# T0041 scaffold benchmark

Measured on 2026-07-16 with Playwright Chromium headless at 1280x720, after
120 warm-up frames and across 600 sampled frames. Both runs completed with zero
page or console errors.

| Revision  | Scene                                       |   Median |      p75 |      p99 | Heap delta |
| --------- | ------------------------------------------- | -------: | -------: | -------: | ---------: |
| `6243d0c` | T0040 single scaffold cube                  |  16.7 ms |  16.7 ms |  16.8 ms | -919,612 B |
| `cd2c18e` | T0041 J2026 catalog, Earth tier 3 at 400 km | 150.0 ms | 166.6 ms | 166.8 ms | +319,392 B |

An earlier T0041 repetition measured p75 154.2 ms and a -412,316 B heap
delta. The opposite heap-delta signs show the noise of two endpoint samples;
neither run shows a monotonic leak, and the valid frame paths use only
preallocated typed arrays/resources. The dedicated CI heap-growth gate remains
the authoritative allocation check when T0092 delivers it.

The large absolute frame-time change is expected in this harness: Chromium is
software-rasterized and T0041 deliberately replaces one cube with a
32,256-triangle, textured Earth filling the viewport in LEO. Per
`performance-spec.md` §6, absolute FPS in CI software rendering is not a
reference-hardware gate. These values are retained as the honest before/after
baseline for future GPU/reference-hardware runs; T0043 and T0092 own lighting,
telemetry, draw/triangle counters, and the adaptive 60 fps control loop.
