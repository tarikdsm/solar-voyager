# T0083 realistic ring systems — performance summary

## Environment and method

- Date: 2026-07-18
- GPU: NVIDIA GeForce RTX 3070 Laptop GPU, ANGLE D3D11
- Browser: stable Chrome through Playwright, hardware acceleration confirmed
- Canonical flight benchmark: 640×360 canvas, high-quality lock, 900 deterministic
  frames, two cache-priming runs, identical route and 30-second heap settle/measure windows
- Baseline head: `cd51f0f89649468333c2bdf05a284bfdb6f1f30e`
- Measured feature head: `d30916b7d9219849643a0c6c85f74ba422d98b28`

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
| Frame p99               | 11.404 ms |     6.601 ms |     −4.803 ms |
| Main-thread work median |    2.8 ms |       2.4 ms |       −0.4 ms |
| Main-thread work p75    |    3.6 ms |       2.8 ms |       −0.8 ms |
| Main-thread work p99    |  7.901 ms |     6.702 ms |     −1.199 ms |
| Maximum draw calls      |        26 |           26 |             0 |
| Maximum triangles       |    66,246 |       66,246 |             0 |
| Steady retained heap    | 104,636 B |     90,688 B |     −13,948 B |
| Route heap delta        | 830,112 B | 26,630,496 B | +25,800,384 B |
| Entry gzip              | 269,983 B |    276,989 B |      +7,006 B |
| Total gzip              | 541,310 B |    548,363 B |      +7,053 B |
| Browser/page errors     |         0 |            0 |             0 |

The 6.1 ms median/p75 cadence remains well below the 16.6 ms floor and the
canonical route adds no draw calls or triangles. The route heap increase is setup
retention from the newly lazy-loaded Jupiter hero model and KTX2 textures; it is not
per-frame growth. The post-warmup retained heap remains bounded, while the
dedicated active-particle interval retains only 8,652 B after forced GC. The
unchanged CI performance gate also passes at 58,545 B retained versus its
196,608 B ceiling, with exact 10 draw calls and 77,071 triangles.

## Dedicated Saturn-plane evidence

`npm run test:ring-flythrough` uses the real shaders and renderer at 512×512:

- four programs compiled before activation and stable through first use and warmup;
- exactly one particle draw call when active (4 total calls, 1 particle-only);
- quality caps: 4,096 / 2,048 / 1,024 / 0 instances;
- particle-only lit pixels: 701 → 703 and centroid x: 254.688 → 255.237 over
  simulation time 0 → 0.001, proving visible orbital motion/parallax;
- symmetric plane-crossing blend:
  `0, 0.259259, 0.740741, 1, 1, 1, 0.740741, 0.259259, 0`;
- measured retained heap after forced GC: 8,652 B, below the 65,536 B gate;
- no WebGL, console, request, or page errors.

`npm run test:ring-systems` additionally loads all four production tier-3 assets.
It holds 13 programs after warmup and renders 3 calls / 20,224 triangles per scene.
Neptune's Adams-window arc contrast is 1.291, while the Le Verrier control is
1.057, proving the azimuthal gain does not leak into inner bands. Saturn's
ring-shadowed planet disc measures 20.508 mean luminance versus 27.406 for the
otherwise identical no-ring-shader control (25.2% darker).

## Ring subset budgets and reproducibility

Two clean sequential Blender builds per corrected planet produced six
byte-identical files, and two clean sequential canonical ingests per corrected
planet produced 23 byte-identical files. The regenerated GLB/radial-strip
SHA-256 pairs are:

- Saturn: `747846184f73b4fa46f75082844a552ed6ac51d9c74549856fe309cb4f24b45b` /
  `adf74e0e05052b2fe470d06849e717692c8fd0150651ad996029448e15f6e1cd`;
- Uranus: `70a5f90dda485920e9551f8ec9e6f71f41778af4f390f0deedf872790f50c6de` /
  `5051c375f2feb873d16e1013eaa6a0923465a05057dcbdf816f76762fce9d063`;
- Neptune: `be9f1f3792da59f74246e24183c320343e45803be140069e8255e0febf685b48` /
  `592348c1452a467246bd0c5b07bdd180439e13cd54b2d02032223e4950de628a`.

The complete named runtime ring-texture variants are 6,655 B (Jupiter), 8,974 B
(Saturn), 10,410 B (Uranus), and 6,906 B (Neptune), each far below the 2 MiB
per-planet ring-subset limit. Particles remain procedural and add zero asset bytes.
