/**
 * Agamen v1.6 test suite.
 *
 * This file is the negative-test gate for the M1.6 authority-handle split.
 * Test names cite the internal re-audit of v1.5 as A1–A10 (blockers/majors)
 * and the original external review as F1–F15. Two v1.5 oracles are inverted
 * here on purpose: (a) `grantCap(rt.address(other), …)` succeeding is no
 * longer "no side channel" — an ActorId may now mint nothing and unlock
 * nothing; (b) a cyclic handler result is no longer `outcome: ok` with a
 * shared reference — it FAILS with E_CLONE. See A1/A2 tests below.
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
/* read-only journal view (A3: there is no rt.journal anymore) */
const evs = (rt, t) => rt.journalEntries().map((e) => e.event).filter((e) => e.t === t);
/* flush queued microtasks (handler .then chains) without relying on timers */
const turn = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
/* host-side wiring helper: give `who` a sendable mailbox cap for `target` */
const wire = (rt, who, target, slot = "m") =>
  rt.grantCap(rt.address(target), who, slot, { rights: ["send"] });

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

/* ---------- A1: three handles — identity is not authority ---------- */

test("ActorId is rejected by every privileged call (A1, oracle inversion)", () => {
  const rt = new Runtime();
  const b = rt.spawn("b");
  const id = rt.identityOf(b); // the "leaked" public handle
  assert.deepEqual(Object.keys(id).sort(), ["id", "label"]);
  assert.equal(id.slots, undefined);
  assert.equal(id.mbox, undefined);
  assert.equal(syncCode(() => rt.address(id)), "E_FOREIGN"); // mints nothing
  assert.equal(syncCode(() => rt.holds(id, "anything")), "E_FOREIGN"); // extracts nothing
  assert.equal(syncCode(() => rt.recv(id)), "E_FOREIGN"); // reads no mailbox
  assert.equal(syncCode(() => rt.request(id, "t", {})), "E_FOREIGN"); // runs no slots
  assert.equal(syncCode(() => rt.grantCap(rt.endpoint("e", async () => 1), id, "x")), "E_FOREIGN");
  // a hand-forged lookalike is inert: control is WeakMap membership, not shape
  const fake = { id: b.id, label: b.label };
  assert.equal(syncCode(() => rt.recv(fake)), "E_FOREIGN");
  assert.equal(syncCode(() => rt.address(fake)), "E_FOREIGN");
});

test("telling requires a presented mailbox capability; possession of the target unlocks nothing (A1)", () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  // v1.5 bypass replayed: knowing b's identity grants no send path
  assert.equal(syncCode(() => rt.tell(a, rt.identityOf(b), {})), "E_FOREIGN");
  assert.equal(evs(rt, "deliver_denied").at(-1).code, "E_FOREIGN");
  // only the host, holding b's CONTROL, can mint and attenuate its mailbox
  const root = rt.address(b);
  const sendCap = rt.grantCap(root, a, "b", { rights: ["send"] });
  assert.equal(rt.tell(a, sendCap, { hi: 1 }), true);
  const m = rt.recv(b);
  assert.equal(m.sender, a.id);
  assert.deepEqual(m.msg, { hi: 1 });
});

test("v1.5 slot-hijack is constructively impossible: installs need the target's control (A1, A5)", () => {
  const rt = new Runtime();
  const victim = rt.spawn("victim");
  rt.grantCap(rt.endpoint("search", async () => "mine"), victim, "search"); // legit install by host
  const evil = rt.endpoint("evil", async () => "pwned");
  // attacker holds the evil cap but presenting an ActorId installs nothing
  assert.equal(syncCode(() => rt.grantCap(evil, rt.identityOf(victim), "search")), "E_FOREIGN");
  assert.equal(evs(rt, "grant_denied").at(-1).code, "E_FOREIGN");
  // even toward the right control, overwriting an occupied slot needs consent
  assert.equal(
    syncCode(() => rt.grantCap(evil, victim, "search", { overwrite: false })),
    "E_OCCUPIED"
  );
  assert.equal(rt.holds(victim, "search").id !== evil.id, true); // original stands
  // explicit overwrite by whoever holds the controller succeeds
  assert.equal(syncCode(() => rt.grantCap(evil, victim, "search", { overwrite: true })), null);
});

