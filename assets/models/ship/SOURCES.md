# Sources — ship

- `ship.glb` — original design, hand-authored interactively in Blender 5.1 via blender-mcp (2026-07-15). Source scene: `assets/blender/ship.blend` (committed hero asset per ADR-009). No external textures — PBR material factors only (`mat_hull`, `mat_hull_dark`, `mat_radiator`, `mat_canopy`, `mat_nozzle`, `mat_engine_glow` emissive); texture maps may be added in a later pass. Scale: 1 unit = 1 m, length ≈ 26 m; nose toward glTF −Z (three.js forward); `engine_nozzle` node named per MODELING-GUIDE §4 for plume attachment. 6,174 tris (budget ≤30k).
