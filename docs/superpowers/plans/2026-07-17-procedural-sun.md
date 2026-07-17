# Procedural Sun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static primary Sun rendering with a deterministic,
simulation-time-animated photosphere, corona, and prominence path while keeping
the authored material as a fallback and preserving the 60 fps contract.

**Architecture:** A small `ProceduralSunState` owns bounded time, seed, enable,
and quality uniforms. A material extension consumes that state for tier-2 and
tier-3 discs, while a `ProceduralSun` facade owns one camera-facing billboard
for the corona and prominences. `createEpochWorld` wires the shared controller
to `BodyVisualSystem`; `main.ts` advances it from `SimSnapshot.simTimeSec`.

**Tech Stack:** TypeScript 6, Three.js r185 WebGL2 shader hooks, Vite 8,
Vitest 4, Playwright 1.61, Sharp 0.35.

## Global Constraints

- Keep `src/core/` and `src/sim/` untouched; all work is in render/test/tool/docs layers.
- Do not change `SimSnapshot`, `Commands`, `bodies.json`, or physics formulas.
- Use the existing `visual.proceduralSeed` value `10` for the Sun.
- Use simulation time, not wall time, for solar animation.
- Allocate nothing in the frame loop; mutate existing uniforms only.
- Create and precompile all materials, geometry, and shader variants before gameplay.
- One fixed shader program serves all quality rungs; no runtime material or program creation.
- Quality rungs map `full -> 4`, `half -> 2`, `minimum -> 1` octaves.
- The procedural billboard replaces the existing glare sprite and must not add a draw relative to main.
- Run a native 1920x1080 adjacent before/after benchmark for every render/frame-loop change.

---

### Task 1: Bounded procedural state and quality rungs

**Files:**
- Create: `src/render/proceduralSunState.test.ts`
- Create: `src/render/proceduralSunState.ts`

**Interfaces:**
- Produces: `ProceduralSunQuality = 'full' | 'half' | 'minimum'`
- Produces: `ProceduralSunUniforms` with shared `IUniform` objects
- Produces: `ProceduralSunState(seed)` with `update`, `setQuality`, and `setEnabled`
- Consumes later: material and billboard shaders retain the exact uniform objects

- [ ] **Step 1: Write the failing state tests**

Create tests that express the public contract before the module exists:

```ts
import { describe, expect, it } from 'vitest';

import { ProceduralSunState } from './proceduralSunState.js';

describe('ProceduralSunState', () => {
  it('maps every fixed quality rung without replacing uniform objects', () => {
    const state = new ProceduralSunState(10);
    const octaveUniform = state.uniforms.uSunOctaves;

    expect(octaveUniform.value).toBe(4);
    state.setQuality('half');
    expect(state.uniforms.uSunOctaves).toBe(octaveUniform);
    expect(octaveUniform.value).toBe(2);
    state.setQuality('minimum');
    expect(octaveUniform.value).toBe(1);
  });

  it('keeps periodic phases bounded and stable over the complete cycle', () => {
    const state = new ProceduralSunState(10);
    const phaseUniform = state.uniforms.uSunTimePhases;
    state.update(0);
    const start = phaseUniform.value.toArray();
    state.update(21_600);

    expect(state.uniforms.uSunTimePhases).toBe(phaseUniform);
    expect(phaseUniform.value.toArray()).toEqual(start);
    expect(phaseUniform.value.length()).toBeCloseTo(Math.SQRT2, 12);
  });

  it.each([-1, 2 ** 32, 1.5, Number.NaN])('rejects invalid uint32 seed %s', (seed) => {
    expect(() => new ProceduralSunState(seed)).toThrow(RangeError);
  });

  it('rejects non-finite simulation time and unknown quality', () => {
    const state = new ProceduralSunState(10);
    expect(() => state.update(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => state.setQuality('ultra' as never)).toThrow(RangeError);
  });

  it('toggles the shared enable scalar in place', () => {
    const state = new ProceduralSunState(10);
    const enabled = state.uniforms.uSunEnabled;
    state.setEnabled(false);
    expect(state.uniforms.uSunEnabled).toBe(enabled);
    expect(enabled.value).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npx vitest run src/render/proceduralSunState.test.ts
```

