/**
 * Agamen APM — the Agent Process Model (semantic track S).
 *
 * Conformance target: spec/apm.md. Landed so far: S1's lifecycle +
 * evidence gate; S2.1's CO-5 dispatch-time obligation binding
 * (receipt-kind CompletionContracts, append-only amend, ownerEpoch /
 * contractRevision stamps on every dispatch); and the ST-3/ST-2 trusted
 * state base, closed by S2.1a: an Intent is a read-only token whose
 * EVERY decision-relevant field lives in one private record —
 * relations (agent, parent, children), configuration (goal, budget,
 * deadline, approval, context) and determinable state (state,
 * stateVersion, contract, contractRevision, ownerEpoch, envelope,
 * evidence, spent). The record is BRANDED with the AgentSystem that
 * wrote it: an intent's state is defined by exactly one ledger, and any
 * other system touching it is refused (E_FOREIGN) before it can write a
 * fact into the wrong place. Views out are true immutable snapshots
 * (structuredClone + deepFreeze; capability tokens keep reference
 * identity — they are opaque handles, not data to copy), and every
 * lifecycle edge rides one transition primitive (spec ST-2) journaling
 * {intent, fromState, toState, stateVersion, cause}. OPEN activates only
 * at the first act that clears every layer guard (call dispatch,
 * capability grant): a guard-refused attempt changes no lifecycle.
 * State is derived from facts, not mutable truth — ledger replay
 * reconstructs each intent's path, and no holder-side act can edit an
 * intermediate state into existence.
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
 *     complete without journal-backed evidence. To its holder it is a
 *     VIEW: readable, never writable.
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
    if (ob.matcher !== null && ob.matcher !== undefined) {
      // A field that looks like policy but executes nothing is a poisoned
      // oracle waiting to happen: refuse it at the door.
      throw new SubstrateError("E_INVAL", `matcher on obligation '${id}' is refused — matcher semantics land with the COMPLETING skeleton (spec §8); nothing is silently ignored`);
    }
    if (seen.has(id)) throw new SubstrateError("E_INVAL", `duplicate obligation id '${id}'`);
    seen.add(id);
    out.push({ id, kind: "receipt", minOccurrences: min });
  }
  return out;
}

/* ---------- contexts: the new memory model ----------
 * A context is a plain-data snapshot. Lineage = the ordered record of
 * transitions; fork copies the current snapshot, child mutations stay
 * isolated until an explicit merge_context, which may be accepted or
 * rejected. The fork/join discipline, but over BELIEFS. mutate() is the
 * SANCTIONED holder path for beliefs; what no holder may do is replace
 * the reference or edit the lineage — it is append-only through the
 * object's own three verbs, and reads come out frozen. */

function cloneContext(data) {
  try {
    return structuredClone(data);
  } catch {
    throw new SubstrateError("E_CANON", "context data must be structurally cloneable");
  }
}

function freezeDeep(v) {
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) freezeDeep(v[k]);
    Object.freeze(v);
  }
  return v;
}

/* The one snapshot copier (S2.1a): clone FIRST, then freeze — a
 * freeze-only path (shallow spread + freezeDeep) would freeze the
 * private record's own nested objects through a shared reference, which
 * is "unwritable" but not the claimed "immutable snapshot clone".
 * Callers that must preserve opaque handles (envelope caps) do NOT route
 * those through here. */
function snapshot(v) {
  if (v === null || typeof v !== "object") return v;
  try {
    return freezeDeep(structuredClone(v));
  } catch {
    throw new SubstrateError("E_CANON", "snapshot data must be structurally cloneable");
  }
}

class Context {
  #data;
  #lineage = [];

