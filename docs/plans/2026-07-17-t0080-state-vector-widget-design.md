# T0080 State-Vector Widget Design

**Date:** 2026-07-17  
**Task:** T0080  
**Status:** Approved under the maintainer's standing autonomous-development approval

## Goal

Add the bottom-right state-vector instrument specified by `docs/rendering-spec.md` §9. It visualizes the existing CM-relative snapshot values from `docs/physics-spec.md` §6 without changing `SimSnapshot`, `Commands`, or any simulation formula.

## Architecture

The feature has three small parts:

1. `src/render/stateVectorModel.ts` is Three.js-free render math. It writes normalized vector endpoints into a caller-owned `Float32Array`, exposes the documented per-quantity logarithmic scales, and formats the four magnitudes plus gamma and percent-c for the sampled DOM display.
2. `src/render/stateVectorWidget.ts` owns one miniature Three.js scene and orthographic camera. It creates the ecliptic grid, axis triad, four anti-aliased `Line2` vectors, and glow-tip sprites once. Each frame it mutates only preallocated geometry, transforms, visibility, viewport/scissor state, and a scalar timing sample.
3. `src/ui/StateVectorPanel.tsx` supplies the transparent bottom-right frame, legend/readouts, and a camera/ecliptic orientation toggle. It publishes the panel rectangle only on layout events and updates text at the existing 10 Hz HUD cadence.

`src/main.ts` wires the parts. The widget updates after the main camera and renders after the post-processing output using the same `WebGLRenderer`. Renderer viewport, scissor, scissor-test, and auto-clear state are restored before the next frame.

## Visual design

- A square instrument sits below the existing energy panel on desktop, with a translucent border and a reserved WebGL window in its upper portion.
- The ecliptic plane is a subtle polar grid disc. X/Y/Z axes use low-contrast red/green/blue lines.
- Velocity, acceleration, momentum, and angular momentum use distinct cyan, amber, magenta, and violet lines. Each is a single `Line2` draw with a small additive glow sprite at its tip.
- Labels remain DOM text for crispness, accessibility, and no runtime font atlas. The legend repeats each vector color and its SI-formatted magnitude; gamma and percent-c sit in a compact footer.
- Default orientation copies the inverse view rotation of the main camera, so the triad behaves like an inset world compass. Pinning switches to a fixed oblique ecliptic view, making +X/+Y/+Z stable.
- On narrow/short layouts the panel joins the existing scroll column. Its cached viewport rectangle is refreshed on resize and scroll, never measured in the frame loop.

## Scaling and invalid data

The four quantities cannot share one numeric scale because they have different dimensions. Each uses the same monotonic logarithmic curve with quantity-specific physical bounds:

`length = minLength + (maxLength - minLength) * clamp(log10(magnitude / minMagnitude) / log10(maxMagnitude / minMagnitude), 0, 1)`

Nonzero values below the lower bound retain `minLength`; zero and non-finite vectors are hidden. Bounds are constants named with units and covered by tests. Velocity is explicitly bounded from 30 km/s to `0.99c`, so both the LEO start state and near-relativistic state remain readable. Acceleration uses the drive's meaningful milli-g through 1 g range. Momentum derives corresponding values for the 10,000 kg v1 ship, while angular momentum uses a broad solar-system operational range. Labels always show the unscaled physical magnitude, so scale saturation never hides the actual value.

## Performance

- All scenes, cameras, materials, geometries, typed arrays, sprites, and callbacks are constructed during startup.
- Per-frame updates use indexed scalar math and mutate existing buffers. No arrays, objects, closures, strings, DOM queries, or renderer resources are created in the rAF path.
- The widget measures its own CPU submission interval into a scalar exposed to telemetry/debug data. A deterministic browser regression collects a warm sample window and gates p75 below 1 ms on reference hardware; CI records rather than interprets software-renderer absolute time.
- Widget shaders are precompiled during startup with the main renderer.

## Verification

- Unit tests cover vector direction, zero/invalid handling, all four log curves, monotonicity, the literal 30 km/s → 0.99c velocity range, and SI formatting.
- Renderer tests cover setup-time resource reuse, scissor/viewport restore, orientation modes, and no replacement of geometry/material objects across updates.
- UI tests cover all readouts, toggle semantics, and cached viewport publication.
- A Playwright regression verifies visible pixels in the scissored region, LEO velocity near 30 km/s, gamma/%c labels, orientation toggle, no console errors, and widget p75 telemetry.
- Full lint, typecheck, Vitest, build, budgets, task schema, smoke/render regressions, heap gate, and before/after flight benchmark are required before review.

## Non-goals

- No changes to physics or snapshot contracts.
- No new runtime dependency.
- No trajectory prediction, warning markers, or energy-ledger redesign.
- No user persistence for the orientation toggle in T0080; it resets to camera-follow on reload.
