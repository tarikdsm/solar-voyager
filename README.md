# Solar Voyager

Solar Voyager is a realistic browser-based solar-system exploration game. Pilot a photon-drive
spacecraft from a canonical 400 km low Earth orbit, plan burns against a float64 n-body simulation,
and watch relativistic effects emerge as velocity increases.

**[Play Solar Voyager](https://tarikdsm.github.io/solar-voyager/)**

## Start a flight

1. Open the game in a current desktop Chrome or Firefox browser with WebGL2 enabled.
2. Wait for the measured loading sequence to reach the main menu.
3. Select **New Game**. The optional tutorial introduces focus, camera, flight controls, instruments,
   time warp, the system map, burn log, performance panel, and saves.
4. Use `W`/`S`, `A`/`D`, and `Z`/`C` for attitude; `R`/`F` for throttle; and `=`/`-` for time warp.

All flight bindings can be changed before launch or during a session. See the complete
[controls reference](docs/controls.md).

## What v1 includes

- Real-scale Sun, planets, major moons, dwarf planets, asteroids, and comets on JPL-derived rails.
- Allocation-conscious float64 n-body spacecraft propagation in km, km/s, seconds, and km³/s².
- Photon-drive energy ledger, attitude modes, burn history, orbital elements, state vectors, and
  trajectory prediction with SOI, closest-approach, and impact markers.
- Light-time, stellar aberration, Doppler shift, relativistic beaming, and dual coordinate/proper
  clocks.
- Interactive system map, camera focus controls, guided tutorial, save/export/import, and rebindable
  input.
- Tiered deterministic Blender/KTX2 assets, procedural Sun and gas giants, post-processing, automatic
  startup quality selection, and an adaptive 60 fps quality governor.

## Saves and compatibility

The game automatically stores data only in this browser profile:

- `solar-voyager.save.v2` — the current flight envelope;
- `solar-voyager.settings.v2` — quality, bindings, and tutorial progress;
- `solar-voyager.settings.v1` — read only for one-time legacy settings migration.

Use **Session & settings → Export** to download `solar-voyager-save.json` before clearing site data or
moving to another browser. **Import** validates the entire v2 envelope before activating it. Older or
malformed flight envelopes are rejected rather than partially loaded. The settings DTO embedded in a
v2 save intentionally remains schema version 1; that is part of the v2 compatibility contract.

See [privacy](docs/privacy.md) for the exact data boundary.

## Hardware and browser guidance

WebGL2 is required. A discrete GPU is not required, but a hardware-accelerated browser and current GPU
driver provide the intended 60 fps experience. Solar Voyager requests a high-performance context,
measures the prepared scene at startup, and selects a conservative quality rung. If the renderer is
software-based or restricted, the game shows an accessible warning and disables unsupported effects;
it does not claim that hardware acceleration was forced.

If that warning appears:

1. update the browser and the operating-system or GPU-vendor graphics driver;
2. enable the browser's “graphics/hardware acceleration when available” setting, then restart it;
3. inspect `chrome://gpu` in Chromium-based browsers or Graphics in `about:support` in Firefox;
4. close GPU-heavy tabs and retry with quality set to **Auto** or **Low**.

Mozilla documents [WebGL and graphics-driver troubleshooting](https://support.mozilla.org/en-US/kb/upgrade-graphics-drivers-use-hardware-acceleration)
and [Firefox performance settings](https://support.mozilla.org/en-US/kb/performance-settings).
Managed devices, remote desktops, virtual machines, privacy hardening, or driver blocklists may still
prevent hardware WebGL.

## Known limitations and post-v1 scope

Solar Voyager v1 is a desktop-class orbital sandbox with one controllable spacecraft. It does not yet
include missions, atmospheric flight, launch, landing, docking, multiplayer, or mobile/touch-specific
controls. The M4 atmospheric-launch chain is explicitly deferred after v1:

- T0060 — US Standard Atmosphere 1976;
- T0061 — 2D launch simulation from Alcântara;
- T0062 — 2D-to-3D launch handoff.

GitHub Pages does not provide the cross-origin isolation headers required by `SharedArrayBuffer`, so
trajectory prediction uses transferable typed arrays in its worker. This is supported but can be less
efficient than a future isolated deployment. Read the full [v1 release notes](docs/release-notes.md).

## Development

Requirements: Node.js 22.12 or newer; Python 3.9 for the tool suite; Blender 5.1 only when rebuilding
authored assets.

```powershell
npm ci
npm run dev
```

Vite serves the game under `/solar-voyager/`. Before changing code, read
[the architecture](docs/architecture.md) and [mandatory task protocol](docs/task-protocol.md), then
claim one YAML task. Physics work must follow [the physics specification](docs/physics-spec.md), and
render work must follow [the performance specification](docs/performance-spec.md).

Core release checks:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:tools
npm run build
npm run check:budgets
npm run check:tasks
npm run check:dashboard
npm run check:licenses
npm run check:release
```

Browser/render/performance gates are individual `test:*` and `bench:*` scripts in
[package.json](package.json) and run permanently in CI. Assets are regenerated only through the
[asset pipeline](docs/asset-pipeline.md); exported runtime files are never hand-edited. The generated
[task dashboard](docs/check_plan.html) must match the canonical YAML queue exactly.

## Project documentation

- [Controls](docs/controls.md)
- [Accessibility](docs/accessibility.md)
- [Privacy](docs/privacy.md)
- [Credits and third-party material](docs/credits.md)
- [Release notes](docs/release-notes.md)
- [Architecture](docs/architecture.md)
- [Contributor workflow](docs/task-protocol.md)

## License

Solar Voyager source code is available under the [MIT License](LICENSE). Data, textures, models, and
other media retain the terms recorded for each source or generated artifact; see
[credits](docs/credits.md), the distributable [third-party software notices](public/THIRD_PARTY_LICENSES.txt),
and each asset's `SOURCES.md`.
