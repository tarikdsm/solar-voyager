# Solar Voyager v2.0 — Free-Flight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This repo has its own mandatory execution protocol on top of those skills.** Read `docs/task-protocol.md` and `AGENTS.md` first. Work happens ONLY through claimed `tasks/T####-*.yaml` files, one PR per task, review by a different agent. Every non-trivial task here additionally requires its claimer to run `superpowers:brainstorming` → `superpowers:writing-plans` scoped to that task, producing `docs/superpowers/specs/<date>-<slug>-design.md` + `docs/superpowers/plans/<date>-<slug>.md` before code — exactly as v1's 47 specs / 55 plans did. This document is the release-level plan: it fixes WHAT each task delivers, its interfaces, its acceptance numbers, and the design decisions already made (do not re-litigate them).

**Goal:** Transform Solar Voyager from an instrumented planetarium into a third-person relativistic free-flight sandbox — ship always visible, point-and-fly cruise to anywhere in the solar system in minutes, four visual fronts, exploration diary, audio — per the approved spec `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md`.

**Architecture:** Targeted transformation (approach A). `core/` + `sim/` stay pure and almost frozen (6 small ADR-gated changes); all new gameplay lives in `game/` (FlightController, CruiseDirector, CameraDirector, Diary, Audio); `render/` keeps its substrate and gains ship/VFX/sky/lighting systems; `ui/` keeps the 10 Hz signals pattern and rebuilds layout into three HUD presets.

**Tech Stack:** TypeScript + Vite + three.js `^0.185.1` (WebGL2; WebGPU stays deferred) + Preact/@preact/signals + Web Audio + Vitest + Playwright + Blender 5.1 headless + KTX-Software 4.4.x. No new runtime dependencies without an ADR.

## Global Constraints

Every task inherits these. Copy them into per-task specs verbatim where relevant.

- Layering `core ← sim ← game ← render/ui` (ESLint-enforced). `sim/`+`core/`: no three.js, no DOM, no side effects. `render` ↮ `ui`.
- All physics float64; km, km/s, s, km³/s²; heliocentric ecliptic J2000; epoch J2026 (TDB). The only f64→f32 site is `src/render/spaceScene.ts` (`Math.fround` scan-enforced by `tests/render/float32Boundary.test.ts`).
- `SimSnapshot`, `Commands`, `bodies.json` schema, and physics formulas change only with an ADR in the same PR (`docs/decisions/`). New runtime/catalog data files under `data/` (e.g. `bodies.json`, `rings.json`, the planned `atmospheres.json`, `audio-manifest.json`) get a JSON Schema + ADR; CI/process config (e.g. `tools/checks/releaseManifest.json`, `tasks/*.yaml`) is validated by bespoke checked-in code instead.
- Zero allocations in the frame loop (CI heap gate ≤ 196,608 B growth / 30 s window). Preallocate scratch; no runtime material/geometry creation; precompile shaders via the existing warm-up patterns.
- 60 fps floor on reference hardware with the adaptive governor; startup ≤ 5,000 ms to first playable (`data/initial-path.json` stays minimal — new heavy assets lazy-load post-activation).
- Budgets are revised deliberately, never silently: bundle total gzip target ≤ 1,000,000 B (entry ≤ 400,000 B); `public/assets` ≤ 150 MiB; repo ≤ 300 MiB; every budget/golden change is its own reviewed commit with justification (see §Budget re-baseline).
- Deployment: GitHub Pages from `main` (no COOP/COEP ⇒ no SharedArrayBuffer). Every merged PR must leave the deployed game playable — v2 lands incrementally on the live site, as v1 did.
- All game text English. Commit format `<type>(<scope>): [T####] <subject>`. Bench evidence (`docs/bench/T####-summary.md` + before/after JSON) required for any PR touching `render/` or the frame loop.
- Golden trajectory fixtures are inviolable: regenerate only with the documented flag + `golden:` commit + ADR-level justification.
- Tests required for all `src/sim` code; every new visual feature ships a Playwright regression harness in `tools/tests/` wired into `.github/workflows/ci.yml` (copy the style of the existing 24 harnesses).
- The six frozen `Object.defineProperty(canvas, 'solarVoyager*')` diagnostics and `RuntimeResourceCounts` are CI contract surface (~25 browser gates). Extend them; never drop fields.
- `npm run generate:dashboard` must run in the same commit as ANY `tasks/*.yaml` change or `check:dashboard` fails CI.

---

## 0. Execution order — read this first

1. **Nothing may be committed to `tasks/` until T0102 merges.** `tools/checks/releaseReadiness.mjs` (runs on every PR) currently fails if any task other than {T0060–62, T0101} is not `DONE`. T0102 generalizes it. Until then, this plan document is the only home of the v2 task definitions.
2. After T0102 + T0103 merge, commit the task YAMLs of a milestone in batches (statuses `TODO`, with `generate:dashboard` in the same commit), then agents claim per protocol.
3. Lanes: within each milestone, tasks with disjoint `depends_on` are parallel by construction. The **asset lane (V2M4 batch tasks T0134–T0139)** may start as soon as T0131/T0132/T0133 are done — it is deliberately independent of V2M2/V2M3 code lanes; run it continuously in the background exactly like v1's asset lane.
4. One agent = one IN_PROGRESS task. Read the matching `agents/skills/*.md` before claiming (Blender tasks → `blender-asset-authoring.md`, body tasks → `add-celestial-body.md`, all → `task-workflow.md`).
5. Milestone exit criteria (spec §14.2) are verified by the last task of each milestone as explicit acceptance items.

### Task DAG at a glance

```
V2M1: T0102 → T0103 → { T0104, T0105, T0113 } → T0106, T0107 → T0108 → { T0109 → T0110, T0111, T0112 }
V2M2: T0114 → T0116 → { T0117, T0118, T0119 } → T0120 ;  T0115 (after T0114, before T0120)
V2M3: T0121 → T0122 → T0123 ; T0124, T0125 (after T0110) ; T0126, T0127 → T0142* ; T0128, T0129, T0130
V2M4: T0131, T0132, T0133 → T0134…T0139 (asset lane) ; T0140 (after T0127), T0141 (after T0127), T0142 (after T0127), T0143
V2M5: T0144 → T0145 ; T0146 → T0147 ; T0148, T0149, T0150
V2M6: T0151 → T0152, T0153 → T0154
(*T0142 listed in V2M4; buildable once T0127's pass-insertion API exists)
```

---

## 1. File structure (new and significantly modified)

```
src/
├── sim/
│   ├── ship/vessel.ts                      # NEW  VesselConfig + defaults (T0104)
│   ├── ship/attitude.ts                    # MOD  slew-limited hold pursuit (T0107)
│   ├── ship/collision.ts                   # NEW  surface-crossing detection (T0111)
│   ├── guidance/constantAccelIntercept.ts  # NEW  physics-spec §8 solver (T0114)
│   ├── guidance/brakingEnvelope.ts         # NEW  relativistic stop-distance (T0114)
│   ├── simulation.ts                       # MOD  vessel injection, collision, slew (T0104/07/11)
│   └── simulationSnapshot.ts               # MOD  impact fields + vessel echo (ADR) (T0111)
├── core/time.ts                            # MOD  MAX_THRUST_WARP retune (T0115)
├── bootstrap/                              # LANDED decomposed main.ts modules (T0113)
│   ├── composition.ts                      #      wiring order (transcribed from main.ts)
│   ├── frameLoop.ts                        #      commands→step→snapshot→render+UI
│   └── diagnostics.ts                      #      the 6 canvas contracts + RuntimeResourceCounts
├── game/
│   ├── input/                              # NEW  input engine (T0105) + gamepad (T0106)
│   │   ├── inputEngine.ts                  #      pointer-lock, axes, focus policy
│   │   ├── bindings.ts                     #      actions/axes registry (settings-backed)
│   │   └── gamepad.ts                      #      Gamepad API polling → axes
│   ├── flight/
│   │   ├── flightController.ts             # NEW  intent→Commands, wall-time authority (T0108)
│   │   ├── assists.ts                      # NEW  approach brake, flip helper (T0118)
│   │   └── cruiseDirector.ts               # NEW  phase machine + warp pilot (T0116)
│   ├── cameraDirector.ts                   # LANDED chase/observatory + cross-fade (T0110); cockpit/cinematic (T0124/25)
│   ├── chaseCameraController.ts            # LANDED spring-arm f64 controller (T0110)
│   ├── cameraTransition.ts                 # LANDED shared blend primitives (T0110)
│   ├── diary/
│   │   ├── milestones.ts                   # NEW  ~50 declarative predicates (T0146)
│   │   ├── diaryStore.ts                   # NEW  progress state + persistence (T0146)
│   │   └── album.ts                        # NEW  IndexedDB photo store (T0147)
│   ├── audio/audioDirector.ts              # NEW  snapshot→audio state (T0144)
│   ├── restorePoints.ts                    # NEW  10 s autosave ring (T0111)
│   └── orbitCameraController.ts            # MOD  ship focus target (T0109)
├── render/
│   ├── cameraRig.ts                        # LANDED CameraPose -> PerspectiveCamera adapter (T0110)
│   ├── shipVisual.ts                       # NEW  ship.glb binding + lights (T0109)
│   ├── plumeVisual.ts                      # NEW  photon-beam plume (T0122)
│   ├── rcsVisual.ts                        # NEW  RCS puff sprites (T0122)
│   ├── planetshine.ts                      # NEW  secondary fill light (T0123)
│   ├── milkyWay.ts                         # NEW  panorama + zodiacal light (T0126)
│   ├── exposureController.ts               # NEW  adaptive exposure (T0127)
│   ├── bodySpin.ts                         # NEW  rotation/tilt/oblateness (T0128)
│   ├── atmosphereScattering.ts             # NEW  analytic Rayleigh+Mie hook (T0140)
│   ├── eclipseShadows.ts                   # NEW  analytic occluder hook (T0141)
│   ├── proceduralSun*.ts                   # MOD  corona/prominences v2 (T0141)
│   ├── godRaysPass.ts                      # NEW  post pass (T0142)
│   ├── lightingPostPipeline.ts             # MOD  pass-insertion API (T0127)
│   ├── effectBindingGuard.ts               # LANDED effect-binding degrade policy (T0129)
│   └── spaceScene.ts                       # LANDED far plane 2.5e10 + effect bindings (T0129)
├── ui/                                     # MOD  presets, markers, pause, diary UI, mixer
│   ├── hud/presets.ts                      # NEW  Clean/Pilot/Engineer state (T0112)
│   ├── hud/WorldMarkers.tsx                # NEW  target diamond, prograde markers (T0112/17)
│   ├── hud/CruiseStrip.tsx                 # NEW  cruise status + dual-clock drama (T0119)
│   ├── PauseMenu.tsx                       # NEW  real pause (T0112)
│   └── DiaryPanel.tsx / AlbumGrid.tsx      # NEW  (T0146/47)
├── workers/ (unchanged)
data/
├── atmospheres.json (+ .schema.json)       # NEW  per-body scattering params (T0140)
├── audio-manifest.json                     # NEW  layer/SFX manifest (T0145)
tools/
├── blender/build_ship.py                   # MOD  ship remodel (T0121)
├── blender/build_asteroid.py, build_comet.py # NEW (T0131)
├── fetch_textures.py                       # MOD  checksummed source fetch (T0132)
└── checks/releaseReadiness.mjs             # MOD  release-scoped (T0102)
```

---

## 2. Shared interface contracts (exact signatures — later tasks must match)

