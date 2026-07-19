# T0100 startup quality and loading evidence

Measured on 2026-07-19 with the production Vite build, a fresh Playwright
Chromium context and a 1280x720 viewport. The raw report is
`T0100-startup.json`; CI runs the same permanent `npm run test:startup` contract.

The local browser used reversed depth through ANGLE/SwiftShader, so the automatic
selector correctly chose conservative rung 14. First playable was 1041.5 ms,
well below the 5000 ms contract. The same cold run transferred 1,391,217 bytes
across 17 resources and fetched exactly the four canonical runtime files in
`data/initial-path.json`; all remaining requests were production code/codec
resources covered by the build budget.

Program count was 34 both at ready and after the first ordinary gameplay frame,
proving that eager visuals did not compile on first use. The manual-high browser
fixture selected rung 0 with a null timing sample, proving that persisted locks
bypass the automatic probe. A separately isolated manifest failure stopped at
the truthful `star-catalog` stage, exposed the accessible retry action, and
reached ready on the second request without a page error.

This software-renderer timing is local/CI startup evidence, not a reference-GPU
frame-rate claim. Hardware 60 fps remains governed by the existing reference
bench evidence and the unchanged performance gates.
