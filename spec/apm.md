# APM — the Agamen Agent Process Model (normative, S2)

> Status: **normative spec, rev. S2.0.1** — it stands on its own;
> `src/intent.js` (S1) is its first, partial implementation. S2.0.1 closed
> the spec-review gaps (§8 lists the six pins). This file inherits the
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
authority.

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
| OPEN → ACTIVE | admission conditions clear at open | `intent_open`; first mediated attempt is charged-attempt [pinned] |
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
      derived from facts, not mutable truth*. [planned: S1 events carry
      no from/to/version yet]
ST-3  Lifecycle state is private to the model layer; principals get
      read-only views. The private set is at minimum:
        state, contract, contractRevision, ownerEpoch, envelope,
        evidence, spent
      — anything less lets a caller mutate the very things the checks
      read (a `contract.pop()` erases an obligation with no fact), and
      "frozen/append-only" remains an API convention, not a property.
      (S1 debt: fields are public — the strong reading of OT's second
      line requires this before it may be claimed. [planned, widened
      in round-5 review; gates CO-1's [pinned]])
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
      previously satisfied obligations. [partial: the append-only amend
      act and revision bump are pinned in S2.1 (`append-only amend —
      work done before an obligation is born can never pay for it`),
      but the obligation ARRAY is still publicly mutable — pop/push/
      field-writes can bypass amend and its fact. "Frozen" is a lie
      until ST-3 privatizes these fields. supersede/waiver planned
      (§8 item 5)]
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
CO-5  Obligation binding precedes the effect — literally. The binding
      is journalled AFTER the xact exists and BEFORE the handler
      executes (the substrate's host-plane admit hook is the one sound
      place; "written after request() returns" is NOT dispatch-time —
      a synchronous effect would already have happened). The dispatch
      fact of an effect-bearing call carries
        { intent, ownerEpoch, contractRevision, obligationIds, xact }
      — the obligations the call was made FOR, in the ledger before
      anything it does can begin, let alone be observed. Completion may
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

APM is Track S: it adds zero substrate mechanisms. Every rule lands on
existing primitives (WeakMap authority, consent grants, correlationIds,
the journal) or on new *facts*, never on new authority. Invariant
references: states ↔ #9; evidence/facts ↔ #10; envelope ⊥ ownership ↔
#1, #2, #3, #6; contract immutability ↔ #11 in its "output may
request, never widen" form.

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

**S2.1 (next code, in this order — reordered after round-5 review so no
check ever runs against mutable truth)**

1. lifecycle privatization (ST-3, widened: state, contract,
   contractRevision, ownerEpoch, envelope, evidence, spent) +
   normalized, replay-unique events (ST-2);
2. the COMPLETING skeleton complete: ST-1 entry-as-check, all four
   obligation kinds, matcher semantics (CO-1…4) — CO-1 may only be
   marked [pinned] when item 1 makes "frozen" a property, not a
   convention;
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
