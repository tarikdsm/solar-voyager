# T0043 lighting and post-processing benchmark

Measured on 2026-07-16 with Playwright Chromium headless at 1280×720, after
120 warm-up frames and across 600 sampled frames. Both runs completed with zero
page or console errors. The after capture used the complete T0043 working tree
immediately before its delivery commit; the raw harness therefore records the
preceding design commit as `gitSha` and identifies the working-tree state
explicitly.

| Revision/state     | Render path                                     |   Median |      p75 |      p99 | Heap delta |
| ------------------ | ----------------------------------------------- | -------: | -------: | -------: | ---------: |
| `c559699`          | Direct SDR render                               | 150.0 ms | 150.0 ms | 166.8 ms | +846,732 B |
| T0043 working tree | Half-float render, bloom and ACES output passes | 250.0 ms | 250.1 ms | 283.3 ms | +909,371 B |

The post chain increased median and p75 by 66.7% and p99 by 69.8% in this
software-rasterized run. This is expected to be a deliberately conservative
worst case for the two additional full-screen passes and half-float traffic;
the absolute timings are not the reference-GPU FPS gate described by
`performance-spec.md` section 6. The production bloom extraction already uses
the official half-resolution bright target, and lowering the complete scene
resolution would violate current visual-fidelity expectations. These software
numbers alone do not decide the FPS gate; the hardware run below does.

The reviewer-requested hardware run repeated the same 120+600-frame protocol
at the required 1920×1080 resolution. The harness passed
`--use-angle=default`, queried `WEBGL_debug_renderer_info`, and rejected known
software-renderer names before accepting the capture. It selected Intel UHD
Graphics through ANGLE D3D11, an integrated GPU older than the 2023+ reference
class.

| Revision/state     | GPU / resolution            | rAF p75 | GPU render p50 | GPU render p75 | GPU render p99 |
| ------------------ | --------------------------- | ------: | -------------: | -------------: | -------------: |
| `c559699`          | Intel UHD D3D11 / 1920×1080 | 16.7 ms |      10.411 ms |      11.133 ms |      12.272 ms |
| T0043 working tree | Intel UHD D3D11 / 1920×1080 | 16.7 ms |      11.706 ms |      12.071 ms |      13.260 ms |

Both paths sustained one 60 Hz refresh interval for all 600 measured frames;
the reported one-decimal 16.7 ms is the rounded 16.67 ms VSync cadence. GPU
queries attribute a 0.938 ms p75 increase to T0043. This Intel UHD 0x9A60 is an
older Tiger Lake-class integrated GPU, not the specified 2023+ reference: even
the pre-T0043 baseline exceeds the 10 ms render split on it. The result proves
the complete post chain sustains 60 Hz on a conservative device, but it does
not by itself certify the 10 ms split on the unavailable reference machine.

The main JavaScript chunk changed from 630.21 kB (163.01 kB gzip) to 658.50 kB
(169.10 kB gzip), adding the official Three.js post-processing modules. The
scene still renders once; the compositor adds bloom and output screen passes.
Endpoint heap delta differed by 62,639 bytes, but this harness does not force
collection and therefore is not a leak measurement. Lighting and post
resources are setup-owned, the application frame path creates none, and the
future T0092 mechanical heap-growth gate remains authoritative.
