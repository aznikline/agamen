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
- address spaces, context, and budgets are isolated per principal;
- high-risk actions can pause and resume through short-lived capabilities;
- authorization and communication events form linked, eventually verifiable
  evidence.

## Invariants

| # | Invariant | v0 status (this repo) |
|---|---|---|
| 1 | **Zero ambient authority** — a new agent's capability table starts empty. | enforced, tested |
| 2 | **Monotonic decay** — derived rights ⊆ source rights, always. | enforced, tested |
| 3 | **Full mediation** — every cross-principal call checks capability + rights. | enforced (runtime chokepoint) |
| 4 | **Non-forgeable identity** — the receiver's view of the sender is substrate-bound, never payload-borne. | simulated (actor-reference); hardening tracked in ROADMAP M3 |
| 5 | **Atomic creation** — spawn is all-or-nothing; no half-authorized child runs. | not applicable in-process; normative for M5 |
| 6 | **Revocation reachability** — delegation enters the derivation tree; revoked roots kill every descendant. | enforced, tested |
| 7 | **Memory isolation** *(kernel-only)* — no ungranted reads/writes across spaces. | normative for M5 |
| 8 | **Pointer safety** *(kernel-only)* — untrusted references validated before dereference. | normative for M5 |
| 9 | **Explicit completion** — success / failure / cancel / timeout / waiting-approval / waiting-resource are distinct states. | enforced (M1): `ok` / `fail` / `cancelled` / `timeout` are journaled outcomes; `shed` and `expire` are queue states; approval pending M2 |
| 10 | **Audit completeness** — allows *and* denials at the mediation point are journaled; no bypass path. | enforced (denials now journaled as `invoke_denied` under the same xact as the attempt) |
| 11 | **Policy outside the model** — output may request, never widen. | enforced (membranes) |
| 12 | **Protocol decoupling** — MCP/A2A changes never alter the substrate ABI. | by construction (no wire layer yet) |

## Threat model (carried from spec 13 §14)

| Threat | Required control |
|---|---|
| prompt injection induces privilege growth | capability allowlist, out-of-model policy, sensitive-action approval |
| confused deputy | substrate-stamped sender, endpoint-bound capability, target-bound tokens |
| identity self-declaration | ignore payload identity; trust only mediation metadata |
| capability leak | empty default table, minimal rights, derivation/revoke, short leases (M2) |
| replay | xact ids, nonce/expiry, tool-side idempotency |
| context poisoning | read/write capability split, version lineage, digests, provenance labels |
| malicious tool service | process/actor isolation, output validation, no reverse ambient authority |
| DoS / runaway agent | membranes with budgets, deadlines, cancel, backpressure (**M1: enforced** — deadline admission, xact cancel, mailbox shed/block) |
| post-approval substitution | approval binds args hash + code/context version (M2) |
| audit overwrite/tampering | hash chain (v0), export + signing batches (later) |

## Acceptance tests (from spec 13 §16, mapped)

| Test | v0 |
|---|---|
| zero-authority | `test/runtime.test.mjs` — *zero-authority* |
| attenuation | — *attenuation* |
| revocation | — *revocation-cascade* |
| identity anti-forge | — *identity-stamp* (payload `sender` ignored) |
| audit completeness | — *provenance* (quad + tamper-evidence) |
| atomic spawn | pending M5 (kernel backend) |
| pointer fault | pending M5 |
| lifecycle | `test/runtime.test.mjs` — *lifecycle* (expire/cancel at delivery; ok/fail outcomes distinct, spec #9) |
| deadline/cancel | — *deadline* denied pre-execution + late result withheld; *cancel* by xact id and pre-aborted signal |
| context isolation | pending M4 |
| approval binding | pending M2 |
| protocol boundary | pending (no wire layer) |

Contribution rule: any change to `src/runtime.js` MUST keep rows 1, 2, 6, 10,
11 green and MUST add a negative test for any newly-enforced invariant before
claiming it.
