# T0127 — Pass insertion API + adaptive exposure — design

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §6.2 and §12.3;
plan `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §3.5 and §5/T0127.

Two deliverables, in dependency order: a public ordering contract on
`render/lightingPostPipeline.ts` (consumed by T0142 god rays, T0141, and anything
after), then `render/exposureController.ts` as the single owner of
`toneMappingExposure`.

---

## 1. Landmines found in the existing code (read this first)

1. **`tools/tests/lightingPostRegression.mjs` freezes the pass order by class name.**
   `assertPipeline` does `assert.deepEqual(snapshot.passNames, ['RenderPass',
   'RelativisticPostPass', 'AdaptiveBloomPass', 'AdaptiveSmaaPass',
   'AdaptiveFxaaPass', 'AdaptiveOutputPass'])`. That gate is the proof that the
   default order is unchanged, so the API must add **nothing** to the chain until
   somebody calls `insertPass`. This is why exposure is *not* implemented as a pass
   (see §4).
2. **`SUN_EMISSIVE_INTENSITY = 4`** (`render/bodyVisualSystem.ts:67`) is a fixed,
   distance-independent radiance for the photosphere. It does not grow as you
   approach the Sun — the renderer is not radiometrically calibrated for the solar
   disk. This is what actually sets `E_min` (§5.3), not the irradiance.
3. **`AMBIENT_LIGHT_INTENSITY = 0.02`** (`render/solarLighting.ts:6`) is a *constant*
   ambient floor: `SolarLighting.update()` rescales only the directional light
   (`π·(AU/d)²`), never the ambient. At Neptune the ambient term is ≈5.8× the
   sunlight term, so the terminator is already washed out there *at any exposure*
   — exposure is a gain and cannot restore contrast. This is what sets `E_max`
   (§5.3) and it is a pre-existing lighting-model defect, not one this task
   introduces (handoff note).
4. **`composition.ts:1101`** writes `renderer.toneMappingExposure = 3` when
   post-processing is unavailable (`SOFTWARE_FALLBACK_EXPOSURE`). A "single owner"
   of `toneMappingExposure` has to absorb that, or the two writers fight.
5. **The `AdaptiveSmaa`/`AdaptiveBloom` private-field casts** (`this as unknown as
   …Internals`) fail *late and cryptically* today: if three.js renamed `_edgesRT`,
   the first error would be a `TypeError` on `undefined.width` inside a resize,
   in the browser, in a governor step. Contained in §3.
6. `docs/rendering-spec.md` §4 still describes the chain as
   `RenderPass → UnrealBloomPass → OutputPass` — stale since the relativistic and
   AA passes landed. Corrected in this task.

---

## 2. Ordering contract — the decision

The chain is a fixed spine of six pipeline-owned passes with four **anchors**
between them. `insertPass(pass, anchor)` places a pass immediately after the named
anchor stage, after any pass already inserted at the same anchor.

```
RenderPass                                   (always first — nothing precedes it)
  ├─ anchor 'scene'              → passes that need the raw HDR scene
RelativisticPostPass
  ├─ anchor 'relativistic'       → passes that must follow aberration (god rays)
AdaptiveBloomPass
  ├─ anchor 'bloom'              → passes that must not be bloomed (lens flare)
AdaptiveSmaaPass, AdaptiveFxaaPass
  ├─ anchor 'anti-aliasing'      → passes that must not be resolved by AA
