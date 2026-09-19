# APM — the Agamen Agent Process Model (normative, S2)

> Status: **normative spec, rev. S2.0.9** — it stands on its own;
> `src/intent.js` (S1) is its first, partial implementation. S2.0.1 closed
> the spec-review gaps (§8 lists the six pins); S2.0.2 is the round-6
> honesty patch: CO-5 is defined as a three-phase order (binding
> precedes HANDLER execution, not every admission/policy side effect),
> and §7 records DEP-1, the first true S→E cross-track dependency;
> S2.0.3 synced labels to the landed ST-3/ST-2 state base; S2.0.4 is the
> round-7 trusted-state closure (S2.1a): ST-3's private set widened to
> EVERY decision-relevant field plus an owning-AgentSystem brand,
> snapshots defined as clone-then-freeze, and OPEN activation gated on
> admitted acts; S2.0.5 is the round-8 principal/context closure
> (S2.1b): ST-3's boundary made TRANSITIVE over the reachable object
> graph — `intent.agent` is an inert AgentPrincipal view, context is a
> ContextVersion stream behind owned mutation acts, and no holder-side
> reference path reaches a mutable authority-bearing object; S2.0.6 is
> the round-9 ingress ownership closure (S2.1c): the boundary made
> BIDIRECTIONAL — no mutable aliases out AND no caller-owned aliases in
> (inputs clone-ingress into private records; every fact is deep-owned
> before the ledger, which does not clone events); S2.0.7 is the
> round-10 prototype closure (S2.1d): the boundary now covers the
> BEHAVIOR surface — view prototypes are frozen, and authoritative
> identity is record data that internal code never reads through a
> presentation getter; S2.0.8 is the round-11 COMPLETING floor
> (S2.2a): authoritative state speaks one JSON-safe plain-data domain,
> facts are SANITIZED into fixed structures — never converted through
> attacker-controlled code — and a ContextVersion handed out by the
> view is a detached value, not a cursor; S2.0.9 is the round-12
> domain closure (S2.2b): the domain is nailed to values that keep
> DISTINCT representations under the provenance hash (dense arrays,
> own enumerable string-keyed data props, -0 normalized, holes and
> symbol keys refused), and the fact path admits two categories only —
> APM-owned values copied in full, raw payloads inspected by descriptor
> and branch-refused to a fixed `{$untrusted}` marker, so a hostile
> value can choose its own opacity but can never veto a denial fact.
> ST-4 remains explicitly NOT claimed.
> This file inherits the
> vocabulary of `spec/invariants.md` and the track definitions of
> `ROADMAP.md`.
> Rule ids (`OT-*`, `ST-*`, `CO-*`, `DC-*`, `HO-*`, `AT-*`) are citable.
> Each rule carries an S1 status: **[pinned]** = implemented and locked
> by a named negative/lifecycle test; **[partial]**; **[planned]**
> (S2.1 conformance work). Spec statements are never marked enforced —
> enforcement belongs to Track E.

```
OT-0  Ownership is not authority.
      Evidence is not correctness.
      Identity is not execution.
```

The three separations are the model's thesis; every rule below is one of
them applied somewhere. They are also the difference from a process
model (POSIX gives ownership and authority to the same uid, treats an
exit status as truth, and runs identity) and from a kernel like agate
(which *enforces* handles of these objects but must not *define* them).

---

## 1. Objects and relations (§OT)

**AgentPrincipal** — the accountable holder of control. Fields: stable
principal id; bound model(s) (mutable only through §5/§6 transitions);
a slot table (substrate ActorControl, trusted-plane); a Context head.
A principal is never destroyed by a model swap.

**Intent** — the schedulable unit of agency: `goal` (the requested
outcome, opaque structured data — the substrate never interprets it),
`CompletionContract` (§3), `AuthorityEnvelope`, budget, deadline,
approval state (§6), delegation edges (§4), evidence list (§3),
`ownerEpoch` and `contractRevision` — two independent monotonic counters
(§3/§5) — lifecycle state (§2).

**ContextVersion** — immutable belief snapshot; a lineage of
`born / mutate / merge` events; merge is two-headed (absorb records the
contributing intent and accept/reject verdict). Beliefs are data, never
authority. It is a VALUE, not a cursor: `{version, snapshot,
lineageRef}` — read v3 and it stays v3 even after the head walks to v5
(pinned S2.2a by `context: current() hands out a DETACHED
ContextVersion`); a context obligation binds this value, never a live
view that quietly changes under it. Its data belongs to the JSON-safe
plain-data domain (ST-3).

**AuthorityEnvelope** — the set of capability grants an intent has
earned *at its current owner's slot table*, each derived in the
substrate's capability graph, each optionally membrane-budgeted. The
envelope is the only lawful place the two graphs touch *in the
construction direction*, and the touch is consent-gated (§1, OT-1).

**Evidence** — a claim referring to a ledger fact: at minimum an
internal xact id plus the dispatch-time obligation binding recorded
with it (CO-5); valid iff the ledger actually holds that fact
(`t:"invoke", outcome:"ok", correlationId = intent` [pinned in S1:
forged/foreign/unbacked xacts are refused by
`completion without ledger-backed evidence is refused`]). Evidence is
*discharge material* for contract obligations (§3), not proof about the
world.

**AttentionRequest** (§6) — a first-class request for a human or
higher-principal resource: subject, scope, requester, resolver,
expiry, consumption terms, transferability. Approval *grants* are
ledger facts, like any other.

### The two graphs — OT-1

- **Delegation graph** `D`: nodes = intents; edges = `fork` (same
  owner), `delegate` (child on another principal, ownership retained),
  `handoff` (ownership moves, §5). Each child edge is a *parentage*
  edge carrying a *join policy* (§4) — two relations, one edge.
  `D` answers *who owes whom what*.
