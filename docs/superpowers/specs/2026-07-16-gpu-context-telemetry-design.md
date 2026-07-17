# T0045 GPU Context and Telemetry Design

## Scope

T0045 completes the WebGL2 bootstrap policy from `performance-spec.md` section
2 and adds the single render telemetry source from section 6. It does not add
the adaptive governor or full perf HUD, which remain later tasks. It exposes a
stable allocation-free contract those consumers can use.

## Context Bootstrap

`createRenderer()` creates the WebGL2 context explicitly before constructing
Three.js. This is necessary because Three.js r185 forwards
`failIfMajorPerformanceCaveat` and `powerPreference`, but does not forward the
standard `desynchronized` context attribute. The first attempt uses:

- `powerPreference: high-performance`;
- `failIfMajorPerformanceCaveat: true`;
- antialias, alpha, stencil and preserveDrawingBuffer disabled;
- depth enabled and `desynchronized: true`.

If that attempt returns null, the same canvas is retried with only
`failIfMajorPerformanceCaveat: false`. A second failure is fatal. The fallback
is recorded even when renderer-name inspection is unavailable.

The bootstrap probes `WEBGL_debug_renderer_info` once and falls back to the
standard `RENDERER` string. Names matching SwiftShader, llvmpipe, Software, or
Basic Render are classified as software. Renderer identity, fallback use,
effective context attributes, and WebGL2 flavor are copied into an immutable
setup report.

The context is probed for `EXT_clip_control` before Three.js construction.
Automatic mode selects reversed depth when the extension is present and the
logarithmic fallback otherwise. Regression-only forced reversed/logarithmic
modes exercise both paths. Three.js receives exactly one enabled depth option,
the existing canvas/context, and `HalfFloatType` output. The resulting
capability is verified against the requested strategy and recorded.

## Hardware Warning

The warning is driven only by the bootstrap report: caveat fallback or a
software renderer name makes it visible. It is a high-contrast overlay with the
required Chrome and Firefox instructions and an explicit acknowledgement
button. It cannot be dismissed by clicking outside or pressing Escape. The
hardware path does not render it.

## Render Telemetry

`RenderTelemetry` owns:

- a 120-entry `Float64Array` frame-time ring;
- a same-size preallocated percentile scratch buffer;
- current sim/render/UI split values;
- a mutable stable-identity snapshot refreshed at most every 250 ms;
- renderer.info render/memory/program counters;
- the immutable context report;
- four setup-time WebGL timer query slots when
  `EXT_disjoint_timer_query_webgl2` is available on a hardware renderer.

`beginFrame(timestampMs)` derives the frame delta and returns the clamped game
delta in seconds. `beginGpuTimer()`/`endGpuTimer()` surround the renderer call.
`endFrame()` records subsystem splits and refreshes the snapshot when due.
Consumers read the stable snapshot and indexed ring accessors; no copies are
made in the frame loop.

The bootstrap publishes the single `RenderTelemetry` instance once on the
canvas as a non-enumerable, non-configurable, non-writable property. This is the
read path for the future HUD/governor and lets the production benchmark consume
the exact ring and snapshot without adding DOM/string work to the frame loop.
The benchmark waits for renderer, camera, and telemetry readiness before its
warmup, retains its historical 600-frame comparison metrics, and also records
the canonical 120-frame ring, renderer counters, and context report.

GPU results are polled only for `QUERY_RESULT_AVAILABLE`; result retrieval
occurs only after availability and is discarded while `GPU_DISJOINT_EXT` is
set. No `readPixels`, `finish`, or blocking query is used. Query objects are
created once and explicitly disposable. Software rasterizers do not create GPU
queries: their timings do not represent the reference GPU, and omitting them
keeps CI/Playwright software paths deterministic.

Percentiles are computed only at 4 Hz by copying into the preallocated scratch
array and sorting it in place. Normal frames only write numeric fields and one
ring entry. Renderer counters are sampled during the same 4 Hz refresh.

## Verification

Unit tests use fake canvases/contexts to prove strict-first retry attributes,
software heuristics, depth selection, stable telemetry identities, ring wrap,
split/info snapshots, and asynchronous/disjoint GPU query behavior.

The existing real-WebGL depth fixture is expanded to run forced reversed and
forced logarithmic paths for both 200 km and 1 AU scenes. A browser policy
regression launches Chromium with SwiftShader, requires the production warning
and browser instructions, acknowledges it, and checks the no-warning component
path. A browser microbenchmark measures telemetry calls over a large fixed
sample and requires average overhead below 0.1 ms/frame.
