# Rendering Specification — Solar Voyager

## 1. Camera-relative rendering (floating origin)

- Physics is float64 heliocentric km; the GPU is float32. The bridge lives in **exactly one place**: `render/spaceScene.ts`.
- Every frame, for each visual: `scenePos = toFloat32(bodyPos_f64 − cameraPos_f64)`. The three.js camera sits at the scene origin `(0,0,0)` permanently.
- **1 scene unit = 1 km.** Near objects get sub-millimeter-true positions; distant objects' float32 error is sub-pixel by construction.
- Never store or accumulate positions in float32 — recompute from float64 each frame.
- **Non-finite guard policy is split by consequence (T0129).** Ship, body, packed-geometry and
  polyline bindings validate at bind time and again every frame, and throw `RangeError` on a
  non-finite value: a NaN there is a physics bug and must stop the frame. *Effect* bindings
  (`bindEffectVisual` / `bindPackedEffectVisual` — plume, RCS, in-world markers, sky panorama)
  degrade instead: the write is skipped, the visual holds its last good position, one console
  warning is emitted per binding per session, and `CameraRelativeSpaceScene.effectBindingTelemetry`
  records `nonFiniteObserved`, a live `degradedBindingCount`, a monotonic `skippedBindCount` and
  `lastDegradedLabel`. Recovery is automatic when the source becomes finite again. Policy module:
  `src/render/effectBindingGuard.ts`.

## 2. Depth (ADR-008)

Prefer **`reversedDepthBuffer: true`** when `EXT_clip_control` is available — faster (keeps early-Z) and more precise; fall back to `logarithmicDepthBuffer: true`. Near plane 0.001 km (1 m), far **2.5e10 km** — Eris reaches 1.4617e10 km at aphelion, so the previous 1e10 km plane clipped it out of the view entirely (T0129). No manual depth partitioning. Both paths CI-tested for z-artifacts at three ranges: Earth from 200 km, Earth from 1 AU, and Eris from 1.429e10 km.

Smallest resolvable separation, with `ε = 2⁻²⁴` as the float32 relative step or the unorm absolute quantum: reversed depth gives `ε·L·(1 − L/far)` and logarithmic gives `ε·(1+L)·ln(1+L)` (float) or `ε·(1+L)·ln(1+far)` (unorm). Reversed depth is therefore effectively far-plane-independent, and the whole cost of the 1e10 → 2.5e10 raise is `ln(2.5e10)/ln(1e10) = 4.0 %` of logarithmic resolution. Measured floors: 0.39 m / 3.4 m at LEO range, 365 km / 19,930 km at Eris range. Derivation and rejected alternatives: `docs/superpowers/specs/2026-08-16-far-plane-strategy-design.md` §1.

Context creation policy (high-performance, software-rasterizer detection): `docs/performance-spec.md` §2.

## 3. Visual ladder — 3 tiers per body (by projected angular size)

| Tier | Condition | Representation |
|---|---|---|
| 1 — Point | < ~1.5 px | Additive point sprite; size/brightness from apparent magnitude computed from real radius, distance, geometric albedo, phase angle. Planets look like wandering stars from afar — correct at real scale. |
| 2 — Sphere | 1.5 px – ~200 px | Icosphere L2 with a dedicated KTX2 albedo (2k planets; 1k moons, dwarfs and small bodies); no normal map. |
| 3 — Full model | > ~200 px | Blender-authored glTF (Draco): normal maps, Saturn/Uranus rings as textured annuli (double-sided, alpha), comet coma+tail as camera-facing sprites scaled by heliocentric distance near perihelion. |

- Only the sphere-tier resources for Sun/Earth/Moon load at startup. Other tier-2 albedos load on approach; every tier-3 glTF and hero texture is lazy, including Sun/Earth/Moon (ADR-023).
- Hysteresis on tier switches (±20%) to avoid popping.
- **Fidelity rule — no artistic scaling, ever:** a body's rendered angular size always equals its true angular size from the camera position (real radii, real distances). The view out the window is exactly what a real ship at that state vector would see. The tier ladder changes *representation*, never *apparent size or brightness class*.

Projected diameter is `2 asin(min(1, radiusKm / distanceKm)) × viewportHeightPx / verticalFovRad`.
The nominal 1.5/200 px boundaries use twenty-percent hysteresis: point→sphere
at 1.8 px and sphere→point below 1.2 px; sphere→model at 240 px and
model→sphere below 160 px.

Reflected-body brightness relative to the Sun at the observer is
`p × Φ(α) × radiusKm² × observerSunKm² / (bodySunKm² × observerBodyKm²)`,
where `p` is geometric albedo and the Lambert phase function is
`Φ(α) = (sin α + (π - α) cos α) / π`. Solar apparent magnitude is -26.74 at
1 AU and follows inverse-square distance. Singular centre/surface observations
are clamped to finite physical fallback distances so tier attributes never
receive NaN or infinity.

