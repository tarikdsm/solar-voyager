# Solar Voyager v2.0 — Free-Flight Redesign — Design

- **Date:** 2026-08-14
- **Status:** Approved by maintainer (interview + three-block design review, 2026-08-14)
- **Scope:** Release-level design for v2.0. Decomposed into an implementation plan (`docs/superpowers/plans/2026-08-14-v2-free-flight.md`) and tasks `T0102+`.
- **Supersedes:** nothing — v1 remains the foundation. This spec re-aims the *game layer* and the *presentation*; the physics core and its 31 ADRs remain in force except where explicitly reopened (§12.4).

---

## 1. Problem statement

v1 shipped a physically excellent solar-system simulation wrapped in a mission-control dashboard. The audit (2026-08-14, four subsystem deep-dives) found:

- **The ship is never rendered.** `ship.glb` is built, deployed, and never loaded. No chase camera exists; the camera can only orbit celestial bodies. `src/render/` never reads `snapshot.shipState` for a position.
- **Piloting is abstract.** Attitude keys move an SVG navball and nothing in the world. 5 of 8 implemented attitude autopilots have no key binding. Input has hard defects: Shift disables flight controls, focusing any HUD button freezes flight input, and manual rotation is integrated in *sim* time so time warp multiplies it into uncontrollable tumbling.
- **Reaching places is not achievable in practice.** Getting anywhere requires manual orbital mechanics with a manual warp ladder; the maintainer — the game's own author — could not fly to a planet or toward the Sun.
- **Visuals are below the bar.** Engineering substrate rated ~4.7/5 (camera-relative float64 rendering, adaptive quality, CI perf gates), but visual output ~2.3/5: 34 of 43 bodies are untextured Lambert spheres, no atmosphere scattering, no shadows/eclipses, no Milky Way, no rotation applied to any body, minimal post-processing, no audio, no sense of motion.

The maintainer's verdict: v1 delivered an instrumented planetarium; the intent was a game where you *fly*.

## 2. Vision — what v2.0 is

> You start in low Earth orbit looking at **your ship**, sunlit, Earth turning below, the Milky Way behind. Mouse-look swings the nose smoothly; RCS puffs are visible. Throttle up: the photon drive ignites into a blinding collimated beam, the camera pulls back slightly, the hull hums. Click Jupiter in the sky and engage **cruise**: the ship orients itself, burns, and time compresses smoothly — Earth shrinks, the dual clocks diverge, γ climbs. Mid-way the ship flips and brakes. Time decompresses on arrival; Jupiter fills the screen. You fly a low pass over the cloud tops, cross the ring plane, visit Io. Then you point "up", leave the ecliptic, and go see the Sun's north pole — the corona alive, exposure adapting — while the exploration diary records the milestone.

Every number on the HUD would satisfy a mission engineer — but the numbers are now **optional panels**, not the game. The game teaches physics by making it *visible and honest*, not by lecturing.

**One-line identity:** a third-person relativistic torchship sandbox across the real solar system — physically honest, visually stunning, playable by anyone.

## 3. Design pillars and non-goals

### Pillars (in priority order)

1. **The ship is the protagonist.** Always visible in third person (default), beautiful up close, with engine/RCS VFX. Piloting must *feel* like flying.
2. **Point-and-fly, physics-honest.** Torchship with continuous proper acceleration (up to ~10 g cruise) plus automatic time compression makes any destination minutes away — with zero physics cheating. Relativity is a feature, not an obstacle.
3. **Visually stunning at every scale.** Four visual fronts, all committed: close-up planets (all 43 bodies), a sublime Sun, ship + engine VFX, deep sky + sense of motion.
4. **Honest data, no lessons.** Real values, correct units, visible physics (dual clocks, γ, energy in Wh). No tutorial-lecture content, no "teacher mode". The simulation itself is the lesson.
5. **Sandbox + exploration diary.** Total freedom from the first second; the game notices and records natural milestones (first orbit of each body, ring crossing, solar polar overflight, 0.9 c, twin-paradox return) with a local photo album.

