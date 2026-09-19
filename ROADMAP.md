# Agamen Roadmap

Form-first: semantics are *modelled* in this userspace substrate, then
*hardened* against the threat it claims to survive (hostile code in the same
realm) before any security-sensitive use, and only later earns kernel-ABI
cost. Enforcement backends are a late, reversible decision (M5). Each
milestone is gated by the acceptance table in `spec/invariants.md`, and
every cost claim follows the measurement rules in `docs/evaluation.md`.

## M0 — v0 invariant core (done, 2026-09-19; retroactively a *semantics* milestone)

Actors, capability derivation + subtree revocation, membranes, hash-chained
provenance. Delivered as an executable model of the boundary — an external
review of 2026-09-19 showed several "enforced" claims were not true against
hostile same-realm JS code; the claims were re-scoped and the gaps closed in
M1.5.

## M1 — scheduling semantics as a substrate object (semantics done, 2026-09-19; enforcement moved to M1.5)

Deadline, budget, and cancellation are first-class on the actor/mailbox path
(not an advisory convention): a request past its deadline is denied before
the handler runs and a late result is withheld (`E_DEADLINE`/`E_TIMEOUT`);
cancellation by xact id discards pending results; saturated mailboxes shed
(`E_SHED`) or block explicitly. Completion states `ok/fail/cancelled/timeout`
are journaled (invariant #9); denials carry the same xact (#10). Enforcement
is cooperative — in-process handlers are not preempted; preemption is an M3
transport concern. Carries agate's EDF-experiment result (P0-1) from paper to
practice. The v1 implementation of this milestone failed the review gate
(hung handlers could strand completion; queue liveness gaps); the semantics
survived and were re-implemented under M1.5.

## M1.5 — in-realm enforcement gate (done, 2026-09-19)

Prerequisite for anything that *authorizes* (M2). The threat model adopted:
hostile JavaScript in the same realm as the substrate. Enforced now:

- actors and capabilities are opaque tokens; all authority state lives in
  runtime-private WeakMaps — rights cannot be forged, revocation cannot be
  undone, membranes cannot be dropped, targets cannot be reached around the
  chokepoint;
- full mediation: messaging requires a mailbox capability with `send`;
  delegation requires `grant`; handler/membrane contexts carry immutable
  metadata only — no caller or capability objects cross to endpoints;
- completion is guaranteed by `cancel()`/`tick()`, never by handler
  cooperation; queued-message expiry and cancellation always promote waiters;
  blocked sends resolve (never reject) within bounded waiter capacity;
- values cross every principal boundary by structured clone; hashes use a
  canonical, total serialization (unhashable is an explicit outcome);
- every denial at the chokepoint is journaled; the only measurement seam is
  an explicitly non-conforming bench sink (`rt.conforming === false`), which
  still generates events.

Still open by design: non-forgeable *transport* identity (#4, M3), handler
preemption (M3), externally anchored evidence (#10 full form, M3+), atomic
creation (#5, M5). Acceptance: 32 tests, one negative test per review
finding (names cite `F2`–`F15`).

## M2 — approval leases (semantics-only until M1.5-grade enforcement; unblocked 2026-09-19)

Atomic mint of a short-lived, use-counted, arg-hash-bound capability
(agate spec 13 §12). The review exposed a sequencing contradiction in the old
wording ("real kernel-visible object" while the backend is undecided until
M5): M2 defines and enforces lease semantics at the M1.5 boundary — one-shot
use, expiry, arg-hash binding via the canonical hash domain — and *documents*
the ABI shape a later backend would expose. It is not advertised as
kernel-visible until M5 chooses where the kernel is. Acceptance:
approval-binding row; substitution tests against the canonical-hash
collisions found in review.

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
