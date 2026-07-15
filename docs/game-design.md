# Game Design — Solar Voyager

## Vision

A pure-sandbox exploration game where the solar system itself is the antagonist. The player commands a single spaceship with **unlimited propulsion energy** — the challenge is never fuel, it is *physics*: every maneuver costs exactly what it would cost a real spacecraft, and the HUD keeps the score. Reaching Mercury is hard because plane changes and deep gravity wells are hard, not because the game says so.

The fantasy: you are flying a real trajectory through the real solar system, at real scale, and the numbers on your HUD would satisfy a mission engineer.

## Core loop

1. **Plan** — study the system map, pick a destination, eyeball a transfer window.
2. **Burn** — orient the ship, throttle up, watch the predicted trajectory bend in real time.
3. **Coast** — time-warp through the cruise, watching for encounter markers and SOI transitions.
4. **Arrive** — capture burn, orbit insertion, flyby, or rendezvous. The mission log records what it cost.
5. **Compare** — cumulative Δv and energy are the player's "score"; doing the same trip cheaper is the replay driver.

There are no fail states other than physics itself (crashing into a body, missing an encounter). No currency, no unlocks in v1.

## Game phases

### Phase 1 — Launch (2D)

- Starts on the pad at **Alcântara Launch Center, Brazil (2.3236°S, 44.3672°W)** — the real near-equatorial Brazilian launch site.
- Side-view 2D presentation (rendered with the same engine, orthographic camera).
- Player controls **throttle** and **pitch rate**; optional "prograde hold" assist for the gravity turn. Nothing is automated by default.
- Full ascent physics per `physics-spec.md`: Earth point gravity, US Standard Atmosphere 1976, Mach-dependent drag, dynamic pressure (max-q callout), co-rotating atmosphere, Earth-rotation velocity bonus (~465 m/s eastward, called out on the HUD).
- Failure is real: too shallow too early → drag losses and heat warning; too steep → lofted trajectory that falls back. Reaching a stable orbit is a skill.
- At 140 km altitude the simulation hands off to the 3D phase (seamless cinematic transition).

### Phase 2 — Space (3D)

- Full 3D, camera-relative rendering at real scale.
- The ship feels the gravity of **every body in the catalog simultaneously** (full n-body on the ship). Planets and moons follow analytic Keplerian rails baked from JPL Horizons (see ADR-001).
- Time warp ladder: 1, 5, 10, 50, 100, 1e3, 1e4, 1e5, 1e6, 1e7. Thrust allowed up to 1000x; above that, coast only. Warp auto-clamps near gravity wells.
- v1 exploration verbs: reach orbit of any body, flyby, escape, plane change, Lagrange-point parking, rendezvous with a targeted body.
- **Landing is out of scope for v1** but the architecture reserves a third phase for it (see `architecture.md` § future expansion).

## The ship

One vessel in v1 (modeled in Blender, `tools/blender/build_ship.py`):

- Unlimited energy, finite thrust: main engine with realistic thrust-to-mass (configurable in `data/bodies.json`-adjacent ship config), RCS for attitude.
- Attitude control: manual rotation + hold modes (prograde, retrograde, normal, anti-normal, radial in/out, target).
- No propellant mass depletion (infinite energy premise) — mass is constant; **cost is metered, not stocked**.

## HUD (space phase)

| Element | Content |
|---|---|
| **Δv ledger** (headline) | Cumulative Δv spent (m/s), session and per-burn; mechanical energy delivered (J) as secondary readout — same Δv costs more energy at high speed (Oberth effect made visible) |
| Orbit readout | Dominant body, Ap/Pe, eccentricity, inclination, period — osculating elements, instant |
| Navball | Attitude vs dominant-body frame, prograde/retrograde/normal/radial markers, thrust vector |
| Warp control | Current warp, clamp indicator with reason ("gravity well: max 1000x") |
| Trajectory | Predicted n-body path (worker-computed), SOI transitions, closest-approach markers, impact warning with time-to-impact |
| Target panel | Selected body: distance, relative velocity, next closest approach |
| Mission log | Burn history: time, duration, Δv, prograde/normal/radial split, dominant body |
| Clock | UTC sim date + mission elapsed time |

Launch-phase HUD: altitude, speed (surface & inertial), vertical speed, Mach, dynamic pressure q with max-q marker, pitch, throttle, apoapsis/periapsis as they emerge, Δv spent + gravity/drag losses.

## Content scope (v1 catalog, ~50 bodies)

- **Star:** Sun.
- **Planets:** Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune.
- **Dwarf planets:** Pluto (+Charon), Ceres, Eris, Makemake, Haumea.
- **Moons:** Moon; Phobos, Deimos; Io, Europa, Ganymede, Callisto; Titan, Enceladus, Mimas, Tethys, Dione, Rhea, Iapetus; Miranda, Ariel, Umbriel, Titania, Oberon; Triton.
- **Asteroids:** Vesta, Pallas, Hygiea, Eros, Bennu, Ryugu.
- **Comets:** 1P/Halley, 67P/Churyumov–Gerasimenko (coma/tail visuals near perihelion).

All on real orbits (elements baked at epoch 2026-01-01 TDB). Planets/Sun/major moons get high-quality Blender models with real NASA/USGS textures; asteroids/comets get simpler procedural or decimated real shape models.

## Audience & tone

Players who enjoyed KSP/Orbiter or are curious about real spaceflight. Presentation is sober and beautiful — real starfield, correct lighting, dark night sides — not cartoonish. All text in English.

## Out of scope for v1 (planned expansions)

1. **Landing & surface operations** (phase 3 in the scene state machine; bodies already carry a `surface` descriptor).
2. **Multiple ships / ship editor** (ship is behind a `Vessel` interface).
3. **Other star systems** (system is a data-driven `SystemDefinition`; a new system = new data file + ephemerides bake).
4. Missions/contracts, aerobraking, re-entry heating, docking with stations, multiplayer.
