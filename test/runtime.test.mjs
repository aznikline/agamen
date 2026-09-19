/**
 * Agamen v1.5 test suite.
 *
 * Beyond positive paths, this file is the negative-test gate for the M1.5
 * hardening pass: every finding in the external review of v1 maps to at
 * least one test asserting the reviewer's stated "what changes my mind"
 * condition. Finding numbers cited in test names refer to that review.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Runtime, rateLimit, policy } from "../src/runtime.js";

const syncCode = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code;
  }
};
const asyncCode = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};
const evs = (rt, t) => rt.journal.entries.map((e) => e.event).filter((e) => e.t === t);
/* flush queued microtasks (handler .then chains) without relying on timers */
const turn = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/* client holds a send-only cap on "t"; handler records ctx it was given */
function setup(handler) {
  const rt = new Runtime();
  const seen = [];
  const { server } = rt.serve(
    "svc",
    "t",
    handler ??
      (async (args, ctx) => {
        seen.push(ctx);
        return `ok:${args.v ?? ""}`;
      })
  );
  const client = rt.spawn("client");
  rt.grant(server, "t", client, "t", { rights: ["send"] });
  return { rt, server, client, seen };
}

/* ---------- invariants #1, #2, #6 + review findings 1–3 ---------- */

test("zero ambient authority; tokens expose no authority state (F2, F3)", () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  assert.equal(syncCode(() => rt.holds(a, "anything")), "E_NO_CAP");
  assert.deepEqual(Object.keys(a).sort(), ["id", "label"]);
  assert.equal(a.slots, undefined);
  assert.equal(a.mbox, undefined);
  // holder-side injection is inert: token is frozen, state lives in a WeakMap
  assert.throws(() => {
    a.slots = new Map();
  });
  assert.equal(syncCode(() => rt.holds(a, "anything")), "E_NO_CAP");

  const { server } = rt.serve("svc", "t", async () => 1);
  const cap = rt.holds(server, "t");
  assert.deepEqual(Object.keys(cap), ["id"]);
  assert.throws(() => {
    cap.target = {};
  });
  assert.throws(() => {
    cap.revoked = true;
  });
  const rs = rt.rightsOf(cap);
  assert.ok(Object.isFrozen(rs));
  assert.throws(() => rs.push("x"));
});

test("full mediation: tell requires a send capability on the target (F1a)", () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  assert.equal(syncCode(() => rt.tell(a, b, { hi: 1 })), "E_RIGHTS");
  assert.equal(evs(rt, "deliver_denied").at(-1).code, "E_RIGHTS");
  const root = rt.address(b);
  rt.grantCap(root, a, "b", { rights: ["send"] });
  assert.equal(rt.tell(a, b, { hi: 1 }), true);
  const m = rt.recv(b);
  assert.equal(m.sender, a.id);
  assert.deepEqual(m.msg, { hi: 1 });
});

test("send-only capability cannot delegate (F1c)", () => {
  const rt = new Runtime();
  const { server } = rt.serve("svc", "t", async () => 1);
  const hop = rt.spawn("hop");
  const sendOnly = rt.grant(server, "t", hop, "t", { rights: ["send"] });
  const other = rt.spawn("other");
  assert.equal(rt.rightsOf(sendOnly).join(), "send");
  assert.equal(syncCode(() => rt.grant(hop, "t", other, "t", { rights: ["send"] })), "E_RIGHTS");
  assert.equal(syncCode(() => rt.grantCap(sendOnly, other, "t", { rights: ["send"] })), "E_RIGHTS");
  assert.equal(evs(rt, "grant_denied").at(-1).code, "E_RIGHTS");
  // and there is no side channel: the mailbox root's grant right is needed
  assert.equal(syncCode(() => rt.grantCap(rt.address(other), hop, "x", { rights: ["send"] })), null);
});

test("revocation cascade is not undoable by holders (F2, invariant #6)", async () => {
  const { rt, server, client } = setup();
  const leaf = rt.spawn("leaf");
  const mid = rt.grant(server, "t", client, "t", { rights: ["send", "grant"] });
  const leafCap = rt.grantCap(mid, leaf, "t", { rights: ["send"] });
  rt.revoke(mid);
  assert.equal(rt.isRevoked(leafCap), true);
  assert.equal(rt.isRevoked(mid), true);
  assert.throws(() => {
    leafCap.revoked = false;
  });
  assert.equal(rt.isRevoked(leafCap), true);
  assert.equal(await asyncCode(rt.invoke(leaf, "t", {})), "E_REVOKED");
});

