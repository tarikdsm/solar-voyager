# Architecture — Solar Voyager

This is the canonical module map. If code and this document disagree, one of them is wrong — fix it in the same PR.

## Layering (enforced by ESLint `import/no-restricted-paths`)

```
core  ←  sim  ←  game  ←  render / ui
```

- **`src/core/`** — zero-dependency utilities: float64 vector math (`vec3.ts`, plain `{x,y,z}` numbers), `time.ts` (SimClock: float64 TDB seconds since epoch, warp ladder), `constants.ts`, typed event bus.
- **`src/sim/`** — PURE physics. **No three.js, no DOM, no globals, no side effects.** Fully unit-testable, portable to Web Workers verbatim. This purity is the load-bearing invariant of the whole codebase.
- **`src/game/`** — orchestration: scene state machine, save/load, settings, the input engine
  (`game/input/`: binding registry, shared UI-focus policy, pointer lock, per-frame `InputFrame`).
- **`src/render/`** — three.js scenes. Consumes snapshots, owns the float64→float32 camera-relative boundary.
- **`src/ui/`** — Preact + @preact/signals HUD overlay (DOM, above the canvas).
- **`src/main.ts` + `src/bootstrap/`** — the composition root, deliberately **outside** every layer
  directory. Joining `sim`, `game`, `render` and `ui` is its entire job, so it is the one place that
  imports from all of them; putting it inside any layer would violate `import/no-restricted-paths`
  (T0113 verified this: `src/game/bootstrap/` cannot import `render/`). `main.ts` resolves the
  document contract and calls `bootstrap/composition.ts`; `bootstrap/frameLoop.ts` owns the
  animation-frame callback and the state it shares with composition; `bootstrap/diagnostics.ts`
  owns the seven frozen `canvas.solarVoyager*` browser-diagnostic objects.

## Directory layout

```
src/
├── main.ts                     # entry: resolves the document contract, calls the composition root
├── bootstrap/                  # composition root (outside the layering — see below)
├── core/                       # vec3, time, constants, events
├── sim/
│   ├── bodies/                 # kepler.ts (elliptic + hyperbolic solver), orbitalElements.ts
│   ├── propagation/            # rails.ts, nbodyForces.ts, dp54.ts
│   ├── ship/                   # initialState.ts, attitude.ts, thrust.ts, relativity.ts, ledger.ts (energy ledger),
│                               # vessel.ts (VesselConfig: rest mass + drive/slew limits)
│   ├── guidance/               # constantAccelIntercept.ts (physics-spec §8 solver),
│                               # brakingEnvelope.ts (exact relativistic stop distance)
│   ├── launch/                 # [deferred, post-v1] atmosphere.ts, launchSim.ts, handoff.ts
│   ├── analysis/               # osculating.ts, dominantBody.ts, barycenter.ts, trajectoryImpact.ts
│   └── simulation.ts           # SimulationCore
├── workers/                    # predictor.worker.ts + predictorProtocol.ts
├── render/                     # spaceScene, bodyVisual, starfield, telemetry, perfGovernor,
│                               # (launchScene: deferred)
│                               # trajectoryLine, systemMapScene, lighting, lod
├── game/                       # sceneManager, saveLoad, settings, input
└── ui/                         # App.tsx, hud/, map/, menus/
data/                           # bodies.json, ephemerides-check.json, stars.bin
public/assets/                  # committed build artifacts: models/*.glb, textures/*.ktx2
tools/                          # blender/ scripts, bake_ephemerides.py, bake_stars.py
tests/                          # sim/ unit+regression, golden/ trajectories
```

## Planned v2 modules (new files and existing-file changes)

The v2.0 free-flight redesign (`docs/superpowers/plans/2026-08-14-v2-free-flight.md`
§1) adds or changes the modules below, each landing with its owning task (in
parentheses); this map is updated in the same PR (per `docs/coding-standards.md`'s
doc-update-in-the-same-PR rule). `NEW` files do not exist yet. `MOD` files exist
today (e.g. `sim/simulation.ts`, the "Single source of truth" below) and gain
their v2 behavior from the named task — none of that v2 behavior has landed yet.

