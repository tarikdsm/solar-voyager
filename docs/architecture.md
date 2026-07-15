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
│   ├── launch/                 # atmosphere.ts, launchSim.ts, handoff.ts
│   ├── analysis/               # osculating.ts, soi.ts, warnings.ts
│   └── simulation.ts           # SimulationCore
├── workers/                    # predictor.worker.ts + predictorProtocol.ts
├── render/                     # spaceScene, launchScene, bodyVisual, starfield,
│                               # trajectoryLine, lighting, lod
├── game/                       # sceneManager, saveLoad, settings, input
└── ui/                         # App.tsx, hud/, map/, menus/
data/                           # bodies.json, ephemerides-check.json, stars.bin
public/assets/                  # committed build artifacts: models/*.glb, textures/*.ktx2
tools/                          # blender/ scripts, bake_ephemerides.py, bake_stars.py
tests/                          # sim/ unit+regression, golden/ trajectories
```

## Single source of truth: `SimulationCore`

`src/sim/simulation.ts` owns all physical state: the SimClock, body catalog (rails), ship state, Δv ledger. Per render frame:

```
step(wallDt) → advances sim time by warp × wallDt via the adaptive integrator
             → emits SimSnapshot (immutable for that frame)
```

**`SimSnapshot`** (typed interface, changes require an ADR):
- sim time (TDB seconds), UTC date, warp state (current, clamp reason)
- body positions/velocities (Float64Array, heliocentric ecliptic J2000, km)
- ship state: r, v, attitude quaternion, throttle, thrust vector
- derived: dominant body id, osculating elements, Δv ledger totals, active warnings

**`Commands`** (the ONLY way player intent enters the sim; changes require an ADR):
- `setThrottle(f)`, `setAttitudeMode(mode)`, `rotate(rates)`, `setWarp(tier)`, `setTarget(bodyId)`, launch-phase: `setPitchRate(r)`, `stage()`

`render/` and `ui/` are pure consumers of `SimSnapshot`. They never mutate sim state. UI agents and physics agents meet ONLY at these two interfaces — this is what makes parallel multi-agent work safe.

## Scene state machine (`game/sceneManager.ts`)

```
MainMenu → LaunchPhase (2D) → HandoffCinematic → SpacePhase (3D)
```

- One WebGL renderer for both phases. LaunchScene uses an orthographic camera (2D side view); SpaceScene uses perspective + camera-relative positioning.
- Handoff trigger: altitude > 140 km. `sim/launch/handoff.ts` converts the 2D polar state to a heliocentric 3D state vector (pure function, unit-tested for energy/angular-momentum round-trip).
- **Future landing = a new state** (`ApproachPhase`/`SurfacePhase`) added to this machine; bodies already carry a `surface` descriptor in `bodies.json` (unused in v1).

## Threading model

- **Main thread:** SimulationCore (rails evaluation + one DP54 ship propagation + ledger = µs-to-low-ms per frame), rendering, UI.
- **`predictor.worker.ts`:** trajectory prediction — propagates the current ship state thrust-free using the *same* `dp54.ts` + `nbodyForces.ts` modules; returns a downsampled polyline (~2000 pts) + events (SOI transitions, closest approaches, predicted impact) via **postMessage with transferable Float64Arrays**. No SharedArrayBuffer (GitHub Pages can't serve COOP/COEP headers). Re-runs on thrust change / warp elapsed / 0.5 s debounce.
- Optional "dynamic bodies" mode (mutual n-body, ADR-001) also runs on a worker.

## State & persistence

- Save = `{version, simTimeSec, phase, shipState, ledger, burnLog, settings}` in localStorage, plus JSON file export/import. Rails bodies need no saving — they are a function of time.
- Versioned envelope with per-version migration functions.

## Expansion hooks (do not remove)

| Future feature | Hook already in place |
|---|---|
| Landing | Scene state machine slot; `surface` descriptor per body; atmosphere module reusable for entry |
| More ships | `Vessel` interface between sim and ship config |
| Other star systems | `SystemDefinition` loaded from `data/*.json`; new system = new data file + bake |
| Docking/stations | Ship state is generic rigid state; rendezvous math already in analysis/ |

## Invariants (CI-enforced where possible)

1. `sim/` and `core/` import nothing from `game/`, `render/`, `ui/`, three.js, or the DOM.
2. Physics state never round-trips through float32. The float64→float32 boundary lives in exactly one place: `render/spaceScene.ts` position updates.
3. All physics formulas trace to `docs/physics-spec.md`.
4. `SimSnapshot`/`Commands`/`bodies.json` schema changes require an ADR in `docs/decisions/`.
5. Committed `.glb`/`.ktx2` are build artifacts of `tools/blender/` scripts — scripts are the source of truth.
