# T0085 Gas-Giant Animation Design

## Scope

T0085 animates the existing tier-3 Jupiter, Saturn, Uranus, and Neptune surface
materials while retaining each authored albedo mosaic as the identity layer.
It adds latitude-dependent band drift, seam-free domain-warped turbulence,
subtle storm shimmer, and localized counterclockwise motion inside Jupiter's
Great Red Spot. It does not replace the source mosaics, add texture downloads,
animate tier-1/tier-2 representations, alter body geometry, or change physical
simulation state.

The work stays in `src/render/`, browser/tool tests, and rendering/performance
documentation. It reads the existing `visual.proceduralSeed` values from
`data/bodies.json` but does not change that schema, `SimSnapshot`, `Commands`,
or any physics formula; no ADR is required.

## Considered approaches

1. Overlay animated procedural colour noise on the existing material. This is
   inexpensive, but recognizable clouds and storms remain frozen, so it does
   not satisfy the motion requirement.
2. Generate animated texture atlases at load time. This can move real pixels,
   but adds startup work, memory, texture state, and either downloads or large
   generated resources while still providing only a finite animation loop.
3. Extend the existing `MeshStandardMaterial` and remap only its albedo UV in
   the fragment shader. The same authored texture remains authoritative, the
   deformation can vary by latitude and storm region, and quality changes are
   uniform-only with no new draw or texture.

Approach 3 is selected.

## Architecture

`src/render/gasGiantAnimationState.ts` owns stable uniforms for one gas giant.
The state validates the body id and uint32 seed, maps the shared procedural
quality rungs to four/two/one octaves, and converts arbitrary finite simulation
time into bounded phase vectors. Four band phases start with slightly different
rates and return through one smooth 64-base-rotation shear cycle, keeping every
adjacent interpolation on the same periodic branch. A separate phase drives
storm shimmer, and Jupiter receives a bounded counterclockwise Great Red Spot
phase. Updates mutate existing vectors and scalars only.

`src/render/gasGiantMaterial.ts` chains one extension onto the loaded
`mat_surface` `MeshStandardMaterial`. Its stable custom program cache key is
independent of time, seed, body, and quality because all variation is uniform
data. The extension computes an animated UV before Three's map chunk and lets
the existing surface-detail hook consume the same remapped UV. It exposes an
idempotent disposer that restores the previous compile hook and cache key.

`src/render/gasGiantAnimation.ts` combines the state and material extension
behind `update(simTimeSec)`, `setQuality`, `setEnabled`, and `dispose`. One
instance is prepared when each eligible tier-3 model is loaded, before
`renderer.compileAsync`. `BodyVisualSystem` owns the four possible instances,
advances them from the existing `simTimeSec` update argument, applies governor
quality changes, and disposes them in reverse hook order. No new frame-loop
object, collection, closure, string, or resource is created.

`BodyVisualDefinition` gains the already-catalogued `proceduralSeed`, and
`createEpochWorld` passes it through for every body. This is a render-local
interface change, not a catalog schema change. `RenderQualityController`
forwards `profile.proceduralQuality` to `BodyVisualSystem` as well as the Sun,
so both effects obey the same existing governor rung.

## Texture-preserving flow

The shader converts equirectangular UV to a unit sphere before evaluating
seeded three-dimensional value noise. Sampling noise in object-direction space
makes the field continuous at longitude 0/1. Full quality evaluates four
fixed-bound octaves, half evaluates two, and minimum evaluates one. Uniform
branches skip the unused work without changing the shader program.

The latitude coordinate selects four broad jet zones. One wrapped base phase is
combined with a bounded sinusoidal shear over 64 base rotations:
`phase_i = fract(basePhase + (multiplier_i - 1) * sin(shearAngle) * 64 / 2π)`.
The cycle begins at the configured rates, returns without a discontinuity, and
keeps every adjacent phase separation below 0.4 turns, so shortest-periodic
interpolation never changes branch. A seeded domain warp adds at most 0.006 UV
longitudinal displacement and 0.002 UV latitudinal displacement. These caps are
small enough to preserve belts, ovals, and mosaic provenance while making close
views visibly alive.

The base rotation periods are 9.9 h for Jupiter, 10.7 h for Saturn, 17.2 h for
Uranus, and 16.1 h for Neptune. Those values follow NASA's solar-system
overview; the four visual jet phases begin each bounded shear cycle at
deterministic multipliers around the base rate rather than claiming a scientific
wind-field reconstruction. Animation is driven by simulation time, so time warp
accelerates it naturally.

