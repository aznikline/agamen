# Agamen

**An execution substrate for AI agents — named for ἄγαν μένων, "the steadfast."**

Agamen is an independent evolution of the *agent-substrate* experiment: a
form for running mutually suspicious, nondeterministic agents that is
deliberately **not an operating system in the classical sense**. Its
normative core is a deterministic boundary — capabilities, stamped identity,
membranes, provenance — with hardware enforcement deferred to a pluggable
backend decision ([ROADMAP](ROADMAP.md) M5).

> Status: **M1** — v1 substrate with scheduling semantics (deadline / budget
> / cancel / backpressure), 15 tests, Node ≥ 20, dependency-free.
> [Why "Agamen"?](docs/name.md) · [Design thesis](docs/thesis.md) ·
> [Invariants (normative)](spec/invariants.md) · [Evaluation charter](docs/evaluation.md) · [Roadmap](ROADMAP.md)

## The five primitives

| Primitive | What it enforces | Invariant |
|---|---|---|
| **Actor** | identity + bounded mailbox; sender is substrate-bound, never message-borne; saturation sheds or blocks | #3, #4 |
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

rt.grant(server, "search", agent, "search", {
  rights: ["send"],
  membranes: [policy((x) => x.q.length < 64), rateLimit(10)],
});

await rt.invoke(agent, "search", { q: "capability revocation" });
rt.revoke(server.slots.get("search")); // kills every derived cap instantly
rt.journal.verify(); // provenance chain, tamper-evident
```

M1 adds scheduling as substrate states — an expired request never runs, and
every completion outcome is journaled under its xact:

```js
const { xact, promise } = rt.request(agent, "search", { q: "…" }, { deadline: t0 + 50 });
rt.cancel(xact);       // pending result is discarded, never delivered
// outcomes in the journal: ok | fail | cancelled | timeout; queue: shed | expire
```

## Layout

```
src/runtime.js                     the substrate (actors/caps/membranes/journal/schedule)
test/runtime.test.mjs              invariant suite
bench/run.mjs                      tier 1-2 measurement harness
bench/baseline.md                  fitted per-invoke cost model (M1)
spec/invariants.md                 normative invariants + threat model + acceptance
                                   (inherited from agate spec 13, ids preserved)
kernel/uapi/                       reference ABI seed (capability rights algebra)
docs/name.md                       the Agamemnon case
docs/thesis.md                     the form, and the backend question
docs/evaluation.md                 measurement charter (quantitative method)
ROADMAP.md                         M0–M5
```

## Relationship to Agate

[agate](https://github.com/aznikline/agate) is the predecessor: a capability
microkernel that proved invariants #1/#2/#6/#10 are enforceable with page
tables and EL0 traps. Agamen inherits its normative core (same invariant
numbering), cites it as prior art, and treats it as one candidate enforcement
backend (M5b) — not the destination. Agate stays its own project; nothing in
this repo is required of it.

## License

MIT — see [LICENSE](LICENSE).
