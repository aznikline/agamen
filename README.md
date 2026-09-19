# agent-substrate

**Actors + object capabilities + membranes + provenance** — an experimental
execution form for AI agents that is deliberately *not* an operating system.

> Status: **v0 incubator.** ~200 lines, runs in-process on Node ≥ 20.
> Semantics proven here may graduate into the
> [Agate kernel](https://github.com/aznikline/agate) (see its
> `spec/13-agent-execution-substrate.md`); everything here stays userspace
> until it earns kernel ABI status.

## Why a new form instead of an OS

An OS multiplexes hardware among *trusting* processes. An agent substrate
mediates authority among **mutually suspicious, nondeterministic actors**:
model output is untrusted input, tools are potentially hostile, and the
principal that must answer for an action is often a human several hops away.
The workload's core needs — least privilege by default, runtime revocation,
identity that cannot be forged, policy that lives outside the model, and an
evidence trail per decision — are exactly the four primitives below, and none
of them needs a page table to exist.

## The four primitives

| Primitive | What it enforces | Kernel counterpart in Agate |
|---|---|---|
| **Actor** (`Actor`, `Runtime.tell/recv`) | Identity + mailbox; sender is runtime-bound, never message-borne | IPC with kernel-stamped `sender_encoding` |
| **Capability** (`Capability`) | Designation + rights; monotonic attenuation; subtree revocation | CNode slots, derivation tree, `cap_revoke` |
| **Membrane** (`rateLimit`, `policy`) | Policy between model and tool: arg vetoes, budgets, rewriting | endpoint cap + approval lease (P4) |
| **Provenance** (`Provenance`) | Append-only hash-chained journal; every invoke records the quad `(actor, tool, argsHash, resultHash)` | audit chokepoint (P4.3) |

## Quick start

```bash
node --test
```

```js
import { Runtime, rateLimit, policy } from "agent-substrate";

const rt = new Runtime();
const { server } = rt.serve("search-svc", "search", async ({ q }) => results_for(q));
const agent = rt.spawn("planner");

// explicit, decaying delegation — the agent starts with zero authority
rt.grant(server, "search", agent, "search", {
  rights: ["send"],
  membranes: [policy((x) => x.q.length < 64), rateLimit(10)],
});

await rt.invoke(agent, "search", { q: "capability revocation" });
rt.revoke(server.slots.get("search")); // kills every derived cap instantly
```

## Invariants (tested)

1. **Zero ambient authority** — fresh actors hold nothing.
2. **Monotonic decay** — derivation can only shrink rights.
3. **Revocation reachability** — revoking a root cascades to all descendants.
4. **Non-forgeable sender** — identity is bound by the runtime, not payload.
5. **Policy outside the caller** — membranes vet/limit/rewrite every call.
6. **Tamper-evident provenance** — the journal verifies or flags edits.

## Known v0 gaps (honest list)

- Caller identity is a passed reference; a caller can *impersonate itself*
  (in the kernel, EL0 cannot forge the stamp at all).
- Single-threaded, no scheduler semantics (deadlines, budgets, backpressure).
- No memory isolation — object graphs are shared within the process;
  membranes are the only confinement.
- `rateLimit` counters live in closures: revoking a cap does not refund or
  share budgets across siblings.

## Layout

```
src/runtime.js        the substrate: actors, caps, membranes, journal
test/runtime.test.mjs invariant suite (node --test)
docs/thesis.md        the design argument and graduation criteria
```

## License

MIT — see [LICENSE](LICENSE).
