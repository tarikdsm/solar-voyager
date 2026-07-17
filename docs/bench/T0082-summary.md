# T0082 close-range surface detail benchmark

Measured on 2026-07-17 with Playwright Chromium headless at native
1920x1080, after 120 warm-up frames and across 600 sampled frames. The updated
harness passes Chromium's official `--force_high_performance_gpu` switch and
rejects software renderers. Both adjacent runs selected the NVIDIA RTX 3070
Laptop GPU through ANGLE D3D11 and completed with zero page, console, or WebGL
errors.

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

Earlier diagnostic runs selected the older Intel UHD 0x9A60 despite the WebGL
high-performance hint. Repeated baseline p75 values on that adapter moved from
10.861 to 16.888 ms as the laptop heated, so cold/hot Intel samples were not
mixed into the committed pair. That Tiger Lake-class integrated GPU predates
the specified 2023+ reference and misses the 10 ms baseline without T0082. The
RTX is stronger than the reference integrated-GPU class rather than a literal
substitute; together, the passing absolute RTX result and the disclosed older
proxy bracket the available local evidence without relabeling either device.

Endpoint heap deltas were +2,668,116 bytes before and +201,028 bytes after.
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
