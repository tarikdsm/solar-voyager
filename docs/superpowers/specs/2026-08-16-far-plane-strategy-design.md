# T0129 — Far-plane strategy (Eris), camera range, guard-policy split — Design

Task: `T0129` (plan `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §5 T0129, spec
`docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §12.3).
Branch: `task/T0129-far-plane-strategy`.

## 0. The problem, stated precisely

Three separate defects share one file and one commit series:

1. **Eris does not render.** `SPACE_FAR_KM = 1e10` (`src/render/spaceScene.ts:21`). Eris is at
   `r ≈ 1.429e10 km` at the J2026 epoch and reaches `a(1+e) = 1.4617e10 km` at aphelion, so its
   point-sprite vertex is clipped by the far plane on every frame from anywhere in the inner system.
   `docs/rendering-spec.md` §2 asserts "far 1e10 km (beyond Eris)", which is simply false — the
   catalog grew past the constant.
2. **The orbit camera cannot frame the system.** `DEFAULT_MAX_DISTANCE_KM = 1e10`
   (`src/game/orbitCameraController.ts:6`) stops the wheel exactly where the outer catalog begins.
3. **Every position binding hard-throws on a non-finite value.** That is correct for ship and body
   positions — a NaN there means the integrator or the catalog is broken and the frame loop should
   die loudly — but V2M3/V2M4 are about to add *effect* visuals (plume T0122, world markers
   T0112/T0117, Milky Way skybox T0126) whose sources are derived quantities. A divide-by-zero in a
   plume direction must not take the whole game down.

The task is small in line count and entirely about getting the *numbers* right, so the depth tests
come first and the constants follow them.

## 1. Depth: what actually limits precision, and what the far plane costs

Both strategies were derived from three.js `0.185.1` source rather than from folklore, because the
whole decision turns on whether raising `far` by 2.5× is cheap or expensive, and the two strategies
answer that differently.

**Reversed** (`Matrix4.makePerspective(..., reversedDepth = true)` + `EXT_clip_control`
`ZERO_TO_ONE`): `c = n/(f−n)`, `d = fn/(f−n)`, so for a view-axis distance `L`

```
z_win = n·(f − L) / ((f − n)·L)
```

with `z_win = 1` at the near plane and `0` at the far plane.

**Logarithmic** (three.js `logdepthbuf` fragment chunk, `gl_FragDepth`):

```
z_win = log2(1 + L) / log2(1 + f)
```

Let `ε = 2⁻²⁴ ≈ 5.96e−8` be either the float32 relative step or the unorm24 absolute quantum
(numerically the same figure, applied differently). Differentiating and solving for the smallest
resolvable separation `ΔL`:

| Strategy | Depth format | Resolvable ΔL |
|---|---|---|
| reversed | float | `ε·L·(1 − L/f)` |
| logarithmic | float | `ε·(1+L)·ln(1+L)` |
| logarithmic | unorm | `ε·(1+L)·ln(1+f)` |
| reversed | unorm | `ε·L²/n` — useless past a few hundred km |

Two conclusions fall straight out and they are the reason this task is safe:

- **Reversed depth is essentially far-plane-independent.** `(1 − L/f)` is `1 − 6.6e−7` at LEO. Moving
  `f` from `1e10` to `2.5e10` changes LEO reversed-depth resolution in the seventh significant
  figure. It is *near*-plane and *distance* that set the precision — a flat `ε` relative error.
- **Logarithmic depth pays `ln(1+f)`, i.e. a logarithm, for the raise.** `ln(2.5e10)/ln(1e10) =
  23.942/23.026 = 1.0398`. **The entire cost of this task's far-plane raise is 4.0 % of logarithmic
  depth resolution, everywhere, and ~0 % of reversed depth resolution.** That is the number the
  decision rests on.

Concrete values at the two ends of the gate (`n = 1e-3 km`, `f = 2.5e10 km`):

| Case | reversed (float) | logarithmic (float) | logarithmic (unorm24) |
|---|---|---|---|
| LEO witness, `L = 6,571 km` | 0.39 m | 3.4 m | 9.4 m |
| Eris, `L = 1.429e10 km` | 365 km | 19,930 km | 20,408 km |

The LEO gate case separates its two discs by **1 km**, which is 2,500× the reversed floor and 290×
the logarithmic floor — the spot check has enormous margin and cannot plausibly move under a 4 %
change. The far case therefore separates its two discs by **1e6 km**, 49× the coarsest floor above.
That is the honest claim the new case makes: *depth still functions at 1.4e10 km*, not *depth is
precise there*. Nothing at that range is ever closer together than a lunar distance on screen.

