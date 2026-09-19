/**
 * Agamen v1.6 — authority-handle split + strict value discipline.
 *
 * Response to the internal re-audit of v1.5 (5 BLOCKERs / 4 MAJORs). Three
 * changes of principle:
 *
 * 1. THREE HANDLES, NOT ONE. A principal is reached by three distinct
 *    tokens: the public ActorId (a frozen {id,label} snapshot — comparable,
 *    displayable, accepted by NO privileged call), the ActorControl handle
 *    (principal-private controller: recv / request / holds / slot writes),
 *    and MailboxCap capabilities (the only authority to tell() an actor).
 *    v1.5 conflated all three into one token, so holding a target's
 *    reference minted its root mailbox cap, read its mailbox, and ran its
 *    slots. That bypass class is closed by construction: identityOf(control)
 *    gives out something the runtime refuses to accept anywhere privileged.
 *
 * 2. THREAT MODEL CHOSEN, NOT AMBIGUOUS (audit #5, option A). The Runtime
 *    object is the TRUSTED CONTROL PLANE: spawn/grant/revoke/tick/cancel/
 *    address are host APIs, not a boundary hostile code faces. The adversary
 *    is realm code that legitimately holds capability tokens, its own
 *    ActorControl, exposed ActorIds, and handler/membrane roles. Against
 *    that adversary: authority state is WeakMap-private (rights unforgeable,
 *    revocation not holder-reversible, membranes undroppable), slot
 *    installation requires the target's control handle (consent), and the
 *    audit journal is a private sink — rt.journal no longer exists;
 *    verifyJournal() / journalEntries() are read-only views.
 *
 * 3. CLONE-OR-FAIL, BOTH DIRECTIONS, NO FALLBACKS. Invocation arguments are
 *    structured-cloned at admission (membranes and handlers never receive a
 *    caller-owned mutable object); results that cannot cross by clone FAIL
 *    the xact (E_CLONE) — v1.5's shared-reference fallback is deleted.
 *    Hashed values must live in the frozen plain domain (null/bool/finite
 *    number/string/bigint/array/plain-object); Date/Map/Set/class-instances/
 *    undefined are rejected (E_DOMAIN), which with type-tagged canonical
 *    encoding removes the v1.5 sentinel/string collisions. A total,
 *    collision-free argument digest is a precondition for M2 approvals —
 *    which therefore stay blocked until this layer is proven.
 *
 * Also fixed: internal xact ids are runtime-lifetime unique (the ledger
 * never rebinds an id; user labels move to `correlationId`); slot
 * overwrites need explicit consent (E_OCCUPIED); grant/revoke foreign
 * denials are journaled; AbortSignal listeners are removed on settle; the
 * rights algebra is {send, grant} — v1.5's `recv`/`revoke` were decorative
 * and are removed (mailbox reads are control-handle possession; subtree
 * revocation is a host act, journaled).
 *
 * Still true (documented deviations): handlers are not preempted in-process
 * (enforcement track E2); identity is runtime-branded, not a transport
 * stamp (#4, E2); the journal is in-memory and internally hash-consistent
 * for the process lifetime — external anchoring is E2/E3 work (#10).
 */

import { createHash } from "node:crypto";

const sha256 = (v) =>
  createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

const UNHASHABLE = Symbol("unhashable");
const BENCH_HASH = () => "!bench";

class DomainError extends Error {}

/* Frozen value domain, type-safely encoded: every value becomes [tag, ...]
 * so no string can alias another type's representation (v1.5 collision:
 * undefined ≡ "!undef", which a hostile caller could also pass as the
 * literal string). plain object = own enumerable string keys, Object/null
 * prototype. Out of domain: undefined, functions, symbols, non-finite
 * numbers, Date/Map/Set/typed arrays/class instances, array holes. */