  constructor(data = {}, seed = "root") {
    this.#data = cloneContext(data);
    this.#lineage.push({ at: nowIso(), event: "born", from: seed });
  }
  get lineage() {
    return Object.freeze(this.#lineage.map((l) => Object.freeze({ ...l })));
  }
  snapshot() {
    return cloneContext(this.#data);
  }
  mutate(next) {
    this.#data = cloneContext(next);
    this.#lineage.push({ at: nowIso(), event: "mutate" });
  }
  absorb(other, fromIntentId) {
    this.#data = cloneContext(other.snapshot());
    this.#lineage.push({ at: nowIso(), event: "merge", from: fromIntentId });
  }
}

/* ---------- AgentExecution ---------- */

export class AgentExecution {
  id;
  label;
  model;
  control; // ActorControl handle — host-plane only, never handed into the agent realm
  context;
  sys; // host-plane back-reference (AgentSystem); intents check it for ownership
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

/* ---------- Intent: a token; the truth is branded and private (ST-3) ----------
 * What a holder carries is a VIEW with no writable surface at all: even
 * `id` is private state, because every check, every ledger correlation
 * and every replay keys on it. The private record holds the ENTIRE
 * decision-relevant set — relations, configuration and derived state —
 * because any field left public is the side door that re-enables the
 * bypass the previous round plugged (intent.approval = "not_required"
 * walked past the approval gate; children.clear() escaped the revoke
 * cascade; a bare intent.agent = … skipped handoff's envelope kill,
 * epoch++ and fact). The record also names its owning AgentSystem:
 * PRIV is module-wide, but only the branding system may read-modify
 * through its own checked accessor. */

const PRIV = new WeakMap(); // Intent -> {system, …the one authoritative record}

/* Lifecycle edges legal in this slice (spec §2 rows that S2.1 item 1
 * covers). COMPLETING, WAITING_* and CANCELLED edges arrive with their
 * own slices; terminal states have no outgoing edges, ever. Genesis is
 * not in the table — the primitive admits exactly one null → open. */
const LEGAL_EDGES = {
  open: new Set(["active", "failed", "revoked"]),
  active: new Set(["suspended", "completed", "failed", "revoked"]),
  suspended: new Set(["active", "failed", "revoked"]),
};

export class Intent {
  #id;
  constructor({ system, agent, parent = null, goal, budget = null, deadline = null, approval = "not_required", contextSeed = {}, contract = [] }) {
    this.#id = `i${nextIntent++}`;
    PRIV.set(this, {
      system, // ST-3 ownership boundary: exactly one AgentSystem defines this record
      agent, // AgentExecution currently holding the envelope
      parent,
      children: new Set(), // child intent ids — the revoke cascade walks this
      goal: cloneContext(goal), // the requested outcome, plain data
      budget: budget === null ? null : cloneContext(budget), // {calls} charged per mediated attempt
      deadline, // absolute ms, enforced by the substrate at request time
      approval, // "not_required" | "required" | { approved, at }
      context: new Context(contextSeed, this.#id),
      openedAt: nowIso(),
      // state null / version -1 until the OPEN genesis edge lands them at
      // open / 0 through the same primitive as every other edge (ST-2)
      state: null,
      stateVersion: -1,
      contract: normalizeContract(contract).map((o) => ({ ...o, bornRevision: 0, bornEpoch: 1 })),
      contractRevision: 0,
      ownerEpoch: 1, // HO-1: +1 per handoff
      envelope: [], // {slot, cap} earned at the CURRENT holder's slot table
      evidence: [],
      spent: 0, // charged-attempt accounting through call()
    });
  }

  get id() { return this.#id; }
  get agent() { return PRIV.get(this).agent; }
  get parent() { return PRIV.get(this).parent; }
  get children() { return Object.freeze([...PRIV.get(this).children]); }
  get goal() { return snapshot(PRIV.get(this).goal); }
  get budget() { return snapshot(PRIV.get(this).budget); }
  get deadline() { return PRIV.get(this).deadline; }
  get approval() { return snapshot(PRIV.get(this).approval); }
  get context() { return PRIV.get(this).context; } // beliefs: mutate() is the sanctioned holder path
  get openedAt() { return PRIV.get(this).openedAt; }
  get state() { return PRIV.get(this).state; }
  get stateVersion() { return PRIV.get(this).stateVersion; }
  get contractRevision() { return PRIV.get(this).contractRevision; }
  get ownerEpoch() { return PRIV.get(this).ownerEpoch; }
  get spent() { return PRIV.get(this).spent; }
  get contract() { return Object.freeze(PRIV.get(this).contract.map((o) => snapshot(o))); }
  get envelope() {
    return Object.freeze(PRIV.get(this).envelope.map((e) => Object.freeze({ slot: e.slot, cap: e.cap })));
  }
  get evidence() { return Object.freeze(PRIV.get(this).evidence.map((ev) => snapshot(ev))); }
}

/* ---------- the system: host-plane glue ---------- */

export class AgentSystem {
  rt;
  agents = new Map(); // id -> AgentExecution
  intents = new Map(); // id -> Intent (system-wide index, incl. handed-off ones)

  constructor(rt) {
    this.rt = rt;
  }

  /* THE accessor (ST-3): no AgentSystem method reaches a private record
   * without passing here. PRIV is shared module-wide, so without the
   * brand a second AgentSystem could drive an intent's state and journal
   * the edges into a DIFFERENT ledger — then "ledger replay reconstructs
   * the state" would be false for the ledger that actually minted the
   * intent. Foreign touch: E_FOREIGN, before any fact, any mutation. */
  #R(intent) {
    const r = PRIV.get(intent);
    if (!r || r.system !== this) {
      throw new SubstrateError("E_FOREIGN", "this intent's state is defined by another AgentSystem's ledger");
    }
    return r;
  }

  #ownAgent(agent, role) {
    if (!(agent instanceof AgentExecution) || agent.sys !== this) {
      throw new SubstrateError("E_FOREIGN", `this ${role} belongs to another AgentSystem`);
    }
  }

  register(label, opts = {}) {
    return new AgentExecution(this, label, opts);
  }

  open(agent, { goal, budget = null, deadline = null, approval = "not_required", context = {}, contract = [] } = {}) {
    this.#ownAgent(agent, "agent");
    if (!goal || typeof goal !== "object") throw new SubstrateError("E_INVAL", "goal must describe the requested outcome");
    const intent = new Intent({ system: this, agent, goal, budget, deadline, approval, contextSeed: context, contract });
    this.#track(agent, intent);
    const rec = this.#R(intent);
    this.#fact({
      t: "intent_open", intent: intent.id, agent: agent.id, goal, budget, deadline, approval,
      contract: rec.contract.map((o) => o.id),
    });
    this.#transition(intent, "open", "open"); // genesis rides the same primitive — no special case
    return intent;
  }

  /** Fork: a child intent on the SAME agent; its context branches from a
   *  copy of the parent's snapshot. */
  fork(parentIntent, { goal, budget = null, deadline = null, approval, contract = [] } = {}) {
    const rec = this.#R(parentIntent);
    this.#guardLive(rec);
    // The child is built FIRST: an invalid contract throws here and the
    // parent's lifecycle never moved — guard-refused acts change nothing.
    const child = new Intent({
      system: this,
      agent: rec.agent,
      parent: parentIntent,
      goal: goal ?? rec.goal,
      budget,
      deadline,
      approval: approval ?? rec.approval,
      contextSeed: rec.context.snapshot(),
      contract,
    });
    rec.children.add(child.id);
    this.#track(rec.agent, child);
    this.#fact({ t: "intent_fork", intent: child.id, parent: parentIntent.id, agent: rec.agent.id });
    this.#transition(child, "open", "fork"); // genesis rides the same primitive
    return child;
  }

  /** Delegate: a NEW child intent executed by another agent; the parent
   *  keeps ownership and receives the merged result. */
  delegate(parentIntent, targetAgent, { goal, budget = null, deadline = null, approval, contract = [] } = {}) {
    this.#ownAgent(targetAgent, "delegate target");
    const rec = this.#R(parentIntent);
    this.#guardLive(rec);
    const child = new Intent({
      system: this,
      agent: targetAgent,
      parent: parentIntent,
      goal: goal ?? rec.goal,
      budget,
      deadline,
      approval: approval ?? rec.approval,
      contextSeed: rec.context.snapshot(),
      contract,
    });
    rec.children.add(child.id);
    this.#track(targetAgent, child);
    this.#fact({
      t: "intent_delegate", intent: child.id, parent: parentIntent.id,
      from: rec.agent.id, to: targetAgent.id,
    });
    this.#transition(child, "open", "delegate"); // genesis rides the same primitive
    return child;
  }

  /** Append-only contract amendment (CO-1): adds obligations stamped with
   *  the bumped contractRevision and current ownerEpoch. There is no
   *  removal path here on purpose — retiring a requirement is
   *  supersede/waiver (§8 item 5), a separate owned act. A promise is
   *  not an attempt: amending an OPEN intent keeps it OPEN. */
  amend(intent, obligations) {
    const rec = this.#R(intent);
    this.#guardLive(rec);
    const added = normalizeContract(obligations); // may throw — nothing has changed yet
    const have = new Set(rec.contract.map((o) => o.id));
    for (const ob of added) {
      if (have.has(ob.id)) throw new SubstrateError("E_INVAL", `obligation '${ob.id}' is already in the contract`);
    }
    rec.contractRevision += 1;
    for (const ob of added) {
      rec.contract.push({ ...ob, bornRevision: rec.contractRevision, bornEpoch: rec.ownerEpoch });
    }
    this.#fact({
      t: "contract_amend", intent: intent.id, revision: rec.contractRevision,
      epoch: rec.ownerEpoch, added: added.map((o) => o.id),
    });
    return rec.contract.map((o) => o.id);
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
   *  delegate, which spawns a child elsewhere and keeps ownership.
   *  An assignment `intent.agent = …` can never stand in for this: the
   *  field is not writable, and the three effects here (envelope revoke,
   *  epoch++, the fact) are the definition of the move. */
  handoff(intent, targetAgent) {
    this.#ownAgent(targetAgent, "handoff target");
    const rec = this.#R(intent);
    this.#guardLive(rec);
    const from = rec.agent;
    from.intents.delete(intent.id);
    targetAgent.intents.set(intent.id, intent);
    rec.agent = targetAgent;
    for (const { cap } of rec.envelope) {
      try { this.rt.revoke(cap); } catch { /* already dead — foreign/revoked */ }
    }
    const slots = rec.envelope.map((e) => e.slot);
    rec.envelope = []; // new holder must re-grant before it can call
    rec.ownerEpoch += 1; // HO-1: work and promises order against the epoch they were made under
    this.#fact({
      t: "intent_handoff", intent: intent.id, from: from.id, to: targetAgent.id,
      envelope: "revoked", slots, ownerEpoch: rec.ownerEpoch,
    });
    return intent;
  }

  suspend(intent) {
    this.#transition(intent, "suspended", "suspend");
    this.#fact({ t: "intent_suspend", intent: intent.id, agent: this.#R(intent).agent.id });
  }

  /** Resume optionally rebinds the EXECUTING MODEL: the principal,
   *  authority, context and budget survive; the "CPU" does not. A process
   *  API cannot express this transition. */
  resume(intent, { model = null } = {}) {
    const rec = this.#R(intent);
    this.#requireState(rec, "suspended"); // trigger guard: only a park may resume
    if (model !== null && model !== rec.agent.model) {
      const prev = rec.agent.model;
      rec.agent.model = model;
      this.#fact({ t: "agent_rebind", agent: rec.agent.id, from: prev, to: model });
    }
    this.#transition(intent, "active", "resume");
    this.#fact({ t: "intent_resume", intent: intent.id, agent: rec.agent.id });
  }

  /** Approve with a SCOPE: the plain-data envelope of what was agreed;
   *  the scope lands in the ledger so the window is inspectable.
   *  Approval is an admission condition, not an attempt: approving an
   *  OPEN intent keeps it OPEN. */
  approve(intent, scope = {}) {
    const rec = this.#R(intent);
    this.#requireState(rec, "open", "active");
    if (rec.approval !== "required") {
      throw new SubstrateError("E_STATE", "this intent never required approval");
    }
    rec.approval = { approved: cloneContext(scope), at: nowIso() };
    this.#fact({ t: "intent_approve", intent: intent.id, scope: rec.approval.approved });
  }

  /** Grant authority INTO the intent's envelope. Host presents the source
   *  actor's control + slot and the agent's control (consent, per v1.6).
   *  A budget membrane is attached at grant time, so the substrate — not
   *  this layer — ultimately charges the attempts. Activation follows
   *  SUCCESS: if grantCap refuses, the OPEN intent is untouched. */
  grantFor(intent, fromControl, fromSlot, opts = {}) {
    const rec = this.#R(intent);
    this.#guardLive(rec);
    const slot = `intent:${intent.id}:${fromSlot}`;
    const membranes = rec.budget ? [rateLimit(rec.budget.calls)] : [];
    const cap = this.rt.grantCap(
      this.rt.holds(fromControl, fromSlot),
      rec.agent.control,
      slot,
      { rights: opts.rights ?? ["send"], membranes }
    );
    this.#activate(intent, rec, "grant");
    rec.envelope.push({ slot, cap });
    this.#fact({ t: "intent_grant", intent: intent.id, agent: rec.agent.id, slot, tool: fromSlot });
    return slot;
  }

  /** The mediated call: lifecycle, approval, budget and envelope are
   *  checked HERE; rights, deadline, membranes and cloning are enforced
   *  THERE (the substrate). correlationId = intent id is what makes
   *  evidence provable later. `for:` names the obligations the call is
   *  made AGAINST — chosen before the effect leaves, never after
   *  (CO-5); an anonymous call is legal but can never be re-labelled
   *  into a receipt at completion time. OPEN activation happens only
   *  AFTER every layer guard passes: a refused attempt (bad slot,
   *  missing approval, exhausted budget, unknown obligation) is a denial
   *  fact and no lifecycle change. */
  async call(intent, slot, args, { for: obligationIds = [] } = {}) {
    const rec = this.#R(intent);
    const denied = (code, msg) => {
      this.#fact({ t: "intent_call", intent: intent.id, slot, outcome: "denied", code });
      throw new SubstrateError(code, msg);
    };
    this.#guardLive(rec); // terminal states throw E_STATE here
    if (rec.state === "suspended") denied("E_STATE", "suspended intents make no calls; resume first");
    if (!rec.envelope.some((e) => e.slot === slot)) {
      denied("E_NO_CAP", `slot '${slot}' is not part of this intent's envelope`);
    }
    if (rec.approval === "required") {
      denied("E_APPROVAL", "intent requires approval before effecting calls");
    }
    if (rec.budget && rec.spent >= rec.budget.calls) {
      denied("E_BUDGET", `intent budget exhausted (${rec.budget.calls} calls)`);
    }
    if (!Array.isArray(obligationIds)) denied("E_INVAL", "obligation bindings must be a list of ids");
    const byId = new Map(rec.contract.map((o) => [o.id, o]));
    for (const oid of obligationIds) {
      if (!byId.has(oid)) {
        denied("E_INVAL", `dispatch binds no obligation: '${oid}' is not in ${intent.id}'s contract at revision ${rec.contractRevision}`);
      }
    }
    this.#activate(intent, rec, "call"); // admitted: the attempt may now be charged
    rec.spent += 1; // charged-attempt, mirroring membrane semantics
    let xact = null;
    try {
      // request() denies synchronously (deadline/cap/clone); it must still
      // land inside the try or the refusal would leave no intent-level fact.
      // The binding fact is written in the substrate's ADMIT HOOK — after
      // the xact exists, before the handler runs, reading the private
      // record's (epoch, revision) as they stand at dispatch (CO-5).
      const req = this.rt.request(rec.agent.control, slot, args, {
        correlationId: intent.id,
        deadline: rec.deadline,
        onAdmit: (x) => {
          xact = x;
          this.#fact({
            t: "intent_dispatch", intent: intent.id, slot, xact: x,
            ownerEpoch: rec.ownerEpoch, contractRevision: rec.contractRevision,
            obligationIds: [...new Set(obligationIds)],
          });
        },
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
    const rec = this.#R(childIntent);
    const parent = rec.parent;
    if (!parent) throw new SubstrateError("E_STATE", "only forked/delegated intents have a context parent");
    if (rec.state === "revoked") {
      throw new SubstrateError("E_STATE", "a revoked intent contributes no context");
    }
    this.#fact({ t: "intent_merge", intent: childIntent.id, into: parent.id, accept });
    if (accept) parent.context.absorb(rec.context, childIntent.id);
    return parent.context.snapshot();
  }

  /** Complete = the contract, or nothing. With a CompletionContract, this
   *  is the COMPLETING check (ST-1): every claim must SELECT a dispatch
   *  binding the ledger recorded before any result was observable (CO-5),
   *  and every obligation needs ≥ minOccurrences distinct discharges.
   *  With an empty contract the S1 gate remains: at least one ledger-
   *  backed ok effect — the degenerate one-obligation case.
   *  KNOWN GAP (lands with the COMPLETING skeleton, spec §8 item 2): a
   *  FAILED completion on the legacy path may still leave candidate
   *  evidence in the record; the working-set commit rule ("claims form a
   *  temporary set; evidence truth changes only at COMPLETING → COMPLETED")
   *  is deliberately not patched here. The contract branch already
   *  follows it. */
  async complete(intent, claims = []) {
    const rec = this.#R(intent);
    this.#guardLive(rec);
    if (rec.contract.length > 0) return this.#completeAgainstContract(intent, rec, claims);
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new SubstrateError("E_NO_EVIDENCE", "completion requires at least one evidence item");
    }
    const backed = this.#journalBackedXacts(intent);
    for (const item of claims) {
      const isBacked = !!(item && item.xact && backed.has(item.xact));
      if (item && item.xact && !isBacked) {
        throw new SubstrateError("E_NO_EVIDENCE", `evidence xact '${item.xact}' is not a journaled ok call on this intent`);
      }
      rec.evidence.push({ ...cloneOrWrap(item), backed: isBacked });
    }
    if (!rec.evidence.some((e) => e.backed)) {
      throw new SubstrateError("E_NO_EVIDENCE", "no evidence item is backed by the ledger");
    }
    this.#transition(intent, "completed", "complete");
    this.#fact({ t: "intent_complete", intent: intent.id, agent: rec.agent.id, evidence: rec.evidence.length });
    return intent;
  }

  #completeAgainstContract(intent, rec, claims) {
    if (!Array.isArray(claims)) {
      throw new SubstrateError("E_INVAL", "completion takes a list of {xact, obligation} claims");
    }
    const backed = this.#journalBackedXacts(intent);
    const bindings = this.#dispatchBindings(intent);
    const discharged = new Map(rec.contract.map((o) => [o.id, new Set()]));
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
      const ob = rec.contract.find((o) => o.id === obligation);
      if (ob.bornEpoch > bind.ownerEpoch || ob.bornRevision > bind.contractRevision) {
        refuse(claim, `HO-4: obligation '${obligation}' was born at (epoch ${ob.bornEpoch}, rev ${ob.bornRevision}) — after the dispatch's (epoch ${bind.ownerEpoch}, rev ${bind.contractRevision}); past work cannot pay for future promises`);
      }
      discharged.get(obligation).add(xact);
    }
    const unmet = rec.contract
      .filter((o) => discharged.get(o.id).size < o.minOccurrences)
      .map((o) => o.id);
    if (unmet.length) {
      this.#fact({ t: "completion_denied", intent: intent.id, unmet });
      throw new SubstrateError("E_NO_EVIDENCE", `unmet obligations: ${unmet.join(", ")}`);
    }
    rec.evidence.push(...claims.map((c) => ({ ...cloneOrWrap(c), backed: true })));
    this.#transition(intent, "completed", "complete");
    this.#fact({
      t: "intent_complete", intent: intent.id, agent: rec.agent.id,
      contract: rec.contract.map((o) => o.id), evidence: rec.evidence.length,
    });
    return intent;
  }

  /** Fail is reachable straight from OPEN (open → failed is a legal
   *  edge): abandoning an unstarted intent must not require a fake
   *  ACTIVE stop on the way out. */
  fail(intent, reason) {
    const rec = this.#R(intent);
    this.#guardLive(rec);
    this.#transition(intent, "failed", "fail");
    this.#fact({ t: "intent_fail", intent: intent.id, agent: rec.agent.id, reason: String(reason ?? "") });
  }

  /** Revoke: the whole subtree dies; every envelope capability is revoked
   *  in the substrate, so in-flight authority disappears with it (#6).
   *  Terminal is terminal: a completed or failed intent keeps its state
   *  (revoking a fact would be editing history) — but the cascade still
   *  runs down, because the children may not be terminal. The cascade
   *  walks the PRIVATE children set: a holder cannot dodge it by editing
   *  a view. */
  revoke(intent) {
    const rec = this.#R(intent);
    const s = rec.state;
    if (s !== "revoked" && s !== "completed" && s !== "failed") {
      for (const { cap } of rec.envelope) {
        try {
          this.rt.revoke(cap);
        } catch { /* dead or foreign caps cannot block the fact of revocation */ }
      }
      this.#transition(intent, "revoked", "revoke");
      this.#fact({ t: "intent_revoke", intent: intent.id, agent: rec.agent.id });
    }
    for (const childId of rec.children) {
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

  /* The one lifecycle writer (ST-2). An edge is read, validated,
   * versioned, applied and journalled here or nowhere: no method of
   * this class assigns state or stateVersion itself, so the journal of
   * `intent_state` facts is by construction replay-unique —
   * {intent, fromState, toState, stateVersion, cause} with
   * fromState == the previous event's toState and stateVersion exactly
   * +1. Illegal edges move nothing and are refusable facts, not
   * silence. Genesis (null → open, version 0) rides the same
   * primitive. */
  #transition(intent, toState, cause) {
    const rec = this.#R(intent);
    const fromState = rec.state;
    const legal = fromState === null ? toState === "open" : (LEGAL_EDGES[fromState]?.has(toState) ?? false);
    if (!legal) {
      this.#fact({
        t: "intent_transition_denied", intent: intent.id,
        fromState, toState, stateVersion: rec.stateVersion, cause,
      });
      throw new SubstrateError("E_STATE", `intent ${intent.id}: ${fromState} → ${toState} is not a legal edge (state and version unchanged)`);
    }
    rec.state = toState;
    rec.stateVersion += 1;
    this.#fact({
      t: "intent_state", intent: intent.id, fromState, toState,
      stateVersion: rec.stateVersion, cause, agent: rec.agent.id,
    });
    return intent;
  }

  /* Live-for-an-operation, WITHOUT touching anything: OPEN, ACTIVE and
   * SUSPENDED are the states an operation may target; terminal states
   * throw. Activation (OPEN → ACTIVE) is a separate, EXPLICIT edge that
   * follows admission — see #activate. */
  #guardLive(rec) {
    const s = rec.state;
    if (s === "open" || s === "active" || s === "suspended") return;
    throw new SubstrateError("E_STATE", `intent is ${s}`);
  }

  /* Admission activates, refusal does not (spec §2, OPEN → ACTIVE):
   * the intent goes live at the first act that clears every layer
   * guard AND succeeds into an effect-bearing posture (a dispatched
   * call, a minted grant). Promises (amend), admission facts (approve)
   * and ownership moves (handoff) are not attempts, so they leave an
   * OPEN intent OPEN — which is also what keeps the planned
   * OPEN → WAITING_* edges from racing a half-activated state. */
  #activate(intent, rec, cause) {
    if (rec.state === "open") this.#transition(intent, "active", cause);
  }

  #requireState(rec, ...states) {
    if (!states.includes(rec.state)) {
      throw new SubstrateError("E_STATE", `intent is ${rec.state}, expected ${states.join("|")}`);
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
