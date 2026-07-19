# Architecture — Solar Voyager

This is the canonical module map. If code and this document disagree, one of them is wrong — fix it in the same PR.

## Layering (enforced by ESLint `import/no-restricted-paths`)

```
core  ←  sim  ←  game  ←  render / ui
```

- **`src/core/`** — zero-dependency utilities: float64 vector math (`vec3.ts`, plain `{x,y,z}` numbers), `time.ts` (SimClock: float64 TDB seconds since epoch, warp ladder), `constants.ts`, typed event bus.
- **`src/sim/`** — PURE physics. **No three.js, no DOM, no globals, no side effects.** Fully unit-testable, portable to Web Workers verbatim. This purity is the load-bearing invariant of the whole codebase.
- **`src/game/`** — orchestration: scene state machine, save/load, settings, input mapping.
- **`src/render/`** — three.js scenes. Consumes snapshots, owns the float64→float32 camera-relative boundary.
- **`src/ui/`** — Preact + @preact/signals HUD overlay (DOM, above the canvas).

## Directory layout

```
src/
├── main.ts                     # bootstrap, wires sceneManager
├── core/                       # vec3, time, constants, events
├── sim/
│   ├── bodies/                 # catalog.ts (loads data/bodies.json), kepler.ts
│   ├── propagation/            # rails.ts, nbodyForces.ts, dp54.ts, leapfrog.ts
│   ├── ship/                   # shipState.ts, deltaV.ts (ledger)
│   ├── launch/                 # [deferred, post-v1] atmosphere.ts, launchSim.ts, handoff.ts
│   ├── analysis/               # osculating.ts, soi.ts, warnings.ts
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

`render/` and `ui/` are pure consumers of `SimSnapshot`. They never mutate sim state. UI agents and physics agents meet ONLY at these two interfaces — this is what makes parallel multi-agent work safe.

## Scene state machine (`game/sceneManager.ts`)

```
v1:      MainMenu → SpacePhase (3D)            — new game starts in a 400 km LEO
future:  MainMenu → LaunchPhase (2D) → HandoffCinematic → SpacePhase (3D)   [deferred, optional]
                  → ApproachPhase/SurfacePhase                              [landing, deferred]
```

- **v1 ships only `MainMenu → SpacePhase`.** The state machine is built to accept the future states without refactoring — phases are pluggable states, never hardcoded transitions.
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

- The canonical save slot is `solar-voyager.save.v2` in `localStorage`; the same document is available through JSON export/import. Settings also have an independent `solar-voyager.settings.v1` slot so quality and input preferences survive without requiring a game save.
- Save v2 = `{version: 2, phase: "space", simulation, settings}`. `simulation` contains the float64 ship/ledger state, simulation time, attitude, throttle, rotation rates, requested/effective warp, clamp reason, navigation target, kinetic-energy baseline and complete burn-log continuation state. `settings` contains the quality governor lock (`auto | low | medium | high`) and the rebindable `KeyboardEvent.code` map.
- Imported and stored documents are treated as untrusted: parsers reject unknown/missing fields and non-finite or inconsistent simulation values before construction. Loading is atomic — validation and creation of a fresh `SimulationCore` complete before the live session reference and input command target are replaced.
- Version migrations are explicit (`v1 -> v2` is covered by a committed fixture). Rails bodies are never serialized because their positions and velocities are deterministically derived from `simTimeSec`.

## Expansion hooks (do not remove)

| Future feature | Hook already in place |
|---|---|
| Landing | Scene state machine slot; `surface` descriptor per body; atmosphere module reusable for entry |
| More ships | `Vessel` interface between sim and ship config |
| Other star systems | `SystemDefinition` loaded from `data/*.json`; new system = new data file + bake |
| Docking/stations | Ship state is generic rigid state; rendezvous math already in analysis/ |

## Performance architecture

- `render/telemetry.ts` is the single source of perf truth (frame-time ring buffer, ms splits per subsystem, renderer.info snapshots); consumed by the perf HUD (top-left), the adaptive quality governor (`render/perfGovernor.ts`) and the bench harness. The frame orchestrator measures the `SimulationCore.step()` call and passes that scalar to telemetry; deterministic `SimSnapshot` data does not depend on a wall clock (ADR-024).
- GPU context creation policy (forced hardware acceleration + software-rasterizer banner) lives in one place: the renderer bootstrap in `main.ts`/`render/`. Contract: `docs/performance-spec.md` §2, ADR-008.
- The frame loop is owned by `main.ts`: `commands → sim.step() → snapshot → render + UI`, instrumented at each seam. Zero-allocation rules apply to everything this loop calls (performance-spec §5).

## Invariants (CI-enforced where possible)

1. `sim/` and `core/` import nothing from `game/`, `render/`, `ui/`, three.js, or the DOM.
2. Physics state never round-trips through float32. The float64→float32 boundary lives in exactly one place: `render/spaceScene.ts` position updates.
3. All physics formulas trace to `docs/physics-spec.md`.
4. `SimSnapshot`/`Commands`/`bodies.json` schema changes require an ADR in `docs/decisions/`.
5. Committed `.glb`/`.ktx2` are build artifacts of `tools/blender/` scripts — scripts are the source of truth.
