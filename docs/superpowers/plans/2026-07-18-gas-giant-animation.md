# Gas-Giant Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Animate the real tier-3 gas-giant mosaics with deterministic band
flow, domain-warped turbulence, Great Red Spot rotation, and governor-controlled
cost without adding textures or draw calls.

**Architecture:** One preallocated state per eligible body owns bounded phases,
seed, enable, and quality uniforms. A chained `MeshStandardMaterial` extension
remaps the existing albedo/detail UV before the normal Three.js map chunk.
`BodyVisualSystem` prepares the extension before lazy compilation, updates it
from simulation time, and forwards the existing procedural-quality rung.

**Tech Stack:** TypeScript 6, Three.js r185 WebGL2 material hooks, Vite 8,
Vitest 4, Playwright 1.61, Sharp 0.35.

## Global Constraints

- Keep `src/core/` and `src/sim/` untouched.
- Do not change `SimSnapshot`, `Commands`, `bodies.json`, its schema, or physics formulas.
- Animate only Jupiter, Saturn, Uranus, and Neptune tier-3 `mat_surface` materials.
- Preserve the existing albedo map as the identity layer and download no new texture.
- Use catalog seeds 599, 699, 799, and 899 respectively.
- Use simulation time, not wall time.
- Allocate nothing in the frame loop; mutate preallocated uniforms only.
- Precompile every material extension through the existing `compileAsync` path.
- Use one stable shader program for `full -> 4`, `half -> 2`, `minimum -> 1` octaves.
- Add no material, geometry, render target, scene node, texture, or draw call.
- Cap domain warp at 0.006 U and 0.002 V; cap shimmer at 1.5% luminance.
- Keep the static path exact when disabled.
- Capture adjacent before/after benchmark evidence for the render/frame-loop change.

---

### Task 1: Baseline and bounded gas-animation state

**Files:**
- Create: `docs/bench/T0085-before.json`
- Create: `src/render/gasGiantAnimationState.test.ts`
- Create: `src/render/gasGiantAnimationState.ts`
- Modify: `src/render/proceduralSunState.ts`

**Interfaces:**
- Produces: `ProceduralQuality = 'full' | 'half' | 'minimum'`
- Produces: `GasGiantId = 'jupiter' | 'saturn' | 'uranus' | 'neptune'`
- Produces: `GasGiantUniforms` with stable `IUniform` objects
- Produces: `GasGiantAnimationState(id, seed)` with `update`, `setQuality`, and `setEnabled`

- [x] **Step 1: Capture the untouched baseline**

Install exact dependencies and run the normal benchmark against commit
`95298f0` with the repository-default route, renderer, resolution, warm-up, and
duration. Save its raw JSON as `docs/bench/T0085-before.json` and record the
actual renderer/resolution rather than claiming unavailable reference hardware.

```powershell
npm ci
npm run bench -- --output docs/bench/T0085-before.json
```

Expected: exit 0, zero page/console errors, and `gitSha` equal to the clean
pre-feature head.

- [x] **Step 2: Write the failing state tests**

Create focused tests with these exact behavioral assertions:

```ts
const jupiter = new GasGiantAnimationState('jupiter', 599);
const phases = jupiter.uniforms.uGasBandPhases;
const storm = jupiter.uniforms.uGasStormPhase;

expect(jupiter.uniforms.uGasOctaves.value).toBe(4);
jupiter.setQuality('half');
expect(jupiter.uniforms.uGasOctaves.value).toBe(2);
jupiter.setQuality('minimum');
expect(jupiter.uniforms.uGasOctaves.value).toBe(1);
expect(jupiter.uniforms.uGasBandPhases).toBe(phases);

jupiter.update(0);
const startPhases = phases.value.toArray();
const startStorm = storm.value.toArray();
jupiter.update(9.9 * 3_600 * 4 * 5 * 6 * 7);
expect(phases.value.toArray().every(Number.isFinite)).toBe(true);
expect(phases.value.toArray().every((phase) => phase >= 0 && phase < 1)).toBe(true);
expect(storm.value.length()).toBeCloseTo(Math.SQRT2, 10);
expect(jupiter.uniforms.uGasBandPhases).toBe(phases);
expect(jupiter.uniforms.uGasStormPhase).toBe(storm);
expect(startPhases).toHaveLength(4);
expect(startStorm).toHaveLength(4);
```

Add table cases for exact ids/seeds and base hours:

