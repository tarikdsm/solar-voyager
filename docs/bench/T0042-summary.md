# T0042 starfield benchmark

Measured on 2026-07-16 with Playwright Chromium headless at 1280×720, after
120 warm-up frames and across 600 sampled frames. Both runs completed with zero
page or console errors. The after capture used the complete T0042 working tree
immediately before its delivery commit; the raw harness therefore records the
preceding documentation commit as `gitSha` and identifies the working-tree
state explicitly.

| Revision/state     | Scene                               |   Median |      p75 |      p99 | Heap delta |
| ------------------ | ----------------------------------- | -------: | -------: | -------: | ---------: |
| `4c1e5d8`          | T0041 epoch world without starfield | 150.0 ms | 150.1 ms | 166.7 ms | -120,532 B |
| T0042 working tree | Same world plus 9,096-star draw     | 150.0 ms | 150.1 ms | 166.8 ms | +397,903 B |

The complete catalog adds one draw call but produced no measurable p75 change
in this paired software-renderer run. The 0.1 ms p99 difference is below the
16.6 ms frame-interval quantization visible in the sample. Absolute headless
times are not the reference-GPU FPS gate described by `performance-spec.md`
section 6.

Endpoint heap delta changed sign between runs and is not a leak measurement;
the browser harness does not force collection. The T0042 runtime object creates
its buffers, material, shader and derived magnitude arrays once at startup and
has no frame-update method or frame-loop call. The future T0092 mechanical heap
gate remains authoritative for the zero-growth performance contract.
