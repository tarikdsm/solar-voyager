# Relativistic Visual Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add quality-gated relativistic aberration, Doppler color shift, and
headlight beaming with correct star/body directions, smooth activation, and a
measured one-pass GPU cost.

**Architecture:** Apply angular aberration at the camera-relative write
boundary and in the static starfield vertex shader. Apply Doppler and beaming
once in the existing HDR composer before bloom. One controller distributes a
validated, preallocated observer state to all consumers.

**Tech Stack:** TypeScript 6, Three.js r185, GLSL/WebGL2, EffectComposer,
Vitest, Playwright, Vite.

## Global Constraints

- Follow RED -> GREEN -> REFACTOR for every production change.
- Do not change `SimSnapshot`, `Commands`, or body schemas.
- Add ADR-031 because the formulas added to `physics-spec.md` require an ADR.
- Preserve the sole float64-to-float32 boundary in `spaceScene.ts`.
- Allocate no objects, arrays, closures, materials, or targets in the frame
  loop.
- Compile the new shader during startup.
- Tiers 1-2 and direct-render/software fallback keep the feature off.
- Gamma one adds zero draw calls and follows the existing coordinate fast path.
- Active high quality adds at most one draw call and no render target.
- Record before/after `npm run bench` evidence.

---

### Task 1: Specify the observer-frame rendering model

**Files:**

- Create: `docs/decisions/ADR-031-relativistic-rendering-model.md`
- Modify: `docs/physics-spec.md`
- Modify: `docs/rendering-spec.md`

**Interfaces:**

- Physics spec defines `n_observed` and `D` for later code citations.
- Rendering spec fixes activation at `smoothstep(1, 1.05, gamma)`, quality
  tiers 3-6, RGB gains `(-0.20, 0.05, 0.35)`, and beaming clamp `[0.20, 8]`.

- [x] **Step 1: Write the ADR and exact formulas**

  Record the selected hybrid boundary/starfield/post approach, alternatives,
  consequences, and the fact that no public simulation interface changes.
  Add the equations from the approved design to physics-spec section 6.

- [x] **Step 2: Make rendering constants normative**

  Expand rendering-spec section 10 with the exact interpolation, RGB gain,
  Rec.709 normalization, `D^3` clamp, post-chain order, and low-tier behavior.

- [x] **Step 3: Verify and commit**

  Run `npx prettier --check docs/decisions/ADR-031-relativistic-rendering-model.md
  docs/physics-spec.md docs/rendering-spec.md` and `git diff --check`.
  Commit `docs(physics): [T0081] specify relativistic rendering model`.

### Task 2: Allocation-free relativistic visual state and math

**Files:**

- Create: `src/render/relativisticVisualState.ts`
- Create: `src/render/relativisticVisualState.test.ts`

**Interfaces:**

```ts
export interface RelativisticVisualState {
  betaX: number;
  betaY: number;
  betaZ: number;
  gamma: number;
  activation: number;
}

export function createRelativisticVisualState(): RelativisticVisualState;

export function writeRelativisticVisualState(
  output: RelativisticVisualState,
  snapshot: Pick<
    SimSnapshot,
    'shipCoordinateVelocityKmS' | 'gamma' | 'speedFractionOfLight'
  >,
  qualityEnabled: boolean,
): void;

export function writeAberratedPositionInto(
  output: Float64Array,
  relativeX: number,
  relativeY: number,
  relativeZ: number,
  state: Readonly<RelativisticVisualState>,
): void;
```

- [x] **Step 1: Write failing math/state tests**

  Test gamma-one and quality-off identity, beta validation below one,
  transactional rejection of inconsistent/non-finite snapshots, the analytic
  0.9c perpendicular result `(1/gamma, 0, 0.9)` at unit radius, forward/aft
  collinearity, radius preservation, and continuity at gamma 1 and 1.05.

- [x] **Step 2: Verify RED**

  Run `npx vitest run src/render/relativisticVisualState.test.ts`. Expected:
  FAIL because the module is absent.

- [x] **Step 3: Implement the minimum math owner**

  Validate all inputs before mutating `output`. Use
  `((gamma - 1) / betaSquared) * dot + gamma`, normalize only the partially
  blended direction, preserve radius, and write three existing array slots.
  Cite physics-spec section 6 above the aberration and activation formulas.

- [x] **Step 4: Verify GREEN and commit**

  Run the focused test and commit
  `feat(render): [T0081] add relativistic visual state`.

### Task 3: Aberrate camera-relative resources and star directions

**Files:**

- Modify: `src/render/spaceScene.ts`
- Modify: `src/render/spaceScene.test.ts`
- Modify: `src/render/starfield.ts`
- Modify: `src/render/starfield.test.ts`

**Interfaces:**

```ts
CameraRelativeSpaceScene.setRelativisticObserver(
  state: Readonly<RelativisticVisualState>,
): void;

Starfield.setRelativisticObserver(
  state: Readonly<RelativisticVisualState>,
): void;
```

- [x] **Step 1: Write failing boundary and starfield tests**

  Reuse one state and assert bound objects, packed points, and Line2 segments
  move to analytic 0.9c directions while source float64 arrays, attributes,
  materials, and buffers keep identity. Assert activation zero produces the
  previous exact float32 components. Assert starfield uniforms update in place
  and the shader contains the physics-spec transform before projection.

- [x] **Step 2: Verify RED**

  Run `npx vitest run src/render/spaceScene.test.ts src/render/starfield.test.ts`.
  Expected: FAIL because both setters are absent.

- [x] **Step 3: Implement the active branch**

  Add one setup-time `Float64Array(3)` scratch to `CameraRelativeSpaceScene`.
  Keep the current loops unchanged when activation is zero; in the active
  branch write aberrated relative positions before `Math.fround`. Update
  transformed bounding volumes from the same output. Add stable starfield
  uniforms and the exact GLSL direction transform.

