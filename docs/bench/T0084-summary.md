# T0084 procedural Sun evidence

Measured on 2026-07-17 with Playwright Chromium headless on the same NVIDIA
GeForce RTX 3070 Laptop GPU through ANGLE D3D11. All hardware runs used native
1920x1080 backing buffers, rejected software rasterizers, and completed with
zero page, console, and WebGL errors.

## Adjacent production benchmark

The baseline and feature runs were adjacent, used 120 warm-up frames and 600
sampled frames, and name exact revisions.

| Revision/state           |   rAF p50/p75/p99 | Average fps |  GPU p50 |  GPU p75 |  GPU p99 | Draws | Triangles | Geometries | Programs | Textures | Heap delta |
| ------------------------ | ----------------: | ----------: | -------: | -------: | -------: | ----: | --------: | ---------: | -------: | -------: | ---------: |
| `7c4ba83` baseline       | 16.7/16.7/16.8 ms |      60.003 | 2.589 ms | 3.016 ms | 5.988 ms |    23 |    65,091 |          8 |       35 |       24 | +160,464 B |
| `3f567ef` procedural Sun | 16.7/16.7/16.8 ms |      60.000 | 2.302 ms | 2.468 ms | 5.870 ms |    23 |    65,091 |          8 |       38 |       24 | +298,384 B |

The feature adds no typical-view draw, triangle, geometry, or texture cost.
Three precompiled programs cover the procedural photosphere paths and the
off-limb billboard. The paired GPU p75 delta was -0.548 ms; this is treated as
GPU clock/DVFS noise rather than a feature speedup. The absolute 2.468 ms
remains 7.532 ms below the 10 ms render split. Heap values are non-monotonic
deltas because the harness does not force garbage collection; the frame update
itself only mutates existing uniform values.

## Close-Sun quality timing

The exact feature revision `3f567efc109c9028171cb52a360ad83c7bf28aa5` was
measured with isolated `EXT_disjoint_timer_query_webgl2` queries. Runs alternated
`full, minimum, minimum, full`; each rung retained 360 valid samples.

| Quality | Octaves |  GPU p50 |  GPU p75 |  GPU p99 |
| ------- | ------: | -------: | -------: | -------: |
| Full    |       4 | 6.350 ms | 7.425 ms | 8.516 ms |
| Minimum |       1 | 6.013 ms | 6.252 ms | 6.893 ms |

Minimum quality reduced close-Sun GPU p75 by 15.81%. This laptop GPU is stronger
than the project's mid-range 2023 reference class, so the absolute result is
supporting local evidence rather than a literal reference-hardware
certification. The ordered quality reduction itself is measured on identical
hardware, resolution, view, and shader program.

## WebGL visual regression

The production-world fixture loaded the tier-3 Sun completely and retained
program counts at 10 before warm-up, 23 after warm-up, and 23 after the first
measured frame. The final metrics were:

- center, half-radius, and limb luminance: 242.849, 240.489, and 170.890;
- limb/center ratio 0.7037 and half-radius/center ratio 0.9903;
- 43.23% of disc samples changed over the animation interval with mean drift
  of only 0.004 on the 8-bit luminance scale;
- static-fallback changed fraction 1.0;
- horizontal/vertical repetition peaks 0.0073/0.0267;
- per-quadrant edge energy 2.608, 2.646, 2.691, and 2.712;
- 73,750 warm off-disc pixels from the bounded corona/prominences; and
- lit-pixel counts 948/678/740 at Mercury/Earth/Neptune distances.

Original-resolution review of the close, animated, fallback, Mercury, Earth,
and Neptune captures found a continuous UV-free photosphere, visible limb
darkening, stable warm corona and prominence arcs, no square billboard edge,
no repeated grid or seam, and an appropriately unresolved solar point at large
distance. The billboard's four-radius bounding sphere also restores off-screen
frustum culling, which is why the production draw count remains unchanged.