```
src/
├── bootstrap/                              # LANDED decomposed main.ts modules (T0113)
├── sim/
│   ├── ship/vessel.ts                      # LANDED VesselConfig + defaults (T0104)
│   ├── ship/attitude.ts                    # LANDED slew-limited hold pursuit (T0107)
│   ├── ship/collision.ts                   # NEW  surface-crossing detection (T0111)
│   ├── guidance/constantAccelIntercept.ts  # LANDED physics-spec §8 solver (T0114)
│   ├── guidance/brakingEnvelope.ts         # LANDED relativistic stop-distance (T0114)
│   ├── simulation.ts                       # MOD  vessel (T0104) + slew (T0107) LANDED; collision (T0111)
│   └── simulationSnapshot.ts               # MOD  manual-rotation lockout LANDED (T0107); impact fields (T0111)
├── core/time.ts                            # MOD  MANUAL_ATTITUDE_MAX_WARP LANDED (T0107); MAX_THRUST_WARP retune (T0115)
├── game/
│   ├── input/                              # LANDED engine+bindings (T0105) + gamepad (T0106)
│   ├── flight/                             # NEW  flightController, assists, cruiseDirector (T0108/16/18)
│   ├── cameraDirector.ts                   # LANDED chase/observatory (T0110) + cinematic (T0125); cockpit (T0124)
│   ├── chaseCameraController.ts            # LANDED spring-arm f64 controller (T0110)
│   ├── cinematicCameraController.ts        # LANDED roll/FOV/idle drift over the orbit camera (T0125)
│   ├── cameraInputRouter.ts                # LANDED camera roll, FOV and the shutter (T0125)
│   ├── photo/                              # LANDED CaptureSink + download sink (T0125); album sink (T0147)
│   ├── cameraTransition.ts                 # LANDED shared blend primitives (T0110)
│   ├── diary/                              # NEW  milestones, diaryStore, album (T0146/47)
│   ├── audio/audioDirector.ts              # NEW  snapshot→audio state (T0144)
│   ├── restorePoints.ts                    # NEW  10 s autosave ring (T0111)
│   ├── targetSelection.ts                  # LANDED one write point for Commands.setTarget (T0117)
│   └── orbitCameraController.ts            # MOD  ship focus target (T0109)
├── render/
│   ├── cameraRig.ts                        # LANDED CameraPose to PerspectiveCamera adapter (T0110)
│   ├── frameCapture.ts                     # LANDED canvas to PNG, no preserveDrawingBuffer (T0125)
│   ├── shipVisual.ts                       # NEW  ship.glb binding + lights (T0109)
│   ├── plumeVisual.ts, rcsVisual.ts        # NEW  photon-beam plume + RCS puffs (T0122)
│   ├── exposureController.ts               # LANDED single toneMappingExposure owner (T0127)
│   ├── planetshine.ts, milkyWay.ts, bodySpin.ts  # NEW (T0123/26/28)
│   ├── atmosphereScattering.ts, eclipseShadows.ts, godRaysPass.ts       # NEW (T0140/41/42)
│   ├── proceduralSun*.ts                   # MOD  corona/prominences v2 (T0141)
│   ├── lightingPostPipeline.ts             # LANDED pass-insertion API + exposure sink (T0127)
│   └── spaceScene.ts                       # MOD  far-plane strategy (T0129)
├── ui/                                     # MOD  presets, markers, pause, diary UI, mixer
│   ├── hud/presets.ts, hud/WorldMarkers.tsx, hud/CruiseStrip.tsx  # NEW (T0112/17/19)
│   └── PauseMenu.tsx, DiaryPanel.tsx, AlbumGrid.tsx                # NEW (T0112/46/47)
data/
├── atmospheres.json (+ .schema.json)       # NEW  per-body scattering params (T0140)
├── audio-manifest.json                     # NEW  layer/SFX manifest (T0145)
tools/
├── blender/build_ship.py                   # MOD  ship remodel (T0121)
├── blender/build_asteroid.py, build_comet.py  # NEW (T0131)
└── fetch_textures.py                       # MOD  checksummed source fetch (T0132)
```