Tier 2 and tier 3 share one **equatorial render radius** — the ring catalog's
reference radius for a ringed body, its `meanRadiusKm` otherwise — and both
carry the catalog's `visual.polarRadiusRatio`: tier 3 bakes the flattening into
the exported mesh (with canonicalised ellipsoid normals), tier 2 applies it as a
non-uniform object scale `(R, R·ratio, R)` about the body's own pole. three.js'
inverse-transpose normal matrix makes that scale normal-exact, so no shader
variant is involved. The result is a continuous silhouette across the 2↔3
boundary; the tier fly-in gate measures Saturn's projected axis ratio at both
tiers from the same camera pose and holds them to 0.902 within 0.03.

### 3.2 Rotation and axial tilt (T0128)

The render frame is the physics frame — heliocentric ecliptic J2000, `+Z`
ecliptic north — and every asset is glTF Y-up with model-local `+Y` as the north
pole. `render/bodySpin.ts` is the **single owner** of the catalog's
`axialTiltRad`; nothing else may turn a tilt into a transform. Once per frame it
rewrites one preallocated quaternion per catalog body into a packed float64
attitude path:

```
q_body(t) = R_x(π/2 − axialTiltRad) · R_y(θ(t))
θ(t)      = W₀ + 2π · (t mod T) / T
```

`T` is the signed `siderealRotationPeriodSec` (negative = retrograde about the
declared pole, per `data/bodies.schema.json`), and `t` is `simTimeSec`, so pause,
time warp and deterministic replay share one clock. The modulo runs before the
scale, so a multi-century session keeps full precision in the angle — the same
bounded-modulo rule §11 states for the gas giants.

**What this is honestly not.** Two things are conventions, not measurements, and
both come from gaps in the catalog:

- **Epoch phase is uncalibrated.** `bodies.json` carries no `W₀`
  (prime-meridian angle at epoch), so `W₀ = 0` for every body except Earth. What
  ships is a **phase-accurate rotation rate with an arbitrary epoch phase**: Io
  really does turn once per 42.46 h, but which face is sunlit at `t = 0` is not
  a claim, and neither is any longitude read off a rendered body.
- **Pole azimuth is a convention.** Obliquity alone does not fix a pole
  direction; that needs IAU `(α₀, δ₀)`, which the catalog also lacks. The chosen
  convention puts the ascending node of each body's equator on the ecliptic at
  ecliptic longitude 0, i.e. the pole leans toward ecliptic longitude 90°. The
  obliquity — hence the *plane* of the equator and of any ring system — is real;
  the orientation of that plane about the ecliptic pole is not.

**Earth is anchored, and only Earth.** With the frame above, Earth's spin angle
is exactly Greenwich sidereal time, so `W₀` is set to GMST at the J2026 TDB
epoch (JD 2461041.5), `1.756863409 rad = 100.660859°` (IAU-1982). The pole
direction `(0, sin ε, cos ε)` is likewise exact for Earth, because its equator's
ascending node on the ecliptic *is* the vernal equinox. The anchor ignores
precession of the equinox (≈0.33° accumulated since J2000), nutation and
UT1−TDB, so the rendered sub-solar point is good to a few tenths of a degree
near the epoch and drifts by ≈0.014°/yr. The unit test holds it to 1° of the
published position for 2026-01-01T00:00 UT and reproduces both solstice
sub-solar latitudes.

Ringed bodies take the same attitude on their model root, so the annulus rides
its planet and the ring/surface shadow pair is evaluated in that spinning frame.
Neptune's Adams arcs therefore circulate at Neptune's 16.11 h rotation rather
than their true ≈10.5 h Keplerian period — previously they were frozen. Saturn's
close-plane particle field is the exception: it is counter-spun back into the
body's non-spinning equatorial frame and addressed by a camera expressed there,
because its shader advances particles at their own Keplerian rate and a rotating
frame would add the parent's angular velocity on top of it.

Design and the full decision record:
`docs/superpowers/specs/2026-08-16-body-rotation-design.md`.

### 3.3 The ship (T0109)

The player vessel uses the **same ladder primitives** with only two rungs,
because it has no fallback sphere worth drawing:

| Rung | Condition | Representation |
|---|---|---|
| Point | < 1.8 px (drops back below 1.2 px) | A slot in the same additive `BodyPointCloud` as the 43 catalog bodies — no extra draw call. |
| Mesh | ≥ 1.8 px | `ship.glb` through `BodyAssetLoader`, lazily fetched on first resolve, `compileAsync`-precompiled before it is ever visible, cross-faded in over the shared 250 ms. |