test("send-only capability cannot delegate — and no self-service root exists (A1, F1c, oracle re-check)", () => {
  const rt = new Runtime();
  const { server } = rt.serve("svc", "t", async () => 1);
  const hop = rt.spawn("hop");
  const sendOnly = rt.grant(server, "t", hop, "t", { rights: ["send"] });
  const other = rt.spawn("other");
  assert.equal(rt.rightsOf(sendOnly).join(), "send");
  assert.equal(syncCode(() => rt.grant(hop, "t", other, "t", { rights: ["send"] })), "E_RIGHTS");
  assert.equal(syncCode(() => rt.grantCap(sendOnly, other, "t", { rights: ["send"] })), "E_RIGHTS");
  assert.equal(evs(rt, "grant_denied").at(-1).code, "E_RIGHTS");
  // the v1.5 "no side channel" test asserted grantCap(address(other)) SUCCEEDS.
  // That was the bypass. Under v1.6 the host may wire caps normally, but a
  // principal holding only other's PUBLIC identity can neither mint nor use
  // its mailbox root: identityOf(other) is accepted nowhere privileged.
  assert.equal(syncCode(() => rt.grantCap(rt.address(rt.identityOf(other)), hop, "x", { rights: ["send"] })), "E_FOREIGN");
});

test("mailbox capability cannot be invoked; endpoint capability cannot tell (A1, A7)", async () => {
  const rt = new Runtime();
  const { server } = rt.serve("svc", "t", async () => 1);
  const a = rt.spawn("a");
  rt.grantCap(rt.address(a), server, "mb", { rights: ["send"] }); // mailbox cap in a slot
  assert.equal(await asyncCode(rt.invoke(server, "mb", {})), "E_RIGHTS"); // not invokable
  const ep = rt.holds(server, "t"); // endpoint cap
  assert.equal(syncCode(() => rt.tell(server, ep, {})), "E_RIGHTS"); // not a mailbox cap
});

test("revocation cascade is not undoable by holders; revoked mailbox cap cannot tell (F2, invariant #6)", async () => {
  const { rt, server, client } = setup();
  const leaf = rt.spawn("leaf");
  const mid = rt.grant(server, "t", client, "mid", { rights: ["send", "grant"] });
  const leafCap = rt.grantCap(mid, leaf, "t", { rights: ["send"] });
  rt.revoke(mid);
  assert.equal(rt.isRevoked(leafCap), true);
  assert.equal(rt.isRevoked(mid), true);
  assert.throws(() => { leafCap.revoked = false; });
  assert.equal(rt.isRevoked(leafCap), true);
  assert.equal(await asyncCode(rt.invoke(leaf, "t", {})), "E_REVOKED");

  const rt2 = new Runtime();
  const b2 = rt2.spawn("b");
  const root2 = rt2.address(b2);
  const s2 = rt2.spawn("s");
  const sendCap2 = rt2.grantCap(root2, s2, "m", { rights: ["send"] });
  rt2.revoke(root2);
  assert.equal(syncCode(() => rt2.tell(s2, sendCap2, {})), "E_REVOKED");
});

/* ---------- A2 + F12: strict clone-or-fail in both directions ---------- */

test("invocation args are cloned at admission: handler mutation cannot reach the caller (A2)", async () => {
  const input = { balance: 100 };
  const { rt, client } = setup(async (args) => {
    args.balance = 0; // hostile tool mutating its input graph
    return "done";
  });
  assert.equal(await rt.invoke(client, "t", input), "done");
  assert.equal(input.balance, 100); // caller's object untouched
});

test("membranes never see caller-owned objects, and rewrites are re-isolated (A2)", async () => {
  const rt = new Runtime();
  const input = { v: 1, nested: { n: 2 } };
  let membraneSaw, handlerSaw;
  const { server } = rt.serve("svc", "t", async (args) => {
    handlerSaw = args;
    return args.v;
  });
  const c = rt.spawn("c");
  rt.grant(server, "t", c, "t", {
    rights: ["send"],
    membranes: [
      {
        kind: "rewriter",
        create: () => (ctx) => {
          membraneSaw = ctx.args;
          return { v: ctx.args.v + 1, nested: ctx.args.nested }; // live object graph
        },
      },
    ],
  });
  await rt.invoke(c, "t", input);
  assert.notEqual(membraneSaw, input); // membrane got a clone
  input.nested.n = 99; // post-admission caller mutation
  assert.notEqual(handlerSaw, membraneSaw); // rewrite re-isolated
  assert.equal(handlerSaw.v, 2);
});

