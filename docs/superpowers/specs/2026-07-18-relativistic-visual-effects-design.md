# Relativistic Visual Effects Design

**Task:** T0081
**Status:** Approved by the maintainer's autonomous-execution instruction
**Scope:** Aberration, Doppler color shift, and headlight beaming for the v1
render path. No simulation or public snapshot changes.

## Goals

- At 0.9c, compress apparent directions toward the velocity vector, blueshift
  the forward sky, redden the aft sky, and visibly beam forward intensity.
- Approach the identity continuously as gamma approaches one.
- Disable all additional runtime work at low quality and while the effect is
  physically negligible.
- Preserve the existing camera-relative float64-to-float32 boundary and the
  zero-allocation frame-loop contract.
- Add at most one draw call when the post effect is active and no draw calls
  when it is inactive.

## Non-goals

- General-relativistic lensing, gravitational redshift, or light-time delay.
- Lorentz contraction of individual meshes or Terrell rotation.
- Spectral reconstruction from arbitrary RGB body textures.
- A new simulation field or command.

## Considered approaches

### Full-screen warp only

Reconstruct an observed ray per pixel, inverse-aberrate it, and resample the
existing frame. This is compact but cannot reveal sources outside the original
camera frustum. At high beta it compresses only the already-visible image and
leaves missing edge information, so star and body directions are not correct.

### Per-material vertex patches

Apply the exact direction transform independently to every star, sprite,
line, Lambert sphere, procedural shader, and loaded glTF material. This can be
exact but duplicates a fragile shader patch across unrelated render resources
and would make future assets responsible for observer physics.

### Camera-boundary transform plus spectral post pass (selected)

The existing `CameraRelativeSpaceScene` already writes every bound body,
point batch, marker batch, and polyline into render coordinates. It will apply
one observer-direction transform while doing that write. The static starfield,
which intentionally bypasses the camera-relative position arrays, receives the
same transform in its vertex shader. A single HDR post pass then applies
Doppler color mapping and headlight beaming to the complete canvas before
bloom. Hero geometry is approximated as a rigid angular translation, matching
the rendering spec without patching loaded materials.

This approach has one formula owner, one extra active draw call, no additional
render target, and a literal zero-cost inactive branch outside the existing
camera-relative loops.

## Physical model and specification changes

T0081 adds ADR-031 and a new observer-rendering subsection to
`docs/physics-spec.md` section 6. For observer velocity `beta = v/c`, gamma,
and rest-frame source direction `n`, the apparent direction is

```text
q = beta dot n
k = ((gamma - 1) / |beta|^2) q + gamma
n_observed = (n + k beta) / (gamma (1 + q))
```

The equivalent Doppler factor evaluated from the observed ray is

```text
D = 1 / (gamma (1 - beta dot n_observed))
```

The physical monochromatic beaming basis is `D^3`. Rendering clamps the final
exposure multiplier to a finite artistic range after evaluating that physical
factor; the clamp and RGB approximation live in `rendering-spec.md`, not in
simulation state.

The displayed direction uses
`normalize(mix(n, n_observed, smoothstep(1, 1.05, gamma)))` and preserves the
original camera-relative radius. The interpolation is a presentation fade,
not another physical frame. At gamma one it is exactly the identity.

## Components

### Relativistic visual state

`src/render/relativisticVisualState.ts` owns setup validation and the
allocation-free per-frame scalar state:

- beta in heliocentric ecliptic J2000 axes;
- gamma;
- smooth activation strength;
- quality permission.

It reads `shipCoordinateVelocityKmS`, `gamma`, and
`speedFractionOfLight` from `SimSnapshot`. Non-finite or inconsistent input is
rejected in focused tests; normal runtime snapshots remain the trusted source.

### Relativistic visual controller

`src/render/relativisticVisualController.ts` coordinates three consumers:

- `CameraRelativeSpaceScene.setRelativisticObserver(...)`;
- `Starfield.setRelativisticObserver(...)`;
- `RelativisticPostPass.updateObserver(...)`.

It owns reusable `Vector3`/`Matrix3` scratch values and converts beta into view
axes without allocating. `RenderQualityController` supplies a boolean quality
permission. The effect is permitted for quality tier 3 and above and disabled
for tiers 1-2, including the manual low lock.

### Camera-relative geometry

`CameraRelativeSpaceScene` keeps an identity fast path when activation is
zero. In the active path, each already-required camera-relative write applies
the direction transform while preserving radius. This covers individual body
roots, the distant-body point cloud, trajectory markers, osculating/predicted
lines, and future resources bound through the same APIs. Existing float64
source positions are never mutated.

