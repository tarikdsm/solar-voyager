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
| 2 — Sphere | 1.5 px – ~200 px | Icosphere L2 with 2k/1k KTX2 albedo; no normal map. |
| 3 — Full model | > ~200 px | Blender-authored glTF (Draco): normal maps, Saturn/Uranus rings as textured annuli (double-sided, alpha), comet coma+tail as camera-facing sprites scaled by heliocentric distance near perihelion. |

- Tier-2/3 textures **lazy-load** the first time a body crosses the tier-1→2 threshold. Only Sun/Earth/Moon assets load at startup.
- Hysteresis on tier switches (±20%) to avoid popping.
- **Fidelity rule — no artistic scaling, ever:** a body's rendered angular size always equals its true angular size from the camera position (real radii, real distances). The view out the window is exactly what a real ship at that state vector would see. The tier ladder changes *representation*, never *apparent size or brightness class*.

## 4. Lighting & post

- **One directional light**, direction Sun→camera-focus, intensity ∝ 1/d² normalized at 1 AU.
- HDR pipeline: half-float render target, **ACES filmic tone mapping**, UnrealBloomPass (solar disc, engine glow).
- Sun rendered as emissive sphere + billboard glare sprite.
- Night sides genuinely dark; global ambient floor 0.02 for playability.
- Earth atmosphere: simple rim/fresnel shader in v1 (full scattering is a future task).

## 5. Starfield

- Yale Bright Star Catalog (~9,100 stars, public domain) baked by `tools/bake_stars.py` into `data/stars.bin`: packed Float32 `(dirX, dirY, dirZ, mag, B−V→RGB)`, ~250 KB.
- Rendered as one `THREE.Points` on a 1e9 km sphere centered on the camera (moves with it). Correct at every zoom; no skybox textures.

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

## 10. Relativistic visual effects (quality-gated, ship near c)

When γ is significant (threshold ~1.05), a full-screen shader pass applies, in order of gameplay value: (1) **relativistic aberration** — star/body directions transformed by the velocity boost, the sky compresses toward the direction of travel; (2) **Doppler shift** — starfield B-V colors shifted blue ahead / red behind; (3) **headlight beaming** — intensity boost ahead. Applied to the starfield and point-sprite tiers (correct transformation of directions), approximated for near-field geometry. OFF at low quality; the effect must interpolate smoothly as γ→1 (no popping when crossing the threshold). This is v1-optional polish (M6 task) — the sim is relativistic regardless.

## 11. Quality settings — adaptive governor (ADR-008)

Quality is owned at runtime by the **adaptive quality governor** (`performance-spec.md` §3): a measured control loop (p75 frame time, hysteresis) walking an ordered knob ladder (render scale → bloom → AA → star cap → texture cap → tier thresholds) to hold the 60 fps floor. The settings menu exposes a tier lock (manual override always wins) and shows the governor's current tier. Initial tier auto-detected from `devicePixelRatio` + a loading-screen timing probe.