test("uncloneable ARGS deny with E_CANON; cyclic args deny with E_DOMAIN (A2, F11)", () => {
  const { rt, client } = setup();
  assert.equal(syncCode(() => rt.request(client, "t", { f: () => 1 })), "E_CANON");
  assert.equal(evs(rt, "invoke_denied").at(-1).code, "E_CANON");
  // cycles survive structuredClone, so they are caught by the domain check:
  // a cyclic graph is not a finite tree and can never be digested
  const cyc = { self: null };
  cyc.self = cyc;
  assert.equal(syncCode(() => rt.request(client, "t", cyc)), "E_DOMAIN");
  assert.equal(evs(rt, "invoke_denied").at(-1).code, "E_DOMAIN");
});

test("cyclic handler RESULT FAILS the xact — no shared-reference fallback (A2, oracle inversion)", async () => {
  const { rt, client } = setup(async () => {
    const o = {};
    o.me = o;
    return o;
  });
  const { promise } = rt.request(client, "t", {});
  assert.equal(await asyncCode(promise), "E_DOMAIN"); // clones, but cannot be hashed
  const inv = evs(rt, "invoke").at(-1);
  assert.equal(inv.outcome, "fail"); // v1.5 wrongly recorded `ok` with a shared reference
  assert.equal(inv.resultHash, undefined);
});

test("uncloneable handler RESULT FAILS with E_CLONE (A2)", async () => {
  const { rt, client } = setup(async () => () => 1);
  const { promise } = rt.request(client, "t", {});
  assert.equal(await asyncCode(promise), "E_CLONE");
  const inv = evs(rt, "invoke").at(-1);
  assert.equal(inv.outcome, "fail");
});

test("results crossing by clone: caller and handler hold independent copies (F12)", async () => {
  let retained;
  const { rt, client } = setup(async (args) => {
    retained = args;
    return { echo: args.v };
  });
  const out = await rt.invoke(client, "t", { v: 1 });
  assert.notEqual(out, retained); // delivered value is a fresh clone
  assert.equal(out.echo, 1);
  out.echo = 99; // caller mutation cannot reach the handler's graph
  assert.equal(retained.echo, undefined);
  assert.equal(evs(rt, "invoke").at(-1).outcome, "ok");
});

/* ---------- A3: audit cannot be disabled from the realm ---------- */

test("rt.journal no longer exists; faking it cannot silence the ledger (A3)", async () => {
  const { rt, client } = setup();
  assert.equal(rt.journal, undefined);
  // hostile same-realm assignment: creates an inert own property
  rt.journal = { entries: [], append() {}, verify: () => true };
  await rt.invoke(client, "t", { v: 1 });
  assert.equal(rt.verifyJournal(), true);
  assert.ok(evs(rt, "invoke").length >= 1); // ledger still growing internally
  assert.equal(rt.journal.entries.length, 0); // the fake was never appended to
});

test("journalEntries() snapshots are inert; conforming is a read-only getter (A3)", async () => {
  const { rt, client } = setup();
  await rt.invoke(client, "t", { v: 1 });
  const before = rt.journalEntries().length;
  const snap = rt.journalEntries();
  snap[0].event.t = "hacked";
  snap.push({ seq: 999, event: { t: "forged" } });
  assert.equal(rt.journalEntries().length, before);
  assert.equal(rt.journalEntries()[0].event.t, "spawn");
  assert.equal(rt.verifyJournal(), true);
  assert.equal(rt.conforming, true);
  assert.throws(() => { rt.conforming = false; }); // getter-only in strict ESM
});

