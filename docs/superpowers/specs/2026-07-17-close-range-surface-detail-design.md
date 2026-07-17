# T0082 Close-range surface detail design

**Task:** T0082 — Close-range surface detail shading

**Status:** approved under the maintainer's standing authorization to continue autonomously
**Scope:** tier-3 body surfaces, Earth cloud motion, and the v1 Earth atmosphere rim

## Goals

- Preserve the real survey albedo, macro normal, emissive, cloud, and PBR material data already authored into each tier-3 model.
- Add spatial detail that remains sharp from a 400 km Earth orbit without shipping impractically large identity maps.
- Make the detail transition invisible: it begins at five body radii, is fully active by 1.2 radii, and produces a byte-identical image to the unmodified material at and beyond five radii.
- Keep all resources lazy, preallocate every frame-loop value, warm every shader before the first gameplay frame, and remain within the 1080p render budget.
- Complete the existing Earth presentation with independently moving clouds and a simple Fresnel atmosphere shell.

## Considered approaches

### 1. Extend `MeshStandardMaterial` at compile time — selected

An isolated render module augments only `mat_surface` through `onBeforeCompile` and a stable `customProgramCacheKey`. It retains Three.js's standard PBR, lighting, authored maps, transparency, and ACES pipeline. The injected code is disabled by an exact uniform branch at long range, so the base fragment path and output remain unchanged when the blend is zero.

This is the least risky path for the current `WebGLRenderer`. The shader math is kept in one module with backend-neutral inputs and no WebGL-only scene assumptions, making a later TSL translation mechanical when ADR-008 migrates the renderer.

### 2. Replace loaded materials with TSL node materials

This is the strongest long-term WebGPU shape, but Three.js r185 requires the experimental `WebGLNodesHandler` compatibility adapter. Its official limitations include no `compile()` support, while this project requires explicit precompilation. Replacing the standard material also risks changing far-view bytes even when detail is disabled. It is not selected for T0082.

### 3. Ship larger or virtual surface textures

This would keep unmodified standard materials but increases download and memory cost, conflicts with the 8 MiB critical path and 150 MiB asset budgets, and does not provide effectively unbounded close-range variation. It is not selected.

## Runtime asset contract

The generated runtime asset manifest moves to schema version 2. Entries may include:

```ts
interface RuntimeSurfaceDetail {
  readonly albedo: string;
  readonly normal: string;
  readonly tilesPerEquator: number;
  readonly seed: number;
}
```

The two paths must be safe members of the entry's `files` list, `tilesPerEquator` must be positive and finite, and `seed` must be an unsigned 32-bit integer. The ingest pipeline emits the descriptor only when a validated 1k detail albedo/normal pair exists. Per-body scale values live in the ingest configuration and are copied into the runtime manifest; the renderer does not infer scale from category or radius. Seeds are deterministic and explicit.

The existing KTX2 files remain the only new shader inputs. `BodyAssetLoader` loads the pair with the tier-3 model, caches one promise per body, and configures both textures once with repeat wrapping, complete mip use, and anisotropy `min(4, renderer.capabilities.getMaxAnisotropy())`. The albedo retains its sRGB metadata and the normal remains linear. A missing or failed optional detail pair leaves the standard tier-3 model usable and reports one stable load error.

## Surface shader

Only `MeshStandardMaterial` named `mat_surface` is extended. Cloud, ring, emissive-only, and ship materials are never modified.

The module owns one stable uniform set per prepared surface material:

- detail albedo and tangent-space normal samplers;
- exact detail blend and closest-range procedural blend;
- `tilesPerEquator` and deterministic seed;
- fixed macro/micro weights and normal strength.

Distance uses camera-to-body-centre distance divided by mean radius. A cubic smoothstep rises from zero at 5.0 radii to one at 1.2 radii. The closest-range procedural factor rises only inside 1.5 radii and is also one by 1.2 radii. Both values are written into existing uniform objects without allocation.

When detail blend is exactly zero, the shader skips every added texture sample and procedural operation. No base color, normal, roughness, emissive, alpha, or lighting value is rewritten. This is the contract behind the byte-identical far-view regression.

