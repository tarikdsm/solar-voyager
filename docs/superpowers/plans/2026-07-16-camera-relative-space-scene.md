# T0040 camera-relative SpaceScene implementation plan

## 1. Lock the boundary with failing tests

- Test the 0.001 km / 1e10 km camera frustum and permanent origin.
- Test binary64 subtraction followed by the sole explicit float32 conversion at
  a 200 km Earth surface view and at one AU.
- Test recomputation rather than render-space accumulation, duplicate binding
  rejection, and stable object/matrix ownership.
- Test renderer setup requests logarithmic depth, leaving extension selection
  to T0045.

## 2. Implement the zero-allocation scene update

- Add `src/render/spaceScene.ts` with setup-time bindings and a plain indexed
  update loop.
- Keep all scratch/state objects preallocated and all Three.js objects
  `matrixAutoUpdate = false` where T0040 owns them.
- Add a source scan that makes `Math.fround` in another render module fail CI.

## 3. Integrate the scaffold runtime

- Rebuild `createPlaceholderScene` on `CameraRelativeSpaceScene` while keeping
  geometry/material creation in setup.
- Give the placeholder a binary64 heliocentric source and update it only through
  `spaceScene.ts` in the animation loop.
- Keep resize/projection updates and shader precompilation intact.

## 4. Verify and deliver

- Run focused tests, then lint, typecheck, all tests, production build, task
  schema, and asset budgets.
- Move T0040 to REVIEW, rebase on main, push, and open a PR with explicit
  acceptance evidence.
- Obtain review from a different agent, address verified findings, require green
  CI, mark DONE, and merge normally.
