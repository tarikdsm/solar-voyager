# ADR-041: Audio architecture and licensing intake

**Status:** accepted (2026-08-16)

## Context

The game has no sound. Before this task, `grep -ri "AudioContext\|autoplay\|webaudio"`
over `src/`, `tools/` and `tests/` returned nothing outside the plan documents.

Spec §9 asks for adaptive music, a ship sound bed, a UI click set, a camera-aware
mix ("Kubrick mode": exterior cameras go vacuum-silent), and a volume mixer in
settings. T0145 sources the assets; T0146 wants a milestone chime; T0119 wants
cruise cues; T0150 wants an intro. All four attach to whatever this task builds,
so the shape decided here is the one the rest of V2M5 inherits.

Four constraints pull against each other:

1. **Browser autoplay policy.** Audio started without a user gesture is blocked,
   and Chrome logs a warning when it happens. Six of our browser harnesses reach
   gameplay through `?autostart=1` — a code path with no human and therefore no
   gesture, ever.
2. **Zero allocations in the frame path** (performance-spec §5), on a subsystem
   that naturally wants to allocate option objects and layer arrays per frame.
3. **The milestone must ship before any audio asset exists.** T0145 is a separate
   task with a sourcing dependency; V2M5 cannot be gated on it.
4. **Audio decisions are game logic and must be testable as such.** "Which music
   layer should be up" is a rule, not a sound.

Design record: `docs/superpowers/specs/2026-08-16-audio-engine-design.md`.

## Decision

### 1. Three modules; the seam between the first two is the architecture

```
snapshot facts ─► AudioDirector ─► AudioMixState ─► WebAudioEngine ─► AudioParam writes
  (primitives)    (pure, Vitest)   (preallocated)   (owns the graph)   (browser)
                                                          ▲
                            bootstrap/composition.ts ──────┘  gesture + visibility adapters
```

- **`src/game/audio/audioDirector.ts`** is pure: no `AudioContext`, no DOM, no
  clock. Every threshold, curve and hold timer in the subsystem lives here.
  `update(snapshot, cameraMode, paused, wallDtSec)` rewrites one preallocated
  `AudioMixState`; it allocates nothing and it is unit-tested in Node with no Web
  Audio API present (the suite asserts `globalThis.AudioContext === undefined`).
- **`src/game/audio/audioEngine.ts`** owns the graph, the hum and the lifecycle,
  and **decides nothing**. It reads an `AudioMixState` and moves `AudioParam`s.
- **`src/game/audio/audioSystem.ts`** joins them, so the frame loop holds one
  field and calls one method, and later tasks attach to one object.
- **`src/bootstrap/composition.ts`** supplies `createContext()`, the one-shot
  gesture listener and the `visibilitychange` listener — exactly as it already
  supplies `PointerLockSurface`, `GamepadHost` and `KeyValueStorage`. `game/`
  never reaches for `window` or `document`.

Rejected: one class owning both halves. It is fewer files and it is what most
codebases do, and it would put a 16-branch decision table (throttle × warp × body
class × warning × camera × pause) behind a real browser, where every future
tuning change costs a Playwright run.

Rejected: putting the director in `src/sim/`. It reads camera mode and user
settings, neither of which exists there, and pushing both into `SimSnapshot`
would be an ADR-gated change to the snapshot contract for a presentation concern.

### 2. The AudioContext is not constructed until a user gesture

Not "constructed suspended and resumed on a gesture" — **not constructed at all**.

Chrome emits the autoplay warning when a context exists and is blocked from
starting. A context that does not exist cannot be blocked and cannot warn. The
eager-construct-then-resume pattern is the common one and it is precisely the one
that warns on a headless page that never receives a gesture.

```
composition installs one-shot { pointerdown, keydown } on window (capture, passive)
   │
   ├─ no gesture ever  → context null, contextState 'none', creations 0.
   │                     The director still runs; the output is silent. No warning.
   │
   └─ first gesture    → unlock(): createContext (once, ever) → build graph →
                         start oscillators → resume() → remove both listeners
```