test("bench sink is an explicit non-conforming configuration; events still generated (F7)", async () => {
  const bench = new Runtime({ bench: true });
  assert.equal(bench.conforming, false);
  const { server } = bench.serve("svc", "t", async () => 1);
  const c = bench.spawn("c");
  bench.grant(server, "t", c, "t", { rights: ["send"] });
  await bench.invoke(c, "t", { v: 1 });
  const inv = evs(bench, "invoke").at(-1);
  assert.equal(inv.argsHash, "!bench");
  assert.ok(bench.journalEntries().length >= 4);
  assert.equal(bench.journalEntries().at(-1).hash, "!bench");
});

test("record() appends trusted-plane facts to the same verified ledger", () => {
  const rt = new Runtime();
  const before = rt.journalEntries().length;
  rt.record({ t: "intent_fork", parent: "i1", child: "i2" });
  assert.equal(rt.journalEntries().length, before + 1);
  assert.equal(rt.journalEntries().at(-1).event.t, "intent_fork");
  assert.equal(rt.verifyJournal(), true);
});

/* ---------- A4: frozen canonical value domain, type-tagged encoding ---------- */

test("undefined/NaN/Date/Map/Set are outside the domain: E_DOMAIN, never aliased (A4)", async () => {
  const { rt, client } = setup();
  assert.equal(syncCode(() => rt.request(client, "t", { a: undefined })), "E_DOMAIN");
  assert.equal(syncCode(() => rt.request(client, "t", { x: NaN })), "E_DOMAIN");
  assert.equal(syncCode(() => rt.request(client, "t", { x: Infinity })), "E_DOMAIN");
  assert.equal(syncCode(() => rt.request(client, "t", { d: new Date(0) })), "E_DOMAIN");
  assert.equal(syncCode(() => rt.request(client, "t", { m: new Map([["x", 1]]) })), "E_DOMAIN");
  assert.equal(syncCode(() => rt.request(client, "t", { s: new Set([1, 2]) })), "E_DOMAIN");
  // exotic types stay exotic across a clone, so nested rejection also fires
  assert.equal(syncCode(() => rt.request(client, "t", { o: { deep: [new Date(0)] } })), "E_DOMAIN");
  assert.equal(evs(rt, "invoke_denied").at(-1).code, "E_DOMAIN");
});

test("the v1.5 sentinel collisions are gone: strings cannot alias other types (A4)", async () => {
  const { rt, client } = setup();
  // "!undef"/"!num:NaN"/"!bigint:10" were v1.5 tags; the typed values are now
  // E_DOMAIN or type-tagged, so strings hash without aliasing anything.
  await rt.invoke(client, "t", { a: "!undef" });
  const hStr = evs(rt, "invoke").at(-1).argsHash;
  await rt.invoke(client, "t", { a: "s:!undef" });
  assert.notEqual(evs(rt, "invoke").at(-1).argsHash, hStr);
  await rt.invoke(client, "t", { a: 10n });
  const hBig = evs(rt, "invoke").at(-1).argsHash;
  await rt.invoke(client, "t", { a: "10" });
  assert.notEqual(evs(rt, "invoke").at(-1).argsHash, hBig);
  await rt.invoke(client, "t", { a: true });
  const hBool = evs(rt, "invoke").at(-1).argsHash;
  await rt.invoke(client, "t", { a: "true" });
  assert.notEqual(evs(rt, "invoke").at(-1).argsHash, hBool);
  assert.match(hBig, /^[0-9a-f]{64}$/);
  // -0 and 0 are explicitly distinguished by the encoding
  await rt.invoke(client, "t", { a: 0 });
  const h0 = evs(rt, "invoke").at(-1).argsHash;
  await rt.invoke(client, "t", { a: -0 });
  assert.notEqual(evs(rt, "invoke").at(-1).argsHash, h0);
  // canonical: key order irrelevant, nested plain objects fine
  await rt.invoke(client, "t", { b: 2, a: 1, c: { z: [1, "x", null] } });
  const k1 = evs(rt, "invoke").at(-1).argsHash;
  await rt.invoke(client, "t", { c: { z: [1, "x", null] }, a: 1, b: 2 });
  assert.equal(evs(rt, "invoke").at(-1).argsHash, k1);
});

/* ---------- A8: transaction identity — lifetime-unique xact + correlationId ---------- */

