# T0084 Procedural Sun Design

## Scope

T0084 makes the procedural Sun the primary tier-2/tier-3 rendering path while
retaining the authored Sun texture and material as a switchable fallback. It
adds animated photospheric granulation, visible-spectrum limb darkening, a
billboard corona, deterministic prominence arcs, and three procedural-cost
rungs for the future quality governor. It does not add sunspots, flares, lens
artifacts, a settings UI, or the adaptive governor itself.

The work remains entirely in `render/` and test/tool code. It does not change
`SimSnapshot`, `Commands`, `bodies.json`, or any physics formula, so no new ADR
is required.

## Considered approaches

1. Replace every Sun material with one custom `ShaderMaterial`. This gives
   complete control, but breaks the existing tier crossfade and makes the
   authored material a second rendering path that must be maintained in
   parallel.
2. Bake a procedural photosphere at load time. This is inexpensive per frame,
   but cannot satisfy the requirement that convection and prominences respond
   to simulation time and warp.
3. Extend the existing Lambert/Standard Sun materials for the disc and replace
   the current static glare sprite with one procedural billboard. This keeps
   the tier/fallback machinery, costs no additional production draw relative to
   the existing glare, and separates photosphere shading from off-limb effects.

Approach 3 is selected.

## Architecture

`src/render/proceduralSun.ts` owns one `ProceduralSun` controller. The
controller:

- creates one setup-time plane geometry and additive shader material for the
  corona and prominence arcs;
- binds that billboard to the packed Sun position through
  `CameraRelativeSpaceScene`;
- augments eligible tier-2 and tier-3 Sun materials through `onBeforeCompile`
  and a stable `customProgramCacheKey`;
- owns shared, preallocated uniforms for seed, bounded simulation-time phases,
  enable state, and procedural quality; and
- exposes `update(simTimeSec)`, `setQuality(quality)`, `setEnabled(enabled)`,
  `prepareMaterial(material)`, and `dispose()`.

The quality type is `'full' | 'half' | 'minimum'`, mapped to four, two, and one
noise octaves. The shader has one fixed program with uniform branches around
the optional octaves; quality changes do not compile a program during play.
This is the interface T0091 can consume later.

`createEpochWorld.ts` reads the existing Sun `visual.proceduralSeed`, creates
the controller, passes its material-preparation port to `BodyVisualSystem`, and
returns it as part of `EpochWorld`. `BodyVisualSystem` prepares both tier-2 Sun
materials during construction and every supported material on the lazy tier-3
Sun model before `compileAsync`. `main.ts` advances the controller with
`snapshot.simTimeSec`, so game warp accelerates the visible solar evolution.

`SolarLighting` retains only the ambient/directional light model. Its current
static glare sprite is removed because the new procedural billboard occupies
the same draw and visual role.

## Disc shading

The material extension sends normalized object-space position to the fragment
shader. No UV participates in the procedural path, so there is no longitude
seam or texture tiling. A seeded three-dimensional gradient/value field builds
domain-warped fBm. Full quality evaluates four bounded octaves, half evaluates
two, and minimum evaluates only the base octave. The full octave range spans
large convection cells down to approximately granule-scale breakup without
creating textures or geometry at runtime.

Animation uses two periodic phases derived from simulation time. The primary
granulation cycle is 600 simulation seconds, consistent with the observed
roughly six-to-twenty-minute evolution range. The JS update reduces time into
bounded phase values and the shader uses periodic sine/cosine motion, so phase
wraps do not pop and arbitrarily large warp values do not lose float32
precision.

The emitted HDR colour interpolates between orange intergranular lanes and
pale yellow-white cell centres with restrained contrast. It replaces
`outgoingLight` immediately before Three's opaque-output chunk, so the Sun is
self-luminous and independent of the directional light while material opacity,
ACES tone mapping, bloom, and tier crossfades remain intact.

Visible-spectrum limb darkening uses the normalized quadratic profile

`I(mu) = 1 - 0.52 * (1 - mu) - 0.16 * (1 - mu)^2`,

where `mu` is the view-normal cosine. The centre intensity is 1.0, the midpoint
at `mu = 0.5` is 0.70, and the mathematical limb is 0.32. These targets preserve
the strong but non-black limb visible in HMI continuum imagery. Granulation
contrast tapers near the limb to avoid a noisy silhouette.

