# Texture sources — ship

The ship is an original vessel, not a photographed body, so nothing here is
fetched: all four maps are **authored procedurally** and their generator is the
source of truth. Under ADR-039 the pixels are not committed; this file is the
reproduction recipe.

## Regenerate

```bash
npm run textures:ship          # writes the four PNGs into this directory
```

The build is deterministic — every value comes from an integer hash of its own
pixel or panel coordinates, with no RNG, no clock and no dependence on
iteration order — so a clean run reproduces the committed KTX2 artefacts
byte for byte. `tools/blender/build_ship.py` then copies these files verbatim
into `assets/models/ship/` (which *is* committed, as the asset deliverable) and
wires them as external images; `npm run assets:ingest` encodes them to KTX2.

`npm run test:blender` runs the whole chain from nothing: regenerate → build →
build again → compare SHA-256 → ingest.

## Files

- `ship_mat_hull__albedo.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset; all rights reserved for project distribution — 2048×1024 sRGB hull plating: irregular bay layout, panel grooves, rivet rows, painted service panels, aft engine soot.
- `ship_mat_hull__normal.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — 2048×1024 tangent-space normal, central-differenced from the same height field as the albedo, seamless in U.
- `ship_mat_hull__metallic.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — 2048×1024 glTF metallic-roughness map: G is roughness, B is metalness, R held at 1.0 (no occlusion).
- `ship_mat_engine_glow__emissive.png` — `tools/textures/generateShipTextures.mjs` — Solar Voyager original asset — 2048×1024 photon-drive throat emission, mapped radially.

## Recipe

**Hull maps (`mat_hull`).** The UV space is the hull's cylindrical unwrap: `U`
is the ring angle (seam on the dorsal spine, where the structure hides it), `V`
is the axial station by profile arc length. The map is divided into 8 bays
across `U` (256 px each) and 16 rows down `V` (64 px each); at the 2.1 m hull
radius that is a 1.65 m × 1.41 m cell, so the plating is close to square on the
real hull rather than stretched. Each bay is hashed into one of four
subdivisions (split in `U`, in `V`, in both, or not at all), which is what makes
the plating read as a built object instead of graph paper. Every resulting
panel is hashed again for its albedo value, roughness, metalness and height
offset, and 12 % of panels become painted service panels (low metalness, warm
tint) with a further 8 % dark composite. Panel edges are grooved, structural
frames every fourth row carry a weld bead and a rivet row, and a soot gradient
with hashed vertical streaks builds up toward the engine end.

The normal map is not drawn: it is the central difference of the same height
field the albedo and roughness read, wrapped in `U` and clamped in `V`, so the
three maps cannot disagree about where a groove is.

**Orientation trap.** Blender's glTF exporter writes `v_gltf = 1 − v_blender`,
and glTF's `V` origin is the *top* row of the image. Row 0 of these maps is
therefore the **nose** and the last row is the **tail** — which is why the soot
is at the bottom of the file. `generateShipTextures.test.mjs` pins this.

**Emissive map (`mat_engine_glow`).** Mapped radially by
`ship_config.project_radial_uvs`: `U` is the glow-disc radius fraction (0 at the
throat centre, 1 at the rim), `V` is the ring angle. The colour ladder runs
white-hot core → cyan → deep blue rim with concentric shock rings and a 24-fold
injector pattern, kept inside sRGB so the bloom pass owns the final intensity.
