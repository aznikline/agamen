/**
 * Agamen APM experiment tests (semantic track S1).
 *
 * Positive lifecycle coverage plus the negative gate that gives the model
 * its teeth: completion must be ledger-backed, approval must precede
 * effect, budget is charged, revoked subtrees lose authority instantly,
 * and context merges never touch a lineage they did not ask for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "../src/runtime.js";
import { AgentSystem, Intent } from "../src/intent.js";

const asyncCode = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};
const evs = (rt, t) => rt.journalEntries().map((e) => e.event).filter((e) => e.t === t);

/* one tool ("t") returning a deterministic receipt; agent registered with
 * a model; intent holds a budgeted envelope on it */
function harness({ budget = null, approval = "not_required", deadline = null } = {}) {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const { server } = rt.serve("tool-svc", "t", async (a) => ({ receipt: `did:${a.job ?? "?"}` }));
  const agent = sys.register("planner", { model: "m-alpha" });
  const intent = sys.open(agent, { goal: { outcome: "ship report" }, budget, approval, deadline });
  const slot = sys.grantFor(intent, server, "t");
  return { rt, sys, server, agent, intent, slot };
}

/* ---------- completion is evidence, not a claim ---------- */

test("happy path: open → grant → call → complete(evidence); whole lifecycle on one ledger", async () => {
  const { rt, sys, agent, intent, slot } = harness();
  const { xact, result } = await sys.call(intent, slot, { job: 1 });
  assert.deepEqual(result, { receipt: "did:1" });
  // substrate invocation and intent fact share the correlation id
  const inv = evs(rt, "invoke").at(-1);
  assert.equal(inv.correlationId, intent.id);
  assert.equal(inv.outcome, "ok");
  await sys.complete(intent, [{ xact }, { note: "human summary" }]);
  assert.equal(intent.state, "completed");
  assert.equal(intent.evidence[0].backed, true);
  assert.equal(intent.evidence[1].backed, false); // unbacked items are allowed ALONGSIDE
  const facts = evs(rt, "intent_complete")[0];
  assert.equal(facts.agent, agent.id);
  assert.equal(rt.verifyJournal(), true);
  for (const t of ["intent_open", "intent_grant", "intent_call", "intent_complete"]) {
    assert.ok(evs(rt, t).length >= 1, t);
  }
});

test("completion without ledger-backed evidence is refused (negative gate)", async () => {
  const { sys, server, intent, slot } = harness();
  assert.equal(await asyncCode(sys.complete(intent, [])), "E_NO_EVIDENCE");
  assert.equal(await asyncCode(sys.complete(intent, [{ note: "trust me" }])), "E_NO_EVIDENCE");
  const { xact } = await sys.call(intent, slot, { job: 1 });
  assert.equal(await asyncCode(sys.complete(intent, [{ xact: "x999999-forged" }])), "E_NO_EVIDENCE");
  // an xact from ANOTHER intent does not count either — same runtime, so
  // the ids live in one namespace and the refusal is about correlation,
  // not about an accidental string mismatch across runtimes.
  const agent2 = sys.register("worker2");
  const intent2 = sys.open(agent2, { goal: { outcome: "unrelated" } });
  const slot2 = sys.grantFor(intent2, server, "t");
  const other = await sys.call(intent2, slot2, {});
  assert.equal(await asyncCode(sys.complete(intent, [{ xact: other.xact }])), "E_NO_EVIDENCE");
  void xact;
  assert.equal(intent.state, "active"); // refusal leaves it open for real evidence
  await sys.complete(intent, [{ xact }]);
  assert.equal(intent.state, "completed");
});

/* ---------- approval as a first-class state ---------- */

test("approval-gated intents effect nothing until approved; scope lands in the ledger", async () => {
  const { rt, sys, intent, slot } = harness({ approval: "required" });
  assert.equal(await asyncCode(sys.call(intent, slot, { job: 1 })), "E_APPROVAL");
  assert.equal(evs(rt, "invoke_denied").length, 0); // never even reached the substrate
  sys.approve(intent, { jobs: [1, 2] });
  const { xact } = await sys.call(intent, slot, { job: 1 });
  assert.ok(xact);
  const ap = evs(rt, "intent_approve")[0];
  assert.deepEqual(ap.scope, { jobs: [1, 2] });
});

test("approving an intent that never required approval is a state error", () => {
  const { sys, intent } = harness();
  assert.throws(() => sys.approve(intent, {}), (e) => e.code === "E_STATE");
});

/* ---------- budget ---------- */

test("intent budget is charged per attempt; denials are facts, not silence", async () => {
  const { rt, sys, intent, slot } = harness({ budget: { calls: 2 } });
  await sys.call(intent, slot, { job: 1 });
  await sys.call(intent, slot, { job: 2 });
  assert.equal(await asyncCode(sys.call(intent, slot, { job: 3 })), "E_BUDGET");
  const last = evs(rt, "intent_call").at(-1);
  assert.equal(last.outcome, "denied");
  assert.equal(last.code, "E_BUDGET");
});

test("a slot outside the intent envelope is not callable", async () => {
  const { sys, intent } = harness();
  assert.equal(await asyncCode(sys.call(intent, "someone-elses-slot", {})), "E_NO_CAP");
});

/* ---------- context lineage: fork / merge ---------- */

test("fork isolates beliefs; merge accepts or rejects explicitly, lineage records both", async () => {
  const { rt, sys, agent } = (() => {
    const rt2 = new Runtime();
    const sys2 = new AgentSystem(rt2);
    const a = sys2.register("k", { context: { facts: ["v1"] } });
    return { rt: rt2, sys: sys2, agent: a };
  })();
  void agent;
  const root = sys.open(agent, { goal: { outcome: "research" }, context: { facts: ["v1"] } });
  const child = sys.fork(root, { goal: { outcome: "sub-question" } });
  sys.mutateContext(child, { facts: ["v1", "child-learned"] });
  assert.deepEqual(root.context.snapshot(), { facts: ["v1"] }); // isolated
  sys.mergeContext(child, { accept: true });
  assert.deepEqual(root.context.snapshot(), { facts: ["v1", "child-learned"] });
  const rejected = sys.fork(root);
  sys.mutateContext(rejected, { facts: ["denied-payload"] });
  sys.mergeContext(rejected, { accept: false });
  assert.deepEqual(root.context.snapshot(), { facts: ["v1", "child-learned"] }); // untouched
  const lineage = root.context.lineage.map((l) => l.event);
  assert.deepEqual(lineage, ["born", "merge"]); // a rejected merge leaves the lineage untouched
  assert.equal(evs(rt, "intent_merge").at(-1).accept, false);
});

