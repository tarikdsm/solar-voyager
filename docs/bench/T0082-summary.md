# T0082 close-range surface detail benchmark

Measured on 2026-07-17 with Playwright Chromium headless at native
1920x1080, after 120 warm-up frames and across 600 sampled frames. The harness
rejects software renderers and can explicitly request Chromium's high-
performance or low-power GPU. Every run completed with zero page, console, or
WebGL errors.

## High-performance GPU

| Revision/state | GPU / resolution            | rAF p75 |  GPU p50 |  GPU p75 |  GPU p99 | Draws | Triangles | Programs | Textures |
| -------------- | --------------------------- | ------: | -------: | -------: | -------: | ----: | --------: | -------: | -------: |
| `cae6343`      | RTX 3070 Laptop / 1920x1080 | 16.7 ms | 2.082 ms | 3.508 ms | 3.866 ms |    22 |    48,963 |       33 |       22 |
| `a9324e5`      | RTX 3070 Laptop / 1920x1080 | 16.7 ms | 2.479 ms | 2.544 ms | 4.767 ms |    23 |    65,091 |       35 |       24 |

The complete T0082 render path is 7.456 ms below the 10 ms GPU split at p75
and sustained exactly 60 fps over the measured window. The negative paired
p75 delta (-0.964 ms) is GPU clock/DVFS noise and is not claimed as a feature
speedup. The structural cost is one atmosphere draw, 16,128 reused cloud-shell
triangles, two precompiled programs, and two lazy KTX2 textures. These remain
far inside the 150-draw and 500k-triangle budgets.

## Conservative integrated-GPU proxy

The exact final implementation was also measured in an immediately adjacent
baseline/feature pair using Chromium's `--force_low_power_gpu` switch. Both
runs selected the Intel UHD 0x9A60 through ANGLE D3D11.

| Revision/state | GPU / resolution             | rAF p75 | Average fps |   GPU p50 |   GPU p75 |   GPU p99 | Draws | Triangles | Programs | Textures |
| -------------- | ---------------------------- | ------: | ----------: | --------: | --------: | --------: | ----: | --------: | -------: | -------: |
| `cae6343`      | Intel UHD 0x9A60 / 1920x1080 | 16.7 ms |       60.00 | 11.486 ms | 12.106 ms | 15.480 ms |    22 |    48,963 |       33 |       22 |
| `93acf4b`      | Intel UHD 0x9A60 / 1920x1080 | 16.7 ms |       56.25 | 13.876 ms | 14.641 ms | 31.380 ms |    23 |    65,091 |       35 |       24 |

T0082 adds 2.535 ms at GPU p75 on this conservative proxy. The absolute
14.641 ms misses the 10 ms render target by 4.641 ms and the sampled average
falls below the 60 fps floor because of the 31.380 ms GPU p99. This is retained
as a failure disclosure, not relabeled as a pass. The Tiger Lake-class adapter
predates the specified mid-range 2023+ reference, and its baseline already
misses the 10 ms target by 2.106 ms. The locally available RTX is stronger than
the reference class rather than a literal substitute. Together, the passing
absolute RTX run and exact older-proxy delta are the available evidence under
the design's reference-hardware fallback.

RTX endpoint heap deltas were +2,668,116 bytes before and +201,028 bytes after;
Intel endpoints were -742,144 bytes before and +113,644 bytes after.
The harness does not force collection, so these non-monotonic endpoints are not
a leak measurement. The frame update mutates existing uniforms and matrices
only. Closest-range C1 waves are evaluated per hero-mesh vertex and interpolated
for fragment use; four KTX2 samples retain the two high-frequency albedo/normal
octaves.

The production-browser regression at 400 km now measures only a circular
surface ROI. Control/detail edge energy was 0.334726/0.348858, a 4.22% increase,
and every quadrant gained at least 1.95%. Mean luminance changed by only -0.0248
on the 8-bit luminance scale after centering sRGB mid-gray in linear space.
Horizontal and vertical repeat-peak prominences were 0.0496 and 0.0054; the
strongest quadrant peak was 0.1161, below its 0.18 rejection threshold. Human
inspection at original resolution found no grid, seam, over-sharpening, or
systematic darkening.

The far control and enabled captures were byte-identical, the atmosphere
capture contained 61 off-disc blue limb pixels, and cloud rotation changed
without moving the surface. Program counts were 11 before warm-up, 27 after
warm-up, and 27 after the first frame, proving that gameplay introduced no
shader compilation.