Expected: FAIL because `proceduralSunState.ts` does not exist.

- [ ] **Step 3: Implement the minimal preallocated state**

Create the state with exact cycles and uniform identity:

```ts
import { Vector2, Vector4, type IUniform } from 'three';

export type ProceduralSunQuality = 'full' | 'half' | 'minimum';

export interface ProceduralSunUniforms extends Record<string, IUniform> {
  readonly uSunEnabled: IUniform<number>;
  readonly uSunOctaves: IUniform<number>;
  readonly uSunSeed: IUniform<Vector2>;
  readonly uSunTimePhases: IUniform<Vector4>;
}

const TWO_PI = Math.PI * 2;
const COMPLETE_CYCLE_SEC = 21_600;
const GRANULATION_CYCLE_SEC = 600;

function periodicAngle(timeSec: number, periodSec: number): number {
  const wrapped = ((timeSec % periodSec) + periodSec) % periodSec;
  return (wrapped / periodSec) * TWO_PI;
}

export class ProceduralSunState {
  readonly uniforms: ProceduralSunUniforms;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError('Procedural Sun seed must be a uint32.');
    }
    this.uniforms = {
      uSunEnabled: { value: 1 },
      uSunOctaves: { value: 4 },
      uSunSeed: { value: new Vector2((seed & 0xffff) / 0xffff, (seed >>> 16) / 0xffff) },
      uSunTimePhases: { value: new Vector4(1, 0, 1, 0) },
    };
  }

  update(simTimeSec: number): void {
    if (!Number.isFinite(simTimeSec)) throw new RangeError('Sun simulation time must be finite.');
    const granulation = periodicAngle(simTimeSec, GRANULATION_CYCLE_SEC);
    const activity = periodicAngle(simTimeSec, COMPLETE_CYCLE_SEC);
    this.uniforms.uSunTimePhases.value.set(
      Math.cos(granulation),
      Math.sin(granulation),
      Math.cos(activity),
      Math.sin(activity),
    );
  }

  setQuality(quality: ProceduralSunQuality): void {
    const octaves = quality === 'full' ? 4 : quality === 'half' ? 2 : quality === 'minimum' ? 1 : 0;
    if (octaves === 0) throw new RangeError('Unknown procedural Sun quality.');
    this.uniforms.uSunOctaves.value = octaves;
  }

  setEnabled(enabled: boolean): void {
    this.uniforms.uSunEnabled.value = enabled ? 1 : 0;
  }
}
```

- [ ] **Step 4: Run focused tests and refactor only while green**

Run: `npx vitest run src/render/proceduralSunState.test.ts`

Expected: 5 tests PASS with no warnings.

- [ ] **Step 5: Commit the state unit**

```powershell
git add src/render/proceduralSunState.ts src/render/proceduralSunState.test.ts
git commit -m "feat(render): [T0084] add bounded Sun animation state"
```

---

### Task 2: Seam-free HDR photosphere material extension

**Files:**
- Create: `src/render/proceduralSunMaterial.test.ts`
- Create: `src/render/proceduralSunMaterial.ts`

**Interfaces:**
- Consumes: `ProceduralSunUniforms`
- Produces: `prepareProceduralSunMaterial(material, uniforms): PreparedProceduralSunMaterial`
- Supports: `MeshLambertMaterial` and `MeshStandardMaterial`
- Preserves: previous compile hook and cache-key function

- [ ] **Step 1: Write failing shader-hook tests**

Use a shader fixture containing `common`, `begin_vertex`, and
`opaque_fragment`. Assert the extension is present once and uses the approved
contracts:

```ts
const prepared = prepareProceduralSunMaterial(material, state.uniforms);
material.onBeforeCompile(shader as never, {} as WebGLRenderer);

expect(previousCompile).toHaveBeenCalledOnce();
expect(shader.uniforms.uSunTimePhases).toBe(state.uniforms.uSunTimePhases);
expect(shader.vertexShader).toContain('vSunObjectDirection = normalize( position )');
expect(shader.fragmentShader).toContain('sunDomainWarpedFbm');
expect(shader.fragmentShader).toContain('if ( uSunOctaves > 1.5 )');
expect(shader.fragmentShader).toContain('if ( uSunOctaves > 3.5 )');
expect(shader.fragmentShader).toContain('1.0 - 0.52 * sunOneMinusMu');
expect(shader.fragmentShader).toContain('if ( uSunEnabled > 0.5 )');
expect(shader.fragmentShader).toContain('outgoingLight = sunHdrColor');
expect(shader.fragmentShader).not.toContain('vSunUv');
expect(material.customProgramCacheKey()).toContain('solar-voyager-procedural-sun-v1');
prepared.dispose();
expect(material.onBeforeCompile).toBe(previousCompile);
```

Add cases for Standard material support, unsupported material rejection, and
idempotent disposal.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/render/proceduralSunMaterial.test.ts`

Expected: FAIL because the material module does not exist.

- [ ] **Step 3: Implement the vertex and fragment extension**

Implement a stable hook that assigns the shared uniform objects and injects:

```glsl
varying vec3 vSunObjectDirection;
varying vec3 vSunViewNormal;
varying vec3 vSunViewPosition;
uniform float uSunEnabled;
uniform float uSunOctaves;
uniform vec2 uSunSeed;
uniform vec4 uSunTimePhases;
```

After `begin_vertex`, assign without UVs:

```glsl
vSunObjectDirection = normalize( position );
vSunViewNormal = normalize( normalMatrix * normal );
vSunViewPosition = -( modelViewMatrix * vec4( transformed, 1.0 ) ).xyz;
```

Use seeded 3D C1 value noise and fixed uniform branches:

```glsl
float sunFbm( vec3 position ) {
  float value = sunValueNoise( position ) * 0.5333333;
  if ( uSunOctaves > 1.5 ) value += sunValueNoise( position * 2.03 + 17.0 ) * 0.2666667;
  if ( uSunOctaves > 2.5 ) value += sunValueNoise( position * 4.11 + 41.0 ) * 0.1333333;
  if ( uSunOctaves > 3.5 ) value += sunValueNoise( position * 8.23 + 73.0 ) * 0.0666667;
  return value;
}

