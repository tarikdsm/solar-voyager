# Roadmap — Solar Voyager

v1.0 shipped 2026-07-19 (tag `v1.0.0`) via milestones `M0`–`M6` below. v2.0 (the
free-flight redesign) is in progress via milestones `V2M1`–`V2M6`, added as
their own section at the end of this document.

Dependency spine (v1): `M0 → M1 → M2 → M3 → M5 → M6`. The asset lane runs continuously from M1 to M6. Tasks encode the exact DAG via `depends_on`.

> **Scope change (2026-07-15):** the 2D launch phase (M4) is **deferred to post-v1 as an optional expansion**. v1 starts with the ship already in low Earth orbit; the focus is 3D navigation across the solar system. The launch spec (physics-spec §4) and its tasks (T0060–T0062) remain in the repo for the future — do not claim them for v1.

## M0 — Foundation (serial — one agent, nothing parallelizes before M0 is merged)

Scaffold Vite + TS + three.js + Preact; ESLint (incl. import-direction rule) + Prettier + Vitest; CI (`ci.yml`) and Pages deploy (`deploy.yml`) shipping a placeholder scene; docs finalized; task backlog seeded.

**Exit criterion:** `https://tarikdsm.github.io/solar-voyager/` serves the placeholder build; CI green; protocol live.

## M1 — Sim core (3 parallel lanes)

- **Lane A (physics):** `core/vec3`, `core/time`, Kepler solver (elliptic + hyperbolic), rails propagation, `nbodyForces`, DP54 over the relativistic (r, u, τ) state, **relativistic kinematics module (γ, celerity, proper time, hyperbolic-motion tests)** + full test suite per physics-spec §7.
- **Lane B (data):** `bake_ephemerides.py` (Horizons → `bodies.json` + `ephemerides-check.json`), `bake_stars.py` → `stars.bin`, task-schema CI check.
- **Lane C (assets):** Blender common helpers, **asset ingest pipeline (`assets/` → validate → Draco/KTX2 → `public/assets/`)**, texture fetch script, `build_planet.py`, Sun/Earth/Moon assets (guide-compliant), budget gates.

**Exit:** rails match Horizons within spec bounds; DP54 passes two-body goldens; Earth/Moon/Sun glb+ktx2 in budget.

## M2 — 3D world

Camera-relative SpaceScene, **GPU context policy (forced hardware acceleration + software-rasterizer banner, reversed/log depth selection — performance-spec §2)**, **render telemetry module**, visual tier ladder (sprite/sphere/glTF), starfield, lighting + bloom + ACES, free camera + body focus, lazy texture loading. Lanes B/C keep producing remaining bodies/assets.

**Exit:** fly the camera from Earth to Jupiter; bodies transition tiers without popping; 60 fps on reference hardware with telemetry proving it.

## M3 — Ship + HUD  →  first playable

Ship state (relativistic) + thrust + attitude modes, warp system with substep-budget clamp, **photon-drive energy ledger (Wh)**, HUD (**top-left perf panel**, orbit readout, navball, warp control, **energy panel**, **bottom-right state-vector 3D widget**, target select, **dual clock t/τ**), **adaptive quality governor**, **bench harness + CI perf gates**, osculating conic overlay, save/load, settings, input rebinding, `build_ship.py` model, Playwright smoke test. **New-game start: ship in a 400 km low Earth orbit, carrying Earth's real ~30 km/s barycentric velocity.**

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

---

## v2.0 — Free-flight redesign (in progress)

**Spec of record:** `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md`.
**Implementation plan:** `docs/superpowers/plans/2026-08-14-v2-free-flight.md`
(full per-task DAG, shared interfaces, and ADR queue — see `docs/decisions/ADR-032-v2-kickoff.md`
for scope, pillars, and the budget-revision policy).

Dependency spine: `V2M1 → V2M2 → V2M3 → V2M4 → V2M5 → V2M6`. As with v1, the
**asset lane** (V2M4's body-asset batch tasks) runs continuously and in
parallel once its lane-opening tasks land — the same pattern v1 used from M1
to M6, it does not wait for V2M2/V2M3 to finish first. **M4 (the 2D Alcântara
launch phase, `T0060`–`T0062`) remains deferred and `BLOCKED`** — v2.0 does not
revisit it.

### V2M1 — "The ship exists."

Input rewrite (pointer lock, wall-time authority, gamepad), ship rendered +
chase camera, manual mouse-look flight, collision v0 (restore/respawn), HUD
Clean v0, pause.

**Exit:** fly around Earth–Moon by hand, crash, restore, 60 fps, all v1 sim
goldens green.

### V2M2 — "The system is yours."

CruiseDirector (guidance §8 + warp piloting + arrival insertion),
click-to-target, assists suite (all holds bound + approach brake), map cruise
integration, warp-ceiling retune.

**Exit:** click Jupiter from LEO → arrive in a stable orbit in ≤ 5 wall
minutes, ledger/goldens honest, abort works mid-cruise.

### V2M3 — "Stunning I."

Ship remodel + plume/RCS/lights + planetshine, cockpit-lite + cinematic/photo
cameras, Milky Way, adaptive exposure, body rotation/tilt/oblateness,
Eris/far-plane fix.

**Exit:** the LEO opening shot and a Saturn arrival are screenshot-worthy;
camera modes cycle smoothly.

### V2M4 — "Stunning II."

All 43 bodies asseted (hero + standard + asteroid/comet tooling), atmospheric
scattering, eclipse shadows, Sun upgrade + god rays, close-range flyby detail.
This milestone contains the continuous asset lane described above.

**Exit:** no untextured body anywhere; Sun-pole shot is the README hero;
eclipse visible from Io.

### V2M5 — "Alive."

Audio engine + adaptive music + ship sounds + Kubrick mode; diary milestones +
album + export; cinematic main menu; settings expansion
(assists/HUD/audio/camera).

**Exit:** full sensory loop; diary records a grand-tour run.

### V2M6 — "Ship it."

Performance re-baseline across tiers, 90-second intro, accessibility pass
(focus order, reduced-motion, captions for audio cues), docs/README/release
notes, v2.0.0 tag + Pages deploy + live audit.

**Exit:** release checklist green, tag peels to deployed commit.