`resume()`, `suspend()` and `close()` return promises, and every one is
`.catch(() => undefined)`. An unhandled rejection surfaces as a Playwright
`pageerror` and fails every browser gate — the same trap
`createCanvasPointerLockSurface` already documents for `requestPointerLock`.

**Hidden tab:** `visibilitychange` suspends and resumes, tracked separately from
`unlocked` so a page hidden before the first gesture does not resume into an
unlocked state on return, and a double hide does not suspend twice. Rejected:
suspending on `blur` — blur fires when the player alt-tabs to a wiki with the
game still visible on a second monitor.

### 3. The game ships audible, not muted

The task brief required this be argued and closed. **Closed: not muted.** Defaults
are `master 0.70, music 0.50, sfx 0.70, ui 0.50, exteriorMusic true`.

The muted-by-default case is real: a browser game is a link someone opens at work,
and unbidden noise is hostile. It loses on three counts:

1. **The lifecycle already satisfies the premise.** Page load, tab restore and
   `?autostart=1` are silent whatever the default level is, because no context
   exists. The only gesture that can reach the speakers is one the player
   performed inside the game.
2. **A default of zero is a default of "off".** The milestone is called "Alive".
   Audio the player must first discover in a settings panel is audio approximately
   nobody hears, and T0145/T0146/T0150 would be built for an audience that has it
   disabled. Shipping a feature switched off is not a conservative launch, it is a
   non-launch.
3. **Consent is what a gesture means.** The autoplay policy is itself built on
   that premise. Clicking **New Game** is the least ambiguous gesture in the
   product.

Accepted cost: a player with speakers up who clicks New Game hears the ship. The
mixer is in Settings, reachable from the pause menu, and `master = 0` persists.

### 4. The graph: four bus GainNodes

```
                                     ┌─ music bus ──┐   (4 layer gains feed it)
  [T0145 stems] ───────────────────►─┤              │
  saw A (−d/2) ┐                     │              │
  saw B (+d/2) ┼─► lowpass ─► engine─┤  sfx bus ────┼──► master ──► destination
  noise (loop) ┘                     │              │
  [T0145 UI clicks] ───────────────►─┤  ui bus ─────┘
```

- **music / sfx / ui → master** are the four buses of the acceptance criterion.
  The hum chain adds two internal gains (engine level, four layer gains) which are
  implementation, not mixer topology.
- **The hum rides the sfx bus.** It is diegetic ship sound, so Kubrick mode
  silences it along with everything else. Giving it a fifth bus was the first
  sketch and it was wrong: the Kubrick rule would have to be wired twice.
- **The ui bus is never silenced by camera mode.** UI sound is not in the vacuum,
  and a settings panel whose buttons stop clicking reads as a bug.
- **Four music layer gains exist now, with no sources.** T0145 connects a stem to
  `engine.musicLayerInput(i)` and is done; the crossfade already drives them.

### 5. The hum is synthesized, so V2M5 ships before any asset

| element | value |
|---|---|
| saw A / saw B | `sawtooth`, 55 Hz (A1), detuned `−d/2` and `+d/2` |
| noise | 2 s white-noise `AudioBuffer`, `loop`, amplitude baked at 0.12 |
| filter | `lowpass`, `Q = 0.9`, cutoff `220 + 3400·throttle^0.8` Hz |
| level | `(0.12 + 0.88·throttle^0.6) · (1 − 0.85·warpMuffle)` |
| detune | `d = 6 + 18·throttle + 26·gammaStress` cents |

Two saws `d` cents apart beat at `2·d·f/1200` Hz — 0.32 Hz at 55 Hz and 6 cents —
which is what makes a drone sound like a machine rather than a test tone.
Widening `d` with throttle turns the sway into a growl **without changing pitch**:
a photon drive has no RPM, and pitch-shifting it would be a lie about the
propulsion this codebase is otherwise careful about. The detune is split
symmetrically for the same reason.

The oscillators start once and are never stopped. `OscillatorNode` is single-use,
so an engine that stopped the hum at throttle zero would have to allocate a
replacement node per burn, in the frame path.

Noise is a filled `AudioBuffer`, not an `AudioWorklet` (a network fetch for white
noise) and not a `ScriptProcessorNode` (main thread, deprecated).

