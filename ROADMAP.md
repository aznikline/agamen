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
diluted to whatever is currently enforceable. The stated gates are
recorded as dependencies in spec §7 — the first is DEP-1: S's CO-5
binding-before-effect required E's pre-handler admission hook.

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

## S2 — APM as normative spec (rev. S2.0.9, `spec/apm.md`)

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

**S2.0.2** (2026-09-19, docs-only honesty patch after round-6 review):
CO-5's "before the effect" is now defined as a three-phase order —
admission/policy (where membranes charge attempts), the dispatch
linearization point (where the binding is journalled), the
effect-bearing handler — retiring any reading of "before every side
effect"; and §7 records **DEP-1**, the first true S→E dependency:
Track S's CO-5 demanded a pre-handler linearization point the substrate
did not have, and Track E supplied one (`onAdmit`). The tracks staying
separate was never the tracks never interacting — the interaction law
is direction: semantics state obligations, enforcement answers with the
minimal mechanism, and neither borrows the other's identity.

**S2.1** (next code, order fixed by the spec §8): lifecycle
privatization + replay-unique events; contract + COMPLETING; the
closure negative gate first (no parent completion over live required
children — S1 permits it today); dispatch-time binding stamps; join
policies over split parentage + supersede/waiver; epoch/revision
stamping; AttentionRequest. Default rule: stay inside `src/intent.js` —
but the rule now has a named exception channel: an S rule that needs a
substrate guarantee gets one only as a recorded cross-track dependency
(spec §7 DEP-1), with the mechanism kept minimal and host-plane-only.