/* ---------- delegate vs handoff ---------- */

test("delegate creates a child on the other agent; ownership stays with the parent", async () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const { server } = rt.serve("svc", "t", async () => "done");
  const boss = sys.register("boss");
  const helper = sys.register("helper");
  const parent = sys.open(boss, { goal: { outcome: "whole job" } });
  const child = sys.delegate(parent, helper, { goal: { outcome: "part" } });
  assert.equal(child.agent, helper);
  assert.equal(child.parent, parent);
  assert.equal(parent.agent, boss); // ownership unmoved
  const slot = sys.grantFor(child, server, "t");
  const { result } = await sys.call(child, slot, {});
  assert.equal(result, "done");
  assert.ok(helper.hasIntent(child.id) && !boss.hasIntent(child.id));
});

test("handoff MOVES the intent but never the authority: envelope dies, new holder re-grants", async () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const { server } = rt.serve("svc", "t", async (a) => a.v);
  const a1 = sys.register("a1");
  const a2 = sys.register("a2");
  const intent = sys.open(a1, { goal: { outcome: "carry" }, budget: { calls: 5 } });
  const slot = sys.grantFor(intent, server, "t"); // envelope installed on a1 BEFORE handoff
  await sys.call(intent, slot, { v: 1 });
  const carriedCap = intent.envelope[0].cap; // the token handoff must kill (view hands out the cap handle, not a1's control)
  sys.handoff(intent, a2);
  // 1. the principal-side registry follows the intent…
  assert.equal(a1.hasIntent(intent.id), false);
  assert.equal(a2.hasIntent(intent.id), true);
  assert.equal(intent.agent, a2);
  assert.equal(intent.spent, 1); // …and so does the budget ACCOUNTING
  // 2. …but the envelope does NOT: unilaterally relocating a grant would
  //    be ambient authority. The old cap is revoked and the intent-level
  //    envelope check denies before the substrate is ever consulted.
  assert.equal(rt.isRevoked(carriedCap), true); // the token is dead, though a1's slot table still names it
  assert.equal(await asyncCode(sys.call(intent, slot, { v: 2 })), "E_NO_CAP");
  assert.equal(intent.ownerEpoch, 2); // HO-1: the epoch moves with the owner
  const fact = evs(rt, "intent_handoff").at(-1);
  assert.equal(fact.to, a2.id);
  assert.equal(fact.envelope, "revoked");
  assert.deepEqual(fact.slots, [slot]);
  assert.equal(fact.ownerEpoch, 2);
  // 3. the new holder re-earns authority explicitly, on its own slot table
  const slot2 = sys.grantFor(intent, server, "t");
  const { result } = await sys.call(intent, slot2, { v: 42 });
  assert.equal(result, 42);
});

/* ---------- S2.1 / CO-5: obligation binding precedes the effect ---------- */

function contractHarness(contract, { budget = null } = {}) {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  let hits = 0;
  const { server } = rt.serve("tool-svc", "t", async (a) => {
    hits += 1;
    return { receipt: `did:${a.job ?? "?"}` };
  });
  const agent = sys.register("planner");
  const intent = sys.open(agent, { goal: { outcome: "book trip" }, budget, contract });
  const slot = sys.grantFor(intent, server, "t");
  return { rt, sys, agent, server, intent, slot, hits: () => hits };
}

test("contract path: bound ok calls discharge exactly the obligations they were bound to", async () => {
  const { rt, sys, intent, slot } = contractHarness(["flight", "hotel"]);
  const { xact: x1 } = await sys.call(intent, slot, { job: 1 }, { for: ["flight"] });
  const { xact: x2 } = await sys.call(intent, slot, { job: 2 }, { for: ["hotel"] });
  const d1 = evs(rt, "intent_dispatch").at(-2);
  assert.deepEqual(d1.obligationIds, ["flight"]);
  assert.equal(d1.ownerEpoch, 1);
  assert.equal(d1.contractRevision, 0);
  await sys.complete(intent, [{ xact: x1, obligation: "flight" }, { xact: x2, obligation: "hotel" }]);
  assert.equal(intent.state, "completed");
  assert.deepEqual(evs(rt, "intent_complete").at(-1).contract, ["flight", "hotel"]);
});

test("CO-5: a success bound to A can never be re-labelled into obligation B", async () => {
  const { rt, sys, intent, slot } = contractHarness(["flight", "hotel"]);
  const { xact } = await sys.call(intent, slot, { job: 1 }, { for: ["flight"] });
  assert.equal(await asyncCode(sys.complete(intent, [{ xact, obligation: "hotel" }])), "E_NO_EVIDENCE");
  assert.ok(evs(rt, "completion_denied").at(-1).why.includes("bindings precede effects"));
  assert.equal(intent.state, "active"); // refusal leaves it claimable (COMPLETING → ACTIVE)
});

test("CO-5: an anonymous success cannot be renamed into a receipt at completion", async () => {
  const { sys, intent, slot } = contractHarness(["flight"]);
  const { xact } = await sys.call(intent, slot, { job: 1 }); // no for: — legal, but pays for nothing
  assert.equal(await asyncCode(sys.complete(intent, [{ xact, obligation: "flight" }])), "E_NO_EVIDENCE");
});

test("CO-5: binding an unknown obligation is refused BEFORE the effect dispatches", async () => {
  const { rt, sys, intent, slot, hits } = contractHarness(["flight"]);
  assert.equal(await asyncCode(sys.call(intent, slot, { job: 1 }, { for: ["not-in-contract"] })), "E_INVAL");
  assert.equal(hits(), 0); // nothing reached the tool
  assert.equal(evs(rt, "intent_dispatch").length, 0); // and no binding fact exists to select later
  assert.equal(evs(rt, "intent_call").at(-1).outcome, "denied");
});

test("CO-5: receipts need minOccurrences DISTINCT discharges; re-claiming one xact is not two", async () => {
  const { sys, intent, slot } = contractHarness([{ id: "flight", minOccurrences: 2 }]);
  const { xact: x1 } = await sys.call(intent, slot, { job: 1 }, { for: ["flight"] });
  assert.equal(await asyncCode(sys.complete(intent, [{ xact: x1, obligation: "flight" }])), "E_NO_EVIDENCE");
  assert.equal(await asyncCode(sys.complete(intent, [{ xact: x1, obligation: "flight" }, { xact: x1, obligation: "flight" }])), "E_NO_EVIDENCE");
  const { xact: x2 } = await sys.call(intent, slot, { job: 2 }, { for: ["flight"] });
  await sys.complete(intent, [{ xact: x1, obligation: "flight" }, { xact: x2, obligation: "flight" }]);
  assert.equal(intent.state, "completed");
});

