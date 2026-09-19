/**
 * Agamen APM — the Agent Process Model (semantic track S).
 *
 * Conformance target: spec/apm.md. Landed so far: S1's lifecycle +
 * evidence gate, and S2.1's CO-5 dispatch-time obligation binding
 * (receipt-kind CompletionContracts, append-only amend, ownerEpoch /
 * contractRevision stamps on every dispatch).
 *
 * The question this layer answers: *which existing OS abstraction fails
 * first under agent workloads?* The process. A long-running, delegable,
 * pausable, forkable, auditable, error-prone agent does not fit
 * process/thread/fork/exec: its identity must survive restarts, its
 * authority travels as capability envelopes, its "memory" is context
 * lineage, and its exit status is evidence, not an exit code. So this
 * file makes two objects first class:
 *
 *   AgentExecution — a principal: identity + authority surface + context
 *     lineage + active intents + execution history. NOT a thread: the
 *     "program counter" is the intent tree.
 *   Intent — the schedulable unit: a requested outcome inside an
 *     authority envelope with budget, deadline, approval state, child
 *     intents, and completion evidence. Like a process it has a lifecycle
 *     (open/fork/delegate/handoff/suspend/resume/revoke/complete); unlike
 *     a process it can be resumed on a different model and it cannot
 *     complete without journal-backed evidence.
 *
 * Enforcement stays in the v1.6 substrate: agents are Runtime actors,
 * envelopes are capability grants with membranes, deadlines and outcomes
 * are substrate semantics, and EVERY lifecycle fact goes to the same
 * hash-chained ledger via rt.record(). This layer holds no authority of
 * its own — it is host-plane glue a scheduler would wrap. Per the
 * Linux-library test (docs/thesis.md §6), what makes this OS-shaped
 * rather than library-shaped is the ledger-backed lifecycle: completion
 * that must be provable, context merges that keep lineage, and revocation
 * that atomically kills authority subtrees.
 */

import { SubstrateError, rateLimit } from "./runtime.js";

const nowIso = () => new Date().toISOString();

let nextIntent = 1;
let nextAgent = 1;

/* ---------- completion contracts (spec/apm.md §3, CO-5) ----------
 * Obligations are declared at creation and may only GROW (append-only
 * amend); retiring one is a separate act (supersede/waiver, §8 item 5)
 * that is deliberately NOT implemented, because erasing a requirement is
 * a decision someone must own. Dispatch-time binding is what gives the
 * contract teeth: an obligation id may name a call only as the call
 * leaves, never after its result is observable. */

function normalizeContract(list) {
  if (!Array.isArray(list)) throw new SubstrateError("E_INVAL", "contract must be a list of obligations");
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    let ob;
    try {
      ob = typeof raw === "string" ? { id: raw } : structuredClone(raw);
    } catch {
      throw new SubstrateError("E_INVAL", "obligations must be plain data");
    }
    const id = ob?.id;
    if (typeof id !== "string" || id === "") throw new SubstrateError("E_INVAL", "obligation needs a string id");
    const kind = ob.kind ?? "receipt";
    if (kind !== "receipt") {
      throw new SubstrateError("E_INVAL", `obligation kind '${kind}' lands with spec §8 item 2; 'receipt' only in this slice`);
    }
    const min = ob.minOccurrences ?? 1;
    if (!Number.isInteger(min) || min < 1) throw new SubstrateError("E_INVAL", "minOccurrences must be a positive integer");
    if (seen.has(id)) throw new SubstrateError("E_INVAL", `duplicate obligation id '${id}'`);
    seen.add(id);
    out.push({ id, kind: "receipt", matcher: ob.matcher ?? null, minOccurrences: min });
  }
  return out;
}

/* ---------- contexts: the new memory model ----------
 * A context is a plain-data snapshot. Lineage = the ordered record of
 * transitions; fork copies the current snapshot, child mutations stay
 * isolated until an explicit merge_context, which may be accepted or
 * rejected. The fork/join discipline, but over BELIEFS. */

