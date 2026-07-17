# T0084 procedural Sun evidence

Measured on 2026-07-17 with Playwright Chromium headless on an NVIDIA GeForce
RTX 3070 Laptop GPU and an Intel UHD 0x9A60 integrated GPU through ANGLE D3D11.
All hardware runs used native 1920x1080 backing buffers, rejected software
rasterizers, and completed with zero page, console, and WebGL errors.

## Adjacent production benchmark

The baseline and feature runs were adjacent, used 120 warm-up frames and 600
sampled frames, and name exact revisions.

| Revision/state           |   rAF p50/p75/p99 | Average fps |  GPU p50 |  GPU p75 |  GPU p99 | Draws | Triangles | Geometries | Programs | Textures |   Heap delta |
| ------------------------ | ----------------: | ----------: | -------: | -------: | -------: | ----: | --------: | ---------: | -------: | -------: | -----------: |
| `7c4ba83` baseline       | 16.7/16.7/16.8 ms |      60.003 | 2.399 ms | 2.545 ms | 4.585 ms |    23 |    65,091 |          8 |       35 |       24 |   +143,628 B |
| `84a3469` procedural Sun | 16.7/16.7/16.8 ms |      60.003 | 2.419 ms | 2.722 ms | 5.855 ms |    23 |    65,091 |          8 |       38 |       24 | +2,914,364 B |

The feature adds no typical-view draw, triangle, geometry, or texture cost.
Three precompiled programs cover the procedural photosphere paths and the
off-limb billboard. The paired GPU p75 delta was +0.177 ms. The absolute
2.722 ms remains 7.278 ms below the 10 ms render split. Heap values are non-monotonic
deltas because the harness does not force garbage collection; the frame update
itself only mutates existing uniform values.

The exact same adjacent pair was repeated on the older Intel integrated GPU:

| Revision/state           |  rAF p75/p99 | Average fps |   GPU p50 |   GPU p75 |   GPU p99 | Draws | Programs |   Heap delta |
| ------------------------ | -----------: | ----------: | --------: | --------: | --------: | ----: | -------: | -----------: |
| `7c4ba83` baseline       | 16.7/33.4 ms |      56.697 | 13.586 ms | 14.376 ms | 31.006 ms |    23 |       35 | +3,397,208 B |
| `84a3469` procedural Sun | 16.7/33.4 ms |      57.601 | 13.345 ms | 14.063 ms | 30.435 ms |    23 |       38 |   +137,644 B |

The Intel baseline already misses the 10 ms render split by 4.376 ms and the
60 fps floor. The feature pair is retained as a conservative delta disclosure:
it introduces no measured regression on that adapter, but neither state is
relabelled as an absolute pass.

## Close-Sun quality timing

The exact feature revision `84a3469e571dd75b65acaf851a933b6bbb6fab16` was
measured with isolated `EXT_disjoint_timer_query_webgl2` queries. Runs alternated
`full, minimum, minimum, full`; each rung retained 360 valid samples.

| Adapter          | Quality | Octaves |   GPU p50 |   GPU p75 |   GPU p99 |
| ---------------- | ------- | ------: | --------: | --------: | --------: |
| RTX 3070 Laptop  | Full    |       4 |  6.148 ms |  6.164 ms | 17.436 ms |
| RTX 3070 Laptop  | Minimum |       1 |  4.773 ms |  4.785 ms |  7.705 ms |
| Intel UHD 0x9A60 | Full    |       4 | 14.585 ms | 21.859 ms | 33.221 ms |
| Intel UHD 0x9A60 | Minimum |       1 | 11.962 ms | 15.064 ms | 23.048 ms |

Minimum quality reduced close-Sun GPU p75 by 22.37% on NVIDIA and 31.08% on
Intel. The Intel adapter is an older 2021-class proxy rather than the literal
mid-range 2023 reference and fails the absolute close-Sun render split even at
minimum quality. The RTX passes the absolute target but is stronger than the
reference class. These limitations are explicit; the cross-adapter evidence
establishes the required ordered quality reduction, not reference-hardware
certification.

## WebGL visual regression

The production-world fixture loaded the tier-3 Sun completely and retained
program counts at 10 before warm-up, 23 after warm-up, and 23 after the first
measured frame. The final metrics were:

- isolated center, inner-disc, and inside-limb luminance: 229.261, 226.669,
  and 207.495;
- post-ACES inside-limb/center ratio 0.9051 and inner-disc/center ratio 0.9887;
- 43.23% of disc samples changed over the animation interval with mean drift
  of only 0.004 on the 8-bit luminance scale;
- static-fallback changed fraction 1.0;
- horizontal/vertical repetition peaks 0.0073/0.0267;
- per-quadrant edge energy 2.608, 2.646, 2.691, and 2.712;
- 73,750 warm off-disc pixels from the bounded corona/prominences; and
- centered 16 px solar-ROI lit counts 313/52/109 at Mercury/Earth/Neptune
  distances, with peak luminance 237.79/233.94/252.93 and surrounding-annulus
  background means only 0.103/0.099/0.127.

Original-resolution review of the close, animated, fallback, Mercury, Earth,
and Neptune captures found a continuous UV-free photosphere, visible limb
darkening, stable warm corona and prominence arcs, no square billboard edge,
no repeated grid or seam, and an appropriately unresolved solar point at large
distance. The billboard's four-radius bounding sphere also restores off-screen
frustum culling, which is why the production draw count remains unchanged. Its
dispose path now removes the camera-relative binding as well as scene/GPU
resources. This regression is an explicit GitHub Actions CI step.