The albedo texture already contains Jupiter's Great Red Spot near UV
`(0.374, 0.640)`. Inside a smooth elliptical mask of radii `(0.068, 0.046)`,
the sampling coordinate rotates counterclockwise around that centre on a
stylized six-day loop. The mask fades before its boundary, retaining the
surrounding belt and wake. A maximum 1.5% luminance modulation supplies subtle
storm shimmer; it never recolours or replaces the source feature.

## Shader-hook ordering and lifecycle

Gas animation is installed before ring and close-range surface detail. The later
hooks chain their exact predecessors; both detail albedo and normal samples use
the persistent animated-surface UV macro, so the real mosaic and its existing
detail pair move as one surface. Setup remains local until compilation succeeds.
On any setup/compile failure, atmosphere, detail, ring, and gas controllers
dispose in reverse order, restoring their exact preceding callbacks/cache keys
before the model is marked failed. Lighting, opacity, ACES, bloom, and
tier-crossfade behavior stay unchanged.

The material must be a mapped `MeshStandardMaterial` named `mat_surface` and
the body id must be one of the four catalogued gas giants. Unsupported bodies
return no controller; malformed eligible materials fail during setup and make
the lazy model load fail through the existing error path. Disabling the effect
selects the exact authored UV and colour path without recompilation, which
provides the static side-by-side control.

Disposal first removes the surface-detail extension and then the gas extension.
The gas disposer restores the exact prior callbacks and marks the material for
the next setup-time compile. No production texture, geometry, or material is
owned or disposed by this feature.

## Performance contract

The feature adds no textures, geometry, render targets, materials, scene nodes,
or draw calls. It adds fragment ALU and one albedo sample already required by
the base material. All programs compile during tier-3 lazy loading via the
existing `compileAsync`; toggling time, enable state, body seed, or quality
cannot change the cache key.

The normal frame path performs four bounded state updates at most and mutates
preallocated uniform values. Minimum quality evaluates one noise octave and
must measure cheaper than full quality in an isolated GPU comparison. The
production performance gate, heap-growth-zero gate, bundle budget, and native
before/after benchmark remain mandatory. The available RTX 3070 Laptop GPU can
provide local comparative evidence, but the 1920x1080 integrated-reference
60-fps certification remains a maintainer hardware gate when that hardware is
unavailable.

## Verification

Unit tests follow red-green-refactor and cover body configuration, uint32 seed
validation, deterministic bounded phases, stable uniform identity, octave
mapping, exact static fallback, shader-hook chaining, one fixed cache key,
seam-free spherical noise input, UV displacement caps, Great Red Spot mask and
direction, unsupported material rejection, and idempotent disposal.

`BodyVisualSystem` tests prove that only the four eligible mapped tier-3
surface materials are prepared, all use their catalog seeds, simulation time
and governor quality reach every controller, compilation happens after hook
installation, and failure/disposal paths restore resources.

A production WebGL fixture renders each real tier-3 model at fixed close-view
cameras. It captures static, animated start, animated later, full, half, and
minimum states after warm-up. Pixel comparisons require both measurable motion
and high structural similarity to the static source; Jupiter also requires a
crop delta at least 1.25 times its control and lower error against a
counterclockwise rotated static reference than against the clockwise negative
control. Surface detail must be active in the same compiled shader. The fixture
records zero WebGL errors, stable program count after warm-up and quality
switches, unchanged draw count, exact octave uniforms, and all texture network
requests. The regression rejects any new texture URL.

An isolated quality benchmark compares full and minimum on the same close
Jupiter view, renderer, resolution, warm-up, and sample count. Repository
Vitest, Python tools, lint, typecheck, formatting, build, browser neighbors,
production performance, task schema, budgets, and `git diff --check` all run
before independent review.

## References

- [NASA solar-system overview](https://science.nasa.gov/learn/basics-of-space-flight/chapter1-2/)
  supplies the 9.9/10.7/17.2/16.1-hour approximate rotation context.
- [NASA Cassini Jupiter colour movie](https://science.nasa.gov/resource/cassinis-first-color-movie-of-jupiter/)
  shows adjacent bands moving at different rates and the Great Red Spot rotating
  counterclockwise while recognizable cloud systems persist.
- [Three.js Material documentation](https://threejs.org/docs/#api/en/materials/Material.onBeforeCompile)
  defines `onBeforeCompile` and `customProgramCacheKey`; the project remains on
  Three.js r185 and WebGLRenderer for this extension.
