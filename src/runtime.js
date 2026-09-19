/**
 * Agamen v1 — actors + object capabilities + membranes + provenance +
 * scheduling semantics (M1).
 *
 * Deadline, budget, and cancellation are substrate states, not advisory
 * conventions: a request whose deadline passed is denied before the handler
 * runs; a result that lands late or cancelled is never delivered; a full
 * mailbox sheds or blocks explicitly; every completion state is journaled
 * under the request's xact (spec 13 #9). Enforcement is cooperative — a
 * running handler is never preempted in-process; preemption arrives with
 * the M3 transport boundary.
 *
 * The in-process reference substrate for the normative invariants in
 * spec/invariants.md (inherited from agate spec 13; ids preserved). v1 is
 * single-threaded; caller identity is a passed actor reference, not a
 * transport stamp — every deviation from kernel-grade enforcement is flagged
 * inline and tracked in ROADMAP.md.
 */

import { createHash } from "node:crypto";

const sha256 = (v) =>
  createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

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

  append(event) {
    const seq = this.entries.length;
    const prevHash = this.entries.at(-1)?.hash ?? null;
    const hash = sha256({ seq, event, prevHash });
    this.entries.push({ seq, event, prevHash, hash });
    return hash;
  }

  verify() {
    let prev = null;
    for (const e of this.entries) {
      if (e.prevHash !== prev) return false;
      if (sha256({ seq: e.seq, event: e.event, prevHash: prev }) !== e.hash) return false;
      prev = e.hash;
    }
    return true;
  }
}

/* ---------- Capability: designation + rights, derivable, revocable ----------
 * Invariant (spec 13 #2 monotonic decay): derived rights are always a subset.
 * Invariant (spec 13 #6 revocation reachability): revoke cascades to the
 * whole derivation subtree. */

export class Capability {
  #children = [];

  constructor(target, rights, { name = null, membranes = [], parent = null } = {}) {
    this.target = target;
    this.rights = Object.freeze(new Set(rights));
    this.name = name;
    this.membranes = membranes;
    this.parent = parent;
    this.revoked = false;
    if (parent) parent.#children.push(this);
  }

  get descendants() {
    return [...this.#children];
  }

  attenuate({ rights, membranes = [] } = {}) {
    const next = rights ? [...rights] : [...this.rights];
    for (const r of next) {
      if (!this.rights.has(r)) {
        throw new SubstrateError("E_ATTENUATE", `derivation may not add rights: +${r}`);
      }
    }
    return new Capability(this.target, next, {
      name: this.name,
      membranes: [...this.membranes, ...membranes],
      parent: this,
    });
  }

  revoke() {
    if (this.revoked) return;
    this.revoked = true;
    for (const c of this.#children) c.revoke();
  }
}

/* ---------- Membranes: policy layers attached to derived capabilities ----------
 * A membrane sees every mediated call, may rewrite args, and may veto.
 * This is the enforcement point for "policy lives outside the model"
 * (spec 13 #11): an agent holding a badged, membred cap cannot outgrow it. */

export const rateLimit = (maxCalls) => {
  let used = 0;
  return (ctx) => {
    if (used >= maxCalls) {
      throw new SubstrateError("E_BUDGET", `membrane budget exhausted (${maxCalls} calls)`);
    }
    used += 1;
    return ctx.args;
  };
};

export const policy = (fn, msg = "rejected by policy") => (ctx) => {
  if (!fn(ctx.args)) throw new SubstrateError("E_POLICY", msg);
  return ctx.args;
};

/* ---------- Actor: identity + capability table + bounded mailbox ----------
 * Invariant (spec 13 #1 zero ambient authority): a new actor's capability
 * table is empty; everything arrives by explicit grant.
 * Backpressure is per-actor policy: onFull "shed" rejects the sender with
 * E_SHED, "block" parks the send until recv frees a slot. */

export class Actor {
  constructor(id, label, { mailbox = 64, onFull = "shed" } = {}) {
    this.id = id;
    this.label = label;
    this.slots = new Map();
    this.mbox = [];
    this.mboxCap = mailbox;
    this.onFull = onFull;
    this.mboxWaiters = [];
  }

  hold(slot) {
    const cap = this.slots.get(slot);
    if (!cap) {
      throw new SubstrateError("E_NO_CAP", `actor ${this.id} holds no capability at slot '${slot}'`);
    }
    return cap;
  }
}

/* ---------- Runtime: the mediating substrate ---------- */

export class Runtime {
  journal = new Provenance();
  #nextActor = 1;
  #xact = 0;
  #msg = 0;
  #now;
  #journaling;
  #pending = new Map(); // request xact -> { cancelled }
  #queued = new Map();  // mailbox xact -> { actor, waiter? }

  /** `journal:false` is a measurement seam only (docs/evaluation.md tier 1:
   *  "journal on/off"); every other substrate decision is unaffected. */
  constructor({ now = () => globalThis.performance.now(), journal = true } = {}) {
    this.#now = now;
    this.#journaling = journal;
  }

  #append(event) {
    if (this.#journaling) this.journal.append(event);
  }

  #nowMs() {
    return this.#now();
  }

  spawn(label, opts = {}) {
    const a = new Actor(this.#nextActor++, label ?? null, opts);
    this.#append({ t: "spawn", actor: a.id, label: a.label });
    return a;
  }

  endpoint(name, handler, { rights = ["send", "recv", "grant", "revoke"] } = {}) {
    return new Capability({ kind: "endpoint", name, handler }, rights, { name });
  }

  /** Create a tool service actor that holds the root capability. */
  serve(label, name, handler) {
    const server = this.spawn(label);
    const cap = this.endpoint(name, handler);
    server.slots.set(name, cap);
    return { server, cap };
  }

  /** Explicit delegation. Never adds rights; attenuation and membranes attach here. */
  grant(from, fromSlot, to, toSlot, { rights, membranes } = {}) {
    const src = from.hold(fromSlot);
    const derived = src.attenuate({ rights, membranes });
    to.slots.set(toSlot, derived);
    this.#append({
      t: "grant",
      from: from.id,
      to: to.id,
      tool: src.name,
      slot: toSlot,
      rights: [...derived.rights],
    });
    return derived;
  }