- [x] **Step 4: Verify GREEN and commit**

  Run the focused tests plus `tests/render/float32Boundary.test.ts`. Commit
  `feat(render): [T0081] aberrate camera-relative directions`.

### Task 4: HDR Doppler and beaming post pass

**Files:**

- Create: `src/render/relativisticPostPass.ts`
- Create: `src/render/relativisticPostPass.test.ts`
- Modify: `src/render/lightingPostPipeline.ts`
- Modify: `src/render/lightingPostPipeline.test.ts`

**Interfaces:**

```ts
export interface RelativisticPostPassPort extends AdaptivePostPassPort {
  updateObserver(
    state: Readonly<RelativisticVisualState>,
    camera: PerspectiveCamera,
  ): void;
}
```

`LightingPostBackend` adds `createRelativisticPass()`. The pipeline exposes
`relativisticPass` and orders passes as render -> relativistic -> bloom -> AA
-> output.

- [ ] **Step 1: Write failing shader and pipeline tests**

  Assert stable uniforms, view-ray FOV/aspect values, camera-space beta without
  normalization, exact RGB/beaming constants, render-scale UV reuse, and
  disposal. Assert ordered composer registration, active/inactive enablement,
  resize propagation, and warm-up restoration.

- [ ] **Step 2: Verify RED**

  Run `npx vitest run src/render/relativisticPostPass.test.ts
  src/render/lightingPostPipeline.test.ts`. Expected: FAIL because the pass is
  absent.

- [ ] **Step 3: Implement one reusable ShaderPass**

  Allocate all uniforms, vectors, and shader resources in the constructor.
  Reconstruct the observed view ray, evaluate `D`, apply the specified mapping,
  and use the composer's existing half-float targets. Disable the pass when
  activation is zero.

- [ ] **Step 4: Verify GREEN and commit**

  Run focused tests and commit
  `feat(render): [T0081] add relativistic spectral post pass`.

### Task 5: Quality and frame-loop integration

**Files:**

- Create: `src/render/relativisticVisualController.ts`
- Create: `src/render/relativisticVisualController.test.ts`
- Modify: `src/render/renderQualityController.ts`
- Modify: `src/render/renderQualityController.test.ts`
- Modify: `src/main.ts`

**Interfaces:**

```ts
export interface QualityRelativisticVisualPort {
  setQualityEnabled(enabled: boolean): void;
}

export class RelativisticVisualController {
  setQualityEnabled(enabled: boolean): void;
  update(snapshot: SimSnapshot, camera: PerspectiveCamera): void;
}
```

- [ ] **Step 1: Write failing controller/quality tests**

  Assert validation happens before any consumer changes, camera-space beta is
  reused without allocation, tiers 1-2 disable and tiers 3-6 enable, duplicate
  rungs do not reapply, and post-processing unavailable always disables.

- [ ] **Step 2: Verify RED**

  Run `npx vitest run src/render/relativisticVisualController.test.ts
  src/render/renderQualityController.test.ts`. Expected: FAIL because the
  controller port is absent.

- [ ] **Step 3: Wire setup and frame order**

  Create the controller after the post pipeline, pass it to
  `RenderQualityController`, and call `update(snapshot, camera)` after camera
  matrices update but before `spaceScene.updateCameraRelative()`. Do not add
  literals, spreads, closures, or formatting to `renderFrame()`.

- [ ] **Step 4: Verify GREEN and commit**

  Run focused tests, lint, typecheck, and build. Confirm the gamma-one
  performance workload remains 10 calls / 77,071 triangles. Commit
  `feat(render): [T0081] integrate relativistic visual controller`.

### Task 6: Browser acceptance, performance, and delivery

**Files:**

- Create: `tests/render/relativisticVisuals.html`
- Create: `tests/render/relativisticVisualsPage.ts`
- Create: `tools/tests/relativisticVisualsRegression.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `tools/checks/ciWorkflow.test.mjs`
- Create: `docs/bench/T0081-summary.md`
- Modify: `tasks/T0081-relativistic-visuals.yaml`

- [ ] **Step 1: Capture unchanged-feature benchmark baseline**

  Run `npm run bench -- --output output/T0081-baseline.json` at the design head
  and record exact frame/GPU percentiles, workload, heap, and bundle figures.

- [ ] **Step 2: Write the failing browser contract**

  Add the package command before the page/script exist and prove it fails.
  The eventual script must use Stable Chrome, fail on console/page errors, and
  measure projection/color pixels at beta zero, gamma 1.049/1.051, and 0.9c.

- [ ] **Step 3: Implement deterministic acceptance metrics**

  Require analytic forward compression within 0.5 CSS px, forward blue/red
  ratio greater than baseline and aft lower than baseline, forward luminance
  greater than aft, threshold-pair normalized image delta below 1%, baseline
  workload unchanged, and active workload increase of at most one draw call.

- [ ] **Step 4: Add the regression permanently to CI**

  Add a named workflow step and a structural test proving the exact package
  command occurs once.

- [ ] **Step 5: Capture after benchmark and run full gates**

  Run benchmark, lint, typecheck, format, full Vitest, build, all browser
  regressions, Python tools, budgets, task schema, and performance gates.
  Record exact before/after evidence in `docs/bench/T0081-summary.md`.

- [ ] **Step 6: Review and deliver**

  Move T0081 to REVIEW, obtain an independent whole-branch review, fix every
  finding through RED/GREEN, push, open PR `[T0081] Relativistic visual
  effects`, require exact-head CI green, mark DONE, and merge normally.