test("internal xacts are never reused, even after delivery (A8, oracle inversion)", () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  const cap = wire(rt, a, b);
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    rt.tell(a, cap, { n: i });
    const x = evs(rt, "tell").at(-1).xact;
    assert.equal(seen.has(x), false, `xact ${x} reused`);
    seen.add(x);
    rt.recv(b); // fully drained — ids STILL may not be recycled
  }
});

test("user labels travel as correlationId and are journaled on allow and deny paths (A8)", async () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  assert.equal(syncCode(() => rt.tell(a, rt.identityOf(b), {}, { correlationId: "job42" })), "E_FOREIGN"); // denied
  assert.equal(evs(rt, "deliver_denied").at(-1).correlationId, "job42");
  const cap = wire(rt, a, b);
  rt.tell(a, cap, { n: 1 }, { correlationId: "job42" });
  assert.equal(evs(rt, "tell").at(-1).correlationId, "job42");
  assert.equal(rt.recv(b).xact !== undefined, true);

  const { rt: rt2, client } = setup();
  await rt2.invoke(client, "t", { v: 1 }, { correlationId: "approval-7" });
  const inv = evs(rt2, "invoke").at(-1);
  assert.equal(inv.correlationId, "approval-7");
  assert.equal(syncCode(() => rt2.request(client, "t", {}, { deadline: -1, correlationId: "approval-8" })), "E_DEADLINE");
  assert.equal(evs(rt2, "invoke_denied").at(-1).correlationId, "approval-8");
});

test("consecutive grant denials get distinct xacts (A8 bug: x${seq} without ++)", () => {
  const rt = new Runtime();
  const v = rt.spawn("v");
  const evil = rt.endpoint("evil", async () => 1);
  syncCode(() => rt.grantCap(evil, rt.identityOf(v), "s")); // denied
  syncCode(() => rt.grantCap(evil, rt.identityOf(v), "s")); // denied again
  const g = evs(rt, "grant_denied");
  assert.equal(g.length, 2);
  assert.notEqual(g[0].xact, g[1].xact);
});

/* ---------- A6 + A7: rights algebra is real, foreign denials journaled ---------- */

test("recv/revoke are no longer rights; unknown rights are refused at mint (A7)", () => {
  const rt = new Runtime();
  const { server } = rt.serve("svc", "t", async () => 1);
  const x = rt.spawn("x");
  assert.equal(syncCode(() => rt.grant(server, "t", x, "t", { rights: ["recv"] })), "E_INVAL");
  assert.equal(syncCode(() => rt.grant(server, "t", x, "t", { rights: ["revoke"] })), "E_INVAL");
  assert.equal(syncCode(() => rt.endpoint("e", async () => 1, { rights: ["recv"] })), "E_INVAL");
  const sg = rt.grant(server, "t", x, "sg", { rights: ["send", "grant"] });
  // 'revoke' is not a right at all — the algebra rejects it before attenuation
  assert.equal(syncCode(() => rt.grantCap(sg, x, "y", { rights: ["send", "revoke"] })), "E_INVAL");
});

test("foreign grantCap source and foreign revoke are denied AND journaled (A6)", () => {
  const rtA = new Runtime();
  const rtB = new Runtime();
  const capA = rtA.endpoint("t", async () => 1);
  const bActor = rtB.spawn("bb");
  assert.equal(syncCode(() => rtB.grantCap(capA, bActor, "t", { rights: ["send"] })), "E_FOREIGN");
  const last = evs(rtB, "grant_denied").at(-1);
  assert.equal(last.code, "E_FOREIGN");
  assert.ok(last.xact); // the v1.5 gap: this denial was raw-thrown
  assert.equal(syncCode(() => rtB.revoke(capA)), "E_FOREIGN");
  assert.equal(evs(rtB, "revoke_denied").at(-1).code, "E_FOREIGN");
});

/* ---------- zero ambient authority + opaque tokens (F2, F3) ---------- */

