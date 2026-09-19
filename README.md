# Agamen

**An execution substrate for AI agents — named for ἄγαν μένων, "the steadfast."**

Agamen is an independent evolution of the *agent-substrate* experiment: a
form for running mutually suspicious, nondeterministic agents that is
deliberately **not an operating system in the classical sense**. Its
normative core is a deterministic boundary — capabilities, stamped
identity, membranes, provenance — with hardware enforcement deferred to
a pluggable backend decision ([ROADMAP](ROADMAP.md) M5). The project runs
on two tracks: the **semantic track** defines the operating model for
agency (what should exist — [S1: the Agent Process
Model](src/intent.js)); the **enforcement track** hardens it (where it
must be enforced). Agate *enforces*; Agamen *defines what should exist*.

> Status: **M1.6** — v1.6 substrate: authority-handle split (ActorId /
> ActorControl / MailboxCap), consent-gated slots, clone-or-fail value
> discipline, private hash-chained ledger; 49 invariant + 20 APM tests;
> Node ≥ 20, dependency-free. M2 (approval leases) stays blocked by
> design.
> [Why "Agamen"?](docs/name.md) · [Design thesis](docs/thesis.md) ·
> [Invariants (normative)](spec/invariants.md) · [APM (normative, S2)](spec/apm.md) ·
> [Evaluation charter](docs/evaluation.md) · [Roadmap](ROADMAP.md)

## The five primitives

| Primitive | What it enforces | Invariant |
|---|---|---|
| **Actor** | identity + bounded mailbox; the receiver's view of the sender is substrate-bound (runtime-branded reference; transport stamping is M3), never message-borne; saturation sheds or blocks | #3, #4 |
| **Capability** | designation + rights; monotonic attenuation; subtree revocation | #1, #2, #6 |
| **Membrane** | policy between model and tool: vetoes, budgets, rewriting | #11 |
| **Provenance** | hash-chained journal; every call records `(actor, tool, argsHash, resultHash)`, denials under the same xact | #10 |
| **Schedule** | deadline, budget, cancellation as substrate states; expired requests never execute; outcomes `ok/fail/cancelled/timeout` are distinct | #9 |

## Quick start

```bash
node --test
```

```js
import { Runtime, rateLimit, policy } from "agamen";

const rt = new Runtime();
const { server } = rt.serve("search-svc", "search", async ({ q }) => results_for(q));
const agent = rt.spawn("planner"); // zero ambient authority: holds nothing

// server's slot cap carries the `grant` right; delegation is mediated (#2)
rt.grant(server, "search", agent, "search", {
  rights: ["send"],
  membranes: [policy((x) => x.q.length < 64), rateLimit(10)],
});

await rt.invoke(agent, "search", { q: "capability revocation" });
rt.revoke(rt.holds(server, "search")); // kills every derived cap instantly (#6)
rt.verifyJournal(); // chain is hash-consistent for this process lifetime
```

