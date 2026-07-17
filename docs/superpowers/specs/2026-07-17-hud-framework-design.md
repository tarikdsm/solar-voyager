# T0054 HUD Framework Design

## Goal

Add the first live Preact HUD layer: an orbit readout sourced directly from the
simulation's dominant-body osculating solution and a dual coordinate/proper-time
clock. The frame loop must remain allocation-free and the HUD must not cause a
full application render for every snapshot.

## Data flow

`main.ts` owns the canonical new-game `SimulationCore`. Every animation frame it
steps the simulation, copies the double-buffered body positions into the stable
render position buffer, and offers the current `SimSnapshot` to a HUD publisher.
The publisher samples at 10 Hz, as required by `performance-spec.md` section 5,
and writes only scalar `@preact/signals` values.

The Preact tree receives one stable `HudSignals` object at setup. Components pass
signals and computed signals directly as text children, so signal updates patch
leaf text nodes without re-rendering `App`, the orbit panel, or the clock panel.
Raw numeric signals retain the exact values from `SimSnapshot`; formatting is a
separate computed presentation concern.

## Orbit readout

The panel displays:

- dominant body id as a human-readable label;
- apoapsis and periapsis radii in km;
- eccentricity;
- inclination in degrees;
- period as a compact duration.

Radii, rather than altitudes, are shown because `SimSnapshot` publishes exact
osculating radii and does not publish body surface radii. Invalid elements render
as an em dash. Open trajectories render an infinite apoapsis/period explicitly.
No orbital value is recomputed in UI code.

## Dual clock

The top-right panel displays coordinate UTC from `utcTimeMs`, mission elapsed
proper time from `shipProperTimeSec`, and gamma only when it exceeds 1.001. The
coordinate and proper clocks therefore visibly diverge during relativistic
flight while remaining sourced from the same snapshot.

## Frame orchestration

The existing render loop gains measured simulation and UI phases:

1. step `SimulationCore` with wall delta;
2. copy body positions into the stable render/camera buffer;
3. publish the snapshot to HUD signals if the 100 ms sample deadline elapsed;
4. update camera and render;
5. send sim/render/UI timings to `RenderTelemetry`.

All objects, signal graphs, formatters, and callbacks are created at setup. The
per-frame path performs no object, array, closure, or string allocation; strings
are produced only on the 10 Hz HUD sample path.

## Testing

Unit tests prove exact scalar transfer, 10 Hz sampling, invalid/open-orbit
formatting, UTC/MET formatting, and signal granularity (an observer of one leaf
does not run when an unrelated leaf changes). Existing render regressions plus a
real-browser playtest verify that the overlay coexists with camera controls and
the WebGL scene without console errors.
