# Roadmap — Solar Voyager v1

Dependency spine: `M0 → M1 → M2 → M3 → M5 → M6`. The asset lane runs continuously from M1 to M6. Tasks encode the exact DAG via `depends_on`.

> **Scope change (2026-07-15):** the 2D launch phase (M4) is **deferred to post-v1 as an optional expansion**. v1 starts with the ship already in low Earth orbit; the focus is 3D navigation across the solar system. The launch spec (physics-spec §4) and its tasks (T0060–T0062) remain in the repo for the future — do not claim them for v1.

## M0 — Foundation (serial — one agent, nothing parallelizes before M0 is merged)

Scaffold Vite + TS + three.js + Preact; ESLint (incl. import-direction rule) + Prettier + Vitest; CI (`ci.yml`) and Pages deploy (`deploy.yml`) shipping a placeholder scene; docs finalized; task backlog seeded.

**Exit criterion:** `https://tarikdsm.github.io/solar-voyager/` serves the placeholder build; CI green; protocol live.

## M1 — Sim core (3 parallel lanes)

- **Lane A (physics):** `core/vec3`, `core/time`, Kepler solver (elliptic + hyperbolic), rails propagation, `nbodyForces`, DP54 over the relativistic (r, u, τ) state, **relativistic kinematics module (γ, celerity, proper time, hyperbolic-motion tests)** + full test suite per physics-spec §7.
- **Lane B (data):** `bake_ephemerides.py` (Horizons → `bodies.json` + `ephemerides-check.json`), `bake_stars.py` → `stars.bin`, task-schema CI check.
- **Lane C (assets):** Blender common helpers, `build_planet.py`, Sun/Earth/Moon assets, KTX2/Draco toolchain, budget-check script.

**Exit:** rails match Horizons within spec bounds; DP54 passes two-body goldens; Earth/Moon/Sun glb+ktx2 in budget.

## M2 — 3D world

Camera-relative SpaceScene, visual tier ladder (sprite/sphere/glTF), starfield, lighting + bloom + ACES, free camera + body focus, lazy texture loading. Lanes B/C keep producing remaining bodies/assets.

**Exit:** fly the camera from Earth to Jupiter; bodies transition tiers without popping; 60 fps on reference hardware.

## M3 — Ship + HUD  →  first playable

Ship state (relativistic) + thrust + attitude modes, warp system with substep-budget clamp, **photon-drive energy ledger (Wh)**, HUD (orbit readout, navball, warp control, **energy panel**, **bottom-right state-vector 3D widget**, target select, **dual clock t/τ**), osculating conic overlay, save/load, settings, input rebinding, `build_ship.py` model, Playwright smoke test. **New-game start: ship in a 400 km low Earth orbit, carrying Earth's real ~30 km/s barycentric velocity.**

**Exit (playable milestone):** ship spawned in LEO can reach any body in the catalog; Hohmann LEO→GEO ledger tests within 1% (proper Δv and E_spent); a near-c cruise shows correct time dilation on the dual clock.

## M5 — Navigation suite

Predictor worker (transferable buffers), trajectory polyline + event markers, SOI/impact warnings, system map view, burn log panel, mission clock UTC.

**Exit:** predicted Mars encounter marker within worker-vs-mainthread tolerance; impact warnings fire correctly.

## M6 — v1 polish

Full ~50-body roster + assets (procedural asteroids, real shape models, comet visuals), **relativistic visual effects (aberration, Doppler, beaming — rendering-spec §10)**, performance audit vs frame budget, orbital-navigation tutorial overlay, quality settings auto-detect, load-time optimization, landing page/README polish → **tag v1.0**.

## M4 — Launch phase (DEFERRED — optional post-v1 expansion)

USSA-1976 atmosphere + tests, 2D launch sim from Alcântara (RK4, drag, max-q) + regression profile, LaunchScene (2D presentation), launch HUD, handoff math + conservation tests, handoff cinematic. Fully specified in physics-spec §4; tasks T0060–T0062. Depends only on M1 — can be picked up any time after v1 (or before, if explicitly re-prioritized by the maintainer).

**Exit:** manual launch from Alcântara to a 200 km orbit hands off seamlessly to 3D with matching state; "start from launch pad" becomes an optional new-game mode alongside "start in orbit".

## Post-v1 (backlog only — architecture hooks in place)

**Launch phase (M4, above)** · Landing & surface phase · multiple ships/`Vessel` configs · other star systems via `SystemDefinition` · aerobraking/re-entry · docking · missions layer.
