# Visual tier ladder design

## Goal and scope

T0041 replaces the scaffold cube with true-scale catalog body visuals. Every
body always has a point and sphere fallback; a body with a runtime manifest
entry may additionally load its full glTF. The selected representation changes
with projected angular diameter while the physical radius and camera-relative
position remain unchanged.

This task owns tier selection, batched point rendering, sphere/model lifecycle,
lazy loading, and a real-browser fly-in regression. Lighting, bloom, surface
detail, and interactive camera controls remain in T0043, T0082, and T0044.

## Considered architectures

1. **One Sprite/Mesh controller per body.** This is simple, but produces one
   draw call for every distant body and violates the repeated-object batching
   rule.
2. **One point cloud plus per-body near visuals (selected).** All tier-1 bodies
   share one `Points` draw call. Tier-2 meshes share one immutable icosphere
   geometry but retain per-body materials. Tier-3 glTF roots exist only for
   bodies whose assets have loaded. This fits lazy loading and keeps the hot
   loop indexed and allocation-free.
3. **Texture arrays and fully instanced bodies.** This minimizes draw calls but
   requires a fixed texture atlas/array and therefore conflicts with independent
   per-body lazy loading. It is unnecessary for the small number of bodies that
   can be visually large at once.

## Projected size and hysteresis

For a body outside its surface, the angular diameter is

`diameterRad = 2 * asin(min(1, radiusKm / distanceKm))`.

For a perspective camera with vertical field of view `fovRad` and viewport
height `heightPx`, projected diameter is

`diameterPx = diameterRad * heightPx / fovRad`.

The nominal boundaries are 1.5 px (point/sphere) and 200 px (sphere/model).
Twenty-percent hysteresis is applied around both boundaries:

- point -> sphere at 1.8 px; sphere -> point below 1.2 px;
- sphere -> model at 240 px; model -> sphere below 160 px.

Large single-frame jumps may select the final tier directly. If the requested
asset is not ready, the best loaded lower tier remains visible. Selection never
changes object scale, so representation changes cannot alter angular size.

## Components and data flow

### `visualTier.ts`

A Three-free module computes projected diameter and the hysteretic target tier.
It validates setup parameters, but its valid update path uses only scalar math
and creates no objects.

### `BodyPointCloud`

One preallocated `BufferGeometry` holds camera-relative positions, display
color, point size, and opacity for every catalog body. A single precompiled
shader renders circular sub-pixel points. Point diameter never exceeds the
1.5 px tier boundary; intensity comes from apparent magnitude rather than
artificial geometric scaling.

For reflected bodies, the brightness ratio against the Sun at the observer is

`p * phase(alpha) * radiusKm^2 * observerSunKm^2 /
 (bodySunKm^2 * observerBodyKm^2)`,

where `p` is geometric albedo and `phase(alpha)` is the Lambert phase function.
The Sun uses inverse-square dimming from its -26.74 apparent magnitude at 1 AU.
The shader receives bounded linear intensity and catalog color. Edge cases at
zero distance use finite saturated values.

### `CameraRelativeSpaceScene`

T0041 extends the existing boundary with setup-time bindings for packed
`Float64Array` body positions and the batched point-cloud position attribute.
Only this module performs `Math.fround(body64 - camera64)`. The normal frame
update remains an indexed, allocation-free loop.

### `BodyVisualSystem`

The system owns parallel arrays of body definitions, tier state, fade state,
prebuilt sphere meshes/materials, optional model roots, and load state. It binds
each near-visual root and the point cloud to `CameraRelativeSpaceScene` during
setup. Each frame it:

1. computes float64 camera/body distance and projected size;
2. updates the hysteretic desired tier;
3. starts a missing load at most once;
4. advances preallocated crossfade scalars;
5. writes existing visibility, opacity, and point attributes.

Point/sphere and sphere/model handoffs crossfade over 250 ms. A load completion
first precompiles the new scene with `renderer.compileAsync`; only then may its
fade start. Loaded model materials are collected once into setup/load-time
arrays, never by per-frame traversal.

## Asset loading and caching

`BodyAssetLoader` reads the validated runtime manifest and owns one promise
cache per URL/tier. Sun, Earth, and Moon are the only eager body ids, and only
their sphere-tier resources are eager. Full glTF models and tier-3 maps always
remain threshold-triggered, including for those three bodies. All other bodies
begin with catalog-color point/sphere fallbacks and issue no model or texture
requests until their first upward threshold crossing. Missing manifest entries
remain on their best fallback without a failing request loop.

The Three.js addon loaders are dynamically imported. One `KTX2Loader` is reused
after `detectSupport(renderer)` and one `GLTFLoader` reuses configured KTX2 and
Draco decoders. The exact decoder/transcoder files from the pinned Three.js
package are committed locally with its license, so runtime loading does not
depend on a third-party CDN. Ingest emits dedicated sphere-tier KTX2 albedo at
2048 px for planets and 1024 px for moons/dwarfs; the glTF tier retains the full
authored maps. The runtime manifest lists these derivatives explicitly instead
of inferring files that may not exist.

Promise rejection is converted into a permanent per-tier failed state with a
single diagnostic. The current fallback remains visible. No automatic retry
occurs inside the frame loop.

## Initial-path budget

T0041 introduces an explicit generated initial-path manifest. It contains the
Earth/Moon sphere albedos, the star payload, and other resources actually
required before the first interactive frame; full hero glTF/maps are lazy and
therefore absent. The budget checker continues conservatively counting every
built JS/WASM file, including loader code and local codecs, and adds exactly the
runtime files named by this manifest. It validates containment, duplicates, and
existence. The 8 MiB threshold is unchanged.

This corrects the pre-tier checker, which classified every file containing a
hero body name as startup-critical even after T0041 made full tiers lazy.
Because this refines the startup interpretation recorded by ADR-022, T0041 adds
a superseding ADR that preserves its texture-quality decision while moving full
Moon/Earth tier-3 resources out of the first-frame path.

## Runtime integration

The entry point compiles the existing rails catalog at J2026 and evaluates its
packed heliocentric positions once until SimulationCore arrives in T0050. The
camera starts 400 km above Earth, matching the v1 roadmap. All catalog bodies
are registered in the tier system; bodies without delivered assets still show
their physically sized catalog-color fallback. The scaffold cube is removed.

Initial hero sphere preloads settle before the first shader compilation/render.
Because the LEO camera requests Earth's model tier immediately, the first frame
shows its true-scale sphere while the full model loads; the model is precompiled
and then crossfades in. Main-thread updates reuse the same packed positions and
camera object every frame.

## Verification

- Unit tests cover angular size, both hysteresis bands, direct jumps, magnitude
  finiteness, one-shot load state, crossfade continuity, and packed
  camera-relative bindings.
- A static invariant continues to permit physics-position `Math.fround` only in
  `spaceScene.ts`.
- A Playwright/Vite fly-in fixture moves from a one-AU Earth view to 400 km LEO,
  samples every tier, asserts that consecutive frames never go dark, and checks
  crossfade opacity continuity.
- The same browser test records requests: only hero allowlist assets may load at
  startup; a non-hero model/texture URL must be absent before its approach and
  present exactly once afterward.
- Browser console/page errors, WebGL errors, lint, typecheck, unit/tool tests,
  production build, task schema, asset budgets, and before/after scaffold bench
  must all pass.