```ts
// sim/ship/vessel.ts (T0104)
export interface VesselConfig {
  readonly restMassKg: number;        // > 0; default 10_000 (today's SHIP_MASS_KG)
  readonly alphaMaxMS2: number;       // absolute drive limit; default 98.0665 (10 g)
  readonly alphaManualMaxMS2: number; // manual-regime cap; default 19.6133 (2 g)
  readonly maxSlewRadPerSimS: number; // hold-mode slew; default 0.261799 (15°/s)
}
export const DEFAULT_VESSEL: VesselConfig;

// sim/guidance/constantAccelIntercept.ts (T0114 — as shipped) — pure, allocation-free
// via out-params. `CompiledRails` did not exist and is DEFINED by T0114: the shared
// read-only `CompiledRailsCatalog` bundled with the solver's own private evaluation
// scratch (never SimulationCore's live RailsState — see ADR-037 §6).
export interface CompiledRails {
  readonly catalog: CompiledRailsCatalog;
  readonly scratchState: RailsState;
  readonly scratchWorkspace: RailsWorkspace;
}
export function createCompiledRails(catalog: CompiledRailsCatalog): CompiledRails;
export type ArrivalIntent = 'orbit' | 'flyby';
export interface InterceptSolution {
  ok: boolean;                    // false ⇒ use pursuit fallback; all numbers NaN
  totalCoordSec: number;          // boost+brake coordinate time
  flipAtCoordSec: number;         // time from start to flip; always totalCoordSec/2
  totalProperSec: number;         // ship τ for the trip
  peakBeta: number;               // max |v|/c on profile
  arrivalRadiusKm: number;        // insertion radius actually used
  // Added by T0114 (this block updated per the naming rule below). Rationale in
  // docs/decisions/ADR-037-constant-accel-intercept.md §6.
  iterations: number;             // the quantity T0114's convergence acceptance is stated in
  readonly aimUnit: Float64Array; // 3: boost thrust axis; brake leg is its negation
}
export function createInterceptSolution(): InterceptSolution;
export function solveInterceptInto(out: InterceptSolution,
  shipState: Float64Array /*7: r,u,τ*/, rails: CompiledRails, targetIndex: number,
  alphaMS2: number, arrival: ArrivalIntent, arrivalAltitudeKm: number,
  startSimTimeSec: number): void;
export function brachistochroneHalfCoordSec(distanceKm: number, alphaMS2: number): number;
export const MAX_INTERCEPT_ITERATIONS = 25;      // plan §3.3.2
export const INTERCEPT_CONVERGENCE_SEC = 0.5;    // plan §3.3.2
export const MAX_INTERCEPT_CLOSING_RATIO = 0.1;  // ADR-037 §4 — spurious-root guard
export const ORBIT_ARRIVAL_RADIUS_FACTOR = 3;    // plan §3.3.3

// sim/guidance/brakingEnvelope.ts (T0114)
export function relativisticStopDistanceKm(relSpeedKmS: number, alphaMS2: number): number;
// = (c²/α)(γ_rel − 1), exact; used by approach-brake assist and cruise brake phase.
export function relativisticStopCoordSec(relSpeedKmS: number, alphaMS2: number): number;
// = u_rel/α, exact; the brake phase's own ETA. Both: α ≤ 0 or β ≥ 1 ⇒ +∞, non-finite ⇒ NaN.

// game/flight/flightController.ts (T0108 — as shipped)
export type ThrustRegime = 'manual' | 'cruise';
export const ROTATION_RATE_RAD_S = 0.6;    // plan §3.1 RATE_MAX; moved here from the T0105 bridge
export class FlightController {
  constructor(ports: { commands: Commands; snapshot(): SimSnapshot; vessel: VesselConfig });
  setLookDelta(yawRad: number, pitchRad: number): void;      // pointer-lock deltas (wall frame)
  setRotationAxes(pitch: number, yaw: number, roll: number): void; // [-1,1]
  setThrottleAxis(value01: number): void;                    // absolute analog
  stepThrottle(delta01: number): void;                       // keyboard ramp
  requestHold(mode: AttitudeMode): void;                     // binds all 8 modes
  killRotation(): void;
  update(wallDtSec: number): void;                           // allocation-free
  // Added by T0108 (this block updated per the naming rule below). Rationale in
  // docs/superpowers/specs/2026-08-14-flight-controller-design.md §1.
  setThrustRegime(regime: ThrustRegime): void;   // T0116 selects 'cruise' for the full alpha envelope
  get thrustRegime(): ThrustRegime;              // read side; a HUD/director needs to know the regime
  get accelerationCapMS2(): number;              // the ceiling now in force, m/s^2
  setStabilityAssist(enabled: boolean): void;    // idempotent form a persisted assist setting needs
  toggleStabilityAssist(): void;                 // the key binding
  get stabilityAssist(): boolean;
  setVessel(vessel: VesselConfig): void;         // restore replaces the core; vessel is per-core (ADR-034 §4)
  adoptCommandedThrottle(commanded01: number): number; // snapshot.throttle is regime-scaled; un-scales it
  get throttleAxis(): number;                    // lever position, before the regime ceiling
  resetAxes(): void;                             // restore: forget intent, do NOT overwrite restored rates
  releaseAxes(): void;                           // resetAxes + an explicit rotate(0,0,0)
}
// Deliberately absent: no `updatePorts`. GameSessionController assigns
// currentSimulation BEFORE onSimulationReplaced fires, so a release-then-repoint
// method reached through a stable Commands facade flushes zeroes over the rates
// the restore just applied. Hold a stable facade and call setVessel instead.

// game/flight/flightInputRouter.ts (T0108) — the only module that knows both
// InputFrame and FlightController; also owns the time-warp ladder.
export class FlightInputRouter {
  constructor(controller: FlightController, ports: { commands: Commands; snapshot(): SimSnapshot });
  apply(frame: InputFrame): void;                            // allocation-free
  updatePorts(ports: { commands: Commands; snapshot(): SimSnapshot }): void;
}

// game/flight/cruiseDirector.ts (T0116)
export type CruisePhase = 'idle'|'align'|'boost'|'flip'|'brake'|'insert'|'done'|'aborted';
export class CruiseDirector {
  engage(targetBodyId: string, arrival: 'orbit'|'flyby', arrivalAltitudeKm?: number): boolean;
  abort(): void;                                             // ≤1 s wall to ≤100× warp
  readonly phase: CruisePhase;
  readonly etaCoordSec: number; readonly etaProperSec: number;
  update(wallDtSec: number): void;
}

// game/cameraDirector.ts (T0110, extended T0124/25)
export type CameraMode = 'chase'|'cockpit'|'cinematic'|'observatory';
export interface CameraPose {                    // three.js `lookAt` semantics: `upDirection`
  readonly positionKm: ReadonlyVec3;             // is an up *hint*, not necessarily orthogonal
  readonly lookDirection: ReadonlyVec3;
  readonly upDirection: ReadonlyVec3;
  readonly fovDeg: number;
}
export class CameraDirector {
  setMode(mode: CameraMode): void;               // throws for a mode this build has not implemented
  cycle(): void;                                 // steps IMPLEMENTED_CAMERA_MODES
  readonly mode: CameraMode;
  update(wallDtSec: number, snapshot: SimSnapshot): void;    // runs BOTH cameras, writes the pose
  prime(attitudeQuaternion: Float64Array): void; // pose before the first simulation step exists
  // Pose read side. `cameraPositionKm` is the identity `EpochWorld.cameraPositionKm` exposes, so
  // every camera-relative consumer keeps one live reference (render/cameraRig.ts applies the rest).
  readonly pose: CameraPose;
  readonly cameraPositionKm: ReadonlyVec3;
  readonly isTransitioning: boolean;
  // Focus. Two entry points on purpose: ONLY the camera input port may change the mode.
  readonly focusId: string;                      // 'ship' in chase, the orbit focus otherwise
  readonly focusPositionOffset: number;          // packed-position offset, for SolarLighting
  focusBody(id: string): boolean;                // input port: ship => chase, body => observatory
  cycleFocus(step: number): string;              // input port: one ring across both modes
  focusObservatoryBody(id: string): boolean;     // Commands.setTarget / system map: mode unchanged
  orbitBy(deltaYawRad: number, deltaPitchRad: number): void;  // routed to the active camera
  zoomByWheel(wheelDelta: number): void;                      // routed to the active camera
  applyCameraSettings(settings: CameraSettings): void;        // persisted fov-widening / shake
  resetChase(): void;                            // restore teleports the ship; snap, do not spring
  // Chase read side, for the frozen `solarVoyagerCamera` browser diagnostic.
  readonly chaseDistanceShipLengths: number; readonly chaseArmDistanceKm: number;
  readonly chaseFovOffsetDeg: number; readonly chaseShakeAmplitudeDeg: number;
  readonly chaseFovWideningEnabled: boolean; readonly chaseShakeEnabled: boolean;
}
export const IMPLEMENTED_CAMERA_MODES: readonly CameraMode[];  // ['chase','observatory'] at T0110

// game/chaseCameraController.ts (T0110) — pure numeric, injected with the ship's packed-position
// offset and hull length because `game/` may not import `render/`.
export class ChaseCameraController {
  update(wallDtSec: number, attitudeQuaternion: Float64Array, throttle01: number,
    properAccelerationMS2: number, clearanceBodyIndex: number, frozen: boolean): void;
  setDistanceShipLengths(d: number): void; zoomByWheel(delta: number): void;
  orbitBy(deltaAzimuthRad: number, deltaElevationRad: number): void;
  resetArmOffsets(): void; reset(): void;
  setFovWideningEnabled(enabled: boolean): void; setShakeEnabled(enabled: boolean): void;
  readonly cameraPositionKm: MutableVec3; readonly subjectPositionKm: MutableVec3;
  readonly lookDirection: MutableVec3; readonly upDirection: MutableVec3;
  readonly distanceShipLengths: number; readonly armDistanceKm: number;
  readonly fovOffsetDeg: number; readonly shakeAmplitudeDeg: number;
  readonly attitudeLagRad: number;               // the 120 ms criterion, made observable
  readonly fovWideningEnabled: boolean; readonly shakeEnabled: boolean;
}

// game/settings.ts (T0110) — profile document generation 4, own storage key
export interface CameraSettings { readonly fovWidening: boolean; readonly shake: boolean }

// SimSnapshot additions (T0111, ADR): all primitives, double-buffer-safe
//   impactOccurred: 0|1, impactBodyIndex: number(-1 none), impactSpeedKmS: number,
//   impactSimTimeSec: number
// Commands additions: NONE in v2 core scope (P2 RCS translation would add one; deferred).

// game/diary/milestones.ts (T0146)
export interface MilestoneDef {
  id: string; title: string; hint: string;                   // hint shown pre-discovery
  test(s: SimSnapshot, ctx: DiaryContext): boolean;          // pure, allocation-free, 10 Hz
}
```

Naming rule: these exact names are load-bearing across tasks. If an implementing agent must deviate, they update this plan file in the same PR and note it in `handoff_notes`.

---

## 3. Key algorithm specifications (decisions already made)

### 3.1 Wall-time input authority (fixes v1 tumble landmine)

Rotation rates enter the sim in **sim-time** rad/s. To make stick/mouse feel warp-invariant:

```
rateSimRadS = clamp(inputRateWallRadS / effectiveWarp, -RATE_MAX, RATE_MAX)
manual rotation LOCKED for effectiveWarp > 100 (holds only)  // constant MANUAL_ATTITUDE_MAX_WARP = 100
```

