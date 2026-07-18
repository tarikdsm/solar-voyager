# T0080 State-Vector Widget Performance Summary

**Date:** 2026-07-17/18  
**Feature head measured:** `32fa040399209880a628c2eab524b9a4b62c97f8`  
**Baseline:** `origin/main@64c93067dafbf226b0ab88f743467caf941b640a`  
**Adapter:** ANGLE D3D11, NVIDIA GeForce RTX 3070 Laptop GPU  
**Canonical bench viewport:** 640×360, high-quality lock

## Paired canonical flight benchmark

Both runs used `npm run bench` with the default 900-frame deterministic route, two cache-priming runs, the same Chrome channel, four session checkpoints, and the same 30-second settle/measurement heap windows.

| Metric                |   Baseline |      T0080 |    Delta |
| --------------------- | ---------: | ---------: | -------: |
| Frame median          |     6.1 ms |     6.1 ms |   0.0 ms |
| Frame p75             |     6.1 ms |     6.1 ms |   0.0 ms |
| Frame p99             |     6.2 ms |     6.2 ms |   0.0 ms |
| Work median           |     1.2 ms |     1.3 ms |  +0.1 ms |
| Work p75              |     1.3 ms |     1.5 ms |  +0.2 ms |
| Work p99              |     2.0 ms |     2.1 ms |  +0.1 ms |
| Stabilized heap delta |  +86,944 B |  +87,736 B |   +792 B |
| Route heap delta      | +677,868 B | +676,692 B | −1,176 B |
| Max draw calls        |         26 |         26 |        0 |
| Max triangles         |     66,246 |     66,246 |        0 |
| Entry gzip            |  257,307 B |  261,292 B | +3,985 B |
| Total gzip            |  515,284 B |  519,711 B | +4,427 B |

The canonical harness intentionally uses 640×360. That activates the scrolling responsive HUD, where the bottom-right widget is outside the visible canvas bounds and correctly receives a zero-sized clipped scissor. Consequently this route measures the frame-loop/model overhead but not the widget draw calls. Both raw reports are retained in ignored `.playwright-mcp/` worktree storage.

## Active-widget hardware measurement

The complete production application was also measured at native 1920×1080 with the widget visible and pinned to ecliptic axes. Eighty 50 ms telemetry samples were collected after startup/warmup:

- widget CPU submission p75: **0.10 ms**
- widget CPU submission p99: **0.20 ms**
- maximum sampled widget submission: **0.20 ms**
- complete scene: 34 draw calls, 65,115 triangles
- viewport: 144×144 CSS pixels
- renderer: hardware (`softwareRasterizer=false`)
- console: zero errors; one pre-existing Three.js FXAA/procedural-shader warning

This directly passes the task's `< 1 ms/frame` reference-hardware contract with 0.90 ms headroom.

## Visual/CI regression

`npm run test:state-vectors` renders the production widget class in a static 512×512 WebGL fixture with a 256×256 scissor and synthetic 30 km/s LEO-scale snapshot. On SwiftShader it reported:

- 97.80% dark backdrop pixels in the scissor
- 1,345 chromatic vector/grid pixels
- all four vectors active
- velocity input exactly 30 km/s
- p75 submission 0.20 ms (recorded only; absolute CI software timing is not a release gate)

The test gates pixels, scissor composition, snapshot consumption, and console cleanliness in CI. Unit tests separately cover the literal monotonic 30 km/s → 0.99c logarithmic velocity domain, all four dimension-specific scales, SI formatting, buffer reuse, renderer-state restoration, orientation modes, and sampled DOM signals.

`npm run test:smoke` is the authoritative production-wiring check. It opens the compiled application and gates the live LEO values (37.9 km/s, γ 1.000000, 0.0127% c), both orientation-toggle states, and the visible 144×144 scissored pixel region. `npm run test:perf-panel` additionally expands and collapses the real responsive performance panel without scrolling; the state-vector layout observer must refresh while the viewport moves, preventing stale WebGL inset coordinates.

## LEO readout interpretation

The live new-game snapshot reads about **37.9 km/s** on the current prograde LEO initial condition. This is the physically correct CM-relative ship speed: Earth's roughly 30 km/s barycentric orbital velocity plus the ship's roughly 7.7 km/s prograde orbital velocity. The acceptance wording uses “~30 km/s” to require visibility of Earth's inherited orbital motion rather than an Earth-relative 7.7 km/s readout; the production value satisfies that intent while the dedicated regression fixes the canonical display input at exactly 30 km/s.