The reversed-depth rows assume a **floating-point** depth buffer. That is an assumption about the
browser's default framebuffer, not something three.js configures, and it is load-bearing: with a
unorm24 depth buffer reversed-Z degrades to `ε·L²/n`, which cannot even resolve the existing 1 km
LEO case (it would need 2,573 km). The existing gate passes on the reversed path today, which is
empirical proof that the CI browser hands us a float depth buffer; the new far case tightens that
same assumption by three more orders of magnitude. **If a driver ever hands us unorm24, the reversed
path fails the LEO case first, loudly, on the gate that already exists.** That is the correct
failure mode and it is why no code was added to probe `DEPTH_BITS`.

### 1.1 Why 2.5e10 and not "cover everything"

`2.5e10 km` covers Eris at aphelion (`1.4617e10`) seen from anywhere inside the planetary system
(Neptune is at `4.5e9`), with 71 % headroom. It does **not** cover the pathological pose of an
observatory camera parked at the new `2e10 km` maximum distance on the far side of the Sun from
Eris (`2e10 + 1.46e10 = 3.46e10`). Covering that would cost another `ln(3.5e10)/ln(2.5e10) = 1.4 %`
of logarithmic resolution for a viewpoint that exists only if the player zooms fully out *and* then
looks back across the system. The plan fixes 2.5e10 as an acceptance number; the residual is
documented here and in the handoff notes rather than silently absorbed. Note that it is strictly
better than today, where `far = 1e10` and `maxDistance = 1e10` clip the same geometry at 2.46e10.

Alternatives rejected:

- **Infinite far plane** (`c = n/f → 0` limit). Free for reversed depth, but three.js's logarithmic
  chunk divides by `log2(far + 1)` and has no infinite branch; it would fork the two strategies'
  projection setup, which ADR-008 deliberately keeps identical.
- **Manual depth partitioning** (near/far scene passes). Explicitly rejected by `rendering-spec.md`
  §2 ("No manual depth partitioning"); it doubles the pass count for a problem that a 4 % precision
  trade solves.
- **Dynamic far plane from the frame's furthest bound.** Makes depth values frame-dependent, which
  breaks the pixel-hash stability assertions the starfield and camera gates are built on.

## 2. Camera range

`DEFAULT_MAX_DISTANCE_KM: 1e10 → 2e10`. One constant, and only the *space* orbit camera default —
`SystemMapScene` already passes an explicit `maxDistanceKm` derived from the catalog bound, and is
untouched.

The transition maths were audited for the new span rather than trusted. `OrbitCameraController.update`
interpolates distance **logarithmically** (`Math.exp(Math.log(start) + (log(end) − log(start))·blend)`),
which is why the span raise is not free of risk: `Math.log(0)` is `−Infinity` and `exp` of a NaN
blend poisons the camera position for the rest of the session. The invariants that make it safe are

- `currentDistanceKm` is clamped into `[minimumCameraDistanceKm(radius), maxDistanceKm]` at
  construction and after every mutation, and `minimumCameraDistanceKm` is `radius + max(2 m,
  radius·1e−6) > 0` for the positive-radius targets the constructor enforces;
- `transitionEndDistanceKm = max(endMinimum, radius·3) > 0`;
- the context pull-back term `0.15 · travel · sin²(πt)` is additive and finite for finite travel —
  at the new maximum span (`travel ≈ 2.9e10 km` between opposite-side outer bodies) it adds
  `4.4e9 km`, which the `maxDistanceKm` clamp absorbs.

None of these are new, but none of them were *tested* across the catalog either. The fuzz test in
§5 is what turns "it should be fine" into evidence, and it exists because the failure mode
(a single NaN, once, at an extreme span) is exactly the kind that unit tests on Earth↔Jupiter never
see.

## 3. Starfield far-pinning

The starfield forces `clipPosition.z = 0.0` under `USE_REVERSED_DEPTH_BUFFER` and
`clipPosition.z = clipPosition.w` otherwise, so stars sit exactly on the far plane in *both*
strategies and the actual `STARFIELD_RADIUS_KM = 1e9` sphere radius is irrelevant to depth. Raising
`far` therefore cannot move the stars — but it *does* change which bodies are in front of them, and
that is the property worth a gate.

The new case is a synthetic occluder at Eris's distance, `1.429e10 km`, i.e. **14× further from the
camera than the starfield sphere itself**. If the pinning is correct it still occludes the star
behind it, because the star's depth is the far plane and the occluder's is not. If someone ever
"fixes" the starfield to use its real radius, this case fails and the near-field case does not. Its
radius (`7.145e8 km`) is chosen to subtend the same 0.05 rad as the existing 1e6 km control, so the
pixel expectations (`Alnilam litPixels === 0`, `drawCalls === 2`) carry over verbatim.

## 4. Guard-policy split