When disabled, the extension leaves Three's authored map/emissive result
untouched. This makes the existing static asset the explicit fallback rather
than a second mesh or download.

## Corona and prominences

The billboard is an eight-solar-radius camera-facing quad, matching the current
glare footprint. Its vertex shader constructs the quad in view space, so the
object needs only the allocation-free packed Sun translation.

The fragment shader combines:

- a soft HDR radial corona outside the solid disc, with low-amplitude seeded
  angular rays and slow periodic motion; and
- three fixed-cost signed-distance prominence arcs between 1.0 and 1.55 solar
  radii. Seeded angles, widths, and phase offsets make the arcs deterministic.
  Smooth periodic activity gates make individual arcs appear occasionally.

The billboard uses additive blending, `depthTest: true`, and
`depthWrite: false`. The solid sphere therefore occludes the on-disc half of an
arc while its off-limb loop remains visible. All loops and optional octave
branches have compile-time upper bounds.

## Performance and lifecycle

All geometry, materials, uniforms, and shader variants are created and warmed
during world initialization or lazy model compilation. The frame path only
mutates existing uniform scalars/vectors. It allocates no arrays, objects,
closures, strings, materials, geometries, textures, or render targets.

The procedural billboard replaces the existing glare draw, so the production
draw count does not increase for off-limb effects. Disc shading adds ALU but no
draw. The fixed uniform quality branches allow the low rungs to skip work
without a runtime shader compile. `dispose()` removes the billboard, releases
its geometry/material, restores chained material hooks, and leaves the
authored fallback resources owned by their original loader.

Invalid radius, packed offset, seed, simulation time, or quality values fail
at the public boundary. A disabled controller hides the billboard and selects
the base material path without allocating.

## Verification

Unit tests cover seed validation, bounded periodic phase updates, stable
uniform identity, quality-to-octave mapping, hook chaining/cache keys, fallback
selection, billboard resource policy, and idempotent disposal. Every production
change follows red-green-refactor TDD.

A production WebGL regression captures:

- a close photosphere view for granulation, radial-profile, animation-delta,
  and horizontal/vertical repetition metrics;
- Mercury-, Earth-, and Neptune-distance views proving a readable disc/glare
  across the required scale range;
- off-disc warm pixels proving prominence visibility and a smooth corona; and
- program counts before warm-up, after warm-up, and after first render.

The close-view radial profile is measured on an isolated photosphere capture
with the corona and bloom disabled so neither contaminates the disc annuli.
The shader contract locks the linear
`I(μ) = 1 - 0.52(1 - μ) - 0.16(1 - μ)²` coefficients directly. After the
production ACES output transform, the inner-disc (0.45–0.60 projected radius)
ratio must remain between 0.94 and 1.02 and the inside-limb (0.92–0.98 radius)
ratio between 0.85 and 0.95. These display-space bands replace the earlier
0.60–0.80/0.25–0.45 draft bands, which were mathematically inconsistent with
the approved linear profile and also sampled the off-disc corona.
The animated capture must change local structure without changing mean disc
luminance by more than 2%. Spatial autocorrelation and quadrant-local energy
checks reject obvious stripes, repeated blocks, or dead regions. Human review
of the generated screenshot set remains an acceptance gate.

An isolated hardware GPU query compares a full-screen close Sun at full and
minimum quality with identical camera, resolution, warm-up, and sample count;
the minimum rung must show a lower p75 GPU time. The normal production
benchmark records adjacent before/after 1920x1080 results, errors, draw calls,
triangles, programs, textures, heap endpoints, and available-GPU limitations.
All repository lint, typecheck, formatting, Vitest, Python/tool, browser,
build, budget, asset, and task-schema gates run before review.

## Visual references

- [NASA SDO first-light HMI continuum imagery](https://sdo.gsfc.nasa.gov/gallery/firstlight/)
  provides the visible-light photosphere and limb reference.
- [NASA SVS HMI intensity sequence](https://svs.gsfc.nasa.gov/4892/) provides
  full-disc limb darkening and changing photospheric structure.
- [NASA SVS Hinode granulation](https://svs.gsfc.nasa.gov/3412) provides the
  close cellular morphology reference.
- [NASA prominence overview](https://eclipse2017.nasa.gov/solar-prominences)
  provides the off-limb loop silhouette and warm emission reference.