float sunDomainWarpedFbm( vec3 direction ) {
  vec3 motion = vec3( uSunTimePhases.xy, uSunTimePhases.z ) * 0.35;
  float warp = sunFbm( direction * 32.0 + motion );
  return sunFbm( direction * 256.0 + vec3( warp * 3.0 ) - motion.yzx );
}
```

Immediately before `opaque_fragment`, branch to preserve the fallback and emit
the approved limb profile:

```glsl
if ( uSunEnabled > 0.5 ) {
  float sunGranulation = sunDomainWarpedFbm( normalize( vSunObjectDirection ) );
  float sunMu = clamp(
    dot( normalize( vSunViewNormal ), normalize( vSunViewPosition ) ),
    0.0,
    1.0
  );
  float sunOneMinusMu = 1.0 - sunMu;
  float sunLimb = 1.0 - 0.52 * sunOneMinusMu -
    0.16 * sunOneMinusMu * sunOneMinusMu;
  float sunContrast = mix( 0.88, 1.12, smoothstep( 0.30, 0.70, sunGranulation ) );
  sunContrast = mix( 1.0, sunContrast, smoothstep( 0.0, 0.35, sunMu ) );
  vec3 sunLane = vec3( 4.8, 2.0, 0.55 );
  vec3 sunCell = vec3( 7.2, 4.5, 1.8 );
  vec3 sunHdrColor = mix( sunLane, sunCell, sunGranulation ) * sunLimb * sunContrast;
  outgoingLight = sunHdrColor;
}
```

Chain the prior hook/cache key and restore both on idempotent disposal only if
they still point at this extension.

- [ ] **Step 4: Run material and existing surface-hook tests**

Run:

```powershell
npx vitest run src/render/proceduralSunMaterial.test.ts src/render/surfaceDetail.test.ts
```

Expected: both files PASS and the existing surface hook remains unchanged.

- [ ] **Step 5: Commit the material unit**

```powershell
git add src/render/proceduralSunMaterial.ts src/render/proceduralSunMaterial.test.ts
git commit -m "feat(render): [T0084] shade procedural photosphere"
```

---

### Task 3: One-draw procedural corona and prominence controller

**Files:**
- Create: `src/render/proceduralSun.test.ts`
- Create: `src/render/proceduralSun.ts`

**Interfaces:**
- Consumes: `CameraRelativeSpaceScene`, packed Sun position, radius, seed
- Consumes: `prepareProceduralSunMaterial`
- Produces: `ProceduralSun` facade and `ProceduralSunMaterialPort`
- Produces: one public `billboard` mesh named `sun-glare`

- [ ] **Step 1: Write failing controller/resource tests**

Construct the controller with a one-body packed array and assert:

```ts
const scene = new CameraRelativeSpaceScene();
const positionsKm = new Float64Array([10, 20, 30]);
const sun = new ProceduralSun(scene, positionsKm, 0, 695_700, 10);

expect(sun.billboard.name).toBe('sun-glare');
expect(sun.billboard.material).toBeInstanceOf(ShaderMaterial);
expect(sun.billboard.material.blending).toBe(AdditiveBlending);
expect(sun.billboard.material.depthTest).toBe(true);
expect(sun.billboard.material.depthWrite).toBe(false);
expect(sun.billboard.material.fragmentShader).toContain('sunProminenceArc');
expect(sun.billboard.material.fragmentShader).toContain('sunCorona');
expect(scene.scene.getObjectByName('sun-glare')).toBe(sun.billboard);
```

Verify `update`, `setQuality`, and `setEnabled` mutate the same uniforms used by
the billboard and a prepared Lambert material. Spy on geometry/material
`dispose` and verify one call after two controller disposals. Add invalid packed
offset/radius tests.

- [ ] **Step 2: Run the controller test and verify RED**

Run: `npx vitest run src/render/proceduralSun.test.ts`

Expected: FAIL because `proceduralSun.ts` does not exist.

- [ ] **Step 3: Implement the facade and setup-time billboard**

Create one `PlaneGeometry(1, 1)` and one `ShaderMaterial` with shared state
uniforms plus `uSunBillboardDiameterKm = solarRadiusKm * 8`. The camera-facing
vertex shader must use view-space expansion:

```glsl
varying vec2 vSunBillboardUv;
uniform float uSunBillboardDiameterKm;

void main() {
  vSunBillboardUv = uv;
  vec4 sunCenterView = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
  sunCenterView.xy += position.xy * uSunBillboardDiameterKm;
  gl_Position = projectionMatrix * sunCenterView;
}
```

The fragment shader maps the quad to `[-4R, +4R]`, emits a soft radial corona,
and evaluates exactly three deterministic SDF arcs:

```glsl
float sunProminenceArc( vec2 point, float angle, float height, float width ) {
  mat2 rotation = mat2( cos( angle ), -sin( angle ), sin( angle ), cos( angle ) );
  vec2 local = rotation * point;
  vec2 center = vec2( 0.0, 1.0 + height * 0.45 );
  vec2 scaled = ( local - center ) / vec2( 0.45 + height * 0.25, height );
  float ring = abs( length( scaled ) - 1.0 );
  return 1.0 - smoothstep( width, width * 2.0, ring );
}
```

Mask arcs to `radius > 1.0 && radius < 1.55`, gate them with smooth periodic
activity derived from `uSunTimePhases.zw`, and combine with the corona in warm
linear HDR. Set additive blending, transparency, depth test on, depth write off,
frustum culling off, and no matrix auto-update beyond packed-scene ownership.

- [ ] **Step 4: Run all three procedural-Sun unit files**

Run:

```powershell
npx vitest run src/render/proceduralSunState.test.ts src/render/proceduralSunMaterial.test.ts src/render/proceduralSun.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the billboard/controller unit**

