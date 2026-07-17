# T0045 GPU Context and Telemetry Implementation Plan

## 1. Specify the context policy with failing tests

- Replace the old parameter-only test with strict-first context creation,
  fallback, renderer-name heuristic, and automatic/forced depth tests.
- Verify mutually exclusive reversed/logarithmic Three.js parameters and
  half-float output.

## 2. Implement and integrate renderer bootstrap

- Refactor `src/render/createRenderer.ts` around an explicit WebGL2 context.
- Return the renderer plus an immutable context report.
- Update production and depth-regression call sites.
- Add warning props/component, acknowledgement behavior, styling, and setup
  metadata for browser verification.

## 3. Specify and implement render telemetry

- Create `src/render/telemetry.test.ts` first.
- Create `src/render/telemetry.ts` with the preallocated ring, 4 Hz snapshot,
  splits, renderer.info copy, percentiles, and GPU query ring.
- Integrate begin/end instrumentation in `src/main.ts` without frame
  allocations.

## 4. Expand real-browser regressions

- Run the depth fixture in forced logarithmic, forced reversed, and sensitive
  standard-control modes.
- Add a SwiftShader warning/acknowledgement regression and no-warning fixture.
- Add the telemetry browser microbenchmark and require less than 0.1 ms/frame.
- Wire new checks into package scripts and CI.

## 5. Verify and deliver

- Record before/after production benchmark and telemetry overhead evidence.
- Run format, lint, typecheck, unit, all WebGL regressions, tools, build,
  budgets, and task schema.
- Rebase, mark REVIEW, open the T0045 PR, obtain independent review and green
  exact-head CI, mark DONE, and merge normally.