test("CO-1/CO-5: append-only amend — work done before an obligation is born can never pay for it", async () => {
  const { rt, sys, intent, slot } = contractHarness(["flight"]);
  const { xact: x1 } = await sys.call(intent, slot, { job: 1 }, { for: ["flight"] });
  sys.amend(intent, ["hotel"]); // same owner, same epoch — revision is what orders this
  assert.equal(intent.contractRevision, 1);
  assert.deepEqual(evs(rt, "contract_amend").at(-1).added, ["hotel"]);
  assert.throws(() => sys.amend(intent, ["hotel"]), (e) => e.code === "E_INVAL"); // append-only: no dupes
  // flight is met, hotel is not:
  assert.equal(await asyncCode(sys.complete(intent, [{ xact: x1, obligation: "flight" }])), "E_NO_EVIDENCE");
  // and the pre-amend call cannot be dressed up for the new obligation:
  assert.equal(await asyncCode(
    sys.complete(intent, [{ xact: x1, obligation: "flight" }, { xact: x1, obligation: "hotel" }])
  ), "E_NO_EVIDENCE");
  // the honest path: work dispatched AFTER the promise
  const { xact: x2 } = await sys.call(intent, slot, { job: 2 }, { for: ["hotel"] });
  await sys.complete(intent, [{ xact: x1, obligation: "flight" }, { xact: x2, obligation: "hotel" }]);
  assert.equal(intent.state, "completed");
});

test("HO-4 across handoff: old-epoch receipts pay only for old-epoch promises", async () => {
  const { rt, sys, server, intent, slot } = contractHarness(["flight"]);
  const { xact: x1 } = await sys.call(intent, slot, { job: 1 }, { for: ["flight"] });
  const a2 = sys.register("relief");
  sys.handoff(intent, a2);
  sys.amend(intent, ["hotel"]); // born at epoch 2 — after the handoff
  const s2 = sys.grantFor(intent, server, "t");
  const { xact: x2 } = await sys.call(intent, s2, { job: 2 }, { for: ["hotel"] });
  const d2 = evs(rt, "intent_dispatch").at(-1);
  assert.equal(d2.ownerEpoch, 2);
  // the epoch-1 receipt cannot pay the epoch-2 promise:
  assert.equal(await asyncCode(
    sys.complete(intent, [{ xact: x1, obligation: "flight" }, { xact: x1, obligation: "hotel" }])
  ), "E_NO_EVIDENCE");
  // x1 still pays flight (born epoch 1); hotel needs the epoch-2 call
  await sys.complete(intent, [{ xact: x1, obligation: "flight" }, { xact: x2, obligation: "hotel" }]);
  assert.equal(intent.state, "completed");
});

test("CO-5 temporal: the binding is in the ledger WHILE the handler runs — effects cannot begin unbound", async () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  let seen = null;
  const { server } = rt.serve("svc", "t", () => {
    // synchronous effect: this body runs INSIDE request(), after the admit
    // hook — anything less than "my own binding is already in the ledger"
    // means the binding followed the effect
    seen = evs(rt, "intent_dispatch").map((d) => `${d.obligationIds.join(",")}@${d.xact}`);
    return 1;
  });
  const a = sys.register("p");
  const intent = sys.open(a, { goal: { outcome: "g" }, contract: ["flight"] });
  const slot = sys.grantFor(intent, server, "t");
  const { xact } = await sys.call(intent, slot, {}, { for: ["flight"] });
  assert.deepEqual(seen, [`flight@${xact}`]); // the effect witnessed its own binding
});

test("matcher fields are refused at the door, never silently ignored", () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const a = sys.register("x");
  assert.throws(
    () => sys.open(a, { goal: { outcome: "g" }, contract: [{ id: "f", matcher: { tool: "bookFlight" } }] }),
    (e) => e.code === "E_INVAL" && /matcher/.test(e.message)
  );
});

/* ---------- suspend / resume on another model ---------- */

test("suspend freezes effect; resume can rebind the model under a surviving principal", async () => {
  const { rt, sys, agent, intent, slot } = harness();
  await sys.call(intent, slot, { job: 1 }); // activate
  sys.suspend(intent);
  assert.equal(await asyncCode(sys.call(intent, slot, { job: 2 })), "E_STATE");
  sys.resume(intent, { model: "m-beta" });
  assert.equal(agent.model, "m-beta");
  const { result } = await sys.call(intent, slot, { job: 3 });
  assert.deepEqual(result, { receipt: "did:3" });
  assert.equal(evs(rt, "agent_rebind").at(-1).from, "m-alpha");
  assert.equal(evs(rt, "intent_suspend").length, 1);
});

/* ---------- revocation kills the subtree's authority instantly ---------- */

test("revoke cascades: envelope caps dead, children revoked, no later merges", async () => {
  const { rt, sys, intent, slot } = harness({ budget: { calls: 5 } });
  const child = sys.fork(intent);
  const envCap = intent.envelope[0].cap;
  sys.revoke(intent);
  assert.equal(intent.state, "revoked");
  assert.equal(child.state, "revoked");
  assert.equal(rt.isRevoked(envCap), true);
  assert.equal(await asyncCode(sys.call(intent, slot, {})), "E_STATE");
  assert.throws(() => sys.mergeContext(child), (e) => e.code === "E_STATE");
});

/* ---------- deadline is substrate-enforced, intent records it ---------- */

test("a deadline in the past denies at the substrate and the intent journals the failure", async () => {
  const rt = new Runtime({ now: () => 1000 });
  const sys = new AgentSystem(rt);
  const { server } = rt.serve("svc", "t", async () => 1);
  const agent = sys.register("late");
  const intent = sys.open(agent, { goal: { outcome: "x" }, deadline: 500 });
  const slot = sys.grantFor(intent, server, "t");
  assert.equal(await asyncCode(sys.call(intent, slot, {})), "E_DEADLINE");
  assert.equal(evs(rt, "intent_call").at(-1).code, "E_DEADLINE");
});

/* ---------- xact-level: suspended children inherit approval state ---------- */

