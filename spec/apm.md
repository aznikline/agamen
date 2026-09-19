# APM — the Agamen Agent Process Model (normative, S2)

> Status: **normative spec** — it stands on its own; `src/intent.js` (S1)
> is its first, partial implementation. This file inherits the vocabulary
> of `spec/invariants.md` and the track definitions of `ROADMAP.md`.
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
`ownerEpoch` (§5), lifecycle state (§2).

**ContextVersion** — immutable belief snapshot; a lineage of
`born / mutate / merge` events; merge is two-headed (absorb records the
contributing intent and accept/reject verdict). Beliefs are data, never
authority.

**AuthorityEnvelope** — the set of capability grants an intent has
earned *at its current owner's slot table*, each derived in the
substrate's capability graph, each optionally membrane-budgeted. The
envelope is the only bridge between the two graphs, and it is a
one-way, consent-gated bridge (§5).

**Evidence** — a claim referring to a ledger fact: at minimum an
internal xact id; valid iff the ledger actually holds that fact
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
  `handoff` (ownership moves, §5). `D` answers *who owes whom what*.
- **Derivation graph** `A`: nodes = capability tokens; edges =
  substrate mint/attenuation. `A` answers *what can reach what*.

```
OT-1  D-edges never move or mint A-tokens; A-edges never create or move
      ownership. The only lawful transition between graphs is
      grantFor: an act of the granter's consent that installs an
      attenuated child (A) named in an intent's envelope (D-context).
OT-2  Handoff (a D-edge move) provably performs NO A-move: the
      envelope is revoked and re-entry requires fresh consent.
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
| OPEN → ACTIVE | begin, or first mediated effect attempt | `intent_call` charged-attempt [pinned] |
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
| non-terminal → CANCELLED | owner-withdrawal that produced no accepted effect | distinct terminal: audit keeps withdrawal ≠ failure |

```
ST-1  COMPLETING is a verification state: entry executes the §3/§4
      checks; no transition to COMPLETED bypasses it.
ST-2  Every state edge is a journaled fact. The state machine is
      reconstructible from the ledger alone (a replay of intent_*
      events yields exactly one legal path per intent).
ST-3  Lifecycle state is private to the model layer; principals get
      read-only views. (S1 debt: fields are public — the strong
      reading of OT's second line requires this before it may be
      claimed. [planned])
```

S1 mapping: S1's `open/active/suspended/completed/revoked/failed` are
the first six rows; `WAITING_*`, `COMPLETING`, `CANCELLED` are new.

---

## 3. Completion obligation (§CO) — contracts, not vibes

The trap avoided: **the substrate never judges whether a natural-
language goal is "really" done.** What it can guarantee is far weaker
in metaphysics and far stronger in audit:

```
CO-1  Every intent carries a CompletionContract, frozen at creation
      (open/fork/delegate; appendable only through an explicit,
      journaled contract_amend — which reopens COMPLETING checks for
      previously satisfied obligations).
CO-2  The contract is a finite set of obligations, each:
        { id, kind, matcher, minOccurrences }
      with machine-checkable kinds only:
        receipt   — ≥ min ledger-backed ok calls whose evidence binds
                    this obligation id (e.g. flight_booking_receipt)
        approval  — ≥ 1 grant fact for this intent ∩ epoch ∩ scope
        closure   — graph condition, delegated to §4
        context   — ≥ 1 accepted merge from a named child lineage
CO-3  complete(claims) succeeds (COMPLETING → COMPLETED) iff every
      obligation has ≥ 1 VALID discharge and §4 closure holds.
      A claim is valid iff (a) the xact is a journaled ok invoke
      correlated to this intent [pinned in S1 as the single-obligation
      degenerate case], (b) the claim explicitly binds an obligation
      id — no cross-serving of obligations by anonymous evidence,
      (c) epoch rule HO-4 (§5) admits it.
CO-4  The contract is the boundary of the promise: Agamen guarantees
      "every pre-declared obligation has traceable discharge"; it
      guarantees NOTHING about whether the discharge means the world
      is in the desired state. That is the exact content of
      *evidence is not correctness*.
```

`goal: "book trip"` with obligations
`[flight_booking_receipt, hotel_booking_receipt, child_intents_closed,
required_approval_consumed]` becomes checkable without Agamen ever
reading "book trip".

---

## 4. Delegation closure (§DC)

`D` is an execution structure, not a parent-pointer diary. Each child
edge carries a join policy:

```
DC-1  required  — parent may not enter COMPLETED while the child is
        non-terminal; child FAILED makes parent's required set
        unsatisfiable (parent must fail, amend, or be revoked).
DC-2  optional  — contributes when closed; never blocks.
DC-3  race      — first COMPLETED child satisfies the group; the
        runtime REVOKE-cascades the remaining racers (authority dies
        down D; results already in the ledger stay).
DC-4  detached  — no closure edge at all; still inside the revoke
        cascade (authority flows down; accountability stops).
DC-5  Default policy is required. SILENT parent completion over live
        required children is a spec violation — S1 today permits
        exactly that, and S2.1's first test must be the negative one:
        complete(parent with open required child) → completion_denied.
DC-6  Closure is evaluated in COMPLETING against the D-subtree;
        the evaluation itself is a journaled fact (the obligation kind
        `closure`, CO-2).
```

---

## 5. Handoff and the ownership epoch (§HO)

Each intent carries a monotonic `ownerEpoch`; every effect-bearing fact
about an intent (`intent_call`, `intent_approve`, discharges) is
stamped with the epoch *at dispatch*.

```
HO-1  handoff: envelope revoked [pinned], epoch++, new owner starts
        with ZERO authority; re-entry only via grantFor (OT-1's lawful
        bridge).
HO-2  In-flight calls (dispatched at epoch e, settling after a
        handoff to e+1) settle honestly: their substrate effects
        happened; they are journaled under epoch e. Delivery is to
        the dispatching principal's controller, never re-pointed —
        mirrors the substrate's "cancellation cancels delivery, not
        side effects".
HO-3  Late receipts from epoch e < current MAY enter the evidence
        list as history (marked stale-epoch).
HO-4  They may discharge only obligations whose contract entry
        existed at epoch ≤ e (you cannot satisfy a promise that was
        made after the work), and they NEVER confer authority or
        satisfy approvals/attention granted under another epoch.
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

The Linux-library test (ROADMAP): an ordinary async library can
*simulate* ownership graphs and contracts; what it cannot offer is ST-2
— a state machine reconstructible from a tamper-evident, correlation-
bound ledger. That, not the vocabulary, is the candidate OS-primitive.

## 8. S2.1 conformance work (next code, in this order)

1. lifecycle privatization (ST-3) + ledger-replayable states (ST-2);
2. `CompletionContract` at open/fork + `receipt/approval/closure/context`
   obligation kinds + COMPLETING (CO-1…3, ST-1);
3. closure negative gate first, as a test before the feature (DC-5);
4. join policies required/optional/race/detached (DC-1…4);
5. ownerEpoch stamping + late-receipt rules (HO-2…5);
6. AttentionRequest object + WAITING_APPROVAL; then, and only then,
   re-open M2 as "which enforcement shape fits §AT".

Non-goals unchanged: no goal interpretation, no world-state claims, no
model execution, no runtime features smuggled in as "spec plumbing".
