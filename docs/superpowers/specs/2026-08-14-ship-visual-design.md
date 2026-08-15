# Ship visual + camera focus target — per-task design (T0109)

Task: `T0109` (v2 plan `docs/superpowers/plans/2026-08-14-v2-free-flight.md`
§"T0109", §6, §13). Spec: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md`
§5, §6.3. Depends on T0103. Contracts inherited: ADR-025 (quaternion `[x,y,z,w]`,
local `+X` is the nose and thrust axis), ADR-023 (explicit initial visual tier),
ADR-009 (per-body assets), ADR-032 (budget-revision policy).

## Problem

`public/assets/models/ship.glb` has existed since T0060: built by
`tools/blender/build_ship.py`, textured, tier-optimised (`ship_1k`, `ship_2k`),
registered in `public/assets/manifest.json`, counted by the asset budget gate and
deployed to GitHub Pages. **No code path has ever loaded it.** v1 shipped a game
whose protagonist is invisible: the camera orbits catalog bodies, the HUD prints
the ship's state vector, and the ship itself is not in the scene graph.

T0110's chase camera needs something to chase. This task makes the ship exist as
a rendered object and as a camera focus target, and nothing else — the remodel,
the plume, RCS puffs and planetshine are Front C work (spec §6.3), owned by
later tasks.

Three things make this more than "add a mesh":

1. **There is no ship slot anywhere in the render data model.** Every visual in
   `CameraRelativeSpaceScene` is bound to an offset inside one packed float64
   array of *catalog body* positions, and `CameraFocusTarget.positionOffset`
   indexes the same array. The ship is not a catalog body.
2. **The ship must be visible at all distances.** At 400 km altitude the initial
   camera is 13,542 km from it; a 26.12 m hull subtends 1.1e-3 px there. It has
   to degrade into the same additive point cloud the 43 bodies use, driven by the
   same apparent-magnitude physics, or it simply vanishes.
3. **The asset's local frame is not the physics body frame.** The glTF export is
   Y-up; the physics body frame is Z-up. Applying the snapshot quaternion
   directly would fly the ship rolled 90° about its own nose.

## Decision summary

1. **One packed array, one extra slot.** The render-side packed position array
   grows from `43 * 3` to `44 * 3`; the trailing triple is the ship. Every
   existing mechanism — `bindPackedVisual`, `bindPackedPointPositions`,
   `CameraFocusTarget.positionOffset`, `SolarLighting.setFocusPositionOffset`,
   `apparentMagnitude` — then works on the ship unchanged. §1
2. **The ship is a 44th point in the *existing* `BodyPointCloud`,** not a second
   point cloud: zero extra draw calls at range. §2
3. **One tier ladder.** `visualTier.ts` grows a shared point↔resolved boundary
   that `selectVisualTier` is rewritten in terms of, and the ship consumes the
   same boundary and the same magnitude→intensity curve. No second ladder. §3
4. **The model frame correction is an explicit constant quaternion,** composed
   as `q_render = q_attitude ⊗ q_modelToBody`, and the invariant it must preserve
   (rendered nose ≡ physics forward) is asserted in unit tests *and* against the
   real `.glb` in the Playwright harness. §4
5. **Lazy, precompiled, allocation-free** — the same lifecycle
   `BodyVisualSystem` gives body models: idle until the ship resolves, then load
   → `compileAsync` → 250 ms cross-fade in. §5
6. **`RuntimeResourceCounts` gains `shipVisualCreations`, and a seventh frozen
   canvas diagnostic `solarVoyagerShip` is added** so browser gates can observe
   the ship the way they observe the system map. §7

---

## 1. Where the ship's position lives

`createEpochState()` (game layer) returns `positionsKm` sized `bodies.length * 3`
— it is literally the rails state array. `createEpochWorld` (render layer) now
allocates the render-side master array:

```
positionsKm      = Float64Array((bodyCount + 1) * 3)   // master, owned by render
bodyPositionsKm  = positionsKm.subarray(0, bodyCount * 3)  // zero-copy view
shipPositionOffset = bodyCount * 3
```

- The **master** goes to `CameraRelativeSpaceScene` bindings, `BodyVisualSystem`,
  `SolarLighting`, `ProceduralSun`, `OrbitCameraController` and `ShipVisual`.
- The **view** goes to `SystemMapScene`, whose contract is `positionsKm.length ===
  bodies.length * 3` and whose icon point cloud is sized from that length. A
  `subarray` shares the buffer, so the map keeps reading live body positions
  without a copy and without gaining a 44th icon. The system map deliberately
  does *not* show the ship in this task; that is a HUD/marker decision owned by
  T0112.
- `main.ts` keeps writing `world.positionsKm.set(snapshot.bodyPositionsKm)` — a
  shorter source into a longer target writes the body prefix and leaves the ship
  slot alone.

The ship slot is seeded at world creation from Earth's rails position plus the
new-game LEO radius, because `SolarLighting` and `ProceduralSun` validate that
*every* component of the packed array is finite at construction time, and
because the pre-first-frame `initializeView`/warm-up passes read it. Once the
frame loop starts, `ShipVisual.writeState` overwrites it from
`snapshot.shipState` every frame.

**Rejected alternative:** a dedicated `Float64Array(3)` for the ship with its own
`Points` object. It would have avoided touching `BodyVisualSystem`, at the cost
of a second draw call at every distance, a second additive material, and a second
place where the magnitude→intensity curve is written down. The brief's "shared
additive point cloud" and "do not invent a second tiering system" both point the
other way.

## 2. The 44th point

`BodyVisualSystem`'s constructor gains a trailing optional
`auxiliaryPointColors: readonly number[] = []`. It appends those colours to the
`BodyPointCloud` colour array and relaxes its packed-length assertion to
`(definitions.length + auxiliaryPointColors.length) * 3`. It never reads or
writes the auxiliary slots — it does not own them.

`ShipVisual` owns index `bodyCount` and writes it with
`pointCloud.writeAppearance(index, diameterPx, opacity, intensity)` followed by
`commitAppearance()`. `commitAppearance()` only sets three `needsUpdate` flags, so
calling it from both owners in the same frame is idempotent and makes the two
update calls order-independent.

Ship point colour: `0xdfe6ef`, a neutral hull white. It is a *colour*, not a
brightness; brightness comes from the magnitude path below.

## 3. One tier ladder, one magnitude curve

`visualTier.ts` gains three exports and one internal rewrite:

```ts
export const TIER_FADE_DURATION_MS = 250;
export function selectResolvedRepresentation(resolved: boolean, diameterPx: number): boolean;
export function pointIntensityForMagnitude(magnitude: number): number;
```

`selectResolvedRepresentation` is the existing point boundary with its existing
hysteresis (`>= 1.8 px` to resolve, `< 1.2 px` to drop back). `selectVisualTier`
is rewritten to call it, which is provably behaviour-preserving:

| current | old | new |
|---|---|---|
| 1 | `d>=240 → 3`, else `d>=1.8 ? 2 : 1` | `!resolved(false,d) → 1`, else `d>=240 ? 3 : 2` |
| 2 | `d>=240 → 3`, else `d<1.2 ? 1 : 2` | `!resolved(true,d) → 1`, else `d>=240 ? 3 : 2` |
| 3 | `d<1.2 → 1`, else `d<160 ? 2 : 3` | `!resolved(true,d) → 1`, else `d<160 ? 2 : 3` |

`pointIntensityForMagnitude` is `min(8, 10^(-0.4(m - 6)))`, lifted verbatim out
of `BodyVisualSystem.update` so both callers share one definition of the curve.

**The ship uses the point boundary only.** It has exactly two representations —
point and mesh — so the 240/160 px sphere↔model boundary is meaningless for it.
This is not a second ladder: it is the same boundary function with the same
hysteresis, consulted for the one transition the ship has. Bodies keep the
three-rung ladder because they have a fallback sphere; the ship has no sphere
tier to fall back to (a 26 m icosphere would be worse than the real mesh at every
distance where it is visible at all).

Ship physical constants, all traceable to `tools/blender/build_ship.py`:

| constant | value | source |
|---|---|---|
| length | 26.12 m | `EXPECTED_LENGTH_METERS`, asserted by the builder |
| model unit | 1 m | builder manifest: "One Blender unit equals one metre" |
| render scale | 1e-3 km/unit | metres → the km render frame |
| bounding radius | 0.01306 km | half the length; the nose/tail extent dominates |
| hull geometric albedo | 0.45 | brief / plan; a light spacecraft hull |

`apparentMagnitude(shipIndex, sunIndex, 0.01306, 0.45, positionsKm, cameraKm)`
then treats the ship as a Lambertian sphere of that radius, which is the same
approximation the 43 bodies get. Sanity: at 1,000 km the ship is m ≈ −1.5
(saturating the intensity clamp, a hard bright star); at 1 AU it is m ≈ 24.4 and
correctly invisible. Making a 26 m hull visible across interplanetary distances
is *not* a bug to fix here — spec §3.6 gives that job to the photon-drive plume
(T0122), which adds its luminance into this same point.

## 4. Attitude: model frame vs body frame

Measured from the committed `ship.glb` (node translations, not assumptions):

| feature | glTF position | meaning |
|---|---|---|
| `hull_nose` | `[9.5, 0, 0]` | nose is `+X` ✔ ADR-025 |
| `hull_tip` | `[12, 0, 0]` | the extreme nose vertex node |
| `canopy` | `[6.6, 1.55, 0]` | up is `+Y` |
| `radiator_P/S` | `[2, 0, ∓4.2]` | lateral is `±Z` |

The builder authors the ship nose-along-`+Y`, up-along-`+Z` in Blender, rotates
it −90° about Blender `Z` before export, and the exporter applies its standard
Z-up→Y-up conversion. Net: **glTF `+X` = nose, `+Y` = up, `±Z` = lateral.**

ADR-025 §4 fixes the physics body frame as `+X` nose, roll about `+X`, **pitch
about `+Y`**, **yaw about `+Z`** — i.e. body `+Y` is lateral and body `+Z` is up.
So model and body agree on the nose and disagree on the roll by exactly 90°:

```
q_modelToBody = rotation(+90° about X) = (√2/2, 0, 0, √2/2)      // [x,y,z,w]
q_render      = q_attitude ⊗ q_modelToBody
```

which maps model `+Y` (up) → body `+Z` (up) and model `+Z` → body `−Y`.

The load-bearing invariant is roll-independent and therefore worth asserting on
its own:

```
q_render · (1,0,0) === writeForwardFromQuaternionInto(q_attitude)
```

because `q_modelToBody` fixes `+X`. `ShipVisual.noseAlignment` returns the dot
product of those two unit vectors; it is `1` to float64 rounding whenever the
composition is right and diverges immediately if the multiplication order, the
component order (`[x,y,z,w]` vs `[w,x,y,z]`), or the correction sign is wrong.
Unit tests assert it over a sweep of attitudes; the Playwright harness asserts it
against the real asset by also measuring the world-space direction of the
`hull_tip` node, which no synthetic stub can fake.

The composition is done with scalar arithmetic straight into
`Object3D.quaternion.set(...)` — no `Quaternion` scratch object, no allocation.
`CameraRelativeSpaceScene.updateCameraRelative` then calls `updateMatrix()` on the
bound root, which composes position, this quaternion, and the 1e-3 scale.

## 5. Lifecycle, precompilation, allocation

Identical in shape to `BodyVisualSystem`'s model path, deliberately:

```
idle ──(resolved && lazy loading enabled)──▶ loading
loading ──loadModel('ship') ok──▶ scale, bind, compileAsync ──▶ ready
        └─ null / throw ─▶ failed   (point representation stays; no throw escapes)
