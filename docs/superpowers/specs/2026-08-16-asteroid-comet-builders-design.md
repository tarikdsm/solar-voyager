# Asteroid and comet builders — design (T0131)

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §6.1;
plan `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §5 T0131; pipeline contract
`docs/asset-pipeline.md` and `assets/models/MODELING-GUIDE.md`.

This task delivers the *tooling*, not the bodies. T0138 (six asteroids) and T0139 (two comets)
are the first consumers; every decision below was taken to make those two tasks a checklist.

## 1. The decision space I actually faced

### 1.1 Determinism of smooth normals — the blocking constraint

`docs/asset-pipeline.md` records that Blender 5.1's smooth-normal calculation is
process-dependent, which is why `common/glb.canonicalize_ellipsoid_normals` re-derives every
float32 normal analytically from the exported position and the catalogued polar ratio. That
function only works for an ellipsoid: `n = normalize(x, y/k², z)`. A displaced icosphere or a
decimated shape model has no closed-form normal.

Options considered:

1. **Flat shading.** Kills the whole point of a smooth regolith surface and still leaves Blender
   computing face normals.
2. **Ship the ellipsoid canonicalizer with ratio 1.0**, i.e. radial normals. Byte-deterministic
   and one line of code, but it shades a lumpy body as if it were a sphere — craters and lobes
   disappear under lighting. Rejected: the whole visual point of §6.1 is that 67P looks bilobed.
3. **Generalize the existing pass**: recompute vertex normals *in the same post-export GLB
   canonicalization step*, in float64 Python, from the exported float32 positions and the
   already-canonicalized triangle order. Chosen.

Option 3 is deliberately *not* a second determinism scheme. It is the same scheme
(`export → canonicalize the binary chunk from data already in the file`) applied to a shape that
has no analytic normal. `canonicalize_mesh_normals(path)` in `common/glb.py`:

- welds vertices by their **exact float32 position bits**, so the seam-split duplicates the glTF
  exporter creates for UV seams share one normal (this is what makes it match Blender's smooth
  shading instead of producing a visible seam);
- accumulates **area-weighted** face normals in canonical triangle order (the triangle list has
  already been sorted by `canonicalize_triangle_indices`, so the accumulation order is a pure
  function of the mesh);
- normalizes in float64 and writes float32.

Order of operations in `export_glb` matters and is now explicit: indices are canonicalized first,
then texcoords, and `canonicalize_mesh_normals` is called by the builder afterwards — it depends
on the canonical triangle order.

Degenerate triangles contribute zero area and therefore zero weight; a vertex whose entire
1-ring is degenerate falls back to the normalized position (the body is star-shaped about its
origin after normalization, so the radial normal is the correct limit).

### 1.2 Mesh generator: Blender's icosphere vs. our own geodesic sphere

Blender's `primitive_ico_sphere_add` only produces subdivision levels, i.e. `20 · 4^(k-1)`
triangles: 1,280 at level 4 and 5,120 at level 5. 5,120 **exceeds the 5,000 category budget**, so
the operator forces us to ship asteroids at 1,280 triangles — 26% of the budget.

A class-I geodesic sphere of frequency *n* has exactly `20 n²` triangles. **n = 15 → 4,500
triangles**, 90% of the budget for the same topology family (it *is* a subdivided icosahedron —
the plan's "displaced icosphere" — just not at a power-of-two frequency). We therefore build the
mesh ourselves in `common/geodesic.py` (pure Python, no `bpy`) and hand it to
`bpy.types.Mesh.from_pydata`.

Second benefit: vertex ordering becomes a pure function of our own loop nesting instead of a
Blender operator's internals, which removes an entire class of determinism risk.

The subtle part is welding the shared lattice points of adjacent base faces. Interpolating
`(i·A + j·B + k·C)/n` in the caller's corner order gives *different* float64 results for the same
physical point reached from two different faces, so a coordinate-keyed weld would fail. Instead
each lattice point carries an exact rational key `((corner_index, weight), …)` sorted by global
corner index, and the position is summed in that same canonical order. Shared points are then
bit-identical by construction, and the key doubles as the weld key.

### 1.3 Procedural shape: what "seeded by proceduralSeed" has to mean

`data/bodies.json` gives us `visual.proceduralSeed` and `visual.albedoColor` per body and nothing
else about shape. Triaxial axis ratios are *not* in the catalog and adding them would be a
`bodies.json` schema change, which needs an ADR (global constraints). Out of scope for a tooling
task, so authored shape parameters (axis ratios, relief fraction, crater count) live in
`tools/blender/small_body_config.py` next to the builders, with per-body overrides and a
seed-derived default. `proceduralSeed` remains the only source of randomness.

Noise is a classic permutation-table 3D value noise with smoothstep interpolation and fBm
octaves, implemented in float64 Python in `common/procedural_shape.py`. Rationale: no numpy
dependency (the Python tool tests run on the system interpreter, not Blender's), exact
reproducibility across machines, and it is directly unit-testable without Blender. Craters are
analytic bowl + rim profiles at seeded directions.

The radius field is evaluated **per direction**, so it is identical whether it is applied to mesh
vertices or to albedo texels, and applying it radially leaves the vertex direction unchanged —
which is why UVs can be assigned after displacement and still be the equirectangular mapping.

### 1.4 Real shape models: pinned tier first, deterministic decimation second

NASA PDS SBN publishes the NEAR (Eros), OSIRIS-REx (Bennu), Hayabusa2 (Ryugu) and Rosetta (67P)
shape models as public-domain Wavefront OBJ at several resolution tiers. Two consequences:

- **OBJ is the only ingest format we support.** `common/shape_model.py` parses it in pure Python
  (`v` and `f`, with `f a/b/c` and negative-index forms), so the parser is unit-testable without
  Blender and cannot be perturbed by an importer add-on's settings.
- **Prefer a pinned tier that already fits the budget.** All four missions publish a tier at or
  below 5,000 facets. Decimation is the fallback, not the plan.

When the pinned tier is over budget we decimate with **uniform-grid vertex clustering**
(Rossignac–Borrel), not quadric-error decimation:

- Blender's `DECIMATE` modifier is a black box whose output can move between versions, and it is
  the exact class of thing the determinism rules exist to keep out of the export.
- Vertex clustering is order-independent by construction (cell membership is a pure function of
  position), collapses to a canonical, sorted, de-duplicated face list, and the grid resolution
  is chosen by a bounded binary search for the finest grid that still fits the cap.
- It loses fine relief. That is the right trade at 5,000 triangles for a body that is a few pixels
  across for 99% of the flight; the silhouette and the concavities (Eros's saddle, 67P's neck)
  survive, which radial resampling onto a sphere would not.

### 1.5 The fetch seam (this was the coordination point with T0132)

T0132 owns `tools/fetch_textures.py`'s checksummed manifest and was landing in parallel, so this
task was designed blind against it: the builders never fetch anything, they consume a **verified
local file** and declare the entry the manifest must produce.

T0132 has since merged, and the seam lines up. Its `TextureRecipe` grew `kind="file"` for exactly
this case — non-image sources such as `.tab`/`.obj` shape models, copied byte-for-byte after
checksum verification instead of going through Sharp — and `role="shape"` is already listed as a
valid role in `agents/skills/add-celestial-body.md`. The one thing I changed after reading the
merged file: `SHAPE_ROOT` now defaults to `assets/textures-src` rather than a separate
`assets/shape-src`, because `TextureRecipe.dest` is hardcoded to
`assets/textures-src/<body_id>/<output_name>` and that tree is already gitignored except for
`SOURCES.md`. A builder must read where the fetcher writes; inventing a second root would have
cost T0138 a gitignore rule and an argument.

`small_body_config.ShapeModelSource` is field-compatible with `TextureRecipe`:

| field | meaning |
|---|---|
| `id` | manifest recipe id, e.g. `eros-shape` |
| `body_id` | catalog id (`eros`, `67p`) |
| `role` | always `shape` |
| `source_url` | exact pinned download URL (**`None` until a `RECIPES` entry pins it**) |
| `product_url` | PDS SBN landing page |
| `license` | public-domain statement |
| `credit` | attribution line copied into `SOURCES.md` |
| `sha256` | pinned lowercase SHA-256 (**`None` until a `RECIPES` entry pins it**) |
| `output_name` | file name inside the fetch root, e.g. `eros_shape.obj` |
| `model_format` | `obj` — the only format `common/shape_model.py` parses |
| `dataset` | prose description of the pinned tier, for review and `SOURCES.md` |

Destination: `assets/textures-src/<body-id>/<output_name>`, i.e. `TextureRecipe.dest`.
`--shape-root` overrides it for tests.

**Deliberately unpinned.** I did not invent URLs or checksums. `source_url` and `sha256` are
`None`, and `validate_shape_source()` rejects the real-model path while they are, so `--shape
real` fails loudly with a message naming the fix rather than silently shipping a procedural Eros.
Adding the four `kind="file"` `RECIPES` entries and copying their `source_url`/`sha256` into
`SHAPE_MODEL_SOURCES` is the whole remaining integration.

### 1.6 Comet anchors — the API T0139 consumes

`coma_anchor` and `tail_anchor` are exported as **mesh-less glTF nodes at the scene root** of the
comet GLB. Verified against Blender 5.1: an unparented Empty survives `use_selection=True` export
as a plain named node carrying its scale, and glTF-transform's `measureDocument` ignores it when
measuring the normalized body (it filters to the node named after the body id), so the anchors
cannot break the radius/origin contract.

Contract, in the normalized body frame (1.0 unit = nucleus mean radius, glTF +Y up):

- `coma_anchor` — translation `(0, 0, 0)`, identity rotation, **uniform scale = authored coma
  radius in nucleus radii**. The coma billboard is centred on the nucleus; its radius is
  `node.scale.x`.
- `tail_anchor` — translation `(0, 0, 0)`, identity rotation, **uniform scale = authored tail
  length in nucleus radii**. The tail root coincides with the coma centre (a real tail root offset
  is far below one nucleus radius); direction is *not* authored — T0139 computes it from sim state
  (anti-sunward blended with orbital lag, per its own handoff note).

Scale, not a glTF `extras` blob, carries the magnitude: `export_extras` is currently off for every
builder and turning it on would change unrelated exports, whereas node scale is already exported,
already read by three.js's `GLTFLoader` into `Object3D.scale`, and needs no extension.

Rejected: putting the anchors on the nucleus as child nodes (adds a transform the ingest
`primaryTransformIdentity` check would have to reason about), and encoding the coma radius in the
catalog (a `bodies.json` schema change → ADR).

### 1.7 What the builders do *not* do

- **No vertex-colour AO.** `MODELING-GUIDE.md` §2 permits vertex colours on asteroids and
  `asset-pipeline.md` described baked AO. Blender's AO bake is a sampled, non-deterministic
  operator, nothing in `render/` currently enables `vertexColors`, and Draco would have to carry a
  fourth attribute nobody reads. The mottling that AO was there to provide is baked into the
  generated albedo instead. `asset-pipeline.md` is corrected in the same commit series.
- **No emissive nucleus.** Comet nuclei are among the darkest surfaces in the solar system; the
  glow belongs to T0139's coma sprite, not to the mesh material.
- **No committed bodies.** T0138/T0139 own `assets/models/asteroids/*` and
  `assets/models/comets/*` and their full per-body checklist. This task ships the builders, their
  tests, and the determinism gate.

## 2. Landmines found in existing code

1. **`build_all.discover_builders` would have crashed on day one.** It requires every
   `build_<id>.py` to have `<id>` in `data/bodies.json`; `asteroid` and `comet` are categories,
   not bodies. Both are added to `EXCLUDED_BUILDERS` alongside `planet`. T0138/T0139 add
   `build_eros.py`-style one-line delegating shims exactly like `build_earth.py`.
2. **Ingest requires an albedo texture for every asteroid and comet.**
   `assetIngest.validateTextureTier` treats `asteroids`/`comets` as `requiresSurface` and demands
   a 1k–2k 2:1 `<id>_albedo`. A geometry-only builder would have failed ingest, so both builders
   generate a deterministic 1024×512 albedo and list it in `SOURCES.md` (also mandatory — every
   deliverable must appear there or ingest reports it).
3. **`build_manifest` cannot be handed an Empty.** It calls `evaluated.to_mesh()`; anchors must be
   excluded from the manifest object list and passed only to `export_glb`.
4. **`build_ship.py` never canonicalizes its normals** and has smooth-shaded objects, so the ship
   GLB is a latent double-build determinism hazard that `npm run test:blender` does not cover
   (it only builds the test sphere). Out of scope here; recorded for T0121.

## 3. Verification design

`npm run test:blender` is extended to be the real determinism gate: it builds a procedural
asteroid and a comet twice into disjoint roots and requires byte-identical GLB **and** albedo
PNG, and asserts the comet GLB carries exactly the two anchor nodes with the documented
translation/rotation. Everything else is pure-Python unit tests in `tools/tests/` (`npm run
test:tools`), which run in CI where Blender does not exist:

- geodesic frequency → exact `20 n²` triangles, closed manifold, shared-edge welding, stable order;
- noise/crater radius field: same seed → identical floats, different seed → different field,
  bounded output;
- OBJ parse (including `f a//b` and negative indices), clustering cap, clustering determinism
  under shuffled input order, normalization to radius 1.0 at the origin;
- shape-source seam: unpinned source rejected, path traversal rejected, checksum mismatch rejected;
- `canonicalize_mesh_normals`: identical bytes from two different triangle orderings, seam-welded
  normals equal, radial fallback for a degenerate 1-ring.