**S2.1 progress** (2026-09-19, round-5/6 hardened): dispatch-time
obligation binding landed (spec §8 item 4, early by owner's request)
and CO-5 is **[pinned]**. The binding is journalled in the substrate's
new host-plane **admit hook** (`request(…, { onAdmit })` — after the
xact exists, before the handler runs; a throwing hook vetoes before any
effect and settles as a fact), pinned by a temporal test in which the
effect itself reads its binding out of the ledger (verified to fail
against the pre-fix `e17465a`). This was the FIRST true S→E
dependency: CO-5's binding-before-effect could not be honoured by the
existing substrate, so Track E grew the admission linearization point —
semantics stated the obligation, enforcement supplied the minimal
mechanism (spec §7 DEP-1; the earlier "no runtime features ride along"
phrasing was the overclaim it corrects). CO-5 wording precision
(round 6): the guarantee is binding-precedes-HANDLER-execution;
membranes/charged attempts belong to the admission/policy phase that
precedes the linearization point. Landed alongside: `receipt`
obligations at open/fork/delegate, append-only `amend` (bumps
`contractRevision`); non-null `matcher` REFUSED until matcher semantics
land; `handoff` bumps `ownerEpoch`; `complete()` claims only SELECT.
22/22 APM + 51/51 invariant tests.

**S2.1 progress** (2026-09-19, ST-3/ST-2 trusted-state base): the shape
guidance above is now the shape shipped. `src/intent.js` was refactored,
`runtime.js` untouched (no new DEP this slice). ST-3: the eight
determinable fields (state, stateVersion, contract, contractRevision,
ownerEpoch, envelope, evidence, spent) live in ONE module-private record
(a WeakMap) behind a setter-less `Intent` token view; `contract`/
`envelope`/`evidence` are handed out as deep-frozen clones (capability
tokens keep reference identity through the snapshot — they are opaque,
not data), so `intent.contract.pop()` and `intent.state = "completed"`
are TypeErrors that reach nothing. ST-2: exactly one lifecycle writer,
`transition(intent, toState, cause)`, which reads the current state,
validates the edge against the §2 table, bumps `stateVersion`, applies,
and journals `{intent, fromState, toState, stateVersion, cause}` —
illegal edges journal `intent_transition_denied` and move nothing.
Every former setter (suspend/resume/fail/revoke/complete/handoff/
requireLive) now routes through it; OPEN is genesis (version 0,
`fromState: null`) and the first structural act is an explicit
open→ACTIVE edge with a named cause, not a silent field write. A test
scans the implementation source to prove no assignment to
state/stateVersion exists outside that primitive — the single-writer
claim is checkable, not asserted. Ledger replay reconstructs each
intent's path and agrees with the read-only view; terminal states are
terminal (revoking a completed intent is refused, not a history
rewrite). The oracle was honest-tested: the six new ST-3/ST-2 tests all
fail against the immediately-pre-fix `1fd6fa9`. This upgrades CO-1 from
[partial] to **[pinned]** — "frozen/append-only" is now a property, not
a convention. 28/28 APM + 51/51 invariant tests. **What this slice
deliberately does NOT claim:** ST-4 total-order-over-dispatch (still
spec §8 item 6); the COMPLETING check machinery (item 2 — the frozen
contract holds, but completion is still the S1 gate plus SELECT-only
claims, not a §3/§4 verification pass). **Round-7 correction:** the
review of this commit judged the [pinned] labels an overclaim — eight
privatized fields left working bypasses (`intent.approval =
"not_required"` walked past the approval gate; `children.clear()`
escaped the revoke cascade; `intent.agent = …` was a handoff with none
of its three effects), PRIV had no ownership brand (a foreign
AgentSystem could drive the record while journalling into another
ledger, voiding replay), and "deep-frozen clones" was shallow spread +
freeze-through. Architecture approved, pins REVISE — closed by S2.1a
below.

**S2.1a progress** (2026-09-19, trusted-state closure, round-7
directives): the four landed items. (1) ST-3 widened to EVERY
decision-relevant field — relations (agent, parent, children),
configuration (goal, budget, deadline, approval, context), identity
(id, openedAt) now share the one private record with the eight state
fields; `id` is private too, because every check and correlation keys
on it. (2) The OWNERSHIP BRAND: the record names the AgentSystem that
minted it, and every system-side access goes through one checked
accessor (`#R`) — a foreign system is refused `E_FOREIGN` before it can
mutate anything or write a fact into the wrong ledger; agents are
branded the same way (`sysA.open(agentOfB)` refused). The foreign-
system test is now ST-2's central oracle: replay is only meaningful if
exactly one ledger defines the intent. (3) One snapshot copier —
structuredClone THEN deep-freeze — replaces the shallow-spread path
that froze the record's own nested objects through shared references;
cap tokens remain the declared reference-identity exception. (4)
Admission-gated activation: OPEN → ACTIVE now follows the first act
that clears every layer guard AND is an attempt (dispatched call,
minted grant); guard-refused calls, refused completions, promises
(amend), approval and ownership moves (handoff) leave OPEN at genesis
— which also keeps the planned OPEN → WAITING_* edges from racing a
half-activated state. `runtime.js` untouched again — this whole slice
asked nothing of Track E, so no new DEP. One deferred gap is recorded,
not patched (per the review): a failed legacy-path completion can still
leave candidate evidence in the record; the working-set commit rule is
part of the COMPLETING skeleton (spec §8 item 2). 34/34 APM + 51/51
invariant tests; the six new S2.1a tests all fail against the
immediately-pre-fix `0a002d8` (and the old 28 still pass there — the
closure changes no behavior the earlier suite legitimately pinned).
Next, in spec order: the COMPLETING skeleton (ST-1 + four kinds +
matcher + working-set commit) → DC-5.

**S2.1b progress** (2026-09-19, principal/context closure, round-8
directives): the review of `a0a97b9` signed ST-2 but not ST-3 — the
read-only view still bled mutable truth through two REFERENCES, and the
lesson generalizes: field-level locking is not enough; a safety
boundary over authoritative state must hold over the WHOLE reachable
object graph. (1) `intent.agent` had been handing out the writable
host-plane AgentExecution — `agent.model = …` bypassed the journalled
rebind, `agent.intents.clear()` rewrote history, and `agent.sys.rt`
gave any token holder the Runtime itself, which in this threat model is
the trusted control plane. AgentExecution is gone: an agent is now a
branded private record (system, id, label, model, control, context
head, intent registry) behind an inert frozen **AgentPrincipal** view
carrying only readable identity — OT-0's "Identity is not execution",
applied to the API surface. (2) Branding got unforgeable: the old
agent-brand check read the public-writable `agent.sys`, so
`foreignAgent.sys = sysA` manufactured membership; every brand check
now reads the private RECORD via the principal token, and the new
oracle attacks the brand itself (`.sys`/`.control` tampering), not just
a foreign object. (3) The context getter leaked the live mutable
Context — `intent.context.mutate(…)` changed belief state with no
owned act and no fact, contradicting §1's own "ContextVersion =
immutable belief snapshot". Split: private ContextHead, externally a
frozen ContextView (version, lineage, snapshot); belief change is
`sys.mutateContext` / `sys.mergeContext`, each journalling
`context_version {intent, fromVersion, toVersion, cause}`.
(4) Intent, AgentPrincipal and ContextView instances are frozen at
construction, and a transitive read-only walk test asserts every value
reachable from a token — goal, contract, evidence, children, envelope,
context, agent, parent — is a frozen snapshot, another token, or the
declared opaque-handle exception. `runtime.js` untouched (zero diff);
CO-5's admit-hook shape unchanged. 38/38 APM + 51/51 invariant tests;
all four new S2.1b oracles fail against pre-fix `a0a97b9` for their
intended reasons (three additional pre-fix failures are old tests
adapted to the new `hasIntent`/`mutateContext` API, not behavior
regressions). With this the trusted-state base is closed — per the
review, closure work STOPS here; next, in spec order: the COMPLETING
skeleton (ST-1 + four kinds + matcher + working-set commit) → DC-5.

**S2.1c progress** (2026-09-19, ingress ownership closure, round-9
directives): the review of `f754eba` signed the AgentPrincipal closure,
the context-write closure and ST-2, but found the boundary still
one-directional — S2.1b stopped mutable references leaking OUT; nothing
stopped caller-owned references leaking IN. Two concrete wounds:
`register` stored the caller's `model`/`label` BY REFERENCE (mutating
the original object after the call rewrote the private record with no
rebind act, no fact, no getter needed), and facts passed input
references into `rt.record()`, which does not clone — so mutating an
input after `open` changed event content AFTER it had been hashed, and
`verifyJournal()` went false: a token holder editing authoritative
history. Landed: ingress clone-normalization (goal/budget/approval/
context/obligations deep-copied into records at the door); `#fact`
deep-owns every event before the ledger (per-value clone; a
non-cloneable payload degrades to String, never to a live alias);
`agent_register` rides `#fact` like every other fact; `intent_open` is
composed from the PRIVATE record, not the parameter references;
label/model/deadline narrowed to immutable identity forms (string /
null|string / null|finite number — a structured ModelBinding is §8
work, not a silent object alias). Principle recorded in spec ST-3:
**authoritative-state isolation is bidirectional — no mutable aliases
out, no caller-owned aliases in; the outward reachable graph (round 8)
and the inward aliasing graph (round 9) together are the ownership
boundary.** The round-9 MAJORs are deferred by directive into the
COMPLETING pre-works (spec §8 item 2): immutable per-version
ContextVersion VALUES (today's view is a read-only live cursor —
evidence must bind a snapshot, not a moving lens) and the plain-data
snapshot domain (freezeDeep over Map/Set/Date is false immutability,
which would poison the `Object.isFrozen` oracle). `runtime.js`
untouched (zero diff); CO-5's admit-hook shape unchanged; ST-4 not
claimed. 42/42 APM + 51/51 invariant tests; the four new ingress
oracles all fail against pre-fix `f754eba` — the flagship on the
reviewer's own attack (post-open goal tamper ⇒ 'rewritten-after-hash'
inside a hashed event), and all 38 older tests pass unchanged on
pre-fix (no API adaptations this round, unlike S2.1b). Next, in spec
order and with the §8 item 2 pre-works first inside it: the COMPLETING
skeleton → DC-5.

