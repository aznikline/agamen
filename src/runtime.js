/**
 * Agamen v1.5 — hardened substrate: actors + object capabilities +
 * membranes + provenance + scheduling semantics.
 *
 * Response to external review of v1 (20 findings). The enforcement model is
 * now "hostile same-realm JS code": capabilities and actors are opaque
 * tokens whose authority state lives in runtime-private WeakMaps, so no
 * holder-side mutation can forge rights, un-revoke, drop membranes, or
 * reach a target — in-realm, before any transport boundary. Messages and
 * results cross principal boundaries by structured clone, never by shared
 * reference. Deadline/cancel settle the caller-facing outcome via cancel()
 * and tick() regardless of whether the handler ever returns.
 *
 * Still true (documented deviations): handlers are not preempted in-process
 * (M3 transports); identity is a runtime-branded reference, not an
 * unforgeable transport stamp (#4, M3); the journal is in-memory and
 * internally hash-consistent for the process lifetime — external anchoring
 * and signing are future work (#10 wording in spec/invariants.md).
 */

import { createHash } from "node:crypto";

const sha256 = (v) =>
  createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

const UNHASHABLE = "!unhashable";
const BENCH_HASH = () => "!bench";

/* Canonical, total serialization: sorted keys, non-JSON atoms tagged so
 * {} vs {a:undefined} and NaN vs null never collide; only cycles fail, and
 * failure is a value (UNHASHABLE), never a throw inside a completion path. */
function canonicalize(v, seen) {
  if (v === null) return null;
  if (v === undefined) return "!undef";
  const t = typeof v;
  if (t === "bigint" || t === "function" || t === "symbol") return `!${t}:${String(v)}`;
  if (t === "number" && !Number.isFinite(v)) return `!num:${String(v)}`;
  if (t !== "object") return v; // string | number | boolean | undefined
  if (seen.has(v)) throw new SubstrateError("E_CANON", "cyclic value");
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => canonicalize(x, seen));
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k], seen);
    return o;
  } finally {
    seen.delete(v);
  }
}