test("zero ambient authority; tokens expose no authority state (F2, F3)", () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  assert.equal(syncCode(() => rt.holds(a, "anything")), "E_NO_CAP");
  assert.deepEqual(Object.keys(a).sort(), ["id", "label"]);
  assert.throws(() => { a.slots = new Map(); }); // frozen
  assert.equal(syncCode(() => rt.holds(a, "anything")), "E_NO_CAP"); // injection inert

  const { server } = rt.serve("svc", "t", async () => 1);
  const cap = rt.holds(server, "t");
  assert.deepEqual(Object.keys(cap), ["id"]);
  assert.throws(() => { cap.target = {}; });
  assert.throws(() => { cap.revoked = true; });
  const rs = rt.rightsOf(cap);
  assert.ok(Object.isFrozen(rs));
  assert.throws(() => rs.push("x"));
});

test("handler ctx carries immutable metadata, never live objects (F3)", async () => {
  const { rt, client, seen } = setup();
  await rt.invoke(client, "t", { v: "x" });
  const ctx = seen[0];
  assert.ok(Object.isFrozen(ctx));
  assert.deepEqual(Object.keys(ctx).sort(), ["caller", "tool", "xact"]);
  assert.deepEqual(Object.keys(ctx.caller).sort(), ["id", "label"]);
  assert.throws(() => { ctx.caller.id = 999; });
  assert.throws(() => { ctx.caller.foo = 1; });
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
  assert.equal(evs(rt, "invoke").filter((e) => e.xact === xact).length, 1);
  const p2 = rt.request(c, "t", {}, { deadline: 15 });
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

test("A10: signal listeners are detached on normal settle — no retention on long-lived signals (A10)", async () => {
  const { rt, client } = setup(async (a) => a.v);
  let live = 0;
  const stubSignal = {
    aborted: false,
    addEventListener() { live += 1; },
    removeEventListener() { live -= 1; },
  };
  for (let i = 0; i < 3; i++) await rt.invoke(client, "t", { v: i }, { signal: stubSignal });
  assert.equal(live, 0); // every success/failure settled with its listener removed
  // and cancellation via a real signal still works end-to-end
  let release;
  const { rt: rt2, client: c2 } = setup(() => new Promise((r) => (release = r)));
  const ac = new AbortController();
  const { promise } = rt2.request(c2, "t", {}, { signal: ac.signal });
  ac.abort();
  assert.equal(await asyncCode(promise), "E_CANCELLED");
  release(1); // late settle must not throw: detach already ran, cancel() is idempotent
  await turn();
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
  assert.ok(inv.delivery === "cancelled");
});

/* ---------- queue liveness (F5, F6) ---------- */

function mboxSetup(onFull = "block", mailbox = 1) {
  const T = { now: 0 };
  const rt = new Runtime({ now: () => T.now });
  const sender1 = rt.spawn("s1");
  const sender2 = rt.spawn("s2");
  const receiver = rt.spawn("r", { mailbox, onFull });
  wire(rt, sender1, receiver);
  wire(rt, sender2, receiver);
  const capOf = (who) => rt.holds(who, "m");
  return { rt, T, sender1, sender2, receiver, capOf };
}

test("expired head unblocks the waiting sender on recv (F5)", async () => {
  const { rt, T, sender1, sender2, receiver, capOf } = mboxSetup();
  assert.equal(rt.tell(sender1, capOf(sender1), { n: 1 }, { deadline: 10 }), true);
  const blocked = rt.tell(sender2, capOf(sender2), { n: 2 });
  assert.equal(typeof blocked.then, "function");
  T.now = 20;
  assert.equal(rt.recv(receiver), null); // skipped the expired head…
  assert.deepEqual(await blocked, { ok: true }); // …and promoted the blocked sender
  assert.equal(rt.recv(receiver).msg.n, 2);
});

test("cancelling a queued message promotes a waiter (F5b)", async () => {
  const { rt, sender1, sender2, receiver, capOf } = mboxSetup();
  rt.tell(sender1, capOf(sender1), { n: 1 });
  const queuedXact = evs(rt, "tell").at(-1).xact;
  const blocked = rt.tell(sender2, capOf(sender2), { n: 2 });
  assert.equal(typeof blocked.then, "function");
  assert.equal(rt.cancel(queuedXact), true);
  assert.deepEqual(await blocked, { ok: true });
  assert.equal(rt.recv(receiver).msg.n, 2);
});

test("cancelling a blocked sender resolves {ok:false}, never rejects (F6)", async () => {
  const { rt, sender1, sender2, receiver, capOf } = mboxSetup();
  rt.tell(sender1, capOf(sender1), { n: 1 });
  const blocked = rt.tell(sender2, capOf(sender2), { n: 2 });
  const denied = evs(rt, "tell_blocked")[0];
  assert.equal(rt.cancel(denied.xact), true);
  assert.deepEqual(await blocked, { ok: false, reason: "cancelled" });
});

test("expired waiter resolves {ok:false, reason:'expired'} on tick (F5c, F6)", async () => {
  const { rt, T, sender1, sender2, receiver, capOf } = mboxSetup();
  rt.tell(sender1, capOf(sender1), { n: 1 });
  const blocked = rt.tell(sender2, capOf(sender2), { n: 2 }, { deadline: 10 });
  T.now = 20;
  rt.tick();
  assert.deepEqual(await blocked, { ok: false, reason: "expired" });
});

test("waiters are bounded; overflow sheds synchronously instead of growing memory (F6)", () => {
  const { rt, sender1, sender2, receiver, capOf } = mboxSetup("block", 1); // waiterCap = 4
  rt.tell(sender1, capOf(sender1), { n: 0 }); // fills mailbox
  for (let i = 0; i < 4; i++) rt.tell(sender2, capOf(sender2), { n: i + 1 });
  assert.equal(syncCode(() => rt.tell(sender2, capOf(sender2), { n: 99 })), "E_SHED");
  assert.equal(evs(rt, "shed").length, 1);
});

test("shed mode: full mailbox rejects with E_SHED (M1 semantics)", () => {
  const rt = new Runtime();
  const s = rt.spawn("s");
  const r = rt.spawn("r", { mailbox: 1, onFull: "shed" });
  const cap = wire(rt, s, r);
  assert.equal(rt.tell(s, cap, 1), true);
  assert.equal(syncCode(() => rt.tell(s, cap, 2)), "E_SHED");
});

/* ---------- F13, F14: branding and message values ---------- */

test("messages cross by structured clone, not reference (F12)", () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  const cap = wire(rt, a, b);
  const m = { v: 1 };
  rt.tell(a, cap, m);
  m.v = 2; // sender-side mutation after send
  assert.equal(rt.recv(b).msg.v, 1); // receiver saw the value at send time
});

test("payload identity is never trusted; sender is substrate-stamped (invariant #4 sim)", () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  const cap = wire(rt, a, b);
  rt.tell(a, cap, { sender: "someone-else" });
  assert.equal(rt.recv(b).sender, a.id);
});

