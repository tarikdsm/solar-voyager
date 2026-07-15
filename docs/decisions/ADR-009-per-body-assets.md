# ADR-009: One asset per body, normalized scale — never a whole-system Blender scene

**Status:** accepted (2026-07-15)

## Decision

Every celestial body (and the ship) is authored as an **independent glTF asset at normalized scale** (body mesh radius = 1.0 unit; ship in real meters), delivered under `assets/models/<category>/<body-id>/` per `assets/models/MODELING-GUIDE.md`, ingested by `npm run assets:ingest` into optimized runtime artifacts. The game instantiates each body and scales it by the real radius from `data/bodies.json`. We never export the solar system as a single Blender scene.

## Why

1. **Blender is float32.** A real-scale system scene (Neptune at 4.5×10⁹ km) is numerically impossible inside Blender — vertices would collapse; even km-scaled scenes lose sub-meter precision. Per-body normalized assets sidestep this entirely.
2. **Positions are simulation output.** Bodies move on ephemerides rails evaluated per frame; a static scene's transforms would be dead weight fighting the sim.
3. **Lazy loading is a budget requirement** (8 MB critical path): per-body assets load on approach (rendering-spec tier ladder). A monolithic scene forces everything up front.
4. **Multi-agent parallelism:** one body = one deliverable = one task; agents never collide on a shared scene file.
5. **Normalization decouples art from data:** radius/oblateness/tilt live once in `bodies.json`; retuning a radius never requires re-exporting art.

## Consequences

- The engine owns scaling, axial tilt, and rotation (authored "upright", pole +Y).
- A source workspace (`assets/`) is now first-class alongside scripted builders: hand/MCP-authored models are accepted if they pass the guide + ingest validation; `.blend` sources for hero assets are committed under `assets/blender/` (gitignore exception).
- `public/assets/` is strictly build output of the ingest step (validation → Draco → KTX2 → budgets).