test("fork inherits approval; delegated child can be approved independently", async () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const { server } = rt.serve("svc", "t", async () => 1);
  const boss = sys.register("b");
  const helper = sys.register("h");
  const root = sys.open(boss, { goal: { outcome: "g" }, approval: "required" });
  const f = sys.fork(root);
  assert.equal(f.approval, "required"); // inherits the gate
  const d = sys.delegate(root, helper);
  sys.grantFor(d, server, "t");
  const slot = d.envelope[0].slot;
  assert.equal(await asyncCode(sys.call(d, slot, {})), "E_APPROVAL");
  sys.approve(d, { once: true });
  await sys.call(d, slot, {}); // approved windows permit effect
  assert.equal(evs(rt, "intent_approve").at(-1).intent, d.id);
});

/* ---------- ST-3: the token is a view, the record is private ---------- */

test("ST-3: every determinable field is read-only from the token — tampering is a TypeError, not a quiet mutation", () => {
  const { sys, intent } = harness(); // grant already activated it
  assert.equal(intent.state, "active");
  assert.throws(() => { intent.state = "completed"; }, TypeError);
  assert.throws(() => { intent.stateVersion = 99; }, TypeError);
  assert.throws(() => { intent.contractRevision = 99; }, TypeError);
  assert.throws(() => { intent.ownerEpoch = 99; }, TypeError);
  assert.throws(() => { intent.spent = 99; }, TypeError);
  assert.throws(() => { intent.envelope = []; }, TypeError);
  assert.throws(() => { intent.contract = []; }, TypeError);
  assert.throws(() => { intent.evidence = []; }, TypeError);
  assert.equal(intent.state, "active"); // nothing moved
  assert.equal(intent.spent, 0);
});

test("ST-3: snapshots out are frozen — pop/push/field-writes cannot reach the private record", async () => {
  const { rt, sys, intent, slot } = contractHarness(["flight"]);
  assert.throws(() => intent.contract.pop(), TypeError); // the old CO-1 bypass, dead
  assert.throws(() => { intent.contract[0].id = "hijacked"; }, TypeError);
  const { xact } = await sys.call(intent, slot, { job: 1 }, { for: ["flight"] });
  await sys.complete(intent, [{ xact, obligation: "flight" }]);
  assert.throws(() => intent.evidence.push({ xact: "forged", backed: true }), TypeError);
  assert.throws(() => { intent.evidence[0].backed = false; }, TypeError);
  assert.throws(() => { intent.envelope[0].slot = "attacker-slot"; }, TypeError);
  // the record behind the snapshots never moved:
  assert.deepEqual(intent.contract.map((o) => o.id), ["flight"]);
  assert.equal(intent.evidence[0].backed, true);
  assert.deepEqual(evs(rt, "intent_complete").at(-1).contract, ["flight"]);
});

/* ---------- ST-2: one lifecycle writer, replay-unique events ---------- */

test("ST-2: OPEN is genesis, not a side effect — birth lands in the normalized shape", () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const { server } = rt.serve("svc", "t", async () => 1);
  const a = sys.register("g");
  const intent = sys.open(a, { goal: { outcome: "x" } });
  assert.equal(intent.state, "open");
  assert.equal(intent.stateVersion, 0);
  const g = evs(rt, "intent_state").at(-1);
  assert.deepEqual(
    { from: g.fromState, to: g.toState, v: g.stateVersion, cause: g.cause, intent: g.intent },
    { from: null, to: "open", v: 0, cause: "open", intent: intent.id }
  );
  sys.grantFor(intent, server, "t"); // activation is an EDGE with a named cause, not a sneaky set
  const e = evs(rt, "intent_state").at(-1);
  assert.deepEqual({ from: e.fromState, to: e.toState, v: e.stateVersion, cause: e.cause }, { from: "open", to: "active", v: 1, cause: "grant" });
});

test("ST-2: illegal edges move nothing and are refusable facts; terminal is terminal", async () => {
  const { rt, sys, intent, slot } = harness();
  const { xact } = await sys.call(intent, slot, { job: 1 });
  sys.suspend(intent);
  const v = intent.stateVersion;
  assert.throws(() => sys.suspend(intent), (e) => e.code === "E_STATE"); // suspended → suspended
  assert.equal(intent.state, "suspended");
  assert.equal(intent.stateVersion, v); // the denial changed no truth
  const d = evs(rt, "intent_transition_denied").at(-1);
  assert.deepEqual({ from: d.fromState, to: d.toState, v: d.stateVersion }, { from: "suspended", to: "suspended", v });
  sys.resume(intent);
  await sys.complete(intent, [{ xact }]);
  const v2 = intent.stateVersion;
  sys.revoke(intent); // revoking a fact would be editing history — refused silently by design
  assert.equal(intent.state, "completed");
  assert.equal(intent.stateVersion, v2);
});

test("ST-2: ledger replay reconstructs each intent's path — state is derived from facts, not mutable truth", async () => {
  const { rt, sys, intent, slot } = harness();
  const { xact } = await sys.call(intent, slot, { job: 1 });
  sys.suspend(intent);
  sys.resume(intent);
  await sys.complete(intent, [{ xact }]);
  let st = null, ver = -1, edges = 0;
  for (const e of evs(rt, "intent_state")) {
    if (e.intent !== intent.id) continue;
    assert.equal(e.fromState, st, "replay must find the previous toState — no ambiguity");
    assert.equal(e.stateVersion, ver + 1, "versions are strictly +1");
    st = e.toState; ver = e.stateVersion; edges += 1;
  }
  assert.equal(st, intent.state); // replay agrees with the read-only view…
  assert.equal(ver, intent.stateVersion); // …exactly
  assert.equal(edges, 5); // genesis, grant, suspend, resume, complete
});

test("ST-2: the source itself proves a single lifecycle writer", () => {
  const src = AgentSystem.toString() + "\n" + Intent.toString();
  const tStart = src.indexOf("#transition(intent, toState, cause) {");
  assert.ok(tStart >= 0, "#transition exists as the primitive");
  const tEnd = src.indexOf("\n  }", tStart);
  assert.ok(tEnd > tStart);
  const writes = [
    ...src.matchAll(/\.state\s*=[^=]/g),
    ...src.matchAll(/\.stateVersion\s*(?:\+=|=[^=])/g),
  ];
  assert.ok(writes.length >= 2, "the primitive does write state and version");
  for (const m of writes) {
    assert.ok(m.index > tStart && m.index < tEnd,
      "an assignment to state/stateVersion escaped #transition — there would be a second lifecycle writer");
  }
});

/* ---------- S2.1a: the trusted-state closure (round-7 blockers) ---------- */

