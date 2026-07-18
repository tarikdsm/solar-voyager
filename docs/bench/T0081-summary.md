# T0081 relativistic visuals — verification summary

## Environment

- Date: 2026-07-18
- GPU: NVIDIA GeForce RTX 3070 Laptop GPU, ANGLE D3D11
- Browser: Stable Chrome via Playwright
- Flight benchmark: 640 × 360, 900 deterministic frames
- Baseline head: `a1fa1856fd1aa563611540f02e7b61b68c6f8012`
- Final measurement head: `6fc1fc0738805e80a8c1240c4b9f9d8db2ee5c1e`

## Flight benchmark

| Metric              |  Baseline |     After | Result    |
| ------------------- | --------: | --------: | --------- |
| Frame median        |    6.1 ms |    6.1 ms | unchanged |
| Frame p75           |    6.1 ms |    6.1 ms | unchanged |
| Frame p99           |    6.3 ms |    6.3 ms | unchanged |
| Work median         |    1.7 ms |    1.5 ms | −0.2 ms   |
| Work p75            |    2.1 ms |    1.8 ms | −0.3 ms   |
| Work p99            |  4.204 ms |    3.5 ms | −0.704 ms |
| Maximum draw calls  |        26 |        26 | unchanged |
| Maximum triangles   |    66,246 |    66,246 | unchanged |
| Retained heap delta |  76,460 B |  78,176 B | +1,716 B  |
| Path heap delta     | 679,740 B | 690,588 B | +10,848 B |
| Entry gzip          | 267,797 B | 269,983 B | +2,186 B  |
| Total gzip          | 539,129 B | 541,311 B | +2,182 B  |

The first after-measurement exposed one imperceptible post pass during ordinary
orbital flight (27 maximum calls). The render now skips activation below
`1/65536`; the repeated measurement restored the exact 26-call baseline while
preserving the specified smooth directional transform.

## Browser acceptance at 0.9c

- Aberrated marker: 276.20 CSS px measured vs 276.59 CSS px analytic
  (0.39 px error; required ≤0.5 px).
- Baseline marker: 352.23 CSS px measured vs 352.31 CSS px analytic.
- Forward blue/red ratio: 1.115, up from the 1.000 baseline.
- Aft blue/red ratio: 0.444, down from the 1.000 baseline.
- Forward/aft luminance: 218.32 / 20.20.
- Gamma 1.049→1.051 normalized image delta: 0.0000212 (0.00212%; required
  <1%).
- Fixture draw calls: 2 at identity, 3 when active; exactly one added pass.
- WebGL, console, and page errors: none.

## Production performance gate

- Identity workload: 10 draw calls / 77,071 triangles.
- Production retained heap delta: −17,357 B over the measured interval.
- Bundle limits: 285,000 B entry gzip / 570,000 B total gzip.
- Final entry and total bundle sizes remain below both gates.