```ts
expect(GAS_GIANT_CONFIG.jupiter.baseRotationHours).toBe(9.9);
expect(GAS_GIANT_CONFIG.saturn.baseRotationHours).toBe(10.7);
expect(GAS_GIANT_CONFIG.uranus.baseRotationHours).toBe(17.2);
expect(GAS_GIANT_CONFIG.neptune.baseRotationHours).toBe(16.1);
expect(GAS_GIANT_CONFIG.jupiter.spot.toArray()).toEqual([0.374, 0.64, 0.068, 0.046]);
expect(GAS_GIANT_CONFIG.saturn.spot.z).toBe(0);
```

Reject `-1`, `2 ** 32`, `1.5`, and `NaN` seeds; unknown body ids; non-finite
time; and unknown quality. Verify `setEnabled(false)` mutates the original
uniform to zero.

- [x] **Step 3: Run the state test and verify RED**

```powershell
npx vitest run src/render/gasGiantAnimationState.test.ts
```

Expected: FAIL because `gasGiantAnimationState.ts` does not exist.

- [x] **Step 4: Implement the minimal stable state**

Export the shared quality alias without breaking current Sun consumers:

```ts
export type ProceduralQuality = 'full' | 'half' | 'minimum';
export type ProceduralSunQuality = ProceduralQuality;
```

Create uniforms with no later replacement:

```ts
this.uniforms = {
  uGasEnabled: { value: 1 },
  uGasOctaves: { value: 4 },
  uGasSeed: { value: new Vector2((seed & 0xffff) / 0xffff, (seed >>> 16) / 0xffff) },
  uGasBandPhases: { value: new Vector4() },
  uGasStormPhase: { value: new Vector4(1, 0, 1, 0) },
  uGasSpot: { value: config.spot.clone() },
  uGasWarp: { value: new Vector4(0.006, 0.002, config.bandCount, config.phaseOffset) },
};
```

Use phase multipliers `[1, 0.985, 1.012, 0.975]`; write four wrapped fractions
into `uGasBandPhases`; write counterclockwise six-day spot cosine/sine and a
1,800-second shimmer cosine/sine into `uGasStormPhase`. `setQuality` maps
four/two/one and rejects all other values.

- [x] **Step 5: Verify GREEN and commit**

```powershell
npx vitest run src/render/gasGiantAnimationState.test.ts src/render/proceduralSunState.test.ts
git add docs/bench/T0085-before.json src/render/gasGiantAnimationState.ts src/render/gasGiantAnimationState.test.ts src/render/proceduralSunState.ts
git commit -m "feat(render): [T0085] add bounded gas giant state"
```

Expected: focused tests pass with stable uniform identities and the baseline is
committed unchanged.

---

### Task 2: Texture-preserving material extension

**Files:**
- Create: `src/render/gasGiantMaterial.test.ts`
- Create: `src/render/gasGiantMaterial.ts`

**Interfaces:**
- Consumes: `GasGiantUniforms`
- Produces: `prepareGasGiantMaterial(material, uniforms): PreparedGasGiantMaterial`
- Preserves: previous compile hook/cache key and the exact disabled map path

- [x] **Step 1: Write the failing shader-hook tests**

Use a mapped, named standard material and a shader fixture containing `common`
and `map_fragment`. Assert the complete contract:

```ts
const material = new MeshStandardMaterial({ map: new Texture() });
material.name = 'mat_surface';
const previousCompile = vi.fn();
material.onBeforeCompile = previousCompile;
const previousKey = material.customProgramCacheKey;
const state = new GasGiantAnimationState('jupiter', 599);
const prepared = prepareGasGiantMaterial(material, state.uniforms);

material.onBeforeCompile(shader as never, {} as WebGLRenderer);
expect(previousCompile).toHaveBeenCalledOnce();
expect(shader.uniforms.uGasBandPhases).toBe(state.uniforms.uGasBandPhases);
expect(shader.fragmentShader).toContain('gasSphericalDirection');
expect(shader.fragmentShader).toContain('if ( uGasOctaves > 1.5 )');
expect(shader.fragmentShader).toContain('if ( uGasOctaves > 3.5 )');
expect(shader.fragmentShader).toContain('0.006');
expect(shader.fragmentShader).toContain('0.002');
expect(shader.fragmentShader).toContain('#define vMapUv gasAnimatedUv');
expect(shader.fragmentShader).toContain('#undef vMapUv');
expect(shader.fragmentShader).toContain('uGasEnabled > 0.5');
expect(material.customProgramCacheKey()).toContain('solar-voyager-gas-giant-v1');

prepared.dispose();
prepared.dispose();
expect(material.onBeforeCompile).toBe(previousCompile);
expect(material.customProgramCacheKey).toBe(previousKey);
```