  revoke(cap) {
    cap.revoke();
    this.#append({ t: "revoke", tool: cap.name });
  }

  /** Mediated call, admitted under explicit lifecycle states. Returns
   *  { xact, promise }. Denials carry the same xact as successes would,
   *  so the journal correlates attempt and outcome (spec 13 #10). */
  request(actor, slot, args, { deadline = null, signal = null } = {}) {
    const xact = `x${++this.#xact}`;
    const cap = actor.hold(slot);
    const deny = (code, msg) => {
      this.#append({ t: "invoke_denied", xact, actor: actor.id, tool: cap.name, code });
      throw new SubstrateError(code, msg);
    };
    if (cap.revoked) deny("E_REVOKED", `capability '${cap.name}' is revoked`);
    if (!cap.rights.has("send")) deny("E_RIGHTS", "missing 'send' right");
    if (signal?.aborted) deny("E_CANCELLED", "cancelled before admission");
    if (deadline !== null && this.#nowMs() >= deadline) {
      deny("E_DEADLINE", "deadline passed before admission; handler not executed");
    }

    let ctx = { actor, cap, args, xact };
    try {
      for (const m of cap.membranes) {
        const next = m(ctx);
        if (next !== undefined) ctx = { ...ctx, args: next };
      }
    } catch (e) {
      this.#append({ t: "invoke_denied", xact, actor: actor.id, tool: cap.name, code: e.code ?? "E_MEMBRANE" });
      throw e;
    }

    // hashing is journal work: when the measurement seam turns the journal
    // off, its cost must leave the measurement too (docs/evaluation.md tier 1)
    const argsHash = this.#journaling ? sha256(ctx.args) : null;
    const journalEv = (outcome, result) => {
      if (!this.#journaling) return;
      const ev = { t: "invoke", xact, actor: actor.id, tool: cap.name, outcome, argsHash };
      if (result !== undefined) ev.resultHash = sha256(result);
      this.journal.append(ev);
    };

    const rec = { cancelled: false };
    this.#pending.set(xact, rec);
    if (signal) signal.addEventListener("abort", () => this.cancel(xact), { once: true });

    let resolve_, reject_;
    const promise = new Promise((res, rej) => { resolve_ = res; reject_ = rej; });

    let h;
    try {
      h = cap.target.handler(ctx.args, ctx);
    } catch (err) {
      this.#pending.delete(xact);
      journalEv("fail");
      throw err;
    }

    Promise.resolve(h).then(
      (result) => {
        this.#pending.delete(xact);
        if (rec.cancelled) {
          journalEv("cancelled");
          reject_(new SubstrateError("E_CANCELLED", `xact ${xact} cancelled; result discarded`));
        } else if (deadline !== null && this.#nowMs() > deadline) {
          journalEv("timeout");
          reject_(new SubstrateError("E_TIMEOUT", `xact ${xact} completed past deadline; result not delivered`));
        } else {
          journalEv("ok", result);
          resolve_(result);
        }
      },
      (err) => {
        this.#pending.delete(xact);
        journalEv(rec.cancelled ? "cancelled" : "fail");
        reject_(err);
      }
    );

    return { xact, promise };
  }

  /** Convenience over request(); throws/rejects with the substrate code. */
  async invoke(actor, slot, args, opts = {}) {
    return this.request(actor, slot, args, opts).promise;
  }

  /** Cancel by xact id. A pending request never delivers its result (the
   *  handler is not preempted — its output is discarded and journaled); a
   *  queued or blocked message is removed before delivery. */
  cancel(xact) {
    const req = this.#pending.get(xact);
    if (req) {
      req.cancelled = true;
      this.#append({ t: "cancel", xact });
      return true;
    }
    const q = this.#queued.get(xact);
    if (!q) return false;
    this.#queued.delete(xact);
    this.#append({ t: "cancel", xact });
    if (q.waiter) {
      const i = q.actor.mboxWaiters.indexOf(q.waiter);
      if (i >= 0) q.actor.mboxWaiters.splice(i, 1);
      q.waiter.reject(new SubstrateError("E_CANCELLED", `blocked message ${xact} cancelled`));
    } else {
      const i = q.actor.mbox.findIndex((m) => m.xact === xact);
      if (i >= 0) q.actor.mbox.splice(i, 1);
    }
    return true;
  }

  /** Sender stamping + backpressure. `sender` is bound by the runtime from
   *  the caller reference and is never read from message content (spec 13
   *  #4; the kernel version replaces the reference with an EL0-unforgeable
   *  stamp). Returns true when enqueued, a Promise when the full mailbox
   *  blocks, and throws E_SHED when the actor sheds. Queued messages are
   *  checked for expiry at delivery, not at send. */
  tell(from, to, msg, { deadline = null, xact = null } = {}) {
    xact = xact ?? `m${++this.#msg}`;
    if (to.mbox.length >= to.mboxCap) {
      if (to.onFull === "block") {
        let w;
        const p = new Promise((resolve, reject) => {
          w = { sender: from.id, msg, deadline, xact, resolve, reject };
        });
        to.mboxWaiters.push(w);
        this.#queued.set(xact, { actor: to, waiter: w });
        this.#append({ t: "tell_blocked", xact, from: from.id, to: to.id });
        return p;
      }
      this.#append({ t: "shed", xact, from: from.id, to: to.id });
      throw new SubstrateError("E_SHED", `mailbox of '${to.label ?? to.id}' is full (${to.mboxCap})`);
    }
    to.mbox.push({ sender: from.id, msg, xact, deadline });
    this.#queued.set(xact, { actor: to });
    this.#append({ t: "tell", xact, from: from.id, to: to.id });
    return true;
  }

  recv(actor) {
    while (actor.mbox.length) {
      const m = actor.mbox[0];
      if (m.deadline !== null && this.#nowMs() >= m.deadline) {
        actor.mbox.shift();
        this.#queued.delete(m.xact);
        this.#append({ t: "expire", xact: m.xact, actor: actor.id });
        continue;
      }
      actor.mbox.shift();
      this.#queued.delete(m.xact);
      this.#append({ t: "recv", actor: actor.id, sender: m.sender, xact: m.xact });
      this.#drainWaiters(actor);
      return m;
    }
    return null;
  }

  #drainWaiters(actor) {
    while (actor.mboxWaiters.length && actor.mbox.length < actor.mboxCap) {
      const w = actor.mboxWaiters.shift();
      this.#queued.delete(w.xact);
      if (w.deadline !== null && this.#nowMs() >= w.deadline) {
        this.#append({ t: "expire", xact: w.xact, actor: actor.id });
        w.reject(new SubstrateError("E_DEADLINE", `blocked message ${w.xact} expired`));
        continue;
      }
      actor.mbox.push({ sender: w.sender, msg: w.msg, xact: w.xact, deadline: w.deadline });
      this.#queued.set(w.xact, { actor });
      this.#append({ t: "tell", xact: w.xact, from: w.sender, to: actor.id, unblocked: true });
      w.resolve(true);
    }
  }
}
