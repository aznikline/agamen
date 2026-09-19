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
import { AgentSystem } from "../src/intent.js";

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
  child.context.mutate({ facts: ["v1", "child-learned"] });
  assert.deepEqual(root.context.snapshot(), { facts: ["v1"] }); // isolated
  sys.mergeContext(child, { accept: true });
  assert.deepEqual(root.context.snapshot(), { facts: ["v1", "child-learned"] });
  const rejected = sys.fork(root);
  rejected.context.mutate({ facts: ["denied-payload"] });
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
  assert.ok(helper.intents.has(child.id) && !boss.intents.has(child.id));
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
  const carriedCap = rt.holds(a1.control, slot); // the token handoff must kill
  sys.handoff(intent, a2);
  // 1. the principal-side registry follows the intent…
  assert.equal(a1.intents.has(intent.id), false);
  assert.equal(a2.intents.has(intent.id), true);
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
