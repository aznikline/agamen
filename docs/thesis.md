# Thesis: beyond the OS form

## 1. The category error

"AI-era operating system" inherits the wrong motivating motif. Classical OSes
multiplex *scarce hardware* among *cooperating, trusted* programs; security
there is an afterthought bolted onto ambient authority (UIDs, paths, open FDs).
Agent systems invert every term: the scarce resource is **trust and
attention**, the programs are **nondeterministic and mutually suspicious**, and
the accountable principal is a **human several delegation hops away**.
Building this as "an OS" means solving page tables and drivers all over again
while the actual hard part — authority mediation among untrusting actors —
stays unaddressed.

## 2. The four-primitive core

v0 argues the irreducible substrate is:

1. **Actor** — identity + mailbox, asynchronous message passing. Computation,
   not memory, is the unit (Agha 1986). Nothing is "shared state by default";
   the classic actor critique of objects ("objects have too much state") is
   precisely the sandboxing property an agent runtime needs.
2. **Object capability** — the *only* way to reach anything is a held,
   attenuable, revocable token (Miller 2006). Designation and authority are
   fused: if you can name it, you can do what the rights bits say — no more.
   No side channel, no ambient path, no confused deputy by construction.
3. **Membrane** — a derived capability may attach arbitrary mediation
   (arg veto, budget, rewriting, logging). This is where *model-outside policy*
   lives: a membred cap is the smallest possible surface you can hand to
   something you do not trust, which is what an LLM's output effectively is.
4. **Provenance** — every mediated event appends to a hash-chained journal
   carrying the quad (actor, tool, argsHash, resultHash) under a correlation
   id. Accountability is the substrate's output stream, not an observability
   add-on: replay, audit, and human approval all read the same ledger.

Everything else — scheduling, memory, networking, model adapters — is
*infrastructure around this core* and should stay out of the TCB unless it is
provably part of the authority decision.

## 3. The operating model, not just the boundary

The substrate's boundary is necessary but it is not the product. The
product is an **operating model for agency**: an answer to "what is a
long-running, delegable, suspendable, forkable, auditable, fallible AI
agent, as a computational object?" — in the way "process" answered that
question for programs. The test applied to every candidate primitive:
*if implementing it as a Linux library would behave exactly the same, it
is not an OS primitive* (it is a library concern, and this project
should not claim it).

This splits the roadmap into two DAGs that must never be merged:

- **Track S (semantic).** The shape of agency: Agent Principal,
  Task/Intent, delegation graph, approval/attention state, context
  lineage, fork/resume/handoff, evidence-backed completion. First
  artifact: the Agent Process Model (`src/intent.js`, ROADMAP S1) —
  `complete()` refusing an agent whose claim the ledger cannot back is
  the milestone's thesis in one gate.
- **Track E (enforcement).** Where the above must be enforced instead
  of trusted: same-realm tokens → transports → hardened userspace →
  agate guest → own kernel. Governed by §5's criteria below.

Agamen's relationship to a kernel — including agate — lives entirely in
track E: **Agate enforces; Agamen defines what should exist.** A
semantic claim is never diluted to whatever is currently enforceable
(that is how v1 got its five BLOCKERs: the enforcement gap silently
reshaped the model); an enforcement claim is never grown beyond what a
negative test has actually closed. The labels
`enforced / simulated / normative` in `spec/invariants.md` are the
mechanism that keeps the two graphs from contaminating each other.

## 4. Relationship to Agate

Agate (capability microkernel, same author) is the **ancestor and prior
art**: it enforces a kernel subset of these invariants with page tables and
EL0 traps. The mapping is 1:1 on purpose:

| Substrate (here)          | Agate (kernel)                       |
|---------------------------|--------------------------------------|
| `Actor.slots`             | CNode (per-process capability table) |
| `Capability.attenuate`    | `cap_copy` GRANT-gated derivation    |
| `Capability.revoke`       | CDT subtree revoke (`cap_revoke`)    |
| `Runtime.tell` stamping   | `sender_encoding` in IPC header      |
| `Membrane`                | endpoint caps; approval lease (P4)   |
| `Provenance`              | audit chokepoint (spec 13 §13)       |

Agamen is form-first: semantics are argued, broken, and measured in ~500
lines of JavaScript before any of them costs a kernel ABI. Since M1.6 the
in-realm enforcement is not merely a demonstration: the negative tests
(`test/runtime.test.mjs`) treat realm code holding legitimate tokens as
the adversary (the Runtime itself is the trusted control plane), so the
milestones are executable semantics *and* enforced semantics up to the
boundary of the JavaScript realm. The mapping above is a migration
contract for track E only, not a submission queue — agate is one
*candidate enforcement backend* for these semantics (ROADMAP M5),
alongside a hardened userspace runtime or, eventually, Agamen's own
kernel. The graduation criterion is deliberately
narrow: a primitive earns kernel cost only when the remaining gap is
something userspace provably cannot close (realm-crossing identity,
preemption, atomic creation), not because the JS enforcement was inconvenient.

## 5. Enforcement criteria (when a primitive moves below the substrate)

A primitive becomes an *enforcement backend's obligation* (agate, a hardened
runtime, or Agamen's own kernel — see ROADMAP M5) only when all of the
following hold:

- it is on the **authority decision path** (without it, an invariant is
  enforceable only by convention);
- its semantics are **stable across ≥ 3 workload shapes** (tool call,
  sub-agent spawn, approval round-trip);
- a **negative test** exists proving unforgeability in-process first;
- the kernel gains more than it costs: the change must not widen the TCB for
  features that could live in a verified-by-convention userspace service.

Current candidates ranked: **(a) approval lease** (atomic mint+expiry+use-count
— races are unfixable in userspace), **(b) budget-as-kernel-object** (membrane
counters are per-closure today; a runaway needs kernel-visible accounting),
**(c) cross-process provenance merging** (xact correlation across vspaces).

## 6. Reading that shaped this

- M. Miller, *Robust Composition* (2006) — ocap, membranes, the confused deputy.
- G. Agha, *Actors* (1986) — the computational form.
- Saltzer & Kaashoek, *Principles of Computer System Design* (2009) — the
  end-to-end argument used as the TCB discipline above.
- Agate spec 13/14 — the kernel-side invariants this incubator mirrors.