### Non-goals for v2.0 (explicitly out)

- Landing / surface operations (terrain, contact physics). v2 includes **collision and low flybys**, not touchdown.
- The 2D Alcântara launch phase (T0060–T0062 stay BLOCKED, spec preserved for later).
- Docking, stations, multiple ships, missions/contracts, multiplayer, other star systems, mobile/touch.
- WebGPU migration (ADR-008 deferral reaffirmed; v2 stays on WebGL2/three.js).
- Localized UI (game text remains English; repo convention).

### Constraints carried from v1 (unchanged)

- Layering `core ← sim ← game ← render/ui`, ESLint-enforced; `SimSnapshot`/`Commands` remain the only cross-layer interfaces (ADR-004).
- Float64 physics, km/km s⁻¹/s/km³ s⁻², heliocentric ecliptic J2000, single f64→f32 boundary in `spaceScene.ts` (ADR-003).
- Rails for bodies + full n-body relativistic ship (ADR-001/002/007); analytic Kepler rails from baked Horizons elements.
- Zero allocation in the frame loop; 60 fps floor with the adaptive governor; startup ≤ 5 s to first playable.
- Browser + GitHub Pages deployment (no COOP/COEP ⇒ no SharedArrayBuffer); budgets raised deliberately (§13), never silently.
- File-per-task YAML protocol, ADR gating for `SimSnapshot`/`Commands`/`bodies.json`/physics formulas.

## 4. Flight model

### 4.1 Regimes

One continuous model, no mode switch in the physics — only in *assist posture*:

| Regime | Typical context | Control posture |
|---|---|---|
| **Manual flight** | near bodies, warp 1×–100× | mouse-look + throttle; assists damp and hold |
| **Cruise** | interplanetary, warp up to ladder max | CruiseDirector flies attitude/throttle/warp; player supervises, can abort any time |

### 4.2 Manual flight

- **Mouse-look steering (pointer lock):** mouse motion defines a desired attitude; a game-layer controller (`FlightController`) pursues it by issuing the existing `commands.rotate(pitch, yaw, roll)` with rate limits and critically-damped easing, so the ship banks and settles like a vehicle with mass. Keyboard/gamepad axes remain available and rebindable.
- **Wall-time authority (bug fix):** commanded rotation rates are normalized so a given stick/mouse deflection produces the same *wall-clock* apparent rate regardless of warp; manual rotation is locked above a threshold warp (attitude holds take over). This fixes v1's warp-multiplied tumbling.
- **Analog throttle:** continuous 0–100% (keyboard ramps, gamepad axis maps directly). The 10-step ratchet is gone.
- **Assists (default ON, individually toggleable):**
  - *Kill rotation* (SAS damping) — default idle behavior.
  - *Hold prograde / retrograde / normal / anti-normal / radial in / out / target* — binds the 5 already-implemented-but-unbound sim autopilot modes plus the 2 bound ones.
  - *Approach brake* — computes required deceleration to stop relative to target; warns, and (if enabled) engages automatically.
  - *Flip-and-burn* — automatic 180° flip at cruise midpoint (part of CruiseDirector, also usable manually).
- **Attitude slew (sim change, ADR):** autopilot hold modes currently snap the quaternion instantly per derivative evaluation. With a visible ship this is unacceptable at 1×. Hold modes gain a rate-limited slew (configurable max slew rate, default ≈ 15°/s at 1×) toward the solved direction. At high warp the slew completes in negligible wall time, preserving current warp semantics and test expectations (tolerances re-validated).
- **Ship performance:** `Vessel` config (ADR): rest mass, α_max manual (default 2 g), α_max cruise (default 10 g), RCS rotational authority. Rest mass stays constant (photon drive, ADR-007). Optional stretch (P2): low-power translational RCS (~0.05 g laterals) for fine trim; requires a `Commands` extension, deferred unless V2M2 finds it necessary.

### 4.3 CruiseDirector (the headline system)

A game-layer autopilot that makes "click Jupiter, arrive in minutes, physics honest" true.

