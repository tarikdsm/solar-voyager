# Body rotation, axial tilt, tier-2 oblateness, sim-time clouds — design (T0128)

Task: `tasks/T0128-body-rotation.yaml`. Release plan §5 T0128; spec §6.1.
Status: decisions taken on 2026-08-16, before implementation.

## 0. What was actually broken

Reading the code before changing it turned up more than the task text promised.

1. **Nothing rotates.** `siderealRotationPeriodSec` is baked into `data/bodies.json` and read by
   nobody. `axialTiltRad` reaches exactly one consumer: `ringSystem.ts`.
2. **Every body's pole points the wrong way.** The render frame *is* the physics frame
   (heliocentric ecliptic J2000, `+Z` = ecliptic north — `spaceScene.ts` only subtracts the camera
   position). glTF assets are Y-up, so an unrotated model has its pole along world `+Y`, which lies
   *in* the ecliptic plane, 90° from where a pole belongs. `ringSystem.ts:195`
   (`root.rotation.z = axialTiltRad`) tilts that already-wrong axis inside the ecliptic plane, so
   Saturn's rings currently stand up perpendicular to the ecliptic. No test caught it because both
   ring browser fixtures build their camera and Sun vectors with the *same* wrong rotation
   (`rotateLocalIntoGlobal` in `tests/render/ringSystemsPage.ts` and `ringFlythroughPage.ts`), so
   the fixture and the code were consistently wrong together.
3. **The "double tilt" is a trap, not a present bug.** `root.rotation.z = tilt` plus the manual
   `R_z(-tilt)` in `PreparedRingSystemImpl.update` are today a matched pair (apply the tilt to the
   geometry, transform world vectors into the tilted frame). The moment a second owner writes the
   root's attitude — which is exactly what this task does — the tilt lands twice.
4. **Earth clouds ride the wall clock.** `earthSurfaceLayers.update(nowMs)` with a 6 h *wall*
   period. Pause, time-warp and deterministic replay all disagree with it.
5. **Tier 2 is a perfect sphere; tier 3 is not.** `tools/blender/build_planet.py` bakes
   `polarRadiusRatio` into the tier-3 mesh (verified: Saturn's exported `Sphere` spans ±1.0 in x/z
   and ±0.9020 in y) and canonicalises the ellipsoid normals. The tier-2 icosphere is scaled with
   `setScalar(meanRadiusKm)`. Two pops at the 2↔3 boundary follow: the flattening appears, and for
   ringed bodies the radius jumps as well, because tier 3 scales by the ring catalog's
   `referenceRadiusKm` (Saturn 60 268 km, its equatorial radius) while tier 2 uses
   `meanRadiusKm` (58 232 km, the volumetric mean) — a 3.5 % step nobody had noticed.

## 1. Orientation model (the decision that fixes 2 and 3)

Model-local `+Y` is the north pole for every asset (glTF Y-up; the ring annulus lies in local `XZ`
with normal `+Y`, and the ring shaders hard-code that). So one quaternion per body:

```
q_body(t) = R_x(π/2 − ε) · R_y(θ(t))
θ(t)      = W₀ + 2π · (t mod T) / T          T = siderealRotationPeriodSec (signed)
ε         = axialTiltRad
```

`R_y(θ)` spins about the model's own pole; `R_x(π/2 − ε)` carries that pole from model `+Y` to the
world direction `(0, sin ε, cos ε)` — angle ε from ecliptic north, leaning toward ecliptic
longitude 90°.

### Why that lean direction, and what it does *not* claim

Obliquity alone does not fix a pole: the catalog has no IAU `(α₀, δ₀)`, so the node of the body's
equator on the ecliptic is a free parameter. The convention chosen puts that ascending node at
ecliptic longitude 0 (the J2000 vernal equinox). That choice is **exact for Earth** — Earth's north
pole in ecliptic J2000 really is `(0, sin ε, cos ε)`, because the equinox *is* the node of the
equator on the ecliptic — and **arbitrary for the other 42 bodies**. Rejected alternatives: lean
toward longitude 0 (breaks Earth, gains nothing); carry the pole as a vector in `bodies.json`
(schema change ⇒ ADR ⇒ a data/bake task, not a render task).