**S2.1d progress** (2026-09-20, prototype closure, round-10 directive):
the review of `1f93ffe` signed S2.1c but named the last JS-specific
hole in the reachable graph — the PROTOTYPE CHAIN. Frozen instances
sat on mutable prototypes, and class getters are configurable by
default: `Object.defineProperty(Intent.prototype, "id", {get:
() => "i-forged"})` leaves `#R` branding authenticating the true
record (real state moves correctly) while every fact written through
the presentation getter attributes the edge to a ghost — private
truth FAILED, replay(originalId) stuck at OPEN: ST-2's core claim
severed through BEHAVIOR, not any field. Both layers landed, as
directed, not either/or: (1) authoritative identity is now record data
— intent id lives in PRIV, and internal code resolves ids through
PRIV/AGENT_PRIV everywhere (a grep-enforced discipline: no
`intent.id`/`rec.agent.id` inside the system); the public getters are
presentation only; (2) `Intent.prototype`, `AgentPrincipal.prototype`,
`ContextView.prototype` are frozen — the read-only view now includes
its own behavior surface. Two oracles: `the view prototypes are
frozen` and the teeth-carrying `an attempted prototype-id spoof
cannot misattribute a transition`. 44/44 APM + 51/51 invariant;
against pre-fix `1f93ffe` exactly the two new tests fail (the spoof
lands silently there) and all 42 older pass unchanged. `runtime.js`
untouched; CO-5 shape unchanged; ST-4 not claimed. Round 10 also
fixed the COMPLETING order — plain-data snapshot domain FIRST (its
new reason: provenance hashes events via JSON shape, so two different
Maps already hash identically — exotic values break hash-content
binding TODAY), then immutable ContextVersion values, then the four
obligation kinds. **Trusted-state closure is declared finished; next
slice, unconditionally: COMPLETING.**

