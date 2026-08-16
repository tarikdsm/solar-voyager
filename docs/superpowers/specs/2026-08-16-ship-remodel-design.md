# T0121 — Ship remodel for close-up beauty (build_ship.py v2)

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §6.3.
Task block: `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §5, T0121.

## 1. The problem, stated precisely

In v1 the ship was a distant sprite. In v2 it is on screen at all times, in chase
and cockpit views, at 2–50 ship lengths. The v1 asset is 5,538 triangles — 18 % of
its own 30,000 budget — of untextured primitives with a 1024×512 procedural map
whose panel grid lands at a different scale on every part.

"Close-up beauty" is therefore a specific engineering target, not a polygon count:

- **Silhouette** must break up. A smooth cylinder reads as a prop at any range.
- **Panel breakup** must be continuous across the hull, not per-primitive.
- **Edges** must catch light. A bare 90° edge reads as a black line at 2 lengths.
- **The bell interior** must exist. The chase camera looks straight into it.
- **Nothing hidden** gets budget. Interior volume is invisible in every view.

## 2. Decisions

### 2.1 Pure-Python geometry, Blender as an adapter

`tools/blender/ship_geometry.py` (primitives) and `tools/blender/ship_config.py`
(part table) import nothing from `bpy`. `build_ship.py` shrank to an adapter that
copies textures, wires materials, converts `ShipPart` records to Blender objects
and asserts the contracts.

This follows the existing `ring_geometry.py` / `common/rings.py` split, and it
buys the thing that matters most here: **the node-name API, the ADR-025 axis, the
metre scale and the triangle band are gated by `npm run test:tools` in CI**, which
runs everywhere, while `npm run test:blender` needs a local Blender install and is
not in `ci.yml`. 73 unit tests cover geometry and contracts without Blender.

*Rejected:* keeping `bpy.ops.mesh.primitive_*` + modifiers. Operators depend on
context and selection state, the bevel modifier's output is opaque, and none of it
is testable outside Blender. It also could not give the hull one continuous UV
space.

### 2.2 Analytic split normals instead of Blender-computed shading

Every primitive emits one exact normal per face corner, and the builder installs
them with `mesh.normals_split_custom_set()` after marking all polygons smooth.
Blender never computes a normal for this asset.

This is the determinism rule from `common/export.py` applied at the source rather
than as a post-export repair. It also solves two real shading problems for free:
the cylindrical UV seam needs duplicated vertices, which averaged normals would
turn into a visible seam line; and a lathe needs smooth shading around the
circumference but a *hard* crease at each radius step, which per-station
`smooth` flags now express directly (`ProfilePoint.smooth`).

*Note for integration:* T0131 has generalised the post-export normal pass into
`canonicalize_mesh_normals()` in `common/glb.py`. That branch had not merged when
this landed, so this asset does not call it — and does not need to, because it
carries no Blender-computed normals. If the helper is applied later it must be a
no-op on `ship.glb`; if it is not, that is a finding.

### 2.3 One cylindrical UV space for the whole hull

`ship_config.project_hull_uvs()` re-projects every `mat_hull` face after
placement: `U` is the ring angle (seam on the dorsal spine, hidden by structure),
`V` is the axial station **by profile arc length**. Fuselage, ribs and bolt-on
plates therefore share one continuous panel grid instead of each carrying its own
texture scale. Seam-straddling faces are shifted past `u = 1` with the same trick
`common/geometry.py` uses for the equirectangular seam.

Arc length rather than `x` is deliberate: it keeps the plating from stretching
across the radius steps and down the nose taper.

The map is sized to that space: 8 bays of 256 px across `U`, 16 rows of 64 px down
`V`, which at the 2.1 m hull radius is a **1.65 m × 1.41 m** cell — close to square
on the real hull.

### 2.4 Grouping by material, not one node per part

18 meshes + 1 marker, down from the v1 asset's 24 nodes, while carrying 4.3× the
geometry. Small parts are merged into the mesh of their material; only nodes that
are **API** or that a later task must address stay separate.

This is the opposite of the merge T0109 and T0110 rejected, and for the same
reason: they rejected merging *because* it would bake away `engine_nozzle` and the
`rcs_*` nodes. Selective grouping keeps every consumed name and still lowers the
draw call count.

### 2.5 Where the triangles went

| Node | Material | Tris | What it buys |
| --- | --- | ---: | --- |
| `hull` | `mat_hull` | 6,208 | Lathed fuselage (72 seg, 20 bands, stepped profile), 5 ribs, 14 bolt-on plates |
| `hull_tip` | `mat_hull` | 624 | Nose cap; **API** |
| `hull_frame` | `mat_hull_dark` | 3,552 | Dorsal spine, ventral keel, 3 collars, docking ring, canopy frame, antenna mast + two-sided dish, greebles |
| `drive_ring` | `mat_hull_dark` | 1,456 | Ring torus + 4 pylons |
| `engine_skirt` | `mat_hull_dark` | 1,384 | Skirt, 4 turbopumps, 6 coolant lines |
| `engine_assembly` | `mat_nozzle` | 3,264 | Throat, gimbal ring, 16 cooling pipes, 3 bell stiffener hoops |
| `engine_nozzle` | `mat_nozzle` | 3,024 | Lined bell shell; **API** |
| `engine_glow_disc` | `mat_engine_glow` | 576 | Recessed glow well |
| `radiator_P` / `_S` | `mat_radiator` | 968 | Panel, 8 ribs, mounting arms |
| `canopy` | `mat_canopy` | 768 | Glass blister; **API** |
| `rcs_pod_1..4` | `mat_hull_dark` | 1,888 | Housing, base plate, 4 thruster bells each; **API** |
| `light_nav_l/r`, `light_beacon` | `mat_light_*` | 468 | Housing + lens; **API** |
| `cockpit_eye` | — | 0 | Meshless marker; **API** |
| **Total** | 9 materials | **23,580** | band 18,000–28,000; budget 30,000 |

Chamfered boxes (44 tris: 6 faces, 12 edge strips, 8 corner triangles) are used
for every greeble. The chamfer is the point — it is what makes an edge catch the
sun instead of reading as a black line.

The bell is a real shell: outer wall, 5 cm liner, rim annulus. 1,440 of its 3,024
triangles are the liner, and they are the difference between "an engine" and
"a hole you can see the inside of the ship through".

### 2.6 What stayed frozen

- **Length 26.12 m, exactly.** `src/render/shipVisual.ts` exports
  `SHIP_LENGTH_M = 26.12` and derives `SHIP_BOUNDING_RADIUS_KM` from it;
  `docs/rendering-spec.md` §3.1 quotes the derived 0.01306 km. A unit test now
  reads that constant out of the TypeScript source and fails if the two drift.
- **The model frame.** `+X` nose, `+Y` up and `+Z` starboard in the exported glTF,
  which is what `shipVisual.ts`'s `MODEL_TO_BODY` quaternion was measured
  against. `radiator_P` is still at glTF `−Z`, as the comment in that file states.
- **`hull_tip` on the axis through the model origin.** `shipVisual.noseNodeAlignment`
  dots the node's offset *from the root* against the physics forward vector, so
  the node origin must be on `+X` — not merely forward of the nozzle.
- **`engine_nozzle` open**, so the recessed glow reads through it.
- **Material names.** `mat_engine_glow` is the engine's emissive-animation hook per
  `MODELING-GUIDE.md` §6; the ingest binds `ship_mat_hull__*` by exact material name.

### 2.7 Authoring frame change

v1 built the ship nose-up along `+Y` and rotated the finished scene −90° about
`+Z`. v2 authors directly in the final frame (`+X` nose, `+Z` dorsal, `+Y` port)
and deletes `_orient_nose_to_positive_x`. Two frames in one file is a sign-error
generator; the axis contract is still asserted on the placed objects and again on
the exported bytes.

## 3. Textures

Four authored 2048×1024 maps from `tools/textures/generateShipTextures.mjs`
(albedo, tangent normal, glTF metallic-roughness, emissive), written to
`assets/textures-src/ship/` and copied verbatim into `assets/models/ship/` by the
builder. Full recipe: `assets/textures-src/ship/SOURCES.md`.

They are **authored, not fetched**, so ADR-039 applies cleanly: under that policy
`assets/textures-src/**` is gitignored except `SOURCES.md`, and the reproduction
path is `npm run textures:ship` rather than a checksummed download. The committed
deliverables under `assets/models/ship/` are what ingest consumes, so a clean
checkout ingests without running anything; `npm run test:blender` regenerates from
nothing to prove the chain.

Two decisions worth recording:

- **The normal map is not drawn.** It is the central difference of the same height
  field the albedo and roughness read, wrapped in `U`. The three maps cannot
  disagree about where a groove is.
- **Row 0 is the nose.** Blender maps `V = 0` to the tail *and* its glTF exporter
  writes `v_gltf = 1 − v_blender`, whose origin is the top row. The engine soot
  therefore belongs at the **bottom** of the file. This was wrong in the first
  draft — the soot landed on the nose cone — and is now pinned by a test.

## 4. Landmines found

1. **Cap discs were wound inside-out.** The triangle fan in `disc()` emitted
   `(centre, ring[i+1], ring[i])`, whose cross product points along `−X` for a
   `facing = +1` cap. Caught by `test_blender_ship_geometry.py`, not by the eye:
   every cap in the ship is hidden behind another part, so the renders looked
   correct while the nose cap and the glow-well core faced backwards. A
   backface-culled hole would have shown up later as a rendering bug with no
   obvious cause.
2. **Blender object locations are float32.** Asserting a node landed at its
   authored `f64` origin to 1e-9 fails on any non-representable literal (6.02).
   The builder compares at 1e-5.
3. **Lathe profiles must advance along `+X`.** Outward normal *and* counter-clockwise
   winding are both derived from a positive axial step, so a reversed profile
   silently emits an inside-out shell. `lathe()` now raises instead. Interior
   surfaces use the explicit `flip=True`.
4. **`build_manifest()` and `_ship_length()` assume every object has a mesh.**
   `cockpit_eye` is an empty; the builder keeps mesh objects and marker objects in
   separate lists and only measures the former. The exporter does emit empties as
   glTF nodes with translations — verified before designing around it.
5. **`npm run test:blender` only ever built the test sphere.** The committed
   `ship.glb` had never been proven byte-reproducible by any gate. The smoke test
   now regenerates the textures, builds the ship twice, compares SHA-256 for the
   GLB and all four PNGs, validates the node contract and the `+X` axis on the
   exported bytes, and ingests all three tier variants.

## 5. Consequences for the next tasks

- **T0122** resolves `engine_nozzle` (plume), `rcs_pod_1..4` (puffs), and
  `light_nav_l` / `light_nav_r` / `light_beacon` (blink) by name. Pod numbering is
  1 forward-port, 2 forward-starboard, 3 aft-port, 4 aft-starboard; each origin is
  the pod centre, between its four bells. The three light materials carry only a
  low baseline emission so the asset reads as "lights on" before T0122 exists —
  the animation and intensity are the render layer's.
- **T0123** should find the metallic-rough map reads well: bare plating sits at
  0.92 metalness / 0.29 roughness, painted service panels at 0.12 / 0.58, and the
  sooted aft rows roughen toward 0.6.
- **T0124** gets `cockpit_eye`, a meshless node at the pilot eye point inside the
  `canopy` shell. The canopy is a separate node with its own material, so the
  cockpit view can render it as the frame silhouette or hide it, without a
  `build_ship.py` patch.
- **The draw-call and triangle goldens move.** The resolved ship is 18 meshes /
  23,580 triangles, against v1's 24 / 5,538.