```powershell
git add src/render/proceduralSun.ts src/render/proceduralSun.test.ts
git commit -m "feat(render): [T0084] animate Sun corona and prominences"
```

---

### Task 4: Production world, tier, and simulation-time integration

**Files:**
- Modify: `src/render/bodyVisualSystem.test.ts`
- Modify: `src/render/bodyVisualSystem.ts`
- Modify: `src/render/createEpochWorld.test.ts`
- Modify: `src/render/createEpochWorld.ts`
- Modify: `src/render/solarLighting.test.ts`
- Modify: `src/render/solarLighting.ts`
- Modify: `src/main.ts`

**Interfaces:**
- `BodyVisualSystem` consumes required `ProceduralSunMaterialPort`
- `EpochWorld` produces `readonly proceduralSun: ProceduralSun`
- `SolarLighting` no longer owns a glare sprite
- `main.ts` calls `proceduralSun.update(snapshot.simTimeSec)` once per frame

- [ ] **Step 1: Write failing integration tests**

In `bodyVisualSystem.test.ts`, provide a port with a `prepareMaterial` spy and
assert both tier-2 Sun materials are prepared during construction. Load a Sun
model with one Standard material and assert the third call occurs before the
compile callback:

```ts
const prepareMaterial = vi.fn();
const compileModel = vi.fn(async () => {
  expect(prepareMaterial).toHaveBeenCalledTimes(3);
});
```

In `createEpochWorld.test.ts`, assert the returned controller uses seed `10`,
owns `sun-glare`, and has been present during the initial `compileAsync` call.
In `solarLighting.test.ts`, change the structural expectation from a sprite to
lights only. The production browser animation test in Task 5 exercises the
`snapshot.simTimeSec` frame wiring end to end.

- [ ] **Step 2: Run the integration tests and verify RED**

Run:

```powershell
npx vitest run src/render/bodyVisualSystem.test.ts src/render/createEpochWorld.test.ts src/render/solarLighting.test.ts
```

Expected: FAIL on the missing constructor port/controller and obsolete glare
ownership.

- [ ] **Step 3: Wire materials, world state, and frame time**

Import the required port produced by `proceduralSun.ts` and add it to the
`BodyVisualSystem` constructor:

```ts
private readonly proceduralSun: ProceduralSunMaterialPort
```

Prepare the two Sun sphere materials immediately after construction. In
`prepareModel`, call the port for each Sun material before `compileModel`.

In `createEpochWorld`, capture the catalog seed while building definitions:

```ts
let sunProceduralSeed = -1;
// inside the Sun branch
sunProceduralSeed = body.visual.proceduralSeed;
```

Construct `ProceduralSun` before `BodyVisualSystem`, pass it as the material
port, and expose it through `EpochWorld`. Remove the old glare creation and
disposal from `SolarLighting`.

In `renderFrame`, update after stepping the simulation and before rendering:

```ts
proceduralSun.update(snapshot.simTimeSec);
```

Destructure the controller from `world`; do not pass a new object through the
frame path.

- [ ] **Step 4: Run focused and complete unit suites**

Run:

```powershell
npx vitest run src/render/proceduralSunState.test.ts src/render/proceduralSunMaterial.test.ts src/render/proceduralSun.test.ts src/render/bodyVisualSystem.test.ts src/render/createEpochWorld.test.ts src/render/solarLighting.test.ts
npm test
```

Expected: focused tests and the full Vitest suite PASS.

- [ ] **Step 5: Commit production integration**

```powershell
git add src/render/bodyVisualSystem.ts src/render/bodyVisualSystem.test.ts src/render/createEpochWorld.ts src/render/createEpochWorld.test.ts src/render/solarLighting.ts src/render/solarLighting.test.ts src/main.ts
git commit -m "feat(render): [T0084] integrate procedural Sun"
```

---

### Task 5: Production WebGL regression and screenshot set

**Files:**
- Create: `tests/render/proceduralSun.html`
- Create: `tests/render/proceduralSunPage.ts`
- Create: `tools/tests/proceduralSunRegression.mjs`
- Modify: `package.json`

**Interfaces:**
- Page exposes `globalThis.__proceduralSunHarness`
- Harness supports `renderAtDistance(distanceKm, simTimeSec, quality, enabled)`
- Regression writes optional original-resolution screenshots under `output/T0084/`
- Package script: `test:procedural-sun`

- [ ] **Step 1: Write the failing browser regression assertions**

Create the Node regression first. It must build/serve the production fixture,
reject console/page/WebGL errors, and assert these metric bands:

```js
assert.ok(limbCenterRatio >= 0.25 && limbCenterRatio <= 0.45);
assert.ok(halfRadiusCenterRatio >= 0.60 && halfRadiusCenterRatio <= 0.80);
assert.ok(animatedChangedFraction >= 0.03);
assert.ok(Math.abs(animatedMeanDelta) <= closeMeanLuminance * 0.02);
assert.ok(horizontalRepeatPeak < 0.18);
assert.ok(verticalRepeatPeak < 0.18);
assert.ok(Math.min(...quadrantEdgeEnergy) >= 0.02);
assert.ok(offDiscWarmPixels >= 24);
assert.ok(mercuryLitPixels >= 64);
assert.ok(earthLitPixels >= 8);
assert.ok(neptuneLitPixels >= 1);
assert.equal(programs.afterFirstFrame, programs.afterWarmUp);
assert.equal(programs.glError, 0);
```

Use a circular disc ROI, radial bins, horizontal and vertical normalized
autocorrelation prominence, quadrant-local edge energy, and an off-disc warm
pixel mask. Save `close-0.png`, `close-animated.png`, `mercury.png`, `earth.png`,
and `neptune.png` when `--output-dir` is provided.

- [ ] **Step 2: Run the script and verify RED**

Run: `node tools/tests/proceduralSunRegression.mjs`

Expected: FAIL because the fixture page/harness does not exist.

- [ ] **Step 3: Implement the production fixture**

Follow `lightingPostPage.ts`: create the real renderer, epoch world, and post
pipeline. The harness method must update the existing camera/controller,
procedural state, body tiers, camera-relative scene, and post pipeline without
creating render resources per call. It must expose:

```ts
interface ProceduralSunHarness {
  setQuality(quality: ProceduralSunQuality): void;
  setEnabled(enabled: boolean): void;
  renderAtDistance(distanceKm: number, simTimeSec: number): Promise<SunSnapshot>;
  rendererInfo(): { programs: number; glError: number };
}
```

Use distances `8 * solarRadiusKm`, Mercury's current Sun distance, `AU_KM`, and
`30 * AU_KM`. Wait for tier-3 readiness only for the close capture. Warm the
full scene before recording program counts.

- [ ] **Step 4: Tune constants only from metrics plus original images**

Run:

```powershell
npm run test:procedural-sun -- --output-dir output/T0084
```

Inspect every PNG at original resolution. Adjust only shader colour, contrast,
frequency, corona falloff, prominence width/activity, or the declared metric
bands when a reference image and a measured false positive agree. Do not add
textures, runtime geometry, or unbounded shader work.