Add failure cases for an unmapped standard material, wrong material name, and
non-standard material. Compile twice and assert declarations/injections occur
once per resulting shader.

- [x] **Step 2: Run and verify RED**

```powershell
npx vitest run src/render/gasGiantMaterial.test.ts
```

Expected: FAIL because `gasGiantMaterial.ts` does not exist.

- [x] **Step 3: Implement deterministic GLSL injection**

Chain the previous hook, assign the stable uniforms, and inject declarations
after `#include <common>`. The GLSL must include:

```glsl
uniform float uGasEnabled;
uniform float uGasOctaves;
uniform vec2 uGasSeed;
uniform vec4 uGasBandPhases;
uniform vec4 uGasStormPhase;
uniform vec4 uGasSpot;
uniform vec4 uGasWarp;
```

Implement seeded C1 value noise and fixed-bound fBm. Convert UV to a periodic
unit direction before noise:

```glsl
vec3 gasSphericalDirection( vec2 uv ) {
  float longitude = uv.x * 6.28318530718;
  float latitude = ( uv.y - 0.5 ) * 3.14159265359;
  float cosLatitude = cos( latitude );
  return vec3( cos( longitude ) * cosLatitude, sin( latitude ), sin( longitude ) * cosLatitude );
}
```

Choose/interpolate the four wrapped band phases by absolute latitude, rotate
Jupiter's elliptical spot with `mat2(c, -s, s, c)`, then add domain warp clamped
to `uGasWarp.xy`. Wrap the map chunk exactly:

```glsl
vec2 gasAnimatedUv = vMapUv;
if ( uGasEnabled > 0.5 ) {
  gasAnimatedUv = gasAnimateUv( vMapUv );
}
#define vMapUv gasAnimatedUv
#include <map_fragment>
diffuseColor.rgb *= gasStormShimmer( gasAnimatedUv );
#undef vMapUv
```

The shimmer function must return `1.0` when disabled and otherwise remain in
`[0.985, 1.015]`. The program cache key contains only the constant extension
version, never uniform values.

- [x] **Step 4: Verify GREEN, neighboring hooks, and commit**

```powershell
npx vitest run src/render/gasGiantMaterial.test.ts src/render/surfaceDetail.test.ts src/render/proceduralSunMaterial.test.ts
git add src/render/gasGiantMaterial.ts src/render/gasGiantMaterial.test.ts
git commit -m "feat(render): [T0085] animate gas giant map sampling"
```

Expected: all focused material tests pass and no existing hook changes output.

---

### Task 3: Tier-3 lifecycle and governor integration

**Files:**
- Create: `src/render/gasGiantAnimation.test.ts`
- Create: `src/render/gasGiantAnimation.ts`
- Modify: `src/render/bodyVisualSystem.ts`
- Modify: `src/render/bodyVisualSystem.test.ts`
- Modify: `src/render/createEpochWorld.ts`
- Modify: `src/render/createEpochWorld.test.ts`
- Modify: `src/render/renderQualityController.ts`
- Modify: `src/render/renderQualityController.test.ts`
- Modify: `tests/render/visualTierFlyInPage.ts`

**Interfaces:**
- Produces: `prepareGasGiantAnimation(id, seed, material): GasGiantAnimation | null`
- Produces on `BodyVisualSystem`: `setProceduralQuality(quality)` and test control `setGasGiantAnimationEnabled(id, enabled)`
- Extends `BodyVisualDefinition` with existing `proceduralSeed: number`

- [x] **Step 1: Write facade and integration tests first**

The facade test must assert:

```ts
expect(prepareGasGiantAnimation('earth', 399, material)).toBeNull();
const animation = prepareGasGiantAnimation('jupiter', 599, material);
expect(animation).not.toBeNull();
animation?.update(3_600);
animation?.setQuality('minimum');
animation?.setEnabled(false);
expect(animation?.state.uniforms.uGasOctaves.value).toBe(1);
expect(animation?.state.uniforms.uGasEnabled.value).toBe(0);
animation?.dispose();
```

