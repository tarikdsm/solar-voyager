# T0090 Performance HUD Verification

## Measured results

| Check                          |         Result |                Contract |
| ------------------------------ | -------------: | ----------------------: |
| Focused Chromium panel FPS     |       60.0 FPS |             1 s average |
| Independent rAF meter          |       60.0 FPS |             cross-check |
| FPS difference                 |        0.0 FPS | within 25% / 8 FPS gate |
| Panel cost, corrected isolated | 0.012 ms/frame |          < 0.2 ms/frame |
| Panel cost, concurrent matrix  | 0.056 ms/frame |          < 0.2 ms/frame |
| Full-game browser playtest     | 0.018 ms/frame |          < 0.2 ms/frame |
| Sparkline samples              |            120 |      exactly 120 frames |

The independent requestAnimationFrame counter is the same frame-boundary signal
used to cross-check the readout with the browser DevTools FPS meter, but remains
available as an automated CI assertion. The full game was also inspected in the
in-app browser after the review corrections at a 1325×837 drawing buffer: the
displayed 85.0 FPS followed the observed scene rate, the canvas contained 1,079
ink pixels, `F3` expanded the panel, UI/HUD measured 0.30 ms, and the browser
console contained no warnings or errors.

## Allocation and update evidence

- `RenderTelemetry.frameTimesMs` remains the one preallocated 120-entry
  `Float64Array`; telemetry adds only a separate preallocated 256-entry timestamp
  ring for the true one-second FPS window, not another sparkline buffer or source.
- The panel store times every invocation. Its between-sample path writes one
  cost sample but performs zero sparkline reads and preserves the same signal
  objects; the sampled and fast-path costs are averaged over actual calls.
- A setup-time canvas sink traces numeric samples directly from the telemetry
  ring, so no SVG point string is built in the frame loop. Display formatting
  remains gated to 4 Hz.
  The focused browser fixture records one `PerfPanel` render while leaf signal
  text and attributes continue updating.
- The existing 100,000-iteration telemetry regression remains the authoritative
  hot-loop benchmark until T0092 installs the repository-wide heap-growth gate.

## Visual and responsive checks

The compact row, 16.6 ms budget line, full detail expansion, GPU truncation,
settings/orbit spacing, and mobile 390 px layout were inspected in Chromium.
The final desktop expansion is 16 rem tall with no internal overflow; mobile
uses a 25 rem single-column detail layout. The production smoke now requires the
real `#perf-panel`, preventing a deterministic fixture from hiding integration
drift.
