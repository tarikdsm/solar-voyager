# ADR-031: Hybrid observer-frame relativistic rendering

**Status:** accepted (2026-07-18)

## Context

The simulation already exposes the ship coordinate velocity, speed fraction of
light, and Lorentz factor. M6 needs observer-frame aberration, Doppler color
shift, and headlight beaming without changing simulation state, breaking the
camera-relative precision boundary, or adding frame-loop allocations. A pure
screen-space warp cannot reveal sources that begin outside the camera frustum,
while patching every material duplicates boost logic and makes later render
paths easy to miss.

## Decision

Use a hybrid render-only model:

1. `SimSnapshot.shipCoordinateVelocityKmS` is the single velocity source. No
   simulation interface changes are required.
2. Camera-relative object and point directions are aberrated at the shared
   `CameraRelativeSpaceScene` boundary. The starfield applies the same transform
   in its vertex shader so off-axis stars can enter the observed frustum.
3. Near-field geometry keeps its shape and receives a rigid angular translation
   based on its camera-relative center. This deliberately avoids unphysical
   per-vertex stretching in the first implementation.
4. One HDR full-screen pass, inserted before bloom, applies the bounded Doppler
   color mapping and headlight-beaming gain defined in the rendering spec.
5. The effect fades from identity over Lorentz factor 1.0 to 1.05. Quality tiers
   1 and 2, plus the direct software fallback, keep it disabled. The identity
   path adds no draw call.

## Consequences

- Physics remains deterministic and untouched; all presentation choices stay in
  the render layer.
- Directional aberration is shared by bodies, point sprites, trajectories, and
  stars without per-material duplication.
- Active high-quality rendering costs one additional full-screen draw and no
  additional render target.
- Near-field geometry is an intentional approximation and can later be replaced
  independently if ray-based rendering becomes justified.

## Alternatives considered

- **Full-screen spatial warp only:** rejected because it clips sources using the
  unboosted frustum and cannot reconstruct newly visible sky.
- **Patch every scene material:** rejected because it duplicates uniforms and
  shader logic across unrelated asset paths.
- **Render an observer cubemap:** deferred because six scene renders exceed the
  v1 frame budget.