- Photometry reuses the reflected-body formula above with the hull's geometric
  albedo `0.45` and a bounding radius of `0.01306 km` (half the 26.12 m authored
  length). A 26 m hull is therefore magnitude ≈ −1.5 at 1,000 km and ≈ 24 at
  1 AU: **correctly invisible** across interplanetary distance. The photon-drive
  plume (§3.4, T0122) is what makes a *burning* ship readable at range, by adding
  its flux into this same point — 16 magnitudes of it at 1 AU.
- Position and attitude come from `SimSnapshot`: the ship occupies one extra
  triple at the end of the packed float64 position array, so the camera-relative
  boundary, the camera focus targets and the solar-lighting focus all address it
  exactly as they address a body.
- ADR-025 makes local `+X` the nose and thrust axis. The exported asset is Y-up
  while the physics body frame is Z-up, so the render quaternion is
  `q_attitude ⊗ rotation(+90° about X)`; the rendered nose stays exactly the
  physics forward vector, which is asserted in unit tests and against the real
  `.glb` in `tools/tests/shipVisualRegression.mjs`.
- The authored hull is metallic (0.78–0.9). three.js gives `AmbientLight` to the
  diffuse term only, so a metal has nothing to reflect and renders black; the
  ship's materials therefore carry a constant environment at the scene's ambient
  radiance, not a studio fill light. `getIBLIrradiance` returns
  `π × texel × envMapIntensity` while `AmbientLight.intensity` is already an
  irradiance, so the white sky texel uses
  `envMapIntensity = AMBIENT_LIGHT_INTENSITY / π`. The ship keeps its ambient
  light as well, so its dielectrics receive ambient irradiance twice (0.04 rather
  than 0.02) — 1.3 % of the direct solar term at 1 AU, deliberately not chased.
  Real planetshine from the dominant body is Front C work.

### 3.4 Engine VFX: plume, RCS, running lights (T0122)

Everything here is deterministic from `SimSnapshot` (throttle, power, attitude,
simulation time), allocates nothing per frame, and hangs off a single `Object3D`
bound through `spaceScene.bindPackedEffectVisual` — T0129's degrading policy,
because an effect transform is a derived quantity and a NaN in one must not end
the session the way a NaN in a ship position rightly does. Anchors are
transcribed from `tools/blender/ship_config.py` into `render/shipEffectAnchors.ts`
so the effects can be precompiled before `ship.glb` is fetched, and verified
against the loaded asset once it arrives (`solarVoyagerShipEffects.anchorErrorM`).

**Beam.** One additive lathe anchored at the `engine_nozzle` **throat**
(model `x = −11.5`, not the bell mouth at `−13.0`), emitting aft. Length is
`4 × 26.12 m × throttle^0.7`, brightness `√throttle`, both delivered as uniforms
so the throttle reaches the screen in the frame it is read; zero throttle hides
the object outright. The bell is a closed shell, so `depthTest: true` is what
makes the beam appear to emerge from the mouth. `forceSinglePass: true` — three
otherwise renders a transparent double-sided material in two passes, and additive
blending is order-independent, so the second pass is a wasted draw call.

**Far field — the artificial star.** The drive is a photon rocket, so
`P = m·α·c` (physics-spec §5) leaves as light and `SimSnapshot.powerDrawW` is
already that number. Its radiant intensity is a normalized beam pattern

```
I(θ) = P · [ f_iso/(4π) + (1 − f_iso)(n+1)·max(0, cos θ)^n / (2π) ]   [W/sr]
```

with `f_iso = 0.02` (bell spill and thermal re-radiation), `n = 64` (half-power
half-angle 8.42°) and `θ` measured from the exhaust axis. Both terms integrate to
their share of `P`, so the pattern redistributes power and never invents any.
Against the same solar zero point §3 already uses,

```
m_plume = −26.74 − 2.5·log10( I(θ)/d² · 4π(1 AU)² / L☉ ),   L☉ = 3.828e26 W
```

and the plume is added to the reflected hull **in flux**,
`m = −2.5·log10(10^(−0.4·m_refl) + 10^(−0.4·m_plume))`, inside the ship's existing
`BodyPointCloud` slot — no second object and no second brightness ladder. For the
default 10 t / 10 g vessel (`P = 2.940e14 W = 7.68e−13 L☉`) at 1 AU: hull alone
+24.4 (invisible), plume broadside +7.8, plume down the beam **−1.7**. A burning
ship is 16 magnitudes brighter than a coasting one, which is the "artificial
star" of spec §6.3 arriving from `P = mαc` rather than from a tuning constant.