```

- `BodyAssetLoader.loadModel('ship')` is used unchanged. It already honours the
  texture tier cap (`ship_1k.glb` / `ship_2k.glb`) through the same
  `models/${id}_${cap}.glb` lookup, so the adaptive quality governor governs the
  ship for free.
- Lazy loading is **disabled at world creation and enabled at space-phase
  activation**, exactly like `BodyVisualSystem`, so `data/initial-path.json`
  stays minimal and startup never fetches the ship. At the initial camera the
  ship is 13,542 km away and unresolved anyway.
- `renderer.compileAsync(root, camera, scene)` runs *before* the model is ever
  visible (opacity starts at 0), so there is no first-use compile stall.
- Reveal is the same 250 ms cross-fade (`TIER_FADE_DURATION_MS`) the bodies use,
  point opacity → 0 while model opacity → 0…1. **Single mesh set.** The tier-2
  body pattern of two parallel meshes exists only to cross-fade a fallback colour
  into a lazily arriving texture; the ship's textures arrive inside the same
  `.glb` as its geometry, so there is nothing to cross-fade between.
- The frame path allocates nothing: preallocated scratch `Float64Array`s for the
  composed quaternion and the forward vector, no closures, no array literals.
- Non-finite ship state throws a `RangeError` with a ship-specific message. This
  matches the deliberate hard-throw already in `spaceScene.ts` — a NaN ship
  position is a physics bug and must not be silently drawn at the origin.

## 6. Lighting at LEO

The ship is lit by the existing `SolarLighting` rig and nothing else:
`AmbientLight(0.02)` plus a `DirectionalLight` pointing along sun→focus with
inverse-square intensity `π·(AU/d)²`. Two consequences that had to be checked
rather than assumed:

1. **The light direction follows the camera focus.** `main.ts` already calls
   `lighting.setFocusPositionOffset(cameraController.focusPositionOffset)` every
   frame. Because the ship is a focus target in the same array, focusing the ship
   points the directional light along sun→**ship** — which is exactly right, and
   is why the ship slot had to live in the master array rather than beside it.
2. **The authored hull is metallic** (`mat_hull` metalness 0.78–0.9 from the
   texture's blue channel; `mat_nozzle` metalness 1.0; `mat_hull_dark` 0.8).
   three.js gives `AmbientLight` to the *diffuse* term only, and metal has no
   diffuse term, so with no image-based environment a metallic hull renders black
   apart from a narrow GGX highlight. That is not "sunlit correctly at LEO".

   The fix is a physically-motivated one and is confined to the ship: an 8×4
   equirectangular `DataTexture` of constant radiance equal to the scene's
   ambient term, assigned as `envMap` on the ship's materials only. three.js
   PMREM-filters it once, during the ship's `compileAsync`. A metal then has a
   sky to reflect rather than a studio fill light (spec §6.3 explicitly rejects a
   fake three-point rig). Body materials are untouched, so no existing visual
   regression moves.

   **The units matter and cost a factor of π.** three.js 0.185.1's
   `getIBLIrradiance` returns `π × envMapColor × envMapIntensity` — an
   *irradiance* — while `AmbientLight.intensity` is already an irradiance. With a
   white (1.0) texel the environment therefore uses
   `envMapIntensity = AMBIENT_LIGHT_INTENSITY / π`, so the sky's radiance is the
   one that produces the scene's ambient irradiance. Setting it to
   `AMBIENT_LIGHT_INTENSITY` directly over-drives the environment by π.

   It is still not an exact equivalence, and the honest statement is that it is
   not: the ship keeps its `AmbientLight` contribution as well, so the ship's
   *dielectrics* receive ambient irradiance twice (0.04) where every other object
   receives it once (0.02). Removing the double count would mean either excluding
   the ship from the ambient light or halving the sky, and halving the sky would
   misstate the radiance the metals — the whole reason this exists — reflect. At
   0.04 against ≈ 3.14 of direct solar irradiance the discrepancy is 1.3 % of the
   lit hull. The honest fix is real planetshine (Front C), not a fudged constant.

## 7. CI contract surface

- `RuntimeResourceCounts` gains **`shipVisualCreations`** (never drops a field).
  `tools/tests/mainMenuRegression.mjs` asserts the whole object with
  `deepEqual`, so both its `MENU_RUNTIME_RESOURCES` and
  `ACTIVE_RUNTIME_RESOURCES` fixtures are extended in the same commit.
- A seventh frozen canvas diagnostic **`solarVoyagerShip`** is added, following
  the getter-based `solarVoyagerTutorial` pattern (frozen, null-prototype, no
  per-frame allocation): `loadState`, `resolved`, `diameterPx`, `pointOpacity`,
  `modelOpacity`, `noseAlignment`, `focused`. The six existing diagnostics are
  untouched.
- New harness `tools/tests/shipVisualRegression.mjs` (`npm run test:ship-visual`)
  wired into `.github/workflows/ci.yml` as its own step, in two phases:
  - **fixture phase** (`tests/render/shipVisual.html`, vite dev server, 256×256
    render target, pixel readback) — no model fetched at startup; point → mesh
    → point across the boundary with hysteresis; model opacity reaches 1; nose
    alignment over an attitude sweep including the `x ≈ −1` singular branch;
    sunlit vs backlit brightness ordering; `getError() === 0` throughout.
  - **production phase** (built `dist`, vite preview, `?autostart=1`) — `[`/`]`
    cycling reaches the ship, the model loads, `noseAlignment ≈ 1` against the
    real asset and the live snapshot, focus label reads `Focus: Ship`, no console
    or page errors.
  - `--capture <path>` (opt-in, not run by CI) writes the LEO proof screenshot.

## 8. Budgets

- **Draw calls.** The committed `ship.glb` is 24 nodes over 6 materials, so a
  *resolved* ship costs 24 draw calls. At the perf gate's scenario (autostart,
  camera on Earth) the ship is unresolved and costs **zero** extra draw calls and
  zero triangles — the golden is re-baselined only if measurement says so, not on
  principle. The 24-call figure is recorded in `docs/bench/T0109-summary.md` as
  the number T0110 will have to re-baseline against, and as the reason the Front C
  remodel should join meshes per material. Merging them *here* was rejected: it
  would bake away the `engine_nozzle` and RCS pod nodes that T0122's plume and
  puffs attach to, and asset shape is the builder script's business, not the
  renderer's.
- **Bundle.** This task lands the plan §13 ceiling raise
  (570,000 → 1,000,000 B total gzip, 285,000 → 400,000 B entry) as its own
  commit, justified against ADR-032's "budgets are revised deliberately, never
  silently" policy, with measured before/after numbers in the bench summary.
- **Heap.** Everything the ship allocates is allocated once, at load. The frame
  path is allocation-free, so the 196,608 B / 30 s window is unaffected.

## 9. Known follow-ups

- **`shipVisual.ts` is 510 lines**, over `coding-standards.md`'s ~300-line
  guideline. There is a clean seam: `createAmbientSkyEnvironment`,
  `prepareModel`, `applyModelOpacity` and the four `base*` material-state arrays
  form a model/material lifecycle concern of roughly 200 lines whose only
  coupling to the rest is a single opacity setter, leaving roughly 250 lines of
  tier selection, attitude and photometry. It was left whole here to keep the
  review surface of a wiring task small. **T0122 must split it before adding the
  plume**, or the file becomes genuinely unreadable.
- **`SharedCameraControls` now lives in `src/ui/sharedCameraControls.ts`.** T0109
  moved it out of `main.ts` so its focus routing could be unit-tested; the rest
  of the composition-root split remains T0113's.
