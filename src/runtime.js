/**
 * Agamen v0 — actors + object capabilities + membranes + provenance.
 *
 * The in-process reference substrate for the normative invariants in
 * spec/invariants.md (inherited from agate spec 13; ids preserved). v0 is
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

/* ---------- Actor: identity + capability table + mailbox ----------
 * Invariant (spec 13 #1 zero ambient authority): a new actor's capability
 * table is empty; everything arrives by explicit grant. */

export class Actor {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this.slots = new Map();
    this.mbox = [];
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

  spawn(label) {
    const a = new Actor(this.#nextActor++, label ?? null);
    this.journal.append({ t: "spawn", actor: a.id, label: a.label });
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
    this.journal.append({
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
    this.journal.append({ t: "revoke", tool: cap.name });
  }

  /** Capability-mediated tool invocation, recorded as the provenance quad
   *  (actor, tool, argsHash, resultHash) correlated by xact id. */
  async invoke(actor, slot, args) {
    const cap = actor.hold(slot);
    if (cap.revoked) throw new SubstrateError("E_REVOKED", `capability '${cap.name}' is revoked`);
    if (!cap.rights.has("send")) throw new SubstrateError("E_RIGHTS", "missing 'send' right");
    const xact = `x${++this.#xact}`;
    let ctx = { actor, cap, args, xact };
    for (const m of cap.membranes) {
      const next = m(ctx);
      if (next !== undefined) ctx = { ...ctx, args: next };
    }
    const argsHash = sha256(ctx.args);
    const result = await cap.target.handler(ctx.args, ctx);
    const resultHash = sha256(result);
    this.journal.append({ t: "invoke", actor: actor.id, tool: cap.name, xact, argsHash, resultHash });
    return result;
  }

  /** Sender stamping: `sender` is bound by the runtime from the caller
   *  reference and is never read from message content. The kernel version
   *  replaces the reference with an EL0-unforgeable stamp (spec 13 #4). */
  tell(from, to, msg) {
    to.mbox.push({ sender: from.id, msg });
    this.journal.append({ t: "tell", from: from.id, to: to.id });
  }

  recv(actor) {
    const m = actor.mbox.shift() ?? null;
    if (m) this.journal.append({ t: "recv", actor: actor.id, sender: m.sender });
    return m;
  }
}