**RCS.** Four pods × four bells = sixteen thrusters, which is the preallocated
pool and its live cap. One `Points` object, static positions, one draw call. Bell
`i` fires with weight `max(0, τ̂ᵢ · ω̂) · saturate(|ω| / 0.12)` where
`τᵢ = rᵢ × (−uᵢ)`, so the couples are solved rather than scripted. `ω` is
differentiated from consecutive snapshot attitudes, not read from
`CommandState.rotationRatesRadS`, because that is zero during a hold-mode slew
(ADR-035) — when the ship is turning hardest. Steps above 1 rad per frame
(warp ≳ 700) alias in the axis–angle extraction and are dropped and counted.

**Lights.** `mat_light_beacon` / `mat_light_nav_l` / `mat_light_nav_r` carry the
authored emission (T0121); this multiplies it by a waveform of **simulation**
time — nav lights ±6 % over 4 s, beacon a double flash of two 90 ms pulses 220 ms
apart every 1.6 s over a 0.25 floor. Sim time is why pause freezes them.

**Cost.** Three objects, hidden unless active: beam, nozzle glow, puff pool — at
most +3 draw calls, and zero in a coasting frame. The governor derives
`plumeBeamSegments` (24/12/6, three index ranges over one vertex buffer) and
`rcsPuffCap` (16/8/0) from the rung's tier.

## 3.6 Camera (T0110)

The space camera is owned by `game/cameraDirector.ts`, a pure float64 module with
one three.js adapter (`render/cameraRig.ts`). It publishes a single `CameraPose`
— world position, look direction, up direction, field of view — and
`EpochWorld.cameraPositionKm` is a live reference to that pose's position, so the
camera-relative boundary in section 1 is unchanged.

Two modes, both running every frame so a switch always cross-fades between live
poses:

- **chase** (default): a spring arm at `position = ship − forward·d + up·0.35d`,
  `d` selectable on the wheel between 2 and 50 ship lengths (default 6 ≈ 157 m).
  The damped quantity is the *arm offset*, never the world position — a
  critically damped world-space tracker would sit `2v/ω` behind a moving target,
  1.9 km at LEO speed. The arm follows the ship's attitude through a 120 ms
  first-order quaternion lag, so the camera rolls with the ship. Integration is
  the exact critically damped solution over the frame, giving zero overshoot at
  any frame delta and a 2 % settle in 0.729 s (`ω = 8 rad/s`).
- **observatory**: v1's `OrbitCameraController`, reporting the scene camera's
  default `+Y` up so every existing framing is bit-identical. Its wheel range is
  `[radius + max(2 m, radius·1e-6), 2e10 km]`; the outer limit frames the whole
  catalog and sits inside the §2 far plane (T0129). The system map passes its own
  catalog-derived maximum and is unaffected.

Mode changes animate with the same primitives as a focus transfer
(`game/cameraTransition.ts`): smootherstep on the anchor, **logarithmic** on the
distance — mandatory when the two ends are 157 m and 210,000 km apart — and
unit-vector slerp on the arm direction, look and up. The orbit camera's
`0.15 × travel × sin²(πt)` context pull-back is deliberately not applied at
director level; with anchors up to 4 AU apart it would add 10⁸ km of swing.

Two throttle/acceleration-driven effects, both switchable in **Session &
settings → Camera** and both on by default because they are sized to be subtle:

- field of view widens up to **+8°** at full throttle, reaching 98 % of a step in
  0.5 s;
- shake reaches **0.15°** of angular deviation at 5 g and saturates there. The
  two components are `A·sin(e)cos(r)` and `A·sin(e)sin(r)`, so their magnitude is
  `A·|sin(e)| ≤ A` exactly; two independent ±A sinusoids would peak at `A√2` and
  quietly break the contract by 41 %.

The arm clamps its **output** position (not its spring state) to
`radius + max(2 m, radius·1e-6)` around the dominant body — the same
minimum-distance rule the orbit camera uses — so a ship frozen against a surface
by ADR-036 collision does not leave the camera underground. While frozen, the
shake phase and the attitude lag stop advancing.

Focus and mode are separate concerns: only the camera input port
(`focusBody`/`cycleFocus`/`O`) may change the mode. `Commands.setTarget` and the
system map re-aim the observatory camera through `focusObservatoryBody` and
never pull the player out of the chase view.

## 4. Lighting & post

- **One directional light**, positioned in the focus-to-Sun direction and aimed
  at the origin so the rays travel Sun-to-focus. For focus distance `dKm`, its
  intensity is `π × (AU_KM / max(dKm, solarRadiusKm))²`; therefore a normal-facing
  Lambertian surface reproduces its base colour at 1 AU and the Sun-focused
  case remains finite at the photosphere.