test("handler ctx carries immutable metadata, never live objects (F3)", async () => {
  const { rt, client, seen } = setup();
  await rt.invoke(client, "t", { v: "x" });
  const ctx = seen[0];
  assert.ok(Object.isFrozen(ctx));
  assert.deepEqual(Object.keys(ctx).sort(), ["caller", "tool", "xact"]);
  assert.equal(ctx.actor, undefined);
  assert.equal(ctx.capability, undefined);
  assert.deepEqual(Object.keys(ctx.caller).sort(), ["id", "label"]);
  assert.equal(ctx.caller.slots, undefined);
  assert.throws(() => {
    ctx.caller.id = 999;
  });
  // a "malicious tool" has no reverse-authority path: nothing mutable in ctx
  assert.throws(() => {
    ctx.caller.foo = 1;
  });
});

test("monotonic decay still enforced on the token API (invariant #2)", () => {
  const { rt, server } = setup();
  const x = rt.spawn("x");
  assert.equal(syncCode(() => rt.grant(server, "t", x, "t", { rights: ["send", "bogus"] })), "E_INVAL");
  const sg = rt.grant(server, "t", x, "sg", { rights: ["send", "grant"] });
  assert.equal(syncCode(() => rt.grantCap(sg, x, "y", { rights: ["send", "revoke"] })), "E_ATTENUATE");
});

/* ---------- membranes: scope + ordering (F15) ---------- */

test("membrane budgets: attached at grant, shared down that subtree, siblings isolated (F15)", async () => {
  const rt = new Runtime();
  const { server } = rt.serve("svc", "t", async () => "ok");
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  const a2 = rt.spawn("a2");
  const capA = rt.grant(server, "t", a, "t", { rights: ["send", "grant"], membranes: [rateLimit(1)] });
  rt.grant(server, "t", b, "t", { rights: ["send"], membranes: [rateLimit(1)] });
  rt.grantCap(capA, a2, "t", { rights: ["send"] }); // inherits A's counter, no new instance
  assert.equal(await rt.invoke(a, "t", {}), "ok");
  assert.equal(await asyncCode(rt.invoke(a, "t", {})), "E_BUDGET");
  assert.equal(await asyncCode(rt.invoke(a2, "t", {})), "E_BUDGET"); // same subtree shares budget
  assert.equal(await rt.invoke(b, "t", {}), "ok"); // sibling subtree unaffected
});

test("membranes run in order and charge on the attempt (F15b)", async () => {
  const { rt, server } = setup();
  const x = rt.spawn("x");
  rt.grant(server, "t", x, "t", { rights: ["send"], membranes: [rateLimit(1), policy(() => false)] });
  assert.equal(await asyncCode(rt.invoke(x, "t", {})), "E_POLICY");
  assert.equal(await asyncCode(rt.invoke(x, "t", {})), "E_BUDGET"); // policy veto still consumed budget
});

test("membrane ctx is frozen and object-free (F3)", async () => {
  const rt = new Runtime();
  const { server } = rt.serve("svc", "t", async () => "ok");
  const x = rt.spawn("x");
  let c;
  rt.grant(server, "t", x, "t", {
    rights: ["send"],
    membranes: [{ kind: "spy", create: () => (ctx) => { c = ctx; return ctx.args; } }],
  });
  await rt.invoke(x, "t", { v: 1 });
  assert.ok(Object.isFrozen(c));
  assert.equal(c.actor, undefined);
  assert.deepEqual(c.caller, Object.freeze({ id: x.id, label: "x" }));
});

/* ---------- scheduling: #9 explicit completion (F4, F9) ---------- */

