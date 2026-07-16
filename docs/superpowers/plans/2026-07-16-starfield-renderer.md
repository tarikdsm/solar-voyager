# T0042 starfield renderer implementation plan

> Execute this plan in the isolated `task/T0042-starfield` worktree. Follow TDD
> for each production change and keep all frame-loop work allocation-free.

## 1. Lock the renderer contract with failing unit tests

- Create `src/render/starfield.test.ts` with a minimal validated catalog.
- Assert one `THREE.Points`, one draw range covering every record, zero-copy
  interleaved position/magnitude/colour attributes, a `1e9 km` shader radius,
  and static matrix/frustum state.
- Assert the documented magnitude-to-size/opacity values and exact colour
  passthrough for bright, mid, and faint stars.
- Assert device-pixel-ratio uniform updates, far-plane shader behaviour,
  material depth/blending settings, and deterministic disposal.
- Run the focused test and capture the expected RED failure because
  `src/render/starfield.ts` does not exist.

## 2. Implement the setup-only `Starfield`

- Add `src/render/starfield.ts` with exported display constants and pure
  magnitude conversion helpers.
- Build one interleaved catalog buffer plus setup-only size and opacity buffers,
  one geometry, one shader material, and one points object.
- Multiply catalog directions by the sphere radius in the vertex shader, force
  far-plane depth, and render unresolved/soft resolved footprints in the
  fragment shader.
- Freeze the object transform, disable frustum culling and depth writes, expose
  only pixel-ratio configuration and disposal, then make the focused tests
  GREEN.

## 3. Integrate catalog loading into the epoch world by TDD

- Extend `src/render/createEpochWorld.test.ts` first to inject a catalog and
  expect a separate 9,096-capable points object plus the returned `starfield`.
- Extend `CreateEpochWorldOptions` with an injectable `StarCatalog`; otherwise
  load `${BASE_URL}data/stars.bin` through the existing validated loader.
- Construct the starfield before the world's single `compileAsync()` call and
  add it directly to the camera-relative scene without a physical binding.
- Pass the renderer pixel ratio at setup and retain the existing body visual
  behaviour and compile-count contract.
- Update `src/main.ts` only if renderer pixel ratio can change at runtime; do
  not add a starfield call to the frame loop.

## 4. Add deterministic browser acceptance coverage

- Add `tests/render/starfield.html` and `tests/render/starfieldPage.ts` using the
  real catalog and production `Starfield`.
- Expose a narrow test API that renders specified ecliptic directions, camera
  translations, and fields of view without changing production behaviour.
- Add `tools/tests/starfieldRegression.mjs` to project the seven pinned Orion
  record indices, require luminous neighbourhoods at each location, verify the
  Mintaka–Alnilam–Alnitak belt relation, and include a dark-location negative
  control.
- Compare framebuffer bytes before/after a large synthetic translation and
  repeat position checks at wide and narrow FOVs.
- Register `npm run test:starfield` and a target-isolated Chromium CI step.

## 5. Update specifications and measure the render delta

- Expand `docs/rendering-spec.md` section 5 with the exact magnitude mapping,
  point-spread, depth, pixel-ratio, and no-per-frame-update contracts from the
  approved design.
- Run the existing scaffold benchmark before and after the implementation under
  the same environment, recording p75 frame time, draw calls if available, and
  the software-renderer limitation explicitly.
- Record commands and observed evidence in `tasks/T0042-starfield.yaml` without
  weakening any acceptance criterion.

## 6. Verify, review, and integrate

- Run focused Vitest and browser regression, then `npm run lint`,
  `npm run typecheck`, `npm test`, `npm run build`, `npm run check:tasks`,
  `npm run check:budgets`, `npm run test:render-depth`, and
  `npm run test:visual-tiers`.
- Run `npm run format:check` and `git diff --check`; correct every in-scope
  failure before delivery.
- Move T0042 to REVIEW, push the task branch, open a normal PR, and wait for
  green remote CI.
- Obtain an independent-agent review. Resolve every Critical or Important
  finding with focused regression coverage and rerun all affected gates.
- Let the independent merger record approval, mark T0042 DONE, require final
  green CI, and merge normally into `main`.