- The one HDR chain is
  `RenderPass → RelativisticPostPass → bloom → SMAA → FXAA → OutputPass` over
  half-float composer buffers. The renderer uses **ACES filmic tone mapping**;
  `OutputPass` performs tone mapping and output conversion once, at the end.
  Bloom uses threshold 1.0, strength 0.15, radius 0.35, and the official
  half-resolution bright target. Only one of SMAA/FXAA is enabled at a time
  (§12); the disabled AA passes stay in the chain.
- **Pass insertion (T0127).** `LightingPostPipeline.insertPass(pass, anchor)` is
  the only supported way to extend the chain. Four anchors name the seams after
  the pipeline-owned passes — `scene`, `relativistic`, `bloom`,
  `anti-aliasing` — and a pass lands immediately after its anchor's pass and
  after everything already inserted at the same anchor, so the total order is a
  pure function of (anchor, insertion sequence) and never of import order.
  Nothing may precede `RenderPass` or follow `OutputPass`. The pipeline owns
  inserted passes: composer sizing, `setRenderScale` when implemented,
  force-enabled warm-up compilation, and disposal in reverse insertion order.
  Inserting nothing leaves the default six-pass order byte-identical. The
  private-field reads the adaptive SMAA/bloom passes depend on are validated at
  construction and pinned to a three.js revision by a canary unit test.
- **Adaptive exposure (T0127, plan §3.5).** `render/exposureController.ts` is the
  single owner of `toneMappingExposure` and writes it only through the pipeline.
  The scene key is `E_target = clamp(K / L_scene, E_min, E_max)` with `K = 1` and
  `L_scene` in units of the solar constant at 1 AU, so `E = 1` — v1's fixed
  exposure — is reproduced exactly at 1 AU with nothing else in view. `L_scene`
  is the sum of the solar term and the dominant body's reflected term, both
  obtained by inverting §3's apparent magnitudes through
  `10^(0.4 (M☉,1AU − m))`; the reflected term is skipped when the dominant body
  is the Sun or absent. **Exposure is display-only:** the tier ladder keeps
  consuming physical magnitudes and never sees it.
  Adaptation is a first-order lag in *log* exposure — equal time buys equal
  stops across the whole range — with `τ = 6 s` when the scene darkens and
  exposure rises, and `τ = 2 s` when it brightens and exposure falls.
  `E_min = 1/8` is set by the photosphere: `SUN_EMISSIVE_INTENSITY = 4` is
  distance-independent, so at exposure 1 the solar disc reaches display channel
  255 (clipped, granulation invisible) and at 1/8 it reaches 219 with the corona
  still visible. `E_max = 16` is bounded by the constant 0.02 ambient floor,
  which no exposure can add contrast to; +4 stops is the last power of two that
  keeps night sides dark, and it lifts Neptune's disc from ≈2/255 to ≈53/255.
  Measured keys: near-Sun (25 R☉) `L = 73.98`, Mercury `6.674`, Earth `1`,
  Neptune `1.106e-3`. Settings expose `auto`/`fixed`; the quality governor pins
  `fixed` on its tier-1 rungs, and `fixed` from either side wins.
- Sun rendering is **procedural** (ADR-010, task T0084). Tier-2 Lambert and
  tier-3 Standard materials share a seeded, UV-free, object-space domain-warped
  fBm photosphere. The visible-limb profile is
  `I(μ) = 1 - 0.52(1 - μ) - 0.16(1 - μ)²`. Simulation time drives bounded
  600 s granulation and 21,600 s activity cycles; wall time is never sampled.
  The fixed quality rungs are `full/half/minimum = 4/2/1` fBm octaves in one
  precompiled shader program.
- One additive, depth-tested billboard spans eight solar radii and combines a
  bounded corona with exactly three deterministic prominence arcs. Its alpha
  reaches zero at every edge, and a four-radius bounding sphere permits safe
  off-screen frustum culling. The billboard replaces the former glare sprite,
  so the typical production draw count does not increase.
- The authored emissive Sun materials remain the disabled-procedural fallback.
  All photosphere variants and the billboard shader are created and precompiled
  before gameplay; frame updates mutate only the existing shared uniforms.
  Gas giants animate their real base maps with procedural band flow (T0085).
  Policy for procedural shading and governor rungs remains in ADR-010.
- Night sides are genuinely dark; the global ambient floor is exactly 0.02 for
  playability. Earth keeps its authored night-light emissive map with minimum
  intensity 4 so localized city lights remain visible; the adaptive controller
  raises exposure on the night side of the outer system, never lowers it below
  `E_min`, so that floor still holds.
  The RGB cloud texture also supplies its green channel as the cloud shell's
  alpha map and the transparent shell does not write depth, preserving the
  surface and night lights below it.
- Earth atmosphere: simple rim/fresnel shader in v1 (full scattering is a future task).