Consequence worth stating plainly: for every body except Earth the *plane* of the equator is right
by construction (the obliquity is real), while the *orientation of that plane about the ecliptic
pole* is a convention. Correcting it needs IAU pole data in the catalog.

### Rotation phase is uncalibrated (except Earth)

The catalog carries no `W₀` (prime-meridian angle at epoch). `W₀ = 0` for every body but Earth. What
ships is therefore **phase-accurate rotation rate with an arbitrary epoch phase**: Io really does
turn once per 42.46 h, but which face is sunlit at t = 0 is not a claim. This is stated in
`docs/rendering-spec.md` rather than implied away.

### Earth's anchor (defensible, so it is taken)

With the frame above, the body-frame prime meridian (`+X` at θ = 0) maps to world
`(cos θ, sin θ cos ε, −sin θ sin ε)`, which is precisely the ecliptic-frame image of the equatorial
direction `(cos GAST, sin GAST, 0)`. So for Earth **θ is Greenwich sidereal time**, and the anchor
is `W₀ = GMST(epoch)`:

```
JD(2026-01-01T00:00:00) = 2461041.5  (= bodies.json `epoch.jdTdb`)
n = JD − 2451545.0 = 9496.5 d,  T = n/36525
GMST = 24110.54841 + 8640184.812866 T + 0.093104 T² − 6.2e-6 T³   [s, IAU 1982, at 0h UT1]
     = 24158.606 s = 100.660859° = 1.756863409 rad
```

Cross-checked against the USNO short form `GMST_h = 18.697374558 + 24.06570982441908 n`: agreement
to 2.6e-5°.

Accuracy the anchor honestly buys: the frame is J2000-fixed while GMST is measured from the equinox
of date, so accumulated precession (~0.33° in right ascension over 26 years) is *not* modelled, and
neither is nutation, UT1−TDB, or polar motion. Sub-solar longitude is therefore good to a few tenths
of a degree near the epoch and drifts by ~0.014°/yr afterwards. That is inside the 1° acceptance
budget and is stated as a bound, not a guarantee of arbitrary-epoch accuracy.

One thing the anchor does **not** verify: that the tier-2 icosphere's and tier-3 UV-sphere's texture
longitude origins coincide with the body-frame `+X`. That is an asset-pipeline contract
(`tools/blender/common/create_uv_sphere` vs three.js `PolyhedronGeometry`'s
`u = atan2(z, −x)/2π + 0.5`) and was not measured here; a constant offset between the two would show
as a longitude ghost during the 2↔3 cross-fade, unchanged by this task because both tiers receive
the identical quaternion. Flagged for T0130, which owns that cross-fade.

### Retrograde encoding — a catalog defect found, not fixed

`data/bodies.schema.json` and the bake design doc are explicit: *"Rotation period is signed:
negative means retrograde about the declared pole."* `tools/bake_ephemerides.py` transcribed the
NASA planetary fact sheet, which states retrograde rotation **twice** — once as obliquity > 90° and
once as a negative period. Three bodies carry both and therefore cancel to prograde under the
documented convention:

| body | axialTiltRad | siderealRotationPeriodSec | faithful result | truth |
|---|---|---|---|---|
| venus | 177.36° | −20 997 360 | prograde | retrograde |
| uranus | 97.77° | −62 063.712 | prograde-ish | retrograde |
| pluto | 122.53° | −551 854.08 | prograde | retrograde |

Triton (tilt 0, negative period), Bennu and Ryugu (tilt > 90°, positive period) are each encoded
once and come out right. `bodySpin.ts` implements the documented convention verbatim and does not
second-guess the data; the three entries are a data/bake fix (`tools/bake_ephemerides.py` table +
three scalars in `data/bodies.json`) reported in the handoff notes.

## 2. Single tilt owner, and what happens to the rings

`bodySpin.ts` is the only place that turns `axialTiltRad` into geometry. `prepareRingSystem` loses
`root.rotation.z` entirely and instead *reads* the same frame helper to build its world→local basis.

