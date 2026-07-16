# Lighting and post-processing design

## Goal

Add physically ordered solar illumination and a single HDR post-processing
chain without compromising the camera-relative or zero-allocation frame
contracts. Reflected bodies must have a genuinely dark night side, authored
emissive maps must remain visible, and the Sun must produce a controlled halo
without a full-screen or square artifact.

## Chosen pipeline

The production path is one Three.js `EffectComposer` with exactly three passes:

1. `RenderPass` renders the camera-relative scene into the composer's
   half-float ping-pong target chain;
2. `UnrealBloomPass` extracts bright pixels into its built-in half-resolution
   bright target and progressively smaller mip chain;
3. `OutputPass` applies the renderer's ACES filmic tone mapping and sRGB output
   conversion once, at the end.

The renderer uses `ACESFilmicToneMapping` with exposure 1.0. The composer is
created only after the renderer has its real CSS size and pixel ratio. Resize
events update the renderer and composer outside the frame loop. A setup-time
warm-up render compiles every post shader before the first animation frame.
The normal frame path calls only `composer.render()`; it creates no target,
pass, geometry, material, vector, closure, or other application-owned object.

`UnrealBloomPass` is configured with threshold 1.0, strength 0.15, and radius
0.35. Its official implementation creates the first bright target at half the
composer resolution, satisfying the downscaled-bloom rule without a redundant
copy or a second composer. Bloom can be enabled or disabled by mutating the
existing pass for the future adaptive governor.

Two alternatives were rejected. Renderer tone mapping without a composer
cannot provide the required bloom. A selective second composer/layer would
render eligible objects twice, require extra full-size targets and composite
passes, and make the draw/frame budget worse than the specified single chain.

## Solar lighting

`SolarLighting` owns exactly one `DirectionalLight`, its origin target, and one
`AmbientLight`. It reads the existing packed binary64 body positions directly;
the Sun and current focus are selected by setup-time numeric offsets. Its
allocation-free update computes:

```text
dKm = max(distance(sun, focus), solarRadiusKm)
directionalIntensity = π × (AU_KM / dKm)²
```

The factor `π` makes a normal-facing Lambertian surface reproduce its base
colour at 1 AU under Three.js' physically based light convention. The light is
placed one unit from the origin in the focus-to-Sun direction and targets the
origin, so its rays travel Sun-to-focus in the unchanged ecliptic axes. The
solar-radius clamp keeps a Sun-focused view finite while preserving inverse
square behaviour everywhere outside the photosphere. If Sun and focus are
coincident, the last valid direction is retained; direction is immaterial for
the emissive Sun itself.

Ambient intensity is exactly 0.02. Tier-2 reflected spheres use a lightweight
Lambert material instead of an unlit basic material, so their terminator and
night side respond to the same light. The Sun's sphere fallback is emissive.
Tier-3 glTF materials remain authored PBR materials: Earth's committed
`earth_emissive_night.ktx2` continues through its emissive map with minimum
intensity 4 at the fixed ACES exposure, and the Sun's authored emissive
material is guaranteed a minimum intensity of 4 at load time.

## Solar glare

One camera-facing `Sprite` is bound to the Sun through the existing canonical
camera-relative position bridge. Its 64×64 radial RGBA `DataTexture`, material,
and geometry are setup-time resources. The sprite spans four solar diameters,
uses additive HDR colour, depth-tests against opaque bodies, does not write
depth, and is tone-mapped with the scene. The opaque solar disc therefore hides
the sprite centre while the soft exterior supplies a glare source and the bloom
pass supplies the wider optical halo. There is no square edge because alpha
reaches zero before every texture boundary.

## Runtime integration

`createEpochWorld()` replaces its provisional lights with `SolarLighting`,
adds the glare sprite, updates lighting before scene shader compilation, and
returns both owners. The main startup resizes the renderer before world
creation, fixing initial tier selection against the real drawing-buffer height.
It then creates and warms the post pipeline. Each animation frame updates body
visuals, lighting, and camera-relative positions before calling the composer.

The pipeline and lighting owners expose deterministic `dispose()` methods for
tests and future navigation teardown. No simulation/core API, body schema,
snapshot, command, or physics formula changes, so no ADR is required. All
runtime code uses the already accepted Three.js dependency and official addons.

## Verification

- Unit tests lock the inverse-square intensity, direction, finite photosphere
  clamp, one-light topology, ambient 0.02, glare texture/scale/static state,
  Lambert sphere materials, Sun emission, ACES configuration, half-float
  targets, pass order, resize, bloom toggle, render delegation, and disposal.
- A real Chromium fixture uses the production pipeline and real Earth glTF.
  From an anti-solar three-Earth-radii view it requires a dark planetary disc with
  spatially localized nonzero night-light pixels.
- The same fixture renders a controlled emissive solar disc with bloom off and
  on. Bloom must add a soft, approximately symmetric exterior halo while
  corners remain black and the centre remains finite—making the test sensitive
  to missing bloom, square glare, and full-screen artifacts.
- The fixture reports HalfFloat composer buffers, half-resolution bloom bright
  target, ACES, one RenderPass, one bloom pass and one OutputPass, with no WebGL,
  console, or page errors.
- Existing depth, starfield and visual-tier browser regressions plus all local
  gates must remain green. Paired 120+600-frame software benchmark reports are
  committed. A second paired 1920×1080 run must reject software rasterizers and
  sustain the 60 Hz cadence on an integrated GPU before acceptance.
