# Why "Agamen"

**Agamen** (AG-uh-men) is taken from **Agamemnon**, and Agamemnon carries
three meanings this OS is built to inherit.

## 1. The name means "the steadfast"

Ancient readers already parsed Αγαμέμνων as **ἄγαν μένων** —
"very steadfast, remaining firm". An execution substrate is a promise of
steadfastness to a thousand nondeterministic actors above it: the boundaries
hold even when every component behind them is uncertain, self-modifying, and
possibly induced to misbehave. The kernel of the model is that the *model*
cannot vouch for itself; the substrate must.

## 2. The scepter is a capability with provenance

Iliad 2.100–108 traces Agamemnon's scepter: forged by **Hephaestus**, given
to **Zeus**, passed to **Hermes**, then Pelops, Atreus, Thyestes, and finally
Agamemnon — the visible emblem of authority handed down an explicit chain.
That is precisely the object-capability discipline:

| Homeric institution      | Substrate primitive                     |
|--------------------------|-----------------------------------------|
| the scepter itself       | capability (unforgeable designation)    |
| the succession chain     | derivation tree + revocation subtree    |
| "carried by heralds"     | IPC with runtime-stamped sender         |
| the witness of oaths     | provenance ledger (hash-chained)        |

Agamemnon's tragic failure at Aulis and Troy is, read coldly, a failure of
delegation control — authority granted ambiently, revoked too late. An OS
named after him takes that lesson as its design brief.

## 3. Lineage from Agate

The predecessor project, [agate](https://github.com/aznikline/agate), is
named for the gemstone (Greek *akhates*). **Aga-te → Aga-men**: same stem,
stone → bearer of the scepter. Agamen is not a fork of agate; it inherits
agate's normative invariants (see `spec/invariants.md`) and evolves the
*form* independently — actors and membranes first, hardware enforcement as a
pluggable backend decision (ROADMAP M5).

## Usage

- repo / product name: `agamen`
- runtime package: `agamen` (npm name reserved by first publish)
- spec references: "Agamen invariant #4" (numbering follows `spec/invariants.md`)