function canonEncode(v, seen) {
  if (v === null) return ["~"];
  const t = typeof v;
  if (t === "boolean") return ["b", v];
  if (t === "number") {
    if (!Number.isFinite(v)) throw new DomainError("non-finite number");
    return ["n", Object.is(v, -0) ? "0" : v];
  }
  if (t === "string") return ["s", v];
  if (t === "bigint") return ["i", String(v)];
  if (t !== "object") throw new DomainError(`type '${t}' is out of the value domain`);
  // cycles are not a finite tree: reject before recursion overflows the stack
  const s = seen || new WeakSet();
  if (s.has(v)) throw new DomainError("cyclic value");
  s.add(v);
  try {
    if (Array.isArray(v)) return ["a", v.map((x) => canonEncode(x, s))];
    const p = Object.getPrototypeOf(v);
    // Cross-realm-safe plain check: a plain object's prototype chain bottoms
    // out at null one step at or above Object.prototype. Date/Map/Set/class
    // instances have Object.prototype two steps up, so they are rejected
    // even when they arrive from another realm (structuredClone in some
    // embedders produces objects whose Object.prototype differs by identity).
    if (p !== null && Object.getPrototypeOf(p) !== null) throw new DomainError("not a plain object");
    return ["o", Object.keys(v).sort().map((k) => [k, canonEncode(v[k], s)])];
  } finally {
    s.delete(v);
  }
}

const canonSha = (v) => {
  try {
    return sha256(JSON.stringify(canonEncode(v)));
  } catch {
    return UNHASHABLE;
  }
};

export class SubstrateError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = "SubstrateError";
    this.code = code;
  }
}

/* clone-or-fail: the only way a value crosses a principal boundary. */
function cloneOrFail(v) {
  try {
    return structuredClone(v);
  } catch {
    throw new SubstrateError("E_CANON", "value is not structurally cloneable");
  }
}

/* ---------- Provenance: append-only, hash-chained journal ----------
 * Not exported and not reachable from outside: Runtime holds it in a
 * private field and exposes only verifyJournal()/journalEntries().
 * `rt.journal = ...` creates an inert own property; the internal append
 * path is `this.#journal.append` and cannot be swapped (audit #3). */

class Provenance {
  entries = [];
  #hash;

  constructor({ hash = sha256 } = {}) {
    this.#hash = hash;
  }

  append(event) {
    const seq = this.entries.length;
    const prevHash = this.entries.at(-1)?.hash ?? null;
    const hash = this.#hash({ seq, event, prevHash });
    this.entries.push({ seq, event, prevHash, hash });
    return hash;
  }

  verify() {
    let prev = null;
    for (const e of this.entries) {
      if (e.prevHash !== prev) return false;
      if (this.#hash({ seq: e.seq, event: e.event, prevHash: prev }) !== e.hash) return false;
      prev = e.hash;
    }
    return true;
  }
}

/* v1.6 rights algebra: send = invoke/tell; grant = derive attenuated caps.
 * `recv` and `revoke` were removed as non-delegable: reading a mailbox is
 * possession of the principal's control handle, and revoking a subtree is
 * an act of the trusted plane. */
const VALID_RIGHTS = new Set(["send", "grant"]);

/* ---------- Membranes: factories; per-derivation instantiated state ----------
 * Budget scope: a membrane's state belongs to the grant that attached it
 * and is shared by that cap's whole derivation subtree; sibling subtrees
 * get independent counters. Membranes run in attachment order and charge
 * their budget on the ATTEMPT, before later membranes veto. */

export const rateLimit = (maxCalls) => ({
  kind: "rateLimit",
  create: () => {
    let used = 0;
    return (ctx) => {
      if (used >= maxCalls) {
        throw new SubstrateError("E_BUDGET", `membrane budget exhausted (${maxCalls} calls)`);
      }
      used += 1;
      return ctx.args;
    };
  },
});

export const policy = (fn, msg = "rejected by policy") => ({
  kind: "policy",
  create: () => (ctx) => {
    if (!fn(ctx.args)) throw new SubstrateError("E_POLICY", msg);
    return ctx.args;
  },
});

/* ---------- Runtime ---------- */

export class Runtime {
  #now;
  #h;
  #conforming = true;
  #journal;

  #nextActor = 1;
  #seq = 0;
  #actors = new WeakMap(); // ActorControl token -> private state
  #caps = new WeakMap();   // cap token          -> private record
  #pending = new Map();    // request xact -> request record
  #queued = new Map();     // message xact -> { st, kind, ... }

  /** `bench: true` selects a non-conforming, constant-time audit sink for
   *  cost-model fitting only; `rt.conforming` reports it. The journal
   *  cannot be disabled or reached: verifyJournal()/journalEntries() are
   *  the only views, both snapshot-only. */
  constructor({ now = () => globalThis.performance.now(), bench = false } = {}) {
    this.#now = now;
    this.#h = bench ? BENCH_HASH : canonSha;
    if (bench) this.#conforming = false;
    this.#journal = new Provenance({ hash: bench ? BENCH_HASH : sha256 });
  }