Full per-task interfaces (`VesselConfig`, `FlightController`, `CruiseDirector`,
`CameraDirector`, `MilestoneDef`) are the plan's §2; do not hand-author a
conflicting signature — update the plan in the same PR if a real constraint
forces a deviation (plan §2 naming rule).

## Single source of truth: `SimulationCore`

`src/sim/simulation.ts` owns all physical state: the SimClock, body catalog (rails), relativistic ship state, energy ledger. Per render frame:

```
step(wallDt) → advances sim time by warp × wallDt via the adaptive integrator
             → emits SimSnapshot (immutable for that frame)
```

**`SimSnapshot`** (typed interface, changes require an ADR):
- sim time (TDB seconds), UTC date, **ship proper time τ**, warp state (current, clamp reason)
- body positions/velocities (Float64Array, heliocentric ecliptic J2000, km)
- ship state: r, celerity u, derived v, **γ, % of c**, attitude quaternion, throttle, thrust vector, current power draw
- **barycenter state** (r_cm, v_cm) and CM-relative derived vectors: velocity, proper acceleration, relativistic p and L (physics-spec §6)
- derived: dominant body id, osculating elements, energy ledger totals (E_spent J, proper Δv), active-or-latest burn summary, active warnings

**`Commands`** (the ONLY way player intent enters the sim; changes require an ADR):
- `setThrottle(f)`, `setAttitudeMode(mode)`, `rotate(rates)`, `setWarp(tier)`, `setTarget(bodyId)`; (deferred launch phase adds `setPitchRate(r)`, `stage()` via ADR when built)

The navigation target has exactly one writer: `game/targetSelection.ts`
(`TargetSelectionController`, T0117). The space-view click, the system-map
click, both target dropdowns and the camera focus ring call `selectTarget`,
which validates the id against the catalog and notifies subscribers;
`tests/architecture/targetWritePoint.test.ts` scans `src/` and fails if any file
other than that controller and the composition-root `Commands` facade calls
`setTarget`. Picking for both views is `game/hud/bodyPicking.ts`: float64
angular-disc math against the published camera pose, never a three.js
`Raycaster` (bodies are points and spheres at wildly different tiers, and the
scene is camera-relative float32).

`render/` and `ui/` are pure consumers of `SimSnapshot`. They never mutate sim state. UI agents and physics agents meet ONLY at these two interfaces — this is what makes parallel multi-agent work safe.

## Player intent: `InputFrame` (`game/input/`)

Raw devices never reach `Commands` directly. `game/input/inputEngine.ts` accumulates keyboard,
pointer-lock, and (T0106) gamepad events into one preallocated `InputFrame`
(`{lookYawRad, lookPitchRad, axes: {pitch, yaw, roll, throttle}, pressed(action)}`) published by a
single `poll(wallDtSec)` per frame; `game/input/bindings.ts` owns the `KeyboardEvent.code` binding
registry and the one UI-focus policy every keyboard consumer shares (only `INPUT`/`SELECT`/
`TEXTAREA`/`contenteditable` and an already-`preventDefault`ed key suppress game input — never a
focused button, never `Shift`). `game/input/gamepad.ts` (`GamepadPoller`) polls the standard-mapping
Gamepad API and is merged into the same frame — keyboard and gamepad axes add together, a trigger sets
the throttle lever directly rather than joining the keyboard ramp, and `A`/`B` latch two reserved
actions (`cruiseEngage`/`cruiseAbort`) for T0116 — never a second path into `FlightController`. Connect/
disconnect gates every `getGamepads()` call, so an unconnected pad costs nothing per frame. DOM access
stays behind structural ports; `bootstrap/composition.ts` supplies the adapters. Design:
`docs/superpowers/specs/2026-08-14-input-engine-design.md`,
`docs/superpowers/specs/2026-08-15-gamepad-design.md`.

## Cruise guidance (`sim/guidance/`)