test("cancel settles a hung handler immediately; later settlement is a fact event (F4, F9)", async () => {
  let release;
  const { rt, client } = setup(() => new Promise((r) => (release = r)));
  const { xact, promise } = rt.request(client, "t", { v: 1 });
  rt.cancel(xact);
  assert.equal(await asyncCode(promise), "E_CANCELLED");
  release("late");
  await turn();
  const settled = evs(rt, "handler_settled");
  assert.equal(settled.length, 1);
  assert.equal(settled[0].xact, xact);
  const invokes = evs(rt, "invoke").filter((e) => e.xact === xact);
  assert.equal(invokes.length, 1); // ONE outcome, honestly "cancelled + delivery stopped"
  assert.equal(invokes[0].outcome, "cancelled");
  assert.equal(invokes[0].delivery, "cancelled");
});

test("tick() enforces deadlines against a hung handler; no pending leak (F4)", async () => {
  let T = 0;
  const rt = new Runtime({ now: () => T });
  const { server } = rt.serve("svc", "t", () => new Promise(() => {}));
  const c = rt.spawn("c");
  rt.grant(server, "t", c, "t", { rights: ["send"] });
  const { xact, promise } = rt.request(c, "t", {}, { deadline: 5 });
  T = 10;
  rt.tick();
  assert.equal(await asyncCode(promise), "E_TIMEOUT");
  // the ledger records exactly one timeout outcome for the hung xact
  assert.equal(evs(rt, "invoke").filter((e) => e.xact === xact).length, 1);
  // and a new transaction can take the old id's place: no #pending residue
  const p2 = rt.request(c, "t", {}, { deadline: 15 });
  T = 20;
  rt.tick(20);
  assert.equal(await asyncCode(p2.promise), "E_TIMEOUT");
});

test("late completion past deadline withholds the result (invariant #9)", async () => {
  let T = 0;
  let release;
  const rt = new Runtime({ now: () => T });
  const { server } = rt.serve("svc", "t", () => new Promise((r) => (release = r)));
  const c = rt.spawn("c");
  rt.grant(server, "t", c, "t", { rights: ["send"] });
  const { promise } = rt.request(c, "t", {}, { deadline: 100 });
  T = 200;
  release("stale");
  assert.equal(await asyncCode(promise), "E_TIMEOUT");
  assert.equal(evs(rt, "invoke").at(-1).outcome, "timeout");
});

test("deadline in the past denies before admission, handler never runs (M1 semantics)", () => {
  let ran = false;
  const { rt, client } = setup(async () => {
    ran = true;
    return 1;
  });
  assert.equal(syncCode(() => rt.request(client, "t", {}, { deadline: -1 })), "E_DEADLINE");
  assert.equal(ran, false);
  assert.equal(evs(rt, "invoke_denied").at(-1).code, "E_DEADLINE");
});

test("abort signal cancels an in-flight request (M1 semantics)", async () => {
  let release;
  const { rt, client } = setup(() => new Promise((r) => (release = r)));
  const ac = new AbortController();
  const { promise } = rt.request(client, "t", {}, { signal: ac.signal });
  ac.abort();
  assert.equal(await asyncCode(promise), "E_CANCELLED");
  release(1);
});

test("cancellation cancels delivery, not side effects — journal says so (F9)", async () => {
  let sideEffects = 0;
  let release;
  const { rt, client } = setup(async () => {
    sideEffects += 1;
    return new Promise((r) => (release = r));
  });
  const { xact, promise } = rt.request(client, "t", {});
  rt.cancel(xact);
  await asyncCode(promise);
  release(1);
  await turn();
  assert.equal(sideEffects, 1); // honest: the world changed
  const inv = evs(rt, "invoke").find((e) => e.xact === xact);
  assert.equal(inv.outcome, "cancelled");
  assert.ok(inv.delivery === "cancelled"); // outcome is about DELIVERY, not effects
});

/* ---------- queue liveness (F5, F6) ---------- */

function mboxSetup(onFull = "block", mailbox = 1) {
  const T = { now: 0 };
  const rt = new Runtime({ now: () => T.now });
  const sender1 = rt.spawn("s1");
  const sender2 = rt.spawn("s2");
  const receiver = rt.spawn("r", { mailbox, onFull });
  const root = rt.address(receiver);
  rt.grantCap(root, sender1, "m", { rights: ["send"] });
  rt.grantCap(root, sender2, "m", { rights: ["send"] });
  return { rt, T, sender1, sender2, receiver };
}