AdaptiveOutputPass                           (always last — owns tone mapping)
```

Total order is a pure function of (anchor, insertion sequence), so two independent
callers cannot produce an order that depends on module-import order — only on the
anchor they each declared. That is the property a second caller needs.

**Ownership:** inserted passes are owned by the pipeline. `dispose()` disposes them
in reverse insertion order, and `applyQualityScale()` calls `setRenderScale` on any
inserted pass that implements it (duck-typed once, at insert time — never per
frame). This is the contract T0142 wants: hand over a pass, get resize, render-scale
and disposal for free.

### Rejected alternatives

- **`insertPass(pass, index: number)`** (three.js `EffectComposer`'s own signature).
  Rejected: an index is a promise about the six built-in passes that the pipeline
  cannot keep. The day AA moves, every caller silently mis-orders.
- **`insertBefore(existingPass)` / `insertAfter(existingPass)`** with the pass
  objects as anchors. Rejected: it exports the identity of every built-in pass as
  API surface and makes "which pass is the AA one" a caller concern when AA is
  three passes in a trench coat (SMAA + FXAA + the `off` case).
- **A priority number.** Rejected: priorities are anchors with the documentation
  removed; two tasks picking `50` is a coin flip.

---

## 3. Containing the three.js private-field casts

The casts stay (there is no public API for SMAA's internal render targets), but they
are now funnelled through one helper that names the field, the owner and the
three.js revision in its error, and they are validated **at construction**, not at
the first resize:

```ts
readPassInternals(owner, 'AdaptiveSmaaPass', SMAA_INTERNAL_FIELDS)
```

plus `VALIDATED_THREE_REVISION = '185'`, asserted by
`lightingPostPipeline.canary.test.ts`. A three.js bump therefore fails a **unit
test with an explicit "re-validate the private fields" message** before it can fail
a browser gate, and a *rename inside the same revision* fails at pipeline
construction with the field name in the message.

The canary constructs the real `SMAAPass`/`UnrealBloomPass`/`OutputPass`/`FXAA`
materials in Node (SMAA only touches `Image` as a `{src, onload}` bag, so a
five-line stub is enough) and asserts:

- every private field the pipeline reads exists, with the expected arity for the
  two array-valued ones (5 blur materials / 5 horizontal / 5 vertical targets);
- every scaled vertex shader still contains the literal `vUv = uv;` that
  `installUvScale` rewrites — the silent-failure mode `installUvScale` already
  throws on, now caught in CI without a GPU.

---

## 4. Why exposure is *not* a post pass

Plan §3.5 says the controller writes `toneMappingExposure` "via the pass-insertion
API". Implemented literally — a no-op pass at the head of the chain that sets
renderer state — it would append a seventh entry to `composer.passes` **by default**,
which is exactly what acceptance criterion 1 and `lightingPostRegression.mjs`
forbid. Taking the intent instead of the letter: the controller does not reach into
the renderer, it writes through the pipeline, which owns the tone-mapping stage.

`LightingPostPipeline` implements a one-method sink:

```ts
setExposure(exposure: number): void   // renderer.toneMappingExposure = baseExposure * exposure
```

`ExposureController` depends only on that port (`ExposureSinkPort`), so it is
testable without three.js and the pipeline stays the only module that touches
`renderer.toneMappingExposure`. Recorded as a deviation in the report.

**`baseExposure` absorbs landmine 4.** The pipeline is constructed with
`baseExposure` = 1 normally and `SOFTWARE_FALLBACK_EXPOSURE` (3) when
post-processing is unavailable. Consequence, deliberately chosen: **exposure mode
`fixed` reproduces v1 byte-for-byte** (`setExposure(1)` → 1, or → 3 on the software
path), so the settings toggle and the governor pin are exact rollbacks, not
approximations.

---

## 5. The exposure model

### 5.1 Scene key

Plan §3.5, verbatim: `E_target = clamp(K / L_scene, E_min, E_max)`.

`L_scene` is expressed in **units of the solar constant at 1 AU**, so `K = 1` puts
`E_target = 1` exactly at Earth's heliocentric distance with nothing else in view —
the calibration every existing asset, material and screenshot was authored against.

Both terms reuse `render/visualTier.ts`'s `apparentMagnitude` unchanged:

```
L_sun  = 10^(0.4·(M☉,1AU − m☉(camera)))        // = (AU / d_camera-sun)², inverse square
L_body = 10^(0.4·(M☉,1AU − m_body(camera)))    // geometric albedo × Lambert phase
L_scene = L_sun + L_body                        // L_body omitted when the dominant
                                                // body is the Sun or is absent