**S2.2a progress** (2026-09-20, COMPLETING floor — steps 1–2 of the
nailed order, round-11 directive): round 11 SIGNED `7073c21`
("APPROVE ST-2 + ST-3 trusted-state closure — 直接进入 COMPLETING，不再
开 S2.1e") and froze the first two steps as prerequisites. Landed:
(1) the JSON-SAFE PLAIN-DATA DOMAIN as ST-3's value language, defined
against provenance's JSON-shaped hashing rather than against
structuredClone (cloneable ≠ representable: Maps clone and hash as
`{}`, BigInts clone and throw inside `record()`): ingress refuses
out-of-domain values with E_DOMAIN before any write — refused opens
journal no genesis fact at all — and the fact path SANITIZES: every
value is rebuilt from own data descriptors, unrepresentable leaves
become fixed `{$notInDomain, tag}` markers. With this the round-11
MAJOR died: `ownValue`'s `String(v)` fallback executed attacker code
(a hostile `toString`/`Symbol.toPrimitive` could throw and erase the
denial fact of its own refusal; a throwing getter ran during cloning)
— conversions are no longer ever the value's job. Authoritative ingress
clones switched from `structuredClone` to a same-realm structural
copier, which the domain makes provably faithful and which keeps
records free of realm-mismatched artifacts. (2) CONTEXT AS DETACHED
VALUES: `context.current()` returns a frozen
`{version, snapshot, lineageRef}` — read v3 and it stays v3 while the
head walks to v5 — so the future `context` obligation binds a value,
not a cursor. Early applications of §8 item 2's working-set commit
rule also landed on both completion paths (claims validate and
domain-own before any evidence write). Four oracles, 48/48 APM +
51/51 invariant; against pre-fix `7073c21` exactly the four new tests
fail (Map goals accepted, the hostile claim throws "boom" with no
denial fact, reasons degrade to `"[object Object]"`, `current()`
doesn't exist) and all 44 older pass unchanged. `runtime.js`
untouched; no new DEP; ST-4 not claimed. Next slice: the COMPLETING
machinery proper — ST-1 entry-as-check, four obligation kinds, matcher
semantics — then DC-5 negative-gate-first.

**S2.2b progress** (2026-09-20, domain closure, round-12 directive):
round 12 SIGNED the detached ContextVersion and the working-set commit
rule but REVISED the value language on two BLOCKERs, requiring a small
domain-closure slice before COMPLETING proper. BLOCKER 1: the S2.2a
sanitizer was itself an execution path — its array branch ran
`v.map(...)`, which READS elements, so an accessor element threw
inside `#fact` AFTER the transition had landed: `intent_fail` vanished
and the private truth moved silently, exactly the failure mode the
slice claimed to have eliminated; the same shape lived in
`const { xact } = claim` (a `get xact() { throw }` preempted
`completion_denied`), and the absolute "no attacker code ever executes"
claim was unsupportable since Proxy traps fire on `getPrototypeOf` /
`getOwnPropertyDescriptor`. The directive was explicit: do NOT keep
chasing a universal safe sanitizer — recursively introspecting a
hostile same-realm object safely is impossible. The fact path now
admits two categories: APM-owned values (certified dense and data-only
at build time via an `OWNED` WeakSet — a trust test no Proxy can trap)
copied in full, and RAW payloads inspected by descriptor only and
branch-refused whole to `{$untrusted: true}` the moment certification
fails, inside a try/catch so a throwing trap can make a payload opaque
but never make a denial fact absent; refusal fields (`xact`,
`obligation`) are extracted from DATA DESCRIPTORS, and caller lists on
gate paths (`for:`, claims) are read by index descriptor, never
iterated. BLOCKER 2: the domain was not closed under distinctness —
sparse holes vs `null`, `-0` vs `0`, symbol keys, named array extras
and the `__proto__` key either collapsed to one JSON binding or were
silently dropped. The domain is now exact: dense data arrays, own
enumerable string-keyed data props on a plain/null prototype, `-0`
normalized to 0 on ingress, holes and symbol keys REFUSED not dropped,
and clones built by `defineProperty`/index assignment so a JSON-parsed
`__proto__` stays an own data property (the round-12 principle, now in
the spec verbatim: "JSON-safe" is not "stringify does not throw" —
admitted values must keep their distinctness in the provenance
representation). Five oracles (four new; the round-11 hostile-claim
test re-asserted against the new refusal shape), 52/52 APM + 51/51
invariant; against pre-fix `86dd49b` exactly those five fail (the
accessor getter fires inside `Array.map` verbatim as the review
predicted; the throwing `xact` getter yields raw "boom" and no denial
fact; sparse arrays pass the old domain; the hostile `for:` list dies
before `E_INVAL`) and all 47 older tests pass unchanged. `runtime.js`
untouched; no new DEP; ST-4 not claimed. The value floor is signed
stable — next slice, with no further closure round in front of it:
COMPLETING machinery proper (ST-1 entry-as-check, four obligation
kinds, matcher semantics), then DC-5 negative-gate-first.

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
