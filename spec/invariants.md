# Agamen Invariants (normative core)

> Derived from [agate `spec/13-agent-execution-substrate.md`](https://github.com/aznikline/agate)
> §2, §6, §13, §14, §16 (commit `b481b4bd`, MIT). Numbering is preserved so
> both repos can cite the same invariant ids. Items marked **kernel-only**
> are not enforceable by an in-process substrate but remain normative for the
> project's end state.

Agamen's goal is not to put models, prompts, RAG, or orchestration into a
kernel; it is to give uncertain, prompt-injectable, possibly wrong-acting
agents a **deterministic execution boundary**:

- authority comes only from capabilities; model output is never an
  authorization;
- agents hold no ambient authority — only explicit, decaying, revocable
  delegation;
- tool calls and agent-to-agent messages traverse the mediation point, where
  the substrate stamps the caller;
- budgets attach to grants and are shared only within that grant's derivation
  subtree; sibling subtrees are independent; values cross principal boundaries
  by structured clone, never by shared mutable reference;
- high-risk actions can pause and resume through short-lived capabilities;
- authorization and communication events form a linked chain, internally
  hash-consistent for the process lifetime; external anchoring and signing
  are future work.

**Enforcement threat model (M1.5 onward):** the adversary is hostile
JavaScript running in the same realm as the substrate — it holds actor and
capability tokens, receives handler contexts, and may mutate anything
reachable. "Enforced" below means *against that adversary*. Anything weaker
is labelled simulated or normative. The M1-era implementation did not meet
this bar; an external review (2026-09-19) forced the re-scoping and the M1.5
rework described in `ROADMAP.md`.

## Invariants

| # | Invariant | v1.5 status (this repo) |
|---|---|---|
| 1 | **Zero ambient authority** — a new agent's capability table starts empty. | enforced, tested — tokens expose no state; handler/membrane ctx carries immutable metadata only (no actor/capability objects) |
| 2 | **Monotonic decay** — derived rights ⊆ source rights, always. | enforced, tested — rights live in runtime-private WeakMaps; holder mutation is impossible, not merely checked |
| 3 | **Full mediation** — every cross-principal call checks capability + rights. | enforced, tested — invoke needs `send`; `tell` needs a mailbox capability targeting the receiver with `send`; delegation needs `grant`; targets are unreachable around the chokepoint (opaque tokens) |
| 4 | **Non-forgeable identity** — the receiver's view of the sender is substrate-bound, never payload-borne. | simulated (runtime-branded actor reference; payload identity ignored) — transport-bound stamping is ROADMAP M3 |
| 5 | **Atomic creation** — spawn is all-or-nothing; no half-authorized child runs. | not applicable in-process; normative for M5 |
| 6 | **Revocation reachability** — delegation enters the derivation tree; revoked roots kill every descendant. | enforced, tested — `revoked` is private state; un-revoking from the holder side is impossible |
| 7 | **Memory isolation** *(kernel-only)* — no ungranted reads/writes across spaces. | in-realm analogue enforced: no shared mutable values across principal boundaries (structured clone); address-space isolation normative for M5 |
| 8 | **Pointer safety** *(kernel-only)* — untrusted references validated before dereference. | normative for M5 |
| 9 | **Explicit completion** — success / failure / cancel / timeout / waiting-approval / waiting-resource are distinct states. | enforced for the caller-facing contract: `cancel()`/`tick()` settle outcomes regardless of handler cooperation; `ok/fail/cancelled/timeout` journaled; `shed`/`expire` queue states; cancellation means **delivery cancelled**, and the ledger says so (`delivery:"cancelled"` + later `handler_settled` facts); approval pending M2 |
| 10 | **Audit completeness** — allows *and* denials at the mediation point are journaled; no bypass path. | enforced within the documented scope: lookup, rights, policy, grant and delivery denials all journal; the only measurement seam is the explicitly non-conforming bench sink (`rt.conforming === false`), which still generates events. The chain is in-memory and internally hash-consistent for the process lifetime — NOT tamper-evident against an attacker with process access until externally anchored (M3+) |
| 11 | **Policy outside the model** — output may request, never widen. | enforced, tested — membrane state is private per grant subtree; holders cannot drop or rewrite membranes |
| 12 | **Protocol decoupling** — MCP/A2A changes never alter the substrate ABI. | by construction (no wire layer yet) |

## Threat model (carried from spec 13 §14)

| Threat | Required control | v1.5 status |
|---|---|---|
| prompt injection induces privilege growth | capability allowlist, out-of-model policy, sensitive-action approval | enforced in-realm (opaque rights; approval = M2) |
| confused deputy | substrate-stamped sender, endpoint-bound capability, target-bound tokens | enforced in-realm; transport stamping M3 |
| identity self-declaration | ignore payload identity; trust only mediation metadata | enforced (payload `sender` ignored) |
| capability leak | empty default table, minimal rights, derivation/revoke, short leases (M2) | enforced; leases M2 |
| replay | xact ids, nonce/expiry, tool-side idempotency | xact ids substrate-generated on collision-check; expiry enforced via tick |
| context poisoning | read/write capability split, version lineage, digests, provenance labels | partial (digests via canonical hash domain; lineage M4) |
| malicious tool service | process/actor isolation, output validation, no reverse ambient authority | reverse-authority closed in-realm (ctx metadata only; cloned values); preemption/isolation M3 |
| DoS / runaway agent | membranes with budgets, deadlines, cancel, backpressure | enforced cooperatively: budget/deadline/cancel/shed/block; waiter queues bounded (`mailbox × 4`); blocked sends resolve, never reject; handler CPU cannot be stopped in-process (M3) |
| post-approval substitution | approval binds args hash + code/context version (M2) | canonical total hash domain ready; collisions (undefined/NaN) closed; leases M2 |
| audit overwrite/tampering | hash chain, then export + signing | internal chain only — do not claim evidence-grade until anchored |

## Acceptance tests (mapped to `test/runtime.test.mjs`, finding refs = 2026-09-19 external review)

| Test | v1.5 |
|---|---|
| zero-authority | — *zero ambient authority; tokens expose no authority state (F2, F3)* |
| attenuation | — *monotonic decay still enforced on the token API* |
| revocation | — *revocation cascade is not undoable by holders (F2, #6)* |
| full mediation (messaging) | — *full mediation: tell requires a send capability (F1a)*; *send-only capability cannot delegate (F1c)* |
| identity anti-forge | — *payload identity is never trusted* |
| no reverse authority | — *handler ctx carries immutable metadata (F3)*; *messages and results cross by structured clone (F12)* |
| audit completeness | — *every denial class is journaled at the chokepoint (F8)*; *allow path journals the full quad (F10)* |
| explicit completion | — *cancel settles a hung handler immediately (F4, F9)*; *tick() enforces deadlines (F4)*; *late result withheld (F9)* |
| deadline/cancel | — *deadline in the past denies before admission*; *abort signal cancels* |
| queue liveness | — *expired head unblocks the waiting sender (F5)*; *cancelling a queued message promotes a waiter (F5b)*; *blocked sends never reject (F6)*; *waiters bounded (F6)* |
| hash domain | — *canonical hashes distinguish undefined/NaN, reject cycles without throwing (F11)* |
| xact identity | — *caller xacts collide only with live transactions (F13)*; *runtime-branded E_FOREIGN (F14)* |
| budget scope | — *membrane budgets per grant subtree (F15)*; *charged-attempt ordering (F15b)* |
| non-conforming seam | — *bench sink is explicit (F7)* |
| atomic spawn | pending M5 (kernel backend) |
| pointer fault | pending M5 |
| context isolation | pending M4 |
| approval binding | pending M2 |
| protocol boundary | pending (no wire layer) |

Contribution rule: any change to `src/runtime.js` MUST keep rows 1, 2, 3, 6,
10, 11 green and MUST add a negative test — written from the hostile
same-realm JS adversary's point of view — for any newly-enforced invariant
before claiming it.