test("actors and capabilities are runtime-branded: E_FOREIGN everywhere (F14)", () => {
  const rtA = new Runtime();
  const rtB = new Runtime();
  const a = rtA.spawn("a");
  const bB = rtB.spawn("b");
  assert.equal(syncCode(() => rtB.tell(bB, rtA.address(rtA.spawn("z")), {})), "E_FOREIGN");
  assert.equal(evs(rtB, "deliver_denied").at(-1).code, "E_FOREIGN");
  assert.equal(syncCode(() => rtA.recv(bB)), "E_FOREIGN");
  assert.equal(syncCode(() => rtA.address(bB)), "E_FOREIGN");
});

/* ---------- audit completeness (F8) ---------- */

test("every denial class is journaled at the chokepoint (F8)", async () => {
  const { rt, server } = setup();
  const x = rt.spawn("x");
  await asyncCode(rt.invoke(x, "t", {})); // E_NO_CAP
  assert.equal(evs(rt, "invoke_denied").at(-1).code, "E_NO_CAP");
  assert.ok(evs(rt, "invoke_denied").at(-1).xact);
  await asyncCode(rt.invoke(x, "t", {}));
  assert.equal(evs(rt, "invoke_denied").at(-1).xact !== evs(rt, "invoke_denied").at(-2).xact, true);
  assert.equal(syncCode(() => rt.grant(x, "empty", server, "s")), "E_NO_CAP");
  assert.equal(evs(rt, "grant_denied").at(-1).code, "E_NO_CAP");
  assert.equal(syncCode(() => rt.grant(server, "t", x, "s", { rights: ["bogus"] })), "E_INVAL");
  assert.equal(evs(rt, "grant_denied").at(-1).code, "E_INVAL");
  // source-cap revocation denial on grant
  const root = rt.address(x);
  rt.revoke(root);
  assert.equal(syncCode(() => rt.grantCap(root, x, "s2")), "E_REVOKED");
  assert.equal(evs(rt, "grant_denied").at(-1).code, "E_REVOKED");
  assert.ok(evs(rt, "invoke_denied").length >= 2);
});

