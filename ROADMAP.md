# Agamen Roadmap

Form-first: semantics are proven in this userspace substrate before any of
them earns kernel-ABI cost. Enforcement backends are a late, reversible
decision (M5). Each milestone is gated by the acceptance table in
`spec/invariants.md`, and every cost claim follows the measurement rules in
`docs/evaluation.md`.

## M0 — v0 invariant core (done, 2026-09-19)

Actors, capability derivation + subtree revocation, membranes, hash-chained
provenance. 7 tests green. Invariants #1 #2 #3 #6 #10 #11 enforced in-process.

## M1 — scheduling semantics as a substrate object (done, 2026-09-19)

Deadline, budget, and cancellation are first-class on the actor/mailbox path
(not an advisory convention): a request past its deadline is denied before
the handler runs and a late result is withheld (`E_DEADLINE`/`E_TIMEOUT`);
cancellation by xact id discards pending results; saturated mailboxes shed
(`E_SHED`) or block explicitly. Completion states `ok/fail/cancelled/timeout`
are journaled (invariant #9); denials carry the same xact (#10). Enforcement
is cooperative — in-process handlers are not preempted; preemption is an M3
transport concern. Carries agate's EDF-experiment result (P0-1) from paper to
practice. Acceptance met: deadline/cancel + lifecycle rows green (15/15
tests); baseline cost model in `bench/baseline.md`.

## M2 — approval leases

Atomic mint of a short-lived, use-counted, arg-hash-bound capability
(agate spec 13 §12). First candidate to graduate from closure-budgets to a
real kernel-visible object — races are unfixable in userspace. Acceptance:
approval-binding row.

## M3 — cross-boundary identity and provenance

Move sender-stamping from "passed reference" to transport-bound authority:
actor mailboxes over `node:worker_threads` / child processes, xact
correlation across boundaries, journals from two substrates merging into one
verifiable chain. Hardens invariant #4 from simulated to demonstrated.

## M4 — context objects: actor state with lineage

Versioned, snapshottable actor state carried by capabilities (CoW semantics
from agate P3, incubated here first): read/write caps split, snapshot creates
new identity with parent link, quota as membrane. Acceptance: context-isolation row.

## M5 — enforcement backend decision

Choose where Agamen is *enforced*, in order of least commitment:
(a) hardening library on commodity OS (seccomp/pledge-class),
(b) guest on the [agate](https://github.com/aznikline/agate) microkernel via
its IPC/capability ABI,
(c) Agamen's own kernel with the `kernel/uapi/` ABI seed as genesis.
Decision criteria: which invariants (#5, #7, #8) cannot be discharged by (a);
measured membrane overhead from M1; agate's P0-P4 stabilization pace.
Until chosen, Agamen remains backend-agnostic by construction (#12).

## Non-goals (all milestones)

No model execution in the substrate; no prompt/JSON parsing below the
mediation point; no promises of semantic correctness of agents — only of the
boundary they run inside.
