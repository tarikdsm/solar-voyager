# Game Design — Solar Voyager

## Vision

A pure-sandbox exploration game where the solar system itself is the antagonist. The player commands a single spaceship with **unlimited propulsion energy** — the challenge is never fuel, it is *physics*: every joule the drive draws is metered at its honest physical price (photon-drive bound, ADR-007), and the HUD keeps the score in Wh. Reaching Mercury is hard because plane changes and deep gravity wells are hard, not because the game says so.

Speed is capped only by the universe: the ship can push **arbitrarily close to the speed of light**, and the game plays special relativity straight — time dilation between ship clock and solar-system clock, energy diverging as γ grows, acceleration that feels heavier and heavier near c. Sizes, distances and sight-lines are exactly real: what you see out the window — how large Jupiter looms, how the Sun shrinks from Neptune — is what a real ship at that position would see.

The fantasy: you are flying a real trajectory through the real solar system, at real scale, and the numbers on your HUD would satisfy a mission engineer.

## Core loop

1. **Plan** — study the system map, pick a destination, eyeball a transfer window.
2. **Burn** — orient the ship, throttle up, watch the predicted trajectory bend in real time.
3. **Coast** — time-warp through the cruise, watching for encounter markers and SOI transitions.
4. **Arrive** — capture burn, orbit insertion, flyby, or rendezvous. The mission log records what it cost.
5. **Compare** — cumulative energy (Wh) is the player's "score", with proper Δv alongside; doing the same trip cheaper is the replay driver.

There are no fail states other than physics itself (crashing into a body, missing an encounter). No currency, no unlocks in v1.

## Game phases

### v1 — Space (3D). The game starts here.

- **New game starts with the ship in a 400 km low Earth orbit** (inclination ~2.3°, a nod to its Alcântara launch — the backstory of the future launch phase).
- Full 3D, camera-relative rendering at real scale.
- The ship feels the gravity of **every body in the catalog simultaneously** (full n-body on the ship). Planets and moons follow analytic Keplerian rails baked from JPL Horizons (see ADR-001).
- Time warp ladder: 1, 5, 10, 50, 100, 1e3, 1e4, 1e5, 1e6, 1e7. Thrust allowed up to 1000x; above that, coast only. Warp auto-clamps near gravity wells.
- v1 exploration verbs: reach orbit of any body, flyby, escape, plane change, Lagrange-point parking, rendezvous with a targeted body, **relativistic cruise** (push toward c and watch the two clocks split).
- **Relativistic travel (ADR-007):** the ship's dynamics are special-relativistic. |v| asymptotes to c (never reaches it — that asymptote IS the endgame challenge); the HUD shows speed as % of c and γ; the mission clock runs in ship proper time τ while the solar system runs in coordinate time — return from a near-c round trip and the planets have moved on without you (twin "paradox", played straight).
- **The launch inheritance:** starting in LEO, the ship already carries Earth's real ~30 km/s barycentric orbital velocity and the solar system's angular momentum — visible on the vector widget from frame one. Leaving the planetary plane (e.g., to visit the Sun's north pole) means rotating that inherited momentum vector, and the energy meter prices it honestly: it *feels* heavy, like flooring a car from standstill, because the physics makes it so.
- **Landing is out of scope for v1** but the architecture reserves a phase for it (see `architecture.md` § future expansion).

### Deferred — Launch phase (2D, optional post-v1 expansion)

Fully specified (physics-spec §4, tasks T0060–T0062) but **not part of v1**: manual launch from **Alcântara Launch Center, Brazil (2.3236°S, 44.3672°W)** — side-view 2D, player-controlled throttle and pitch rate, gravity turn, USSA-1976 atmosphere, Mach-dependent drag, max-q, Earth-rotation bonus (~465 m/s), handoff to 3D at 140 km. When built, it becomes an optional new-game mode ("start from launch pad") alongside the default "start in orbit".

## The ship

One vessel in v1 (modeled in Blender, `tools/blender/build_ship.py`):

- **Pure-energy (propellantless) drive**: the player commands proper acceleration (throttle = fraction of max α, configurable in the ship config); the drive draws power P = F·c (photon-drive bound, physics-spec §5). Unlimited reserve, honest meter.
- Attitude control: manual rotation + hold modes (prograde, retrograde, normal, anti-normal, radial in/out, target). RCS for attitude is treated as free (negligible next to translation costs).
- No propellant mass depletion — rest mass is constant; **cost is metered, not stocked**.
- The "weight" of a maneuver is emergent: near c, or when bending a large momentum vector, the same throttle produces visibly less coordinate acceleration (γ³ effect) while the power meter screams — no artificial handicaps.

## HUD (space phase)

| Element | Position | Content |
|---|---|---|
| **State-vector widget** (signature element) | **Bottom-right** | An elegant miniature 3D axis triad (own tiny viewport, same renderer) showing live vectors **relative to the solar-system barycenter (CM)**: velocity (starts at Earth's real ~30 km/s — visible from frame one), proper acceleration, relativistic linear momentum p = γm·v_rel and angular momentum L. Vector magnitudes labeled with prefix formatting; γ and % of c readouts integrated. Rotatable with the camera or pinnable to ecliptic axes. |
| **Energy panel** (headline metric) | **Bottom-right, beside/below the widget** | Cumulative energy spent in **Wh with SI prefixes k…Y** (e.g. `4.82 PWh`); live power draw (W) while thrusting; secondary: proper Δv (m/s) and ΔE_kin. Per-burn and per-session. |
| **Perf panel** | **Top-left corner** | Elegant compact row: FPS + frame-time sparkline (budget line at 16.6 ms), render resolution (e.g. `1920×1080 @0.85`), quality-tier badge. Expands (F3) to full telemetry: 1% lows, ms splits, draw calls/triangles, memory, GPU name, governor state. Spec: performance-spec §4 |
| Orbit readout | Left side, below perf panel | Dominant body, Ap/Pe, eccentricity, inclination, period — osculating elements, instant |
| Navball | Bottom-center | Attitude vs dominant-body frame, prograde/retrograde/normal/radial markers, thrust vector |
| Warp control | Top-center | Current warp, clamp indicator with reason ("gravity well: max 1000x") |
| Trajectory | In-world | Predicted n-body path (worker-computed), SOI transitions, closest-approach markers, impact warning with time-to-impact |
| Target panel | Right side | Selected body: distance, relative velocity, next closest approach |
| Mission log | Collapsible panel | Burn history: time (t and τ), duration, energy, proper Δv, prograde/normal/radial split, dominant body |
| **Dual clock** | Top-right | Coordinate UTC sim date **and ship proper time τ (MET)** side by side — they visibly diverge at relativistic speed; γ shown between them when > 1.001 |

(Launch-phase HUD — altitude, Mach, dynamic pressure/max-q, pitch, gravity/drag losses — is specified with the deferred launch expansion, not v1.)

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

1. **Launch phase (2D) from Alcântara** — optional new-game mode; fully specified, deferred (see above).
2. **Landing & surface operations** (a reserved phase in the scene state machine; bodies already carry a `surface` descriptor).
3. **Multiple ships / ship editor** (ship is behind a `Vessel` interface).
4. **Other star systems** (system is a data-driven `SystemDefinition`; a new system = new data file + ephemerides bake).
5. Missions/contracts, aerobraking, re-entry heating, docking with stations, multiplayer.
