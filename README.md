# Agamen

**An execution substrate for AI agents — named for ἄγαν μένων, "the steadfast."**

Agamen is an independent evolution of the *agent-substrate* experiment: a
form for running mutually suspicious, nondeterministic agents that is
deliberately **not an operating system in the classical sense**. Its
normative core is a deterministic boundary — capabilities, stamped identity,
membranes, provenance — with hardware enforcement deferred to a pluggable
backend decision ([ROADMAP](ROADMAP.md) M5).

> Status: **M1.5** — v1.5 hardened substrate: invariants enforced against
> hostile same-realm JS (opaque WeakMap-backed tokens, fully mediated
> messaging, honest cancellation/tick liveness), 32 tests, Node ≥ 20,
> dependency-free.
> [Why "Agamen"?](docs/name.md) · [Design thesis](docs/thesis.md) ·
> [Invariants (normative)](spec/invariants.md) · [Evaluation charter](docs/evaluation.md) · [Roadmap](ROADMAP.md)

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
rt.journal.verify(); // chain is hash-consistent for this process lifetime
```

Tokens are opaque: a capability/actor is a frozen `{id}` whose authority
state lives in runtime-private WeakMaps, so holder-side code — even hostile
same-realm JS — cannot forge rights, un-revoke, drop membranes, or reach the
target. Values cross principals by structured clone, never shared reference.

Messaging is capability-gated too (#3): holding an actor reference is not
authority to mail it. The mailbox root cap comes from `address()` and is
distributed by attenuation:

```js
const worker = rt.spawn("worker", { mailbox: 8, onFull: "block" });
rt.grantCap(rt.address(worker), agent, "worker-mbox", { rights: ["send"] });
rt.tell(agent, worker, { job: "index" });   // E_RIGHTS without the cap
const got = rt.recv(worker);                // { sender, msg, xact } — stamped, cloned
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

The journal cannot be switched off. `new Runtime({ bench: true })` swaps in
a constant-time, **non-conforming** audit sink for cost-model fitting only;
events are still generated and `rt.conforming === false` flags the deviation.

## Layout

```
src/runtime.js                     the substrate (actors/caps/membranes/journal/schedule)
test/runtime.test.mjs              invariant suite
bench/run.mjs                      tier 1-2 measurement harness
bench/baseline.md                  fitted per-invoke cost model (M1.5 snapshot)
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