- **Derivation graph** `A`: nodes = capability tokens; edges =
  substrate mint/attenuation. `A` answers *what can reach what*.

```
OT-1  D and A are typed separately. Two cross-graph operations are
      lawful, both journaled:
        creation    — A-tokens are minted only by fresh consent
                      (grantFor: an act of the granter that installs an
                      attenuated child (A) named in an intent's
                      envelope (D-context));
        destruction — a D-transition (revoke cascade, race cancel,
                      handoff) may — and must — revoke A-tokens.
      The forbidden direction is exact: NO D-transition may CREATE or
      RETARGET authority without fresh consent; A-edges never create or
      move ownership.
OT-2  Handoff (a D-edge move) performs no A-move except destruction:
      the envelope is revoked and re-entry requires fresh consent.
      [pinned: handoff MOVES the intent but never the authority]
```

`D ⊥ A` is the exact sense of *ownership is not authority*: the graphs
are typed separately enough that a change in one must be an explicit,
audited act in the other.

---

## 2. The intent state machine (§ST)

States: `OPEN, ACTIVE, SUSPENDED, WAITING_APPROVAL, WAITING_RESOURCE,
COMPLETING, COMPLETED, FAILED, REVOKED, CANCELLED`.
Terminal: `COMPLETED, FAILED, REVOKED, CANCELLED`.

