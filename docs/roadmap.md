# Roadmap — Solar Voyager v1

Dependency spine: `M0 → M1 → M2 → M3 → M5`; **M4 depends only on M1+M2** and can run in parallel with M5. The asset lane runs continuously from M1 to M6. Tasks encode the exact DAG via `depends_on`.

## M0 — Foundation (serial — one agent, nothing parallelizes before M0 is merged)

Scaffold Vite + TS + three.js + Preact; ESLint (incl. import-direction rule) + Prettier + Vitest; CI (`ci.yml`) and Pages deploy (`deploy.yml`) shipping a placeholder scene; docs finalized; task backlog seeded.

**Exit criterion:** `https://tarikdsm.github.io/solar-voyager/` serves the placeholder build; CI green; protocol live.

## M1 — Sim core (3 parallel lanes)

- **Lane A (physics):** `core/vec3`, `core/time`, Kepler solver (elliptic + hyperbolic), rails propagation, `nbodyForces`, DP54 + full test suite per physics-spec §7.
- **Lane B (data):** `bake_ephemerides.py` (Horizons → `bodies.json` + `ephemerides-check.json`), `bake_stars.py` → `stars.bin`, task-schema CI check.
- **Lane C (assets):** Blender common helpers, `build_planet.py`, Sun/Earth/Moon assets, KTX2/Draco toolchain, budget-check script.

**Exit:** rails match Horizons within spec bounds; DP54 passes two-body goldens; Earth/Moon/Sun glb+ktx2 in budget.

## M2 — 3D world

Camera-relative SpaceScene, visual tier ladder (sprite/sphere/glTF), starfield, lighting + bloom + ACES, free camera + body focus, lazy texture loading. Lanes B/C keep producing remaining bodies/assets.

**Exit:** fly the camera from Earth to Jupiter; bodies transition tiers without popping; 60 fps on reference hardware.

## M3 — Ship + HUD  →  first playable

Ship state + thrust + attitude modes, warp system with substep-budget clamp, Δv/energy ledger, HUD (orbit readout, navball, warp control, Δv meter, target select, clock), osculating conic overlay, save/load, settings, input rebinding, Playwright smoke test.

**Exit (playable milestone):** ship spawned in LEO can reach any body in the catalog; Hohmann LEO→GEO ledger test within 1%.

## M4 — Launch phase (parallel with M5)

USSA-1976 atmosphere + tests, 2D launch sim (RK4, drag, max-q) + regression profile, LaunchScene (2D presentation), launch HUD, handoff math + conservation tests, `build_ship.py` model, handoff cinematic.

**Exit:** manual launch from Alcântara to a 200 km orbit hands off seamlessly to 3D with matching state.

## M5 — Navigation suite (parallel with M4)

Predictor worker (transferable buffers), trajectory polyline + event markers, SOI/impact warnings, system map view, burn log panel, mission clock UTC.

**Exit:** predicted Mars encounter marker within worker-vs-mainthread tolerance; impact warnings fire correctly.

## M6 — v1 polish

Full ~50-body roster + assets (procedural asteroids, real shape models, comet visuals), performance audit vs frame budget, launch tutorial overlay, quality settings auto-detect, load-time optimization, landing page/README polish → **tag v1.0**.

## Post-v1 (backlog only — architecture hooks in place)

Landing & surface phase · multiple ships/`Vessel` configs · other star systems via `SystemDefinition` · aerobraking/re-entry · docking · missions layer.
