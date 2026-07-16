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
resolution would violate current visual-fidelity expectations. Reference
hardware measurement remains required before treating these numbers as a 60
fps pass or failure.

The main JavaScript chunk changed from 630.21 kB (163.01 kB gzip) to 658.50 kB
(169.10 kB gzip), adding the official Three.js post-processing modules. The
scene still renders once; the compositor adds bloom and output screen passes.
Endpoint heap delta differed by 62,639 bytes, but this harness does not force
collection and therefore is not a leak measurement. Lighting and post
resources are setup-owned, the application frame path creates none, and the
future T0092 mechanical heap-growth gate remains authoritative.
