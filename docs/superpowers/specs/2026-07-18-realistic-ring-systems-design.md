# Realistic Ring Systems Design

**Task:** T0083
**Status:** approved for autonomous execution under the project-completion goal
**Scope:** Saturn, Jupiter, Uranus, and Neptune tier-3 assets, ring lighting, and Saturn close-range flythrough

## Outcome

All four giant planets load as canonical tier-3 models with guide-compliant annulus geometry and scientifically grounded ring structure. Rings respond to the live Sun direction with planet shadow, cast an opacity-shaped shadow back onto the planet, and transmit a bounded amount of backlight. Saturn additionally gains a quality-governed, one-draw instanced ice field that cross-fades with the annulus near the ring plane and moves at local Keplerian speed.

The implementation keeps the existing body-id asset model: each planet GLB owns its body and `mat_rings` annulus. No new manifest identity scheme and no `bodies.json` schema change are required.

## Approaches considered

### 1. Integrated planet GLBs and a shared ring catalog — selected

Each planet's tier-3 GLB contains `mat_surface` and `mat_rings`. A new versioned `data/rings.json` is the single scientific source for authoring and runtime shading. Blender consumes it for normalized annulus geometry and deterministic source textures; TypeScript consumes it for shader radii, optical scaling, arcs, and particle policy.

This matches the already approved Saturn asset and the current `BodyAssetLoader`, keeps one lazy tier-3 request per planet, and gives both Blender and runtime one reviewed data contract.

### 2. Separate ring assets and a dedicated manifest identity

This would isolate ring budgets cleanly, but the manifest validates catalog body ids and the loader caches one model per body id. It would require a second identity convention, loader lifecycle, tier cross-fade, and failure policy for companion assets. The extra machinery does not improve v1 visuals.

### 3. Runtime-generated annuli and textures

This minimizes checked-in geometry, but conflicts with the requirement that all four ring sets pass through canonical ingest and with the no-runtime-geometry-creation contract. It also weakens Blender review and deterministic asset provenance.

## Scientific data contract

`data/rings.json` is a small schema-versioned document independent of `bodies.json`. Each entry contains:

- `bodyId`, equatorial reference radius, inner/outer extent in kilometers and normalized planet radii;
- named radial bands with inner/outer kilometer radii, representative optical depth, and linear display color;
- optional azimuthal arcs expressed as stable angular centers, widths, and gain;
- particle parameters only for Saturn: deterministic seed, maximum instance count, patch radius, vertical thickness, and size range;
- exact primary-source URLs and citation labels.

The catalog uses PDS Ring-Moon Systems Node / NASA / USGS values. Saturn spans D inner edge through F ring. Jupiter includes halo, main, Amalthea, and Thebe/gossamer extents. Uranus includes the classical narrow rings plus the faint outer Nu/Mu structure within a bounded visual dynamic range. Neptune includes Galle through Adams and the four prominent Adams arcs.

Optical depth is authoritative for relative structure, not literal display alpha. A documented per-system exposure maps the many-orders-of-magnitude physical range into a visible but still correctly ranked alpha. This is necessary for Jupiter's and the ice giants' rings to remain visible on an SDR display without making them resemble Saturn.

The data loader rejects duplicate body ids, non-finite values, inverted bands, bands outside the annulus, invalid colors, and arcs outside the Adams band. Unit tests pin the published Saturn proportions and representative PDS radii for all four systems.

## Asset authoring and ingest

The generic planet builder is extended to the four ringed giants and wrappers preserve `build_all.py` discovery. All builders use `tools/blender/common` and start from an empty scene.

For each body the builder emits:

- one upright, normalized, oblate surface (`mat_surface`), north along +Y after export;
- one flat annulus (`mat_rings`) with at least 128 angular segments, no more than 5,000 triangles, double-sided rendering, and U mapped monotonically from the configured inner to outer radius;
- a 2048×64 deterministic RGBA ring strip generated from the catalog's bands, with alpha representing the exposure-mapped optical depth;
- external planet albedo and mandatory 1k gas-detail pair;
- a stable manifest and guide/budget assertions.

Saturn's approved Solar System Scope source remains the visual reference, but its builder is migrated to shared deterministic helpers and the common ring contract. Jupiter, Uranus, and Neptune use approved Solar System Scope/NASA base maps with explicit `SOURCES.md` attribution. The ring strips are project-generated visualizations of the cited PDS/NASA measurements and record their processing in `SOURCES.md`.

Canonical ingest produces Draco GLBs and KTX2 variants. Each planet remains under the 12 MB planet limit and each ring source/runtime subset remains below 2 MB. A focused verification compares two clean builder/ingest runs byte-for-byte.

## Runtime ring shading

`src/render/ringMaterial.ts` prepares resources only when a tier-3 model is loaded. It finds the `mat_rings` mesh/material and the planet's `mat_surface`; missing or malformed pairs fail that model load cleanly without affecting the sphere fallback.

One stable shader augmentation is applied to both materials:

- **Planet shadow on ring:** in ring-local coordinates, a ray toward the Sun is tested against the unit oblate spheroid. Occluded fragments receive a bounded shadow multiplier while preserving a small ambient floor.
- **Ring shadow on planet:** a surface-to-Sun ray is intersected with the local ring plane. When the intersection radius lies inside the ring extent, the radial strip is sampled and its optical alpha attenuates direct light.
- **Backlit transmission:** the ring material uses the signed ring-normal/Sun cosine and texture alpha to add a limited warm transmission term on the unlit/backlit side.
- **Neptune arcs:** an azimuthal mask strengthens only the configured Adams arc sectors. Other systems use a neutral mask.

Sun direction is computed allocation-free from the existing packed float64 body positions, transformed into the planet's stable local frame, and written into existing uniforms. Materials receive stable program cache keys and compile before becoming visible. The implementation creates no materials, textures, geometries, arrays, or closures in the frame loop.

Body tier-3 roots receive the catalog axial tilt at setup so the ring plane is visually correct. The same transform is used for shader-space Sun and camera calculations. Rotation animation of the gas surfaces remains T0085 scope; T0083 does not add band flow.

## Saturn close-range flythrough

`src/render/ringParticleField.ts` owns one maximum-capacity `InstancedMesh` with a single shared low-poly ice geometry and one shader material. Instance seed attributes and base transforms are generated once. Runtime changes only uniforms and `mesh.count`.

The field activates when the camera is near Saturn's configured annulus and approaches the ring plane. A smooth radial/vertical window prevents popping. The annulus opacity is reduced by the complementary blend, so the total representation remains continuous.

Particles form a camera-centered patch expressed in Saturn's local radial/tangent/normal basis. The patch origin follows the camera through uniforms; seeded offsets do not regenerate. Tangential phase advances from simulation time using `sqrt(mu / r^3)`, with time reduced modulo a local orbital period before conversion to float32 shader uniforms. The result is visible parallax and Keplerian motion without CPU instance updates per frame.

Each instance samples the same catalog-derived radial opacity profile as the annulus. That sample controls deterministic density rejection, color, and size, so Cassini gaps stay sparse in both representations and the particle field cannot contradict the distant texture.

The adaptive-quality profile exposes a ring-particle count rung. Full quality uses the configured maximum; lower tiers reduce count, and the lowest tier disables the field while retaining the annulus. Because count changes do not change shader code, no runtime shader compilation is introduced.

## Integration and ownership

`BodyVisualSystem` remains the lifecycle owner for body models. A prepared ring system is stored beside surface-detail and Earth-layer state, updated inside the existing body loop using already computed body distance and packed positions, and disposed with the model. `RenderQualityController` forwards the precomputed particle count from each quality profile.

The public API additions are render-layer only:

- body definitions add `muKm3S2` and `axialTiltRad`;
- visual updates receive simulation time in addition to wall-clock animation time;
- quality profiles add an integer ring-particle cap;
- prepared ring systems expose allocation-free `update`, `setParticleCount`, and `dispose` methods.

No `src/core` or `src/sim` dependency is added, and no `SimSnapshot`, `Commands`, physics formula, or `bodies.json` schema changes.

## Failure handling

- Missing ring catalog or invalid ring data fails during application setup with an actionable body/field path.
- A missing tier-3 model or texture retains the existing textured-sphere fallback and reports one loader error.
- A model containing only one of `mat_surface` / `mat_rings` is rejected as an incomplete ring asset.
- Particle initialization failure disables only the flythrough field; the annulus remains available.
- Software rendering and low quality can set particle count to zero without altering asset or shader readiness.

## Verification

### Unit and tool tests

- ring catalog validation and normalized published radii;
- ring-strip generation, seam continuity, alpha ordering, and deterministic hash;
- Blender config, topology, material names, scale/orientation, and manifest;
- shader injection, stable cache keys, correct uniform reuse, occlusion geometry, backlight bounds, and disposal;
- particle seed determinism, count rungs, activation/cross-fade continuity, Keplerian phase, and zero replacement resources;
- loader and visual-tier fallback behavior.

### Real-browser acceptance

A deterministic Chromium fixture captures all four systems from lit, shadowed, backlit, and edge-on views. Pixel metrics require visible radial structure, a planet-shadow sector, planet ring-shadow band, brighter bounded backlight, Neptune arc localization, zero WebGL errors, and stable program count after warm-up.

A Saturn flythrough route crosses the ring plane. It records annulus/particle blend continuity, visible parallax motion, one particle draw call, no first-frame compile, stable heap after warm-up, and quality-rung instance counts.

### Performance and delivery

The standard test/lint/type/build/task/budget gates run in full. Asset ingest is repeated for hash stability. Browser regressions neighboring body tiers, lighting/post, surface detail, renderer policy, and governor all run. Native before/after benchmark evidence records FPS, frame/GPU percentiles, draw calls, triangles, programs, heap, renderer identity, and the required reference-hardware disclosure. Independent review and GitHub CI are required before merge.

## Explicit non-goals

- Gas-band differential rotation, storms, and Great Red Spot animation remain T0085.
- Volumetric multiple scattering, individual collision physics, spacecraft damage, and ring-moon gravitational perturbations are outside v1.
- Deferred launch tasks T0060–T0062 remain post-v1.