Bounding volumes are rebuilt from the transformed float32 output exactly as
they are today. No geometry, material, array, object, or closure is created in
`updateCameraRelative()`.

### Starfield

The starfield shader receives stable uniforms for beta, gamma, and activation.
It transforms each unit catalog direction before multiplying by the fixed sky
radius. The identity branch retains the current depth strategy, size, opacity,
draw range, and one-draw-call behavior.

### HDR Doppler/beaming pass

`src/render/relativisticPostPass.ts` is one reusable `ShaderPass` inserted
between `RenderPass` and `UnrealBloomPass`. It reconstructs an observed view
ray from UV, aspect, and vertical FOV, evaluates `D`, then:

- maps `log2(D)` to bounded RGB channel gains (blue forward, red aft);
- normalizes the hue gain so headlight intensity remains a separate term;
- multiplies intensity by clamped `D^3`;
- blends both operations by activation strength.

The pass reuses the composer's existing half-float ping-pong targets. It is
disabled when activation is zero, quality disallows it, or post-processing is
unavailable. Warm-up temporarily enables it so the shader compiles before the
first relativistic frame.

The exact presentation mapping is:

```text
x = clamp(log2(D), -2, 2)
g = exp2(x * (-0.20, 0.05, 0.35))
g_normalized = g / dot(g, (0.2126, 0.7152, 0.0722))
color_shifted = color * g_normalized
beaming = clamp(D^3, 0.20, 8.0)
output = mix(color, color_shifted * beaming, activation)
```

These constants deliberately preserve approximate Rec.709 luminance in the
hue-only term, keep the aft sky legible, and leave HDR headroom for ACES and
bloom. They are acceptance-tested constants, not runtime quality knobs.

## Frame flow

```text
sim.step() -> SimSnapshot
camera update -> camera matrices
RelativisticVisualController.update(snapshot, camera)
CameraRelativeSpaceScene.updateCameraRelative(cameraPosition)
RenderPass -> RelativisticPostPass -> bloom -> AA -> output
state-vector scissor viewport (unchanged, not color shifted)
```

The state-vector widget remains an instrumentation overlay and intentionally
renders after the cinematic post chain.

## Quality and performance

- `RenderQualityController` applies the profile's tier to the relativistic
  controller alongside the existing knobs.
- Tiers 1-2 and software-renderer fallback disable the feature.
- Gamma one disables the post pass and uses the existing camera-relative fast
  path, so the normal LEO workload golden remains unchanged.
- Active high quality adds one full-screen draw call and no render target.
- Shader resources are allocated at startup and compiled by `warmUp()`.
- The hardware benchmark records before/after p75/p99, GPU time, draw calls,
  triangles, heap, and bundle size with the scripted near-c checkpoint active.

## Validation

### Unit tests

- Aberration identity at beta zero and activation zero.
- At beta 0.9 along +Z, a perpendicular ray becomes `(1/gamma, 0, 0.9)`;
  forward and aft rays remain collinear.
- Radius preservation and finite output for valid beta below one.
- Activation is continuous at gamma one and 1.05.
- Low quality disables all three consumers; high quality enables them.
- Starfield uniforms/resources remain stable across updates.
- Post chain order is render, relativistic, bloom, AA, output; inactive render
  skips the relativistic pass; warm-up compiles it.
- Camera-relative bindings transform bodies, points, and polylines without
  changing source float64 arrays or resource identities.

### Browser regression

A deterministic render page shows a star/body direction grid at beta zero,
just below/above the activation endpoint, and 0.9c. Pixel/projection metrics
must prove:

- forward angular compression matches the analytic expectation;
- forward blue/red ratio increases while aft ratio decreases;
- forward luminance exceeds aft luminance;
- the activation-threshold image delta is continuous;
- inactive/low-quality frames retain the baseline workload;
- no console, page, or WebGL errors occur.

The regression is added permanently to CI.

### Delivery gates

Run focused Vitest suites, full Vitest, lint, typecheck, Prettier, build,
browser smoke/regressions, asset and task checks, performance gates, and the
hardware benchmark. The PR records before/after benchmark evidence and does
not weaken the 60 fps floor or heap-growth contract.

## Error handling and lifecycle

All public setup/update inputs reject non-finite values and beta greater than
or equal to one. Runtime state updates are transactional: validation completes
before consumer uniforms/scalars are changed. `dispose()` releases the new
post material once; existing scene/starfield ownership remains unchanged.
There is no retry path because the feature owns no I/O. If post-processing is
unavailable, rendering remains on the established direct-render fallback with
relativistic visuals disabled.
