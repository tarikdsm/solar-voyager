# ADR-023: Explicit initial visual tier

**Status:** accepted (2026-07-16)

## Context

ADR-022 reconciled the Moon's authored texture tier with the 8 MiB initial-path
budget. Before the visual ladder existed, the budget checker conservatively
classified every Sun, Earth, Moon, and star file as startup-critical. T0041
makes full glTF models and their hero textures lazy, so that filename heuristic
would count resources the browser does not request before interaction and would
no longer describe the actual startup path.

The runtime also needs local KTX2 and Draco decoders. Depending on a CDN would
make loading nondeterministic and unavailable offline, while loading every body
model eagerly would defeat both the network and frame-time budgets.

## Decision

The initial runtime path is declared by `data/initial-path.json`, schema version
1. Its `files` list contains repository-relative files required before the first
interactive frame. The budget checker validates every entry for containment,
existence, file type, and duplication, then sums each canonical file once. It
also conservatively counts every built JavaScript, CSS, HTML, and WASM file.
Repositories without the explicit file retain the former name-based fallback so
the checker remains usable before an ingest has been generated.

Only sphere-tier resources for Sun, Earth, and Moon may be eager. Full glTF
models and hero textures are tier 3 and remain lazy for every body, including
those three. Ingest emits a dedicated ETC1S albedo for sphere rendering:

- 2048x1024 for planets;
- 1024x512 for moons, dwarf planets, asteroids, and comets.

The pinned Three.js Basis and Draco JavaScript/WASM decoders and the matching
Three.js license are copied into `public/assets/codecs/` by ingest. No runtime
decoder is fetched from a third-party origin.

## Consequences

- The 8 MiB gate measures the declared first-frame payload instead of lazy hero
  resources that happen to contain a prominent body name.
- A change to startup loading must update the explicit manifest and therefore
  becomes visible in review and CI.
- Tier-2 spheres retain geographic albedo at a bounded resolution, while the
  higher-resolution ADR-022 Moon maps remain available only with the lazy full
  model.
- Local codec bytes remain budgeted through the conservative built-code/WASM
  rule and deployment is deterministic and offline-capable.
- This ADR supersedes ADR-022 only for startup membership. ADR-022's authored
  Moon texture and geometry decisions remain in force.