`sim/guidance/constantAccelIntercept.ts` solves the constant-proper-acceleration
boost–flip–brake intercept of a rails target (physics-spec §8, ADR-037), and
`brakingEnvelope.ts` is the exact relativistic stop distance `(c²/α)(γ−1)` shared by
the cruise brake phase and the approach-brake assist, so a warning threshold and the
flown brake can never drift apart. Both are pure, float64 and allocation-free via
out-params; the catalog is consumed read-only and the module holds no state.

The 1D profile is relativistically exact in closed form; the vector correction is a
first-order drift subtraction iterated to a fixed point on the coordinate time of
flight. Two properties bind every caller. The solve is **thrust-only** — gravity is
absent by design and the CruiseDirector's mid-course re-solve is the closed loop. And
it is a **departure** solver: it arrives at rest in the ship's initial drift frame,
not relative to the target, and it returns `ok = false` (all fields NaN) whenever the
arrival closing speed exceeds a tenth of the profile's own peak, which is what a
mid-cruise re-solve does. `ok = false` is a routing decision, not an error: it selects
the physics-spec §8.7 pursuit rule, implemented by T0116.

## Flight control (`game/flight/`)

`game/flight/flightController.ts` is the only writer of attitude and throttle `Commands`. It takes
decomposed setters (`setLookDelta`, `setRotationAxes`, `setThrottleAxis`, `stepThrottle`,
`requestHold`, `killRotation`) rather than an `InputFrame`, so a gamepad (T0106) and the
`CruiseDirector` (T0116) drive the same surface. Two channels, deliberately different: mouse-look
deltas integrate into a desired attitude pursued by a critically damped law (`k_p = 6.0`,
`k_d = 2*sqrt(k_p)`), while keyboard/gamepad axes are direct rate demands that re-anchor the desired
attitude while deflected. Wall-time authority lives here: the control law saturates against
`RATE_MAX = 0.6` in the **wall** frame and only then divides by `effectiveWarp`, so the sim-frame
envelope is `RATE_MAX / effectiveWarp` (physics-spec §3.0.1 — the order is what makes a saturating
input warp-invariant). The `requestedWarp > MANUAL_ATTITUDE_MAX_WARP` lockout is gated on the same
figure `Commands.rotate` uses. The throttle lever is scaled by a `thrustRegime` that caps manual
flight at the vessel's `alphaManualMaxMS2`. `game/flight/flightInputRouter.ts` is the one module that knows both
`InputFrame` and the controller, and owns the time-warp ladder. `update()` is allocation-free and
covered by `bench:sim`. Design:
`docs/superpowers/specs/2026-08-14-flight-controller-design.md`.

## Scene state machine (`game/sceneManager.ts`)

```
v1:      MainMenu → SpacePhase (3D)            — new game starts in a 400 km LEO
future:  MainMenu → LaunchPhase (2D) → HandoffCinematic → SpacePhase (3D)   [deferred, optional]
                  → ApproachPhase/SurfacePhase                              [landing, deferred]
```

- **v1 ships only `MainMenu → SpacePhase`.** The state machine is built to accept the future states without refactoring — phases are pluggable states, never hardcoded transitions.
- `MainMenu` is also the public landing. It mounts only after the measured startup pipeline reaches first playable, so the primary New Game/Continue action never creates a second route, renderer, world, worker, or animation loop.
- Deferred launch phase (post-v1, optional): LaunchScene with an orthographic camera (2D side view) on the same WebGL renderer; handoff at 140 km via `sim/launch/handoff.ts` (2D polar → heliocentric 3D, pure function, energy/angular-momentum round-trip tested). Spec: physics-spec §4; tasks T0060–T0062.
- **Future landing = a new state** added to this machine; bodies already carry a `surface` descriptor in `bodies.json` (unused in v1).

## Threading model