test("ST-3: relations and configuration are decision-relevant too — every one is a read-only view", async () => {
  const { sys, intent, slot } = harness({ budget: { calls: 5 }, approval: "required" });
  assert.throws(() => { intent.approval = "not_required"; }, TypeError); // the round-7 gate bypass, dead
  assert.throws(() => { intent.budget = null; }, TypeError);
  assert.throws(() => { intent.deadline = null; }, TypeError);
  assert.throws(() => { intent.goal = { outcome: "mine now" }; }, TypeError);
  assert.throws(() => { intent.parent = null; }, TypeError);
  assert.throws(() => { intent.context = null; }, TypeError);
  assert.throws(() => { intent.children = []; }, TypeError);
  assert.throws(() => { intent.id = "i0-forged"; }, TypeError); // every check keys on id
  assert.throws(() => { intent.openedAt = "1970-01-01"; }, TypeError);
  // and the gate the tamper aimed at still gates:
  assert.equal(await asyncCode(sys.call(intent, slot, {})), "E_APPROVAL");
});

test("ST-3: the revoke cascade walks the PRIVATE children set — no view-edit dodges it", async () => {
  const { sys, intent, slot } = harness();
  await sys.call(intent, slot, { job: 1 });
  const child = sys.fork(intent);
  assert.throws(() => intent.children.clear(), TypeError); // pre-fix: children was a public Set; clear() "won"
  assert.throws(() => intent.children.push("i9999-ghost"), TypeError);
  sys.revoke(intent);
  assert.equal(child.state, "revoked"); // the cascade never consulted a mutable view
});

test("ST-3: `intent.agent = …` is not a handoff — it is a TypeError, and the three handoff effects stay owned", () => {
  const { rt, sys, agent, intent } = harness();
  const squatter = sys.register("squatter");
  assert.throws(() => { intent.agent = squatter; }, TypeError);
  assert.equal(intent.agent, agent); // would-be silent takeover moved nothing…
  assert.equal(intent.ownerEpoch, 1); // …no epoch bump…
  assert.equal(evs(rt, "intent_handoff").length, 0); // …and no ledger fact. Handoff is the ONLY move.
});

test("ST-2/ST-3: one ledger defines one intent — a foreign AgentSystem is refused before it writes anywhere", async () => {
  const rtA = new Runtime();
  const sysA = new AgentSystem(rtA);
  const a = sysA.register("a");
  const intent = sysA.open(a, { goal: { outcome: "guarded" } }); // rtA ledger: OPEN v0
  const rtB = new Runtime();
  const sysB = new AgentSystem(rtB);
  const b = sysB.register("b");
  // the reviewer's construction: sysB.fail drives the SAME record but journals elsewhere
  assert.throws(() => sysB.fail(intent, "cross-ledger"), (e) => e.code === "E_FOREIGN");
  assert.throws(() => sysB.amend(intent, ["late-promise"]), (e) => e.code === "E_FOREIGN");
  assert.throws(() => sysB.handoff(intent, b), (e) => e.code === "E_FOREIGN");
  assert.throws(() => sysB.revoke(intent), (e) => e.code === "E_FOREIGN");
  assert.throws(() => sysA.open(b, { goal: { outcome: "poached" } }), (e) => e.code === "E_FOREIGN"); // agents branded too
  assert.equal(await asyncCode(sysB.call(intent, "any-slot", {})), "E_FOREIGN");
  // nothing moved in truth or in either ledger:
  assert.equal(intent.state, "open");
  assert.equal(intent.stateVersion, 0);
  assert.equal(evs(rtB, "intent_state").length, 0); // no edge in the WRONG ledger…
  assert.equal(evs(rtB, "intent_transition_denied").length, 0); // …not even a denial — refused before any fact
  assert.equal(evs(rtA, "intent_state").filter((e) => e.intent === intent.id).length, 1); // genesis only
  assert.equal(sysA.handoff(intent, a) && intent.ownerEpoch, 2); // the RIGHT system still owns the move
});

test("ST-3: views are TRUE snapshots — clone-then-freeze, no shared reference through the getter", async () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const { server } = rt.serve("svc", "t", async (p) => ({ receipt: `did:${p.job ?? "?"}` }));
  const a = sys.register("s");
  const intent = sys.open(a, { goal: { outcome: "g", detail: { list: [1, 2] } } });
  assert.notEqual(intent.goal, intent.goal); // each read is its own clone…
  assert.notEqual(intent.goal.detail, intent.goal.detail); // …DEEP, not a shallow spread…
  // (frozen arrays cloned in the module realm throw THAT realm's TypeError —
  // cross-realm instanceof fails, so match by name, not constructor)
  const isTE = (e) => e.name === "TypeError";
  assert.throws(() => intent.goal.detail.list.push(3), isTE); // …and frozen on the way out
  const slot = sys.grantFor(intent, server, "t");
  const { xact } = await sys.call(intent, slot, { job: 1 });
  await sys.complete(intent, [{ xact, meta: { nested: [7] } }]);
  assert.notEqual(intent.evidence[0].meta, intent.evidence[0].meta); // pre-fix: same reference both reads (freeze-through)
  assert.throws(() => intent.evidence[0].meta.nested.push(8), isTE);
});

test("ST-2: admission, not ambition, activates OPEN — guard-refused attempts change no lifecycle", async () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const { server } = rt.serve("svc", "t", async () => 1);
  const a = sys.register("q");
  const intent = sys.open(a, { goal: { outcome: "x" }, approval: "required", contract: ["pilot"] });
  // every local guard refuses while the intent is still OPEN…
  assert.equal(await asyncCode(sys.call(intent, "slot-never-granted", {})), "E_NO_CAP");
  assert.equal(intent.state, "open");
  assert.equal(intent.stateVersion, 0);
  assert.equal(await asyncCode(sys.complete(intent, [])), "E_NO_EVIDENCE"); // unmet contract, no dispatch
  assert.equal(intent.state, "open"); // pre-fix: the failed call had already burned the genesis edge
  // a promise is not an attempt either: amending leaves OPEN untouched
  sys.amend(intent, ["second"]);
  assert.equal(intent.state, "open");
  assert.equal(evs(rt, "intent_state").filter((e) => e.intent === intent.id).length, 1); // genesis only
  // the admitted act activates, with its named cause
  sys.grantFor(intent, server, "t");
  const e = evs(rt, "intent_state").at(-1);
  assert.deepEqual({ from: e.fromState, to: e.toState, v: e.stateVersion, cause: e.cause }, { from: "open", to: "active", v: 1, cause: "grant" });
  assert.equal(await asyncCode(sys.call(intent, `intent:${intent.id}:t`, {})), "E_APPROVAL"); // gate intact on the now-ACTIVE intent
});