function cloneContext(data) {
  try {
    return structuredClone(data);
  } catch {
    throw new SubstrateError("E_CANON", "context data must be structurally cloneable");
  }
}

class Context {
  #data;
  lineage = [];

  constructor(data = {}, seed = "root") {
    this.#data = cloneContext(data);
    this.lineage.push({ at: nowIso(), event: "born", from: seed });
  }
  snapshot() {
    return cloneContext(this.#data);
  }
  mutate(next) {
    this.#data = cloneContext(next);
    this.lineage.push({ at: nowIso(), event: "mutate" });
  }
  absorb(other, fromIntentId) {
    this.#data = cloneContext(other.snapshot());
    this.lineage.push({ at: nowIso(), event: "merge", from: fromIntentId });
  }
}

/* ---------- AgentExecution ---------- */

export class AgentExecution {
  id;
  label;
  model;
  control; // ActorControl handle — host-plane only, never handed into the agent realm
  context;
  sys; // host-plane back-reference (AgentSystem), assigned at construction
  intents = new Map(); // id -> Intent (active and terminal; the execution history)

  constructor(sys, label, { model = null, context = {} } = {}) {
    this.sys = sys;
    this.id = `agent${nextAgent++}`;
    this.label = label;
    this.model = model;
    this.context = new Context(context, this.id);
    this.control = sys.rt.spawn(`agent:${label}`);
    sys.rt.record({ t: "agent_register", agent: this.id, label, model });
    sys.agents.set(this.id, this);
  }

  identity() {
    return this.sys.rt.identityOf(this.control); // the only handle that may be shown to others
  }

  activeIntents() {
    return [...this.intents.values()].filter((i) => ["open", "active", "suspended"].includes(i.state));
  }
}

/* ---------- Intent ---------- */

export class Intent {
  id;
  agent; // AgentExecution currently holding the envelope
  parent = null;
  children = new Set(); // child Intent ids
  goal; // the requested outcome, plain data
  envelope = []; // {slot, cap} installed for this intent (attenuated grants)
  budget; // {calls} charged per mediated attempt through call()
  spent = 0;
  deadline; // absolute ms, enforced by the substrate at request time
  approval; // "not_required" | "required" | { approved, at }
  context; // own Context (forked from the parent's snapshot when created)
  state = "open"; // open | active | suspended | revoked | completed | failed
  evidence = [];
  // spec §5: two independent monotonic counters — a handoff must not be
  // confused with a contract change, and neither with the passage of time
  ownerEpoch = 1; // +1 per handoff (HO-1)
  contractRevision = 0; // +1 per append-only amend (CO-1)
  contract = []; // {id, kind, matcher, minOccurrences, bornRevision, bornEpoch}
  openedAt = nowIso();

  constructor({ agent, goal, budget = null, deadline = null, approval = "not_required", contextSeed = {}, contract = [] }) {
    this.id = `i${nextIntent++}`;
    this.agent = agent;
    this.goal = cloneContext(goal);
    this.budget = budget;
    this.deadline = deadline;
    this.approval = approval;
    this.context = new Context(contextSeed, this.id);
    this.contract = normalizeContract(contract).map((o) => ({ ...o, bornRevision: 0, bornEpoch: 1 }));
  }
}

/* ---------- the system: host-plane glue ---------- */

export class AgentSystem {
  rt;
  agents = new Map(); // id -> AgentExecution
  intents = new Map(); // id -> Intent (system-wide index, incl. handed-off ones)

  constructor(rt) {
    this.rt = rt;
  }

  register(label, opts = {}) {
    return new AgentExecution(this, label, opts);
  }

