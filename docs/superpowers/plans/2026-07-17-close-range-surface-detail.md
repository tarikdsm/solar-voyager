# Close-range Surface Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lazy two-octave close-range surface detail, closest-range procedural breakup, independently moving Earth clouds, and a Fresnel atmosphere while preserving exact far-view pixels and the 60 fps floor.

**Architecture:** Asset ingest emits a schema-v2 optional `surfaceDetail` descriptor; `BodyAssetLoader` resolves and configures its KTX2 pair with the tier-3 model. A focused `surfaceDetail.ts` module extends eligible standard materials once and exposes allocation-free update handles consumed by `BodyVisualSystem`; browser regressions validate LEO fidelity, far equivalence, shader warm-up, and Earth layers.

**Tech Stack:** TypeScript 6, Three.js r185/WebGL2, Vite 8, Vitest 4, Playwright 1.61, Sharp 0.35, KTX-Software 4.4.x.

## Global Constraints

- `src/core/` and `src/sim/` remain pure and unchanged; all new runtime work belongs to `src/render/`.
- Do not change `SimSnapshot`, `Commands`, `bodies.json`, or physics formulas.
- Detail blend is exactly `0` at and beyond `5.0` body radii and exactly `1` at and below `1.2` radii.
- Detail textures are existing 1024×1024 KTX2 pairs, lazy-loaded with complete mip chains and anisotropy capped at `4`.
- Frame-loop code creates no objects, arrays, closures, materials, geometries, or textures.
- Shader variants are prepared before model reveal; the first gameplay frame must not increase `renderer.info.programs.length`.
- Typical 1080p rendering remains within 10 ms on reference hardware; unavailable reference hardware must be disclosed with paired conservative-proxy evidence.
- Do not stage or modify `docs/check_plan.html`, `.playwright-mcp/`, or `t0040-space-scene.png`.

---

### Task 1: Runtime manifest v2 and deterministic ingest metadata

**Files:**
- Modify: `src/render/assetManifest.ts`
- Modify: `tests/render/assetManifest.test.ts`
- Modify: `tools/assets/config.mjs`
- Modify: `tools/assets/ingest.mjs`
- Modify: `tools/assets/ingest.test.mjs`
- Modify: `tools/checks/assetBudgets.test.mjs`

**Interfaces:**
- Produces: `RuntimeSurfaceDetail { albedo, normal, tilesPerEquator, seed }` and optional `RuntimeAssetEntry.surfaceDetail`.
- Produces: `SURFACE_DETAIL_CONFIG[id]` for Earth `{32,399}`, Moon `{16,301}`, Pluto `{12,999}`, and Saturn `{32,699}`.
- Consumes: the existing sorted runtime `files` array and validated 1k detail roles.

- [ ] **Step 1: Write failing manifest parser tests**

Add a valid schema-v2 entry and table-driven invalid descriptors:

```ts
const detailedEarth = {
  id: 'earth',
  category: 'planet',
  triangles: 1,
  files: [
    'models/earth.glb',
    'textures/earth_detail_albedo.ktx2',
    'textures/earth_detail_normal.ktx2',
  ],
  surfaceDetail: {
    albedo: 'textures/earth_detail_albedo.ktx2',
    normal: 'textures/earth_detail_normal.ktx2',
    tilesPerEquator: 512,
    seed: 399,
  },
};

expect(parseAssetManifest({ schemaVersion: 2, assets: [detailedEarth] }).assets[0])
  .toEqual(detailedEarth);
for (const surfaceDetail of [
  { ...detailedEarth.surfaceDetail, albedo: '../escape.ktx2' },
  { ...detailedEarth.surfaceDetail, normal: 'textures/missing.ktx2' },
  { ...detailedEarth.surfaceDetail, tilesPerEquator: 0 },
  { ...detailedEarth.surfaceDetail, seed: -1 },
]) {
  expect(() => parseAssetManifest({
    schemaVersion: 2,
    assets: [{ ...detailedEarth, surfaceDetail }],
  })).toThrow(/surface detail/iu);
}
```