/* ---------- S2.1b: the boundary extends over the reachable graph (round-8 blockers) ---------- */

const isTE = (e) => e.name === "TypeError"; // cross-realm-safe: module-realm freezes throw THAT realm's TypeError

test("ST-3: the agent view leaks no control plane — from intent.agent there is no path to Runtime", () => {
  const { sys, intent, agent } = harness(); // registered with model "m-alpha"
  assert.equal(intent.agent, agent); // stable principal view
  assert.equal(agent.control, undefined); // the execution handle is not a property of the view…
  assert.equal(agent.sys, undefined); // …so `agent.sys.rt` — the trusted control plane — does not exist
  assert.throws(() => { agent.model = "evil-model"; }, isTE); // pre-fix: a plain field write, no agent_rebind fact
  assert.throws(() => { agent.id = "forged"; }, isTE);
  assert.throws(() => { agent.control = {}; }, isTE); // cannot bolt a handle onto a frozen view
  assert.throws(() => { agent.intents = new Map(); }, isTE);
  assert.throws(() => { agent.polluted = 1; }, isTE); // the view itself is frozen
  assert.throws(() => agent.intentIds.push("ghost"), isTE); // registry reads are snapshots
  assert.equal(agent.model, "m-alpha"); // none of the tampering moved truth
  assert.deepEqual(agent.intentIds, [intent.id]);
});

test("ST-3: the agent brand is itself unforgeable — `foreign.sys = sysA` is view-tampering, not branding", () => {
  const rtA = new Runtime();
  const sysA = new AgentSystem(rtA);
  const a = sysA.register("mine");
  const rtB = new Runtime();
  const sysB = new AgentSystem(rtB);
  const b = sysB.register("foreign");
  assert.throws(() => { b.sys = sysA; }, isTE); // pre-fix: `sys` was a public mutable field — this assignment WORKED
  assert.throws(() => { b.id = a.id; }, isTE);
  assert.ok(Object.isFrozen(b)); // nothing writable was left behind on the view for a brand to attach to
  assert.throws(() => sysA.open(b, { goal: { outcome: "poached" } }), (e) => e.code === "E_FOREIGN");
  const intent = sysA.open(a, { goal: { outcome: "mine" } });
  assert.throws(() => sysA.handoff(intent, b), (e) => e.code === "E_FOREIGN"); // the brand reads the RECORD, never the view
});

test("ST-3: context is a ContextVersion stream — the view reads, the system mutates, the ledger narrates", () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const a = sys.register("k", { context: { facts: ["v1"] } });
  const root = sys.open(a, { goal: { outcome: "research" }, context: { facts: ["v1"] } });
  assert.equal(root.context.mutate, undefined); // pre-fix: the live mutable Context leaked straight out of the read-only view
  assert.throws(() => { root.context.snapshot().facts.push("x"); }, isTE);
  assert.equal(root.context.version, 0);
  sys.mutateContext(root, { facts: ["v1", "v2"] }); // belief change = owned act…
  assert.equal(root.context.version, 1);
  assert.deepEqual(evs(rt, "context_version").at(-1).intent, root.id); // …with its fact
  const cv = evs(rt, "context_version").at(-1);
  assert.deepEqual({ from: cv.fromVersion, to: cv.toVersion, cause: cv.cause }, { from: 0, to: 1, cause: "mutate" });
  const child = sys.fork(root);
  assert.deepEqual(child.context.snapshot(), { facts: ["v1", "v2"] }); // seeded from the CURRENT version
  sys.mutateContext(child, { facts: ["v1", "v2", "child-learned"] });
  sys.mergeContext(child, { accept: true });
  assert.deepEqual(root.context.snapshot(), { facts: ["v1", "v2", "child-learned"] });
  const mv = evs(rt, "context_version").at(-1);
  assert.deepEqual({ intent: mv.intent, from: mv.fromVersion, to: mv.toVersion, cause: mv.cause }, { intent: root.id, from: 1, to: 2, cause: "merge" });
  assert.deepEqual(root.context.lineage.map((l) => l.event), ["born", "mutate", "merge"]);
  sys.revoke(child);
  assert.throws(() => sys.mutateContext(child, { facts: ["post-mortem"] }), (e) => e.code === "E_STATE"); // terminal beliefs are frozen history
});

test("ST-3: transitive read-only walk — every reachable value is a frozen snapshot, another token, or a declared opaque handle", async () => {
  const { sys, intent, slot, agent } = contractHarness(["flight"]);
  const { xact } = await sys.call(intent, slot, { job: 1 }, { for: ["flight"] });
  await sys.complete(intent, [{ xact, obligation: "flight", meta: { deep: { list: [1] } } }]);
  assert.throws(() => { intent.polluted = 1; }, isTE); // the Intent token itself is frozen
  const reachable = [
    intent.goal, intent.contract[0], intent.evidence[0], intent.evidence[0].meta,
    intent.children, intent.envelope[0], intent.context.snapshot(), intent.context.lineage[0],
    agent, agent.intentIds, intent.parent,
  ];
  for (const [i, v] of reachable.entries()) {
    if (v && typeof v === "object") assert.ok(Object.isFrozen(v), `reachable #${i} is a MUTABLE object past the boundary: ${v.constructor?.name}`);
  }
  // the second-order leak: no reference path to the control plane in two hops
  assert.equal(intent.agent.sys, undefined);
  assert.equal(intent.agent.control, undefined);
  assert.equal(intent.parent, null);
  // caps are the DECLARED exception — opaque handles, not data:
  assert.ok(intent.envelope[0].cap);
});

/* ---------- S2.1c: ingress ownership (round-9 blocker) ----------
 * The boundary is bidirectional: no mutable aliases OUT (S2.1b), no
 * caller-owned aliases IN. Provenance does not clone events — an input
 * reference that reaches rt.record() keeps the CALLER holding live
 * content inside already-hashed history. */

test("S2.1c ingress: register owns its inputs — label/model are immutable identity, context clones at the door", () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  // pre-fix: the object passed straight into the record AND the fact —
  // `agent.model.cfg.mode = "evil"` then mutated private truth with no
  // agent_rebind act at all
  assert.throws(() => sys.register("a", { model: { name: "m", cfg: { mode: "safe" } } }), (e) => e.code === "E_INVAL");
  assert.throws(() => sys.register(42), (e) => e.code === "E_INVAL");
  const ctx = { facts: ["v1"] };
  const a = sys.register("a", { model: "m-alpha", context: ctx });
  ctx.facts.push("injected"); // the caller still holds the original…
  assert.deepEqual(a.context.snapshot(), { facts: ["v1"] }); // …but the record got a clone
  assert.equal(evs(rt, "agent_register").at(-1).model, "m-alpha");
  assert.equal(rt.verifyJournal(), true);
});