  open(agent, { goal, budget = null, deadline = null, approval = "not_required", context = {}, contract = [] } = {}) {
    if (!goal || typeof goal !== "object") throw new SubstrateError("E_INVAL", "goal must describe the requested outcome");
    const intent = new Intent({ agent, goal, budget, deadline, approval, contextSeed: context, contract });
    this.#track(agent, intent);
    this.#fact({
      t: "intent_open", intent: intent.id, agent: agent.id, goal, budget, deadline, approval,
      contract: intent.contract.map((o) => o.id),
    });
    return intent;
  }

  /** Fork: a child intent on the SAME agent; its context branches from a
   *  copy of the parent's snapshot. */
  fork(parentIntent, { goal, budget = null, deadline = null, approval, contract = [] } = {}) {
    this.#requireLive(parentIntent);
    const child = new Intent({
      agent: parentIntent.agent,
      goal: goal ?? parentIntent.goal,
      budget,
      deadline,
      approval: approval ?? parentIntent.approval,
      contextSeed: parentIntent.context.snapshot(),
      contract,
    });
    child.parent = parentIntent;
    parentIntent.children.add(child.id);
    this.#track(parentIntent.agent, child);
    this.#fact({ t: "intent_fork", intent: child.id, parent: parentIntent.id, agent: child.agent.id });
    return child;
  }

  /** Delegate: a NEW child intent executed by another agent; the parent
   *  keeps ownership and receives the merged result. */
  delegate(parentIntent, targetAgent, { goal, budget = null, deadline = null, approval, contract = [] } = {}) {
    this.#requireLive(parentIntent);
    const child = new Intent({
      agent: targetAgent,
      goal: goal ?? parentIntent.goal,
      budget,
      deadline,
      approval: approval ?? parentIntent.approval,
      contextSeed: parentIntent.context.snapshot(),
      contract,
    });
    child.parent = parentIntent;
    parentIntent.children.add(child.id);
    this.#track(targetAgent, child);
    this.#fact({
      t: "intent_delegate", intent: child.id, parent: parentIntent.id,
      from: parentIntent.agent.id, to: targetAgent.id,
    });
    return child;
  }

  /** Append-only contract amendment (CO-1): adds obligations stamped with
   *  the bumped contractRevision and current ownerEpoch. There is no
   *  removal path here on purpose — retiring a requirement is
   *  supersede/waiver (§8 item 5), a separate owned act. */
  amend(intent, obligations) {
    this.#requireLive(intent);
    const added = normalizeContract(obligations);
    const have = new Set(intent.contract.map((o) => o.id));
    for (const ob of added) {
      if (have.has(ob.id)) throw new SubstrateError("E_INVAL", `obligation '${ob.id}' is already in the contract`);
    }
    intent.contractRevision += 1;
    for (const ob of added) {
      intent.contract.push({ ...ob, bornRevision: intent.contractRevision, bornEpoch: intent.ownerEpoch });
    }
    this.#fact({
      t: "contract_amend", intent: intent.id, revision: intent.contractRevision,
      epoch: intent.ownerEpoch, added: added.map((o) => o.id),
    });
    return intent.contract.map((o) => o.id);
  }

  /** Handoff: the INTENT moves, its AUTHORITY does not. Goal, context
   *  lineage, approval state, budget accounting, children and evidence
   *  relocate to the new holder whole; every envelope capability is
   *  REVOKED and the fact is journaled. This is not a shortfall — it is
   *  the ocap consent principle: a capability was minted by a granter
   *  who consented to serve THIS agent's slot table; no act of the
   *  current holder can unilaterally re-point that consent at another
   *  principal. Authority that "moved with the ticket" would be an
   *  ambient right. The new holder re-delegates explicitly
   *  (grantFor), and only what it re-earns it may spend. Contrast
   *  delegate, which spawns a child elsewhere and keeps ownership. */
  handoff(intent, targetAgent) {
    this.#requireLive(intent);
    const from = intent.agent;
    from.intents.delete(intent.id);
    targetAgent.intents.set(intent.id, intent);
    intent.agent = targetAgent;
    for (const { cap } of intent.envelope) {
      try { this.rt.revoke(cap); } catch { /* already dead — foreign/revoked */ }
    }
    const slots = intent.envelope.map((e) => e.slot);
    intent.envelope = []; // new holder must re-grant before it can call
    intent.ownerEpoch += 1; // HO-1: work and promises order against the epoch they were made under
    this.#fact({
      t: "intent_handoff", intent: intent.id, from: from.id, to: targetAgent.id,
      envelope: "revoked", slots, ownerEpoch: intent.ownerEpoch,
    });
    return intent;
  }

  suspend(intent) {
    this.#require(intent, "active");
    intent.state = "suspended";
    this.#fact({ t: "intent_suspend", intent: intent.id, agent: intent.agent.id });
  }

  /** Resume optionally rebinds the EXECUTING MODEL: the principal,
   *  authority, context and budget survive; the "CPU" does not. A process
   *  API cannot express this transition. */
  resume(intent, { model = null } = {}) {
    this.#require(intent, "suspended");
    if (model !== null && model !== intent.agent.model) {
      const prev = intent.agent.model;
      intent.agent.model = model;
      this.#fact({ t: "agent_rebind", agent: intent.agent.id, from: prev, to: model });
    }
    intent.state = "active";
    this.#fact({ t: "intent_resume", intent: intent.id, agent: intent.agent.id });
  }

  /** Approve with a SCOPE: the plain-data envelope of what was agreed;
   *  the scope lands in the ledger so the window is inspectable. */
  approve(intent, scope = {}) {
    this.#require(intent, "open", "active");
    if (intent.approval !== "required") {
      throw new SubstrateError("E_STATE", "this intent never required approval");
    }
    intent.approval = { approved: cloneContext(scope), at: nowIso() };
    this.#fact({ t: "intent_approve", intent: intent.id, scope: intent.approval.approved });
  }

  /** Grant authority INTO the intent's envelope. Host presents the source
   *  actor's control + slot and the agent's control (consent, per v1.6).
   *  A budget membrane is attached at grant time, so the substrate — not
   *  this layer — ultimately charges the attempts. */
  grantFor(intent, fromControl, fromSlot, opts = {}) {
    this.#requireLive(intent);
    const slot = `intent:${intent.id}:${fromSlot}`;
    const membranes = intent.budget ? [rateLimit(intent.budget.calls)] : [];
    const cap = this.rt.grantCap(
      this.rt.holds(fromControl, fromSlot),
      intent.agent.control,
      slot,
      { rights: opts.rights ?? ["send"], membranes }
    );
    intent.envelope.push({ slot, cap });
    this.#fact({ t: "intent_grant", intent: intent.id, agent: intent.agent.id, slot, tool: fromSlot });
    return slot;
  }

  /** The mediated call: lifecycle, approval, budget and envelope are
   *  checked HERE; rights, deadline, membranes and cloning are enforced
   *  THERE (the substrate). correlationId = intent id is what makes
   *  evidence provable later. `for:` names the obligations the call is
   *  made AGAINST — chosen before the effect leaves, never after
   *  (CO-5); an anonymous call is legal but can never be re-labelled
   *  into a receipt at completion time. */
  async call(intent, slot, args, { for: obligationIds = [] } = {}) {
    this.#requireLive(intent);
    const denied = (code, msg) => {
      this.#fact({ t: "intent_call", intent: intent.id, slot, outcome: "denied", code });
      throw new SubstrateError(code, msg);
    };
    if (intent.state === "suspended") denied("E_STATE", "suspended intents make no calls; resume first");
    if (!intent.envelope.some((e) => e.slot === slot)) {
      denied("E_NO_CAP", `slot '${slot}' is not part of this intent's envelope`);
    }
    if (intent.approval === "required") {
      denied("E_APPROVAL", "intent requires approval before effecting calls");
    }
    if (intent.budget && intent.spent >= intent.budget.calls) {
      denied("E_BUDGET", `intent budget exhausted (${intent.budget.calls} calls)`);
    }
    if (!Array.isArray(obligationIds)) denied("E_INVAL", "obligation bindings must be a list of ids");
    const byId = new Map(intent.contract.map((o) => [o.id, o]));
    for (const oid of obligationIds) {
      if (!byId.has(oid)) {
        denied("E_INVAL", `dispatch binds no obligation: '${oid}' is not in ${intent.id}'s contract at revision ${intent.contractRevision}`);
      }
    }
    intent.spent += 1; // charged-attempt, mirroring membrane semantics
    let xact = null;
    try {
      // request() denies synchronously (deadline/cap/clone); it must still
      // land inside the try or the refusal would leave no intent-level fact.
      const req = this.rt.request(intent.agent.control, slot, args, {
        correlationId: intent.id,
        deadline: intent.deadline,
      });
      xact = req.xact;
      // The binding fact is written BEFORE any result is observable —
      // completion claims can only select what this line recorded.
      this.#fact({
        t: "intent_dispatch", intent: intent.id, slot, xact,
        ownerEpoch: intent.ownerEpoch, contractRevision: intent.contractRevision,
        obligationIds: [...new Set(obligationIds)],
      });
      const result = await req.promise;
      this.#fact({ t: "intent_call", intent: intent.id, slot, xact, outcome: "ok" });
      return { xact, result };
    } catch (e) {
      this.#fact({ t: "intent_call", intent: intent.id, slot, xact, outcome: "fail", code: e.code ?? null });
      throw e;
    }
  }

  /** merge_context: a child's beliefs join the parent's lineage — accept
   *  or reject, explicitly; the lineage records which happened. A revoked
   *  branch contributes nothing. */
  mergeContext(childIntent, { accept = true } = {}) {
    const parent = childIntent.parent;
    if (!parent) throw new SubstrateError("E_STATE", "only forked/delegated intents have a context parent");
    if (childIntent.state === "revoked") {
      throw new SubstrateError("E_STATE", "a revoked intent contributes no context");
    }
    this.#fact({ t: "intent_merge", intent: childIntent.id, into: parent.id, accept });
    if (accept) parent.context.absorb(childIntent.context, childIntent.id);
    return parent.context.snapshot();
  }

  /** Complete = the contract, or nothing. With a CompletionContract, this
   *  is the COMPLETING check (ST-1): every claim must SELECT a dispatch
   *  binding the ledger recorded before any result was observable (CO-5),
   *  and every obligation needs ≥ minOccurrences distinct discharges.
   *  With an empty contract the S1 gate remains: at least one ledger-
   *  backed ok effect — the degenerate one-obligation case. */
  async complete(intent, claims = []) {
    this.#requireLive(intent);
    if (intent.contract.length > 0) return this.#completeAgainstContract(intent, claims);
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new SubstrateError("E_NO_EVIDENCE", "completion requires at least one evidence item");
    }
    const backed = this.#journalBackedXacts(intent);
    for (const item of claims) {
      const isBacked = !!(item && item.xact && backed.has(item.xact));
      if (item && item.xact && !isBacked) {
        throw new SubstrateError("E_NO_EVIDENCE", `evidence xact '${item.xact}' is not a journaled ok call on this intent`);
      }
      intent.evidence.push({ ...cloneOrWrap(item), backed: isBacked });
    }
    if (!intent.evidence.some((e) => e.backed)) {
      throw new SubstrateError("E_NO_EVIDENCE", "no evidence item is backed by the ledger");
    }
    intent.state = "completed";
    this.#fact({ t: "intent_complete", intent: intent.id, agent: intent.agent.id, evidence: intent.evidence.length });
    return intent;
  }

  #completeAgainstContract(intent, claims) {
    if (!Array.isArray(claims)) {
      throw new SubstrateError("E_INVAL", "completion takes a list of {xact, obligation} claims");
    }
    const backed = this.#journalBackedXacts(intent);
    const bindings = this.#dispatchBindings(intent);
    const discharged = new Map(intent.contract.map((o) => [o.id, new Set()]));
    const refuse = (claim, why) => {
      this.#fact({ t: "completion_denied", intent: intent.id, claim: claim ?? null, why });
      throw new SubstrateError("E_NO_EVIDENCE", why);
    };
    for (const claim of claims) {
      const { xact, obligation } = claim ?? {};
      const bind = xact ? bindings.get(xact) : null;
      if (!bind) refuse(claim, `claim xact '${xact ?? "—"}' has no dispatch binding on ${intent.id}`);
      if (!backed.has(xact)) refuse(claim, `dispatch '${xact}' did not settle ok — a failed call discharges nothing`);
      if (!bind.obligationIds.includes(obligation)) {
        refuse(claim, `CO-5: '${xact}' was bound at dispatch to [${bind.obligationIds.join(", ") || "anonymous"}], not '${obligation}' — bindings precede effects`);
      }
      const ob = intent.contract.find((o) => o.id === obligation);
      if (ob.bornEpoch > bind.ownerEpoch || ob.bornRevision > bind.contractRevision) {
        refuse(claim, `HO-4: obligation '${obligation}' was born at (epoch ${ob.bornEpoch}, rev ${ob.bornRevision}) — after the dispatch's (epoch ${bind.ownerEpoch}, rev ${bind.contractRevision}); past work cannot pay for future promises`);
      }
      discharged.get(obligation).add(xact);
    }
    const unmet = intent.contract
      .filter((o) => discharged.get(o.id).size < o.minOccurrences)
      .map((o) => o.id);
    if (unmet.length) {
      this.#fact({ t: "completion_denied", intent: intent.id, unmet });
      throw new SubstrateError("E_NO_EVIDENCE", `unmet obligations: ${unmet.join(", ")}`);
    }
    intent.evidence.push(...claims.map((c) => ({ ...cloneOrWrap(c), backed: true })));
    intent.state = "completed";
    this.#fact({
      t: "intent_complete", intent: intent.id, agent: intent.agent.id,
      contract: intent.contract.map((o) => o.id), evidence: intent.evidence.length,
    });
    return intent;
  }

  fail(intent, reason) {
    this.#requireLive(intent);
    intent.state = "failed";
    this.#fact({ t: "intent_fail", intent: intent.id, agent: intent.agent.id, reason: String(reason ?? "") });
  }

  /** Revoke: the whole subtree dies; every envelope capability is revoked
   *  in the substrate, so in-flight authority disappears with it (#6). */
  revoke(intent) {
    if (intent.state === "revoked") return;
    intent.state = "revoked";
    for (const { cap } of intent.envelope) {
      try {
        this.rt.revoke(cap);
      } catch { /* dead or foreign caps cannot block the fact of revocation */ }
    }
    this.#fact({ t: "intent_revoke", intent: intent.id, agent: intent.agent.id });
    for (const childId of intent.children) {
      const child = this.intents.get(childId);
      if (child) this.revoke(child);
    }
  }

  #track(agent, intent) {
    agent.intents.set(intent.id, intent);
    this.intents.set(intent.id, intent);
  }

  #journalBackedXacts(intent) {
    const set = new Set();
    for (const { event } of this.rt.journalEntries()) {
      if (event.t === "invoke" && event.correlationId === intent.id && event.outcome === "ok") set.add(event.xact);
    }
    return set;
  }

  /* CO-5's read side: what the ledger says each dispatch was FOR. Facts
   * are the only source — no in-layer cache exists to be re-labelled. */
  #dispatchBindings(intent) {
    const m = new Map();
    for (const { event } of this.rt.journalEntries()) {
      if (event.t === "intent_dispatch" && event.intent === intent.id) {
        m.set(event.xact, {
          obligationIds: event.obligationIds ?? [],
          ownerEpoch: event.ownerEpoch,
          contractRevision: event.contractRevision,
        });
      }
    }
    return m;
  }

  #fact(ev) {
    this.rt.record({ ...ev, at: nowIso() });
  }

  #requireLive(intent) {
    if (intent.state === "suspended" || intent.state === "open" || intent.state === "active") {
      if (intent.state === "open") intent.state = "active"; // first structural act activates
      return;
    }
    throw new SubstrateError("E_STATE", `intent ${intent.id} is ${intent.state}`);
  }

  #require(intent, ...states) {
    if (!states.includes(intent.state)) {
      throw new SubstrateError("E_STATE", `intent ${intent.id} is ${intent.state}, expected ${states.join("|")}`);
    }
  }
}

function cloneOrWrap(item) {
  try {
    return structuredClone(item);
  } catch {
    return { note: String(item) };
  }
}