Extend the existing ringed-giant model test with a mapped `mat_surface`, seed
699, and surface detail. During `compileModel`, require both cache-key suffixes
and require gas animation to precede surface detail in the key. After an update
at `simTimeSec = 123_457`, require nonzero bounded band phases. Call
`setProceduralQuality('minimum')` and require octave 1. Add Jupiter, Uranus, and
Neptune table cases; add Earth and Mars controls that are never prepared.

Update every `BodyVisualDefinition` fixture with its exact seed. In the quality
controller test require:

```ts
expect(subject.visualSystem.setProceduralQuality).toHaveBeenCalledWith('minimum');
```

- [x] **Step 2: Run integration tests and verify RED**

```powershell
npx vitest run src/render/gasGiantAnimation.test.ts src/render/bodyVisualSystem.test.ts src/render/createEpochWorld.test.ts src/render/renderQualityController.test.ts
```

Expected: FAIL on missing facade, seed field, and quality method.

- [x] **Step 3: Implement the facade and wire model setup**

The facade owns one state and one prepared material handle:

```ts
export class GasGiantAnimation {
  readonly state: GasGiantAnimationState;
  private readonly prepared: PreparedGasGiantMaterial;

  update(simTimeSec: number): void { this.state.update(simTimeSec); }
  setQuality(quality: ProceduralQuality): void { this.state.setQuality(quality); }
  setEnabled(enabled: boolean): void { this.state.setEnabled(enabled); }
  dispose(): void { this.prepared.dispose(); }
}
```

In `prepareModel`, find a mapped standard `mat_surface`, prepare gas animation
for eligible ids before `prepareSurfaceDetail`, store it in a fixed-length array,
and only then call `compileModel`. On compilation failure dispose surface detail
first and gas animation second. In the normal update loop call
`gasAnimation.update(simTimeSec)` if present. `setProceduralQuality` loops the
preallocated array and updates existing instances only.

Pass `body.proceduralSeed` from `createEpochWorld`. Add
`setProceduralQuality(profile.proceduralQuality)` to `QualityVisualSystemPort`
and call it beside the existing Sun quality update.

- [x] **Step 4: Verify GREEN and render neighbors**