- [ ] **Step 2: Run the focused parser test and confirm RED**

Run: `npm test -- --run tests/render/assetManifest.test.ts`
Expected: FAIL because schema version 2 and `surfaceDetail` are not recognized.

- [ ] **Step 3: Implement the strict schema-v2 parser**

Define and validate the exact contract:

```ts
export interface RuntimeSurfaceDetail {
  readonly albedo: string;
  readonly normal: string;
  readonly tilesPerEquator: number;
  readonly seed: number;
}

export interface RuntimeAssetEntry {
  readonly id: string;
  readonly category: RuntimeAssetCategory;
  readonly triangles: number;
  readonly files: readonly string[];
  readonly surfaceDetail?: RuntimeSurfaceDetail;
}

export interface RuntimeAssetManifest {
  readonly schemaVersion: 2;
  readonly assets: readonly RuntimeAssetEntry[];
}
```

`parseSurfaceDetail()` must require both safe paths to exist in `files`, require `Number.isFinite(tilesPerEquator) && tilesPerEquator > 0`, and require `Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff`. Return `{ schemaVersion: 2, assets }` and reject every other schema version.

- [ ] **Step 4: Add failing ingest expectations**

Add `createDetailedSourceTree()` with a `dwarfs/pluto` fixture containing a valid 1024×512 albedo, 1024×1024 detail albedo, 1024×1024 detail normal, fixture GLB, and complete `SOURCES.md`. Expect canonical output:

```js
surfaceDetail: {
  albedo: 'textures/pluto_detail_albedo.ktx2',
  normal: 'textures/pluto_detail_normal.ktx2',
  tilesPerEquator: 12,
  seed: 999,
},
schemaVersion: 2,
```

Also assert the two-run SHA-256 tree remains identical.

- [ ] **Step 5: Emit deterministic metadata from ingest**

Add to `tools/assets/config.mjs`:

```js
export const SURFACE_DETAIL_CONFIG = Object.freeze({
  earth: Object.freeze({ tilesPerEquator: 32, seed: 399 }),
  moon: Object.freeze({ tilesPerEquator: 16, seed: 301 }),
  pluto: Object.freeze({ tilesPerEquator: 12, seed: 999 }),
  saturn: Object.freeze({ tilesPerEquator: 32, seed: 699 }),
});
```

In ingest, locate both emitted detail paths. Throw if configuration and validated files disagree; otherwise append the descriptor and serialize `{ schemaVersion: 2, assets }`. Update budget fixtures from schema 1 to 2 without weakening any file/path validation.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm test -- --run tests/render/assetManifest.test.ts tools/assets/ingest.test.mjs tools/checks/assetBudgets.test.mjs`
Expected: all focused tests PASS.

```powershell
git add src/render/assetManifest.ts tests/render/assetManifest.test.ts tools/assets/config.mjs tools/assets/ingest.mjs tools/assets/ingest.test.mjs tools/checks/assetBudgets.test.mjs
git commit -m "feat(assets): [T0082] describe runtime surface detail"
```

### Task 2: Lazy detail-pair loading and texture policy

**Files:**
- Modify: `src/render/bodyAssetLoader.ts`
- Modify: `src/render/bodyAssetLoader.test.ts`

**Interfaces:**
- Consumes: `RuntimeAssetEntry.surfaceDetail` from Task 1.
- Produces: `LoadedSurfaceDetail { albedo, normal, tilesPerEquator, seed }`.
- Produces: `LoadedBodyModel.surfaceDetail: LoadedSurfaceDetail | null`.

- [ ] **Step 1: Write failing loader tests**

Use a fake renderer with `capabilities.getMaxAnisotropy: () => 16`; load a detailed Earth twice and assert one model request, two texture requests, cached promise identity, and:

```ts
expect(result?.surfaceDetail).toMatchObject({ tilesPerEquator: 512, seed: 399 });
expect(result?.surfaceDetail?.albedo.wrapS).toBe(RepeatWrapping);
expect(result?.surfaceDetail?.albedo.wrapT).toBe(RepeatWrapping);
expect(result?.surfaceDetail?.normal.wrapS).toBe(RepeatWrapping);
expect(result?.surfaceDetail?.normal.wrapT).toBe(RepeatWrapping);
expect(result?.surfaceDetail?.albedo.anisotropy).toBe(4);
expect(result?.surfaceDetail?.normal.anisotropy).toBe(4);
```

Add a rejection test where detail normal fails: the model resolves with `surfaceDetail: null`, the reporter runs once, and a second `loadModel()` does not retry.

- [ ] **Step 2: Run focused test and confirm RED**

Run: `npm test -- --run src/render/bodyAssetLoader.test.ts`
Expected: FAIL because loaded models have no surface-detail result.

- [ ] **Step 3: Implement one cached optional pair per model**

Add:

```ts
export interface LoadedSurfaceDetail {
  readonly albedo: Texture;
  readonly normal: Texture;
  readonly tilesPerEquator: number;
  readonly seed: number;
}