When enabled, the shader samples the seamless pair at `uv * tilesPerEquator` and at eight times that frequency with a deterministic phase offset. Centered albedo variation is blended conservatively over the identity map; the two normal samples are combined with the authored macro normal instead of replacing it. At the closest range, a seeded two-octave 3D value-noise function over normalized object-space direction adds low-amplitude roughness and normal breakup without a longitude seam. All loop counts and branches are compile-time bounded.

`customProgramCacheKey` identifies the surface-detail program independently of object identity. Uniform values do not create shader variants. Model preparation finishes before `compileAsync`, and the existing startup post-pipeline warm-up renders the selected production path before `requestAnimationFrame`.

## Earth clouds and atmosphere

The loaded Earth model's `mat_clouds` mesh is retained. Its existing alpha-map setup, transparent depth behavior, and authored radius remain unchanged. Model preparation stores the cloud object once; the frame update changes only its Y-rotation and matrix using a deterministic, slow wall-time phase, independent of the surface mesh. No object, matrix, or array is created in the frame loop.

The atmosphere reuses the cloud shell geometry in one additional mesh created during model preparation. It uses one precompiled transparent back-face `MeshBasicMaterial` with an isolated Fresnel compile hook, slightly larger than the cloud shell, with blue limb color, additive blending, depth test enabled, and depth writes disabled. Retaining a built-in material keeps Three.js's standard opacity uniform synchronized with the tier-3 fade bookkeeping. It adds one draw call only while the Earth tier-3 model is visible.

## Ownership and data flow

1. Asset ingest validates the authored pair and emits schema-v2 manifest metadata.
2. `BodyAssetLoader` lazily resolves the tier-3 model and optional detail textures.
3. A focused surface-detail module prepares eligible surface materials and optional Earth layers before model compilation.
4. `BodyVisualSystem` stores one nullable prepared handle per body.
5. The existing allocation-free `update()` computes radius ratios and writes blend/cloud values to those handles.
6. The normal render and lighting/post pipelines remain unaware of surface-detail internals.

No `SimSnapshot`, `Commands`, `bodies.json`, physics formula, or layer boundary changes.

## Failure behavior

- Invalid schema-v2 descriptors reject the manifest with a precise entry-level error.
- Missing descriptors or bodies without detail maps use the existing standard material.
- A rejected detail texture pair reports once and loads the model without the extension.
- A model with no eligible `mat_surface` material remains usable and is treated as detail-ineligible.
- Shader compilation failure follows the existing model failure state, so the sphere tier remains visible instead of exposing a partially prepared model.

## Verification

### Unit and contract tests

- Manifest v2 accepts valid descriptors and rejects unsafe, absent-from-files, non-finite-scale, and invalid-seed values.
- Ingest emits deterministic descriptors and identical manifests across repeated runs.
- Loader caches the model/detail request, configures repeat and anisotropy once, and degrades safely after rejection.
- Distance blend tests cover 5.0, 1.2, surface crossing, non-finite input, monotonicity, and exact zero at long range.
- Shader preparation tests cover material filtering, stable cache keys, uniform reuse, and disposal.
- Earth preparation tests cover one reused-geometry atmosphere mesh and allocation-free cloud matrix updates.

### Browser regressions

- A production Earth tier-3 capture at 400 km altitude demonstrates increased high-frequency surface detail without texel blur.
- Spatial autocorrelation and quadrant metrics reject obvious tiling repetition; a human screenshot review remains part of PR review.
- At a distance greater than or equal to five Earth radii, enabled-detail and forced-control captures are byte-identical.
- Cloud phase changes while the surface transform remains stable; atmosphere pixels remain confined to the limb.
- Program count is stable from startup warm-up through the first gameplay frame, with no WebGL or console errors.

### Performance and gates

- Record paired native 1920×1080 telemetry before/after data on the available hardware, including GPU p50/p75/p99, frame cadence, draw calls, triangles, heap delta, and browser errors.
- The near-Earth render remains at or below the 10 ms render target on reference hardware. If the specified 2023+ reference GPU is unavailable, use the maintainer-approved conservative local hardware proxy and report both absolute time and incremental T0082 cost without hiding the limitation.
- Run lint, typecheck, Prettier, Vitest, Python/tool tests, every browser regression, build, asset budgets, and task-schema validation before review.
