# ADR-022: Startup Moon texture tier

**Status:** accepted (2026-07-16)

## Context

T0033 requires a 4096x2048 lunar albedo, a 2048x1024 normal, and an initial
code+Sun+Earth+Moon+stars payload below 8 MiB. Later modeling-guide text grouped
the Moon with Earth and Mars at 8192x4096 albedo and 4096x2048 normal. Those
requirements cannot both hold.

After T0032, the measured non-Moon task payload is 6,535,970 bytes and leaves
1,852,638 bytes. A KTX2 prototype of the larger Moon tier consumed 13,787,812
bytes before mesh and manifest. A direct 4k/2k prototype consumed 3,170,822
bytes. This is a contract conflict, and the performance specification says that
budgets are mandatory rather than a later polish pass.

ADR-010 separately established the Sun as a procedural Tier A object and made a
static texture only an optional fallback. Adding an SDO texture to the initial
path would spend budget without replacing the procedural runtime treatment.

## Decision

The startup Moon uses:

- a 4096x2048 albedo prepared from NASA SVS's 8192x4096 LROC color map;
- a scale-separated 2048x1024 macro normal prepared from LOLA elevation;
- periodic 1024x1024 detail albedo and normal maps for close-range regolith;
- a displaced 128x64 mesh whose maximum normalized radius is exactly 1.0.

The macro normal is filtered and quantized specifically to retain large-scale
relief while compressing efficiently. Fine relief belongs to the independently
tiling detail pair. A measured prototype of this four-texture set consumes
1,504,870 bytes after ingest, leaving room for the mesh and metadata under the
task's startup gate.

Earth and Mars retain the 8k/4k hero tier. The Moon remains a hero asset for its
20 MiB per-body ceiling, but the validator applies this explicit 4k/2k source
tier first. Other major moons retain their documented default tiers and are
lazy-loaded. The named Moon may use the major-moon 50,000-triangle authoring
limit; ordinary moons remain capped at 15,000 triangles by ingest policy.

The Sun ships its existing deterministic emissive procedural fallback without
a static SDO texture, as allowed by ADR-010.

## Consequences

- The original T0033 tier and the hard startup budget agree again.
- Real LRO/LOLA geography is retained at the scale visible during startup;
  repeatable procedural detail supplies close-range frequency content cheaply.
- The modeling guide, pipeline table, and automated validation distinguish the
  startup Moon from Earth/Mars instead of using one ambiguous hero tier.
- A future higher-resolution lunar surface may be streamed after interaction,
  but it must be a separate lazy tier and may not silently enter the initial
  critical path.
