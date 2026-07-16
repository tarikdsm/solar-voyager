# T0043 lighting and post-processing implementation plan

> Execute in the isolated `task/T0043-lighting-post` worktree. Every production
> change starts with a failing focused test, and no frame path may allocate.

## 1. Lock solar lighting and glare with RED tests

- Add `src/render/solarLighting.test.ts` using packed synthetic Sun/focus
  positions at 1 AU, 2 AU, and the coincident/photosphere edge.
- Assert exactly one directional light, ambient 0.02, `π × (AU/d)²`, correct
  focus-to-Sun light position, static target matrices, focus-offset validation,
  and finite retained direction at zero distance.
- Assert one static glare sprite, canonical packed-position binding, four-solar-
  diameter scale, HDR additive/depth settings, radial zero-edge alpha, and
  deterministic disposal.
- Run the focused test and capture RED while `solarLighting.ts` is absent.

## 2. Implement allocation-free lighting and integrate body materials

- Add `src/render/solarLighting.ts` with setup-only Three.js resources and an
  indexed numeric update over the caller-owned `Float64Array`.
- Replace provisional epoch-world lights with `SolarLighting`; find Sun/Earth
  offsets once while building definitions and update before scene compilation.
- Change tier-2 reflected spheres from unlit basic to Lambert materials, with
  emissive fallback treatment for the Sun.
- Guarantee loaded Sun PBR materials exceed the bloom threshold without
  altering authored Earth emissive/night-light materials.
- Extend epoch/body visual tests first, then make them GREEN.

## 3. Lock and implement the HDR post pipeline

- Add failing `src/render/lightingPostPipeline.test.ts` for ACES/exposure,
  half-float composer buffers, pass order, documented bloom constants, size and
  pixel-ratio propagation, enable/disable mutation, render delegation, warm-up,
  and disposal. Use an injectable narrow backend if needed to keep unit tests
  independent of a WebGL context.
- Add `src/render/lightingPostPipeline.ts` using official `EffectComposer`,
  `RenderPass`, `UnrealBloomPass`, and `OutputPass` addons.
- Ensure the official bloom bright target is half the effective composer
  resolution and that output tone mapping occurs only in `OutputPass`.
- Refactor startup to size the renderer before world construction, create and
  warm the pipeline before rAF, propagate later resizes, and replace direct
  `renderer.render()` with the existing composer call only.

## 4. Add real-browser acceptance coverage

- Add a dedicated fixture under `tests/render/` and Playwright driver under
  `tools/tests/` using the production world, real Earth glTF/night emissive map,
  and production post pipeline.
- Render Earth from the anti-solar 400 km view after the tier-3 model is ready;
  analyze the framebuffer/screenshot for a dark majority and localized visible
  night lights.
- Render a controlled HDR solar disc with bloom disabled and enabled; prove an
  added symmetric exterior halo, finite centre, dark corners, and no square or
  full-screen artifact.
- Assert HalfFloat buffers, half-resolution bright target, exact pass order,
  ACES, WebGL error 0, and no console/page errors.
- Register `npm run test:lighting-post` and add it to CI after Chromium install.

## 5. Update specs, benchmark, and deliver

- Expand `docs/rendering-spec.md` section 4 with exact intensity normalization,
  photosphere clamp, bloom constants, glare extent, and pass order.
- Capture paired `npm run bench:scaffold` reports from the T0043 base and head
  under identical 1280×720 software conditions; document p50/p75/p99, heap
  endpoint caveats, bundle/draw implications, and lack of reference hardware.
- Run lint, strict typecheck, Prettier, all Vitest and Python tests, production
  build, budgets, task schema, diff check, and every Chromium regression.
- Move T0043 to REVIEW with evidence, push, open `[T0043] Lighting, ACES and
  bloom`, require green CI, and obtain independent review.
- Resolve every Critical/Important finding with regression coverage. Let the
  independent merger record approval, mark DONE, require final green CI, and
  merge normally before selecting the next task.