### 6. Director decisions

**Perspective.** `chase`/`cockpit` → interior; `cinematic`/`observatory` →
exterior, `sfxBusGain = 0`. Music on exterior follows `settings.exteriorMusic`.
All four modes are mapped now even though `cockpit`/`cinematic` arrive with
T0124/T0125, so those tasks inherit the contract instead of a `default:` branch
that would silently classify cockpit as exterior on the day it lands.

**Music context**, highest priority first: `warning` (impact flag or
`impactOccurred`), `near-sun` (dominant body class `star`), `giant-approach`
(class `giant`), else `deep-space`. Body class is an injected
`readonly AudioBodyClass[]` indexed like `snapshot.bodyIds`, built once from
`data/bodies.json` (`surface.kind === 'gas'` marks the four giants), so the
director never imports the catalog.

Hysteresis: dominant body is already hysteretic (ADR-029). The impact warning is
not, so `warning` gets a **4 s release hold** — entry immediate (the value of the
cue is that it is early), exit held, so a predicted impact flickering across a
periapsis cannot strobe the score.

**Crossfade** is 4 s (spec §9) and lives in the director as a linear per-layer
ramp published as `sqrt(ramp)`, which is equal-power (the sum of squares holds at
unity through a two-layer blend) while still starting from silence.

**Warp.** `warpMuffle = clamp01(log10(warp)/log10(MAX_THRUST_WARP))` cuts the hum
by 85% and the sfx bus by 60%. At 1000× `Commands.setThrottle` already forces the
throttle to zero, so a continuous drive tone there would describe a burn that is
not happening, and discrete SFX at 10⁷× would be a machine gun. **Music is
untouched by warp** — it is non-diegetic and is the one thing that should survive
a time skip.

**Gamma.** `gammaStress = clamp01(log10(γ))` (0 at rest, 1 at γ = 10) widens the
detune and ducks the music bus by up to 35%. Nothing about the ship's interior
physically changes with γ — the ship is at rest in its own frame — so pitching
the hum would be dishonest. Letting the ship's own voice take the room from the
score as you approach c is a composition choice, recorded as one.

**Pause.** T0112's pause holds the simulation at zero while the loop keeps
running. The sfx bus mutes (a held world has nothing to sustain a sound about);
music continues, and the crossfade advances, because audio is driven by the
**wall** delta, never `simDeltaSec` — a 4 s transition on a zeroed delta would
freeze mid-blend for the whole menu visit.

### 7. Settings: profile generation v7

**Amended at merge time.** This was written as v6; T0127 (adaptive exposure) landed
its own v6 on `main` first, adding `render.exposureMode`. The mixer therefore
becomes **v7**, and the two stay *separate* migration tiers (v5→v6 attaches the
exposure mode, v6→v7 attaches the mixer) rather than being folded into one
generation. Folding them would have been fewer lines and a lie: the chain is the
only record of what was added when, and a player whose profile predates only one
of the two features must be migrated through only the tier that concerns them.
`LEGACY_V6_SETTINGS_STORAGE_KEY` is the new read-and-migrate tier 2, so the
`SettingsRepository.load()` ladder is now seven tiers deep.

New key `solar-voyager.settings.v7`; the v6 key becomes read-and-migrate tier 2;
`migrateProfileV6ToV7` attaches `DEFAULT_AUDIO_SETTINGS` as a whole-document
migration (there is nothing inside a v6 document to backfill `audio` from). Same
dedicated-key-per-generation reasoning as ADR-034 §4 and T0106's design doc: a
downgraded build reads its own key and cannot clobber the newer document.

Levels persist as the **slider position** in [0, 1], not as a gain. The taper
(`gain = v²`) is applied in the director, so the stored number is the one the
panel shows and a future taper change does not invalidate every stored profile.
`v²` over a decibel curve because it is exact at both ends and monotone; a true
`20·log10` fader needs a floor constant that would have to be persisted too.

### 8. Diagnostics

An eighth frozen `canvas.solarVoyager*` object, `solarVoyagerAudio`, carrying
`unlocked`, `contextState`, `contextCreationCount`, `unlockAttemptCount`,
`paramWriteCount`, `suspendedByVisibility` and the published mix.