Principals are reached by three distinct handles (v1.6): the **ActorId**
(a frozen `{id, label}` snapshot from `identityOf` — displayable,
comparable, accepted by no privileged call), the **ActorControl** (the
principal's controller: `recv`/`request`/`holds`/slot writes), and
**MailboxCap** capabilities (the only authority to `tell`). Authority
state lives in runtime-private WeakMaps, so realm code — even hostile
same-realm JS holding legitimate tokens — cannot forge rights, un-revoke,
drop membranes, or install into a slot without the target's consent.
Values cross principals by structured clone in both directions; a
result that cannot clone FAILS the transaction (`E_CLONE`).

Messaging is capability-gated too (#3): a public identity is not
authority to mail its owner. The mailbox root cap comes from `address()`
— which requires the target's control handle, i.e. the host's consent —
and is distributed by attenuation:

```js
const worker = rt.spawn("worker", { mailbox: 8, onFull: "block" });
const mbox = rt.grantCap(rt.address(worker), agent, "worker-mbox", { rights: ["send"] });
rt.tell(agent, mbox, { job: "index" }); // E_RIGHTS without the cap
const got = rt.recv(worker);            // { sender, msg, xact } — stamped, cloned
```

Scheduling is substrate state, not a convention — an expired request never
runs, `tick()`/`cancel()` settle the caller's outcome even if the handler
hangs, and every completion is journaled under its xact (#9, #10):

```js
const { xact, promise } = rt.request(agent, "search", { q: "…" }, { deadline: t0 + 50 });
rt.cancel(xact);   // caller rejected NOW; a hung handler's late result is
                   // journaled as `handler_settled`, delivery never happens
rt.tick();         // host-driven clock sweep: expires queued work
// outcomes in the journal: ok | fail | cancelled | timeout; queue: shed | expire
```

The journal cannot be switched off or reached: it is a private sink, and
`verifyJournal()` / `journalEntries()` (snapshot copies) are the only
views. `new Runtime({ bench: true })` swaps in a constant-time,
**non-conforming** audit sink for cost-model fitting only; events are
still generated and the `rt.conforming` getter reports the deviation.

## Agent Process Model (S2 spec: [`spec/apm.md`](spec/apm.md); S1 experiment: `src/intent.js`)

The semantic track's normative model — two graphs (delegation ≠ capability
derivation), the intent state machine with waiting states, CompletionContract,
delegation closure, and handoff epochs — is in `spec/apm.md`; S1's
`src/intent.js` is its first executable sketch. The layer's core objects:
`AgentExecution` (a principal that survives model rebinds) and `Intent`
(goal + authority envelope + budget + deadline + approval state + context
lineage) with fork / delegate / handoff / suspend / resume(model) / approve /
revoke / merge_context / complete(evidence). Enforcement stays in the
substrate; the layer owns lifecycle facts — and the gate is provable:

```js
const sys = new AgentSystem(rt);
const planner = sys.register("planner", { model: "m-alpha" });
const intent = sys.open(planner, {
  goal: { outcome: "report" }, budget: { calls: 10 }, contract: ["report_written"],
});
const slot = sys.grantFor(intent, server, "search"); // envelope cap, budget membrane
const { xact } = await sys.call(intent, slot, { q: "…" }, { for: ["report_written"] });
// the binding is recorded AS THE CALL LEAVES (CO-5); a completion claim
// can only select a binding the ledger already wrote — never re-label.
await sys.complete(intent, [{ xact, obligation: "report_written" }]);
```

## Layout

```
src/runtime.js                     the substrate (actors/caps/membranes/journal/schedule)
src/intent.js                      the Agent Process Model (Track S; spec/apm.md)
test/runtime.test.mjs              invariant suite (49 tests)
test/intent.test.mjs               APM lifecycle + negative suite (20 tests)
bench/run.mjs                      tier 1-2 measurement harness (paired protocol)
bench/baseline.md                  fitted per-invoke cost model (M1.6 snapshot)
spec/invariants.md                 normative invariants + threat model + acceptance
                                   (inherited from agate spec 13, ids preserved)
spec/apm.md                        S2: the Agent Process Model (normative)
kernel/uapi/                       reference ABI seed (capability rights algebra)
docs/name.md                       the Agamemnon case
docs/thesis.md                     the form, the two tracks, and the backend question
docs/evaluation.md                 measurement charter (quantitative method)
ROADMAP.md                         Track S (S0–S2.1) and Track E (M0–M5)
```

## Relationship to Agate

[agate](https://github.com/aznikline/agate) is the predecessor: a capability
microkernel that proved invariants #1/#2/#6/#10 are enforceable with page
tables and EL0 traps. Agamen inherits its normative core (same invariant
numbering), cites it as prior art, and treats it as one candidate enforcement
backend (M5b) — not the destination. The division of labor in one line:
**Agate enforces; Agamen defines what should exist.** Agate stays its own
project; nothing in this repo is required of it.

## License

MIT — see [LICENSE](LICENSE).
