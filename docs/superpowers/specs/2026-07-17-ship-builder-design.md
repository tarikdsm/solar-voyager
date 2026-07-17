# Ship Builder Design

**Task:** T0034 — Ship model (`build_ship.py`)

**Status:** Approved under the maintainer's standing approval to continue autonomously.

## Goal

Replace the hand-authored-only ship workflow with a deterministic Blender builder that preserves the approved ship silhouette, emits a guide-compliant authored GLB with external PBR maps, and produces an ingested Draco/KTX2 runtime asset within the 8 MiB ship budget.

## Chosen approach

The builder will recreate the existing 26 m silver exploration ship from Blender primitives: a tapered central hull and nose, engine skirt and separately named `engine_nozzle`, emissive engine disc, drive ring with four pylons, port/starboard radiators, canopy, RCS blocks, and antenna. Dimensions and material factors will be copied from the approved `assets/blender/ship.blend` reference; the script becomes the canonical source of the scene.

The builder will also generate four deterministic 1024×512 project-authored maps in `assets/models/ship/`:

- `ship_mat_hull__albedo.png`
- `ship_mat_hull__normal.png`
- `ship_mat_hull__metallic.png`
- `ship_mat_engine_glow__emissive.png`

The double underscore separates an exact glTF material name from the standard texture role. Ingest will interpret `<asset>_<material>__<role>.<ext>` as a material-scoped binding while preserving the existing unscoped conventions for celestial assets. Unknown material names will fail with an actionable error instead of silently binding to the first material.

## Geometry and coordinate contract

- One Blender unit equals one metre.
- The ship is approximately 26 m long and remains centered around the approved origin.
- The Blender longitudinal axis is +Y toward the nose; Blender's glTF export yields the existing three.js-facing orientation.
- `engine_nozzle` remains a separate open mesh node, is named exactly for the renderer attachment contract, and exposes the recessed emissive engine disc.
- Export contains only selected mesh objects: no camera, light, or animation.
- Applied geometry stays below 30,000 triangles; the target is close to the approved 6,174-triangle source.

## Materials and maps

The scene uses the approved material names: `mat_hull`, `mat_hull_dark`, `mat_radiator`, `mat_canopy`, `mat_nozzle`, and `mat_engine_glow`. The main hull receives albedo, tangent-space normal, and metallic/roughness input; the engine disc receives the emissive map at strength 2 so it remains bloom-ready without crushing the ship's dynamic range. Other components use deterministic Principled BSDF factors.

Maps are generated from fixed mathematical patterns without randomness, timestamps, machine paths, or network inputs. They remain external authoring deliverables; ingest binds their KTX2 derivatives to the named runtime materials and marks `KHR_texture_basisu` required.

## Verification

1. Unit tests prove material-scoped bindings target the named material and reject a missing target.
2. Headless Blender builds the ship twice into disposable directories; SHA-256 hashes of the GLB and maps must match.
3. Source validation proves the authored GLB contract, the `engine_nozzle` node, triangle budget, texture declarations, and attribution.
4. Focused ingest proves all four KTX2 files are present and total ship bytes remain below 8 MiB.
5. Full ingest regenerates `public/assets/` so the committed manifest and runtime files are canonical.
6. Blender renders a review image from the regenerated source, and the game asset is smoke-tested without console errors.
