# T0100 startup quality and loading — design

## Goal

Make the first playable menu a measured, truthful startup milestone. Startup
loads only the reviewed critical path, compiles every eager shader before the
menu becomes interactive, selects a conservative initial auto-quality rung from
real device evidence, and turns any initialization failure into an accessible
retry state instead of an unhandled crash.

## Initial quality policy

`render/startupQuality.ts` owns a pure three-band selector. Its input is a
snapshot of device pixel ratio, the renderer's strict/fallback and software
classification, `MAX_TEXTURE_SIZE`, `MAX_SAMPLES`, and the mean duration of a
fixed three-render loading probe. The probe runs only after eager scene shaders
have compiled; each sample renders the same prepared flight scene and calls
`WebGL2RenderingContext.finish()` outside gameplay. The workload is therefore
bounded to three samples and cannot enter the frame loop.

Auto selects the representative governor rungs documented in
`performance-spec.md` section 3:

- rung 0 / Q6 only for strict hardware, DPR at most 1.5, texture size at least
  16384, at least 4 samples, and probe mean at most 8 ms;
- rung 7 / Q3 for remaining strict hardware with DPR at most 2, texture size at
  least 8192, at least 2 samples, and probe mean at most 16.6 ms;
- rung 14 / Q1 otherwise, including software or caveat fallback.

Persisted manual `high`, `medium`, and `low` remain authoritative at rungs 0, 7,
and 14 and bypass both capability selection and the timing probe. Unsupported
post-processing remains disabled on a software renderer even when the user asks
for high quality. `PerfGovernor` accepts the auto-detected initial rung and keeps
its existing measured control law unchanged after startup.

## Loading state and recovery

`index.html` contains the immediate semantic loading shell: label, native
`progress`, detail text, and a hidden Retry button. The bootstrap updates it only
at completed milestones — context/session, star catalog, manifest, eager hero
textures, flight shaders, map shaders, timing selection, post pipeline/widget,
and ready. Percentages never advance on timers and never claim bytes or work that
has not completed.

The Preact menu is mounted only after the world, eager shaders, post pipeline,
and state-vector widget are ready. At that point the loading shell unmounts,
`data-startup-stage="ready"` and `data-world-ready="true"` are published, and
New Game/Continue become interactive. This is the canonical first-playable
milestone.

Initialization rejection is caught once. The shell changes to `role="alert"`,
keeps the failed stage and sanitized error, and exposes Retry, which reloads the
page. No animation loop, input mapper, or partially initialized Preact menu is
started. A browser regression aborts a critical request, verifies this state,
removes the fault, clicks Retry, and reaches ready.

## Critical assets and shader readiness

`data/initial-path.json` remains the sole source of truth. Before first playable,
production may request built code/WASM plus only its four declared runtime files:
the star catalog, asset manifest, and Earth/Moon sphere albedos. Sun is
procedural. Draco, every tier-3 model, hero texture, and non-hero sphere stay
lazy.

`BodyVisualSystem` starts with lazy requests disabled. `initializeEager()` loads
only the hero sphere path; `initializeView()` may choose a tier but cannot start
a model request. Gameplay activation enables lazy loading, so the close Earth
model can begin after first playable without delaying control. Lazy models still
compile through their existing compiler before publication.

The prepared flight scene, compilation-only trajectory geometry, system map,
procedural Sun variants, post pipeline, and state-vector widget are all compiled
or warmed before ready. The startup regression records the program count at
ready and after the first ordinary frame; it rejects first-use growth attributable
to eager visuals.

## Diagnostics and measurements

A fixed getter-only `canvas.solarVoyagerStartup` diagnostic exposes stage,
progress, selected rung/tier/source, probe duration or null for manual locks,
startup elapsed milliseconds, first-playable milliseconds, resource transfer and
encoded-body bytes, program count at ready/current, requested critical paths,
and an error count/message. Values are written only during setup or the existing
telemetry cadence; no per-frame object is created.

The permanent cold-load Chromium regression starts with an empty cache, records
request paths/status/bytes, timing, programs, console/page errors and first
playable, and prints one JSON report in CI. The final local run is committed
under `docs/bench/` with hardware/context identity. It also verifies manual-lock
probe bypass, deterministic capability fixtures, exact critical-path membership,
the recoverable failure route, and no eager first-use compilation.

## Bundle strategy

T0099 left 12 gzip bytes under the fixed total ceiling. The existing deterministic
Terser post-pass therefore applies the same safe `module`/mangle/four-pass
configuration to every JavaScript chunk, not only the entry. This removes more
bytes than T0100 adds while preserving the fixed 570000-byte gate and stable
cache identity. No budget is raised and no runtime dependency is added.