`RATE_MAX = 0.6` (today's constant). FlightController applies this every frame; sim unchanged for manual rates.

### 3.2 Hold-mode slew (T0107, sim change)

Today hold modes snap the quaternion each derivative evaluation. New behavior: pursue the solved target direction with bounded angular step per accepted integrator segment:

```
θ_err   = angle(q_current, q_target)
θ_step  = min(θ_err, maxSlewRadPerSimS · dtSimSec)
q_next  = rotateTowards(q_current, q_target, θ_step)     // slerp by θ_step/θ_err
```

At 1× this yields a visible 15°/s slew. **Corrected by T0107 / ADR-035 — the original text here said "at warp ≥ 5× a full 180° flip completes in ≤ 0.24 s wall", which is arithmetically impossible at the contract rate and lost a factor of ten.** The rate is per *simulated* second, so a 180° flip costs `π / 0.261799 = 12.000 s` of simulation time at **every** warp tier, and wall time is `12.000 s / warp`:

| warp | 1× | 5× | 50× | 100× |
|---|---|---|---|---|
| wall time for 180° | 12.00 s | 2.40 s | 0.240 s | 0.120 s |

0.24 s is the **50×** figure. Reaching 0.25 s at 5× would require 2.51 rad/s (144°/s), contradicting the "visible 15°/s at 1×" in the same sentence, so the rate was not changed. T0114/T0116 must budget `θ_err / maxSlewRadPerSimS` of *sim* time for any slew (12 s for a flip at the default vessel). Full reasoning in `docs/decisions/ADR-035-attitude-slew.md`. Existing tests that assert snapped attitude get expectation updates in the same PR (documented in the ADR).

### 3.3 Cruise guidance (T0114 → physics-spec §8)

Constant-proper-acceleration boost–flip–brake to a rails target, relativistically exact in the 1D profile, vector-corrected iteratively:

1. Straight-line distance guess `d₀ = |r_t(t₀) − r₀|`, TOF guess from the relativistic brachistochrone: half-trip coordinate time `T_h` solves `d/2 = (c²/α)(√(1+(αT_h/c)²) − 1)`, so `T₀ = 2·T_h`.
2. Iterate k = 0…24: evaluate target at `t₀+T_k` (rails), recompute `d_k` including initial relative velocity projection (`d_k = |r_t(t₀+T_k) − r₀ − v₀·T_k|` first-order, minus the arrival radius), recompute `T_{k+1}`. Converged when `|T_{k+1}−T_k| < 0.5 s` (measured 2–3 iters on all five canonical routes; `ok=false` if not converged in 25). **T0114 adds one further `ok=false` condition (ADR-037 §4):** the contraction factor `κ = |v₀ − v_t(t₀+T)| / (αT/2)` must be `≤ 0.1` at convergence. Without it the iteration silently returns *spurious* roots in which the ship drifts past the target and boosts back — real solutions of the stated equation that "arrive" at thousands of km/s. Departure solves measure κ = 0.0019–0.036; mid-cruise re-solves measure 0.245–1.615. **The solver is a departure solver**; the endgame belongs to the step-6 pursuit rule.
3. Profile: thrust vector = unit(line-of-sight to predicted intercept), boost for `flipAt = T/2`, flip (attitude reversal via hold-mode slew), brake to rest at `arrivalRadiusKm = meanRadius·3` (planets/moons; ringed giants: outermost ring radius × 1.2; Sun: 25 R☉ for 'orbit', configurable for polar flyby), then `insert`: circularize using the analytic `v_circ = √(μ/r)` against the target's rails frame. **Corrected by T0114 / ADR-037 — the original text here said `flipAt = T/2` "(adjusted for initial v∥)" and "brake to *relative* rest", and both are wrong under step 2's own distance definition.** Subtracting `v₀·T` inside `d_k` puts the solve in the frame drifting at the ship's initial velocity, where the ship starts at rest: the parallel component of `v₀` is *already* removed, so a second correction to the flip time would double-count it, and the flip is at exactly `T/2`. The profile therefore arrives at rest **in that drift frame, not relative to the target** — a single fixed thrust axis cannot match both an arrival position and an arrival velocity. The residual `v₀ − v_target(t_arrival)` (measured 6.8–63.5 km/s on the canonical routes) is the `insert` phase's to remove, sized with `relativisticStopDistanceKm`. Full derivation in physics-spec §8.4.
4. Mid-course: re-solve every 300 s sim OR on phase change OR if lateral drift > 0.5% of remaining distance. CruiseDirector feeds α and attitude via existing `Commands` only.
5. Proper time / γ for HUD from the same closed forms: `τ = (c/α)·asinh(αT_h/c)·2` per leg, `peakBeta = tanh(asinh(αT_h/c))`… (full derivation transcribed into physics-spec §8 by T0114, with symbols matching `relativity.ts`).
6. **Fallback pursuit** (always available, also the abort-resume mode): point at target lead position; full α while `distance > 1.2 × relativisticStopDistanceKm(v_rel, α)`; else brake. No TOF solve needed.

Reference wall-times at α = 10 g, thrust-warp 1000× (before T0115 retune): Earth→Moon ≈ 1.1 h sim ≈ 4 s + ramps ≈ ~1 min wall; Earth→Mars (0.52 AU) ≈ 1.0 d sim ≈ 90 s wall; Earth→Jupiter (4.2 AU) ≈ 1.9 d sim ≈ 2.7 min; Earth→Neptune ≈ 4.9 d sim ≈ 7 min (drops to ≈ 2.3 min if T0115 lands 3000×). These validate spec pacing (2–5 min interplanetary) without touching physics.

### 3.4 Collision semantics (T0111, ADR)

Per accepted integrator segment, test ship segment vs sphere `radius_col(body) = meanRadiusKm` (+ `surface.atmosphereTopKm` when non-null; gas/ice giants get their 1-bar cloud-deck radius entered as `atmosphereTopKm` in the same PR — data change, ADR-covered). Reuse `trajectoryImpact.smallestUnitRoot` for the segment/sphere root. On hit: bisect to contact time (tolerance 1 ms sim), freeze integration, publish snapshot with impact fields set, `SimulationCore.step()` becomes a no-op until `restoreFromState()` or `respawnInOrbit()` (game layer calls, backed by `restorePoints.ts`: ring of 6 snapshots taken every 10 s wall). Warp forced to 1× on impact. No NaN path: the singularity guard becomes unreachable for the ship.

### 3.5 Adaptive exposure (T0127)

Scalar exposure driven by a physically-motivated key: `E_target = clamp(K / L_scene, E_min, E_max)` where `L_scene` is the sum of (a) solar irradiance at camera distance (inverse-square from `visualTier`'s existing math) and (b) dominant-body reflected luminance (albedo × phase, same helpers). Exponential adaptation: τ_bright→dark = 6 s, dark→bright = 2 s. `E_min/E_max` chosen so (i) Neptune daylight reads, (ii) near-Sun the photosphere stays below clip with corona visible. Must not break `visualTier` magnitude tests: the tier ladder keeps consuming *physical* magnitudes; exposure is display-only (single owner: `exposureController.ts` writing `toneMappingExposure` via the pass-insertion API).

### 3.6 Plume model (T0122)

The photon drive exhausts collimated light: render as (a) a narrow emissive beam mesh (cylinder + cone falloff, length ∝ throttle^0.7 × up to 4 ship lengths, additive, bloom-friendly), (b) nozzle glow sprite, (c) far-field: when ship angular size < point threshold, add plume luminance into the existing `bodyPointCloud`-style ship point so a burning ship is visible across space (artificial-star effect). No particle physics; deterministic from snapshot (throttle, attitude), zero per-frame allocation.

---

## 4. ADR queue (write in the same PR as the implementing task)

| # | Working title | Task | Content outline |
|---|---|---|---|
| ADR-032 | v2 kickoff: scope, pillars, WebGL2 reaffirmed, budget-revision policy | T0103 | spec pointer; explicit non-goals; "budgets change only via dedicated reviewed commits" |
| ADR-033 | Release-scoped readiness checking | T0102 | release manifest concept; v1 boundary preserved |
| ADR-034 | VesselConfig | T0104 | fields, defaults, save-envelope v3 migration, settings untouched |
| ADR-035 | Attitude slew + wall-time input authority | T0107 | §3.1–3.2 formulas; test-tolerance revisions enumerated |
| ADR-036 | Collision & impact semantics | T0111 | §3.4; snapshot fields; restore/respawn contract; cloud-deck radii data |
| ADR-037 | Constant-α relativistic intercept (physics-spec §8) | T0114 | §3.3 math; golden policy for cruise scenarios |
| ADR-038 | Thrust-warp ceiling revision (amends ADR-026) | T0115 | benchmark method; chosen tier; tolerance evidence |
| ADR-039 | Source-texture fetch policy | T0132 | pinned URLs + SHA-256; `SOURCES.md` unchanged; repo-budget rationale |
| ADR-040 | Atmosphere data contract (`data/atmospheres.json`) | T0140 | schema; per-body params; scattering model summary |
| ADR-041 | Audio architecture & licensing intake | T0144 | Web Audio graph; manifest; Kubrick-mode honesty labeling |
| ADR-042 | Diary storage & album export | T0146 | IndexedDB layout; quota policy; export format v1 |

(Numbers indicative — actual next-ADR number checked at execution time; keep this order.)

---

## 5. Tasks

Notation: every task block contains the **exact YAML to commit** (10-field schema), files, interfaces, design guidance (with landmines), required tests with tolerances, and definition-of-done checkboxes. `spec:` always points to the release spec §; complex tasks must add their own per-task design doc first (noted in `handoff_notes`).

---

### V2M1 — "The ship exists"

#### T0102 — Release-scoped readiness check

```yaml
id: T0102
title: Generalize release readiness to release-scoped task sets
status: TODO
agent: ""
branch: ""
depends_on: []
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §14.1
acceptance:
  - releaseReadiness.mjs validates tasks against a committed release manifest (v1 set frozen; v2 tasks allowed in any status)
  - CI green on a branch containing a dummy TODO task T9999 (removed before merge)
  - --final mode for v1 unchanged (proven by existing tests); new --release=v2 mode covered by new unit tests
  - check:dashboard behavior unchanged; docs/check_plan.html regenerated
handoff_notes: "BLOCKING HEAD OF V2. Add tools/checks/releaseManifest.json listing v1 task ids as the frozen released set. Do not weaken any other check."
```

- Files — Modify: `tools/checks/releaseReadiness.mjs`; Create: `tools/checks/releaseManifest.json`, tests beside existing check tests; Modify: `package.json` script args if needed.
- Guidance: keep the v1 invariant intact (T0060–62 BLOCKED, all v1 DONE); the new rule is "tasks not in the released manifest are exempt from the DONE requirement, but still schema-checked". Landmine: `check:release` runs on every PR — test with an actual scratch TODO file on the branch.
- [ ] Failing test for manifest-exempt task → implement → green
- [ ] Dummy-task CI proof on branch; remove dummy; merge

#### T0103 — v2 kickoff docs: ADR-032, roadmap, protocol pointers

```yaml
id: T0103
title: Add v2 kickoff ADR, roadmap milestones V2M1-V2M6, doc pointers
status: TODO
agent: ""
branch: ""
depends_on: [T0102]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §3,§14
acceptance:
  - docs/decisions/ADR-032 added (scope, WebGL2 reaffirm, budget policy)
  - docs/roadmap.md gains a v2 section with V2M1-V2M6 exits copied from the spec
  - docs/architecture.md directory map corrected (removes phantom files noted in the 2026-08-14 audit) and lists planned v2 modules
  - AGENTS.md points to the v2 spec+plan as active work
handoff_notes: "Docs-only. Also fix architecture.md stale entries (bodies/catalog.ts, leapfrog.ts, shipState.ts, deltaV.ts, soi.ts, warnings.ts do not exist) and the false 'rendezvous math in analysis/' claim."
```

- [ ] ADR + roadmap + architecture fixes in one PR

#### T0104 — VesselConfig in sim (ADR-034)

```yaml
id: T0104
title: Introduce VesselConfig; remove hardcoded ship mass and fixed alpha
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.2,§12.2
acceptance:
  - SimulationCore constructed with VesselConfig; SHIP_MASS_KG constant deleted from src/main.ts and flightBenchmarkRoute
  - Save envelope v3 with v2->v3 migration fixture test; embedded settings DTO untouched (stays GameSettingsV1)
  - alphaMaxMS2 default 98.0665 reachable; existing 1 g goldens still pass by pinning their scenarios to alpha=9.80665
  - Energy-ledger Hohmann and plane-change tests unchanged and green
handoff_notes: "Write per-task design doc first. ADR-034 in same PR. Interfaces in plan §2 are binding. Landmine: ledger/burn-basis/persistence tri-coupling (simulation.ts:543-622, simulationState.ts:91-143) revalidates mass-derived values on load — thread vessel through all three."
```

- Files — Create: `src/sim/ship/vessel.ts`; Modify: `src/sim/simulation.ts`, `src/sim/simulationState.ts`, `src/game/saveLoad.ts` (envelope v3), `src/game/createNewGameSimulation.ts`, `src/main.ts`, `src/game/flightBenchmarkRoute.ts`.
- Tests: vessel defaults; envelope v2→v3 migration (fixture: committed v2 save loads, vessel = defaults); goldens green at pinned α; throttle × alphaMaxMS2 produces P = m·α·c within 1e-12 relative.
- [ ] Design doc → tests → impl → goldens green → ADR → commit

#### T0105 — Input engine core (pointer lock, analog, focus policy)

```yaml
id: T0105
title: New input engine: pointer lock, analog axes, UI-focus policy
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.2,§7
acceptance:
  - Pointer-lock mouse-look deltas exposed as wall-frame rad; ESC releases lock and opens pause (stub OK until T0112)
  - Flight input NEVER disabled by focused BUTTON elements or held Shift (regression tests for both v1 defects)
  - Analog throttle axis [0,1] with keyboard ramp (full sweep 1.5 s) replacing 10-step ratchet
  - KeyboardCommandMapper removed; all 13 existing bindings preserved via new bindings registry; rebind UI still works
  - Zero frame-loop allocations (heap gate green)
handoff_notes: "Design doc first. Keep settings schema compatibility: bindings stay KeyboardEvent.code map in GameSettingsV2 profile. Editable-target policy: only INPUT/TEXTAREA/SELECT/contenteditable block flight keys; buttons do not."
```

- Files — Create: `src/game/input/inputEngine.ts`, `src/game/input/bindings.ts`; Delete: `src/game/inputMapping.ts` (port its per-frame flush shape); Modify: `src/ui/cameraInputController.ts` consumers, `src/game/settings.ts` (only additive).
- Interfaces produced: `InputFrame { lookYawRad, lookPitchRad, axes: {pitch,yaw,roll,throttle}, pressed(action): boolean, pressCount(action): number, held(action): boolean }`, published by `InputEngine.poll(wallDtSec)` once per frame and consumed by FlightController.
  - As shipped (T0105, per the §2 naming rule): `poll` takes `wallDtSec` because the engine owns the analog throttle ramp and the ramp needs a time base. `pressCount` exists because two `=` taps between two polls must step warp twice — v1 acted on every `keydown` immediately and a boolean silently drops the second. `held` is the level query for consumers that need "is the player on the stick" without re-deriving it from `axes` (T0116's cruise decompress-on-input rule).
- Tests: Shift+W still pitches; focused warp button + W still pitches; throttle ramp timing; pointer-lock delta scaling; rebind persistence.
- [ ] Design doc → failing regression tests for both v1 defects → impl → green → commit

#### T0106 — Gamepad + expanded rebinding UI

```yaml
id: T0106
title: Gamepad support and rebinding UI extension
status: TODO
agent: ""
branch: ""
depends_on: [T0105]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §7
acceptance:
  - Gamepad API polling mapped to axes (deadzone 0.08, curve exponent 1.6, both configurable in settings)
  - Standard-mapping default: left stick pitch/yaw, right-X roll, triggers throttle, A cruise-engage, B abort
  - Settings UI: per-axis invert + sensitivity; profile v2->v3 settings migration test
  - No polling cost when no gamepad connected (0 allocations, early-out)
handoff_notes: "Poll in the existing frame loop before FlightController.update; never in an interval."
```

- [ ] Tests (mapper pure functions) → impl → settings UI → commit

#### T0107 — Attitude slew in sim (ADR-035)

```yaml
id: T0107
title: Slew-limited hold modes and wall-time rotation authority contract
status: TODO
agent: ""
branch: ""
depends_on: [T0104]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.2,§12.2; plan §3.1-3.2
acceptance:
  - Hold modes pursue target direction at maxSlewRadPerSimS (vessel), never snap; formula per plan §3.2
  # CORRECTED by ADR-035: the original "warp >= 5x ... <= 0.25 s wall" is impossible
  # at the contract slew rate. A 180° reorientation costs 12.000 s of SIM time at every
  # tier, so wall = 12.000/warp: 2.40 s at 5x, 0.240 s at 50x. Verified at both tiers.
  - A 180° reorientation costs pi/maxSlewRadPerSimS = 12.000 s sim at every warp tier,
    i.e. 12.000/warp wall: <= 2.5 s at 5x and <= 0.25 s at 50x (test with mocked wall clock)
  - Prograde-hold LEO golden segment: position drift vs pre-change baseline < 1e-3 km over 1 orbit (slew converges then tracks)
  - MANUAL_ATTITUDE_MAX_WARP=100 exported from core/time.ts; rates above it rejected by Commands validation
  - ADR-035 lists every test whose expectation changed
handoff_notes: "sim/ship/attitude.ts change. Landmine: axis remap [roll,pitch,yaw] at simulation.ts:385-387 — add the missing explanatory comment while there."
```

- Tests: slerp step math vs analytic; hold convergence time at 1× = θ/maxSlew ± 1 integrator step; warp semantics; energy-ledger warp-invariance still 1e-12.
- [ ] Design doc → tests → impl → tolerance-change audit in ADR → commit

#### T0108 — FlightController

```yaml
id: T0108
title: FlightController: mouse-look pursuit, throttle, hold orchestration
status: TODO
agent: ""
branch: ""
depends_on: [T0105, T0107]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.2
acceptance:
  - Mouse-look: desired attitude integrates look deltas; pursuit issues rotate() rates capped per plan §3.1; critically damped settle (no overshoot > 2°) verified in test
  - Manual throttle capped at alphaManualMaxMS2/alphaMaxMS2 fraction; full range available to CruiseDirector later
  - All 8 AttitudeMode holds reachable from bindings; kill-rotation on idle default (SAS) toggleable
  - update() allocation-free (bench:sim harness extended to include controller step; retained-heap delta 0)
handoff_notes: "Design doc first. Pure game-layer: only existing Commands. Damping law shipped as the second-order form omega_dot = k_p*theta_err - k_d*omega integrated in wall time. FINAL CONSTANTS: k_p = 6.0 s^-2, k_d = 2*sqrt(k_p) = 4.898979485566356 s^-1, i.e. zeta = 1 exactly. The suggested k_p=2.5/k_d=0.9 was zeta=0.28 (39.3% overshoot measured) and too soft for the 2 s budget past ~12 deg; 6.0 puts the 0.6 rad/s saturation knee at ~45 deg. Overshoot is identically 0 at every step size. Rate saturation is applied in the WALL frame before the plan 3.1 division — see physics-spec 3.0.1, the order is what makes a saturating input warp-invariant."
```

- Interfaces consumed: `InputFrame` (T0105), `VesselConfig` (T0104). Produces: class in plan §2.
- [ ] Design doc → pursuit math unit tests (converge ≤ 2 s at 1×, no overshoot) → impl → wire into frame loop → commit

#### T0109 — Ship visible + camera target

```yaml
id: T0109
title: Render the ship and register it as a camera focus target
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §5,§6.3
acceptance:
  - ship.glb (existing asset) loaded via BodyAssetLoader, bound through CameraRelativeSpaceScene, attitude-driven from snapshot quaternion
  - Ship appears in camera target list with positionOffset from shipState; '[' ']' cycle includes it
  - Sunlit correctly at LEO; visible at all tiers (point sprite beyond angular threshold, reuse apparent-magnitude path with hull albedo 0.45)
  - Draw-call golden re-baselined in a dedicated commit (expected +2..3); heap gate green; new Playwright harness test:ship-visual in CI
handoff_notes: "The asset is already deployed and never loaded — this is wiring, not art. Landmine: RuntimeResourceCounts asserts exact resource counts; extend the contract in the same PR."
```

- Files — Create: `src/render/shipVisual.ts`, `tools/tests/shipVisualRegression.mjs`; Modify: `src/render/createEpochWorld.ts` (targets), `src/game/orbitCameraController.ts` (ship target), CI workflow.
- [ ] Load+bind → attitude coupling test (quaternion → matrix) → tier integration → Playwright harness → golden re-baseline commit → merge

#### T0110 — Chase camera + CameraDirector v0

```yaml
id: T0110
title: Chase camera with spring arm; CameraDirector chase/observatory
status: TODO
agent: ""
branch: ""
depends_on: [T0109, T0108]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §5
acceptance:
  - Chase: position = ship - forward*d + up*0.35d, d in [2,50] ship lengths (wheel), critically damped spring (settle < 0.8 s, zero overshoot in test), attitude-follow with 120 ms lag
  - FOV widens up to +8° at full throttle (smoothed 0.5 s); shake amplitude <= 0.15° at alpha >= 5 g; both OFF via settings
  - CameraDirector cycles chase<->observatory with the existing smootherstep/log-distance transition (no cuts)
  - Allocation-free update; test:camera-controls harness extended; 60 fps maintained (bench evidence)
handoff_notes: "Design doc first. f64 controller pattern like orbitCameraController (pure numeric module + thin three.js adapter). Relativistic post pass observer stays the SHIP velocity (already correct source) — now finally coherent with the camera."
```

- [ ] Design doc → spring math tests → impl → transitions → FOV/shake → bench + harness → commit

#### T0111 — Collision, restore, respawn (ADR-036)

```yaml
id: T0111
title: Surface collision with impact event, restore points, respawn
status: TODO
agent: ""
branch: ""
depends_on: [T0104]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.4; plan §3.4
acceptance:
  - Segment/sphere detection per accepted step vs meanRadius (+atmosphereTopKm when set); contact bisected to <= 1 ms sim; snapshot impact fields per plan §2
  - Post-impact: step() no-ops; restoreFromState(ring[i]) and respawnInOrbit(2 radii circular) both produce valid, golden-consistent states
  - Restore ring: 6 slots, 10 s wall cadence, zero frame-loop allocation (preallocated state copies)
  - Gas/ice giants get cloud-deck atmosphereTopKm values in data (Jupiter 71492+5000 style — values documented in ADR); bodies.json untouched otherwise
  - Impact UI: freeze overlay with speed/body/time + Restore/Respawn buttons; warp forced 1x
handoff_notes: "ADR-036 with SimSnapshot delta. Reuse trajectoryImpact.smallestUnitRoot. Impact must also fire when prediction missed it (thrusting descent)."
```

- Tests: head-on LEO decay impact fires within 1 ms of analytic crossing; graze (periapsis = radius+0.1 km) does NOT fire; restore determinism (restore → identical snapshot hash); respawn orbital elements e < 1e-3.
- [ ] Design doc → sim tests → impl → ring buffer → UI overlay → ADR → commit

#### T0112 — HUD Clean preset, pause, world markers v0

```yaml
id: T0112
title: HUD preset system (Clean v0), pause menu, target diamond
status: TODO
agent: ""
branch: ""
depends_on: [T0105, T0109]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §7
acceptance:
  - Preset state machine Clean/Pilot/Engineer (key cycles; Engineer = all v1 panels); Clean shows reticle, throttle+speed strip (context units: m/s < 1000, else km/s, else %c), warnings, cruise strip placeholder
  - World markers overlay: target diamond + distance, prograde/retrograde chevrons, and toggleable body labels with live distances, projected via camera (DOM layer, 10 Hz signals, no per-frame allocation)
  - Real pause: ESC opens menu (sim halted via warp-hold, not skipped frames), resume/settings/save/exit-to-menu; sceneManager gains 'paused' sub-state and menu return
  - New CSS layout: design tokens + grid; app.css absolute-positioning removed for migrated panels (rest migrate in T0119/T0149)
handoff_notes: "Design doc first. Marker projection: reuse the DOM-rect->GL pattern inverse (project f64 world->NDC in game layer, write CSS transforms via signals). SceneManager one-way landmine: this task makes menu return real."
```

- [ ] Design doc → preset store tests → markers projection tests (known camera pose → expected NDC) → pause state machine tests → impl → commit

#### T0113 — main.ts decomposition (diagnostics contract first)

```yaml
id: T0113
title: Decompose main.ts into bootstrap modules with diagnostics contract test
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M1
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §12.3
acceptance:
  - New tests/architecture/diagnosticsContract.test.ts asserts all 6 canvas diagnostics + RuntimeResourceCounts shapes BEFORE the split; unchanged after
  - main.ts <= 200 lines (imports + composition call); src/bootstrap/{composition,frameLoop,diagnostics}.ts own the rest verbatim (behavior-preserving). NAMING-RULE DEVIATION, T0113: the planned `game/bootstrap/` is impossible — `import/no-restricted-paths` forbids `src/game` importing `src/render`+`src/ui`, and the composition root must import both. It lives at `src/bootstrap/`, beside `main.ts` and outside every layer, and `docs/architecture.md` is corrected in the same PR.
  - All 24 Playwright harnesses green without modification (proof the contracts held)
  - Frame-loop instrumentation seams (sim/render/ui ms splits) preserved exactly
handoff_notes: "Behavior-preserving refactor ONLY — no new features. Move code, keep order. The startup sequence order (renderer->world->probe->menu->activation) is hard-won; transcribe, don't re-derive."
```

- [ ] Contract test green pre-split → mechanical extraction → all harnesses green → commit

**V2M1 exit (verified in T0113's PR description + a manual flight):** fly LEO→Moon by hand with mouse-look, crash into the Moon, restore, all sim goldens + 24 harnesses green, 60 fps reference.

---

### V2M2 — "The system is yours"

#### T0114 — Guidance solver + physics-spec §8 (ADR-037)

```yaml
id: T0114
title: Constant-acceleration relativistic intercept solver (physics-spec §8)
status: TODO
agent: ""
branch: ""
depends_on: [T0104]
milestone: V2M2
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.3; plan §3.3
acceptance:
  - physics-spec.md gains §8 with the full derivation (symbols matching relativity.ts); ADR-037 in same PR
  - solveInterceptInto + relativisticStopDistanceKm per plan §2 signatures, pure, allocation-free
  - Convergence: Earth->{Moon,Mars,Jupiter,Neptune} and LEO->Sun-polar-flyby all ok=true, <= 12 iterations, |arrival miss| < 0.1% of trip distance when profile is followed by a test integrator
  - Relativistic exactness: 1D profile vs closed-form hyperbolic motion 1e-9 relative (reuse relativity test harness); stop distance vs (c^2/alpha)(gamma-1) exact
  - Degenerate cases return ok=false cleanly: target = current dominant body within 2 radii; alpha <= 0; unconverged
handoff_notes: "Design doc first. Pure sim module; consumes CompiledRails read-only. The fallback pursuit rule (plan §3.3.6) is part of this task's spec text but implemented in T0116."
```

- [ ] Design doc → closed-form tests → iteration tests per destination → spec §8 text → ADR → commit

#### T0115 — Thrust-warp ceiling retune (ADR-038)

```yaml
id: T0115
title: Benchmark and raise MAX_THRUST_WARP (amends ADR-026)
status: TODO
agent: ""
branch: ""
depends_on: [T0114]
milestone: V2M2
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.3
acceptance:
  - Reproducible benchmark (tools/bench) measuring golden-scenario error and step budget at thrust-warp {1000, 3000, 5000, 10000} under alpha in {2g, 10g}
  - Chosen ceiling = highest tier with error within existing golden tolerances AND p95 frame sim cost <= 2 ms; recorded in ADR-038 with tables
  - core/time.ts MAX_THRUST_WARP updated; warp clamp reasons/UI unchanged; energy-ledger warp-invariance still 1e-12
  - If 1000x remains the answer, ADR documents why and CruiseDirector burn-coast-burn fallback becomes the pacing mechanism (note in handoff)
handoff_notes: "Evidence-first task: the number comes from the bench, not the wish. Cross-platform nondeterminism (ADR-017) applies — run bench on CI ubuntu too."
```

- [ ] Bench harness → data tables → pick ceiling → ADR → constant change → goldens green → commit

#### T0116 — CruiseDirector

```yaml
id: T0116
title: CruiseDirector: engage/abort, phase machine, warp piloting, insertion
status: TODO
agent: ""
branch: ""
depends_on: [T0114, T0108]
milestone: V2M2
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.3; plan §2,§3.3
acceptance:
  - Phases idle/align/boost/flip/brake/insert/done/aborted per plan §2; flip uses hold-mode slew; mid-course re-solve per plan §3.3.4
  - Warp piloting: requests ladder tiers respecting all existing clamps; decompress to <=100x within 1 s wall on ANY player input, abort, SOI change, or collision warning
  - LEO->Jupiter 'orbit' arrival: stable orbit (e < 0.05, altitude within 10% of preset) in <= 5 wall minutes at reference settings, fully unattended (Playwright-driven run in CI, headless-time-tolerant)
  - Abort at any phase leaves a valid controllable state (fuzz test over 200 random abort times on the Mars route)
  - Ledger honesty preserved: cruise energy equals integrator ledger (no side channel), asserted vs analytic 2*(gamma_peak-1)mc^2 within 2%
handoff_notes: "Design doc first. Game layer only (existing Commands). Insertion: brake to rails-relative rest at arrivalRadius then circularize via two hold-mode burns computed from osculating elements. Fallback pursuit implemented here per §3.3.6."
```

- [ ] Design doc → phase-machine unit tests (mock sim) → integration vs real sim (Mars route) → warp piloting tests → CI cruise run → commit

#### T0117 — Click-to-target picking

```yaml
id: T0117
title: Select cruise/nav target by clicking bodies in-world and in map
status: TODO
agent: ""
branch: ""
depends_on: [T0112]
milestone: V2M2
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §7
acceptance:
  - Screen-ray picking against body angular discs (min pick radius 8 px) in space view; nearest-along-ray wins; ship excluded
  - System map click selects focus/target; 'set as cruise target' affordance in both views
  - Target panel select stays as fallback; all three paths converge on Commands.setTarget
  - Zero allocation per click-frame; picking math unit-tested (known camera pose -> expected body)
handoff_notes: "Pick in game layer using f64 positions + camera pose (no three.js Raycaster on meshes — bodies are points/spheres at wild scales; angular-disc math is exact and cheap)."
```

- [ ] Picking math tests → impl both views → commit

#### T0118 — Assists suite completion

```yaml
id: T0118
title: Bind all holds; approach-brake and manual flip assists; per-assist toggles
status: TODO
agent: ""
branch: ""
depends_on: [T0116]
milestone: V2M2
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.2
acceptance:
  - All 8 AttitudeModes bound (defaults documented in controls.md); target-hold points at nav target
  - Approach brake: warns when distance < 1.5x stop distance (relativisticStopDistanceKm); auto-engages retrograde+throttle at 1.2x when enabled; disengages at rel speed < 1 m/s
  - Manual flip-and-burn: single key executes 180° slew + throttle restore
  - Settings: per-assist enable/disable persisted; HUD shows active assist chip
handoff_notes: "Assists live in game/flight/assists.ts consuming snapshot + brakingEnvelope. No sim changes."
```

- [ ] Brake-envelope trigger tests → impl → bindings + settings → commit

#### T0119 — Cruise HUD strip + dual-clock drama

```yaml
id: T0119
title: Cruise status strip, ETA dual clocks, compression indicator, map engage
status: TODO
agent: ""
branch: ""
depends_on: [T0116, T0112]
milestone: V2M2
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.3,§7
acceptance:
  - Strip shows phase, target, ETA in coordinate AND proper time, current compression (warp), peak beta forecast, abort hint; gamma highlighted > 1.001
  - Present in all HUD presets (Clean included); 10 Hz signals; zero frame allocation
  - Map gains 'engage cruise' on selected body (wires T0117)
  - Playwright harness asserts strip renders during a scripted cruise and clocks visibly diverge on a 0.3c leg
handoff_notes: "Reuse formatUnits SI prefixes; dual-clock copy pattern from DualClock component."
```

- [ ] Signals store tests → component → harness → commit

#### T0120 — Cruise goldens + accuracy gates

```yaml
id: T0120
title: Golden cruise scenarios and CI accuracy gates
status: TODO
agent: ""
branch: ""
depends_on: [T0116, T0115]
milestone: V2M2
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §14.2,§15
acceptance:
  - Four committed goldens: LEO->Moon, LEO->Mars, LEO->Jupiter, LEO->Sun-north-pole flyby (daily-sample format of ADR-017)
  - Tolerances: position 1e-3 km/day sample vs regeneration; ledger energy vs analytic bound within 2%; tau/t ratio vs closed form 1e-6
  - Gate runs in npm test (not browser); regeneration flag + golden: commit discipline documented
  - V2M2 exit checklist in PR: click-Jupiter-arrive <= 5 min proven by T0116's CI run; abort fuzz green
handoff_notes: "Extends tests/golden/goldenComparison harness; scenario driver may reuse flightBenchmarkRoute-style synthesis."
```

- [ ] Scenario driver → capture goldens → tolerance tests → CI wiring → commit

---

### V2M3 — "Stunning I"

#### T0121 — Ship remodel (Blender)

```yaml
id: T0121
title: Remodel the ship for close-up beauty (build_ship.py v2)
status: TODO
agent: ""
branch: ""
depends_on: [T0109]
milestone: V2M3
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.3
acceptance:
  - New build_ship.py: hull paneling, canopy, 4 RCS pod clusters, nozzle assembly, light housings; 18000-28000 tris (budget 30000)
  - Contracts preserved: +X nose/thrust (ADR-025), nodes hull_tip + engine_nozzle + NEW rcs_pod_[1-4] + light_[nav_l,nav_r,beacon]; meters scale; byte-identical double rebuild
  - Authored PBR textures 2048x1024 (albedo/normal/metallic-rough/emissive) via textures-src workflow with SOURCES.md; ingest green; all three tier variants
  - Ship budget file total <= 8 MB; test:blender smoke green; visual check renders committed to docs/bench
handoff_notes: "Read agents/skills/blender-asset-authoring.md. Determinism rules: analytic normals, texcoord rounding, canonical triangle order (see common/export.py). The new node names are consumed by T0122 — they are API."
```

- [ ] Design doc (concept sheet) → geometry → textures → determinism proof → ingest → commit

#### T0122 — Plume, RCS, running lights

```yaml
id: T0122
title: Photon-beam plume, RCS puffs, ship lights
status: TODO
agent: ""
branch: ""
depends_on: [T0121]
milestone: V2M3
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.3; plan §3.6
acceptance:
  - Beam per plan §3.6 anchored at engine_nozzle; intensity/length respond to throttle within 1 frame; zero when coasting
  - Far-field: ship point sprite gains plume luminance term so a full burn is visible from >= 1 AU (apparent-magnitude math documented)
  - RCS puffs at rcs_pod_* fire on rotation commands (sprite pool, preallocated, max 16 live)
  - Nav lights + beacon blink (sim-time driven); all effects governed (governor rung reduces particle pool + beam segments)
  - Playwright harness test:ship-vfx; draw-call golden re-baselined (+<=4); heap gate green; bench evidence
handoff_notes: "onBeforeCompile hook pattern + prepareCompilationPass warm-up (no first-burn shader stall). Additive transparency: mind the crossfade depthWrite landmine — beam renders after bodies with depthTest true, depthWrite false."
```

- [ ] Design doc → beam shader → far-field term test → RCS pool → lights → harness + bench → commit

#### T0123 — Planetshine + hull specular

```yaml
id: T0123
title: Planetshine secondary light and sun specular on hull
status: TODO
agent: ""
branch: ""
depends_on: [T0122]
milestone: V2M3
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.3
acceptance:
  - Second directional light: direction from dominant body, color/intensity = albedoColor x phase x solid-angle (formula in per-task design; LEO night side clearly lit by earthshine, intensity <= 8% of solar)
  - Optional 'camera fill' accessibility light (settings, default off, labeled artistic)
  - No per-frame allocation; light updates from snapshot in the existing lighting update path
  - Playwright harness extends lighting suite; bench evidence
handoff_notes: "One extra DirectionalLight total (not per body). Solar specular already comes from MeshStandardMaterial + sun light — verify metallic-rough map from T0121 reads well and record reference screenshots."
```

- [ ] Formula tests → impl → harness → commit

#### T0124 — Cockpit-lite camera

```yaml
id: T0124
title: Cockpit-lite first-person camera with glass HUD variant
status: TODO
agent: ""
branch: ""
depends_on: [T0110, T0121]
milestone: V2M3
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §5
acceptance:
  - Camera at canopy node, attitude-locked, small look-around cone (+-30° with mouse hold)
  - Canopy frame silhouette rendered (from ship model interior-facing shell — no full interior)
  - HUD 'glass' skin for Clean preset in cockpit (reticle + strip restyled; same signals)
  - Relativistic post pass verified coherent in cockpit (observer = ship exactly); aberration/Doppler harness case added
handoff_notes: "CameraDirector gains 'cockpit'. If T0121's canopy occludes badly, coordinate a build_ship.py patch (interior shell flag) rather than hacking render-side."
```

- [ ] Camera pose tests → canopy render → glass skin → relativistic case → commit

#### T0125 — Cinematic/photo mode

```yaml
id: T0125
title: Cinematic free camera and photo capture
status: TODO
agent: ""
branch: ""
depends_on: [T0110]
milestone: V2M3
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §5,§8
acceptance:
  - Cinematic mode: orbit the ship (existing orbit controller, ship target), roll (Q/E), FOV 20-90°, HUD hidden, slow-drift idle
  - Capture: canvas -> PNG blob (preserveDrawingBuffer-free path via re-render into a target), saved through a CaptureSink interface (T0147 provides IndexedDB sink; this task ships a download sink)
  - Capture stamps metadata object {simTimeSec, tauSec, positionKm, dominantBodyId, gammaMax}
  - No steady-state allocation; capture may allocate transiently (excluded window documented for heap gate)
handoff_notes: "CaptureSink interface is consumed by T0147 — keep it: capture(blob: Blob, meta: CaptureMeta): Promise<void>."
```

- [ ] Mode + roll/FOV → capture path → sink interface → commit

#### T0126 — Milky Way + zodiacal light

```yaml
id: T0126
title: Milky Way panorama and zodiacal light
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M3
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.4
acceptance:
  - ESO/Gaia-derived CC panorama (attribution in credits + SOURCES.md) as KTX2 equirect sphere behind the star Points, correct galactic orientation vs J2000 (verified against 3 bright-star positions in test)
  - Lazy-loaded post-activation (NOT in initial-path.json); startup gate unchanged
  - Zodiacal light: faint ecliptic-plane additive gradient, <= 2 nits equivalent, toggleable
  - Optional constellation-lines overlay (88 IAU constellations from the existing Yale star indices, single LineSegments batch, toggle in HUD settings, off by default)
  - Governor rung: skybox resolution tier; aberration shader applies to the panorama exactly as to stars
  - Playwright harness test:milky-way; asset budget check green
handoff_notes: "Panorama must pass through the SAME observer-aberration path as starfield or high-beta views will shear the sky inconsistently (extend the vertex-shader approach)."
```

- [ ] Source + bake → orientation test → shader path → lazy-load wiring → harness → commit

#### T0127 — Adaptive exposure + pass-insertion API

```yaml
id: T0127
title: Pass-insertion API and adaptive exposure controller
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M3
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.2; plan §3.5
acceptance:
  - lightingPostPipeline gains insertPass(pass, anchor) with ordering contract + tests; existing pass order unchanged by default (all 21 render harnesses green)
  - Exposure per plan §3.5: correct trend proven at Mercury/Earth/Neptune/near-Sun test poses; adaptation time constants 2 s / 6 s (+-10% in test)
  - visualTier magnitude tests untouched and green (exposure is display-only)
  - Settings: exposure mode auto/fixed; governed (can pin at fixed on low tier)
handoff_notes: "This task creates the API T0142 and future passes use. The AdaptiveSmaa/Bloom private-field casts live here — contain them behind the API and add a three.js-version canary test."
```

- [ ] API + tests → controller math tests → integration poses → harness → commit

#### T0128 — Body rotation, tilt, oblateness

```yaml
id: T0128
title: Apply sidereal rotation, axial tilt, tier-2 oblateness; sim-time clouds
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M3
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1
acceptance:
  - All bodies rotate: angle = 2*pi*(simTimeSec/siderealRotationPeriodSec) about the tilted axis (axialTiltRad about the orbit normal); verified for Earth vs a known epoch sub-solar longitude within 1°
  - Ringed-body double-tilt fixed (ringSystem.ts:195 refactor — single tilt owner)
  - polarRadiusRatio applied to tier-2 spheres (scale, and normal-correct via shader flag) — no pop at tier 2<->3
  - Earth clouds move to sim time (wall-clock landmine fixed); pause freezes them
  - Playwright tier harness cases extended; zero new allocation
handoff_notes: "bodySpin.ts computes per-body quaternions into the packed attitude path once per frame (43 quats, preallocated). Rotation phase at epoch is UNCALIBRATED (catalog has no W0): document 'phase-accurate rotation rate, arbitrary epoch phase' honestly in release notes; Earth may be hand-anchored to J2026 sub-solar point."
```

- [ ] Spin math tests → render wiring → oblateness → clouds fix → harness → commit

#### T0129 — Far-plane strategy fix (Eris) + camera range

```yaml
id: T0129
title: Extend depth coverage to the full catalog; raise camera range
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M3
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §12.3
acceptance:
  - Eris (r ~ 1.43e10 km) renders in space view: SPACE_FAR_KM raised to 2.5e10 with reversed/log-depth validation (test:render-depth extended with a far-body case; z-fighting spot checks at LEO unchanged)
  - Orbit camera max distance raised to frame the full system (2e10 km); focus transitions still stable (no NaN at extreme spans — fuzz test)
  - Starfield far-pinning still correct under both depth strategies
  - Non-finite guard policy split: ship/body position bindings keep the hard throw; NEW effect-visual bindings (plume, markers, skybox) get a degrade path (bind skipped + one-time console warning + telemetry flag) so a NaN in an effect never kills the frame loop (unit test with an injected NaN binding)
handoff_notes: "Small but subtle: touch spaceScene.ts constants + depth tests together; do NOT touch the Math.fround boundary contract."
```

- [ ] Depth tests first → constants → fuzz transitions → commit

#### T0130 — Tier-2 quality + draw-call consolidation

```yaml
id: T0130
title: Higher tier-2 tessellation; consolidate double-mesh crossfade cost
status: TODO
agent: ""
branch: ""
depends_on: [T0128]
milestone: V2M3
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1,§13
acceptance:
  - Tier-2 spheres: icosahedron detail 2 -> 4 (320 -> 5120 tris) with governor rung stepping back to 2; silhouette faceting gone at 240 px (screenshot diff in harness)
  - Tier-2 fallback+textured double mesh replaced by single mesh with shader-side texture crossfade (draw calls per tier-2 body: 2 -> 1)
  - Full-catalog worst-case draw calls measured and recorded; golden re-baselined in dedicated commit; triangles within 500k budget at reference pose
handoff_notes: "The crossfade uniform rides the existing hook pattern; keep the 250 ms curve and the 1/15 point-seed trick documented in bodyVisualSystem."
```

- [ ] Harness case (faceting) → tessellation + governor → single-mesh crossfade → budget evidence → commit

**V2M3 exit:** LEO opening shot and a Saturn arrival are screenshot-worthy (reference captures committed to `docs/bench/`); camera modes cycle smoothly; all harnesses green.

---

### V2M4 — "Stunning II" (asset lane + light & sky physics)

#### T0131 — Asteroid/comet builders

```yaml
id: T0131
title: build_asteroid.py and build_comet.py with shape-model ingest
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1; docs/asset-pipeline.md
acceptance:
  - build_asteroid.py: real shape models (Eros NEAR, Bennu OSIRIS-REx, Ryugu Hayabusa2 — decimated <= 5000 tris) + procedural displaced-icosphere fallback seeded by proceduralSeed
  - build_comet.py: nucleus (67P shape model decimated; Halley procedural) + coma/tail hook nodes (coma_anchor, tail_anchor) for T0139
  - Deterministic double-build byte-identical; unit tests in tools/tests python suite; SOURCES.md per body
  - Budget: asteroid/comet category <= 5000 tris each (config.mjs enforced)
handoff_notes: "Shape model sources: NASA PDS SBN (public domain) — pin URLs+SHA256 via T0132's fetch mechanism (coordinate; T0132 may land first or same-week)."
```

- [ ] Fallback procedural path → shape-model path → determinism → tests → commit

#### T0132 — Source-texture fetch policy (ADR-039)

```yaml
id: T0132
title: Checksummed on-demand source fetching; stop committing 8K sources
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §12.4
acceptance:
  - fetch_textures.py: manifest of {url, sha256, license, dest} per source; fetch+verify+cache; offline-friendly error copy
  - New-body workflow docs updated: sources fetched, never committed; existing committed sources STAY (no history rewrite)
  - ADR-039; asset-pipeline.md updated; repo-budget check documents the policy
  - Python tests: checksum mismatch fails; cache hit skips download (mocked)
handoff_notes: "Do not delete existing textures-src content in this task (churn risk); policy applies to NEW bodies. All 34 upcoming bodies depend on this."
```

- [ ] Manifest format → fetch+verify → tests → ADR + docs → commit

#### T0133 — Hero assets: Mercury + Mars

```yaml
id: T0133
title: Mercury and Mars hero assets
status: TODO
agent: ""
branch: ""
depends_on: [T0131, T0132]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1
acceptance:
  - Per body: bake_ephemerides check untouched (already in catalog); build_planet.py config (USGS/NASA sources: Mercury MESSENGER MDIS, Mars Viking/MOLA-derived normal); 8k albedo + 4k normal + 1k detail pair; SOURCES.md; ingest green
  - Hero budget <= 20 MB (Mars), <= 12 MB (Mercury); rails class regression untouched; tier thresholds verified in fly-in harness case
  - Draw/tri budgets green; credits.md updated
handoff_notes: "Read agents/skills/add-celestial-body.md. Follow the earth/moon config pattern in build_planet.py/planet_config.py. Every remaining asset task uses this same checklist."
```

- [ ] Fetch sources → configs → build → ingest → harness fly-in case → commit

#### T0134 — Hero assets: Venus + Titan (haze worlds)

```yaml
id: T0134
title: Venus and Titan hero assets with cloud-deck surfaces
status: TODO
agent: ""
branch: ""
depends_on: [T0133]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1
acceptance:
  - Venus: Magellan-derived cloud albedo (or Akatsuki composite), subtle band animation via gas-giant shader family reuse; Titan: ISS/Cassini haze tones
  - Cloud-deck atmosphereTopKm values coordinated with T0111 data (collision at deck)
  - Same pipeline checklist as T0133 (sources fetched, SOURCES.md, ingest, budgets, fly-in case, credits)
  - Each body <= 12 MB
handoff_notes: "These two are 'surface = cloud deck' worlds: visual.assetRef stays null pattern; scattering params for T0140 recorded in the per-task design doc."
```

- [ ] Same checklist as T0133 per body → commit

#### T0135 — Galilean moons (Io, Europa, Ganymede, Callisto)

```yaml
id: T0135
title: Galilean moon assets
status: TODO
agent: ""
branch: ""
depends_on: [T0133]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1
acceptance:
  - Four bodies from USGS Voyager/Galileo mosaics; 4k albedo + 2k normal each; standard (non-hero) budget <= 6 MB each
  - Full pipeline checklist per body (fetch, SOURCES.md, build via build_moon.py parameterization, ingest, budgets, credits)
  - Fly-in harness case for Io (eclipse-relevant body for T0141 exit shot)
handoff_notes: "moon_config.py parameterization pattern; displacement optional (Io hero-ish is fine within budget)."
```

- [ ] Checklist ×4 → commit

#### T0136 — Saturn/Uranus/Neptune major moons batch

```yaml
id: T0136
title: Titan-siblings batch: Mimas..Iapetus, Miranda..Oberon, Triton
status: TODO
agent: ""
branch: ""
depends_on: [T0135]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1
acceptance:
  - 13 bodies (Mimas, Enceladus, Tethys, Dione, Rhea, Iapetus, Miranda, Ariel, Umbriel, Titania, Oberon, Triton + Phobos/Deimos folded here): real mosaics where available (Cassini/Voyager), procedural-displaced otherwise; <= 4 MB each
  - Iapetus two-tone and Triton cantaloupe validated visually (reference renders committed)
  - Full pipeline checklist per body; assets total still <= 150 MB budget (report number)
handoff_notes: "Batch task — split into two PRs if review size demands (protocol allows adding T-ids; note here if split)."
```

- [ ] Checklist ×13 → budget report → commit

#### T0137 — Dwarfs + Charon batch

```yaml
id: T0137
title: Dwarf planets batch: Ceres, Eris, Makemake, Haumea, Charon
status: TODO
agent: ""
branch: ""
depends_on: [T0133]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1
acceptance:
  - Ceres (Dawn mosaic), Charon (New Horizons), Eris/Makemake procedural, Haumea procedural WITH true triaxial shape (visual.polarRadiusRatio + custom builder scale)
  - <= 4 MB each; full pipeline checklist per body; Eris render verified (depends on T0129 far-plane fix at runtime, not build time)
handoff_notes: "Haumea's triaxial ellipsoid needs a builder flag (a!=b!=c) — small common/geometry.py extension with its own python test."
```

- [ ] Geometry extension test → checklist ×5 → commit

#### T0138 — Asteroids batch

```yaml
id: T0138
title: Asteroid assets: Vesta, Pallas, Hygiea, Eros, Bennu, Ryugu
status: TODO
agent: ""
branch: ""
depends_on: [T0131, T0132]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1
acceptance:
  - Eros/Bennu/Ryugu real shape models; Vesta Dawn mosaic on displaced sphere; Pallas/Hygiea procedural; <= 5000 tris & <= 2 MB each
  - Full pipeline checklist per body; point-cloud tier magnitudes still correct (albedo values verified against catalog)
handoff_notes: "First consumer of build_asteroid.py at scale — file issues against T0131 patterns here if friction appears."
```

- [ ] Checklist ×6 → commit

#### T0139 — Comets with coma/tail visuals

```yaml
id: T0139
title: 1P/Halley and 67P assets with perihelion coma and tail
status: TODO
agent: ""
branch: ""
depends_on: [T0131]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1
acceptance:
  - Nuclei per T0131; coma sprite + ion/dust tail (two additive ribbons, anti-sunward + orbit-lagged) activated when r_helio < 3 AU, intensity ramps per 1/r^2
  - Deterministic from sim time; governed; rendering-spec gains a comet-visuals section
  - Playwright case: 67P near perihelion shows tail pointing anti-sunward within 5° in screen space
handoff_notes: "Tail dir = normalize(r_comet - r_sun) blended 15% with negative orbital velocity for dust lag — record exact blend in rendering-spec."
```

- [ ] Activation math tests → ribbons → harness → spec text → commit

#### T0140 — Atmospheric scattering (ADR-040)

```yaml
id: T0140
title: Analytic atmosphere scattering for Earth, Venus, Mars, Titan, giants
status: TODO
agent: ""
branch: ""
depends_on: [T0127]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1
acceptance:
  - data/atmospheres.json + schema + ADR-040: per-body {rayleighRGB, mieCoeff, scaleHeightKm, deckRadiusKm}
  - Single-scatter analytic shell shader (per-pixel sun angle, limb integration approximation): Earth blue limb + red terminator sunset; Venus/Titan thick haze; Mars thin dust; giants limb glow — replaces earthSurfaceLayers rim hack
  - Correctness proxies tested: limb brightness vs sun angle monotonic curves; Playwright harness screenshot diffs for 4 poses per hero body
  - Governed (quality rung: shader steps 8/4/off); zero allocation; bench evidence; aerial perspective term applied to close-range detail on atmosphere bodies
handoff_notes: "Biggest single visual lever. Keep it a hook on the existing material pattern (shell mesh like earthSurfaceLayers but with the scattering integral). Parameters live in data, not code."
```

- [ ] Design doc (model derivation) → schema+ADR → shader → per-body params → harnesses → bench → commit

#### T0141 — Eclipse shadows + Sun upgrade

```yaml
id: T0141
title: Analytic eclipse shadows; corona/prominence/granulation v2
status: TODO
agent: ""
branch: ""
depends_on: [T0127]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.1,§6.2
acceptance:
  - Generalized analytic occluder test (up to 4 nearest occluders per lit body, umbra/penumbra from angular radii) in the lighting hook; moon shadows on parents and vice versa; existing ring shadows unchanged
  - Sun: corona rebuilt as layered noise streamers (replaces 3 hardcoded arcs), limb prominences from seeded arcs, granulation contrast +30% with governor octave control
  - Playwright: Io-eclipse pose shows umbra on Jupiter within 2% of analytic center; solar-eclipse-from-LEO pose shows Moon umbra on Earth
  - Bench evidence; draw calls unchanged (shader-only)
handoff_notes: "Occluder selection per lit body precomputed per frame in game layer (nearest-4 by angular size, packed uniforms) — keep the shader branchless-ish. Sun upgrade must keep customProgramCacheKey stability."
```

- [ ] Occluder math tests (analytic penumbra widths) → shader → sun corona → harness poses → commit

#### T0142 — God rays + lens flare

```yaml
id: T0142
title: Screen-space god rays and physical lens flare
status: TODO
agent: ""
branch: ""
depends_on: [T0127]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §6.2
acceptance:
  - Radial-blur god-rays pass via insertPass (sun screen-pos driven, occlusion-aware via depth sample), strength governed, off at lowest tier
  - Lens flare: 3-element restrained ghosting + halo, sun-angle driven, default subtle, OFF switch in settings
  - No pass allocation per frame; SMAA/FXAA ordering verified; 21+ render harnesses green; bench evidence
handoff_notes: "First external consumer of the T0127 API. Screen-space sun pos must come from the f64 game-layer projection (same path as world markers) — never from a three.js Object3D."
```

- [ ] Pass skeleton + API test → occlusion factor → flare → harness → commit

#### T0143 — Close-range flyby detail + radar altimetry

```yaml
id: T0143
title: Flyby detail boost and radar-altitude HUD
status: TODO
agent: ""
branch: ""
depends_on: [T0128, T0112]
milestone: V2M4
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §4.4,§6.1
acceptance:
  - Detail-shader strengths retuned (albedo 0.12->0.25, normal 0.08->0.18 baseline, per-body overrides in manifest extras) with before/after captures at 2x radius for 6 bodies
  - 'Looks great at 2x radius' bar: reference captures for Moon, Mars, Io committed and linked in the PR
  - Radar altitude readout (Pilot preset) below 2 radii: altitude above meanRadius (or deck), vertical speed; 10 Hz signals
  - Governor: detail octaves rung preserved; bench evidence
handoff_notes: "Tuning task with objective anchors — the captures ARE the acceptance. Do not touch tier thresholds here."
```

- [ ] Capture harness poses → retune → HUD readout → commit

**V2M4 exit:** no untextured body anywhere (fly-in harness sweeps all 43); Sun-pole shot captured as README hero; Io eclipse visible.

---

### V2M5 — "Alive"

#### T0144 — Audio engine + AudioDirector (ADR-041)

```yaml
id: T0144
title: Web Audio engine, AudioDirector, mixer settings, Kubrick mode
status: TODO
agent: ""
branch: ""
depends_on: [T0103]
milestone: V2M5
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §9
acceptance:
  - AudioContext lifecycle correct (user-gesture unlock, suspend on hidden tab, no autoplay warnings); graph: music bus + sfx bus + ui bus -> master (4 GainNodes)
  - AudioDirector maps snapshot facts (throttle, warp tier, gamma, dominant body class, impact warning, camera mode) to layer states; pure decision module unit-tested without AudioContext
  - Engine hum: synthesized (2 detuned saws + noise through lowpass keyed to throttle) so it ships dependency-free before T0145 assets
  - Kubrick mode: exterior cameras silence sfx bus (music per setting); mixer UI in settings; all levels persisted
  - Zero allocation in frame path (audio param updates only); ADR-041
handoff_notes: "Design doc first. No library. Cockpit/chase = interior mix; cinematic/observatory = exterior. Muted-by-default until first user volume interaction is a defensible launch posture — decide in design doc and record."
```

- [ ] Director decision tests → graph + unlock → synth hum → mixer UI → Kubrick logic → ADR → commit

#### T0145 — Music + SFX assets

```yaml
id: T0145
title: Adaptive music layers and ship SFX asset intake
status: TODO
agent: ""
branch: ""
depends_on: [T0144]
milestone: V2M5
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §9
acceptance:
  - data/audio-manifest.json: tracks/loops with license fields (CC0/CC-BY only; attribution auto-listed in credits.md build step)
  - 4 music contexts (deep-space, giant-approach, near-sun, warning) as loopable OGG stems, crossfade 4 s; total audio <= 12 MB, lazy-loaded, never in initial path
  - SFX set: RCS tick, cruise engage/disengage, warp shift, impact, milestone chime, UI clicks
  - check:licenses extended to audio; startup gate unchanged
handoff_notes: "Sourcing: freesound CC0 + generated stems. Every file's provenance in the manifest — the license check must fail on a missing entry (test with fixture)."
```

- [ ] Manifest+license gate test → asset intake → crossfade wiring → commit

#### T0146 — Diary milestones (ADR-042)

```yaml
id: T0146
title: Exploration diary: milestone engine and panel
status: TODO
agent: ""
branch: ""
depends_on: [T0116]
milestone: V2M5
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §8
acceptance:
  - >= 50 MilestoneDefs per plan §2 shape: first-orbit-of-{each body class list}, first close approach < 2 radii per planet, ring-plane crossing, solar polar overflight (|ecliptic latitude| > 80° within 30 R_sun), 0.1/0.5/0.9/0.99c, gamma 2/10, twin-paradox return (|t - tau| > 86400 s AND within Earth SOI), eclipse witnessed (from T0141 event), grand tour (all 8 planets orbited), first PWh
  - Engine: 10 Hz evaluation, allocation-free, edge-triggered with per-milestone hysteresis; state persisted in profile settings store (NOT save envelope) + export/import
  - Diary panel: achieved list with mission timestamp + stats; undiscovered show hint silhouettes; toast on unlock (+ audio chime hook)
  - ADR-042 (storage + export); unit tests: each predicate fires on a synthetic snapshot fixture and not on near-miss fixtures
handoff_notes: "Design doc first. Predicates read ONLY SimSnapshot + DiaryContext (prior achievement state, per-body visited flags) — no sim changes. Orbit detection: dominant body == target AND e < 0.3 for 2 consecutive periods? No — use e < 0.3 AND r inside SOI for >= 1 osculating period (cheap, robust); record rule in design doc."
```

- [ ] Predicate fixtures → engine → panel + toasts → persistence/export → ADR → commit

#### T0147 — Photo album

```yaml
id: T0147
title: IndexedDB photo album with quota policy and export
status: TODO
agent: ""
branch: ""
depends_on: [T0125, T0146]
milestone: V2M5
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §8
acceptance:
  - CaptureSink (from T0125) backed by IndexedDB: {blob, CaptureMeta, thumbnail 256px}; album grid UI with view/delete/download
  - Quota: soft cap 200 MB or navigator.storage.estimate()*0.5, oldest-eviction only after user consent dialog; all failure paths handled (private mode -> download-only fallback with notice)
  - Export: album metadata JSON + per-photo download; import not required (photos are personal artifacts) — documented in privacy.md update
  - Storage code fully unit-tested via fake-indexeddb; UI Playwright case captures and lists a photo
handoff_notes: "privacy.md must be updated in this PR (new local storage surface). No cloud, no telemetry."
```

- [ ] Store tests (fake-indexeddb) → sink impl → grid UI → quota/consent → privacy doc → commit

#### T0148 — Cinematic main menu

```yaml
id: T0148
title: Main menu over live LEO scene with ship
status: TODO
agent: ""
branch: ""
depends_on: [T0110, T0122]
milestone: V2M5
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §7
acceptance:
  - Menu backdrop: live scene, ship in LEO, slow cinematic drift (reuses cinematic camera idle), sun angle chosen for drama; no second renderer/world (RuntimeResourceCounts unchanged)
  - Entries: New Game / Continue / Diary / Settings; startup measured pipeline + ?autostart=1 preserved; startup gate green (<= 5 s)
  - Menu adds <= 3 draw calls at menu state; frame budget respected during menu
handoff_notes: "The v1 menu already mounts over the built scene — this is art direction + camera path, not architecture. Keep the semantic-shell accessibility structure."
```

- [ ] Camera path → art pass → startup gate proof → commit

#### T0149 — Settings consolidation + HUD preset editor

```yaml
id: T0149
title: Consolidated settings: assists, camera, HUD presets, audio; migration wrap-up
status: TODO
agent: ""
branch: ""
depends_on: [T0118, T0144, T0112]
milestone: V2M5
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §7
acceptance:
  - Single settings surface (pause menu + main menu) with sections: Flight assists, Camera (shake/FOV/invert), HUD (preset + per-panel visibility editor), Audio (mixer + Kubrick), Video (quality/exposure), Controls (bindings incl. gamepad)
  - Profile schema vN migration chain tested end-to-end from a committed v1-era fixture; save-envelope embedded DTO still GameSettingsV1 (contract preserved)
  - Remaining app.css absolute-position panels migrated to the grid/token system; app.css reduced by >= 60% lines (report number)
  - Keyboard-only traversal audit green (existing a11y pattern)
handoff_notes: "This closes the settings/CSS debt opened across V2M1-M5. No new features beyond the editor."
```

- [ ] Migration chain test → sections → CSS migration → a11y pass → commit

#### T0150 — 90-second interactive intro

```yaml
id: T0150
title: First-flight intro: five skippable prompts
status: TODO
agent: ""
branch: ""
depends_on: [T0116, T0112]
milestone: V2M5
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §10
acceptance:
  - Five steps driven by real facts (existing tutorial machine): look around (attitude changed > 30°) -> throttle (>= 50%) -> click Moon (target set) -> engage cruise -> arrival (dominant body = moon); each step one line of copy, skippable, never re-offered after completion/skip
  - v1 12-step tutorial content retired; controller machine reused; progress in profile store
  - Median completion <= 120 s in 3 scripted Playwright runs (headless timing tolerance documented)
handoff_notes: "Copy tone: imperative, zero physics lecturing ('Push R to burn' not 'Thrust produces acceleration')."
```

- [ ] Step predicate tests → copy → harness runs → commit

**V2M5 exit:** full sensory loop demonstrated in a recorded grand-tour session; diary records it; album holds its photos.

---

### V2M6 — "Ship it"

#### T0151 — Performance re-baseline + governor extension

```yaml
id: T0151
title: v2 performance audit, governor rungs, budget goldens
status: TODO
agent: ""
branch: ""
depends_on: [T0140, T0141, T0142, T0130, T0122, T0126]
milestone: V2M6
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §13
acceptance:
  - Governor ladder re-authored to cover: scattering steps, plume/RCS pools, skybox tier, god rays, exposure mode, detail octaves, tier-2 tessellation — 15+ rungs, tested descent/ascent behavior
  - performance-golden.json re-baselined at 3 canonical poses (LEO+ship+full HUD, Saturn arrival, Sun approach): draw calls, tris, heap window recorded; 60 fps p75 on reference hardware evidenced in docs/bench/T0151-summary.md
  - Bundle: total gzip <= 1,000,000 B verified with headroom report per chunk; entry <= 400,000 B; initial-path unchanged
  - bench:sim wired into CI (closing the v1 gap: sim step budget <= 2 ms now enforced)
handoff_notes: "This is the gate-keeper task before release. Any budget still violated becomes a fix-task filed from here."
```

- [ ] Governor rungs + tests → pose benches → goldens commit → CI sim-bench → commit

#### T0152 — Accessibility pass

```yaml
id: T0152
title: v2 accessibility: focus, reduced motion, audio cues, contrast
status: TODO
agent: ""
branch: ""
depends_on: [T0151]
milestone: V2M6
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §14.2
acceptance:
  - Full keyboard traversal of all new UI (pause, diary, album, settings, cruise strip); focus visible; no key traps
  - prefers-reduced-motion: camera shake/FOV pulse/menu drift disabled automatically (tested)
  - Visual alternatives for audio alerts (warning banner states); HUD contrast >= 4.5:1 for text in all presets (checked per token)
  - accessibility.md updated; existing a11y harness cases extended
handoff_notes: "Run the existing accessibility conventions doc; this is an audit-and-fix task with a checklist PR description."
```

- [ ] Audit checklist → fixes → doc → commit

#### T0153 — Docs, README, release notes, hero media

```yaml
id: T0153
title: v2 documentation and marketing surface
status: TODO
agent: ""
branch: ""
depends_on: [T0151]
milestone: V2M6
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §14.2
acceptance:
  - README rewritten around free flight (hero image = Sun north pole capture from T0141-era); controls.md regenerated from bindings registry; game-design.md updated to v2 reality; release-notes.md v2.0.0 section
  - credits.md complete for every new source (textures, shape models, panorama, audio) — cross-checked against SOURCES.md files and audio manifest by the license check
  - architecture.md final pass: module map matches the shipped tree (audit rule: doc == code)
handoff_notes: "Docs task; screenshots come from committed bench captures. Keep README play-in-30-seconds structure."
```

- [ ] README + docs → credits cross-check → commit

#### T0154 — v2.0.0 release audit + tag

```yaml
id: T0154
title: Final v2.0.0 audit, tag, deploy verification
status: TODO
agent: ""
branch: ""
depends_on: [T0152, T0153]
milestone: V2M6
spec: docs/superpowers/specs/2026-08-14-v2-free-flight-design.md §15
acceptance:
  - All 10 spec §15 release criteria verified and evidenced one-by-one in the PR (the <= 5-min legs run scripted; criteria 1-10 checklist with links)
  - releaseReadiness --final --release=v2: every v2 task DONE (T0060-62 remain BLOCKED); package version 2.0.0; dashboard equal
  - Two full production builds byte-identical (SHA-256 across dist); Pages deploy verified by cache-disabled live audit; annotated tag v2.0.0 peels to deployed commit
  - Post-release: roadmap updated with v3 backlog stubs (landing, launch phase, WebGPU ADR, ship interior)
handoff_notes: "Mirror T0101's discipline exactly. Do not relax any gate to pass; file fix-tasks instead."
```

- [ ] Criteria evidence → readiness → build determinism → deploy + tag → commit

---

## 6. Budget re-baseline procedure (referenced by many tasks)

1. A task that legitimately changes a golden (draw calls, tris, heap, bundle) lands the change and the new golden in **separate commits within the same PR**: `feat(...): [T####] ...` then `golden(perf): [T####] re-baseline <metric>: <old> -> <new> (<reason>)`.
2. The PR description must show before/after from the bench harness (`docs/bench/T####-summary.md`).
3. Raising a *budget ceiling* (not just a golden) additionally cites ADR-032's policy and gets maintainer sign-off in review.
4. Never combine a gate weakening with an unrelated red-CI fix (the v1 T0101 lesson: product deadlines vs runner headroom are separate commits).

## 7. Risks (owner = the task that must watch it)

| Risk | Owner | Trigger to escalate |
|---|---|---|
| Guidance non-convergence in edge geometry | T0114/T0116 | any ok=false on the 5 canonical routes |
| Warp retune degrades goldens | T0115 | error tables exceed tolerance at 3000× |
| Draw-call growth beyond 150 | T0130/T0151 | worst-case pose > 120 before V2M6 |
| Bundle > 1 MB | every JS task names its gzip cost | headroom < 50 KB before V2M5 |
| main.ts split breaks browser gates | T0113 | any harness red post-split |
| Asset lane stalls | T0133–T0139 | > 1 week without a body merged |
| IndexedDB quota UX | T0147 | private-mode fallback unproven |
| Audio autoplay policies | T0144 | unlock flow fails on Chrome/Firefox |

## 8. What execution agents must NOT do

- Do not modify `sim/` outside T0104/T0107/T0111/T0114 scopes without a new ADR + maintainer sign-off.
- Do not regenerate golden trajectories to make a feature pass.
- Do not add runtime dependencies (three.js/preact/signals are the whole list) without an ADR.
- Do not touch the `Math.fround` boundary, the layering rules, or the snapshot double-buffer contract.
- Do not weaken CI gates to fix red CI — file a fix-task.
- Do not hand-edit `public/assets/*` or any `.glb`/`.ktx2` — scripts are the source of truth.
- Do not start a task whose `depends_on` is not DONE, and do not code outside a claimed task.
