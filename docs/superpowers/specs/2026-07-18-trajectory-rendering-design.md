# T0071 Trajectory Rendering Design

## Goal and scope

Render the current thrust-free worker prediction as a camera-relative fat
polyline, color every segment by its dominant body, place billboarded SOI,
closest-approach, and impact markers on that same polyline, and surface closest
approach and impact information in the HUD. T0071 also wires the already-built
module worker and predictor client into the production application.

The system-map bullet in `rendering-spec.md` section 7 is outside this task.
The existing osculating conic remains visible as immediate feedback while the
worker is debouncing or computing.

## Chosen approach

One `TrajectoryOverlay` owns exactly two drawables created during world setup:

- a preallocated `Line2`/`LineGeometry`/`LineMaterial` for at most 2,000
  predicted points; and
- one `THREE.Points` marker batch with a small precompiled shader for all SOI,
  closest-approach, and impact icons.

This is preferred over one line or sprite per event/body because the latter
increases draw calls and runtime object churn. It is also preferred over a
custom GPU float64 transport because the renderer's established
camera-relative CPU boundary is both simpler and more precise at solar-system
scale.

## Packed prediction model

`game/trajectoryPredictionModel.ts` is a browser-independent reader for the
T0070 point/event buffers. It validates counts already guaranteed by the worker
protocol and writes into caller-owned storage:

- event markers are located by binary-searching the monotonically increasing
  point times;
- an exact event time copies the corresponding point position;
- a time between two samples is linearly interpolated between those samples,
  which places the marker exactly on the rendered polyline segment;
- times outside the point interval are rejected rather than extrapolated;
- segment body indices begin with the earliest SOI transition's primary body
  when available, otherwise with the current snapshot's dominant body, and
  switch at each SOI event time; and
- the summary contains the closest-approach body/time/distance, impact
  body/time/time-to-impact, and deterministic error text.

The predictor currently appends closest approach after the propagation events,
so event records are not assumed to be globally time-sorted. Each record is
handled independently. Body palette colors are deterministic from canonical
body IDs and are written as identical start/end colors for each `Line2`
segment.

## Camera-relative rendering

`CameraRelativeSpaceScene` remains the only float64-to-float32 position bridge.
It gains a setup-time packed-polyline binding. The binding retains a stable
maximum-sized float64 xyz buffer and the existing `LineGeometry` interleaved
segment buffer. Each frame it writes only the active segments as
`Math.fround(point - camera)` and marks the existing GPU buffer dirty. No
geometry, material, typed array, object, or closure is created in the frame
loop.

The overlay copies a successful transferred result into stable preallocated
point and marker storage outside the frame loop. It changes
`geometry.instanceCount` and the marker draw range rather than replacing
resources. The `LineMaterial` uses screen-pixel width, vertex colors,
transparent depth testing, and the current drawing-buffer resolution. Marker
points are inherently camera-facing; their shader draws a ring for SOI, a
diamond for closest approach, and a warning triangle for impact from
`gl_PointCoord`. Point size is expressed in CSS pixels multiplied by renderer
pixel ratio.

The line and marker batches keep frustum culling enabled with reusable bounding
spheres updated from active camera-relative positions. Hidden/empty predictions
set both active counts to zero.

## Runtime integration and invalidation

`main.ts` creates one module worker with
`new Worker(new URL('./workers/predictor.worker.ts', import.meta.url),
{ type: 'module' })`, then creates one owning `TrajectoryPredictorClient`.
`createNewGameSimulation()` and the persistent-state factory accept the
existing `TrajectoryInvalidationListener`, so every replacement simulation
retains thrust, attitude, target, and warp-command invalidation.

The first prediction is invalidated after world setup. Every frame calls the
client's allocation-free `update(snapshot)`. For elapsed warp time, the runtime
compares the snapshot time with the first time in the displayed prediction.
Once the simulation advances by at least one prediction sample interval, it
calls `invalidateForWarpElapsed()` exactly once for that displayed result. A
boolean latch prevents repeated invalidations from resetting the 500 ms quiet
period; a new successful result resets the latch.

The client already suppresses stale responses. A successful current response
updates the overlay and presentation store together. A transport or worker
error leaves the application responsive, hides potentially stale impact data,
and exposes an unavailable status in the trajectory readout.

## HUD presentation

`ui/trajectoryPredictionSignals.ts` owns a small signal graph sampled at the
existing 10 Hz HUD cadence. The target panel replaces “Awaiting trajectory
predictor” with the next closest-approach distance and countdown. A separate
`TrajectoryImpactWarning` alert appears only when the current prediction
contains an impact, names the canonical body, and counts down from the absolute
event coordinate time. No DOM nodes are rebuilt per frame; only signal-backed
text and visibility change.

When no target is selected, closest approach displays an em dash. Before the
first prediction it displays “Calculating…”. On deterministic predictor failure
it displays “Prediction unavailable”, and the impact alert is cleared so stale
safety information is never presented as current.

## Lifecycle and errors

All worker listeners and the worker itself are disposed through the owning
client on page teardown. Overlay resources expose `dispose()` for tests and
future scene replacement, but normal prediction updates reuse them. Malformed
or impossible event references hide only the affected marker and produce no
non-finite GPU coordinates. A wholly invalid result is handled as unavailable
without replacing the last valid buffers mid-write.

## Performance contract

- Two draw calls at most: one fat line and one marker batch.
- Zero setup-resource creation after world initialization.
- Zero allocations on clean predictor-client and render-frame updates.
- At most 1,999 line segments and 2,002 marker slots.
- All shaders compile during the existing world warm-up.
- The PR records `npm run bench` before/after numbers because it touches
  `render/` and the frame loop.

## Verification

- Unit tests prove event-time interpolation, SOI-derived segment ownership,
  deterministic summaries, resource reuse, active counts, and exact shared
  float64 positions for line points and markers.
- Space-scene tests prove the polyline binding is camera-relative at multiple
  camera offsets without replacing buffers.
- UI tests prove calculating, closest-approach, unavailable, and impact states.
- A Vite/Playwright regression loads the real module worker, waits for a visible
  trajectory, checks marker alignment before and after zoom, and reports no
  browser errors.
- `npm run bench` captures before/after frame, draw-call, triangle, and heap
  evidence; full lint, typecheck, formatting, Vitest, build, budgets, task
  schema, smoke, performance gates, playtest, and independent review complete
  delivery.