  /* ===== read-only audit views ===== */

  get conforming() {
    return this.#conforming;
  }

  verifyJournal() {
    return this.#journal.verify();
  }

  /** Snapshot copy — mutating the result cannot touch the ledger. */
  journalEntries() {
    return this.#journal.entries.map((e) => structuredClone(e));
  }

  /** Trusted-plane hook for higher layers (e.g. src/intent.js) to record
   *  facts in the same ledger. It appends; it grants no authority. */
  record(event) {
    return this.#journal.append(event);
  }

  #A(token) {
    const st = this.#actors.get(token);
    if (!st) {
      throw new SubstrateError("E_FOREIGN", "not an ActorControl handle of this runtime (public ActorIds are accepted nowhere privileged)");
    }
    return st;
  }

  #C(token) {
    const rec = this.#caps.get(token);
    if (!rec) throw new SubstrateError("E_FOREIGN", "capability is not minted by this runtime");
    return rec;
  }

  #x(prefix) {
    return `${prefix}${++this.#seq}`; // runtime-lifetime unique; never reused
  }

  #mint(rec) {
    const token = Object.freeze({ id: `c${++this.#seq}` });
    this.#caps.set(token, { children: [], revoked: false, instances: [], ...rec });
    return token;
  }

  /* ===== actors: control handle vs public identity ===== */

  spawn(label, { mailbox = 64, onFull = "shed" } = {}) {
    if (onFull !== "shed" && onFull !== "block") throw new SubstrateError("E_INVAL", "onFull: shed|block");
    const control = Object.freeze({ id: this.#nextActor++, label: label ?? null });
    this.#actors.set(control, {
      token: control,
      slots: new Map(),
      mbox: [],
      waiters: [],
      mboxCap: mailbox,
      waiterCap: mailbox * 4,
      onFull,
      mboxCapToken: null,
    });
    this.#journal.append({ t: "spawn", actor: control.id, label: control.label });
    return control;
  }

  /** The public handle: comparable and displayable, rejected by every
   *  privileged call (it is not a key into #actors). The only form of an
   *  actor that may be shown to other principals. */
  identityOf(control) {
    const st = this.#A(control);
    return Object.freeze({ id: st.token.id, label: st.token.label });
  }

  /** Root mailbox capability. Requires the control handle — an ActorId
   *  mints nothing. Distributing attenuations of it is the only way to
   *  let anyone tell() this actor (#3). */
  address(control) {
    const st = this.#A(control);
    if (!st.mboxCapToken) {
      st.mboxCapToken = this.#mint({
        kind: "actor",
        target: st.token, // private control token — never handed out
        name: `mailbox:${st.token.id}`,
        rights: new Set(["send", "grant"]),
      });
    }
    return st.mboxCapToken;
  }

  holds(control, slot) {
    const st = this.#A(control);
    const tok = st.slots.get(slot);
    if (!tok) throw new SubstrateError("E_NO_CAP", `actor ${st.token.id} holds no capability at slot '${slot}'`);
    return tok;
  }

  rightsOf(capToken) {
    return Object.freeze([...this.#C(capToken).rights]);
  }

  isRevoked(capToken) {
    return this.#C(capToken).revoked;
  }

  /* ===== capabilities ===== */

  endpoint(name, handler, { rights = ["send", "grant"] } = {}) {
    for (const r of rights) if (!VALID_RIGHTS.has(r)) throw new SubstrateError("E_INVAL", `unknown right '${r}'`);
    return this.#mint({ kind: "endpoint", target: { handler }, name: String(name), rights: new Set(rights) });
  }

  serve(label, name, handler) {
    const server = this.spawn(label);
    const cap = this.endpoint(name, handler);
    this.#A(server).slots.set(name, cap);
    return { server, cap };
  }

  /** Derive a child capability from an actor's slot and install it on the
   *  target actor — whose CONTROL handle must be presented (consent). */
  grant(fromControl, fromSlot, toControl, toSlot, opts = {}) {
    let srcTok;
    try {
      srcTok = this.#A(fromControl).slots.get(fromSlot);
    } catch (e) {
      this.#grantDenied(fromControl, toControl, toSlot, e.code ?? "E_FOREIGN");
      throw e;
    }
    if (!srcTok) {
      this.#grantDenied(fromControl, toControl, toSlot, "E_NO_CAP");
      throw new SubstrateError("E_NO_CAP", "source slot empty");
    }
    try {
      this.#A(toControl);
    } catch (e) {
      this.#grantDenied(fromControl, toControl, toSlot, e.code);
      throw e;
    }
    return this.grantCap(srcTok, toControl, toSlot, opts);
  }

  /** Derive from a held capability token into a slot of the actor whose
   *  control handle is presented. There is no way to install into an actor
   *  you were not given control of — the v1.5 slot-hijack (attacker mints
   *  an evil endpoint, grantCaps it onto the victim's slot) is
   *  constructively impossible, and overwriting an occupied slot needs an
   *  explicit `overwrite: true` from whoever holds the controller. */
  grantCap(srcTok, toControl, toSlot, { rights, membranes = [], overwrite = false } = {}) {
    const gx = this.#x("g");
    const deny = (code, msg) => {
      this.#journal.append({ t: "grant_denied", xact: gx, to: toControl?.id ?? null, slot: toSlot, code });
      throw new SubstrateError(code, msg);
    };
    let src;
    try {
      src = this.#C(srcTok);
    } catch {
      deny("E_FOREIGN", "source capability not minted by this runtime");
    }
    let toSt;
    try {
      toSt = this.#A(toControl);
    } catch {
      deny("E_FOREIGN", "destination is not a control handle owned by this runtime");
    }
    if (src.revoked) deny("E_REVOKED", "source capability is revoked");
    if (!src.rights.has("grant")) deny("E_RIGHTS", "delegation requires the 'grant' right");
    const next = rights ? [...rights] : [...src.rights];
    for (const r of next) {
      if (!VALID_RIGHTS.has(r)) deny("E_INVAL", `unknown right '${r}'`);
      if (!src.rights.has(r)) deny("E_ATTENUATE", `derivation may not add rights: +${r}`);
    }
    let created;
    try {
      created = membranes.map((m) => m.create());
    } catch {
      deny("E_INVAL", "bad membrane factory");
    }
    // occupancy is checked BEFORE minting: a denied overwrite must not
    // leave a ghost child linked into the revocation tree.
    if (!overwrite && toSt.slots.has(toSlot)) {
      deny("E_OCCUPIED", `slot '${toSlot}' on actor ${toSt.token.id} is occupied`);
    }
    const child = this.#mint({
      kind: src.kind,
      target: src.target,
      name: src.name,
      rights: new Set(next),
      parent: srcTok,
      instances: [...src.instances, ...created],
    });
    src.children.push(child);
    toSt.slots.set(toSlot, child);
    this.#journal.append({
      t: "grant", xact: gx, to: toSt.token.id, tool: src.name, slot: toSlot, rights: next,
    });
    return child;
  }

  #grantDenied(fromControl, toControl, toSlot, code) {
    this.#journal.append({
      t: "grant_denied", xact: this.#x("g"),
      from: fromControl?.id ?? null, to: toControl?.id ?? null, slot: toSlot, code,
    });
  }

  /** Subtree revocation — a trusted-plane act (host/scheduler), journaled.
   *  Holders of a capability token cannot un-revoke; descendants die with
   *  the root (#6). Foreign tokens are denied AND journaled (audit #6). */
  revoke(capToken) {
    let root;
    try {
      root = this.#C(capToken);
    } catch (e) {
      this.#journal.append({ t: "revoke_denied", xact: this.#x("g"), code: e.code });
      throw e;
    }
    const queue = [root];
    while (queue.length) {
      const rec = queue.pop();
      if (rec.revoked) continue;
      rec.revoked = true;
      for (const childTok of rec.children) queue.push(this.#C(childTok));
    }
    this.#journal.append({ t: "revoke", tool: root.name });
  }

  /* ===== mediated invocation =====
   * `control` is ALWAYS an ActorControl handle: an actor's slot table may
   * only be driven by whoever holds its controller. */

  /* Mediated invocation. `control` is ALWAYS an ActorControl handle: an
   * actor's slot table may only be driven by whoever holds its
   * controller. `onAdmit(xact)` — host-plane only — runs synchronously
   * after the request is registered (its xact exists and is final) and
   * BEFORE the handler executes: the one sound place for a dispatch-time
   * binding fact, since nothing the effect does can be observed until
   * the ledger already carries it. A throwing onAdmit aborts the
   * dispatch before any effect: the invoke settles as fail and the
   * error is re-thrown to the caller (who never receives the promise). */
  request(control, slot, args, { deadline = null, signal = null, correlationId = null, onAdmit = null } = {}) {
    const x = this.#x("x");
    const corr = correlationId !== null ? { correlationId } : {};
    const deny = (code, msg) => {
      this.#journal.append({ t: "invoke_denied", xact: x, actor: control?.id ?? null, slot, code, ...corr });
      throw new SubstrateError(code, msg);
    };
    let st;
    try {
      st = this.#A(control);
    } catch {
      deny("E_FOREIGN", "not a control handle owned by this runtime");
    }
    const capTok = st.slots.get(slot);
    if (!capTok) deny("E_NO_CAP", `no capability at slot '${slot}'`);
    const rec = this.#C(capTok);
    if (rec.revoked) deny("E_REVOKED", `capability '${rec.name}' is revoked`);
    if (rec.kind !== "endpoint") deny("E_RIGHTS", "slot holds no invokable endpoint");
    if (!rec.rights.has("send")) deny("E_RIGHTS", "missing 'send' right");
    if (signal?.aborted) deny("E_CANCELLED", "cancelled before admission");
    if (deadline !== null && this.#now() >= deadline) {
      deny("E_DEADLINE", "deadline passed before admission; handler not executed");
    }
    /* isolation begins before policy: membranes never see the caller's
     * object graph, and neither does the handler (audit #2). */
    let margs;
    try {
      margs = cloneOrFail(args);
    } catch {
      deny("E_CANON", "arguments are not structurally cloneable");
    }
    const frozenCtx = Object.freeze({
      xact: x,
      caller: Object.freeze({ id: st.token.id, label: st.token.label }),
      tool: rec.name,
    });
    let rewrote = false;
    for (const inst of rec.instances) {
      let out;
      try {
        out = inst(Object.freeze({ ...frozenCtx, args: margs }));
      } catch (e) {
        this.#journal.append({ t: "invoke_denied", xact: x, actor: st.token.id, slot, code: e.code ?? "E_MEMBRANE" });
        throw e;
      }
      if (out !== undefined) {
        margs = out;
        rewrote = true;
      }
    }
    if (rewrote) {
      try {
        margs = cloneOrFail(margs); // membrane returned a live object: re-isolate
      } catch {
        deny("E_CANON", "membrane-rewritten arguments are not structurally cloneable");
      }
    }
    const argsHash = this.#h(margs);
    if (argsHash === UNHASHABLE) deny("E_DOMAIN", "arguments are outside the canonical value domain");

    let resolve_, reject_;
    const promise = new Promise((res, rej) => { resolve_ = res; reject_ = rej; });
    const r = {
      x, actorId: st.token.id, tool: rec.name, argsHash, deadline, correlationId,
      settled: false, handlerSettled: false,
      resolve: resolve_, reject: reject_, promise, detach: null, settle: null,
    };
    if (signal) {
      const onAbort = () => this.cancel(x);
      signal.addEventListener("abort", onAbort, { once: true });
      r.detach = () => signal.removeEventListener("abort", onAbort); // audit #10
    }
    this.#pending.set(x, r);

    r.settle = (outcome, resultHash) => {
      if (r.settled) return false;
      r.settled = true;
      this.#pending.delete(x);
      r.detach?.();
      const ev = { t: "invoke", xact: x, actor: r.actorId, tool: r.tool, outcome, argsHash: r.argsHash, ...corr };
      if (resultHash) ev.resultHash = resultHash;
      this.#journal.append(ev);
      return true;
    };

    let h;
    if (onAdmit) {
      try {
        onAdmit(x);
      } catch (err) {
        r.settle("fail"); // admitted, then refused: a fact, not silence
        throw err;
      }
    }
    try {
      h = rec.target.handler(margs, frozenCtx);
    } catch (err) {
      r.settle("fail");
      throw err;
    }
    Promise.resolve(h).then(
      (result) => {
        r.handlerSettled = true;
        if (r.settled) {
          this.#journal.append({ t: "handler_settled", xact: x });
          return;
        }
        if (r.deadline !== null && this.#now() > r.deadline) {
          r.settle("timeout");
          r.reject(new SubstrateError("E_TIMEOUT", `xact ${x} completed past deadline; result not delivered`));
          return;
        }
        let delivered;
        try {
          delivered = cloneOrFail(result); // no shared-reference fallback
        } catch {
          r.settle("fail");
          r.reject(new SubstrateError("E_CLONE", `xact ${x}: result cannot cross by clone`));
          return;
        }
        const rh = this.#h(delivered);
        if (rh === UNHASHABLE) {
          r.settle("fail");
          r.reject(new SubstrateError("E_DOMAIN", `xact ${x}: result is outside the canonical value domain`));
          return;
        }
        r.settle("ok", rh);
        r.resolve(delivered);
      },
      (err) => {
        r.handlerSettled = true;
        if (r.settled) {
          this.#journal.append({ t: "handler_settled", xact: x });
          return;
        }
        r.settle("fail");
        r.reject(err);
      }
    );

    return { xact: x, promise };
  }

  async invoke(control, slot, args, opts = {}) {
    return this.request(control, slot, args, opts).promise;
  }

  /** Scheduler tick: settles caller-facing outcomes for expired requests
   *  and expired queue entries no matter what the handler does afterwards.
   *  Host-driven; #9 completion is guaranteed by cancel()/tick(), not by
   *  handler cooperation. Trusted-plane API — a caller-chosen `now` is
   *  exactly as trusted as the rest of the host surface. */
  tick(now = this.#now()) {
    for (const [x, r] of [...this.#pending]) {
      if (!r.settled && r.deadline !== null && now >= r.deadline) {
        r.settle("timeout");
        r.reject(new SubstrateError("E_TIMEOUT", `xact ${x} deadline enforced by tick`));
      }
    }
    const touched = new Set();
    for (const [x, q] of [...this.#queued]) {
      const deadline = q.kind === "mbox" ? q.msg.deadline : q.waiter.deadline;
      if (deadline === null || now < deadline) continue;
      this.#removeQueued(x, q);
      touched.add(q.st);
      this.#journal.append({ t: "expire", xact: x, actor: q.st.token.id });
      if (q.kind === "waiter") q.waiter.resolve({ ok: false, reason: "expired" });
    }
    for (const st of touched) this.#drain(st);
  }

  /** Cancel by internal xact id (trusted plane). For requests: the caller
   *  is rejected NOW; when a (non-preempted) handler eventually settles, a
   *  separate `handler_settled` fact is appended — cancellation cancels
   *  DELIVERY, and the journal never claims otherwise. */
  cancel(xact) {
    const r = this.#pending.get(xact);
    if (r) {
      this.#journal.append({ t: "cancel", xact });
      if (!r.settled) {
        r.settled = true;
        this.#pending.delete(xact);
        r.detach?.();
        const corr = r.correlationId !== null ? { correlationId: r.correlationId } : {};
        this.#journal.append({ t: "invoke", xact, actor: r.actorId, tool: r.tool, outcome: "cancelled", argsHash: r.argsHash, delivery: "cancelled", ...corr });
        r.reject(new SubstrateError("E_CANCELLED", `xact ${xact} cancelled; result delivery stopped`));
      }
      return true;
    }
    const q = this.#queued.get(xact);
    if (q) {
      this.#removeQueued(xact, q);
      this.#journal.append({ t: "cancel", xact });
      if (q.kind === "waiter") q.waiter.resolve({ ok: false, reason: "cancelled" });
      this.#drain(q.st);
      return true;
    }
    return false;
  }

  #removeQueued(x, q) {
    this.#queued.delete(x);
    if (q.kind === "mbox") {
      const i = q.st.mbox.findIndex((m) => m.xact === x);
      if (i >= 0) q.st.mbox.splice(i, 1);
    } else {
      const i = q.st.waiters.indexOf(q.waiter);
      if (i >= 0) q.st.waiters.splice(i, 1);
    }
  }

  /* ===== mediated messaging =====
   * tell(senderControl, mailboxCap, msg): the DESTINATION is authorized by
   * the presented capability (target-bound, right "send"); the SENDER is
   * stamped from its own control handle and cannot be claimed. An ActorId
   * cannot send, receive, address, or invoke anything. Values cross by
   * structured clone; a blocked send NEVER rejects: it resolves {ok:true}
   * on delivery or {ok:false, reason} on expiry/cancellation. */

  tell(senderControl, mailboxCap, msg, { deadline = null, correlationId = null } = {}) {
    const tx = this.#x("t");
    const corr = correlationId !== null ? { correlationId } : {};
    const deny = (code, msgText) => {
      this.#journal.append({ t: "deliver_denied", xact: tx, from: senderControl?.id ?? null, code, ...corr });
      throw new SubstrateError(code, msgText);
    };
    let fs;
    try {
      fs = this.#A(senderControl);
    } catch {
      deny("E_FOREIGN", "sender is not a control handle owned by this runtime");
    }
    let rec;
    try {
      rec = this.#C(mailboxCap);
    } catch {
      deny("E_FOREIGN", "destination is not a capability minted by this runtime");
    }
    if (rec.kind !== "actor") deny("E_RIGHTS", "not a mailbox capability");
    if (rec.revoked) deny("E_REVOKED", "mailbox capability is revoked");
    if (!rec.rights.has("send")) deny("E_RIGHTS", "capability lacks the 'send' right");
    const ts = this.#A(rec.target); // target is our own private control token
    let cloned;
    try {
      cloned = cloneOrFail(msg);
    } catch {
      deny("E_CANON", "message is not structurally cloneable");
    }
    const to = ts.token;
    if (ts.waiters.length >= ts.waiterCap) {
      this.#journal.append({ t: "shed", xact: tx, from: fs.token.id, to: to.id, why: "waiters", ...corr });
      throw new SubstrateError("E_SHED", `mailbox of '${to.label ?? to.id}' shed (waiter bound)`);
    }
    if (ts.mbox.length >= ts.mboxCap) {
      if (ts.onFull === "block") {
        let w;
        const p = new Promise((resolve) => {
          w = { sender: fs.token.id, msg: cloned, xact: tx, deadline, resolve };
        });
        ts.waiters.push(w);
        this.#queued.set(tx, { st: ts, kind: "waiter", waiter: w });
        this.#journal.append({ t: "tell_blocked", xact: tx, from: fs.token.id, to: to.id, ...corr });
        return p;
      }
      this.#journal.append({ t: "shed", xact: tx, from: fs.token.id, to: to.id, ...corr });
      throw new SubstrateError("E_SHED", `mailbox of '${to.label ?? to.id}' is full (${ts.mboxCap})`);
    }
    ts.mbox.push({ sender: fs.token.id, msg: cloned, xact: tx, deadline });
    this.#queued.set(tx, { st: ts, kind: "mbox", msg: { xact: tx, deadline } });
    this.#journal.append({ t: "tell", xact: tx, from: fs.token.id, to: to.id, ...corr });
    return true;
  }

  /** Reading a mailbox belongs to the control handle alone — self-service,
   *  not a delegable right (see the rights-algebra note above). */
  recv(receiverControl) {
    const st = this.#A(receiverControl);
    let out = null;
    while (st.mbox.length) {
      const m = st.mbox[0];
      if (m.deadline !== null && this.#now() >= m.deadline) {
        st.mbox.shift();
        this.#queued.delete(m.xact);
        this.#journal.append({ t: "expire", xact: m.xact, actor: st.token.id });
        continue;
      }
      st.mbox.shift();
      this.#queued.delete(m.xact);
      this.#journal.append({ t: "recv", actor: st.token.id, sender: m.sender, xact: m.xact });
      out = { sender: m.sender, msg: m.msg, xact: m.xact };
      break;
    }
    this.#drain(st); // EVERY capacity-freeing transition promotes waiters
    return out;
  }

  #drain(st) {
    while (st.waiters.length && st.mbox.length < st.mboxCap) {
      const w = st.waiters.shift();
      this.#queued.delete(w.xact);
      if (w.deadline !== null && this.#now() >= w.deadline) {
        this.#journal.append({ t: "expire", xact: w.xact, actor: st.token.id });
        w.resolve({ ok: false, reason: "expired" });
        continue;
      }
      st.mbox.push({ sender: w.sender, msg: w.msg, xact: w.xact, deadline: w.deadline });
      this.#queued.set(w.xact, { st, kind: "mbox", msg: { xact: w.xact, deadline: w.deadline } });
      this.#journal.append({ t: "tell", xact: w.xact, from: w.sender, to: st.token.id, unblocked: true });
      w.resolve({ ok: true });
    }
  }
}
