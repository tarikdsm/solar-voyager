# T0122 — Photon-beam plume, RCS puffs, ship lights (design)

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §6.3.
Binding model: `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §3.6.
Geometry contract: `tasks/T0121-ship-remodel.yaml` `handoff_notes`.

This records the decisions actually faced, the ones taken, the ones rejected, and
the landmines found in the code this sits on top of.

---

## 1. Where the effects live in the scene graph

**Decision.** One `Object3D` — `shipEffects.root` — bound to the ship's packed
float64 position through `CameraRelativeSpaceScene.bindPackedEffectVisual`, given
the ship's render quaternion and the ship's `1e-3` km-per-metre scale every frame.
Every effect is a child of it, authored in **model metres in the glTF frame**, so
the anchors are literally the numbers in `tools/blender/ship_config.py`.

**Rejected: parenting the effects to the loaded `ship.glb` root.** The model is
lazy-loaded after space-phase activation (`ShipVisual.beginModelLoad`), so an
effect parented to it cannot exist during `createEpochWorld`'s warm-up
`compileAsync` + `render` pass. That is precisely the first-burn shader stall the
task forbids. Owning our own root means the beam, the glow and the puff pool are
in the scene, at their real anchors, for the warm-up render — which is what
`prepareCompilationPass` is for.

**Consequence: the anchors are constants, not asset reads.** `SHIP_NOZZLE_THROAT_X_M
= -11.5`, `SHIP_NOZZLE_EXIT_X_M = -13.0` and the four `rcs_pod_*` origins are
transcribed from `ship_config.py` into `src/render/shipEffectAnchors.ts`. They are
*verified* against the real asset once, when the model finishes loading:
`ShipEffects.bindModel` measures each anchor node's local position and publishes
the worst error as `anchorErrorM`. A re-export that moves a node shows up as a
number in the browser gate instead of as a plume hanging in space.

**T0121 landmine, respected.** `engine_nozzle`'s origin is the **throat**, not the
exit, and the bell is a closed shell with a 5 cm liner. The beam is anchored at the
throat and emitted aft, so its first 1.5 m are *inside* the bell and correctly
occluded by the liner — the glow appears to emerge from the bell mouth. This only
works because the beam keeps `depthTest: true` (see §4).

---

## 2. Far-field photometry — the artificial star

The acceptance criterion is "a full burn is visible from ≥ 1 AU, with the
apparent-magnitude math documented". It is met with radiometry, not with a fudge
factor, and it goes through the **existing** magnitude path
(`visualTier.apparentMagnitude` → `pointIntensityForMagnitude` →
`BodyPointCloud.writeAppearance`), never a parallel one.

### The formula

The drive is a photon rocket: `P = m·α·c` (physics-spec §5), already published
per frame as `SimSnapshot.powerDrawW`. That power leaves as light, so the plume's
**radiant intensity** is a normalized beam pattern over `P`:

```
I(θ) = P · [ f_iso/(4π) + (1 − f_iso)·(n+1)·max(0, cos θ)^n / (2π) ]     [W/sr]
```

- `θ` is the angle between the exhaust direction (the ship's **aft** axis,
  −forward, from the snapshot attitude) and the direction to the camera.
- `f_iso = 0.02` — bell-rim spill and thermal re-radiation, the part that is not
  collimated. Without it a beam seen from the side is exactly invisible, which is
  correct for an ideal laser and useless for a game.
- `n = 64` — the collimation exponent. Half-power half-angle
  `arccos(0.5^(1/64)) = 0.1469 rad = 8.42°`.
- Both terms integrate to their fractions of `P` over their solid angles
  (`∫ cos^n θ dΩ = 2π/(n+1)` over a hemisphere), so `∫ I dΩ = P` exactly. The
  pattern redistributes power; it never invents any.

Irradiance at the camera is `E = I(θ)/d²`. The Sun at 1 AU is the zero point the
whole renderer already uses (`SUN_MAGNITUDE_AT_ONE_AU = −26.74`), and its
irradiance there is `L_☉/(4π·(1 AU)²)`, so

```
m_plume = −26.74 − 2.5·log10( I(θ)/d² · 4π·(1 AU)² / L_☉ )
```

with `L_☉ = 3.828e26 W`. The plume and the reflected hull are then combined **in
flux, not in magnitude**:

```
m_total = −2.5·log10( 10^(−0.4·m_reflected) + 10^(−0.4·m_plume) )
```

### What the numbers say

Default vessel: 10,000 kg at 10 g ⇒ `P = 2.940e14 W = 7.680e−13 L_☉`.

| Geometry, full throttle | apparent magnitude |
|---|---|
| Hull reflection alone at 1 AU (T0109) | +24.4 — invisible |
| Plume, viewed side-on (θ = 90°) at 1 AU | **+7.8** |
| Plume, isotropic-equivalent at 1 AU | +3.5 |
| Plume, looking down the beam (θ = 0) at 1 AU | **−1.7** — Sirius |
| Plume, side-on at 10 AU | +12.8 |

So a burning ship is 16.6 magnitudes brighter than a coasting one at 1 AU, and it
is naked-eye bright — brighter than any planet — to anyone it is pointed at. That
is the "artificial star" of spec §6.3, and it falls out of `P = mαc` rather than
being dialled in.

The point-cloud intensity curve clamps at `MAX_POINT_INTENSITY = 8`
(magnitude ≈ +3.7), so the on-axis case saturates the sprite rather than washing
out the additive buffer. That clamp is `visualTier`'s, untouched.

**Rejected: a separate "plume sprite" in the far field.** It would be a second
draw call, a second brightness curve to keep in step with `visualTier`, and a
second thing to fade. Adding flux into the ship's existing point slot costs
nothing and cannot drift.

---

## 3. Beam geometry, and how the governor shrinks it

Length follows §3.6 exactly: `L = 4 · SHIP_LENGTH_M · throttle^0.7`, so
104.5 m at full throttle, and `visible = false` at zero — "nothing when coasting"
is a visibility flip, not a small beam.

**One geometry, three index ranges.** Rebuilding geometry per governor rung is
forbidden (`performance-spec` §5: never create geometries during gameplay), and
`setDrawRange` on a single index buffer cannot express "same length, fewer rings".
So the lathe is built once at 24 radial × 12 axial, and the index buffer holds
**three complete beams** back to back — 24×12, 12×6 and 6×3 — all indexing the
same vertices, because the coarse ring sets are strict subsets of the fine one.
A rung change is one `geometry.setDrawRange(offset, count)` call. One draw call in
every case.

Length is a **uniform**, not a vertex rewrite: the vertex shader multiplies a
per-vertex axial coordinate `aAxial ∈ [0,1]` by `uBeamLengthM`, and the radius by a
profile that is also a function of `aAxial`. Throttle therefore reaches the screen
in the same frame it is read, with zero buffer traffic.

**`onBeforeCompile`, not `ShaderMaterial`.** The task names the hook pattern, and
it is the right call here for a concrete reason: the renderer runs with
`logarithmicDepthBuffer: true`, and a hand-written `ShaderMaterial` has to
re-derive the log-depth chunks (`bodyPointCloud.ts` does, and has to be kept in
step with three by hand). Extending `MeshBasicMaterial` inherits log depth, tone
mapping and colour space from three, and matches `gasGiantMaterial.ts` /
`earthSurfaceLayers.ts`. `customProgramCacheKey` is extended alongside it so the
program is cached under its own key.

---

## 4. Additive transparency and the crossfade landmine

The beam, the nozzle glow and the RCS puffs are all
`blending: AdditiveBlending, transparent: true, depthWrite: false, depthTest: true`
with `renderOrder = 2`, i.e. after bodies and after the ship hull.

`depthTest: true` is load-bearing twice: it is what lets the nozzle liner hide the
first 1.5 m of the beam, and it is what puts a planet in front of the ship in front
of the plume.

**Known and accepted:** while the ship model is cross-fading (`modelOpacity < 1`),
`ShipVisual.applyModelOpacity` sets every hull material to `depthWrite = false`, so
for those 250 ms the beam is not occluded by the bell. It is a quarter-second on a
beam that is itself fading in. Fixing it would mean either giving the plume its own
fade curve keyed off `ShipVisual`'s private fade state, or making the hull write
depth while translucent, which is the bug that fade is avoiding.

---

## 5. RCS: 16 bells, not 16 particles

**The pool cap is the hardware.** T0121 gives each pod four bells. Four pods × four
bells = **16**, which is exactly the "preallocated sprite pool capped at 16 live" the
task asks for — so the cap is structural, not a magic number. One `Points` object,
16 vertices, static positions, one draw call. `aSize`/`aIntensity` are the only
things that change.

**Which bells fire is solved, not scripted.** Each bell has a fixed model-frame
position `r` and exhaust direction `u ∈ {±X, ±Y}`; the reaction torque it applies is
`τ = r × (−u)`. For a commanded body-frame angular velocity `ω` the weight is

```
w_i = max(0, τ̂_i · ω̂)  ·  saturate(|ω| / RCS_FULL_RATE)
```

Bells whose torque opposes the rotation stay dark. This is a one-line allocation
that produces the couples a reader expects — a pure yaw lights the fore/aft-facing
bells on both sides, a pure roll lights the tangential ones — and it is asserted
that way in `rcsVisual.test.ts` rather than asserted in prose.

**Where `ω` comes from — and why not from `Commands`.** `SimSnapshot` does not carry
rotation rates; `CommandState.rotationRatesRadS` does, but it is **zero during a
hold-mode slew** (ADR-035), when the ship is visibly rotating hardest. A ship that
puffs under manual stick and turns silently under `prograde` hold reads as broken.
So `ω` is differentiated from the snapshot attitude quaternion itself:
`Δq = q_prev⁻¹ ⊗ q_now`, `ω = 2·axis·atan2(|v|, w) / Δt_sim`. That is deterministic
from the snapshot (plan §3.6 names *attitude* as an input), it costs no new
interface, and it fires for manual, hold and cruise-director rotation alike.

**Wrap guard.** Above ~π radians of rotation per frame the axis–angle extraction
aliases. At `maxSlewRadPerSimS = 0.261799` that needs about 12 s of simulated time
in one frame, i.e. warp ≳ 700. Above `RCS_MAX_TRUSTED_STEP_RAD = 1.0` per frame the
rates are treated as untrusted and the puffs are held dark — an RCS strobe at 1000×
warp is noise anyway. `degradedRateSteps` counts it so the choice is visible.

---

## 6. Lights: sim time, so pause freezes them

T0121 already ships `mat_light_beacon` / `mat_light_nav_l` / `mat_light_nav_r` with
baseline emissive strengths 1.4 / 1.2 / 1.2, so the asset reads "lights on" with no
code. This task owns the modulation only: it caches each material's authored
`emissiveIntensity` at bind time and writes `base × waveform(simTimeSec)`.

- Nav lights: steady at their authored value, breathing ±6 % over a 4 s sim-second
  cycle so they read as lit rather than as painted texels.
- Beacon: a double-flash anti-collision strobe on a 1.6 s sim period — two 90 ms
  pulses 220 ms apart, `BEACON_PEAK_MULTIPLIER = 6`, dark between.

Driven by `snapshot.simTimeSec`, which the frame loop pins to the previous value
while paused (`simDeltaSec = 0`), so **pause freezes the strobe** exactly as T0128
froze the clouds. It also means the strobe runs at warp — deliberate: it is a
sim-time phenomenon and a strobing hull under time compression is honest.

**Rejected: real `PointLight`s at the nav positions.** Three extra lights in every
shader on screen, for a fixture 6 m across whose own emissive already reads. The
spec's "no fake three-point studio rig" argues against it as well.

---

## 7. Guard policy — T0129's effect binding, first consumer

`spaceScene.bindPackedEffectVisual(root, positionsKm, shipOffset, 'ship-effects')`.
T0129's handoff names this task as the intended first consumer, and the reason is
concrete: the plume's transform is a *derived* quantity (a quaternion difference, a
normalized direction), so a divide-by-zero here must not end the session the way a
NaN in a ship position rightly does. On a non-finite source the scene skips the
write, the root holds its last good position, the console warns once and
`effectBindingTelemetry` rises.

`nonFiniteObserved` and `degradedBindingCount` are surfaced on the new
`canvas.solarVoyagerShipEffects` diagnostic — the flag becomes a browser
observation for the first time, which is what T0129 asked for. The ship's own
position binding keeps its hard `RangeError`; the two policies stay separate.

---

## 8. Governor

`RenderQualityProfile` gains two derived fields, in the style `ringParticleCount`
and `exposureMode` already established (derived from `tier` inside `profile()`, so
the 15 call sites are untouched and the ladder cannot drift out of step):

| tier | 6–5 | 4–3 | 2 | 1 |
|---|---|---|---|---|
| `plumeBeamSegments` | 24 | 12 | 12 | 6 |
| `rcsPuffCap` | 16 | 16 | 8 | 0 |

The lowest rung drops the puff pool entirely and quarters the beam tessellation.
The beam itself is never removed: it is the ship's identity and it is one draw call.

---

## 9. Draw-call accounting

Three new objects, all `visible = false` unless active:

| object | draw calls when active |
|---|---|
| beam mesh | 1 |
| nozzle glow sprite | 1 |
| RCS puff `Points` | 1 |

Worst case **+3**, inside the task's `+4` allowance. The perf-gate scenario
(`?autostart=1`, LEO, no input) coasts at zero throttle and issues no rotation
command, so all three are hidden and the golden is expected to move by **0**. The
far-field plume term adds no object at all — it writes into the ship's existing
`BodyPointCloud` slot.