| from → to | trigger | guard / journal |
|---|---|---|
| OPEN → ACTIVE | the first act that clears every layer guard AND is an attempt (a dispatched call, a minted grant) activates, with that act as the journaled cause; promises (amend), admission facts (approve) and ownership moves (handoff) leave OPEN untouched — a guard-refused attempt changes no lifecycle | `intent_open` genesis; activation edge `intent_state {open→active, cause}`; first mediated attempt is charged-attempt [pinned] |
| OPEN → WAITING_APPROVAL | admitted with an unresolved required AttentionRequest — no detour through ACTIVE | `attention_open` at open [planned; S1's boolean gate is the degenerate case] |
| OPEN → WAITING_RESOURCE | admitted with an unmet resource precondition | `waiting_resource` [planned; S1 denies `E_BUDGET` at attempt time] |
| ACTIVE → SUSPENDED | owner/host suspend | `intent_suspend` [pinned] |
| SUSPENDED → ACTIVE | resume, **optionally rebinding the model** | `agent_rebind` — identity, context, envelope state survive; the "CPU" does not [pinned] |
| ACTIVE → WAITING_APPROVAL | contract requires an unresolved AttentionRequest | `attention_open`; calls effect nothing [pinned for the boolean gate; state split planned] |
| WAITING_APPROVAL → ACTIVE | attention resolved **grant** (scope-bound, epoch-bound) | `intent_approve` [pinned for scope-in-ledger; expiry/consumption planned] |
| WAITING_APPROVAL → FAILED | attention denied or expired | planned |
| ACTIVE → WAITING_RESOURCE | budget/backpressure park instead of deny | planned (S1 denies `E_BUDGET` — charged-attempt [pinned]) |
| WAITING_RESOURCE → ACTIVE | resource re-acquired | planned |
| ACTIVE → COMPLETING | `complete(claims)` — an entry into a CHECK, not a setter | `completion_check` begins |
| COMPLETING → COMPLETED | §3 + §4 checks all pass | `intent_complete` |
| COMPLETING → ACTIVE | any check fails; intent stays claimable | `completion_denied` (with failed-obligation ids) |
| non-terminal → REVOKED | revoke of this or any ancestor (cascade down `D`) | envelope caps revoked in `A` [pinned] |
| non-terminal → FAILED | owner abandons after real effects, or deadline policy | `intent_fail` [pinned: deadline journaled at intent level] |
| non-terminal → CANCELLED | two causes, both ledger-defined: **withdrawal** — no effect-dispatch fact (no `intent_call` with non-null `xact`) at any epoch; effects dispatched ⇒ FAILED, not CANCELLED; or **policy cancel** — e.g. `race_lost` (DC-3), where dispatched effects may exist and must still settle | distinct terminal: audit keeps withdrawal/cancellation ≠ failure; every predicate is a fact lookup, never a world judgment |

```
ST-1  COMPLETING is a verification state: entry executes the §3/§4
      checks; no transition to COMPLETED bypasses it.
ST-2  Every state edge is a journaled fact in one normalized shape:
        { intent, fromState, toState, stateVersion, cause }
      with two replay invariants: next.stateVersion = current + 1, and
      event.fromState must equal the replayed current state. Ledger
      replay therefore yields exactly one legal path per intent —
      duplicate or out-of-order events are refusable facts, not
      ambiguity. This is the primitive in the purest sense: *state is
      derived from facts, not mutable truth*. [pinned in S2.1: `ledger
      replay reconstructs each intent's path` (the journal alone
      reproduces every intent's final state and version), `OPEN is
      genesis, not a side effect` (genesis is version 0, fromState null,
      and activation is an EDGE with a named cause — no silent
      open→active), `illegal edges move nothing and are refusable facts`
      (a rejected transition journals intent_transition_denied and leaves
      state/version untouched), `admission, not ambition, activates
      OPEN` (S2.1a: calls refused by the envelope/approval/budget/binding
      guards, and refused completions, leave the intent at genesis v0
      with no activation edge), `one ledger defines one intent` (S2.1a:
      a second AgentSystem touching the record is refused E_FOREIGN
      before it can journal anything — replay is only meaningful if the
      ledger that brands the record is the only one that writes it)]
ST-3  Lifecycle state is private to the model layer; principals get
      read-only views. The private set is EVERY field a check, gate or
      cascade reads:
        relations      agent, parent, children
        configuration  goal, budget, deadline, approval, context
        determinable   state, stateVersion, contract, contractRevision,
        state          ownerEpoch, envelope, evidence, spent
        identity       id, openedAt
      plus the OWNERSHIP BRAND: the record names the AgentSystem that
      minted it, and only that system may reach it — PRIV reachability
      without the brand lets a second system drive the same record while
      journalling into a different ledger, which would make ST-2's
      replay claim false for the ledger that actually owns the intent.
      Anything less lets a caller mutate the very things the checks
      read (`approval = "not_required"` walks past the approval gate,
      `budget = null` walks past charging, `children.clear()` escapes
      the revoke cascade, `agent = …` is a handoff with no envelope
      kill, no epoch++, no fact), and "frozen/append-only" remains an
      API convention, not a property. Views out are TRUE snapshots:
      deep-copy THEN deep-freeze — freeze-only paths freeze the
      record's own nested objects through shared references, which is
      unwritable but not a snapshot. Capability tokens are the declared
      exception: opaque handles keep reference identity. The write path
      is singular: exactly one lifecycle writer exists, and the source
      is checkable for that. And the boundary is TRANSITIVE: locking
      the declared fields is not enough — it must hold over the whole
      reachable object graph. `intent.agent` is an inert AgentPrincipal
      VIEW (OT-0's `Identity is not execution`, applied to the API
      surface: the execution handle, the system back-reference and the
      intent registry are not properties of the view, and the brand
      check reads the private RECORD, so view-tampering can never forge
      membership); `intent.context` is a ContextVersion stream — the
      holder sees immutable versioned snapshots, belief change is an
      owned act journalled as `context_version`; every view instance
      (Intent, AgentPrincipal, ContextView) is frozen at construction,
      so no property can be bolted onto it, and no two-hop reference
      path from a token reaches a mutable authority-bearing object.
      And the boundary is BIDIRECTIONAL (S2.1c): no mutable aliases
      out, no caller-owned aliases IN. Authoritative state and ledger
      events hold APM-owned values, never input references: ingress
      clones (goal/budget/approval/context/obligations are deep-copied
      into the record at the door), facts are deep-owned before
      `record` (provenance does not clone events, so an aliased event
      content could be rewritten AFTER hashing — that edits history,
      not just state), and identity-ish inputs are narrowed to
      immutable forms: label is a string, model is null | string
      (a structured ModelBinding gets its own object when it lands),
      deadline is null | finite number. And the boundary covers the
      BEHAVIOR surface (S2.1d): a frozen instance on a mutable
      prototype is a locked door in an unlockable wall — class getters
      are configurable by default, so redefining one on a view's
      prototype rewrites what every read of that view returns. View
      prototypes (Intent, AgentPrincipal, ContextView) are therefore
      frozen, and authoritative identity is RECORD data: internal code
      resolves ids through the records, never through a presentation
      getter, so even a hypothetical getter rewrite could not
      misattribute a fact. The public getters are presentation only.
      And the state LANGUAGE is a frozen JSON-safe plain-data domain
      (S2.2a, closed by S2.2b): "JSON-safe" is NOT "JSON.stringify
      does not throw" — it is that distinct admitted values keep
      distinct representations in the provenance hash. The admitted
      domain, exactly:
        scalar   null | boolean | finite number | string, where -0 is
                 admitted and normalized to 0 on ingress (JSON
                 collapses the two, so a ledger that stored both would
                 bind two beliefs to one hash)
        array    DENSE: own indices exactly 0..length-1, data elements
                 only, no holes, no named extras, no symbol keys
        object   own enumerable STRING-keyed DATA properties only, on
                 a plain (or null) prototype — no accessors, no
                 symbols, no non-enumerables
        refused  undefined | bigint | NaN | Infinity | function |
                 symbol | Date | Map | Set | typed arrays | class
                 instances | cycles
      The domain is defined independently of any copier — "cloneable"
      is NOT "representable": structuredClone accepts a Map, and under
      JSON-shaped hashing the Map serializes to `{}` while a sparse
      `[hole]` and `[null]` serialize identically and a symbol-keyed
      property simply disappears. Silent dropping is therefore not a
      sanctioned response anywhere inside authoritative state: what
      cannot be represented is REFUSED (E_DOMAIN) before any write,
      and the copier never uses `map()` or plain property assignment,
      both of which are execution paths (`map` reads elements, so an
      accessor element fires; `out["__proto__"] = v` routes through the
      prototype SETTER instead of creating a data property). Clones
      build fresh objects through `defineProperty`, so a JSON-parsed
      `"__proto__"` data property stays data.
      The FACT path admits exactly two categories (S2.2b), because
      recursively introspecting a hostile same-realm object safely is
      not possible and an honest spec must not pretend otherwise:
        owned    a value the system built itself (from domain-validated
                 content) is copied in full, recursively — nothing an
                 attacker controls is ever touched;
        raw      anything else is inspected BY DESCRIPTOR ONLY — no
                 element read, no iteration, no `String(v)`, no getter,
                 no conversion — and the moment the inspection cannot
                 certify the branch (accessor, symbol key, hole, named
                 array extra, exotic prototype, or a trap that throws),
                 the WHOLE branch is refused to the fixed marker
                 `{$untrusted: true}`. Out-of-domain leaves at a scalar
                 position become `{$notInDomain: <tag>}`.
      Fact integrity outranks content preservation: a hostile payload
      decides its own opacity, never the ledger's completeness. Fields
      a refusal fact must carry (`xact`, `obligation`) are extracted
      from own DATA DESCRIPTORS, so a `get xact() { throw }` cannot
      preempt the denial of its own claim. The honest limit is stated
      rather than papered over: touching a Proxy can fire its traps —
      `getPrototypeOf` and `getOwnPropertyDescriptor` are not free in
      this realm — so a hostile payload may EXECUTE while being
      refused, but the accounting path wraps that inspection so it
      still cannot SUPPRESS the fact. Closing this last blind spot is
      Track E's job, not Track S's vocabulary. Ingress refuses
      (E_DOMAIN) before any write; records are built by a same-realm
      structural copier, so exotic-realm artifacts never sit under the
      plain check either. In full, the boundary is: private state +
      branded ownership + no aliases out + no aliases in + immutable
      behavior surface + one JSON-safe value domain whose admitted
      values stay distinct under the hash.
      [pinned in S2.1a + S2.1b +
      S2.1c + S2.1d: `every determinable
      field is read-only from the token`, `relations and configuration
      are decision-relevant too` (assignment to any of agent/parent/
      children/goal/budget/deadline/approval/context/id/openedAt is a
      TypeError, and the approval gate the tamper aimed at still gates),
      `the revoke cascade walks the PRIVATE children set`, ``intent.agent
      = …` is not a handoff`, `snapshots out are frozen`, `views are
      TRUE snapshots` (nested references differ per read — clone, not
      freeze-through), `the source itself proves a single lifecycle
      writer`, `the agent view leaks no control plane` (from
      `intent.agent` there is no property path to the substrate handle
      or the Runtime), `the agent brand is itself unforgeable` (the
      attack lands on `.sys`/`.control` themselves, not just on a
      foreign object), `context is a ContextVersion stream`,
      `transitive read-only walk`, `S2.1c ingress: register owns its
      inputs`, `S2.1c ingress: mutating the caller's goal after open
      cannot rewrite hashed history` (the flagship: verifyJournal()
      survives tampering with the input graph), `S2.1c ingress: even a
      DENIED claim's object cannot stay aliased inside the ledger`,
      `S2.1c ingress: approval scopes and model rebinds are owned
      values`, `the view prototypes are frozen`,
      `an attempted prototype-id spoof cannot misattribute a
      transition` (private truth, ledger attribution and replay stay
      in agreement even when the presentation getter is attacked),
      `S2.2a domain: Map/bigint/cycle/function/accessor/undefined/
      class-instance cannot enter authoritative state; refusals change
      no truth and no ledger` (refused opens journal no genesis fact;
      the ledger does not grow during refusals at all), `S2.2a
      sanitization: a hostile toString cannot suppress a denial fact`
      (the refusal lands with its xact/obligation extracted from data
      descriptors and the accessor-bearing payload branch-refused
      whole to `{$untrusted}`; pre-fix the conversion threw and the
      audit trail vanished), `S2.2a
      sanitization: out-of-domain fact payloads become fixed markers`,
      `S2.2a context: current() hands out a DETACHED ContextVersion`
      (v3 stays v3 while the head walks to v5), `S2.2b fact integrity:
      an accessor-array or throwing-Proxy reason cannot make
      intent_fail vanish` (pre-fix the sanitizer's own `v.map()` fired
      the accessor INSIDE the accounting path — the transition landed
      and the fact did not), `S2.2b fact integrity: a claim whose xact
      getter throws cannot preempt completion_denied`, `S2.2b domain
      edges: holes/-0/symbols/extra array props/__proto__ are refused
      or normalized, never silently collapsed` (`[hole]` refused while
      `[null]` admitted; a JSON-parsed `__proto__` stays an own data
      property through clone AND fact; -0 records as 0), `S2.2b gate
      integrity: a hostile `for:` list denies by descriptor — no
      getter runs, no dispatch, no charge`]