const canonSha = (v) => {
  try {
    return sha256(canonicalize(v, new Set()));
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

/* ---------- Provenance: append-only, hash-chained journal ---------- */

export class Provenance {
  entries = [];
  #hash;

  /** A non-conforming sink may swap the hasher (bench); events are still
   *  generated — only the crypto is replaced, and the Runtime that chose it
   *  is flagged `conforming: false`. */
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

const VALID_RIGHTS = new Set(["send", "recv", "grant", "revoke"]);

/* ---------- Membranes: factories; per-derivation instantiated state ----------
 * Budget scope is defined explicitly (review #15): a membrane's state
 * belongs to the grant that attached it and is shared by that cap's whole
 * derivation subtree; sibling subtrees get independent counters.
 * Membranes run in attachment order and charge their budget on the
 * ATTEMPT, before later membranes veto (charged-attempt semantics). */

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

/* ---------- Actor / Capability: opaque tokens ----------
 * Holders see a frozen identity-only token. All authority state (rights,
 * target, membranes, revocation, lineage) lives in runtime WeakMaps keyed
 * by the token: unforgeable, unenumerable, and unreachable by holder-side
 * code — including code that enumerates symbols or deep-freezes objects. */

/* ---------- Runtime ---------- */

export class Runtime {
  journal;
  conforming = true;

  #now;
  #h;
  #nextActor = 1;
  #seq = 0;
  #actors = new WeakMap(); // actor token -> private state
  #caps = new WeakMap();   // cap token  -> private record
  #pending = new Map();    // request xact -> request record
  #queued = new Map();     // message xact -> { st, kind: "mbox" | "waiter", ... }

  /** `bench: true` selects a non-conforming, constant-time audit sink for
   *  cost-model fitting only; it is reported on `rt.conforming`, never
   *  silently off. There is no way to disable the journal itself. */
  constructor({ now = () => globalThis.performance.now(), bench = false } = {}) {
    this.#now = now;
    this.#h = bench ? BENCH_HASH : canonSha;
    if (bench) this.conforming = false;
    this.journal = new Provenance({ hash: bench ? BENCH_HASH : sha256 });
  }

  #A(token) {
    const st = this.#actors.get(token);
    if (!st) throw new SubstrateError("E_FOREIGN", "actor is not owned by this runtime");
    return st;
  }

  #C(token) {
    const rec = this.#caps.get(token);
    if (!rec) throw new SubstrateError("E_FOREIGN", "capability is not minted by this runtime");
    return rec;
  }

  #mint(rec) {
    const token = Object.freeze({ id: `c${++this.#seq}` });
    this.#caps.set(token, { children: [], revoked: false, instances: [], ...rec });
    return token;
  }

  /* ===== actors ===== */

  spawn(label, { mailbox = 64, onFull = "shed" } = {}) {
    if (onFull !== "shed" && onFull !== "block") {
      throw new SubstrateError("E_INVAL", "onFull: shed|block");
    }
    const token = Object.freeze({ id: this.#nextActor++, label: label ?? null });
    this.#actors.set(token, {
      token,
      slots: new Map(),
      mbox: [],
      waiters: [],
      mboxCap: mailbox,
      waiterCap: mailbox * 4,
      onFull,
      mboxCapToken: null,
    });
    this.journal.append({ t: "spawn", actor: token.id, label: token.label });
    return token;
  }

  /** Root capability over an actor's mailbox. Distributing it is the ONLY
   *  way to grant anyone (including other runtimes' notions of "public
   *  address") the right to tell() that actor — messaging is mediated
   *  (invariant #3). The root itself is not ambient: it lives with whoever
   *  the system hands it to, and attenuates/revokes like any cap. */
  address(actorToken) {
    const st = this.#A(actorToken);
    if (!st.mboxCapToken) {
      st.mboxCapToken = this.#mint({
        kind: "actor",
        target: actorToken,
        name: `mailbox:${actorToken.id}`,
        rights: new Set(["send", "recv", "grant", "revoke"]),
      });
    }
    return st.mboxCapToken;
  }

  holds(actorToken, slot) {
    const st = this.#A(actorToken);
    const tok = st.slots.get(slot);
    if (!tok) throw new SubstrateError("E_NO_CAP", `actor ${actorToken.id} holds no capability at slot '${slot}'`);
    return tok;
  }

  rightsOf(capToken) {
    return Object.freeze([...this.#C(capToken).rights]);
  }

  isRevoked(capToken) {
    return this.#C(capToken).revoked;
  }

  /* ===== capabilities ===== */

  endpoint(name, handler, { rights = ["send", "recv", "grant", "revoke"] } = {}) {
    for (const r of rights) if (!VALID_RIGHTS.has(r)) throw new SubstrateError("E_INVAL", `unknown right '${r}'`);
    return this.#mint({ kind: "endpoint", target: { handler }, name: String(name), rights: new Set(rights) });
  }

  serve(label, name, handler) {
    const server = this.spawn(label);
    const cap = this.endpoint(name, handler);
    this.#A(server).slots.set(name, cap);
    return { server, cap };
  }

  /** Derive a child capability from an actor's slot and install it on `to`. */
  grant(from, fromSlot, to, toSlot, opts = {}) {
    let srcTok;
    try {
      srcTok = this.#A(from).slots.get(fromSlot);
    } catch (e) {
      this.#grantDenied(from, to, toSlot, `x${this.#seq}`, e.code ?? "E_FOREIGN");
      throw e;
    }
    if (!srcTok) {
      this.#grantDenied(from, to, toSlot, `x${this.#seq}`, "E_NO_CAP");
      throw new SubstrateError("E_NO_CAP", "source slot empty");
    }
    return this.grantCap(srcTok, to, toSlot, opts);
  }

  #grantDenied(from, to, toSlot, gx, code) {
    this.journal.append({
      t: "grant_denied", xact: gx, from: from?.id ?? null, to: to?.id ?? null, slot: toSlot, code,
    });
  }

  /** Derive from a capability token directly — the distribution path for
   *  root mailbox caps from `address()`, which live outside any slot table
   *  (zero ambient authority, #1, stays literally true). Authority checks
   *  are identical either way. */
  grantCap(srcTok, to, toSlot, { rights, membranes = [] } = {}) {
    const gx = `x${++this.#seq}`;
    let srcId = null;
    try {
      srcId = this.#C(srcTok).target?.id ?? null;
    } catch {}
    const deny = (code, msg) => {
      this.#grantDenied(srcId, to, toSlot, gx, code);
      throw new SubstrateError(code, msg);
    };
    let toSt;
    try {
      toSt = this.#A(to);
    } catch (e) {
      deny(e.code, e.message);
    }
    const src = this.#C(srcTok);
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
    this.journal.append({
      t: "grant", xact: gx, to: to.id, tool: src.name, slot: toSlot, rights: next,
    });
    return child;
  }

  revoke(capToken) {
    const root = this.#C(capToken);
    const queue = [root];
    while (queue.length) {
      const rec = queue.pop();
      if (rec.revoked) continue;
      rec.revoked = true;
      for (const childTok of rec.children) queue.push(this.#C(childTok));
    }
    this.journal.append({ t: "revoke", tool: root.name });
  }

  /* ===== mediated invocation ===== */

  request(actor, slot, args, { deadline = null, signal = null } = {}) {
    const x = `x${++this.#seq}`;
    const deny = (code, msg) => {
      this.journal.append({ t: "invoke_denied", xact: x, actor: actor?.id ?? null, slot, code });
      throw new SubstrateError(code, msg);
    };
    let st;
    try {
      st = this.#A(actor);
    } catch {
      deny("E_FOREIGN", "actor not owned by this runtime");
    }
    const capTok = st.slots.get(slot);
    if (!capTok) deny("E_NO_CAP", `no capability at slot '${slot}'`);
    const rec = this.#C(capTok);
    if (rec.revoked) deny("E_REVOKED", `capability '${rec.name}' is revoked`);
    if (!rec.rights.has("send")) deny("E_RIGHTS", "missing 'send' right");
    if (signal?.aborted) deny("E_CANCELLED", "cancelled before admission");
    if (deadline !== null && this.#now() >= deadline) {
      deny("E_DEADLINE", "deadline passed before admission; handler not executed");
    }
    let margs = args;
    const frozenCtx = Object.freeze({
      xact: x,
      caller: Object.freeze({ id: actor.id, label: actor.label }),
      tool: rec.name,
    });
    for (const inst of rec.instances) {
      let out;
      try {
        out = inst(Object.freeze({ ...frozenCtx, args: margs }));
      } catch (e) {
        this.journal.append({ t: "invoke_denied", xact: x, actor: actor.id, slot, code: e.code ?? "E_MEMBRANE" });
        throw e;
      }
      if (out !== undefined) margs = out;
    }
    const argsHash = this.#h(margs);
    if (argsHash === UNHASHABLE) deny("E_CANON", "arguments are not canonically hashable (cycle?)");

    let resolve_, reject_;
    const promise = new Promise((res, rej) => { resolve_ = res; reject_ = rej; });
    const r = {
      x: x, actorId: actor.id, tool: rec.name, argsHash, deadline,
      settled: false, handlerSettled: false,
      resolve: resolve_, reject: reject_, promise,
    };
    this.#pending.set(x, r);
    if (signal) signal.addEventListener("abort", () => this.cancel(x), { once: true });

    const settle = (outcome, err, resultHash) => {
      if (r.settled) return;
      r.settled = true;
      this.#pending.delete(x);
      const ev = { t: "invoke", xact: x, actor: r.actorId, tool: r.tool, outcome, argsHash: r.argsHash };
      if (resultHash) ev.resultHash = resultHash;
      this.journal.append(ev);
    };

    let h;
    try {
      h = rec.target.handler(margs, frozenCtx);
    } catch (err) {
      settle("fail");
      throw err;
    }
    Promise.resolve(h).then(
      (result) => {
        r.handlerSettled = true;
        if (r.settled) {
          this.journal.append({ t: "handler_settled", xact: x });
          return;
        }
        if (r.deadline !== null && this.#now() > r.deadline) {
          settle("timeout");
          r.reject(new SubstrateError("E_TIMEOUT", `xact ${x} completed past deadline; result not delivered`));
          return;
        }
        let delivered = result;
        let rh;
        try {
          delivered = structuredClone(result);
        } catch {
          // result cannot cross a real boundary either; keep identity, flag it
          delivered = result;
          rh = UNHASHABLE;
        }
        if (rh === undefined) rh = this.#h(delivered);
        settle("ok", null, rh);
        r.resolve(delivered);
      },
      (err) => {
        r.handlerSettled = true;
        if (r.settled) {
          this.journal.append({ t: "handler_settled", xact: x });
          return;
        }
        settle("fail");
        r.reject(err);
      }
    );

    return { xact: x, promise };
  }

  async invoke(actor, slot, args, opts = {}) {
    return this.request(actor, slot, args, opts).promise;
  }

  /** Scheduler tick: settles caller-facing outcomes for expired requests and
   *  expired queue entries no matter what the handler does afterwards. Hosts
   *  drive this periodically (or after any clock advance). #9 completion is
   *  guaranteed by cancel()/tick(), not by handler cooperation. */
  tick(now = this.#now()) {
    for (const [x, r] of [...this.#pending]) {
      if (!r.settled && r.deadline !== null && now >= r.deadline) {
        r.settled = true;
        this.#pending.delete(x);
        this.journal.append({ t: "invoke", xact: x, actor: r.actorId, tool: r.tool, outcome: "timeout", argsHash: r.argsHash });
        r.reject(new SubstrateError("E_TIMEOUT", `xact ${x} deadline enforced by tick`));
      }
    }
    const touched = new Set();
    for (const [x, q] of [...this.#queued]) {
      const deadline = q.kind === "mbox" ? q.msg.deadline : q.waiter.deadline;
      if (deadline === null || now < deadline) continue;
      this.#removeQueued(x, q);
      touched.add(q.st);
      this.journal.append({ t: "expire", xact: x, actor: q.st.token.id });
      if (q.kind === "waiter") q.waiter.resolve({ ok: false, reason: "expired" });
    }
    for (const st of touched) this.#drain(st);
  }

  /** Cancel by xact id. For requests: the caller is rejected NOW and the
   *  ledger records delivery cancellation; when a (non-preempted) handler
   *  eventually settles, a separate `handler_settled` fact is appended —
   *  cancellation cancels DELIVERY, and the journal never claims otherwise. */
  cancel(xact) {
    const r = this.#pending.get(xact);
    if (r) {
      this.journal.append({ t: "cancel", xact });
      if (!r.settled) {
        r.settled = true;
        this.#pending.delete(xact);
        this.journal.append({ t: "invoke", xact, actor: r.actorId, tool: r.tool, outcome: "cancelled", argsHash: r.argsHash, delivery: "cancelled" });
        r.reject(new SubstrateError("E_CANCELLED", `xact ${xact} cancelled; result delivery stopped`));
      }
      return true;
    }
    const q = this.#queued.get(xact);
    if (q) {
      this.#removeQueued(xact, q);
      this.journal.append({ t: "cancel", xact });
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
   * tell() requires a capability (right "send") whose target is `to` —
   * possession of an actor reference is NOT authority to spam it (#3).
   * Values cross by structured clone both ways; a blocked send NEVER
   * rejects: it resolves {ok:true} on delivery or {ok:false, reason} on
   * expiry/cancellation, so ignored results cannot become process-wide
   * unhandled rejections. */

  tell(from, to, msg, { deadline = null, xact = null } = {}) {
    if (xact !== null) {
      if (this.#pending.has(xact) || this.#queued.has(xact)) {
        this.journal.append({ t: "deliver_denied", xact, from: from?.id ?? null, to: to?.id ?? null, code: "E_INVAL" });
        throw new SubstrateError("E_INVAL", `xact '${xact}' collides with a live transaction`);
      }
    } else {
      xact = `t${++this.#seq}`;
      while (this.#queued.has(xact)) xact = `t${++this.#seq}`;
    }
    const deny = (code, msg) => {
      this.journal.append({ t: "deliver_denied", xact, from: from?.id ?? null, to: to?.id ?? null, code });
      throw new SubstrateError(code, msg);
    };
    let fs, ts;
    try {
      fs = this.#A(from);
      ts = this.#A(to);
    } catch {
      deny("E_FOREIGN", "actor not owned by this runtime");
    }
    let canSend = false;
    for (const tok of fs.slots.values()) {
      const rec = this.#C(tok);
      if (rec.kind === "actor" && rec.target === to && !rec.revoked && rec.rights.has("send")) {
        canSend = true;
        break;
      }
    }
    if (!canSend) deny("E_RIGHTS", `no send capability for actor ${to.id}`);
    let cloned;
    try {
      cloned = structuredClone(msg);
    } catch {
      deny("E_CANON", "message is not structurally cloneable");
    }
    if (ts.waiters.length >= ts.waiterCap) {
      this.journal.append({ t: "shed", xact, from: from.id, to: to.id, why: "waiters" });
      throw new SubstrateError("E_SHED", `mailbox of '${to.label ?? to.id}' shed (waiter bound)`);
    }
    if (ts.mbox.length >= ts.mboxCap) {
      if (ts.onFull === "block") {
        let w;
        const p = new Promise((resolve) => {
          w = { sender: from.id, msg: cloned, xact, deadline, resolve };
        });
        ts.waiters.push(w);
        this.#queued.set(xact, { st: ts, kind: "waiter", waiter: w });
        this.journal.append({ t: "tell_blocked", xact, from: from.id, to: to.id });
        return p;
      }
      this.journal.append({ t: "shed", xact, from: from.id, to: to.id });
      throw new SubstrateError("E_SHED", `mailbox of '${to.label ?? to.id}' is full (${ts.mboxCap})`);
    }
    ts.mbox.push({ sender: from.id, msg: cloned, xact, deadline });
    this.#queued.set(xact, { st: ts, kind: "mbox", msg: { xact, deadline } });
    this.journal.append({ t: "tell", xact, from: from.id, to: to.id });
    return true;
  }

  recv(actor) {
    const st = this.#A(actor);
    let out = null;
    while (st.mbox.length) {
      const m = st.mbox[0];
      if (m.deadline !== null && this.#now() >= m.deadline) {
        st.mbox.shift();
        this.#queued.delete(m.xact);
        this.journal.append({ t: "expire", xact: m.xact, actor: actor.id });
        continue;
      }
      st.mbox.shift();
      this.#queued.delete(m.xact);
      this.journal.append({ t: "recv", actor: actor.id, sender: m.sender, xact: m.xact });
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
        this.journal.append({ t: "expire", xact: w.xact, actor: st.token.id });
        w.resolve({ ok: false, reason: "expired" });
        continue;
      }
      st.mbox.push({ sender: w.sender, msg: w.msg, xact: w.xact, deadline: w.deadline });
      this.#queued.set(w.xact, { st, kind: "mbox", msg: { xact: w.xact, deadline: w.deadline } });
      this.journal.append({ t: "tell", xact: w.xact, from: w.sender, to: st.token.id, unblocked: true });
      w.resolve({ ok: true });
    }
  }
}