test("S2.1c ingress: mutating the caller's goal after open cannot rewrite hashed history", async () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const { server } = rt.serve("svc", "t", async () => 1);
  const a = sys.register("a");
  const goal = { task: { name: "original" } };
  const budget = { calls: 1 };
  const intent = sys.open(a, { goal, budget });
  // the reviewer's attack, verbatim in shape:
  goal.task.name = "rewritten-after-hash";
  budget.calls = 999;
  // pre-fix, the intent_open event's `goal` WAS this object — the hash
  // covers "original" while the event now reads "rewritten":
  assert.equal(evs(rt, "intent_open").at(-1).goal.task.name, "original");
  assert.equal(rt.verifyJournal(), true);
  assert.equal(intent.goal.task.name, "original"); // views read the record's clone
  assert.deepEqual(intent.budget, { calls: 1 }); // the gate reads the clone too
  const slot = sys.grantFor(intent, server, "t");
  await sys.call(intent, slot, {});
  assert.equal(await asyncCode(sys.call(intent, slot, {})), "E_BUDGET"); // 999 bought nothing
});

test("S2.1c ingress: even a DENIED claim's object cannot stay aliased inside the ledger", async () => {
  const { rt, sys, intent, slot } = contractHarness(["flight"]);
  await sys.call(intent, slot, { job: 1 }, { for: ["flight"] });
  const claim = { xact: "x999-forged", obligation: "flight", meta: { note: "original" } };
  assert.equal(await asyncCode(sys.complete(intent, [claim])), "E_NO_EVIDENCE");
  claim.meta.note = "rewritten-after-hash"; // pre-fix: the refusal fact held THIS object
  const d = evs(rt, "completion_denied").at(-1);
  assert.equal(d.claim.meta.note, "original");
  assert.equal(rt.verifyJournal(), true);
});

test("S2.1c ingress: approval scopes and model rebinds are owned values, not live references", () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const { server } = rt.serve("svc", "t", async () => 1);
  const a = sys.register("a", { model: "m1" });
  const intent = sys.open(a, { goal: { o: 1 }, approval: "required" });
  sys.grantFor(intent, server, "t"); // grant activates; approval still gates calls
  const scope = { window: { max: 1 } };
  sys.approve(intent, scope);
  scope.window.max = 99; // pre-fix this only reached a clone — kept as a pinned expectation, not a teeth claim
  assert.equal(evs(rt, "intent_approve").at(-1).scope.window.max, 1);
  sys.suspend(intent);
  assert.throws(() => sys.resume(intent, { model: { evil: true } }), (e) => e.code === "E_INVAL"); // pre-fix: aliased into the record, fact unhashed-able
  assert.equal(a.model, "m1"); // the refusal rebound nothing
  assert.equal(rt.verifyJournal(), true);
});

/* ---------- S2.1d: the behavior surface (round-10 blocker) ----------
 * A frozen instance on a mutable prototype is a locked door in an
 * unlockable wall: class getters are configurable, so same-realm code
 * can redefine what `intent.id` RETURNS — branding still authenticates
 * the true record (state moves correctly) while every fact written
 * through the presentation getter attributes the edge to a ghost. */

test("ST-3: the view prototypes are frozen — behavior is part of the reachable graph", () => {
  const { sys, intent, agent } = harness();
  for (const [name, proto] of [
    ["Intent", Object.getPrototypeOf(intent)],
    ["AgentPrincipal", Object.getPrototypeOf(agent)],
    ["ContextView", Object.getPrototypeOf(intent.context)],
  ]) {
    // pre-fix: Object.freeze(instance) stopped at the instance; the
    // prototype — the behavior every getter call dispatches through —
    // was a plain mutable object
    assert.equal(Object.isFrozen(proto), true, `${name}.prototype is MUTABLE`);
  }
  assert.throws(() => Object.defineProperty(Object.getPrototypeOf(intent), "id", { configurable: true, get() { return "i-forged"; } }), isTE);
  assert.throws(() => Object.defineProperty(Object.getPrototypeOf(agent), "id", { configurable: true, get() { return "a-forged"; } }), isTE);
  assert.throws(() => Object.defineProperty(Object.getPrototypeOf(intent.context), "version", { configurable: true, get() { return 99; } }), isTE);
});

test("ST-2: an attempted prototype-id spoof cannot misattribute a transition — facts carry the private id", () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const a = sys.register("a");
  const intent = sys.open(a, { goal: { o: 1 } });
  const canonical = intent.id;
  let threw = false;
  try {
    // the reviewer's attack verbatim. PRE-FIX this SUCCEEDS silently:
    // the class getter is configurable, so the prototype takes the
    // spoof and every downstream `intent.id` read lies.
    Object.defineProperty(Object.getPrototypeOf(intent), "id", { configurable: true, get() { return "i-forged"; } });
  } catch (e) {
    threw = e.name === "TypeError"; // cross-realm-safe
  }
  assert.equal(threw, true); // pre-fix: no throw — the spoof landed
  sys.fail(intent, "round-10 oracle");
  const last = evs(rt, "intent_state").at(-1);
  // pre-fix (with the spoof landed): the fact says intent: "i-forged"
  // while the REAL record moved to failed — private truth FAILED,
  // replay(originalId) stuck at OPEN: ST-2's claim, severed.
  assert.equal(last.intent, canonical);
  assert.equal(last.toState, "failed");
  let st = null, ver = -1;
  for (const e of evs(rt, "intent_state")) {
    if (e.intent !== canonical) continue;
    assert.equal(e.fromState, st, "replay must chain without ambiguity");
    assert.equal(e.stateVersion, ver + 1);
    st = e.toState; ver = e.stateVersion;
  }
  assert.equal(st, "failed"); // replay == private view, under the canonical id
  assert.equal(intent.state, "failed");
});

/* ---------- S2.2a: COMPLETING pre-works — JSON-safe domain + detached
 * ContextVersion (round-11 directive, spec §8 item 2 pre-works a & b).
 * Provenance hashes events by JSON shape, so "cloneable" was never
 * "representable": Map/Set/class instances clone but serialize to {},
 * cycles clone but explode inside record(). And the old String(v)
 * escape hatch meant a hostile toString could EXECUTE while escaping a
 * denial fact — or throw, and the fact would simply vanish. ---------- */