```

`m_body` already carries `p · Φ(α) · R² · d_obs,sun² / (d_body,sun² · d_obs,body²)`
(rendering-spec §3), so "albedo × phase, same helpers" is literally one call. Sanity
check: full Earth from a 400 km orbit gives `L_body = 0.384` — a third of a solar
constant of earthshine, which is the right order for a hemisphere of albedo 0.43
filling the sky.

**The magnitude ladder is untouched.** `visualTier` keeps consuming physical
magnitudes; the exposure controller is a *consumer* of the same pure function. No
`visualTier` test changes, which is the invariant this task is not allowed to break.

### 5.2 Adaptation

First-order lag **in log-exposure**, not in exposure:

```
stops       = log2(E_target) − log2(E)
τ           = E_target > E ? 6 s (bright→dark) : 2 s (dark→bright)
log2(E) += stops · (1 − exp(−Δt/τ))
```

At `t = τ` the controller has closed 63.2% of the gap **in stops**, which is what
the ±10% test asserts.

Rejected: a lag on `E` itself. Also "exponential adaptation", also matches the
words, but over the 7-stop working range it is wildly non-uniform — the same τ
would feel instant near `E_min` and glacial near `E_max`, because equal steps in `E`
are not equal steps in perceived brightness. Adaptation is multiplicative in every
photopic model, and the clamps span 2.4 decades. Documented in rendering-spec §4 so
the choice is not re-litigated.

`τ_bright→dark = 6 s` is the slow direction (exposure *rising*, eyes adapting to
dark) and `τ_dark→bright = 2 s` the fast one, matching the plan and the real
asymmetry of light vs. dark adaptation.

### 5.3 Why E_min = 1/8 and E_max = 16

Both clamps are derived from fixed calibrations elsewhere in the renderer, not
taste. three.js ACES maps a linear value `v` through `RRTAndODTFit(v·E/0.6)`.

**`E_min = 0.125` — "the photosphere stays below clip".** The photosphere renders at
`v = SUN_EMISSIVE_INTENSITY = 4`, distance-independent (landmine 2). At today's
fixed `E = 1` that is `RRT(6.67) = 0.952` → 250/255 after sRGB: flat white,
granulation invisible. The largest power-of-two exposure that keeps it near
mid-tone is `E = 1/8` → `RRT(0.833) = 0.558` → ≈197/255: bright, unclipped, full
granulation contrast. The corona billboard (peak ≈1.8 before alpha) lands at
`RRT(0.375) = 0.29` → ≈140/255 — visible, which is the other half of the criterion.

**`E_max = 16` — "Neptune daylight reads", bounded by the constant ambient.** The
non-physical ambient floor contributes `0.02·albedo/π = 0.0064·albedo` regardless of
where the camera is (landmine 3). At `E = 16` an albedo-1 surface lit by ambient
alone reaches `RRT(0.17) = 0.097` → ≈0.34 sRGB: a dark grey floor, still clearly
below the lit surface. At `E = 64` the same surface reaches 0.49 → 0.72 sRGB and
night sides turn into grey cards. 16 is the last power of two that keeps the ambient
floor dark. What it buys: Neptune's disk (albedo 0.442 at 30.07 AU) goes from
`RRT(5.5e-3) = 6.8e-4` → **2/255, effectively black today** to `RRT(0.088) = 0.035`
→ **≈53/255**, which reads as (dim) daylight.

The window is therefore [−3, +4] stops around v1's fixed exposure of 1.0.

Consequences accepted, with numbers:

| pose | d☉ | L_scene | K/L | E_target |
|---|---|---|---|---|
| near-Sun (25 R☉, plan §3.3 arrival radius) | 0.1163 AU | 73.9 | 0.0135 | **0.125** (clamped) |
| Mercury | 0.387 AU | 6.68 | 0.150 | 0.150 |
| Earth (free space) | 1.0 AU | 1.00 | 1.00 | 1.00 |
| Neptune | 30.07 AU | 1.11e-3 | 902 | **16** (clamped) |

Mercury clears `E_min` by only 20%, and at perihelion (0.307 AU) it clamps. That is
the honest answer for a −3-stop floor, not a bug; the four poses stay strictly
ordered, which is what acceptance criterion 2 asks for. The tests assert the strict
`L_scene` ordering separately from the clamped `E` ordering so a future clamp retune
cannot silently destroy the physics.

**Deliberately not fixed here:** `SUN_EMISSIVE_INTENSITY` makes the solar disk dimmer
as you approach (its radiance should rise, or at least not be a constant) and the
constant ambient flattens the outer system. Both are radiometric calibration bugs
that belong to T0141 (Sun v2) and to whatever revisits `solarLighting.ts`; `E_min`
should be revisited with the former.

### 5.4 Settings and the governor

- `GameSettingsV6` adds `render: { exposureMode: 'auto' | 'fixed' }`, default `auto`,
  persisted under `solar-voyager.settings.v6` with a v5→v6 migration (the existing
  v1→v5 chain is extended, not replaced).
- `RenderQualityProfile` gains `exposureMode`. Rungs 0–11 are `'auto'`; rungs 12–14
  (tier 1, the texture-capped floor) are `'fixed'` — the same rungs that already give
  up procedural octaves and star count. The governor and the user setting compose the
  obvious way: **`fixed` from either side wins**, so a governed pin cannot be undone by
  the settings toggle and vice versa. `ExposureController.setGovernorMode()` and
  `setUserMode()` are separate entry points precisely so neither can clobber the other.

---

## 6. Frame-loop cost

One `update(dtSec, cameraPositionKm, dominantBodyIndex)` per frame: two
`apparentMagnitude` calls (existing allocation-free math over the shared packed
`Float64Array`), three `Math.pow`, one `Math.exp`, one `Math.log2`. No allocation,
no object churn, no strings.

`fixed` mode does **not** skip the `L_scene` evaluation, deliberately. It costs a
few hundred nanoseconds against a 16.6 ms budget, and keeping it always-on means
`sceneLuminance` is a trustworthy diagnostic in every mode and the mode switch
changes exactly one thing (the target), which is far easier to reason about than a
controller with two code paths. Pinning `fixed` on a low tier is about not making a
struggling frame re-adapt, not about saving arithmetic.

`fixed` also *ramps* into place through the same lag rather than snapping, so a
governor rung change is a 2 s fade instead of a flash. `reset()` is the explicit
snap, for discontinuities where a fade would be a lie (startup, restore-point
teleport, cruise insertion).
