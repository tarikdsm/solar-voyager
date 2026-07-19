# T0100 startup quality and loading evidence

Measured on 2026-07-19 with the production Vite build, a fresh Playwright
Chromium context and a 1280x720 viewport. The raw report is
`T0100-startup.json`; CI runs the same permanent `npm run test:startup` contract.

The local browser used reversed depth through ANGLE/SwiftShader, so the automatic
selector correctly chose conservative rung 14. First playable was 1054.9 ms,
well below the 5000 ms contract. The same cold run transferred 1,391,293 bytes
across 17 resources and fetched exactly the four canonical runtime files in
`data/initial-path.json`; all remaining requests were production code/codec
resources covered by the build budget. The raw evidence preserves each critical
request's HTTP 200 status plus encoded and transferred bytes, without collapsing
duplicates, and records empty console/page-error arrays for the successful run.

Program count was 34 both at ready and after the first ordinary gameplay frame,
proving that eager visuals did not compile on first use. The manual-high browser
fixture selected rung 0 with a null timing sample, proving that persisted locks
bypass the automatic probe. Separately isolated manifest, Earth hero-texture,
and bootstrap-chunk failures stopped at the truthful `star-catalog`,
`asset-manifest`, and `boot` stages. Each exposed the accessible retry action,
reached ready on the second request, and produced no unhandled page error. The
expected network/decode console diagnostics are retained in the raw report.

This software-renderer timing is local/CI startup evidence, not a reference-GPU
frame-rate claim.

The final current-head hardware flight benchmark used the NVIDIA GeForce RTX
3070 Laptop GPU at 640x360 for the deterministic 900-frame LEO/Moon/Jupiter
route. It recorded 6.1 ms median/p75 frame time, 6.3 ms p99, 1.6 ms work p75,
103,952 bytes steady heap growth, at most 26 draw calls and 49,530 triangles,
with no browser errors or stability findings. This clears the 60 fps floor with
substantial headroom.

| Production gate    | T0099 baseline | T0100 final |
| ------------------ | -------------: | ----------: |
| Entry gzip         |      123,281 B |   125,568 B |
| Total JS/CSS gzip  |      569,988 B |   555,034 B |
| Draw calls         |             10 |          10 |
| Triangles          |         77,071 |      77,071 |
| 30 s retained heap |      -84,815 B |  -199,866 B |

The startup UI increases the entry slightly, while safe standalone-decoder
minification reduces total transfer by 14,954 bytes from the preceding release
head. Runtime workload remains identical and retained heap remains non-positive.
