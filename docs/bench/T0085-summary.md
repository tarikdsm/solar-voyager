# T0085 gas-giant animation benchmark

## Environment and method

- Before SHA: `95298f04fa6f69e3c10a82489dcd72dff32caa44`
- After SHA: `93269220a0fcfba5e5710a776c60e04a724afabf`
- Renderer: ANGLE / NVIDIA GeForce RTX 3070 Laptop GPU / Direct3D 11
- Canvas: 640 x 360, device scale factor 1
- Harness: production Vite build, two cache-prime passes, one deterministic
  900-frame/180-second route (LEO, Moon flyby, Jupiter approach), seed
  `1511506142`
- Raw reports: `T0085-before.json` and `T0085-after.json`

## Before/after result

| Metric             |        Before |         After |     Delta |
| ------------------ | ------------: | ------------: | --------: |
| Frame median       |      6.100 ms |      6.100 ms |  0.000 ms |
| Frame p75          |      6.100 ms |      6.100 ms |  0.000 ms |
| Frame p99          |      6.502 ms |     12.100 ms | +5.598 ms |
| Frame-work median  |      2.200 ms |      1.700 ms | -0.500 ms |
| Frame-work p75     |      2.800 ms |      2.400 ms | -0.400 ms |
| Frame-work p99     |      9.000 ms |      7.503 ms | -1.497 ms |
| Steady heap before | 123,176,928 B | 123,216,706 B | +39,778 B |
| Steady heap after  | 123,266,664 B | 123,306,742 B | +40,078 B |
| Steady heap growth |      89,736 B |      90,036 B |    +300 B |
| Path heap delta    |  26,629,296 B |  26,656,980 B | +27,684 B |
| Maximum draw calls |            26 |            26 |         0 |
| Maximum triangles  |        66,246 |        66,246 |         0 |
| Entry gzip         |     276,989 B |     279,959 B |  +2,970 B |
| Total gzip         |     548,363 B |     551,332 B |  +2,969 B |

Both reports completed with an empty error list and no stability findings. The
normal-flight harness does not emit program or texture counters. The dedicated
actual-WebGL acceptance test compiled four stable programs for the four bodies,
held each production surface at one draw/16,128 triangles, issued only the 16
pre-existing catalog texture requests, and reported zero GL, request, console,
or page errors. Close-range detail blend was 0.692812 for every body. The
isolated 1920 x 1080 GPU timer benchmark used 360 samples per rung. Under
concurrent local GPU load, full/minimum p50 was 1.874944/1.368064 ms and p75 was
3.052032/3.045376 ms. Minimum remained cheaper as required, although the p75
reduction (0.22%) was noise-limited; the p50 reduction was 27.03%. The benchmark
records its measurement method and has a CPU frame-work fallback when timer
queries are unavailable.

## Interpretation and limitation

The feature leaves normal-flight p75, draw calls, triangles, and steady heap
growth effectively unchanged; its measured bundle cost is 2,969 gzip bytes.
Absolute frame timing was collected on the available RTX 3070 laptop GPU, not
the specification's mid-range integrated reference GPU. CI therefore enforces
portable heap/bundle/draw/triangle gates, while this hardware report is valid as
the required same-machine before/after regression comparison.

The Windows local production heap gate remained narrowly above its Linux-CI
calibrated 196,608-byte ceiling: T0085 samples were 207,036 B, 199,444 B, and
203,060 B. An immediate same-machine `main` A/B without T0085 also failed at
198,392 B. The ceiling was not changed; this baseline-reproduced local variance
must be arbitrated by the required Linux CI run before merge.
