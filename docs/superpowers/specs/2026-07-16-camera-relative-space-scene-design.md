# Camera-relative SpaceScene design

## Goal

Establish the only physics-position-to-render-position boundary in the game.
Physics and camera positions remain heliocentric binary64 kilometres; every
rendered visual is recomputed relative to the camera before Three.js sees it.
The Three.js camera remains at scene origin permanently.

## Scope and depth strategy

T0040 owns `src/render/spaceScene.ts`, the camera frustum, the explicit float32
bridge, and the logarithmic-depth fallback requested by the task. ADR-008 makes
reversed depth preferable when `EXT_clip_control` exists, but current Three.js
r185 does not automatically fall back from a requested reversed buffer to a
logarithmic buffer. Requesting both also keeps logarithmic-depth shader work
enabled when reversed depth succeeds.

T0045 already owns GPU context policy, extension detection, retry behaviour,
software-rasterizer reporting, and depth telemetry. It will select exactly one
of reversed or logarithmic depth at startup. Until then, T0040 enables the safe
logarithmic path. This keeps T0040 testable without prematurely implementing
half of T0045.

## Runtime contract

`CameraRelativeSpaceScene` owns a `THREE.Scene`, a `PerspectiveCamera`, and
parallel setup-time arrays of bound `Object3D` instances and caller-owned
heliocentric position sources. Its public operations are:

- bind a visual once during scene setup;
- update every bound visual from one caller-owned camera position each frame;
- expose the scene and origin-locked camera to the renderer.

The update loop computes each component as `Math.fround(body64 - camera64)`.
Subtraction therefore happens in JavaScript binary64 before the one explicit
float32 rounding boundary. It writes through the existing Three.js `Vector3`,
updates the existing matrix, and allocates nothing. Positions are never
accumulated in render space. Repeating an earlier camera position reproduces the
same render coordinates exactly.

Bindings set `matrixAutoUpdate = false`; geometry, materials, bindings, and
position-source objects are all setup-time allocations. A duplicate binding is
rejected during setup to avoid ambiguous updates. Non-finite input is rejected
when a binding/update enters the boundary, outside the normal valid hot path.

## Frustum and scale

One scene unit is one kilometre. The camera uses near `0.001` km and far
`1e10` km. Tests model Earth at a large heliocentric coordinate and verify a
surface view at 200 km as well as a one-AU view. The near surface must retain
sub-kilometre precision after absolute-position cancellation, while the
one-AU float32 error remains bounded and the body stays inside the frustum.

## Integration

The existing scaffold scene becomes a consumer of `CameraRelativeSpaceScene`.
Its setup-only cube remains temporary, but now has a binary64 heliocentric
position and the animation loop updates it through the canonical boundary. The
camera no longer moves away from origin. T0041 will replace the placeholder
visual with the tier ladder without changing the position bridge.

## Verification

- Unit tests cover origin lock, near/far constants, 200 km cancellation,
  one-AU precision, non-accumulation, setup-time binding rules, and log-depth
  renderer parameters.
- A static invariant test permits explicit `Math.fround` position conversion
  only in `src/render/spaceScene.ts`.
- Full lint, typecheck, test, build, task-schema, and budget checks must pass.
- Because this touches `render/`, the PR records the available deterministic
  checks; the M3 bench harness does not yet exist and cannot supply before/after
  hardware numbers in T0040.