## 5. Starfield

- Yale Bright Star Catalog (9,096 coordinate-bearing entries, public domain) baked by `tools/bake_stars.py` into `data/stars.bin`. The 254,688-byte payload is a raw little-endian stream of seven Float32 values per star: `(dirX, dirY, dirZ, visualMagnitude, red, green, blue)`, stride 28 bytes. Directions are unit vectors in the ecliptic J2000 frame; RGB is a bounded display mapping of B−V, with neutral white for missing color indices.
- Rendered as one `THREE.Points` on a 1e9 km sphere centered on the camera (moves with it). The static object is never registered as a physical position binding and has no per-frame update or allocation. Correct at every warp translation and zoom; no skybox textures.
- For visual magnitude `m`, setup computes `F = 10^(-0.4m)`, `sizeCssPx = clamp(1, 4, 1 + 1.5 F^0.25)`, and `opacity = clamp(0, 1, 10^(-0.4(m - 1)))`. Point size is multiplied by renderer pixel ratio; unresolved points retain a one-fragment footprint and resolved points use a soft circular profile. Catalog B−V RGB passes through unchanged.
- Star vertices are forced to the selected depth strategy's far plane (`z=w` for normal/logarithmic, `z=0` for reversed depth). The additive material uses a less-or-equal logical depth test against the cleared far plane but never writes depth, so every opaque near-field body occludes stars regardless of its camera-relative distance while the starfield cannot occlude later transparent effects.

## 6. Launch scene (2D) — DEFERRED (optional post-v1 expansion, see roadmap)

Same renderer, orthographic camera, side view: rocket sprite/low-poly model, Earth limb, atmosphere gradient by altitude, exhaust plume scaling with throttle and ambient pressure. Parallax cloud/ground layers near the pad (Alcântara coastline silhouette).

## 7. Trajectory & map rendering

- Predicted path: polyline from the worker (≤2000 pts), rendered camera-relative as `Line2` (fat lines), color-coded by dominant body; event markers (SOI, closest approach, impact) as billboarded icons.
- Osculating conic: analytic ellipse (64–256 segments) around the dominant body, updated every frame — instant feedback while the worker refines.
- System map: a dynamically imported, separately preallocated three.js scene
  on the same renderer and live snapshot positions. Every catalog body is in
  one fixed-pixel `Points` draw; every closed catalog orbit is sampled through
  the canonical orbital-element conversion and batched into one
  parent-anchored `LineSegments` draw. A map-owned `TrajectoryOverlay` accepts
  the same validated predictor result as the space overlay. Its camera,
  diagnostics, float64 source buffers, float32 GPU buffers, geometries,
  materials, and shaders all exist before gameplay; updates only mutate those
  stable resources through the `spaceScene.ts` camera-relative boundary. The
  map derives its setup-time camera range and far plane from the complete
  parent-relative catalog bound and initial viewport aspect; the normal space
  view retains the §2 far-plane default. Alignment diagnostics measure the
  selected icon against the actually rendered orbit segments in both float64
  kilometres and projected screen pixels without frame-loop allocations. A
  setup-only nonempty trajectory fixture is compiled and rendered once, then
  reset before the animation loop, so the first real event cannot create a GPU
  program or geometry. During gameplay the frame orchestrator updates the live
  simulation and both cameras but submits exactly one active view.

## 8. Performance & asset budgets (CI-gated)

| Budget | Limit |
|---|---|
| Repo total | < 300 MB |
| `public/assets/` | < 150 MB |
| Initial critical path (code + Sun/Earth/Moon + stars) | < 8 MB |
| Frame budget (mid-range laptop, 1080p) | 16.6 ms; render ≤ 10 ms — full budget table and 60 fps contract: `performance-spec.md` §1 |
| Draw calls / triangles (typical view) | ≤ 150 / ≤ 500k |
| Tier-3 model | ≤ 50k tris planets, ≤ 5k asteroids |

- All textures KTX2 (ETC1S for albedo, UASTC for normal maps); all meshes Draco.
- `npm run check:budgets` fails CI when exceeded.

## 9. HUD state-vector widget (bottom-right)

A miniature 3D axis triad in its own small viewport (same WebGL renderer, scissor test), rendering the CM-relative vectors from the snapshot (physics-spec §6): velocity, proper acceleration, linear momentum p = γmv, angular momentum L. Design goals: *elegant* — thin anti-aliased lines, soft glow tips, subtle grid disc for the ecliptic plane, magnitude labels with SI-prefix formatting, logarithmic vector-length scaling (linear would be useless across 30 km/s → 0.99c). Orientation follows the main camera by default; pinnable to fixed ecliptic axes. Adjacent energy panel (DOM, Preact) shows Wh/W figures. Budget: the widget viewport must cost < 1 ms/frame.

