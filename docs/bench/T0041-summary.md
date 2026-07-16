# T0041 scaffold benchmark

Measured on 2026-07-16 with Playwright Chromium headless at 1280x720, after
120 warm-up frames and across 600 sampled frames. Both runs completed with zero
page or console errors.

| Revision  | Scene                                          |   Median |      p75 |      p99 | Heap delta |
| --------- | ---------------------------------------------- | -------: | -------: | -------: | ---------: |
| `6243d0c` | T0040 single scaffold cube                     |  16.7 ms |  16.7 ms |  16.8 ms | -919,612 B |
| `1d9579d` | T0041 corrected ladder, Earth tier 3 at 400 km | 166.7 ms | 183.3 ms | 216.7 ms | +629,776 B |

The corrected head repeated at median/p75/p99 166.7/183.3/200.0 ms and
+410,352 B heap delta. The prior `cd2c18e` head measured p75 166.6 ms and
+319,392 B, while an earlier repetition measured p75 154.2 ms and -412,316 B.
The corrected software baseline is therefore retained as a measured regression,
not dismissed as noise. Endpoint heap samples remain non-monotonic across the
series and do not establish a leak; the valid frame paths use only preallocated
typed arrays/resources. The dedicated CI heap-growth gate remains authoritative
when T0092 delivers it.

The large absolute frame-time change is expected in this harness: Chromium is
software-rasterized and T0041 deliberately replaces one cube with a
32,256-triangle, textured Earth filling the viewport in LEO. The corrected head
also preallocates separate fallback/textured tier-2 meshes so lazy KTX2
readiness can crossfade without a color pop, while restoring the glTF material
to its original opaque state after the tier-3 fade. Per
`performance-spec.md` §6, absolute FPS in CI software rendering is not a
reference-hardware gate. These values are retained as the honest before/after
baseline for future GPU/reference-hardware runs; T0043 and T0092 own lighting,
telemetry, draw/triangle counters, and the adaptive 60 fps control loop.