export interface LoadedBodyModel {
  readonly root: Object3D;
  readonly materials: Material[];
  readonly surfaceDetail: LoadedSurfaceDetail | null;
}
```

Inside the existing cached model promise, load the root and optional pair from the same backend. Configure `RepeatWrapping` and `Math.min(4, renderer.capabilities.getMaxAnisotropy())` before returning. Catch only the optional pair failure locally; keep model failure behavior unchanged.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm test -- --run src/render/bodyAssetLoader.test.ts tests/render/assetManifest.test.ts`
Expected: PASS.

```powershell
git add src/render/bodyAssetLoader.ts src/render/bodyAssetLoader.test.ts
git commit -m "feat(render): [T0082] load surface detail lazily"
```

### Task 3: Distance blend and standard-material extension

**Files:**
- Create: `src/render/surfaceDetail.ts`
- Create: `src/render/surfaceDetail.test.ts`

**Interfaces:**
- Consumes: `LoadedSurfaceDetail`, a `MeshStandardMaterial`, and body id.
- Produces: `surfaceDetailBlend(distanceKm, radiusKm): number`.
- Produces: `PreparedSurfaceDetail { setDistance(distanceKm, radiusKm): void; setEnabled(enabled): void; dispose(): void }`.
- Produces: `prepareSurfaceDetail(material, detail): PreparedSurfaceDetail`.

- [ ] **Step 1: Write failing pure blend tests**

```ts
expect(surfaceDetailBlend(5 * R, R)).toBe(0);
expect(surfaceDetailBlend(6 * R, R)).toBe(0);
expect(surfaceDetailBlend(1.2 * R, R)).toBe(1);
expect(surfaceDetailBlend(R, R)).toBe(1);
expect(surfaceDetailBlend(3 * R, R)).toBeGreaterThan(0);
expect(surfaceDetailBlend(3 * R, R)).toBeLessThan(1);
expect(() => surfaceDetailBlend(Number.NaN, R)).toThrow(RangeError);
```

- [ ] **Step 2: Run focused test and confirm RED**

Run: `npm test -- --run src/render/surfaceDetail.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement exact cubic blending**

```ts
const DETAIL_START_RADII = 5;
const DETAIL_FULL_RADII = 1.2;

export function surfaceDetailBlend(distanceKm: number, radiusKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || !Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new RangeError('Surface-detail distance and radius must be finite and physical.');
  }
  const ratio = distanceKm / radiusKm;
  const linear = Math.min(1, Math.max(0,
    (DETAIL_START_RADII - ratio) / (DETAIL_START_RADII - DETAIL_FULL_RADII),
  ));
  return linear * linear * (3 - 2 * linear);
}
```

- [ ] **Step 4: Write failing material-extension tests**

Capture `onBeforeCompile`, invoke it with a minimal shader fixture containing `#include <map_fragment>`, `#include <normal_fragment_maps>`, and `#include <roughnessmap_fragment>`, then assert sampler/uniform injection, an exact `if (uSurfaceDetailBlend > 0.0)` guard, two scales (`uTilesPerEquator` and `* 8.0`), seeded two-octave object-space noise, and stable `customProgramCacheKey()`. Assert repeated `setDistance()` mutates existing uniform objects rather than replacing them.