The model root now carries the **full** attitude, so the ring annulus rotates with its planet.
Consequences, weighed:

- The annulus texture is a radial strip — axisymmetric — so Saturn/Jupiter/Uranus see no change.
- Neptune's four Adams arcs are localised by local azimuth, so they now circulate at Neptune's
  16.11 h rotation rather than the arcs' true ~10.5 h Keplerian period. Previously they were frozen.
  Wrong rate beats frozen, and it is one shader constant away from right once someone wants it.
- The **ring shadow on the planet** and the **planet shadow on the rings** both live in that same
  spinning frame, so `uRingSunDirection` simply moves from "world rotated by −tilt" to "world
  rotated by the full inverse attitude". No new uniform, no shader source change, no cache-key bump.
- The **particle field** must not inherit the spin: its shader advances particles at the local
  Keplerian rate, and a rotating frame would add ω_planet·r on top (at Saturn's B ring that is
  1.84× the correct streaming speed). It therefore gets a local counter-spin `R_y(−θ)` and keeps
  receiving the camera in the non-spinning equatorial frame. Exactly two objects change: the
  instanced mesh's quaternion, and nothing else.

Rejected: spinning the surface mesh inside a static root (needs a second sun-direction uniform *and*
per-body knowledge of which meshes spin, for all 43 bodies, not just the 4 ringed ones).

## 3. Oblateness at tier 2

`scale.set(R_eq, R_eq · polarRadiusRatio, R_eq)` on both tier-2 spheres, with
`R_eq = ringDefinition?.referenceRadiusKm ?? meanRadiusKm` — the identical expression tier 3 already
uses for its root scale. That closes both pops at once: flattening and (for ringed bodies) the 3.5 %
radius step. Tier selection and apparent magnitude keep using `meanRadiusKm`; only the mesh scale
moves, so the "no artistic scaling" rule in rendering-spec §3 is untouched.

**On the "normal-correct shader flag" in the acceptance text.** No flag is added, deliberately.
three.js already uploads `normalMatrix = transpose(inverse(modelViewMatrix₃ₓ₃))` per object per
draw, which is the exact normal transform for an object-space non-uniform scale: applied to an
icosphere's `normal == position` it yields `(x/a, y/b, z/a)`, the true normal of the ellipsoid
`x²/a² + y²/b² + z²/a² = 1`. A shader flag would be a second, redundant implementation and an extra
program variant. The *outcome* the criterion asks for — normals correct under oblate scaling — is
asserted numerically in `bodySpin.test.ts` against the analytic ellipsoid normal. Reported as a
deviation rather than faked. (The Blender pipeline's `canonicalize_ellipsoid_normals` exists because
Blender bakes non-uniform scale into vertex normals *without* the inverse transpose; three.js does
not have that bug.)

## 4. Clouds on sim time

`PreparedEarthSurfaceLayers.update(simTimeSec)`, period in **simulation** seconds, joining the
gas-giant animation's bounded-modulo pattern (rendering-spec §11) so pause, warp and replay share
one clock.

The old constant was a 6 h *wall* period. Reinterpreting it as 6 h of sim time would make the cloud
deck lap the planet four times a day at warp — a 460 m/s zonal wind. Instead the relative drift is
derived from a stated wind speed: 10 m/s eastward at the equator over a 40 074.784 km equatorial
circumference gives a **4 007 478 s (46.4 d) relative period**. At 1× both rates are equally
invisible; at warp the new one is the one that looks like Earth. The cloud shell's absolute motion
is dominated by the body spin it now inherits from the root.

## 5. Allocation and cost

`BodySpin` owns two preallocated typed arrays sized at construction: 43 quaternions
(`Float64Array(4n)`, the packed attitude path) and 43 spin angles. `update(simTimeSec)` is one
arithmetic pass — per body two `Math.sin`/`Math.cos` of the half-angle and four multiplies, because
the frame half-angle terms are constant and precomputed. Writing into three.js is
`quaternion.set(...)` + `updateMatrix()`, both in-place. No allocation, no new draw call, no new
material, geometry or texture.