- [ ] **Step 5: Run neighboring browser regressions**

Run:

```powershell
npm run test:procedural-sun
npm run test:lighting-post
npm run test:visual-tiers
npm run test:camera-controls
```

Expected: all four PASS with zero page, console, and WebGL errors.

- [ ] **Step 6: Commit the production regression**

```powershell
git add package.json tests/render/proceduralSun.html tests/render/proceduralSunPage.ts tools/tests/proceduralSunRegression.mjs
git commit -m "test(render): [T0084] verify procedural Sun visuals"
```

---

### Task 6: Quality GPU measurement and exact production benchmark

**Files:**
- Modify: `tests/render/proceduralSunPage.ts`
- Create: `tools/bench/proceduralSunQualityBench.test.mjs`
- Create: `tools/bench/proceduralSunQualityBenchUtils.mjs`
- Create: `tools/bench/proceduralSunQualityBench.mjs`
- Modify: `package.json`
- Create: `docs/bench/T0084-quality.json`
- Create: `docs/bench/T0084-before.json`
- Create: `docs/bench/T0084-after.json`
- Create: `docs/bench/T0084-summary.md`
- Modify: `docs/rendering-spec.md`

**Interfaces:**
- Page harness produces full/minimum GPU query samples for the same close view
- Package script: `bench:sun-quality`
- Raw JSON retains adapter, resolution, sample count, percentiles, and SHA
- Rendering spec records only implemented constants and contracts

- [ ] **Step 1: Add failing deterministic quality-benchmark utility tests**

Test the alternating run order and summary comparison before their helper
exists:

```js
expect(qualityRunOrder()).toEqual(['full', 'minimum', 'minimum', 'full']);
expect(summarizeQualitySamples({
  full: [2, 4, 6, 8],
  minimum: [1, 2, 3, 4],
})).toMatchObject({
  full: { sampleCount: 4, p75Ms: 6.5 },
  minimum: { sampleCount: 4, p75Ms: 3.25 },
  minimumCheaper: true,
});
```

Run `npx vitest run tools/bench/proceduralSunQualityBench.test.mjs` and confirm
RED because the utility module does not exist.

- [ ] **Step 2: Implement utilities and isolated sequential GPU queries**

Implement the tested order/percentile summary helpers. In the fixture, add a
hardware-only method that uses `EXT_disjoint_timer_query_webgl2`. Warm each
quality for 60 frames, then issue one query per rendered frame and poll
completed queries without nesting. Reject disjoint samples. Measure 180 valid
samples per rung in `full, minimum, minimum, full` order and combine matching
sets to limit clock-order bias. Return p50/p75/p99 milliseconds.

The Node benchmark launches Chromium with the existing hardware-selection
flags, rejects SwiftShader/llvmpipe/software renderer strings, calls the page
method, asserts equal sample counts of at least 360 and
`minimum.p75Ms < full.p75Ms`, then writes adapter, resolution, timestamp, SHA,
raw samples, and summary JSON. The regular `test:procedural-sun` command does
not require GPU timers and remains CI-safe.

- [ ] **Step 3: Run and record the quality comparison**

Run:

```powershell
npm run bench:sun-quality -- --output docs/bench/T0084-quality.json --viewport-width 1920 --viewport-height 1080 --require-hardware-gpu
```

Keep a failed absolute or quality-delta result if the adapter is below the
specified reference class; do not relabel it.

- [ ] **Step 4: Record adjacent main/feature production runs**

Commit all executable code first so the after JSON names an exact SHA. Run the
updated scaffold harness against `origin/main` and the feature worktree with
identical `--viewport-width 1920 --viewport-height 1080
--require-hardware-gpu` flags. Run the baseline immediately before the feature.
Store them as `T0084-before.json` and `T0084-after.json`.