Today `spaceScene.ts` validates every bound position twice — once at bind time
(`assertFinitePosition` / `assertPackedPositions`) and once per frame inside `updateCameraRelative`
— and throws `RangeError` either way. Five binding families do this: `bindVisual`,
`bindPackedVisual`, `bindPackedPositions`, `bindPackedPointPositions`, `bindPackedPolyline`.

**All five keep the throw.** They carry ship state, catalog positions, trajectory polylines and the
osculating conic — a NaN in any of them is a physics bug, and the plan's whole point is that those
stay loud.

Two **new** families are added for effect visuals, `bindEffectVisual` and `bindPackedEffectVisual`.
On a non-finite source they:

1. **skip the write** — the visual keeps its last good camera-relative position and the frame
   completes;
2. **warn once per binding**, not once per frame and not once globally: one line per failing effect
   names the culprit, and a bounded number of effects means a bounded number of lines. The message
   is built lazily, in the degrade branch only, so the steady-state frame path allocates nothing;
3. **raise a telemetry flag** — `spaceScene.effectBindingTelemetry`, a single object allocated in
   the constructor and mutated in place, carrying `nonFiniteObserved` (the flag), a live
   `degradedBindingCount`, a monotonic `skippedBindCount` and `lastDegradedLabel`.

Recovery is symmetric: when the source becomes finite again the binding resumes writing and
`degradedBindingCount` drops. `nonFiniteObserved` and `skippedBindCount` are deliberately
monotonic — a flag that clears itself is not evidence.

The policy lives in `src/render/effectBindingGuard.ts`, not in `spaceScene.ts`, for two reasons:
`spaceScene.ts` is already 648 lines against a 300-line house guideline, and the guard is the one
part of this that a future effect subsystem will want to reason about on its own. The `Math.fround`
writes stay in `spaceScene.ts` — **the boundary contract scanned by
`tests/render/float32Boundary.test.ts` is untouched**, and the guard module contains no float32
conversion at all.

`onEffectBindingWarning` is injectable through `CameraRelativeSpaceSceneOptions` so the unit test
can observe the warning without spying on `console`; it defaults to `console.warn`.

**Not done, deliberately:** wiring the flag into a `canvas.solarVoyager*` browser diagnostic. There
is no production effect binding yet — plume, markers and skybox are T0122/T0112/T0126 — so a
diagnostic field today would be contract surface with no producer and no reader. The handoff notes
name the field and the owner.

## 5. Test plan (written before the constants moved)

| Evidence | Where |
|---|---|
| Eris inside the far plane, both strategies, plus the LEO spot check unchanged | `tests/render/depthRegressionPage.ts` + `tools/tests/renderDepthRegression.mjs` — third case `eris-1.43e10-km` |
| The far plane really is what the standard control fails on, not clipping | same gate: the control must still render the far *rear* disc (`rearPixels > 100`) while losing the front |
| `SPACE_FAR_KM` covers the whole catalog, forever | `src/render/spaceScene.test.ts` derives every body's aphelion from `data/bodies.json` and asserts the constant clears it |
| Focus transitions stable at extreme spans | `src/game/orbitCameraController.test.ts` — deterministic fuzz over all ordered focus pairs × start distances × frame deltas |
| Starfield far-pinning under both strategies | `tests/render/starfieldPage.ts` + `tools/tests/starfieldRegression.mjs` — `renderFarOcclusionControl()` |
| Guard split | `src/render/effectBindingGuard.test.ts` (policy) + `src/render/spaceScene.test.ts` (injected NaN through a real binding, and the hard throw preserved) |

The far case's fov is `2e-5°`: Eris's 1,200 km radius at 1.429e10 km subtends 8.39e-8 rad, which
that fov maps to 61.5 px of a 256 px viewport. This is the same trick the existing `earth-1-au`
case uses at `0.01°`, three orders of magnitude further out.

## 6. Landmines found in existing code

- `docs/rendering-spec.md` §2's "far 1e10 km (beyond Eris)" was wrong when it was written; the
  parenthetical is what let the defect survive. Corrected with the actual catalog figure.
- `renderDepthRegression.mjs` asserted `cases.length === 2` and iterated positionally with no name
  check, so a reordered or renamed case would have passed silently. The assertions are now
  name-addressed.
- `depthRegressionPage.ts` hard-coded Earth's radius for *both* discs inside `renderCase`, so a new
  case could not have its own scale. Radii moved into the case definition; the two existing cases
  keep their exact previous values and their output is byte-identical.
- `OrbitCameraController.zoomByWheel` mutates `transitionZoomFactor` while a transfer is running and
  the factor is *not* reset when a new `focusBody` interrupts an old one mid-flight — it is, at
  `focusBody`, but only because that line exists; the fuzz test now covers interrupted transfers so
  a future edit cannot drop it.