### 9.1 HUD navball (bottom-center)

The navball consumes the existing float64 snapshot and uses the dominant body's
instantaneous orbital frame from physics-spec §3.0.1. The ship-local `+X` nose is
the instrument center, local `+Y` is screen-right, and local `+Z` is screen-up.
Prograde/retrograde, normal/antinormal, and radial-out/radial-in markers are
inverse-rotated by the attitude quaternion and orthographically projected onto
the front hemisphere. The proper-acceleration vector uses the same projection
for the thrust indicator. Degenerate axes are hidden rather than publishing
non-finite geometry.

The SVG geometry is created once. Snapshot-derived values are written into a
preallocated projection buffer and sampled with the HUD at 10 Hz; signals mutate
only marker/horizon `transform` and `opacity`. No canvas drawing, SVG path rebuild,
or component rerender is allowed in the frame loop.
The ground/sky boundary uses the visible half of the projected great-circle
ellipse: a lower sky cap while the radial-out axis faces the viewer, and an upper
ground cap while radial-in faces the viewer. The hidden back arc is not drawn.

## 10. Relativistic visual effects (quality-gated, ship near c)

The normative observer-frame model is defined in physics-spec section 6.1 and
ADR-031. Camera-relative bodies, point sprites, and trajectory points transform
their directions at the shared precision boundary. The starfield applies the
same aberration in its vertex shader so sources outside the inertial frustum can
enter the observed view. Near-field meshes use a rigid angular translation of
their camera-relative center; their local shape is not distorted.

Activation is `smoothstep(1.0, 1.05, gamma)`, multiplied by a quality gate that
is zero for tiers 1 and 2 and for the direct software fallback. The identity
path must preserve existing positions and HDR colors exactly.

For Doppler factor `D`, the bounded presentation mapping is:

- `x = clamp(log2(D), -2, 2)`
- `g = exp2(x * (-0.20, 0.05, 0.35))`
- `g_normalized = g / dot(g, (0.2126, 0.7152, 0.0722))`
- `color_shifted = color * g_normalized`
- `beaming = clamp(D^3, 0.20, 8.0)`
- `output = mix(color, color_shifted * beaming, activation)`

One precompiled HDR full-screen pass applies that mapping between the scene
render and bloom. When active it may add at most one draw call and no render
target. All uniforms and scratch values are preallocated; no frame-loop shader,
material, geometry, or collection allocation is permitted.

The full-screen pass is skipped while activation is below `1/65536`. Even at
the maximum bounded gain, the omitted contribution is below 0.03 of one 8-bit
display level. This keeps ordinary orbital flight on the zero-cost identity
path without a visible discontinuity; directional shaders retain the exact
smoothstep value.

When γ is significant (threshold ~1.05), a full-screen shader pass applies, in order of gameplay value: (1) **relativistic aberration** — star/body directions transformed by the velocity boost, the sky compresses toward the direction of travel; (2) **Doppler shift** — starfield B-V colors shifted blue ahead / red behind; (3) **headlight beaming** — intensity boost ahead. Applied to the starfield and point-sprite tiers (correct transformation of directions), approximated for near-field geometry. OFF at low quality; the effect must interpolate smoothly as γ→1 (no popping when crossing the threshold). This is v1-optional polish (M6 task) — the sim is relativistic regardless.

## 11. Close-range surface fidelity (real-scale bodies)

Real scale means a 4k equirectangular map on Earth is ~10 km/pixel — sharp from afar, mush from low orbit. Fidelity near a body comes from **layers**, not from impossibly large textures:

1. **Hero texture tier:** 8k albedo for Earth/Mars/Moon (4k others), 4k macro normal maps — the base layer (MODELING-GUIDE §5).
2. **Tiling detail maps (the workhorse):** seamless 1k detail normal + albedo-variation pairs per surface class (rock, ice, regolith, gas banding), blended with a cubic fade from exactly zero at 5 body-radii to fully active at 1.2 radii. Runtime asset-manifest schema 2 stores each pair, `tilesPerEquator`, and a deterministic uint32 seed. The shader samples a macro tile and a phase-shifted, 28°-rotated micro tile at 7.73× frequency; sRGB mid-gray is centered at 0.21404114 linear, albedo variation has strength 0.12, and normal XY weights are 0.08/0.03. The exact-zero branch leaves far output byte-identical.
3. **Procedural shader noise:** shared seeded two-octave periodic C1 waves over object-space direction fade in from 1.5 to 1.2 radii. A cubic profile makes both value and derivative continuous across every period. The waves are evaluated per hero-mesh vertex and interpolated for fragment use; the KTX2 layers retain high-frequency per-fragment detail. The result perturbs tangent-space normal at strength 0.12 and roughness at 0.16, reusing the hero normal map's tangent frame where available.
4. **Mipmap discipline:** KTX2 full mip chains, anisotropy 4; never sample beyond native resolution (the detail layers take over instead).
5. **Atmosphere & clouds:** Earth cloud layer as a slightly larger shell (independent rotation), rim/fresnel atmosphere shader — both mask the surface transition zone naturally.
6. **Geometry:** tier-3 meshes (≤50k tris) are enough for orbital-only v1 (no terrain landing); silhouette smoothness is guaranteed by the quad-sphere subdivision, not displacement. If landing arrives post-v1, a CDLOD/quadtree patch system becomes its own ADR.