`RuntimeResourceCounts` is deliberately **not** extended with
`audioContextCreations`, even though that is where it belongs by type:
`tools/tests/mainMenuRegression.mjs` pins that object twice with `deepEqual`, and
the count is gesture-dependent (0 at the menu, 1 after the New Game click), so it
would make an unrelated gate's fixture depend on how a harness happens to reach
the space phase.

### 9. Frame path

`AudioDirector.update()` is arithmetic into preallocated storage.
`WebAudioEngine.apply()` compares each of twelve params against its last written
value and skips below an audible epsilon (`1e-4` gain, `0.5` Hz, `0.05` cents), so
**steady flight writes zero params per frame** and a throttle ramp writes two or
three. Changed params get one `setTargetAtTime` (τ = 0.12 s buses, 0.05 s drive)
rather than a `param.value` assignment, which would apply at the next 128-sample
quantum and hold — an audible 16.7 ms staircase at 60 Hz. A non-finite target is
dropped rather than written: it would poison the automation curve for the session.

### 10. Licensing intake (the contract T0145 fills)

This task ships **no audio asset and no runtime dependency**, so nothing enters
the licence surface yet. The rules T0145 must satisfy:

1. **`data/audio-manifest.json` is the only way an audio file enters the build**,
   with a JSON Schema beside it (the plan's rule for every new `data/` catalog).
   Every entry carries `id`, `path`, `sha256`, `license`, `licenseUrl`, `source`,
   `sourceUrl` and `attribution`.
2. **CC0 or CC-BY only.** No NC, no ND, no SA, no "free for non-commercial",
   no unlicensed "found it on a forum". CC-BY entries must carry an
   `attribution` string, and the credits build step lists them automatically.
3. **`npm run check:licenses` is extended to audio and must fail on a missing or
   incomplete entry**, proven with a committed fixture — a licence gate that has
   never been seen to fail is not a gate.
4. **Provenance is per file, not per pack.** A pack downloaded as one archive
   still gets one manifest entry per shipped file, with the checksum of the file
   we ship, so a re-encode is visible as a change.
5. **Audio is never in the startup critical path.** `data/initial-path.json` does
   not gain audio; stems lazy-load after gameplay activation, total ≤ 12 MB.
6. **Kubrick-mode honesty labelling.** The settings copy states plainly that
   exterior cameras are silent because there is no medium out there to carry
   sound — the silence is the physics, not a missing feature. That sentence ships
   with the mixer (it is in the panel today) and T0145 must not quietly replace it
   with exterior ambience.

## Consequences

- V2M5 has working audio with zero assets and zero new dependencies.
- Every audio *rule* is a Vitest test; only "does it make a noise" needs a browser.
- The autoplay criterion is verified by a new gate (`npm run test:audio`) that
  collects console **warnings** as well as errors, because every existing harness
  filters `type() === 'error'` and Chrome emits the autoplay message at `warning`
  level — the criterion was not merely unverified, it would have *looked* verified.
- The settings key bump touches every browser fixture that hand-writes a profile.
  Those fixtures stay hand-written on purpose (`hudPresetProfile.mjs`: "importing
  the app's own constant would let a schema change pass its gate by moving both
  sides at once").
- T0145 inherits: `musicLayerInput(i)` for stems, the sfx and ui buses for
  one-shots, the manifest contract in §10, and a crossfade it does not have to
  write.

## Alternatives considered

- **A tiny audio library (howler.js, tone.js).** Rejected: plan §8 forbids new
  runtime dependencies without an ADR, and the two things a library would give us
  — a bus graph and a crossfade — are 200 lines we need to own anyway because the
  crossfade has to be observable from a browser gate.
- **`AudioContext` created eagerly and resumed on gesture.** Rejected in §2.
- **Muted until the first volume interaction.** Rejected in §3.
- **Sound bed pitched by γ or by warp.** Rejected: dishonest about a photon drive
  and about the ship's own rest frame. Warp muffles, γ widens the beat.
- **Extending `RuntimeResourceCounts`.** Rejected in §8.
