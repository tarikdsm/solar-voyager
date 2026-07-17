# T0090 performance HUD — design

## Goal

Add the top-left performance panel defined by `performance-spec.md` section 4.
The compact row must stay quiet during play while exposing truthful frame,
resolution, and quality data; click or `F3` reveals the diagnostic detail.

## Data flow

- `render/telemetry.ts` remains the single performance source. Its existing
  preallocated 120-frame ring is also the sparkline ring. Telemetry owns one
  separate preallocated 256-entry timestamp ring so a true one-second FPS
  window remains available above 120 Hz without creating a second truth source.
- A `PerfPanelStore` in `src/ui/hud/` receives the stable telemetry instance and
  current renderer/quality scalars from the frame orchestrator. Its per-frame
  fast path measures the complete call without reading telemetry or writing
  signals between samples.
- Every 250 ms the store computes display strings, the one-second FPS average,
  and 1% low from p99 frame time. A setup-time canvas sink redraws the
  chronological telemetry ring directly with numeric Canvas 2D calls, avoiding
  point-string construction in the frame loop. Leaf signals commit in one batch,
  so the application and panel components do not rerender as metrics change.
- The store times both sampled and between-sample calls and reports their mean
  milliseconds per actual invocation. The browser regression rejects a measured
  cost at or above 0.2 ms/frame.

## Presentation and interaction

- `src/ui/hud/PerfPanel.tsx` renders a compact button row with FPS, 120-frame
  sparkline plus the 16.6 ms budget line, drawing-buffer resolution/render scale,
  and `Q6/6` initial quality badge.
- The expanded area adds 1% low, sim/render/UI/GPU splits, draw and resource
  counts, JS heap when available, GPU/context/depth identity, governor state,
  last action, and measured panel cost.
- Click and `F3` toggle the same state. `F3` is reserved from user bindings so
  input mapping cannot compete with the panel. Expanded state is UI-local and is
  intentionally not part of save data.
- The panel uses tabular monospace numerals, strict containment, low default
  contrast, and higher contrast on hover/focus. Desktop layout moves settings
  and orbit panels below the new top-left row; responsive layout keeps all
  panels in document order without horizontal overflow.

## Quality/governor boundary

T0090 reports the truthful current full-quality baseline (`Q6/6`, scale `1.00`)
and an explicit `Awaiting adaptive governor` state. T0091 will supply changing
quality scalars through the same store call without changing the panel contract.

## Verification

- Unit tests cover mixed-refresh one-second FPS, p99-derived 1% low, the canvas
  sink handoff, 4 Hz sampling, stable hot-path signals, resolution/context
  formatting, and total measured cost.
- A lightweight Chromium fixture drives the real telemetry and panel for 120
  requestAnimationFrame samples, compares its FPS with an independent meter (the
  same cross-check performed with the DevTools FPS meter), and verifies
  compact/expanded/F3 behavior (including key repeat), canvas pixels, metrics,
  layout, errors, and the
  0.2 ms/frame limit without depending on SwiftShader's full-scene throughput.
- The production application smoke requires the real `#perf-panel` anchor, so
  deterministic fixture coverage cannot hide a missing production integration.
- Existing telemetry tests continue to prove stable typed-array storage and the
  allocation-free 120-frame append path.
