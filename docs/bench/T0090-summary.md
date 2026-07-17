# T0090 Performance HUD Verification

## Measured results

| Check                        |               Result |                Contract |
| ---------------------------- | -------------------: | ----------------------: |
| Focused Chromium panel FPS   |             60.0 FPS |             1 s average |
| Independent rAF meter        |             60.0 FPS |             cross-check |
| FPS difference               |              0.0 FPS | within 25% / 8 FPS gate |
| Panel cost, focused repeat 1 |       0.013 ms/frame |          < 0.2 ms/frame |
| Panel cost, focused repeat 2 |       0.027 ms/frame |          < 0.2 ms/frame |
| Panel cost, focused final    |       0.019 ms/frame |          < 0.2 ms/frame |
| Full-game browser playtest   | 0.013–0.040 ms/frame |          < 0.2 ms/frame |
| Sparkline samples            |                  120 |      exactly 120 frames |

The independent requestAnimationFrame counter is the same frame-boundary signal
used to cross-check the readout with the browser DevTools FPS meter, but remains
available as an automated CI assertion. The full game was also inspected in the
in-app browser at a 1600×900 drawing buffer: the displayed FPS followed the
observed heavy-scene rate, `F3` toggled both directions, and the browser console
contained no warnings or errors.

## Allocation and update evidence

- `RenderTelemetry.frameTimesMs` remains the one preallocated 120-entry
  `Float64Array`; T0090 adds no second per-frame sparkline buffer.
- The panel store's between-sample path returns before reading a frame or clock.
  Its unit regression spies on `getFrameTimeByAge` and proves zero sparkline
  reads/writes between 250 ms commits while preserving the same signal objects.
- SVG point-string formatting and all display formatting happen only at 4 Hz.
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
