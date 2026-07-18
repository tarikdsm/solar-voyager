# T0083 realistic ring systems — performance summary

## Environment and method

- Date: 2026-07-18
- GPU: NVIDIA GeForce RTX 3070 Laptop GPU, ANGLE D3D11
- Browser: stable Chrome through Playwright, hardware acceleration confirmed
- Canonical flight benchmark: 640×360 canvas, high-quality lock, 900 deterministic
  frames, two cache-priming runs, identical route and 30-second heap settle/measure windows
- Baseline head: `cd51f0f89649468333c2bdf05a284bfdb6f1f30e`
- Measured feature head: `7ed72e0a8757636f5e85c88d8ce6bdc305d5aac5`

The repository's unchanged `npm run bench` harness fixes its canvas at 640×360.
This machine has a discrete GPU, not the integrated-GPU 1080p reference class in
`performance-spec.md`; therefore these numbers are paired regression evidence, not
a claim of reference-hardware certification. The dedicated Saturn fixture below
measures the close-range particle path that the canonical LEO → Moon → Jupiter route
does not enter. GPU timer queries were unavailable, so the reports record frame and
main-thread work distributions rather than inventing GPU percentiles.

## Paired canonical flight benchmark

| Metric                  |    Before |        After |         Delta |
| ----------------------- | --------: | -----------: | ------------: |
| Frame median            |    6.1 ms |       6.1 ms |        0.0 ms |
| Frame p75               |    6.1 ms |       6.1 ms |        0.0 ms |
| Frame p99               | 11.404 ms |    12.001 ms |     +0.597 ms |
| Main-thread work median |    2.8 ms |       2.7 ms |       −0.1 ms |
| Main-thread work p75    |    3.6 ms |       3.5 ms |       −0.1 ms |
| Main-thread work p99    |  7.901 ms |       9.7 ms |     +1.799 ms |
| Maximum draw calls      |        26 |           26 |             0 |
| Maximum triangles       |    66,246 |       66,246 |             0 |
| Steady retained heap    | 104,636 B |     90,168 B |     −14,468 B |
| Route heap delta        | 830,112 B | 26,639,340 B | +25,809,228 B |
| Entry gzip              | 269,983 B |    276,761 B |      +6,778 B |
| Total gzip              | 541,310 B |    548,136 B |      +6,826 B |
| Browser/page errors     |         0 |            0 |             0 |

The 6.1 ms median/p75 cadence remains well below the 16.6 ms floor and the
canonical route adds no draw calls or triangles. The route heap increase is setup
retention from the newly lazy-loaded Jupiter hero model and KTX2 textures; it is not
per-frame growth. The post-warmup retained heap is lower in the after capture, while
the dedicated active-particle interval retains only 9,848 B after forced GC.

## Dedicated Saturn-plane evidence

`npm run test:ring-flythrough` uses the real shaders and renderer at 512×512:

- stable program count: 4;
- exactly one particle draw call when active (4 total calls, 1 particle-only);
- quality caps: 4,096 / 2,048 / 1,024 / 0 instances;
- particle-only lit pixels: 702 → 703 and centroid x: 254.949 → 255.232 over
  simulation time 0 → 0.001, proving visible orbital motion/parallax;
- symmetric plane-crossing blend:
  `0, 0.259259, 0.740741, 1, 1, 1, 0.740741, 0.259259, 0`;
- measured retained heap after forced GC: 9,848 B, below the 65,536 B gate;
- no WebGL, console, request, or page errors.

`npm run test:ring-systems` additionally loads all four production tier-3 assets.
It holds 13 programs after warmup and renders 3 calls / 20,224 triangles per scene.
Planet/ring shadow angular contrast is 2.290 (Jupiter), 2.368 (Saturn), 2.972
(Uranus), and 21.599 (Neptune); Neptune's localized arc contrast is 4.256.