ST-4  Intent transition serial order: effect dispatch, handoff, revoke
      (including each cascade leg), approval consumption,
      amend/supersede, and every lifecycle edge on one intent are
      linearized in the journal. Each dispatch is stamped with the
      (ownerEpoch, contractRevision) of its position in that order, so
      "did the call or the handoff come first" always has a ledger
      answer — no edge races the order. The mechanism (mutex, queue,
      single-writer actor) is Track E's choice; the total order itself
      is Track S's claim. [planned]
```

S1 mapping: S1's `open/active/suspended/completed/revoked/failed` are
the pinned rows; `WAITING_*` (both directions), `COMPLETING`,
`CANCELLED` and the OPEN-initial waiting edges are new.

---

## 3. Completion obligation (§CO) — contracts, not vibes

The trap avoided: **the substrate never judges whether a natural-
language goal is "really" done.** What it can guarantee is far weaker
in metaphysics and far stronger in audit:

```
CO-1  Every intent carries a CompletionContract, frozen at creation
      (open/fork/delegate). After creation the obligation set grows
      ONLY through an explicit, journaled `contract_amend` — which is
      APPEND-ONLY: it may add obligations but can never remove or
      weaken one. Retiring an obligation is a different act with its
      own name: `contract_supersede(oldId → newId)` or
      `waiver(oldId)`, each journaled and each itself gated by whatever
      the contract names (default: an approval obligation — erasing a
      requirement is a decision someone must own). Amend/supersede
      bumps `contractRevision` and reopens COMPLETING checks for
      previously satisfied obligations. [pinned in S2.1: `append-only
      amend — work done before an obligation is born can never pay for
      it` + `snapshots out are frozen` (the array is no longer publicly
      reachable — pop/push/field-writes are TypeErrors against frozen
      views, so bypassing amend is not futile-but-possible, it is
      impossible; ST-3's privatization is what converted "frozen" from
      convention to property). supersede/waiver themselves remain
      planned (§8 item 5) — the freeze property holds with them absent,
      because there is NO removal path at all]
CO-2  The contract is a finite set of obligations, each:
        { id, kind, matcher, minOccurrences, bornRevision }
      where `bornRevision` is the contractRevision at which the
      obligation entered the contract. A non-null `matcher` is
      REFUSED at construction until matcher semantics land (S2.1) —
      a policy field that silently evaluates to nothing is a poisoned
      oracle in waiting; refusing is the honest default.
      Machine-checkable kinds only:
        receipt   — ≥ minOccurrences ledger-backed ok calls whose
                    dispatch binding names this obligation id (CO-5)
        approval  — ≥ minOccurrences grant facts for this intent ∩
                    epoch ∩ scope
        closure   — graph condition, delegated to §4
        context   — ≥ minOccurrences accepted merges from a named
                    child lineage