Ring systems (Saturn, Uranus, Jupiter, Neptune) are driven by the versioned
`data/rings.json` catalog. Each tier-3 model uses the catalog's equatorial
reference radius, a 256×4-segment annulus at the exact inner/outer ratios, and a
2048×64 radial strip whose alpha is exposed optical depth. Runtime applies the
catalogued axial tilt, samples radial structure, and localizes Neptune's four
named arc sectors only inside the narrow Adams band. It casts the oblate
planet's shadow across the annulus, casts the ring shadow onto the planet, and
permits at most 0.22 backlit transmission. Material shader hooks and
program-cache keys are stable and are installed during model setup.

Saturn alone has a close-plane particle representation. One seeded icosahedron
`InstancedMesh` covers a 2,400 km camera-local patch, samples the same radial
density profile, spans the catalogued 0.12 km thickness and 0.15–8 m physical
sizes, and advances at local Keplerian angular velocity. Subpixel chunks retain
a bounded 0.0012-radian view-space proxy so the procedural field remains visible;
physical geometry is used once larger. A cubic radial/vertical blend fades the
annulus as particles enter, with no runtime geometry, material, texture, or
instance allocation. Quality tiers cap particles at 4,096 (Q5+), 2,048 (Q4),
1,024 (Q2–Q3), or 0 (Q1).

Jupiter, Saturn, Uranus, and Neptune preserve their authored tier-3 albedo maps
while animating the map lookup in one `MeshStandardMaterial` program hook. Their
catalog seeds are respectively 599, 699, 799, and 899; nominal band-rotation
periods are 9.9 h, 10.7 h, 17.2 h, and 16.1 h. Four latitude zones begin at
rate multipliers 1.000, 0.985, 1.012, and 0.975 inside a smooth, bounded
64-base-rotation shear cycle. Adjacent phase separation stays below 0.4 turns,
preventing periodic half-longitude interpolation changes. Seeded, seam-free
spherical noise domain-warps longitude by at most 0.006 UV and latitude by at
most 0.002 UV, and storm shimmer remains within 0.985–1.015 of the sampled color. The
Great Red Spot is localized at UV `(0.374, 0.640)` with radii
`(0.068, 0.046)` and completes one counter-clockwise content rotation every six
simulation days; the shimmer cycle is 1,800 simulation seconds. All phases are
derived from bounded modulo arithmetic over `SimSnapshot.simTimeSec`, so pause,
time-warp, and deterministic replay share one clock without accumulating drift.

The gas-giant hook is installed before ring and surface-detail hooks during
model setup. Both surface-detail albedo and normal use its animated UV, so all
layers move as one surface. Every hook retains its exact prior callback/cache
key; failed setup or compilation unwinds them in reverse order before the lazy
model is rejected. The feature adds no texture, geometry, material, render
target, or draw call. `full`, `half`, and `minimum` procedural quality select 4,
2, and 1 noise octaves. Disabling the animation selects an exact authored-map
path: the original map sample and subsequent surface-detail composition remain
unchanged.

## 12. Quality settings — adaptive governor (ADR-008)

Quality is owned at runtime by the **adaptive quality governor** (`performance-spec.md` §3): a measured control loop (p75 frame time, hysteresis) walking an ordered knob ladder (render scale → bloom → AA → star cap → texture cap → tier thresholds) to hold the 60 fps floor. The settings menu exposes a tier lock (manual override always wins), an exposure mode (`auto`/`fixed`, §4), and shows the governor's current tier. The tier-1 rungs additionally pin `fixed` exposure, and `fixed` from either the player or the governor wins. Two further knobs are derived from the rung's tier rather than listed per rung, so the ladder cannot drift out of step with it: the photon beam's radial tessellation `plumeBeamSegments` (24 at tier ≥ 5, 12 at tiers 2–4, 6 at tier 1) and the RCS live-puff cap `rcsPuffCap` (16 at tier ≥ 3, 8 at tier 2, 0 at tier 1). Initial tier auto-detected from `devicePixelRatio` + a loading-screen timing probe.