- **Main thread:** SimulationCore (rails evaluation + one DP54 ship propagation + ledger = µs-to-low-ms per frame), rendering, UI.
- **`predictor.worker.ts`:** trajectory prediction — propagates the current ship state thrust-free using the *same* `dp54.ts` + `nbodyForces.ts` modules; returns a downsampled polyline (~2000 pts) + events (SOI transitions, closest approaches, predicted impact) via **postMessage with transferable Float64Arrays**. No SharedArrayBuffer (GitHub Pages can't serve COOP/COEP headers). Re-runs on thrust change / warp elapsed / 0.5 s debounce.
- Optional "dynamic bodies" mode (mutual n-body, ADR-001) also runs on a worker.

The system map is a dynamically imported, setup-time `SystemMapScene` that
shares the live body-position buffer and renderer with the space view. Its one
body-icon batch, one orbit-line batch, and independent trajectory overlay are
allocated and shader-precompiled before the gameplay frame loop. Opening the
map therefore changes only the active view; it never creates a second
simulation, renderer, or runtime GPU resource.

## State & persistence

- The canonical save slot is `solar-voyager.save.v2` in `localStorage` (the key names the slot, not the document version — ADR-034 kept it while bumping the document to v3 so already-deployed saves stay reachable, since the save slot has no fallback-read tier below it and renaming it would orphan deployed data); the same document is available through JSON export/import. Independent profile settings take the opposite approach on purpose: **each schema-incompatible profile generation gets its own key** (`solar-voyager.settings.v4` current, `.v3` T0106-era, `.v2` T0108-era, `.v1` pre-T0108), because the profile document already has a fallback-read/migrate/write-forward mechanism a shared key would not need but also must not risk — a downgraded build silently overwriting a newer document it can't parse with a fresh older-schema one (T0106's design doc, "Storage key" section, has the full reasoning). `SettingsRepository.load()` checks the current key first, then each older key in turn, migrating forward (and persisting to the current key, never back to an older one) on the first match; a present-but-invalid document at any one key fails closed there and does not cascade to older keys. Quality, input bindings, gamepad calibration, camera preferences (chase field-of-view widening and shake, T0110) and tutorial progress all live in this one document and survive without requiring a game save. A missing profile starts tutorial status `unoffered`; a profile migrated up from the v1 or v2 generation starts `skipped`.
- Save v3 = `{version: 3, phase: "space", simulation, settings}`. `simulation` contains the float64 ship/ledger state, simulation time, the `VesselConfig` that priced that ledger (rest mass, absolute and manual proper-acceleration limits, hold slew rate — ADR-034), attitude, throttle, rotation rates, requested/effective warp, clamp reason, navigation target, kinetic-energy baseline and complete burn-log continuation state. Its embedded `settings` deliberately remains the strict `GameSettingsV1` preferences DTO containing only the quality governor lock (`auto | low | medium | high`) and rebindable `KeyboardEvent.code` map. Save/load and export/import project or merge that DTO through `GameSessionController`; they never overwrite profile-only tutorial progress.
- Imported and stored documents are treated as untrusted: parsers reject unknown/missing fields and non-finite or inconsistent simulation values before construction. Loading is atomic — validation and creation of a fresh `SimulationCore` complete before the live session reference and input command target are replaced.
- Version migrations are explicit and each is covered by a committed fixture (`tests/fixtures/save-v1.json`, `tests/fixtures/save-v2.json`, `tests/fixtures/save-v2-midburn.json`). A migrated document adopts the running vessel, but only if that vessel carries the 10 000 kg rest mass that priced every pre-v3 ledger; any other mass fails the load closed, because no downstream check can detect a mass substitution (ADR-034). Rails bodies are never serialized because their positions and velocities are deterministically derived from `simTimeSec`.
- The burn-log HUD is the one bounded exception to snapshot-only UI reads: its runtime chunk is awaited before application bootstrap, then a setup-owned `BurnLogSignalStore` consumes the public read-only `SimulationCore.burnLog` view only when the existing 10 Hz HUD publisher commits, plus a synchronous `rebind()` on session replacement. Its 256 row identities and browser diagnostic object are preallocated; unchanged history is never traversed from the animation-frame path.
- The opt-in tutorial is a DOM-free `game/TutorialController` driven only by real UI events and primitive facts from the existing 10 Hz HUD publication. Camera, map, panel and save callbacks report completed interactions; snapshot facts confirm simulation outcomes. Its stable frame observer is nullable and is set to `null` after skip or completion, so terminal profiles add no tutorial work or allocation to the frame path. A frozen getter-only browser diagnostic exposes observation state without changing `Commands` or `SimSnapshot`.

