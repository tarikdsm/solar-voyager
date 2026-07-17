# Rendering Specification — Solar Voyager

## 1. Camera-relative rendering (floating origin)

- Physics is float64 heliocentric km; the GPU is float32. The bridge lives in **exactly one place**: `render/spaceScene.ts`.
- Every frame, for each visual: `scenePos = toFloat32(bodyPos_f64 − cameraPos_f64)`. The three.js camera sits at the scene origin `(0,0,0)` permanently.
- **1 scene unit = 1 km.** Near objects get sub-millimeter-true positions; distant objects' float32 error is sub-pixel by construction.
- Never store or accumulate positions in float32 — recompute from float64 each frame.

## 2. Depth (ADR-008)

Prefer **`reversedDepthBuffer: true`** when `EXT_clip_control` is available — faster (keeps early-Z) and more precise; fall back to `logarithmicDepthBuffer: true`. Near plane 0.001 (1 m), far 1e10 km (beyond Eris). No manual depth partitioning. Both paths CI-tested for z-artifacts (Earth from 200 km and from 1 AU). Context creation policy (high-performance, software-rasterizer detection): `docs/performance-spec.md` §2.

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

## 4. Lighting & post

- **One directional light**, positioned in the focus-to-Sun direction and aimed
  at the origin so the rays travel Sun-to-focus. For focus distance `dKm`, its
  intensity is `π × (AU_KM / max(dKm, solarRadiusKm))²`; therefore a normal-facing
  Lambertian surface reproduces its base colour at 1 AU and the Sun-focused
  case remains finite at the photosphere.
- The one HDR chain is `RenderPass → UnrealBloomPass → OutputPass` over
  half-float composer buffers. The renderer uses **ACES filmic tone mapping**
  at exposure 1.0; `OutputPass` performs tone mapping and output conversion
  once, at the end. Bloom uses threshold 1.0, strength 0.15, radius 0.35, and
  the official half-resolution bright target.
- Sun rendered **procedurally** (ADR-010, task T0084): animated convective granulation, limb darkening, prominence arcs + billboard glare — the static emissive texture is only a fallback. Gas giants animate their real base maps with procedural band flow (T0085). Policy for all procedural shading (tiers, bake-at-load rule, governor octave rung): ADR-010.
- Until T0084, the fallback Sun material has minimum emissive intensity 4 and
  one additive, depth-tested 64×64 radial glare sprite spans four solar
  diameters. Its alpha reaches zero at every edge, preventing square artifacts.
- Night sides are genuinely dark; the global ambient floor is exactly 0.02 for
  playability. Earth keeps its authored night-light emissive map with minimum
  intensity 4 at the fixed exposure so localized city lights remain visible.
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
- System map: separate three.js scene, top-down-capable free orbit camera, bodies as scaled icons + orbit lines, same snapshot data.

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

When γ is significant (threshold ~1.05), a full-screen shader pass applies, in order of gameplay value: (1) **relativistic aberration** — star/body directions transformed by the velocity boost, the sky compresses toward the direction of travel; (2) **Doppler shift** — starfield B-V colors shifted blue ahead / red behind; (3) **headlight beaming** — intensity boost ahead. Applied to the starfield and point-sprite tiers (correct transformation of directions), approximated for near-field geometry. OFF at low quality; the effect must interpolate smoothly as γ→1 (no popping when crossing the threshold). This is v1-optional polish (M6 task) — the sim is relativistic regardless.

## 11. Close-range surface fidelity (real-scale bodies)

Real scale means a 4k equirectangular map on Earth is ~10 km/pixel — sharp from afar, mush from low orbit. Fidelity near a body comes from **layers**, not from impossibly large textures:

1. **Hero texture tier:** 8k albedo for Earth/Mars/Moon (4k others), 4k macro normal maps — the base layer (MODELING-GUIDE §5).
2. **Tiling detail maps (the workhorse):** seamless 1k detail normal + albedo-variation pairs per surface class (rock, ice, regolith, gas banding), blended in by the surface shader starting at ~5 body-radii and fully in by ~1.2 radii, keyed by a per-body detail scale. Two octaves (macro tile + micro tile at ~8× frequency) kill visible repetition. Fades with distance so the far view is untouched.
3. **Procedural shader noise:** low-cost fbm modulating roughness/normal at the closest range, seeded per body — breaks up the last visible texel edges.
4. **Mipmap discipline:** KTX2 full mip chains, anisotropy 4; never sample beyond native resolution (the detail layers take over instead).
5. **Atmosphere & clouds:** Earth cloud layer as a slightly larger shell (independent rotation), rim/fresnel atmosphere shader — both mask the surface transition zone naturally.
6. **Geometry:** tier-3 meshes (≤50k tris) are enough for orbital-only v1 (no terrain landing); silhouette smoothness is guaranteed by the quad-sphere subdivision, not displacement. If landing arrives post-v1, a CDLOD/quadtree patch system becomes its own ADR.

Ring systems (Saturn, Uranus, Jupiter, Neptune): annulus at true radial ratios, 2048×64 radial strip where alpha = optical depth; shader adds planet shadow across the ring, ring shadow on the planet, and backlit transmission (unlit side glows faintly when the Sun is behind) — the three cues that read as "real rings".

## 12. Quality settings — adaptive governor (ADR-008)

Quality is owned at runtime by the **adaptive quality governor** (`performance-spec.md` §3): a measured control loop (p75 frame time, hysteresis) walking an ordered knob ladder (render scale → bloom → AA → star cap → texture cap → tier thresholds) to hold the 60 fps floor. The settings menu exposes a tier lock (manual override always wins) and shows the governor's current tier. Initial tier auto-detected from `devicePixelRatio` + a loading-screen timing probe.