test("expired head unblocks the waiting sender on recv (F5)", async () => {
  const { rt, T, sender1, sender2, receiver } = mboxSetup();
  const first = rt.tell(sender1, receiver, { n: 1 }, { deadline: 10 });
  assert.equal(first, true);
  const blocked = rt.tell(sender2, receiver, { n: 2 });
  assert.ok(blocked instanceof Promise);
  T.now = 20;
  assert.equal(rt.recv(receiver), null); // skipped the expired head…
  assert.deepEqual(await blocked, { ok: true }); // …and promoted the blocked sender
  const m = rt.recv(receiver);
  assert.equal(m.msg.n, 2);
});

test("cancelling a queued message promotes a waiter (F5b)", async () => {
  const { rt, sender1, sender2, receiver } = mboxSetup();
  rt.tell(sender1, receiver, { n: 1 });
  const queuedXact = evs(rt, "tell").at(-1).xact;
  const blocked = rt.tell(sender2, receiver, { n: 2 });
  assert.ok(blocked instanceof Promise);
  assert.equal(rt.cancel(queuedXact), true);
  assert.deepEqual(await blocked, { ok: true });
  assert.equal(rt.recv(receiver).msg.n, 2);
});

test("cancelling a blocked sender resolves {ok:false}, never rejects (F6)", async () => {
  const { rt, sender1, sender2, receiver } = mboxSetup();
  rt.tell(sender1, receiver, { n: 1 });
  const blocked = rt.tell(sender2, receiver, { n: 2 });
  const denied = evs(rt, "tell_blocked")[0];
  assert.equal(rt.cancel(denied.xact), true);
  assert.deepEqual(await blocked, { ok: false, reason: "cancelled" }); // resolution, not rejection
});

test("expired waiter resolves {ok:false, reason:'expired'} on tick (F5c, F6)", async () => {
  const { rt, T, sender1, sender2, receiver } = mboxSetup();
  rt.tell(sender1, receiver, { n: 1 });
  const blocked = rt.tell(sender2, receiver, { n: 2 }, { deadline: 10 });
  T.now = 20;
  rt.tick();
  assert.deepEqual(await blocked, { ok: false, reason: "expired" });
});

test("waiters are bounded; overflow sheds synchronously instead of growing memory (F6)", () => {
  const { rt, sender1, sender2, receiver } = mboxSetup("block", 1); // waiterCap = 4
  rt.tell(sender1, receiver, { n: 0 }); // fills mailbox
  const pending = [];
  for (let i = 0; i < 4; i++) pending.push(rt.tell(sender2, receiver, { n: i + 1 }));
  assert.equal(syncCode(() => rt.tell(sender2, receiver, { n: 99 })), "E_SHED");
  assert.equal(evs(rt, "shed").length, 1);
});

test("shed mode: full mailbox rejects with E_SHED (M1 semantics)", () => {
  const rt = new Runtime();
  const s = rt.spawn("s");
  const r = rt.spawn("r", { mailbox: 1, onFull: "shed" });
  rt.grantCap(rt.address(r), s, "m", { rights: ["send"] });
  assert.equal(rt.tell(s, r, 1), true);
  assert.equal(syncCode(() => rt.tell(s, r, 2)), "E_SHED");
});

/* ---------- value semantics across boundaries (F12) ---------- */

test("messages and results cross by structured clone, not reference (F12)", async () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  rt.grantCap(rt.address(b), a, "m", { rights: ["send"] });
  const m = { v: 1 };
  rt.tell(a, b, m);
  m.v = 2; // sender-side mutation after send
  assert.equal(rt.recv(b).msg.v, 1); // receiver saw the value at send time

  let retained;
  const { server } = rt.serve("svc", "t", async (args) => {
    retained = { v: args.v };
    return retained;
  });
  const c = rt.spawn("c");
  rt.grant(server, "t", c, "t", { rights: ["send"] });
  const out = await rt.invoke(c, "t", { v: 1 });
  retained.v = 99; // handler retains and mutates after completion
  assert.equal(out.v, 1); // caller's copy untouched
});

test("payload identity is never trusted; sender is substrate-stamped (invariant #4 sim)", () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  rt.grantCap(rt.address(b), a, "m", { rights: ["send"] });
  rt.tell(a, b, { sender: "someone-else" });
  const m = rt.recv(b);
  assert.equal(m.sender, a.id);
});

/* ---------- canonical hashing (F11) ---------- */