```powershell
npx vitest run src/render/gasGiantAnimation.test.ts src/render/bodyVisualSystem.test.ts src/render/createEpochWorld.test.ts src/render/renderQualityController.test.ts src/render/surfaceDetail.test.ts src/render/ringSystem.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass with compile order locked.

- [x] **Step 5: Commit the integration**

```powershell
git add src/render tests/render/visualTierFlyInPage.ts
git commit -m "feat(render): [T0085] wire gas giant animation quality"
```

---

### Task 4: Actual-WebGL acceptance and isolated quality evidence

**Files:**
- Create: `tests/render/gasGiantAnimation.html`
- Create: `tests/render/gasGiantAnimationPage.ts`
- Create: `tools/tests/gasGiantAnimationRegression.mjs`
- Create: `tools/bench/gasGiantQualityBench.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run test:gas-giants`
- Produces: `npm run bench:gas-quality`
- Produces fixture API: `renderBody`, `programSnapshot`, `networkSnapshot`, and `qualitySnapshot`

- [x] **Step 1: Write the browser regression before the fixture**

The Playwright script starts Vite, records every response URL and page/console
error, and requires WebGL hardware context. For each body it captures 512x512
RGBA buffers for static time 0, animated time 0, animated time 3,600 seconds,
and minimum-quality time 3,600 seconds after warm-up.

Use these exact acceptance bounds after masking background pixels:

- static-vs-animated structural correlation >= 0.94 for every body;
- animated t0-vs-t3600 mean absolute RGB delta >= 0.7/255 for Jupiter and
  Neptune, >= 0.35/255 for Saturn and Uranus;
- mean luminance drift between static and animated <= 2%;
- Jupiter Great Red Spot crop delta >= 1.25 times an equal-area control crop;
- program count identical after warm-up, time change, enable toggle, and all
  three quality switches;
- draw count identical between static and animated captures;
- octave snapshots exactly 4, 2, and 1;
- zero WebGL, page, and unexpected console errors;
- every requested texture URL belongs to the pre-existing manifest captured at
  baseline, with no `gas`, `flow`, `noise`, `storm`, or `animation` texture.

Run and verify RED:

```powershell
npm run test:gas-giants
```

Expected: FAIL because the fixture page does not exist.

- [x] **Step 2: Implement the deterministic fixture**

Create the real epoch world, force one eligible body into tier 3, wait for its
model load and `compileAsync`, hide unrelated overlays, and use fixed camera,
light, exposure, and body rotation per capture. The test-only controls call the
public enable/quality methods; they do not replace production shaders or maps.
Return numeric program/draw/octave values and raw canvas pixels only after two
warm-up renders.

- [x] **Step 3: Implement the full/minimum quality benchmark**

Mirror `proceduralSunQualityBench.mjs`: render the same close Jupiter camera at
full and minimum quality, discard warm-up samples, alternate run order, and
record p50/p75/p99 GPU timer values when available plus CPU frame-work fallback.
Require identical draw/program counts and minimum p75 lower than full p75 when
the GPU timer is available; otherwise record the limitation without inventing a
GPU result.

- [x] **Step 4: Run acceptance and neighboring browsers**

```powershell
npm run test:gas-giants
npm run test:visual-tiers
npm run test:surface-detail
npm run test:ring-systems
npm run test:lighting-post
npm run test:perf-governor
npm run bench:gas-quality -- --output docs/bench/T0085-quality.json
```

Expected: every regression passes with stable programs, zero errors, no new
texture URL, and one unchanged production draw per body surface.

- [x] **Step 5: Commit WebGL evidence**

```powershell
git add tests/render tools/tests tools/bench package.json .github/workflows/ci.yml docs/bench/T0085-quality.json
git commit -m "test(render): [T0085] verify gas giant animation in WebGL"
```

---

### Task 5: Performance, documentation, review, and delivery

**Files:**
- Create: `docs/bench/T0085-after.json`
- Create: `docs/bench/T0085-summary.md`
- Modify: `docs/rendering-spec.md`
- Modify: `docs/performance-spec.md`
- Modify: `tasks/T0085-gas-giant-animation.yaml`
- Modify: `docs/superpowers/plans/2026-07-18-gas-giant-animation.md`

**Interfaces:**
- Produces complete acceptance evidence and REVIEW/DONE handoff.

- [x] **Step 1: Capture adjacent after evidence**

Run the same benchmark command/configuration as Task 1 and save raw JSON:

```powershell
npm run bench -- --output docs/bench/T0085-after.json
```

Write `T0085-summary.md` with exact before/after git SHAs, renderer, resolution,
warm-up, duration, median/p75/p99 frame and frame-work time, draw calls,
triangles, programs, texture count, heap endpoints/growth, entry/total gzip, and
all errors. Explicitly state any reference-hardware limitation.

- [x] **Step 2: Document implemented constants only**

Update rendering spec section 11 with ids/seeds, base periods, UV caps, spot
mask/cycle, simulation-time behavior, hook ordering, exact fallback, and
quality mapping. Update performance spec only to name gas giants as consumers
of the already-existing procedural octave rung; do not change any budget.

- [ ] **Step 3: Run the full local gate set**

```powershell
npm test
npm run test:tools
npm run lint
npm run typecheck
npm run format:check
npm run build
npm run check:tasks
npm run check:budgets
npm run test:gas-giants
npm run test:visual-tiers
npm run test:lighting-post
npm run test:surface-detail
npm run test:ring-systems
npm run test:ring-flythrough
npm run test:procedural-sun
npm run test:renderer-policy
npm run test:perf-governor
npm run test:perf-gates
npm run test:smoke
git diff --check
```

Expected: every command exits 0; only already-documented skips remain.

- [ ] **Step 4: Request independent exact-head review**

The different reviewer verifies every acceptance criterion, GLSL/static path,
recognizable-feature preservation, Great Red Spot direction/crop evidence,
quality/program stability, no new textures/draws, zero-allocation update,
benchmarks, docs, and exact-head gates. Address all findings with a new failing
test before production fixes, then rerun affected and full gates.

- [ ] **Step 5: Move to REVIEW and publish**

Fill `handoff_notes` with exact commits, pixel metrics, program/draw counts,
network texture set, quality benchmark, normal benchmark, budgets, commands,
reviewer verdict, and hardware limitation. Flip `IN_PROGRESS -> REVIEW`, rebase
onto current `origin/main`, push `task/T0085-gas-giant-animation`, and open PR
`[T0085] Gas giant animated band shaders` with one evidence item per acceptance
criterion.

- [ ] **Step 6: Complete only after green CI**

Wait for all required checks. After independent approval and green CI, flip the
task to `DONE` in the PR, rerun CI, merge with a merge commit while retaining
the branch, fetch `origin/main`, and record the merge SHA before selecting the
next project blocker.
