# Agamen Roadmap

**North star:** define an *operating model for agency* — a computation
model in which long-running, delegable, suspendable, forkable, auditable,
and fallible AI agents are first-class, in the way processes are for
classical OSes. The decision test for every candidate primitive:
*if implementing it as a Linux library would behave exactly the same, it
is not an OS primitive.*

Agamen is not "Agate's JS frontend verifier". The division is:
**Agate (and any eventual kernel) enforces; Agamen defines what should
exist.** Form-first still holds — semantics are modelled, broken, and
measured in userspace before any of them costs a kernel ABI — but the
model is now the product, not a rehearsal for the kernel.

## Two independent tracks (two DAGs; do not mix edges)

**Track S — the operating model (semantic).**
Agent Principal → Task/Intent → delegation graph → approval/attention →
context lineage → fork/resume/handoff → evidence-backed completion.
The artifact is the Agent Process Model (`src/intent.js`, S1 below).
S-track milestones are judged by explanatory power and negative tests
("an agent cannot claim it finished"), not by ns/call.

**Track E — enforcement.**
same-realm tokens → worker/child-process transport → hardened userspace
runtime → agate guest via its IPC/capability ABI → Agamen's own kernel
(`kernel/uapi/` as genesis). E-track milestones are judged by the
acceptance table in `spec/invariants.md` and the charter in
`docs/evaluation.md`.

The tracks share invariant numbering and the same ledger vocabulary, but
they gate each other only where stated: enforcement may lag semantics
(label it simulated/normative, never silently); semantics must never be
diluted to whatever is currently enforceable.

# Track S — the operating model

## S0 — boundary primitives as semantics (done, 2026-09-19; = old M0+M1)

Actor, capability, membrane, provenance, schedule as executable
semantics. Retroactive label: M0/M1 were S-track milestones delivered
with E-track-quality in-realm enforcement.

## S1 — Agent Process Model experiment (done, 2026-09-19; `src/intent.js`)

`AgentExecution` (a principal that survives model rebinds —
resume-with-new-model keeps identity, context and open intents) and
`Intent` (the schedulable unit: requested outcome, authority envelope,
budget, deadline, approval state, child intents, completion evidence),
with fork / delegate / handoff / suspend / resume(model) / approve /
revoke / merge_context / complete(evidence). Built entirely on the M1.6
substrate: lifecycle facts are recorded HERE, rights/deadlines/cloning/
membranes are enforced THERE, and correlationIds make the two ends
provable against each other. The negative gate is the milestone:
`complete()` refuses without at least one evidence item backed by a
journaled `ok` invocation. Acceptance: 13 lifecycle + negative tests.

## S2 — APM as normative spec (rev. S2.0.1, `spec/apm.md`)

The spec stands on its own, independent of the JavaScript prototype. It
is built on three separations — **Ownership is not authority. Evidence
is not correctness. Identity is not execution** — and answers the four
questions the S1 experiment exposed: the two-graph model (delegation
graph ⊥ derivation graph; creation only by fresh consent, destruction
by D-transition revocation; handoff proves the split), the intent state
machine with a verification state (`COMPLETING`), OPEN-initial waiting
edges, and replay-unique normalized events (`from/to/stateVersion/
cause`), completion as a frozen **CompletionContract** of
machine-checkable obligations (receipt/approval/closure/context)
**bound at dispatch, never re-labelable at completion** (CO-5) — the
contract has teeth exactly because past work cannot be renamed to pay
for promises made after it — and **attention as a resource**
(AttentionRequest: scope, expiry, consumption, transferability) with
M2's lease question explicitly deferred until the object is stable.
Handoff gains two independent monotonic counters — `ownerEpoch` and
`contractRevision` — and a per-intent serial order (ST-4), so late
receipts count as history, never as authorization, and cannot pay for
obligations born after the work.