test("allow path journals the full quad; chain verifies (F10 wording)", async () => {
  const { rt, client } = setup();
  await rt.invoke(client, "t", { v: "7" });
  const inv = evs(rt, "invoke").at(-1);
  for (const k of ["xact", "actor", "tool", "outcome", "argsHash", "resultHash"]) assert.ok(k in inv, k);
  assert.equal(rt.verifyJournal(), true);
});

/* ---------- happy paths ---------- */

test("request/invoke success, distinct xacts, deterministic hashes", async () => {
  const { rt, client } = setup();
  const r1 = await rt.invoke(client, "t", { v: "a" });
  const r2 = await rt.invoke(client, "t", { v: "a" });
  assert.equal(r1, "ok:a");
  assert.equal(r1, r2);
  const [e1, e2] = evs(rt, "invoke");
  assert.notEqual(e1.xact, e2.xact);
  assert.equal(e1.argsHash, e2.argsHash);
  assert.equal(e1.resultHash, e2.resultHash);
});

test("spawn validates options synchronously", () => {
  const rt = new Runtime();
  assert.equal(syncCode(() => rt.spawn("x", { onFull: "explode" })), "E_INVAL");
  assert.equal(syncCode(() => rt.spawn("x", { onFull: "block" })), null);
});

test("recv is self-service via the control handle; full round trip with attenuated caps (A7)", () => {
  const rt = new Runtime();
  const svc = rt.spawn("svc");
  const agent = rt.spawn("agent");
  const root = rt.address(svc);
  const sendCap = rt.grantCap(root, agent, "svc-in", { rights: ["send"] });
  assert.equal(rt.tell(agent, sendCap, { job: 42 }), true);
  const m = rt.recv(svc); // possession of the controller IS the receive authority
  assert.equal(m.msg.job, 42);
  assert.equal(m.sender, agent.id);
});

/* ---------- host-plane admit hook (required by APM CO-5) ---------- */

test("onAdmit runs with the final xact BEFORE the handler — a binding fact can precede effects", async () => {
  let seenByHandler = -1;
  const { rt, client } = setup(async () => {
    // this body IS the effect; the ledger as seen here was written before it
    seenByHandler = rt.journalEntries().map((e) => e.event.t).filter((t) => t === "admit_mark").length;
    return 1;
  });
  const req = rt.request(client, "t", {}, { onAdmit: (x) => rt.record({ t: "admit_mark", xact: x }) });
  const result = await req.promise;
  assert.equal(result, 1);
  assert.equal(seenByHandler, 1); // the effect observed its own binding
  assert.equal(evs(rt, "admit_mark")[0].xact, req.xact);
  const names = rt.journalEntries().map((e) => e.event.t);
  assert.ok(names.indexOf("admit_mark") < names.indexOf("invoke")); // admit-marked, then settled
});

test("a throwing onAdmit vetoes the dispatch before any effect; the veto is a fact, not silence", async () => {
  let hits = 0;
  const { rt, client } = setup(async () => { hits += 1; return 1; });
  let threw = null;
  try {
    rt.request(client, "t", {}, { onAdmit: () => { throw new Error("veto"); } });
  } catch (e) {
    threw = e;
  }
  assert.equal(threw?.message, "veto"); // re-thrown to the caller, who never holds the promise
  assert.equal(hits, 0);
  await turn();
  assert.equal(hits, 0); // and the handler stays uncalled
  assert.equal(evs(rt, "invoke").at(-1)?.outcome, "fail"); // settled as a fact at veto time
  assert.equal(evs(rt, "invoke_denied").length, 0); // admitted-then-vetoed ≠ denied
});
