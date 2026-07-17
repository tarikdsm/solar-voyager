# T0082 close-range surface detail benchmark

Measured on 2026-07-17 with Playwright Chromium headless at native
1920x1080, after 120 warm-up frames and across 600 sampled frames. Both runs
selected hardware WebGL2 through ANGLE D3D11 and completed with zero page,
console, or WebGL errors.

| Revision/state     | GPU / resolution             | rAF p75 |   GPU p50 |   GPU p75 |   GPU p99 | Draws | Triangles | Programs | Textures |
| ------------------ | ---------------------------- | ------: | --------: | --------: | --------: | ----: | --------: | -------: | -------: |
| `cae6343`          | Intel UHD 0x9A60 / 1920x1080 | 16.7 ms | 10.408 ms | 10.861 ms | 12.624 ms |    22 |    48,963 |       33 |       22 |
| T0082 working tree | Intel UHD 0x9A60 / 1920x1080 | 16.7 ms | 13.453 ms | 14.397 ms | 25.778 ms |    23 |    65,091 |       35 |       24 |

T0082 adds 3.536 ms at GPU p75 on this machine, one atmosphere draw, 16,128
reused cloud-shell triangles, two precompiled programs, and two lazy KTX2
textures. The after run's 600-frame cadence was 16.7/16.7/33.664 ms at
median/p75/p99 and averaged 52.945 fps; the before run was
16.7/16.7/16.8 ms and averaged 60.003 fps. Endpoint heap deltas were
-529,068 bytes before and +186,284 bytes after. The harness does not force a
collection, so these non-monotonic endpoints are not a leak measurement; the
frame update mutates existing uniforms and matrices only.

This Intel UHD 0x9A60 is Tiger Lake-class hardware older than the specified
mid-range 2023+ reference. The baseline itself already exceeds the 10 ms render
split, so the available machine cannot certify that absolute gate. The raw
result is retained without relabeling it as a pass: T0082 remains structurally
inside the 150-draw and 500k-triangle budgets, but a run on the specified
reference class is still required to certify the 10 ms split. The shader was
reduced from interpolated hashed value noise to a shared, seeded two-octave
vector modulation and reuses Three.js's existing tangent frame when the hero
normal map provides one.

The production-browser regression at 400 km recorded control/detail edge
energy of 0.340875/0.381034, an 11.78% increase without visible over-sharpening.
Its strongest spatial repeat peak was 0.286250 against the 0.35 rejection
threshold. The far control and enabled captures were byte-identical, the
atmosphere capture contained 61 off-disc blue limb pixels, and cloud rotation
changed without moving the surface. Program counts were 11 before warm-up, 27
after warm-up, and 27 after the first frame, proving that gameplay introduced
no shader compilation.
