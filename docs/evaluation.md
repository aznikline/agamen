# Agamen Evaluation Charter — a quantitative approach to the substrate

Agamen's thesis is that cost decides which primitive belongs below the
mediation boundary (`docs/thesis.md` §5, M5). A thesis without numbers is a
style. This charter fixes *what* we measure, *how* we aggregate, and *which
fallacies* disqualify a result — methodology adapted from Hennessy &
Patterson, *Computer Architecture: A Quantitative Approach* (knowledge
center, "OS" notebook). Scope: these rules govern **track E** measurements;
track S milestones (S1/S2) are judged by `spec/` acceptance tests, not by
ns/call — S1's `intent.js` overhead is deliberately not fitted here.

## 1. What is measured

**Cost model per mediated invoke** — decompose, never report only the total:

| component | symbol | v0 expectation |
|---|---|---|
| capability lookup + rights check | `c_cap` | O(depth), map hit |
| membrane chain (n membranes) | `n · c_mem` | linear in chain length |
| provenance journal append (SHA-256 + chain) | `c_journal` | dominant hash cost |
| actor mailbox enqueue/dequeue | `c_ipc` | copy of msg |
| revocation-subtree walk (amortized) | `c_revoke / calls` | charged to the workload, not per call |

**Baseline for every number**: the same call through a *raw* async function
reference with no capability, no membrane, no journal. Overhead is reported
as a ratio to baseline and as absolute ns/call — never as a bare number
that smuggles in machine-dependent constants.

## 2. Benchmark hierarchy (low → high)

1. **Microkernels (M1 harness)**: synthetic invokes — 1 cap, 0/1/3 mem-
   branes, journaling measured both ways: conforming SHA-256 vs the
   explicitly non-conforming `bench:` sink (there is no journal-off seam;
   see `spec/invariants.md` #10). Purpose: fit the §1 cost model
   coefficients.
2. **Full kernels**: complete agent workloads — a tool-loop (actor →
   capability-gated tool → reply, K iterations, one xact), a fan-out
   (1 client → n servers), a chain delegation (grant moves through d
   CNode-equivalent hops). Purpose: end-to-end elapsed time.
3. **Real apps (post-M3)**: measured against the unmediated version of the
   same app. Only these numbers may justify a kernel backend.

## 3. Aggregation rules

- **Rates (calls/s) → harmonic mean** of per-run times; **totals (ns/call,
  throughput over one workload) → arithmetic mean** as the headline;
  report the median alongside whenever variance across runs exceeds 15%.
  A single mean of mixed ratios is an automatic reject in review.
- **A/B comparisons are per-replicate paired** (M1.6 protocol): journal
  and no-journal variants of a pair run the identical workload in the
  *same round* against fresh runtimes, rounds are interleaved
  round-robin across all variants, odd rounds execute in reversed
  order, and the reported delta is over same-round-index samples
  (Δmean, Δmedian, ratio). Pass-level or best-of-N comparisons are not
  admissible for audit-share claims.
- Each benchmark runs ≥ 10 iterations after warmup; discard the first 10%;
  report max too — tail latency is a *security* property under deadline
  semantics (M1), not just performance trivia.
- Every recorded number carries: commit hash, Node version, OS, CPU model,
  date. Numbers without provenance metadata are deleted, not footnoted —
  the journal applies to our own measurements too.

## 4. Analysis discipline

- **Amdahl before optimizing**: measure what fraction of the end-to-end
  agent loop a component actually occupies before improving it. If journals
  are 9% of full-kernel time, a 2× faster hash buys <5%; the review asks
  for the closed-form speedup `1 / ((1−f) + f/s)` before the patch.
- **The "benchmarks always valid" fallacy**, inverted for our domain: a
  result measured only on microkernels may not justify any M5 backend
  decision; a result measured only on Node may not be extrapolated to a
  kernel ABI. State the extrapolation, or don't state the conclusion.
- **No single-metric headlines**: every overhead claim is reported with its
  memory cost (slot/journal bytes per actor) and its semantics gate (which
  invariant row it pays for).

## 5. Milestone linkage

- **M1** acceptance gains: publish `bench/baseline.md` from harness tier 1–2
  with §1 coefficients fitted.
- **M2** adds the approval-lease cost column; the lease-vs-revoke trade is
  decided numerically.
- **M3** transports must be measured against tier-2 workloads or the
  boundary claim is unsupported.
- **M5** decision requires tier-3 numbers for option (a); the criterion
  "membrane overhead < 20% of mediated call" is an example, and M1's data
  sets the real threshold.

## Non-goals

No competitive benchmarketing against seL4/Hubris/Erlang. Numbers exist to
decide *our* boundary placements, and to make each one falsifiable by a
reader with a laptop.