- [ ] **Step 5: Document evidence and implemented rendering contract**

Write `T0084-summary.md` with:

- exact before/after SHAs and GPU names;
- rAF and GPU p50/p75/p99, average FPS, heap endpoints, errors;
- draw/triangle/program/texture deltas;
- full/minimum close-Sun p75 and percentage reduction;
- radial/animation/repetition/prominence/distance screenshot metrics;
- generated screenshot review result; and
- explicit reference-hardware limitation when applicable.

Update `rendering-spec.md` with the quadratic limb coefficients, 600/21,600 s
cycles, 4/2/1 quality mapping, object-space domain-warped fBm, one eight-radius
billboard, three bounded prominence arcs, simulation-time input, static
fallback, and precompile policy.

- [ ] **Step 6: Commit performance evidence and spec**

```powershell
git add package.json tests/render/proceduralSunPage.ts tools/bench/proceduralSunQualityBench.test.mjs tools/bench/proceduralSunQualityBenchUtils.mjs tools/bench/proceduralSunQualityBench.mjs docs/bench/T0084-quality.json docs/bench/T0084-before.json docs/bench/T0084-after.json docs/bench/T0084-summary.md docs/rendering-spec.md
git commit -m "docs(render): [T0084] record procedural Sun evidence"
```

---

### Task 7: Full verification, delivery, and independent review

**Files:**
- Modify: `tasks/T0084-procedural-sun.yaml`
- Modify only if a gate exposes a real defect: the T0084-owned files above

**Interfaces:**
- Task moves `IN_PROGRESS -> REVIEW` on the feature branch
- PR title: `[T0084] Procedural Sun shader`
- Independent reviewer must report `Critical 0, Important 0, Minor 0`

- [ ] **Step 1: Rebase and run static/unit gates**

```powershell
git fetch origin main
git rebase origin/main
npm run lint
npm run typecheck
npm run format:check
npm test
npm run test:tools
git diff --check origin/main...HEAD
```

Expected: all commands PASS.

- [ ] **Step 2: Run every browser/build/budget gate**

```powershell
$scripts = @('test:render-depth','test:starfield','test:visual-tiers','test:lighting-post','test:surface-detail','test:procedural-sun','test:camera-controls','test:renderer-policy','test:telemetry','test:hud-signals')
foreach ($script in $scripts) { npm run $script; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
npm run build
npm run check:budgets
$env:KTX_BIN='C:\Program Files\KTX-Software\bin\ktx.exe'
npm run assets:verify
npm run check:tasks
```

Expected: every command PASS; KTX verification reports 15 byte-identical Earth
files.

- [ ] **Step 3: Submit the task for review**

Update only `tasks/T0084-procedural-sun.yaml` to `status: REVIEW`. Fill
`handoff_notes` with screenshot metrics, exact program counts, full/minimum GPU
delta, production benchmark pair, adapter limitation, test counts, and original
image review result. Commit:

```powershell
git add tasks/T0084-procedural-sun.yaml
git commit -m "chore(tasks): [T0084] submit procedural Sun for review"
git push -u origin task/T0084-procedural-sun
```

Open the PR and map every acceptance item to evidence.

- [ ] **Step 4: Obtain independent review and resolve findings with TDD**

A different agent reviews architecture, fallback behavior, shader continuity,
visual screenshots, seed/time determinism, resource disposal, frame-loop
allocations, quality timing, performance evidence, and CI. For every
Critical/Important finding, first add a failing test, then fix, rerun affected
and full gates, push, and request rereview until counts are `0/0/0`.

- [ ] **Step 5: Mark DONE and merge normally**

After exact-head CI and independent approval, change only the task status to
`DONE`, add the approval SHA/counts to `handoff_notes`, run task schema and diff
checks, commit, push, wait for final CI, and merge with a normal merge commit.
Verify the merge second parent equals the approved feature head and
`origin/main` contains `status: DONE`.
