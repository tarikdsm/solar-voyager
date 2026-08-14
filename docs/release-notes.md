# Release notes

The public build includes complete, machine-checked
[third-party software notices](../public/THIRD_PARTY_LICENSES.txt) at its root.

## v2.0 development

Solar Voyager v2.0 (the free-flight redesign) is in progress. The deployed
site tracks `main`, so it may include incremental, incomplete v2 work in
between milestone landings; **v1.0.0 below remains the tagged release** until
v2.0.0 ships. See `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md`
and the v2.0 section of `docs/roadmap.md` for the plan.

## Solar Voyager 1.0.0 — 2026-07-19

The first public release delivers the complete M0–M3 and M5–M6 orbital-exploration experience. It
starts in a canonical 400 km low Earth orbit and is playable at
[tarikdsm.github.io/solar-voyager](https://tarikdsm.github.io/solar-voyager/).

### Highlights

- Float64 real-scale n-body spacecraft simulation with JPL-derived body rails, adaptive integration,
  warp safety, orbital elements, energy accounting, attitude control, and photon-drive thrust.
- Relativistic state, proper time, light-time, aberration, Doppler shift, beaming, and precompiled
  visual effects.
- Tiered planets, moons, dwarf planets, small bodies, named ring structures, animated gas giants,
  procedural Sun, star catalog, post-processing, and camera-relative rendering.
- Trajectory worker and overlay with dominant-body segments, SOI, closest-approach and impact markers;
  system map; burn log; target and state-vector instruments.
- Accessible measured loading/retry flow, public landing menu, guided orbital tutorial, rebindable
  controls, quality settings, local save/load, and JSON export/import.
- Strict WebGL2 context handling, software-renderer warning, startup quality probe, adaptive 60 fps
  governor, bounded assets/bundle, allocation-free frame contracts, and permanent browser/performance
  regression gates.

### Save compatibility

Version 1.0.0 writes `SaveEnvelopeV2` and `GameSettingsV2`. Legacy v1 settings migrate to the profile
format; no legacy flight envelope is silently upgraded. Export important saves before clearing browser
site data. The settings DTO inside a v2 save intentionally stays version 1 and is validated strictly.

### Known limitations

This is a single-spacecraft desktop browser sandbox, not a mission campaign. Atmospheric launch,
landing, docking, multiplayer, and mobile/touch-specific flight remain outside v1. GitHub Pages lacks
cross-origin isolation, so the trajectory worker transfers typed arrays instead of using
`SharedArrayBuffer`.

Only the M4 atmospheric-launch chain remains explicitly deferred: T0060 (USSA76 atmosphere), T0061
(2D Alcântara launch simulation), and T0062 (2D-to-3D handoff). Every other canonical task is complete
as part of the v1 release audit.

### Verification contract

The annotated `v1.0.0` tag is created only after the exact `main` commit has passed repository CI,
deployed successfully through GitHub Pages, and passed a cache-disabled live launch audit with no
missing assets or console/page errors. The generated [task dashboard](check_plan.html) is checked
against every canonical YAML task in CI.