CO-3  complete(claims) succeeds (COMPLETING → COMPLETED) iff every
      obligation has ≥ minOccurrences VALID discharges and §4 closure
      holds. A claim is valid iff (a) the xact is a journaled ok
      invoke correlated to this intent [pinned in S1 as the
      single-obligation degenerate case], (b) the ledger's dispatch
      binding for that xact names the claimed obligation id — the
      claim SELECTS a binding, it never creates one (CO-5), (c) the
      epoch/revision rules HO-4 (§5) admit it.
CO-4  The contract is the boundary of the promise: Agamen guarantees
      "every pre-declared obligation has traceable discharge"; it
      guarantees NOTHING about whether the discharge means the world
      is in the desired state. That is the exact content of
      *evidence is not correctness*.
CO-5  Obligation binding precedes the effect. Dispatch is three
      ordered phases:
        admission/policy phase   (rights, deadline, clone, membranes —
                                  a charged rate-limit attempt happens
                                  HERE, before the dispatch is admitted)
        ↓
        CO-5 dispatch linearization point (xact exists and is final;
                                  the binding fact is journalled)
        ↓
        effect-bearing handler   (nothing the ENDPOINT does can begin
                                  until the ledger already carries the
                                  binding)
      The binding is journalled at the middle phase — the substrate's
      host-plane admit hook is the one sound place; "written after
      request() returns" is NOT dispatch-time — a synchronous effect
      would already have happened. Precisely: the guarantee is that the
      binding precedes HANDLER execution, not that it precedes every
      admission/policy side effect; policy must finish admitting before
      a dispatch can be honoured with a binding. The dispatch fact of
      an effect-bearing call carries
        { intent, ownerEpoch, contractRevision, obligationIds, xact }
      — the obligations the call was made FOR, in the ledger before
      the handler's work begins, let alone is observed. Completion may
      only consume bindings the ledger recorded at dispatch;
      re-labelling an anonymous past call at completion time is
      structurally impossible, because no completion-time act can write
      a dispatch-time fact. Without this rule the contract has no
      teeth: any successful call could be renamed into any receipt
      later. [pinned in S2.1: `the binding is in the ledger WHILE the
      handler runs`, `a success bound to A can never be re-labelled
      into obligation B`, `an anonymous success cannot be renamed into
      a receipt at completion`, `binding an unknown obligation is
      refused BEFORE the effect dispatches`]
```

`goal: "book trip"` with obligations
`[flight_booking_receipt, hotel_booking_receipt, child_intents_closed,
required_approval_consumed]` becomes checkable without Agamen ever
reading "book trip".

---

## 4. Delegation closure (§DC)

`D` is an execution structure, not a parent-pointer diary — and it
carries **two relations**, kept separate (S2.0.1 named the conflation
apart):

- a **parentage edge**: lineage, provenance, the revoke cascade,
  accountability. Every child has exactly one; it is never optional.
- a **join policy** on that edge: whether and how the parent's
  *completion* waits on the child.

```
DC-1  required  — parent may not enter COMPLETED while the child is
        non-terminal; child FAILED makes the closure obligation
        UNSATISFIABLE. The parent may then FAIL, be REVOKED, or carry
        an explicit journaled supersede/waiver for that closure term
        (CO-1). Append-only amend can never make a dead requirement
        vanish silently — that is the point of the split.
DC-2  optional  — contributes when closed; never blocks.
DC-3  race      — first COMPLETED child satisfies the group. Losers
        go to CANCELLED(reason=race_lost), NOT REVOKED — losing a race
        is not a security withdrawal — and their envelopes are
        revoked. The same principle as handoff applies verbatim:
        **race cancellation revokes future authority, not past or
        in-flight effects** — losers' dispatched effects, pending
        handlers and late receipts all settle into the ledger (ST-4,
        HO-2) and stay admissible history.
DC-4  detached  — parentage edge = YES; join policy = detached.
        Completion never waits; the revoke cascade and provenance
        still flow down. ("No closure edge but inside the cascade"
        was the conflation talking; with the two relations split,
        detached is just a policy, not a missing edge.)
DC-5  Default policy is required. SILENT parent completion over live
        required children is a spec violation — S1 today permits
        exactly that, and S2.1's first test must be the negative one:
        complete(parent with open required child) → completion_denied.
DC-6  Closure is evaluated in COMPLETING against the D-subtree;
        the evaluation itself is a journaled fact (the obligation kind
        `closure`, CO-2).
```

---

## 5. Handoff, the ownership epoch, and the contract revision (§HO)

Each intent carries **two independent monotonic counters**:
`ownerEpoch` (increments on handoff) and `contractRevision` (increments
on amend/supersede, CO-1). Every effect-bearing dispatch is stamped
with both, at its point in the ST-4 serial order. A single epoch is not
enough to order obligations against work: a contract can grow *within*
one owner's tenure.

```
HO-1  handoff: envelope revoked [pinned], epoch++ [pinned in S2.1:
        the handoff test asserts ownerEpoch], new owner starts
        with ZERO authority; re-entry only via grantFor (OT-1's lawful
        creation bridge).
HO-2  In-flight calls (dispatched at epoch e, settling after a
        handoff to e+1) settle honestly: their substrate effects
        happened; they are journaled under the (epoch, revision)
        stamped at dispatch — which the serial order (ST-4) fixes
        unambiguously even when dispatch and handoff race. Delivery
        is to the dispatching principal's controller, never
        re-pointed — mirrors the substrate's "cancellation cancels
        delivery, not side effects".
HO-3  Late receipts from epoch e < current MAY enter the evidence
        list as history (marked stale-epoch).
