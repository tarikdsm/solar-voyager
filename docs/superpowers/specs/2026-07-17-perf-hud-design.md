# T0090 performance HUD — design

## Goal

Add the top-left performance panel defined by `performance-spec.md` section 4.
The compact row must stay quiet during play while exposing truthful frame,
resolution, and quality data; click or `F3` reveals the diagnostic detail.

## Data flow

- `render/telemetry.ts` remains the single performance source. Its existing
  preallocated 120-frame ring is also the sparkline ring; no second per-frame
  buffer or object is introduced.
- A `PerfPanelStore` in `src/ui/hud/` receives the stable telemetry instance and
  current renderer/quality scalars from the frame orchestrator. Its per-frame
  fast path is one timestamp comparison and returns without writing signals.
- Every 250 ms the store computes display strings, the one-second FPS average,
  1% low from p99 frame time, and chronological SVG points. It commits leaf
  signals in one batch, so the application and panel components do not rerender
  as metrics change.
- The store times its sampled commit and reports amortized panel milliseconds per
  frame. The browser regression rejects a measured cost at or above 0.2 ms/frame.

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

- Unit tests cover one-second FPS, p99-derived 1% low, chronological capped SVG
  points, 4 Hz sampling, stable hot-path signals, resolution/context formatting,
  and measured cost.
- A Chromium regression mounts the production panel, compares its FPS with an
  independent requestAnimationFrame meter (the same cross-check performed with
  the DevTools FPS meter), verifies compact/expanded/F3 behavior, budget line,
  metrics, layout, errors, and the 0.2 ms/frame limit.
- Existing telemetry tests continue to prove stable typed-array storage and the
  allocation-free 120-frame append path.

