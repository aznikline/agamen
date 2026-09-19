# Agamen Invariants (normative core)

> Derived from [agate `spec/13-agent-execution-substrate.md`](https://github.com/aznikline/agate)
> §2, §6, §13, §14, §16 (commit `b481b4bd`, MIT). Numbering is preserved so
> both repos can cite the same invariant ids. Items marked **kernel-only**
> are not enforceable by an in-process substrate but remain normative for
> the project's end state.

Agamen's goal is not to put models, prompts, RAG, or orchestration into a
kernel; it is to define the **operating model for agency** — the
lifecycle, authority and accountability shape long-running, delegable,
forkable, fallible agents have — and to give that model a deterministic
execution boundary:

- authority comes only from capabilities; model output is never an
  authorization;
- agents hold no ambient authority — only explicit, decaying, revocable
  delegation;
- tool calls and agent-to-agent messages traverse the mediation point,
  where the substrate stamps the caller;
- budgets attach to grants and are shared only within that grant's
  derivation subtree; sibling subtrees are independent; values cross
  principal boundaries by structured clone **in both directions**, never
  by shared mutable reference;
- high-risk actions can pause and resume through short-lived capabilities
  (M2, blocked);
- authorization and communication events form a linked chain, internally
  hash-consistent for the process lifetime; external anchoring and
  signing are future work (#10, M3+).

## Threat model (M1.6 onward: chosen, not ambiguous)

**The Runtime object is the TRUSTED CONTROL PLANE.** `spawn`, `grant`,
`revoke`, `tick`, `cancel`, `address` and `record` are host APIs, not a
boundary hostile code faces; code that holds the Runtime is the host, by
definition (option A of the M1.6 re-audit).

The adversary is **realm code**: handler bodies, membrane factories,
agent-side JS — code that legitimately holds capability tokens, its own
`ActorControl`, exposed `ActorId`s, and frozen snapshots. Against that
adversary "enforced" means: rights unforgeable (WeakMap-private state),
revocation not holder-reversible, membranes undroppable, slot
installation impossible without the target's consent, public identity
inert at every privileged call, values unable to cross by reference, and
the ledger unreachable except through read-only views. Anything weaker
is labelled simulated or normative. The v1.5 wording ("hostile
same-realm JS") conflated host and realm; the re-audit's five BLOCKERs
all traced to that conflation and are closed in v1.6.

## Handle taxonomy (v1.6)

A principal is reached by three distinct tokens; v1.5's single-token
design made holding a target's reference mint its mailbox root, read its
mailbox, and drive its slots.

| Handle | What it does | What it must never do |
|---|---|---|
| **ActorId** (`identityOf(control)`) | frozen `{id,label}` snapshot: comparable, displayable, embeddable in messages | accepted by ANY privileged call — it keys nothing |
| **ActorControl** (`spawn` return) | the principal's controller: `recv`/`request`/`holds`/slot writes/`address` | handed to anyone but the principal's host-side owner |
| **MailboxCap** (`address`/attenuations) | the only authority to `tell()` an actor | invoked as an endpoint (`request` denies `E_RIGHTS`) |

Rights algebra: `{send, grant}` only. Mailbox reads are control-handle
possession; subtree revocation is a trusted-plane act. Both were
*v1.5 `recv`/`revoke` "rights", which enforced nothing and are removed.*

## Invariants

| # | Invariant | v1.6 status (this repo) |
|---|---|---|
| 1 | **Zero ambient authority** — a new agent's capability table starts empty. | enforced, tested — tokens expose no state; handler/membrane ctx carries frozen metadata only; a public ActorId grants nothing anywhere |
| 2 | **Monotonic decay** — derived rights ⊆ source rights, always. | enforced, tested — rights live in runtime-private WeakMaps; holder mutation is impossible, not merely checked |
| 3 | **Full mediation** — every cross-principal call checks capability + rights. | enforced, tested — `tell` needs a mailbox capability with `send` on the receiver; `request` needs `send` on an endpoint cap; delegation needs `grant` AND the target's control handle (consent, `E_OCCUPIED` on overwrite without `overwrite: true`); `recv`/`holds`/`address` are control-handle possession |
| 4 | **Non-forgeable identity** — the receiver's view of the sender is substrate-bound, never payload-borne. | simulated (runtime-branded control handles; forged ActorId lookalikes are inert; payload identity ignored) — transport-bound stamping is ROADMAP M3 |
| 5 | **Atomic creation** — spawn is all-or-nothing; no half-authorized child runs. | not applicable in-process; normative for M5 |
| 6 | **Revocation reachability** — delegation enters the derivation tree; revoked roots kill every descendant. | enforced, tested — `revoked` is private state; un-revoking from the holder side is impossible; revoked mailbox caps deny `tell` |
| 7 | **Memory isolation** *(kernel-only)* — no ungranted reads/writes across spaces. | in-realm analogue enforced: clone-or-fail in BOTH directions (args `E_CANON` before any membrane sees them; un-cloneable results fail the xact, `E_CLONE` — no shared-reference fallback); address-space isolation normative for M5 |
| 8 | **Pointer safety** *(kernel-only)* — untrusted references validated before dereference. | normative for M5 |
| 9 | **Explicit completion** — success / failure / cancel / timeout / waiting-approval / waiting-resource are distinct states. | enforced for the caller-facing contract: `cancel()`/`tick()` settle outcomes regardless of handler cooperation; `ok/fail/cancelled/timeout` journaled; `shed`/`expire` queue states; cancellation means **delivery cancelled**, and the ledger says so (`delivery:"cancelled"` + later `handler_settled` facts); approval pending M2 (shape owned by S2) |
| 10 | **Audit completeness** — allows *and* denials at the mediation point are journaled; no bypass path. | enforced within the documented scope: the ledger is a PRIVATE sink (`rt.journal` no longer exists); `verifyJournal()`/`journalEntries()` are snapshot-only views, `record()` is a trusted-plane append; grant/revoke foreign denials now journal too; internal xacts are runtime-lifetime unique and caller labels ride `correlationId`. Chain is in-memory, internally hash-consistent — NOT evidence-grade until externally anchored (M3+) |
| 11 | **Policy outside the model** — output may request, never widen. | enforced, tested — membrane state is private per grant subtree; holders cannot drop or rewrite membranes; membrane-rewritten args are re-isolated by a second clone |
| 12 | **Protocol decoupling** — MCP/A2A changes never alter the substrate ABI. | by construction (no wire layer yet) |

## Value & identity discipline (v1.6)

- **Hashed values live in a frozen plain domain**: null, booleans,
  finite numbers, strings, bigints, arrays, plain objects (cross-realm
  safe prototype test). Date/Map/Set/class instances/`undefined`/
  non-finite numbers deny with `E_DOMAIN`. Encoding is type-tagged
  (`["n",0]` ≠ `["n","0"]`, bigint ≠ string), removing the v1.5
  sentinel collisions; cyclic values deny (`E_DOMAIN`), not stack-overflow.
- **`correlationId`** is the caller's label: journaled alongside the
  substrate-unique internal xact on allow and deny paths; it is what
  makes S1's evidence-backed completion checkable against the ledger.
- Error codes: `E_FOREIGN`, `E_NO_CAP`, `E_RIGHTS`, `E_REVOKED`,
  `E_ATTENUATE`, `E_INVAL`, `E_OCCUPIED`, `E_CANON`, `E_CLONE`,
  `E_DOMAIN`, `E_DEADLINE`, `E_TIMEOUT`, `E_CANCELLED`, `E_SHED`,
  `E_BUDGET`, `E_POLICY` (substrate); `E_STATE`, `E_APPROVAL`,
  `E_NO_EVIDENCE` (S1 APM layer).

## Acceptance tests (mapped to `test/runtime.test.mjs`; finding refs = 2026-09-19 external review, A-refs = internal re-audit of `192a4c1`)

| Test | v1.6 |
|---|---|
| zero-authority | — *zero ambient authority; tokens expose no authority state*; *ActorId rejected by every privileged call + forged lookalike inert (A1)* |
| attenuation | — *monotonic decay still enforced on the token API* |
| revocation | — *revocation cascade is not undoable by holders*; *revoked mailbox cap tells E_REVOKED* |
| full mediation (messaging) | — *tell requires destination mailbox cap (F1a)*; *send-only cannot delegate* (inverted oracle: `grantCap(rt.address(rt.identityOf(other)), …)` now **denies `E_FOREIGN`**, A2); *mailbox cap not invokable / endpoint cap not tellable*; *slot-hijack constructively impossible + E_OCCUPIED consent (A1/A5)* |
| identity anti-forge | — *payload identity never trusted; sender substrate-stamped* |
| no reverse authority | — *handler ctx immutable metadata only*; *handler cannot mutate caller args (clone at admission)*; *membrane never sees caller-owned object* |
| value discipline | — *uncloneable args E_CANON / cyclic args E_DOMAIN*; ***cyclic RESULT FAILS E_DOMAIN** (inverted oracle, A4)*; *uncloneable result E_CLONE (no fallback)*; *results cross by independent clones*; *E_DOMAIN for undefined/NaN/Infinity/Date/Map/Set*; *sentinel-collision-gone battery* |
| audit completeness | — *every denial class journaled at the chokepoint (F8)* incl. foreign grant/revoke (A6); *`rt.journal = fake` cannot silence the ledger (A3)*; *journalEntries snapshots inert; conforming getter throws on assign*; *record() appends verified facts* |
| explicit completion | — *cancel settles hung handler (F4, F9)*; *tick() enforces deadlines (F4)*; *late result withheld*; *xacts runtime-unique, never recycled*; *consecutive grant denials carry distinct xacts (A7 — v1.5 `x${seq}` non-increment bug)* |
| deadline/cancel | — *past deadline denies before admission*; *abort signal cancels*; ***AbortSignal listeners removed on settle (A10, listener-count probe)*** |
| queue liveness | — *expired head unblocks waiter (F5)*; *cancel promotes (F5b)*; *blocked sends resolve never reject (F6)*; *waiters bounded* |
| hash domain | — *canonical hashes type-tagged, cycle-safe, total on the plain domain (F11)* |
| xact identity | — *correlationId journaled on allow+deny*; *runtime-branded E_FOREIGN (F14)* |
| budget scope | — *membrane budgets per grant subtree (F15)*; *charged-attempt ordering (F15b)* |
| non-conforming seam | — *bench sink explicit, journal unreachable (F7)* |
| APM lifecycle (S1) | `test/intent.test.mjs`: *evidence-backed completion gate*; *approval precedes effect*; *budget + envelope membership*; *fork/delegate/handoff/suspend/resume(new model)/revoke cascade*; *context lineage isolation + merge accept/reject*; *deadline failure journaled at intent level* |
| atomic spawn | pending M5 (kernel backend) |
| pointer fault | pending M5 |
| context isolation | pending M4 (S1 Context is the incubator) |
| approval binding | pending M2 — **blocked** (digest precondition + S2 shape) |
| protocol boundary | pending (no wire layer) |

Contribution rule: any change to `src/runtime.js` MUST keep rows 1, 2,
3, 6, 10, 11 green and MUST add a negative test — written from the
realm-code adversary's point of view, never assuming they lack the
Runtime they were given — for any newly-enforced invariant before
claiming it.