HO-4  Discharge admission: a receipt stamped (epoch e, revision r)
        may discharge only obligations whose contract entry existed at
        an epoch ≤ e AND whose bornRevision ≤ r (CO-2) — you cannot
        pay for a promise made after the work, whether the contract
        grew under a later owner or under the SAME owner after the
        call. Receipts NEVER confer authority and never satisfy
        approvals/attention granted under another epoch.
        [pinned in S2.1: `append-only amend — work done before an
        obligation is born can never pay for it`, `HO-4 across
        handoff: old-epoch receipts pay only for old-epoch promises`]
HO-5  An approval grant is bound to (intent, epoch, scope): a
        handoff invalidates unconsumed grants; the human's yes was
        about *that* principal doing *that* work.
```

HO-3/HO-4 together are the deliberate answer to "may old-epoch work
count?": **yes as record, no as authorization** — history transfers
freely, authority never does.

---

## 6. Approval and attention (§AT) — a resource, not a flag

```
AT-1  Approval is modelled as an AttentionRequest object
        { subject, scope, requester(intent,epoch), resolver,
          expires, consumes, transferable, reusable }
      — NOT as a capability lease. What enforces it is a Track E
      question (M2), asked only after this object is stable.
AT-2  A grant resolves to a journal fact binding (intent, epoch,
      scope) [pinned: scope lands in ledger; epoch binding planned];
      a denial or expiry is a terminal-capable event (§2).
AT-3  consumes: attention is budgeted like compute — a resolver
      grant may burn attention quota; spent attention is ledgered.
AT-4  transferable: an intent may forward an unresolved request
      upward; a transferred request keeps its subject, gains a
      lineage edge. reusable=false by default: one-shot yes.
AT-5  WAITING_APPROVAL is the explicit blocked state; the boolean
      gate of S1 (calls denied E_APPROVAL [pinned]) is its degenerate
      one-obligation case.
```

The M2 question, correctly ordered: *which enforcement primitive best
implements this already-stable semantic object* — lease, mint, or
kernel-visible grant — decided by the charter, not by taste.

---

## 7. Relation to the substrate and to agate

APM is Track S: it defines semantics, not enforcement, and until now it
has landed every rule on existing primitives (WeakMap authority, consent
grants, correlationIds, the journal) or on new *facts*, never on new
authority. That streak ended, instructively, at CO-5: binding-before-
effect demanded a linearization point between "dispatch admitted" and
"handler executing" that the substrate did not have — a fact written
after `request()` returns follows the synchronous effect it promised to
precede. So Track E added one minimal mechanism, the host-plane admit
hook (`request(…, { onAdmit })`), and this is recorded as the first true
cross-track dependency:

```
DEP-1  S: CO-5 binding-before-effect
         → requires →
       E: a pre-handler admission linearization point (admit hook)
```

Two tracks not mixing does NOT mean the two never interact: the
interaction law is directional — semantics state an obligation, and
enforcement supplies the minimal mechanism that makes it keepable.
DEP-1 is the template, not the exception to worry about; what would
corrupt both tracks is S diluting an obligation to whatever is
currently enforceable, or E growing a mechanism no S rule asked for.
Invariant references: states ↔ #9; evidence/facts ↔ #10; envelope ⊥
ownership ↔ #1, #2, #3, #6; contract immutability ↔ #11 in its "output
may request, never widen" form.

The Linux-library test (ROADMAP), stated honestly: ST-2 alone proves
nothing — an ordinary async library can append events, hash-chain
them, carry correlation ids, and replay a state machine. ST-2 is
*necessary semantics* for a candidate primitive, not a sufficient
OS claim. The conjunction that must face the test is: lifecycle state
derived from a tamper-evident ledger (ST-2) + authority living only in
a separate, substrate-bound graph that state transitions can never
mint (OT-1) + principals unable to observe or write each other's
state (ST-3) + cancellation/handoff that settle effects, not
intentions (ST-4, HO-2) + evidence durable and checkable across
principals (CO-5). Whether a library can hold that conjunction under
the *target threat model* — a hostile caller in the same realm — is
precisely the open question Track E must answer; until it does,
Agamen claims an operating model, and reserves the primitive verdict
on the combination. The spec does not pre-decide its own conclusion.

## 8. Conformance work

**S2.0.1 (spec closure, landed 2026-09-19 — spec only, no code)** —
the six pins from the spec review, in their landed form:
dispatch-time obligation binding (CO-5); `contractRevision` beside
`ownerEpoch`, obligations carry `bornRevision` (CO-1/2, HO-4); the
per-intent serial order (ST-4); the D-graph relation split
parentage/join-policy (DC-4) with race losers `CANCELLED(reason)`
(DC-3); normalized replay events `from/to/stateVersion/cause` (ST-2);
and the demoted, honest Linux-library test (§7).

**S2.0.2 (round-6 honesty patch, landed 2026-09-19 — spec + docs only,
no code)** — CO-5 restated as the three-phase order (admission/policy →
dispatch linearization point → effect-bearing handler), retiring the
"before anything it does" overclaim; §7 rewritten to record **DEP-1**,
the first true S→E dependency (CO-5 required the substrate's admit
hook), replacing the "adds zero substrate mechanisms" line.

**S2.0.3 (label sync after the ST-3/ST-2 slice landed, 2026-09-19)** —
no new rules: ST-2, ST-3 and (consequently) CO-1 move from
planned/partial to [pinned] with their test names; §8 item 1 is struck.
ST-4 gains nothing from this slice and says so.

**S2.0.4 (round-7 trusted-state closure, landed 2026-09-19 — code slice
S2.1a)** — the review of 0a002d8 found S2.0.3's pins overstated:
privatizing eight fields while `approval/budget/deadline/goal/agent/
parent/children` stayed public left working bypasses (the approval gate,
the budget gate, the revoke cascade, a fake in-place handoff), and the
module-wide PRIV had no ownership brand (a foreign AgentSystem could
drive an intent's state and journal into the wrong ledger, voiding
replay). Landed with this rev: full-field privatization + brand +
`#R` single checked accessor; clone-then-freeze snapshots (replacing
shallow-spread + freezeDeep, which froze the record's own nested
objects); and admission-gated OPEN activation. The round-7 review also
recorded a DEFERRED gap rather than a quick patch: a FAILED completion
on the legacy (empty-contract) path may still leave candidate evidence
in the record — the working-set commit rule lands with the COMPLETING
skeleton (item 2); the contract branch already follows it.

