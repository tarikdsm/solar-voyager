# T0126 — Milky Way panorama, zodiacal light, constellations — design

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §6.4.
Plan block: `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §5, T0126.

This records the decisions that were actually contested, and the landmines found
in existing code. It is not a description of the finished code — read the code.

## 1. Keeping the sky on one aberration path

**The rule.** The panorama must be displaced by the same map as the star Points,
or a high-beta view shears the sky against its own stars.

Two ways to satisfy it:

- **A. Inverse-aberrate the view ray per fragment.** Exact, tessellation-free.
  Rejected: it is a *second* implementation of the aberration — the inverse of
  the one in `starfield.ts` — and two implementations of the same physics is
  precisely the failure mode the task's handoff note warns about. Any future edit
  to one would have to be mirrored, correctly inverted, in the other.
- **B. Displace sphere vertices by `aberrate(d)` and sample the texture from the
  *undisplaced* `d`.** Chosen. It is the identical transform the stars get, so a
  texel whose true direction is `d` lands on screen exactly where a star at `d`
  lands. The identity is enforced structurally: `src/render/skyAberration.ts`
  exports one GLSL string that the starfield, the panorama and the constellation
  batch all interpolate into their vertex shaders, plus the uniform block and the
  writer that fills it. `RelativisticVisualController` hands all three the same
  state object.

Cost of B: between vertices the mapping is piecewise-linear, so at high beta the
warp is faceted at the sphere's resolution. Mitigated by tessellation, and
bounded by the triangle budget (§5).

**Verification.** `tools/tests/milkyWayRegression.mjs` aims the camera at a
catalog star and reads the sky at screen centre, at rest and at beta 0.5/0.9. If
the two paths agree the sampled colour is invariant, because the texel under the
crosshair is the one whose own true direction is the star's. Negative control
run during development: sampling the texture from the *aberrated* direction
instead fails the gate with drift 14.36 against an allowance of 2.17.

## 2. Getting the orientation right, and proving it

Two separate questions, deliberately tested separately.

**Is the rotation right?** `src/core/galacticFrame.ts` builds `M_gal←ecl` from
the three IAU 1958 defining constants via explicit basis vectors, not from a
transcribed matrix and not from an Euler-angle convention I would have to
remember the handedness of. Proved in `src/core/galacticFrame.test.ts` against
SIMBAD's own galactic coordinates for α CMa, α Car and α Lyr: agreement better
than 0.1″. `tests/render/galacticSkyOrientation.test.ts` repeats it through the
float32 records actually shipped in `data/stars.bin` (2″, the Yale catalog's own
quantisation floor) and locks the obliquity against `tools/bake_stars.py`.

**Is the image's own convention right?** A correct rotation applied to a
mirrored image is still wrong. The ESO panorama's convention was established
empirically, not by eye: 39 catalog stars were projected onto the 6000×3000
source under both candidate longitude directions and the brightness peaks
located. `u = 0.5 − l/2π` won with a mean residual of 0.08 px in `u` and 0.59 px
in `v`; the mirrored hypothesis put the LMC on empty sky. The check is kept alive
in CI by the registration half of the browser gate, which aims at six catalog
stars and asserts the sky behind the two galactic-plane ones is more than five
times brighter than behind the two high-latitude ones. Measured: Shaula 43.57 and
Acrux 14.47 against Vega 0.11 and Canopus 0.22.

## 3. Where the asset is produced

`assets:ingest` publishes by **atomically replacing the whole `public/assets`
tree** (`publishDirectory()` in `tools/assets/ingest.mjs`). Anything the ingest
does not produce is deleted on its next run. That single fact decided this:

- A side-channel encoder writing `public/assets/textures/milkyway_panorama.ktx2`
  would work exactly once. Rejected.
- Putting the file outside `public/assets` would dodge `check:budgets`'s
  `publicAssetsBytes` accounting. Rejected as budget-gaming.
- Threading a "texture-only" flag through `discoverAssets` / `validateAssetDirectory`
  / `inspectAsset` would refactor the whole tested body-ingest path for an asset
  that satisfies none of its contract (`<id>.glb`, a `bodies.json` id, a triangle
  count). Rejected as blast radius.
- **Chosen:** a separate `tools/assets/skyTextures.mjs` step called from
  `ingestAssets` just before the manifest is written. `assetIngest.mjs` is
  untouched. The asset list is *declared* in `SKY_TEXTURE_ASSETS` rather than
  discovered, because the source tree it reads (`assets/textures-src`) is shared
  with ordinary body textures that must not be ingested twice.

A full re-ingest was required to add the file. That was only safe because the
toolchain here is bit-reproducible: `--only earth` into a scratch tree produced
byte-identical `earth_albedo.ktx2`, `earth_albedo_tier2.ktx2` and `earth.glb`
against the committed ones before anything was changed. The full run then added
only the three new files and the manifest entry.

## 4. Governor: a knob column, not a sixteenth rung

`QUALITY_PROFILES` is a closed 15-entry array and rung indices are positional
contract in `lockRung`, `startupQuality.ts`, the internal-width table and the
browser gate. Inserting a rung renumbers all of it.

`RenderQualityProfile.skyboxTier` is instead **derived from `tier`** inside the
`profile()` factory, exactly as `ringParticleCount` already is — zero call sites
change, no contract moves. `tier ≥ 4 → 'full'`, `tier ≥ 2 → 'half'`, else
`'off'`.

The tier does real work rather than cosmetic work: it selects which KTX2 the
lazy loader fetches (4096 vs 2048 source), and `'off'` skips the fetch entirely
and — with the zodiacal band also off — skips the full-screen sky draw. An
explicit non-goal: a tier *raised* after the texture is resident keeps what it
has. Re-fetching mid-flight would mean creating a texture during gameplay, which
`docs/performance-spec.md` §5 forbids.

Considered and dropped: a `textureLod` bias uniform for instant mid-flight
downshifts. It needs either `glslVersion: GLSL3` (every other shader in the repo
is GLSL1) or three.js's internal `texture2DLodEXT` shim. Not worth the exotic
dependency for a knob the tier already covers.

## 5. Budgets that shaped the design

The workload golden is 33 draw calls / 82,429 triangles at ±10%, i.e. 3 draw
calls and 8,243 triangles of headroom. Everything here fits inside it, so **no
golden was re-baselined**:

- Sky sphere: `SphereGeometry(1, 64, 32)` = 3,968 triangles, 1 draw call.
- Zodiacal light: same mesh, same material, same draw. It is a term in the
  panorama's fragment shader, not a second pass.
- Constellations: `LineSegments`, 0 triangles, 1 draw call, and `visible = false`
  by default so it costs 0 in the shipped configuration.

A finer sphere would render the high-beta warp more smoothly; 64×32 (5.6° cells)
is what the triangle headroom allows without a reviewed golden move.

## 6. Landmines found

- **`publishDirectory` replaces the output tree wholesale.** See §3. Also means
  `assets:ingest --only <id>` without `--output` will wipe `public/assets`.
- **`camera.matrixAutoUpdate = false`** in `CameraRelativeSpaceScene`. `lookAt()`
  sets the quaternion but nothing composes it into `matrix`; `updateMatrixWorld(true)`
  is not enough. Cost an hour in the harness, where every sample silently
  returned the same view. Any new test page that aims this camera must call
  `updateMatrix()` first.
- **`Vector3.project()` on points behind the camera** returns mirrored
  coordinates that land inside the viewport. The first harness reported four
  reference stars "on screen" when none were within 42° of the view axis.
- **`renderer.compileAsync` / the warm-up render only reach visible objects.**
  An overlay that ships off must be forced visible for the compilation pass and
  hidden again, which is what `OsculatingConicOverlay` already does and what
  `ConstellationLines.prepareCompilationPass()` copies.
- **Yale magnitudes are not SIMBAD magnitudes.** Canopus is V = −0.72 in BSC5
  and −0.74 in SIMBAD, so selecting catalog records by magnitude is fragile. The
  tests select by record index and *assert* the magnitude, which turns a silent
  re-bake into a loud failure.
- **Float32 catalog directions are not unit length** (|v| − 1 ≈ ±2e-8). Taking
  `acos` of a dot product against a unit vector turns that into a spurious 35–44″
  separation. Renormalise before any angular comparison.
- **Raw `ShaderMaterial` gets no output colour-space conversion.** Three.js only
  injects `<colorspace_fragment>` into its built-in shaders, so the sky writes
  linear values and looks far dimmer in a bare harness than in the app, where the
  post pipeline's output pass does the encode. Do not tune brightness from a
  harness screenshot.

## 7. Deliberate non-goals

- No re-fetch of the panorama when the governor tier rises (§4).
- No subdivision of constellation segments; at high beta a long figure line bows
  slightly off the aberrated great circle (median segment 4.9°, longest 24.4°).
- No adaptive-exposure participation: the sky is `toneMapped: false`, like the
  starfield, so the two stay in one display space. If T0127's exposure should
  reach the sky, that is a deliberate follow-up, not an accident.