## Expansion hooks (do not remove)

| Future feature | Hook already in place |
|---|---|
| Landing | Scene state machine slot; `surface` descriptor per body; atmosphere module reusable for entry |
| More ships | `Vessel` interface between sim and ship config |
| Other star systems | `SystemDefinition` loaded from `data/*.json`; new system = new data file + bake |
| Docking/stations | Ship state is generic rigid state; no rendezvous math exists yet — it would be new `sim/analysis/` module(s) written when this is tackled |

## Performance architecture

- `render/telemetry.ts` is the single source of perf truth (frame-time ring buffer, ms splits per subsystem, renderer.info snapshots); consumed by the perf HUD (top-left), the adaptive quality governor (`render/perfGovernor.ts`) and the bench harness. The frame orchestrator measures the `SimulationCore.step()` call and passes that scalar to telemetry; deterministic `SimSnapshot` data does not depend on a wall clock (ADR-024).
- GPU context creation policy (high-performance request, strict/fallback handling, software classification and warning) lives in one place: the renderer bootstrap in `bootstrap/composition.ts`/`render/`. Browsers and drivers remain authoritative over the actual adapter. Contract: `docs/performance-spec.md` §2, ADR-008.
- The frame loop is owned by `bootstrap/frameLoop.ts`: `commands → sim.step() → snapshot → render + UI`, instrumented at each seam. Zero-allocation rules apply to everything this loop calls (performance-spec §5), including the single mutable `FrameLoopRuntime` the loop shares with the composition root — it is allocated once, never per frame.
- Production builds retain Vite's Oxc minification, deterministically recompress entry chunks with Terser, and minify copied standalone JavaScript decoders only when their gzip size improves. This keeps optional setup UI within the fixed JavaScript/CSS gzip gate without changing runtime behavior or the budget.
- Startup is an explicit measured state machine: the static semantic shell reports completed critical-path and shader milestones, `startupQuality.ts` selects the initial unlocked governor rung from context/probe evidence, and lazy body assets remain disabled until gameplay activation. A frozen canvas diagnostic and the cold-load browser gate preserve timing, transfer, program and recovery evidence.

## Release integrity

- `tasks/T*.yaml` is the only task-state authority. `tools/checks/taskDashboard.mjs` deterministically embeds the complete canonical payload in `docs/check_plan.html`; CI rejects drift instead of maintaining parallel status overrides.
- `tools/checks/releaseReadiness.mjs` enforces the public version, required player/policy documents, README local links, the release-scoped task-state boundary, and dashboard equality. Final publication additionally requires T0101 DONE. The task-state boundary is release-scoped: a committed `tools/checks/releaseManifest.json` names explicit task-id scopes (`v1` today, frozen to the ids that shipped v1.0); `T0060`–`T0062` and `T0101` keep their unconditional rules, every other in-scope task must be DONE, and tasks outside the selected scope (future releases' work-in-progress) are exempt from the DONE rule while remaining schema-checked by `check:tasks`. `--release=<name>` (default `v1`) selects the scope; see ADR-033.
- GitHub Pages deploys only from `main`. An annotated release tag is created only after exact-commit CI, Pages deployment, and a cache-disabled live audit succeed; the tag must peel to that deployed commit.

## Invariants (CI-enforced where possible)

1. `sim/` and `core/` import nothing from `game/`, `render/`, `ui/`, three.js, or the DOM.
2. Physics state never round-trips through float32. The float64→float32 boundary lives in exactly one place: `render/spaceScene.ts` position updates.
3. All physics formulas trace to `docs/physics-spec.md`.
4. `SimSnapshot`/`Commands`/`bodies.json` schema changes require an ADR in `docs/decisions/`.
5. Committed `.glb`/`.ktx2` are build artifacts of `tools/blender/` scripts — scripts are the source of truth.