**S2.0.5 (round-8 principal/context closure, landed 2026-09-19 — code
slice S2.1b)** — the review of a0a97b9 accepted ST-2 but found ST-3's
read-only view still leaked mutable truth through REFERENCES:
`intent.agent` handed out the writable host-plane AgentExecution
(model/id/control writes bypassed their owned journalled paths,
`intents.clear()` rewrote history, and `agent.sys.rt` gave any token
holder the trusted control plane outright — branding also read the
public-writable `agent.sys`, so membership was forgeable), and the
context getter returned the live mutable Context, contradicting §1's
own ContextVersion definition. Landed: the agent becomes a branded
private record behind an inert frozen AgentPrincipal view, with brand
checks reading the record; Context splits into private head + immutable
versioned view, mutation only via owned `mutateContext`/`mergeContext`
journalling `context_version {intent, fromVersion, toVersion, cause}`;
Intent tokens are frozen instances. The lesson is recorded as ST-3's
transitivity clause: a safety boundary over mutable authoritative state
must hold over the whole reachable object graph, not merely over the
declared fields. The substrate is untouched, CO-5's binding shape is
unchanged, and ST-4 is still not claimed. This closes the trusted-state
work — the next code slice is the COMPLETING skeleton (item 2).

**S2.0.6 (round-9 ingress ownership closure, landed 2026-09-19 — code
slice S2.1c)** — the review of f754eba approved the AgentPrincipal and
context-write closures but found the third edge of the boundary open:
S2.1b sealed mutable references from leaking OUT; nothing stopped
caller-owned references from leaking IN. `register` stored the caller's
`model`/`label` objects by reference (so `agent.model.cfg.mode = …`
mutated the private record with no rebind act — and the caller needed
no getter: mutating the original object after `register`/`open` hit the
record directly), and facts passed input references into `rt.record()`,
which does not clone: mutating the input graph after `open` rewrote
event content AFTER it had been hashed, breaking `verifyJournal()` —
a token holder editing authoritative history. Landed: ingress
clone-normalization into every record; `#fact` deep-owns each event
before the ledger (non-cloneable payloads degrade to String, never to a
live alias); `agent_register` routed through `#fact`; `intent_open`
composed from the private record; label/model/deadline narrowed to
immutable identity (string / null|string / null|finite number —
structured forms are §8 work, not silent aliases). The recorded
principle: AUTHORITATIVE-STATE ISOLATION IS BIDIRECTIONAL — no mutable
aliases out, no caller-owned aliases in; round 8 closed the outward
reachable graph, this closes the inward aliasing graph, and only the
two together make an ownership boundary. The round-9 MAJORs (live
ContextView vs immutable ContextVersion values; freezeDeep's false
immutability over Map/Set) are recorded as COMPLETING pre-works in
item 2 — the `context` obligation must not land on either shortcut.
Still: substrate untouched, CO-5 shape unchanged, ST-4 unclaimed.

**S2.0.7 (round-10 prototype closure, landed 2026-09-20 — code slice
S2.1d)** — the review of 1f93ffe approved S2.1c but named the last
JS-specific hole in ST-3's reachable graph: the PROTOTYPE CHAIN.
`Object.freeze(instance)` leaves `Object.getPrototypeOf(instance)`
mutable, and class getters are configurable — so same-realm code could
redefine `Intent.prototype.id` to return a ghost. Branding still
authenticated the true record (real state moved correctly) but facts
written through the presentation getter attributed the edge to the
ghost: private truth FAILED while replay(originalId) stuck at OPEN —
ST-2's core claim severed through the behavior surface, not any field.
Landed, both layers as directed: (1) authoritative identity is RECORD
data (intent id, principal id resolved via PRIV/AGENT_PRIV everywhere
internally — the public getters are presentation only, and a getter
rewrite now misattributes nothing because nothing internal reads
through it); (2) Intent/AgentPrincipal/ContextView prototypes frozen —
the read-only view now includes its own behavior. Pinned by
`the view prototypes are frozen` and the teeth-carrying
`an attempted prototype-id spoof cannot misattribute a transition`
(fails against 1f93ffe exactly where predicted: the spoof lands
silently). The review also fixed the COMPLETING order — plain-data
domain → ContextVersion values → four obligation kinds — now recorded
in item 2 with its reason (JSON-shaped provenance hashing already
binds exotic values like two different Maps to the same bytes). With
this, the trusted-state closure is declared FINISHED: the next slice
is COMPLETING, unconditionally.

**S2.0.8 (round-11 COMPLETING floor, landed 2026-09-20 — code slice
S2.2a)** — the review of 7073c21 SIGNED the trusted-state closure
("APPROVE ST-2 + ST-3") and directed the first COMPLETING steps without
another closure round. Landed, in the nailed order: (a) the JSON-safe
plain-data domain is now the normative value language of ST-3 —
defined against provenance's JSON-shaped hashing, not against
structuredClone, because "cloneable" and "representable" only coincide
by luck; ingress refuses exotic values (E_DOMAIN) before any write,
and the fact path sanitizes structurally. The round-11 MAJOR died with
it: `ownValue`'s `String(v)` fallback EXECUTED attacker code
(malicious `toString` / `Symbol.toPrimitive`, and a clone that merely
READS a throwing getter) and could make a denial fact vanish mid-
refusal; facts are now rebuilt from own data descriptors with fixed
`{$notInDomain, tag}` markers — the conversion is never the value's
job. (b) `context.current()` returns the detached ContextVersion
VALUE (`{version, snapshot, lineageRef}`), closing the round-9 MAJOR
that a context obligation would otherwise have bound to a live cursor.
One implementation note the domain made necessary: authoritative
ingress clones with a same-realm structural copier, not
`structuredClone`, because a host-realm clone is precisely the
realm-mismatched artifact the plain check refuses. This was still
trusted-state work — the COMPLETING machinery proper (ST-1 check
state, four obligation kinds, matcher, DC-5) is the next slice;
substrate untouched, no new DEP, ST-4 unclaimed.