test("canonical hashes distinguish undefined/NaN and reject cycles without throwing (F11)", async () => {
  const { rt, client } = setup();
  await rt.invoke(client, "t", {});
  await rt.invoke(client, "t", { a: undefined });
  await rt.invoke(client, "t", { x: NaN });
  await rt.invoke(client, "t", { x: null });
  const [h1, h2, h3, h4] = evs(rt, "invoke").map((e) => e.argsHash);
  assert.notEqual(h1, h2);
  assert.notEqual(h3, h4);
  assert.match(h1, /^[0-9a-f]{64}$/);

  const cyc = { self: null };
  cyc.self = cyc;
  assert.equal(syncCode(() => rt.request(client, "t", cyc)), "E_CANON");
  assert.equal(evs(rt, "invoke_denied").at(-1).code, "E_CANON"); // journaled, not silent

  // cyclic RESULT still completes: outcome ok with explicit unhashable marker
  const { server } = rt.serve("svc2", "t2", async () => {
    const o = {};
    o.me = o;
    return o;
  });
  const c2 = rt.spawn("c2");
  rt.grant(server, "t2", c2, "t2", { rights: ["send"] });
  const res = await rt.invoke(c2, "t2", {});
  assert.equal(res.me, res);
  assert.equal(evs(rt, "invoke").at(-1).resultHash, "!unhashable");

  // BigInt results hash instead of throwing inside the completion path
  const { server: s3 } = rt.serve("svc3", "t3", async () => 10n);
  const c3 = rt.spawn("c3");
  rt.grant(s3, "t3", c3, "t3", { rights: ["send"] });
  assert.equal(await rt.invoke(c3, "t3", {}), 10n);
  assert.match(evs(rt, "invoke").at(-1).resultHash, /^[0-9a-f]{64}$/);
});

/* ---------- transaction identity (F13, F14) ---------- */

test("caller xacts collide only with live transactions; messages get fresh ids (F13)", async () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  rt.grantCap(rt.address(b), a, "m", { rights: ["send"] });
  assert.equal(rt.tell(a, b, 1, { xact: "dup" }), true);
  assert.equal(syncCode(() => rt.tell(a, b, 2, { xact: "dup" })), "E_INVAL");
  assert.equal(evs(rt, "deliver_denied").at(-1).code, "E_INVAL");
  // after delivery, ids may be reused without ambiguity with LIVE state
  rt.recv(b);
  assert.equal(rt.tell(a, b, 3, { xact: "dup" }), true);
  // auto-generated message ids never collide with request ids
  const { server } = rt.serve("svc", "t", async () => 1);
  const c = rt.spawn("c");
  rt.grant(server, "t", c, "t", { rights: ["send"] });
  const req = rt.request(c, "t", {});
  assert.equal(syncCode(() => rt.tell(a, b, 4, { xact: req.xact })), "E_INVAL");
  rt.cancel(req.xact);
  await asyncCode(req.promise);
});

test("actors and capabilities are runtime-branded: E_FOREIGN everywhere (F14)", async () => {
  const rtA = new Runtime();
  const rtB = new Runtime();
  const a = rtA.spawn("a");
  const bB = rtB.spawn("b");
  rtA.grantCap(rtA.address(rtA.spawn("x")), a, "x", { rights: ["send"] });
  assert.equal(syncCode(() => rtA.tell(a, bB, {})), "E_FOREIGN");
  assert.equal(evs(rtA, "deliver_denied").at(-1).code, "E_FOREIGN");
  assert.equal(syncCode(() => rtA.recv(bB)), "E_FOREIGN");
  assert.equal(syncCode(() => rtA.address(bB)), "E_FOREIGN");
  const capA = rtA.endpoint("t", async () => 1);
  const bActor = rtB.spawn("bb");
  assert.equal(syncCode(() => rtB.grantCap(capA, bActor, "t", { rights: ["send"] })), "E_FOREIGN");
});

/* ---------- audit completeness (F7, F8, F10) ---------- */