- [ ] **Step 5: Implement the extension and disposal**

Create one uniform record before compilation. Inject an object-space direction varying in the vertex shader and guarded detail code in the fragment shader. Combine centered albedo variation after `<map_fragment>`, tangent-space detail normals after `<normal_fragment_maps>`, and bounded roughness noise after `<roughnessmap_fragment>`. Chain any pre-existing hooks, set `material.needsUpdate = true` only during preparation, and dispose the two owned detail textures exactly once.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm test -- --run src/render/surfaceDetail.test.ts src/render/bodyAssetLoader.test.ts`
Expected: PASS.

```powershell
git add src/render/surfaceDetail.ts src/render/surfaceDetail.test.ts
git commit -m "feat(render): [T0082] shade close-range surface detail"
```

### Task 4: BodyVisualSystem integration, Earth cloud motion, and atmosphere

**Files:**
- Create: `src/render/earthSurfaceLayers.ts`
- Create: `src/render/earthSurfaceLayers.test.ts`
- Modify: `src/render/bodyVisualSystem.ts`
- Modify: `src/render/bodyVisualSystem.test.ts`
- Modify: `src/render/createEpochWorld.test.ts`

**Interfaces:**
- Consumes: `LoadedBodyModel.surfaceDetail` and `prepareSurfaceDetail()`.
- Produces: one nullable `PreparedSurfaceDetail` per body.
- Produces: `prepareEarthSurfaceLayers(root, materials): PreparedEarthSurfaceLayers | null` with `update(nowMs)` and `dispose()`.

- [ ] **Step 1: Write failing Earth-layer tests**

Build a root with one cloud mesh/material. Assert preparation adds exactly one atmosphere mesh sharing the cloud geometry, using a `MeshBasicMaterial` with `BackSide`, `AdditiveBlending`, `depthTest: true`, `depthWrite: false`, and a stable Fresnel compile hook. Call `update(0)` then `update(10_000)` and assert the cloud matrix changes while the surface matrix does not; compare object identities to prove repeated updates allocate no replacement matrices or materials.

- [ ] **Step 2: Implement setup-only Earth layers**

Create one `MeshBasicMaterial` and one `Mesh` during preparation, add the Fresnel varying/alpha multiplication through `onBeforeCompile`, set a stable `customProgramCacheKey`, append its material to the mutable model material list before fade baselines are captured, and store the cloud mesh. `update(nowMs)` writes a bounded Y rotation and calls `updateMatrix()` on the existing cloud object. Three.js's built-in opacity uniform makes atmosphere opacity follow the existing tier-3 material fade.

- [ ] **Step 3: Write failing BodyVisualSystem integration tests**

Load a detailed Earth model and assert only `mat_surface` receives the extension. Move the camera through `6R`, `3R`, and `1.2R`; capture the prepared handle and assert blend `0`, between `0..1`, and `1`. Assert cloud/atmosphere preparation happens before `compileModel` and that a failed detail pair leaves the standard material intact.

- [ ] **Step 4: Integrate allocation-free handles**

Add fixed-length arrays initialized in the constructor:

```ts
private readonly surfaceDetails: Array<PreparedSurfaceDetail | null>;
private readonly earthSurfaceLayers: Array<PreparedEarthSurfaceLayers | null>;
```

During model load, prepare eligible materials and Earth layers before opacity baselines and `compileModel`. During the existing body loop, reuse the already computed `distanceKm` and radius to call `setDistance`; update Earth layers with `nowMs`. Do not add a second body loop.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- --run src/render/surfaceDetail.test.ts src/render/earthSurfaceLayers.test.ts src/render/bodyVisualSystem.test.ts src/render/createEpochWorld.test.ts`
Expected: PASS.