- **Engage:** select target (click body in-world, in system map, or target list) → engage cruise (key/button). Player picks arrival intent: *orbit* (default; circular orbit at a per-class safe altitude, nominally 3 body radii for planets/moons, higher for ringed giants to arrive outside the rings — exact table in the implementation plan) or *flyby* (choose periapsis altitude).
- **Guidance:** solves constant-acceleration intercept of a rails-moving target: iterate time-of-flight → target state at arrival → boost/flip/brake profile with mid-course correction; relativistic kinematics included (the profile is computed with the same celerity math the sim integrates). Numerical, well-conditioned at torchship accelerations; specified as **physics-spec §8** with golden tests (Earth→Mars, Earth→Jupiter, LEO→Moon, high-inclination Earth→Sun-polar).
- **Warp piloting:** CruiseDirector requests warp tiers from the existing ladder, respecting all existing clamps (integration budget, gravity-well descent) and the thrust-warp ceiling; ramps compression down for flip, arrival, and any player input (touching the stick decompresses smoothly to ≤100× within ~1 s wall time and pauses cruise).
- **Pacing target:** interplanetary trips ≈ 2–5 wall minutes; Earth→Moon ≈ 1 min; Kuiper belt ≈ 8–12 min. Achieved via cruise α up to 10 g and a re-tuned thrust-warp ceiling (ADR revising ADR-026's 1000× after accuracy benchmarks; target ≥ 3000× thrust-warp if DP54 error stays within golden tolerances, else profile shifts to burn–coast–burn automatically).
- **Honesty rules:** compression level always visible; dual clocks always run (coordinate t and proper τ); the energy ledger records every joule; no teleportation, no rubber-banding, the trajectory is the integrated one. Near-c cruises make aberration/Doppler/beaming (already implemented) and clock divergence the visible drama.
- **Abort/decompress:** always one input away; safety decompression on SOI change, collision-course warning, or arrival.

### 4.4 Collision and low flybys

- **Sim change (ADR):** `SimulationCore` detects surface crossing (ship altitude vs `meanRadiusKm`, or cloud-deck radius for gas/ice giants via `surface` descriptor). On impact: simulation freezes at contact state, snapshot carries an impact event, game layer presents an impact summary (speed, body, mission time) with two options: **restore** (pre-impact autosave ~10 s prior) or **respawn** in a stable orbit above the body. Sandbox-friendly, no punitive game-over.
- **Radar altitude** readout appears below a threshold altitude; collision-course warning (predictor already computes impact) gains urgency states + audio cue.
- **Low flybys are a supported experience:** close-range detail shading strengthened, and the camera minimum-distance rule prevents clipping into the surface. No terrain meshes in v2 (non-goal), but hero-body texture/detail work targets "looks great at 2× radius" as the acceptance bar, and mean-sphere collision keeps it honest.

## 5. Cameras

`CameraDirector` (game layer) owns mode state and transitions; all modes reuse the proven float64 controller pattern and the existing beautiful focus-transition machinery (log-distance blend + context pull-back).

1. **Chase (default):** spring-arm behind the ship; configurable distance/stiffness; follows attitude with slight lag; subtle FOV widening with thrust and gentle shake on high-g burns (both toggleable, default subtle). The ship becomes a `CameraFocusTarget` (the contract already anticipated this).
2. **Cockpit "lite":** first-person from the canopy with a glass-HUD; canopy frame silhouette only, no full modeled interior in v2 (v3 candidate). Relativistic post effects apply coherently here (the observer is finally *at* the ship — fixes v1's incoherent aberration-on-planet-camera).
3. **Cinematic / photo:** free orbit around the ship (existing orbit controller pointed at the ship target), HUD hidden, roll/FOV control, screenshot capture → exploration diary album.
4. **Observatory:** v1's body-focus orbit camera, kept as-is (it is good), reachable from the map and a camera menu.

Default binding: one key cycles chase→cockpit→cinematic; observatory via map/UI. All transitions animated, never a hard cut.

## 6. Visual design

### 6.1 Front A — planets up close

- **All 43 bodies get authored or procedural assets.** Hero assets: Mercury, Venus (cloud deck), Mars, Io, Europa, Ganymede, Callisto, Titan, Triton, Charon. Standard assets: remaining moons + dwarfs (real maps where public sources exist — USGS/NASA —, high-quality procedural otherwise, seeded by `proceduralSeed`). Asteroids/comets: `build_asteroid.py` + `build_comet.py` (specified in the pipeline doc, never written) generating real shape models where available (Eros, Bennu, Ryugu, 67P) and procedural shapes otherwise; 67P/Halley get coma/tail visuals near perihelion (new rendering-spec section; activated by heliocentric distance threshold).
- **Atmospheric scattering:** analytic single-scattering (Rayleigh + Mie, per-body parameters in the catalog) as a material/shell hook in the existing `onBeforeCompile` pattern: Earth (blue limb, sunsets on the terminator), Venus/Titan haze, Mars thin dust limb, gas-giant limb glow. Aerial perspective for low flybys on atmosphere bodies.
- **Shadows & eclipses:** analytic sphere-occluder test (generalization of the existing ring-shadow technique) — moons cast umbra/penumbra on parents and vice versa; rings keep their mutual shadows. Eclipse events become diary-worthy moments.
- **Rotation & axial tilt everywhere:** apply `siderealRotationPeriodSec` + `axialTiltRad` (in the catalog, currently unused) to all bodies in sim time; fix the ringed-body double-tilt hazard; apply `polarRadiusRatio` oblateness at tier 2 so silhouettes don't pop at tier transitions.
- **Silhouette quality:** raise tier-2 sphere tessellation (320 tris → tier-scaled), keep budgets via instanced/governed geometry.

### 6.2 Front B — the Sun

- Upgrade the procedural photosphere (granulation octaves, limb darkening kept), **living corona** (layered noise billboards + streamers replacing the 3 hardcoded arcs), prominences on the limb, subtle chromosphere ring.
- **God rays** (screen-space radial scattering when the Sun is visible) and a restrained physical lens flare (toggleable).
- **Adaptive exposure:** smooth photopic adaptation between deep-space and near-Sun irradiance (physically-motivated curve with artistic clamps) — replaces fixed exposure 1.0; makes both the Sun approach and Neptune twilight read correctly.
- The Sun's north pole view is the release's signature shot; a diary milestone and the README hero image.

### 6.3 Front C — ship & engine VFX

- **Ship remodel** (`build_ship.py` v2): a vessel designed to be stared at — hull paneling, canopy, RCS pods, nozzle assembly, running lights; PBR textures authored properly (current ship is procedural programmer-art at 18% of its triangle budget). Keeps ADR-025 contracts: +X nose/thrust axis, `hull_tip`/`engine_nozzle` nodes, meters scale.
- **Photon-drive plume:** the exhaust *is* light — rendered as an intense collimated beam + bloom + faint exhaust-cone glow, length/intensity ∝ throttle; visible from far away as an artificial star (tier-integrated). Unique visual identity, physically motivated.
- **RCS puffs** (impulse-keyed sprites at pod positions), running/anti-collision lights, **planetshine**: secondary fill light from the dominant body's albedo (honest, gorgeous in LEO), plus sun specular on the hull. No fake three-point studio rig; a labeled optional "camera fill" at very low intensity for accessibility.

### 6.4 Front D — deep sky & sense of motion

- **Milky Way panorama** (ESO/Gaia-derived CC imagery, KTX2, lazy-loaded outside the critical path) blended beneath the existing 9,096-star Yale catalog (kept — real stars stay real); subtle zodiacal light along the ecliptic.
- **Sense of speed, honestly:** near bodies, real parallax already works; in cruise, visible system motion (compressed time) is the honest cue; near c, the existing aberration/Doppler/beaming intensify. One labeled artistic license: sparse zodiacal micro-dust streaks near the ship (default on, off in "purist" preset).
- Optional overlay: constellation lines + body labels with live distances (fits "honest data"; helps navigation by sky).

## 7. HUD & UI

- **Three presets** (cycle key + settings): **Clean** (reticle + target diamond with ETA/closing speed + throttle/velocity strip + cruise status + warnings only), **Pilot** (+ navball, dual clock, radar altitude, warp indicator), **Engineer** (everything v1 had: osculating elements, energy ledger, state-vector triad, burn log — as dockable/collapsible panels).
- **In-world markers** (Elite-style): target diamond + intercept lead, prograde/retrograde/normal markers projected on the sky, body labels with distance (toggle), SOI-boundary hint on approach.
- **Click-to-target:** click a body in-world or in the map to select; target panel remains as a list fallback.
- **Kept verbatim:** navball (excellent), dual clock, energy ledger, burn log, perf panel (F3), warp clamp reasons.
- **Layout rebuild:** design tokens + CSS grid replaces 1,789 lines of absolute positioning; HUD stays DOM/Preact with the proven 10 Hz signals pattern; panels get a shared docking/collapse component. Full input rebinding UI extended: gamepad bindings, sensitivity/invert, per-assist toggles, HUD preset editor, audio mixer, quality tiers.
- **System map:** kept as a mode; gains cruise-target selection and "engage cruise from map". (Longer-term map upgrades are out of v2 scope.)
- **Main menu:** cinematic backdrop (ship + Earth live scene), New Game / Continue / Diary / Settings; the measured-startup semantics and `?autostart=1` are preserved.
- **Input defects fixed by construction:** new input system uses pointer lock + explicit UI-focus policy (flight input never dies because a button has focus; Shift is a normal modifier; Escape opens a real pause/system menu).
- **Pause:** a real pause state (sim halted, menu overlay) — v1 had none.

## 8. Exploration diary

- **Milestones (~50 at launch, data-driven):** first orbit / first close approach per body; ring-plane crossing; solar polar overflight (the flagship); speed marks (0.1/0.5/0.9/0.99 c); γ marks; twin-paradox return (arrive back at Earth with |t−τ| > 1 day); full planet tour; eclipse witnessed; energy marks (first PWh). Defined declaratively (predicate over `SimSnapshot` stream + diary state), evaluated in the game layer at 10 Hz, no sim changes.
- **Album:** photo-mode captures stored locally in IndexedDB (quota-aware, oldest-evicted with user consent), with mission timestamp + location + flight stats (γ_max, Wh, v_max). Export/import as JSON alongside the save envelope; privacy stance unchanged (all local).
- **Diary UI:** panel from menu/HUD listing milestones (achieved + silhouetted "undiscovered" hints) and the album grid.

## 9. Audio

- **Engine:** Web Audio, no heavy dependency; a small `AudioDirector` (game layer) driven by snapshot facts + UI events.
- **Layers:** adaptive ambient music (deep-space calm / giant-planet awe / near-Sun majesty / collision-warning tension) crossfaded by context; interior ship sound bed keyed to state (drive hum ∝ throttle + regime, RCS ticks, cruise engage/disengage transitions, warp shifts, HUD alerts, hull stress on high-g flip); UI click set.
- **Camera-aware mixing:** interior sounds only in cockpit/chase-near; **Kubrick mode**: exterior cameras go vacuum-silent (label: physically honest) with music optional.
- **Assets:** CC0/CC-BY sources + light synthesis; OGG; a few MB, outside the startup critical path; volume mixer in settings (master/music/SFX/UI), default modest.

## 10. Onboarding (not a tutorial course)

Consistent with "no lessons": a **90-second interactive intro** on first flight only — look around → throttle → click Moon → engage cruise → arrive. Five prompts, skippable, never returns. The v1 tutorial's 12-step UI checklist is retired; the existing DOM-free tutorial state machine is reused to drive the intro. Everything else is discoverable via the HUD and a static controls reference.

## 11. What v2 deliberately keeps from v1 (protected list)

`SimulationCore` + relativistic (r,u,τ) DP54 + rails + energy ledger + burn log; golden trajectories; camera-relative f64→f32 boundary; visual tier ladder + apparent-magnitude math; ring systems; gas-giant animation; procedural-sun base; relativistic post pass; starfield; perf governor + startup quality + telemetry; predictor worker + trajectory overlay; navball; signals HUD pattern; save/load envelope discipline; asset pipeline (Draco/KTX2, determinism); task protocol + ADR discipline; all CI gates (with re-baselined goldens where features legitimately change them).

## 12. Technical architecture

### 12.1 Layer mapping of new systems

| Module (new) | Layer | Responsibility |
|---|---|---|
| `game/flight/flightController.ts` | game | mouse/gamepad intent → rate/throttle `Commands`; wall-time normalization; assist orchestration |
| `game/flight/cruiseDirector.ts` | game | intercept guidance, flip-and-burn, warp piloting, arrival insertion; consumes `sim/analysis` helpers |
| `game/cameraDirector.ts` | game | camera mode state machine + transitions; ship focus target |
| `game/diary/…` | game | milestone predicates, IndexedDB album, export/import |
| `game/audio/audioDirector.ts` | game | context → audio layer state (render-agnostic) |
| `sim/guidance/constantAccelIntercept.ts` | sim | pure relativistic boost-flip-brake solver (physics-spec §8), unit-tested + goldens |
| `sim/ship/collision.ts` (+ `SimulationCore` integration) | sim | surface-crossing detection, impact state capture |
| `render/shipVisual.ts`, `render/plume.ts`, `render/rcsVfx.ts` | render | ship model binding, beam plume, RCS sprites, lights |
| `render/atmosphereScattering.ts`, `render/eclipseShadows.ts`, `render/milkyWay.ts`, `render/exposureAdaptation.ts`, `render/bodyRotation.ts` | render | the four visual fronts (hook pattern, governed) |
| `ui/hud/…` (rebuilt layout, presets, markers) | ui | Clean/Pilot/Engineer presets, in-world markers, pause menu, diary UI, audio settings |

Import direction unchanged. Sim modules stay pure (the intercept solver takes state + catalog, returns a profile; no DOM, no three.js).

### 12.2 Sim-layer changes (all ADR-gated, deliberately small)

1. **Collision** (new): surface-crossing detection + impact event in snapshot; simulation freeze semantics.
2. **Attitude slew** (change): rate-limited hold-mode pursuit (default ≈ 15°/s at 1×; warp-scaled); manual-rotation wall-time normalization contract.
3. **Vessel config** (new): `{restMassKg, alphaMaxManual, alphaMaxCruise, rcsAuthority}` replacing the hardcoded `SHIP_MASS_KG` and fixed α_max; serialized in the save envelope.
4. **Thrust-warp ceiling retune** (revision of ADR-026): raise `MAX_THRUST_WARP` from 1000× to the highest tier that keeps golden-trajectory error within existing tolerances (benchmarked; target ≥ 3000×).
5. **Guidance module** (new, additive): physics-spec §8 constant-acceleration relativistic intercept.
6. **Commands/SimSnapshot deltas:** impact event fields, vessel config injection, (P2 only: translational RCS command). Everything else uses existing commands.

### 12.3 Render/UI-layer notes

- Post pipeline gains a pass-insertion API (currently hardcoded order) before new passes (god rays, exposure) land; the private-field SMAA/bloom casts are contained there and re-validated against the pinned three.js version.
- New visuals follow the established `onBeforeCompile` + `customProgramCacheKey` + reversible-dispose hook pattern and the `prepareCompilationPass` warm-up discipline (no first-use shader stalls).
- Known landmines scheduled as explicit fixes: Eris outside the 1e10 km far plane; camera max-distance clamp; Earth-cloud wall-clock rotation (moves to sim time); tier-2 double-mesh draw-call growth (batched or budgeted); frame-loop NaN hard-throw gains a graceful degradation path for new subsystems.
- `main.ts` decomposed into composition modules; the six frozen canvas diagnostic objects and `RuntimeResourceCounts` contracts are ported intact (≈25 CI browser gates depend on them) and extended for new resources.

### 12.4 ADRs to write (numbered at execution time)

1. v2 kickoff: scope, pillars, reaffirm WebGL2 (ADR-008 deferral), budget-raise policy.
2. Collision & impact semantics.
3. Attitude slew + wall-time input authority.
4. `Vessel` configuration.
5. Thrust-warp ceiling revision (supersedes part of ADR-026).
6. Guidance spec §8 (constant-α relativistic intercept) + golden policy.
7. Source-texture policy: 8K sources fetched by pinned script (`fetch_textures.py` extended) instead of committed (repo 300 MB budget protection); checksums pinned, `SOURCES.md` unchanged.
8. Audio architecture + asset licensing intake.
9. Diary storage (IndexedDB) + album export format.
10. Budget re-baseline (bundle/assets/draw-calls/heap goldens per milestone).

## 13. Budgets & performance (deliberate revisions)

| Budget | v1 | v2 target | Rationale |
|---|---|---|---|
| Total JS+CSS gzip | 570 KB (14 KB free) | **≈ 1 MB** | cruise/cameras/audio/scattering code; raised via reviewed golden commit |
| Entry gzip | 285 KB | ≈ 400 KB | new game-layer bootstrap |
| Startup to playable | ≤ 5 s | **≤ 5 s (unchanged)** | Milky Way/audio/new bodies lazy-load outside `initial-path.json` |
| `public/assets` | 150 MB (31 used) | 150 MB (est. 90–120 used) | 34 new bodies + skybox + audio |
| Repo content | 300 MB | 300 MB (source-fetch policy) | ADR §12.4-7 |
| Frame | 60 fps floor, governed | unchanged; governor gains rungs for scattering/plume/skybox/exposure | |
| Draw calls / tris goldens | 10 / 77 k | re-baselined per milestone, reviewed | ship+VFX+markers+skybox |
| Heap growth window | ≤ 192 KiB | unchanged | zero-alloc discipline holds for all new frame-loop code |

Reference-hardware definition unchanged; quality tiers auto-detected as today.

## 14. Execution model

### 14.1 Protocol fit

- **T0102 (first, blocking):** generalize `releaseReadiness` to release-scoped task sets (v1 check currently fails CI if any new task file is not DONE) + dashboard regeneration. No other v2 task can be committed before this merges.
- Milestones `V2M1…V2M6` added to `docs/roadmap.md` in the same change that introduces them; asset lane runs continuously from V2M1 (v1's proven pattern).
- Tasks: one PR each, 3–5 numeric acceptance criteria, spec+plan docs per non-trivial task, ADRs in the same PR as governed changes, bench evidence for render/frame-loop PRs. Estimated 55–70 tasks; the implementation plan carries complete YAML for each.

### 14.2 Milestones (dependency spine)

- **V2M1 — "The ship exists."** Input rewrite (pointer lock, wall-time authority, gamepad), ship rendered + chase camera, manual mouse-look flight, collision v0 (restore/respawn), HUD Clean v0, pause. *Exit: fly around Earth–Moon by hand, crash, restore, 60 fps, all v1 sim goldens green.*
- **V2M2 — "The system is yours."** CruiseDirector (guidance §8 + warp piloting + arrival insertion), click-to-target, assists suite (all holds bound + approach brake), map cruise integration, warp-ceiling retune. *Exit: click Jupiter from LEO → arrive in a stable orbit in ≤ 5 wall minutes, ledger/goldens honest, abort works mid-cruise.*
- **V2M3 — "Stunning I."** Ship remodel + plume/RCS/lights + planetshine, cockpit-lite + cinematic/photo cameras, Milky Way, adaptive exposure, body rotation/tilt/oblateness, Eris/far-plane fix. *Exit: the LEO opening shot and a Saturn arrival are screenshot-worthy; camera modes cycle smoothly.*
- **V2M4 — "Stunning II."** All 43 bodies asseted (hero + standard + asteroid/comet tooling), atmospheric scattering, eclipse shadows, Sun upgrade + god rays, close-range flyby detail. *Exit: no untextured body anywhere; Sun-pole shot is the README hero; eclipse visible from Io.*
- **V2M5 — "Alive."** Audio engine + adaptive music + ship sounds + Kubrick mode; diary milestones + album + export; cinematic main menu; settings expansion (assists/HUD/audio/camera). *Exit: full sensory loop; diary records a grand-tour run.*
- **V2M6 — "Ship it."** Performance re-baseline across tiers, 90-second intro, accessibility pass (focus order, reduced-motion, captions for audio cues), docs/README/release-notes, v2.0.0 tag + Pages deploy + live audit. *Exit: release checklist green, tag peels to deployed commit.*

### 14.3 Risks & mitigations

| Risk | Mitigation |
|---|---|
| Guidance solver divergence in edge geometries (Sun-polar, near-SOI targets) | pure-function solver with golden suite before UI integration; fallback profile (burn–coast–burn pursuit) always available |
| Warp-ceiling raise degrades accuracy | benchmark-first ADR; ceiling chosen from measured golden error, not desire |
| Draw-call growth from 43 asseted bodies + VFX | per-milestone golden re-baseline + governor rungs; tier-2 double-mesh consolidation task |
| Bundle creep past 1 MB | per-task gzip cost named in acceptance criteria (v1 discipline, larger envelope) |
| `main.ts` decomposition breaks the 25 diagnostic-reading CI gates | port-then-refactor: diagnostics contract test added *before* the split |
| Cockpit demands full interior art | cockpit-lite scoped to canopy frame + glass HUD; full interior explicitly v3 |
| Asset lane stalls (34 bodies is a lot of Blender) | per-body tasks fully parallel; procedural fallback quality bar defined so no body ships gray |
| Adaptive exposure fights magnitude-honest rendering | single exposure controller owns the mapping, validated against the apparent-magnitude tests |

## 15. v2.0 release acceptance (measurable)

1. From a fresh LEO start, a player using only the mouse, throttle, and cruise can: orbit the Moon, land a Jupiter arrival orbit, cross Saturn's ring plane, and view the Sun's north pole — each in ≤ 5 wall minutes per leg, without reading documentation.
2. The ship is visible and lit in every camera mode; engine/RCS VFX respond to input within one frame.
3. All 43 catalog bodies have non-placeholder visuals at every tier; all rotate with correct period and tilt.
4. Collision ends flight with restore/respawn; no fly-through of any body.
5. All v1 physics goldens pass unchanged (or with ADR-documented tolerance revisions); new cruise goldens pass on CI.
6. 60 fps on reference hardware at default tier with the full HUD; startup ≤ 5 s; zero frame-loop allocations (gate green).
7. Dual-clock divergence, γ, %c, and the energy ledger remain correct and visible in Pilot/Engineer presets (spot-checked against analytic values in CI).
8. Diary records ≥ 50 distinct milestones; album capture/export works; all data local.
9. Audio behaves per §9 including Kubrick mode; the game is fully playable muted.
10. Deployed on GitHub Pages within revised budgets; release checklist + live audit green; tagged v2.0.0.

## Appendix A — maintainer interview record (2026-08-14)

| Question | Decision |
|---|---|
| v1 pain points | couldn't reach places; invisible ship; abstract piloting; visuals below bar (instrument density was *not* a complaint) |
| Flight model | torchship point-and-accelerate (physics-honest arcade) |
| Trip pacing | automatic cruise time-compression (manual warp remains as override) |
| Cameras | chase (primary) + cockpit + cinematic/photo + observatory |
| Education | honest data only; no lessons/teacher mode |
| Structure | sandbox + exploration diary (no missions) |
| Visual priorities | all four fronts non-negotiable |
| Scope | no landing/launch/docking; collision + low flybys IN |
| Platform | browser + GitHub Pages, budgets raised deliberately |
| Audio | music + ship sounds + optional honest-silence mode |
| Approach | A — targeted transformation on the existing foundation |
