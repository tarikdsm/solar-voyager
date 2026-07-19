# T0085 gas-giant animation benchmark

## Environment and method

- Before SHA: `95298f04fa6f69e3c10a82489dcd72dff32caa44`
- After SHA: `cf27949f0361d2e8afd1a5fcf799ce7287e511ec`
- Renderer: ANGLE / NVIDIA GeForce RTX 3070 Laptop GPU / Direct3D 11
- Canvas: 640 x 360, device scale factor 1
- Harness: production Vite build, two cache-prime passes, one deterministic
  900-frame/180-second route (LEO, Moon flyby, Jupiter approach), seed
  `1511506142`
- Raw reports: `T0085-before.json` and `T0085-after.json`

## Before/after result

| Metric | Before | After | Delta |
|---|---:|---:|---:|
| Frame median | 6.100 ms | 6.100 ms | 0.000 ms |
| Frame p75 | 6.100 ms | 6.100 ms | 0.000 ms |
| Frame p99 | 6.502 ms | 6.400 ms | -0.102 ms |
| Frame-work median | 2.200 ms | 2.300 ms | +0.100 ms |
| Frame-work p75 | 2.800 ms | 2.800 ms | 0.000 ms |
| Frame-work p99 | 9.000 ms | 6.603 ms | -2.397 ms |
| Steady heap before | 123,176,928 B | 123,229,575 B | +52,647 B |
| Steady heap after | 123,266,664 B | 123,319,267 B | +52,603 B |
| Steady heap growth | 89,736 B | 89,692 B | -44 B |
| Path heap delta | 26,629,296 B | 26,682,536 B | +53,240 B |
| Maximum draw calls | 26 | 26 | 0 |
| Maximum triangles | 66,246 | 66,246 | 0 |
| Entry gzip | 276,989 B | 279,446 B | +2,457 B |
| Total gzip | 548,363 B | 550,820 B | +2,457 B |

Both reports completed with an empty error list and no stability findings. The
normal-flight harness does not emit program or texture counters. The dedicated
actual-WebGL acceptance test compiled four stable programs for the four bodies,
held each production surface at one draw/16,128 triangles, issued only the 16
pre-existing catalog texture requests, and reported zero GL, request, console,
or page errors. The isolated 1920 x 1080 GPU timer benchmark used 360 samples per
rung: full-quality p75 was 0.387072 ms and minimum-quality p75 was 0.181248 ms,
a 53.17% reduction.

## Interpretation and limitation

The feature leaves normal-flight p75, draw calls, triangles, and steady heap
growth effectively unchanged; its measured bundle cost is 2,457 gzip bytes.
Absolute frame timing was collected on the available RTX 3070 laptop GPU, not
the specification's mid-range integrated reference GPU. CI therefore enforces
portable heap/bundle/draw/triangle gates, while this hardware report is valid as
the required same-machine before/after regression comparison.