```powershell
git add src/render/earthSurfaceLayers.ts src/render/earthSurfaceLayers.test.ts src/render/bodyVisualSystem.ts src/render/bodyVisualSystem.test.ts src/render/createEpochWorld.test.ts
git commit -m "feat(render): [T0082] integrate detailed Earth layers"
```

### Task 5: Production WebGL regression for LEO, far identity, and warm-up

**Files:**
- Create: `tests/render/surfaceDetail.html`
- Create: `tests/render/surfaceDetailPage.ts`
- Create: `tools/tests/surfaceDetailRegression.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `globalThis.__surfaceDetailHarness` methods `renderLeo(enabled)`, `renderFar(enabled)`, `advanceClouds(nowMs)`, and `programSnapshot()`.
- Consumes: production `createEpochWorld`, lighting, and post pipeline.

- [ ] **Step 1: Create the fixture and a failing regression assertion**

The fixture must load the real generated Earth model, wait for tier 3, position the camera at `meanRadiusKm + 400`, warm the production render path, and expose screenshots with detail enabled/disabled. The Node script must initially assert:

```js
assert.deepEqual(farEnabledPixels, farControlPixels, 'far detail changed production pixels');
assert.equal(programs.afterFirstFrame, programs.afterWarmUp);
assert.equal(programs.glError, 0);
assert.ok(leo.highFrequencyEnergy > control.highFrequencyEnergy * 1.08);
assert.ok(leo.strongestRepeatPeak < 0.35);
assert.ok(atmosphere.offDiscBluePixels > 100);
assert.notEqual(clouds.beforeMatrixHash, clouds.afterMatrixHash);
```

- [ ] **Step 2: Run the browser regression and confirm RED**

Run: `npm run test:surface-detail`
Expected: FAIL until the production integration and generated manifest/assets are present.

- [ ] **Step 3: Finish deterministic image metrics**

Use Sharp raw RGB data. Measure high-frequency energy with adjacent-pixel luminance deltas inside the Earth disc; measure repeat peaks from normalized horizontal/vertical autocorrelation at candidate tile periods; compare far buffers byte-for-byte; count blue-biased atmosphere pixels only outside the solid disc; hash cloud matrices before/after. Reject page errors, console errors, nonzero WebGL errors, and first-frame program growth.

- [ ] **Step 4: Register the regression in local and CI gates**

Add `"test:surface-detail": "node tools/tests/surfaceDetailRegression.mjs"` to `package.json` and a `Surface detail regression` step immediately after lighting/post in CI.

- [ ] **Step 5: Run regression and commit**

Run: `npm run test:surface-detail && npm run test:lighting-post && npm run test:camera-controls`
Expected: all three browser regressions PASS with JSON metrics printed.

```powershell
git add tests/render/surfaceDetail.html tests/render/surfaceDetailPage.ts tools/tests/surfaceDetailRegression.mjs package.json .github/workflows/ci.yml
git commit -m "test(render): [T0082] verify close-range surface fidelity"
```

### Task 6: Regenerate assets and record performance evidence

**Files:**
- Modify: `public/assets/manifest.json`
- Modify: generated `public/assets/models/*.glb` only if deterministic ingest changes their bytes
- Modify: generated `public/assets/textures/*.ktx2` only if deterministic ingest changes their bytes
- Create: `docs/bench/T0082-before.json`
- Create: `docs/bench/T0082-after.json`
- Create: `docs/bench/T0082-summary.md`
- Modify: `docs/rendering-spec.md`

**Interfaces:**
- Consumes: installed KTX-Software and the existing `tools/bench/scaffoldBench.mjs` hardware path.
- Produces: committed schema-v2 runtime manifest and paired 1920×1080 evidence.

- [ ] **Step 1: Verify the encoder and regenerate twice**

Run:

```powershell
ktx --version
npm run assets:ingest
git diff --check
git status --short public/assets
```

Hash `public/assets`, run ingest a second time, and assert the tree hash is unchanged. Expected: schema version 2 and descriptors for Earth, Moon, Pluto, and Saturn; no nondeterministic second-run diff.

- [ ] **Step 2: Run visual review at original resolution**

Run `npm run test:surface-detail` with screenshot output enabled, inspect the 400 km Earth, far control, clouds, and atmosphere at original resolution, and adjust only manifest scale/constant strengths when a metric and the image agree that blur, tiling, or over-sharpening remains. Re-run the full focused unit/browser set after each adjustment.

- [ ] **Step 3: Capture paired native 1080p evidence**

Use the existing benchmark harness at native `1920×1080` on the available GPU. Record before/after with identical camera, warm-up, duration, and browser flags. Each JSON must include FPS/cadence, GPU and render p50/p75/p99, draw calls, triangles, program count, heap delta, context renderer string, console errors, and page errors.

- [ ] **Step 4: Document exact results and limitation**

Write `T0082-summary.md` with the incremental GPU p75 cost, absolute render p75, whether the 10 ms target passed, screenshot metric values, far byte identity, first-frame program stability, and the explicit hardware-proxy disclosure if the 2023+ reference GPU is unavailable. Update rendering-spec §11 only with implemented constants and manifest contract; do not broaden scope.

- [ ] **Step 5: Run budget checks and commit**

Run: `npm run check:budgets && npm run assets:verify && git diff --check`
Expected: asset budgets and Earth verification PASS.

```powershell
git add public/assets docs/bench/T0082-before.json docs/bench/T0082-after.json docs/bench/T0082-summary.md docs/rendering-spec.md
git commit -m "docs(render): [T0082] record surface detail evidence"
```

### Task 7: Full verification, task delivery, and independent review

**Files:**
- Modify: `tasks/T0082-close-range-surface-detail.yaml`

**Interfaces:**
- Consumes: all T0082 commits and evidence.
- Produces: task status `REVIEW`, a PR with acceptance evidence, then reviewer-owned approval and `DONE`.

- [ ] **Step 1: Run the complete local gate**

Run, with every command required to succeed:

```powershell
npm run lint
npm run typecheck
npm run format:check
npm test
npm run test:render-depth
npm run test:starfield
npm run test:visual-tiers
npm run test:lighting-post
npm run test:surface-detail
npm run test:camera-controls
npm run test:renderer-policy
npm run test:telemetry
npm run test:hud-signals
npm run test:tools
npm run build
npm run check:budgets
npm run check:tasks
git diff --check
```

- [ ] **Step 2: Rebase and repeat affected gates**

Run `git fetch origin main && git rebase origin/main`; resolve only T0082-owned conflicts. Repeat lint, typecheck, Vitest, surface-detail, lighting/post, camera, build, budgets, and task schema.

- [ ] **Step 3: Set REVIEW and commit**

Change only T0082's task file to `status: REVIEW`. Handoff notes must list LEO visual metrics, far SHA/byte identity, exact program counts, paired 1080p results, full test counts, and the hardware limitation.

```powershell
git add tasks/T0082-close-range-surface-detail.yaml
git commit -m "chore(tasks): [T0082] surface detail ready for review"
git push -u origin task/T0082-close-range-surface-detail
```

- [ ] **Step 4: Open the PR and wait for exact-head CI**

Open `[T0082] Close-range surface detail shading`. The description maps each acceptance criterion to evidence and links `docs/bench/T0082-summary.md`. Do not merge unless the CI head SHA equals the reviewed branch head and every check succeeds.

- [ ] **Step 5: Obtain independent review and close findings**

A different agent reviews architecture, shader correctness, far identity, visual screenshots, resource disposal, zero-allocation behavior, asset determinism, and performance evidence. Fix Critical/Important findings with TDD, re-run exact affected/full gates, and request re-review until the report is `Critical 0, Important 0, Minor 0`.

- [ ] **Step 6: Mark DONE, run final CI, and merge normally**

Append the independent approval to handoff notes, change status to `DONE`, commit and push. Wait for exact-head CI again, then use a normal merge commit and verify its second parent is the approved head.