test("S2.2a domain: Map/bigint/cycle/function/accessor/undefined/class-instance cannot enter authoritative state; refusals change no truth and no ledger", () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const a = sys.register("d1");
  const isDomain = (e) => e.code === "E_DOMAIN";
  assert.throws(() => sys.open(a, { goal: new Map([["k", "v"]]) }), isDomain); // clones fine, hashes as {} — exactly the gap
  assert.throws(() => sys.open(a, { goal: { o: 1n } }), isDomain); // bigint: JSON.stringify THROWS on it
  const cyc = { o: "x" }; cyc.self = cyc;
  assert.throws(() => sys.open(a, { goal: cyc }), isDomain); // cycle: no JSON binding
  assert.throws(() => sys.open(a, { goal: { o: 1 }, budget: { calls: new Date() } }), isDomain);
  assert.throws(() => sys.open(a, { goal: { o: 1, bad: (x) => x } }), isDomain);
  assert.throws(() => sys.open(a, { goal: { o: 1 }, approval: { get trap() { throw new Error("getter-ran"); } } }), isDomain); // inspection must not execute
  assert.throws(() => sys.open(a, { goal: { o: 1, u: undefined } }), isDomain); // silently dropped by cloning — now refused
  class Belief { constructor() { this.b = 1; } }
  assert.throws(() => sys.open(a, { goal: { o: 1, b: new Belief() } }), isDomain); // structuredClone ACCEPTS this — that's the point
  assert.throws(() => sys.open(a, { goal: { o: 1, f: Infinity } }), isDomain); // non-finite number
  // shared (DAG) references are NOT cycles — legal, and cloned apart:
  const shared = { n: 1 };
  const intent = sys.open(a, { goal: { o: "ok", x: shared, y: shared }, context: { list: [shared, shared] } });
  assert.equal(intent.state, "open");
  const before = rt.journalEntries().length;
  assert.throws(() => sys.mutateContext(intent, new Set([1])), isDomain);
  assert.throws(() => sys.mutateContext(intent, { a: NaN }), isDomain);
  assert.equal(intent.context.version, 0); // refusal bumped no belief version
  assert.equal(intent.state, "open");
  assert.equal(evs(rt, "intent_open").length, 1); // the refused opens wrote NO genesis fact
  assert.equal(rt.journalEntries().length, before); // refusals are silent on the ledger — nothing half-written
  assert.equal(rt.verifyJournal(), true);
});

test("S2.2a sanitization: a hostile toString cannot suppress a denial fact — facts are rebuilt, never converted", async () => {
  const { rt, sys, intent, slot } = contractHarness(["flight"]);
  await sys.call(intent, slot, { job: 1 }, { for: ["flight"] });
  const claim = {
    xact: "x999-forged", obligation: "flight",
    evil: function nope() {}, // pre-fix: uncloneable → String(claim) → runs the hostile conversion
    toString() { throw new Error("boom"); },
    get trap() { throw new Error("getter-ran"); }, // pre-fix: the clone READS it — attacker code executed on the fact path
  };
  // pre-fix: complete() dies inside String(claim) — Error("boom"), and
  // the completion_denied fact NEVER lands: a hostile object erased the
  // audit trail of its own refusal.
  assert.equal(await asyncCode(sys.complete(intent, [claim])), "E_NO_EVIDENCE");
  const d = evs(rt, "completion_denied").at(-1);
  assert.ok(d, "the denial fact must land no matter what the claim object wants");
  assert.equal(d.claim.evil.$notInDomain, "function");
  assert.equal(d.claim.toString.$notInDomain, "function");
  assert.equal(d.claim.trap.$notInDomain, "accessor");
  assert.equal(d.claim.xact, "x999-forged"); // in-domain parts stay honest
  assert.equal(d.claim.obligation, "flight");
  assert.equal(rt.verifyJournal(), true);
  assert.equal(intent.state, "active"); // refused completion changed nothing
});

test("S2.2a sanitization: out-of-domain fact payloads become fixed markers — nothing attacker-run executes, the hash still binds", () => {
  const { rt, sys, intent } = contractHarness(["flight"]);
  const reason = { note: "ok", f: () => {}, n: 1n, when: new Date(0), nested: [{ bad: undefined }] };
  sys.fail(intent, reason); // pre-fix: the whole reason degraded to String(reason) = "[object Object]"
  const f = evs(rt, "intent_fail").at(-1);
  assert.equal(f.reason.note, "ok");
  assert.equal(f.reason.f.$notInDomain, "function");
  assert.equal(f.reason.n.$notInDomain, "bigint");
  assert.equal(f.reason.when.$notInDomain, "non-plain"); // Date was LIVE in the ledger pre-fix
  assert.equal(f.reason.nested[0].bad.$notInDomain, "undefined");
  assert.equal(rt.verifyJournal(), true);
});

test("S2.2a context: current() hands out a DETACHED ContextVersion — v3 stays v3 while the head walks to v5", () => {
  const rt = new Runtime();
  const sys = new AgentSystem(rt);
  const a = sys.register("d4", { context: { belief: "v0" } });
  const intent = sys.open(a, { goal: { o: 1 }, context: { belief: "v0" } });
  const v0 = intent.context.current(); // pre-fix: ContextView had no current() — only a live cursor
  assert.deepEqual(Object.keys(v0).sort(), ["lineageRef", "snapshot", "version"]); // spec §1's shape, verbatim
  sys.mutateContext(intent, { belief: "v1" });
  sys.mutateContext(intent, { belief: "v2" });
  assert.equal(intent.context.version, 2);
  assert.equal(v0.version, 0); // the head moved; the VALUE did not
  assert.deepEqual(v0.snapshot, { belief: "v0" });
  assert.equal(Object.isFrozen(v0) && Object.isFrozen(v0.snapshot) && Object.isFrozen(v0.lineageRef), true);
  assert.throws(() => { v0.snapshot.belief = "rewritten"; }, isTE);
  assert.equal(v0.lineageRef.length, 1); // lineage pinned at birth too
  const v2 = intent.context.current();
  assert.equal(v2.version, 2);
  assert.notEqual(v2.snapshot, v0.snapshot); // distinct detached values — a context obligation binds ONE
  assert.equal(v2.lineageRef.at(-1).toVersion, 2);
  assert.equal(rt.verifyJournal(), true);
});