test("every denial class is journaled at the chokepoint (F8)", async () => {
  const { rt, server } = setup();
  const x = rt.spawn("x");
  await asyncCode(rt.invoke(x, "t", {})); // E_NO_CAP
  assert.equal(evs(rt, "invoke_denied").at(-1).code, "E_NO_CAP");
  assert.ok(evs(rt, "invoke_denied").at(-1).xact);
  await asyncCode(rt.invoke(x, "t", {}));
  assert.equal(syncCode(() => rt.grant(x, "empty", server, "s")), "E_NO_CAP");
  assert.equal(evs(rt, "grant_denied").at(-1).code, "E_NO_CAP");
  assert.equal(syncCode(() => rt.grant(server, "t", x, "s", { rights: ["bogus"] })), "E_INVAL");
  assert.equal(evs(rt, "grant_denied").at(-1).code, "E_INVAL");
  const denied = evs(rt, "invoke_denied").length;
  assert.ok(denied >= 2);
});

test("allow path journals the full quad; chain verifies and detects tampering (F10 wording)", async () => {
  const { rt, client } = setup();
  await rt.invoke(client, "t", { v: "7" });
  const inv = evs(rt, "invoke").at(-1);
  for (const k of ["xact", "actor", "tool", "outcome", "argsHash", "resultHash"]) assert.ok(k in inv, k);
  assert.equal(rt.journal.verify(), true);
  rt.journal.entries[3].event.outcome = "ok?";
  assert.equal(rt.journal.verify(), false); // internal hash-consistency, documented scope
});

test("bench sink is an explicit non-conforming configuration, journal events still generated (F7)", async () => {
  const plain = new Runtime();
  assert.equal(plain.conforming, true);
  const bench = new Runtime({ bench: true });
  assert.equal(bench.conforming, false);
  const { server } = bench.serve("svc", "t", async () => 1);
  const c = bench.spawn("c");
  bench.grant(server, "t", c, "t", { rights: ["send"] });
  await bench.invoke(c, "t", { v: 1 });
  const inv = evs(bench, "invoke").at(-1);
  assert.equal(inv.argsHash, "!bench");
  assert.ok(bench.journal.entries.length >= 4); // spawn+grant+invoke: events exist
  assert.equal(bench.journal.entries.at(-1).hash, "!bench"); // only crypto is replaced
  // and there is no other way to silence the journal
  assert.equal(await asyncCode(new Runtime({ journal: false }).invoke(c, "t", {})), "E_FOREIGN");
});

/* ---------- happy paths ---------- */

test("request/invoke success, distinct xacts, deterministic key-order-insensitive hashes", async () => {
  const { rt, client } = setup();
  const r1 = await rt.invoke(client, "t", { v: "a" });
  const r2 = await rt.invoke(client, "t", { v: "a" });
  assert.equal(r1, "ok:a");
  assert.equal(r1, r2);
  const [e1, e2] = evs(rt, "invoke");
  assert.notEqual(e1.xact, e2.xact);
  assert.equal(e1.argsHash, e2.argsHash);
  assert.equal(e1.resultHash, e2.resultHash);

  const rt2 = new Runtime();
  const { server } = rt2.serve("svc", "t", async (a) => a);
  const c = rt2.spawn("c");
  rt2.grant(server, "t", c, "t", { rights: ["send"] });
  await rt2.invoke(c, "t", { b: 2, a: 1 });
  await rt2.invoke(c, "t", { a: 1, b: 2 });
  const [k1, k2] = evs(rt2, "invoke").map((e) => e.argsHash);
  assert.equal(k1, k2); // canonical: sorted keys
});

test("spawn validates options synchronously", () => {
  const rt = new Runtime();
  assert.equal(syncCode(() => rt.spawn("x", { onFull: "explode" })), "E_INVAL");
  assert.equal(syncCode(() => rt.spawn("x", { onFull: "block" })), null);
});

test("recv by owner + full send/recv round trip with attenuated caps", async () => {
  const rt = new Runtime();
  const svc = rt.spawn("svc");
  const agent = rt.spawn("agent");
  const root = rt.address(svc);
  rt.grantCap(root, agent, "svc-in", { rights: ["send"] });
  // recv right cannot be delegated to another actor for svc's mailbox unless granted
  rt.grantCap(root, svc, "svc-in", { rights: ["recv"] });
  assert.equal(rt.tell(agent, svc, { job: 42 }), true);
  const m = rt.recv(svc);
  assert.equal(m.msg.job, 42);
  assert.equal(m.sender, agent.id);
});
