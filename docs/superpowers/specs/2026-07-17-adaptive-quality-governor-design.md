# T0091 adaptive quality governor — design

## Goal

Hold the 60 FPS floor with a deterministic, allocation-free control loop while
making the least visible quality sacrifice first. The persisted quality lock is
authoritative and the performance HUD reports the actual applied state.

## Control law

- `RenderTelemetry.snapshot.p75FrameMs` is sampled only when its stable
  `frameCount` changes. Re-reading one snapshot during intervening animation
  frames cannot advance the controller.
- In `auto`, two consecutive sampled windows above 15.5 ms step down once.
  Continuous headroom below 11 ms for 10 seconds steps up once. Values between
  the thresholds reset both streaks.
- A change starts a three-second cooldown and resets both streaks. Samples in
  cooldown are observed but cannot accumulate a pending change.
- `high`, `medium`, and `low` immediately select fixed profiles and suppress all
  automatic actions until the user returns to `auto`. Returning to auto starts a
  fresh cooldown at the locked profile.

## Ordered ladder and HUD tiers

The controller has 15 concrete profiles (baseline plus 14 downward steps), so
each action changes exactly one knob in the order required by
`performance-spec.md` section 3:

| Rung | Changed knob | Applied value | HUD tier |
| ---: | ------------ | ------------- | :------: |
| 0 | Baseline | full quality | Q6 |
| 1 | Render scale | 0.85 | Q6 |
| 2 | Render scale | 0.70 | Q6 |
| 3 | Render scale | 0.55 | Q5 |
| 4 | Bloom | half resolution | Q5 |
| 5 | Bloom | off | Q4 |
| 6 | AA | FXAA | Q4 |
| 7 | AA | off | Q3 |
| 8 | Procedural octaves | half | Q3 |
| 9 | Procedural octaves | minimum | Q2 |
| 10 | Star cap | 4,000 | Q2 |
| 11 | Star cap | 2,000 | Q2 |
| 12 | Texture cap | 2k on the next lazy load | Q1 |
| 13 | Texture cap | 1k on the next lazy load | Q1 |
| 14 | Tier-3 threshold | doubled | Q1 |

The six HUD tiers are a compact severity summary, not the controller step
count. Manual `high`, `medium`, and `low` map to rungs 0, 7, and 14.

## Runtime application

- `render/perfGovernor.ts` owns only scalar state and the control law. Profiles
  are module-level frozen data, and `update()` performs no allocations.
- `RenderQualityController` applies the post and remaining scalar controls to the
  starfield, procedural Sun, lazy asset policy, and body tier thresholds. Normal
  frames only compare the already-applied rung.
- One half-float composer is allocated, sized, and warmed at startup. Its two
  maximum-size color targets remain fixed; render-scale changes mutate only the
  existing target viewports/scissors, star point-size uniform, and preinstalled
  UV-scale uniforms, so the valid subregion is upscaled to the fixed drawing
  buffer without reallocating.
- The single bloom, SMAA, FXAA, and output passes use the same adaptive subregion.
  Half bloom narrows the already-downscaled bloom viewports. No material,
  geometry, pass, shader program, composer, or render target is created or
  resized by a rung transition.
- Texture caps affect only assets that have not entered a promise cache. The
  deterministic asset ingest emits real `_2k` and `_1k` variants for every
  model-bound texture plus capped GLBs whose image URIs reference only matching
  variants. The loader selects capped spheres, details, and models for subsequent
  uncached lazy bodies.
- The tier-3 threshold multiplier changes only numeric selection thresholds and
  reuses all existing body representations.

## Telemetry and verification

- `RenderTelemetry` keeps a preallocated 32-entry numeric action ring containing
  timestamp, previous/new rung, and reason code. The HUD consumes stable scalar
  state (`tier`, scale, controller status, last action).
- Unit tests cover every profile, exact thresholds, cooldown, repeated-snapshot
  immunity, headroom timing, limits, lock precedence, and the synthetic-load
  recovery/no-oscillation acceptance scenario.
- Browser regression drives real renderer knobs, checks internal-buffer and draw
  count changes, verifies render-target identity and heap stability across 1,500
  rung transitions, checks full-sky coverage of the 2k brightest-star subset,
  confirms no shader compilation after warm-up, and records one committed
  screenshot for every rung.