**S2.0.1** (2026-09-19, spec-only): closed the spec-review blockers —
dispatch-time obligation binding, `contractRevision` beside the epoch —
and the majors: serial order, the parentage/join-policy split in `D`,
race losers `CANCELLED(reason=race_lost)` ("cancellation revokes
future authority, not past effects"), and the Linux-library argument
demoted to an honest conjunction that Track E must still face.

**S2.1** (next code, order fixed by the spec §8): lifecycle
privatization + replay-unique events; contract + COMPLETING; the
closure negative gate first (no parent completion over live required
children — S1 permits it today); dispatch-time binding stamps; join
policies over split parentage + supersede/waiver; epoch/revision
stamping; AttentionRequest. All inside `src/intent.js`. No runtime
features ride along.

**S2.1 progress** (2026-09-19, round-5 hardened): dispatch-time
obligation binding landed (spec §8 item 4, early by owner's request).
The binding is journalled in the substrate's new host-plane **admit
hook** (`request(…, { onAdmit })` — after the xact exists, before the
handler runs; a throwing hook vetoes before any effect and settles as
a fact), pinned by a temporal test in which the effect itself reads
its binding out of the ledger. `receipt` obligations at
open/fork/delegate, append-only `amend` (bumps `contractRevision`);
non-null `matcher` REFUSED until matcher semantics land; `handoff`
bumps `ownerEpoch`; `complete()` claims only SELECT. 22/22 APM +
51/51 invariant tests. Honest labels: CO-1 is **[partial]** — the
contract array is still publicly mutable; ST-3 (widened to
state/contract/revisions/epoch/envelope/evidence/spent) is what turns
"append-only" from convention into property. Next, in spec order:
ST-3 → ST-2 → the COMPLETING skeleton (ST-1 + four kinds + matcher) →
DC-5 — no check runs against mutable truth, no fourth oracle.

# Track E — enforcement

## M0 — v0 invariant core (done, 2026-09-19)

Actors, capability derivation + subtree revocation, membranes,
hash-chained provenance. An external review of 2026-09-19 showed
several "enforced" claims were not true against hostile same-realm JS;
the claims were re-scoped and the gaps closed across M1.5/M1.6.

## M1 — scheduling semantics as a substrate object (semantics done, 2026-09-19)

Deadline, budget, and cancellation are first-class on the actor/mailbox
path: expired requests are denied before the handler runs (`E_DEADLINE`),
late results are withheld (`E_TIMEOUT`), cancellation discards pending
delivery, saturated mailboxes shed (`E_SHED`) or block explicitly.
Completion states `ok/fail/cancelled/timeout` are journaled (#9);
denials carry the same xact (#10). Enforcement is cooperative — handler
preemption is a transport concern (M3). Carries agate's EDF-experiment
result (P0-1) from paper to practice.

## M1.5 — in-realm enforcement gate (done, 2026-09-19)

Opaque WeakMap-backed tokens; full mediation of messaging and delegation;
cancel/tick completion without handler cooperation; bounded waiter
liveness; structured-clone value crossing; canonical hashing; every
denial journaled; the only measurement seam is the explicitly
non-conforming bench sink. 32 tests, one negative test per external
review finding. An internal re-audit of the final v1.5 tree found five
BLOCKERs and four MAJORs — all real, all closed in M1.6 — and the M1.5
"enforced" claims were re-scoped to "enforced against the realm-code
adversary that does not hold the Runtime object".

## M1.6 — authority-handle split + strict value discipline (done, 2026-09-19)

- **Three handles, not one:** public ActorId (comparable, displayable,
  accepted by no privileged call), ActorControl (principal-private
  controller: recv/request/holds/slot writes), MailboxCap (the only
  authority to `tell()`). Holding a target's public identity mints
  nothing and reads nothing.
- **Consent:** installing into an actor's slot requires that actor's
  control handle; overwriting an occupied slot requires explicit
  `overwrite: true` (`E_OCCUPIED`). The v1.5 slot-hijack is
  constructively impossible.
- **Threat model chosen, not ambiguous (option A):** the Runtime object
  is the trusted control plane — host API, not a boundary hostile code
  faces. The adversary is realm code holding legitimate tokens.
- **Clone-or-fail, both directions:** args are cloned before any
  membrane sees them (`E_CANON` on failure); results that cannot cross
  by clone FAIL the xact (`E_CLONE`) — the shared-reference fallback is
  deleted.
- **Frozen, type-tagged canonical value domain:** plain data only
  (`E_DOMAIN`), which removes the v1.5 sentinel/string collisions. A
  total, collision-free argument digest is a precondition for M2 —
  which therefore **stays blocked** until this layer is proven beyond
  the in-realm tests.
- **Private ledger:** `rt.journal` is gone; `verifyJournal()` /
  `journalEntries()` / `record()` are read-only views; `conforming` is a
  getter. Internal xact ids are runtime-lifetime unique; caller labels
  moved to `correlationId`.
- Acceptance: 49 invariant tests (both poisoned v1.5 oracles inverted),
  bench protocol upgraded to per-replicate A/B pairing
  (`bench/baseline.md`, commit `27a2a9b`).

## M2 — approval leases (**blocked**)

Atomic mint of a short-lived, use-counted, arg-hash-bound capability
(agate spec 13 §12). Two gates, both open questions as of 2026-09-19:
(1) the digest precondition — M2 binds approvals to an argument hash, so
the canonical domain must be proven total and collision-free beyond
in-realm tests (v1.6 narrowed but did not close this); (2) the shape
question — S2's approval-state spec should define *what* a lease
protects before M2 freezes *how* it is minted. M2 stays blocked on both
tracks until each gate individually clears.

## M3 — cross-boundary identity and provenance

Move sender-stamping from "passed reference" to transport-bound
authority: actor mailboxes over `node:worker_threads` / child processes,
xact correlation across boundaries, journals from two substrates merging
into one verifiable chain. Hardens invariant #4 from simulated to
demonstrated.

## M4 — context objects: actor state with lineage

Versioned, snapshottable actor state carried by capabilities (CoW
semantics from agate P3, incubated in S1's Context first): read/write
caps split, snapshot creates new identity with parent link, quota as
membrane. Acceptance: context-isolation row.

## M5 — enforcement backend decision

Choose where Agamen is *enforced*, in order of least commitment:
(a) hardening library on commodity OS (seccomp/pledge-class),
(b) guest on the [agate](https://github.com/aznikline/agate) microkernel
via its IPC/capability ABI, (c) Agamen's own kernel with the
`kernel/uapi/` ABI seed as genesis. Decision criteria: which invariants
(#5, #7, #8) cannot be discharged by (a); measured membrane overhead
from M1; agate's P0-P4 stabilization pace. Until chosen, Agamen remains
backend-agnostic by construction (#12).

## Non-goals (all milestones, both tracks)

No model execution in the substrate; no prompt/JSON parsing below the
mediation point; no promises of semantic correctness of agents — only of
the boundary they run inside and the lifecycle facts recorded about them.