**S2.0.9 (round-12 domain closure, landed 2026-09-20 — code slice
S2.2b)** — the review of 86dd49b SIGNED the detached ContextVersion and
the working-set commit rule but REVISED the value language: two
BLOCKERs showed S2.2a had named the right standard and then missed it
in both directions. (1) The sanitizer was itself an execution path. Its
array branch called `v.map(...)`, which READS elements — an accessor
element fired attacker code inside `#fact`, so `sys.fail(intent,
accessorArray)` completed the transition and then lost the
`intent_fail` fact: precisely the vanishing-audit-trail bug the slice
claimed to have killed. The same shape lived in `const { xact } =
claim`, which a `get xact() { throw }` could preempt before
`completion_denied` was written, and the absolute claim that "no
attacker-controlled code ever executes on the fact path" was
unsupportable anyway, since `getPrototypeOf`/`getOwnPropertyDescriptors`
fire Proxy traps. (2) The domain was not closed under distinctness:
sparse `[,null]`-family arrays, sparse vs dense, `-0` vs `0`,
symbol-keyed properties, named extras hanging off an array and the
`__proto__` key (which plain assignment routes through the prototype
SETTER) all either collapsed to one JSON binding or were silently
dropped. Landed, and deliberately NOT a universal safe sanitizer —
recursively introspecting a hostile same-realm object safely is
impossible, and the spec now says so instead of pretending: the fact
path admits two categories (owned values copied in full with nothing
attacker-controlled ever touched; raw payloads inspected by descriptor
only and branch-refused whole to `{$untrusted: true}` the moment
anything fails certification), refusal fields come from DATA
DESCRIPTORS, and the inspection is wrapped so a throwing trap can make
a payload opaque but never a fact absent. The domain is nailed to the
scalar/dense-array/plain-object form above, `-0` normalizes on ingress,
and clones use `defineProperty` and index assignment rather than
`map()` or `out[k] =`. Four teeth pin it, including the reviewer's two:
`S2.2b fact integrity: an accessor-array or throwing-Proxy reason
cannot make intent_fail vanish` (against 86dd49b the getter fires
inside `Array.map` exactly as predicted) and `S2.2b domain edges`
(`[hole]` and `[null]` can no longer both be admitted). The value floor
is now signed as stable, so COMPLETING machinery proper — ST-1 check
state, the four obligation kinds, matcher semantics, DC-5 — is next
with no further closure round in front of it. Substrate untouched, no
new DEP, ST-4 unclaimed.

**S2.1 (next code, in this order — reordered after round-5 review so no
check ever runs against mutable truth)**

1. ~~lifecycle privatization + replay-unique events~~ LANDED (ST-3
   pinned: one private state record behind a setter-less token view;
   ST-2 pinned: genesis and every edge through one transition
   primitive, replay reconstructs each path, illegal edges are refusable
   facts; CO-1 upgraded to [pinned] on the strength of it — ST-4 is
   NOT claimed by this, the total-order-over-dispatch proof is still
   item 6's work);
2. the COMPLETING skeleton complete: ST-1 entry-as-check, all four
   obligation kinds, matcher semantics (CO-2…4) — what remains here is
   the CHECK machinery, the frozen-contract property already holds;
   plus the WORKING-SET COMMIT RULE for candidate evidence (claims are
   verified against a temporary set; `rec.evidence` changes only at
   COMPLETING → COMPLETED; denials mutate no truth — closes the
   round-7 deferred gap on the legacy path; APPLIED EARLY to both
   completion paths by S2.2a — claims validate and domain-own before
   any evidence write; what remains is the explicit COMPLETING
   check-state itself); plus the ROUND-9/10 PRE-WORKS, required because the `context` obligation reads them,
   in this fixed order (round-10: 先冻域，再造值，最后四种 obligation —
   do not reverse it):
   (a) ~~first, the PLAIN-DATA SNAPSHOT DOMAIN~~ LANDED (S2.2a, closed
       by S2.2b) — the domain above; exotic values are refused at the
       APM door, and the fact path admits owned values (copied in
       full) and raw payloads (descriptor-inspected, branch-refused to
       `{$untrusted}`) — with the honest limit stated: a same-realm
       Proxy may still EXECUTE traps while being refused, but it can
       never suppress the fact recording its refusal;
   (b) ~~then immutable per-version ContextVersion VALUES~~ LANDED
       (S2.2a) — `context.current()` hands out a detached
       `{version, snapshot, lineageRef}` value; the completion evidence
       for a `context` obligation binds that value, not a moving view;
   (c) only then the four obligation kinds;
3. closure negative gate first, as a test before the feature (DC-5);
4. ~~dispatch-time binding~~ LANDED (CO-5 pinned by the temporal test;
   written in the substrate's admit hook, refusing matcher included);
5. join policies required/optional/race/detached over the split
   parentage relation (DC-1…4), supersede/waiver for DC-1's escape;
6. epoch/revision stamping + late-receipt admission (HO-2…5);
7. AttentionRequest object + the OPEN-initial waiting edges; then,
   and only then, re-open M2 as "which enforcement shape fits §AT".

Non-goals unchanged: no goal interpretation, no world-state claims, no
model execution, no runtime features smuggled in as "spec plumbing".
