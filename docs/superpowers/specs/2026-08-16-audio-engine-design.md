# T0144 — Web Audio engine, AudioDirector, mixer, Kubrick mode — Design

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §9.
Release plan block: `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §5, T0144.
Decision record: `docs/decisions/ADR-041-audio-architecture.md` (same PR).

## 0. The problem, stated precisely

The game has no sound at all. `grep -ri "AudioContext\|autoplay\|webaudio" src/ tools/ tests/` returns
nothing outside the plan documents. So this task is not "add a sound"; it is "decide, once, what the
audio subsystem *is*", because T0145 (assets), T0146 (milestone chime), T0119 (cruise HUD) and T0150
(intro) all bolt onto whatever lands here.

Four things have to be true at once and they pull against each other:

1. **Zero autoplay warnings.** Browsers block audio started without a user gesture, and Chrome logs
   `The AudioContext was not allowed to start.` when it happens. The smoke gate asserts on
   `console` messages of type `error`, so that particular warning would *not* fail it today
   (Chrome emits it at `warning` level — verified against `tools/smoke/applicationSmokeContract.mjs`
   line 217 and Playwright's `Log.entryAdded` forwarding). That is a hole, not a licence: the new
   gate collects warnings explicitly and fails on the autoplay string.
2. **Decisions must be testable without a browser.** "Which music layer should be up right now" is
   game logic. If it lives inside a class that owns an `AudioContext`, it is testable only in
   Playwright, and every future tuning change costs a browser run.
3. **Zero allocation in the frame path** (performance-spec §5), on a subsystem that naturally wants
   to allocate: option objects for `setTargetAtTime`, string literals for layer names, arrays of
   layer gains.
4. **The milestone must ship before any audio asset exists.** T0145 is a separate task and might
   slip; V2M5 cannot be gated on sourcing CC0 stems.

## 1. The split: director / engine / adapter

Three modules, and the seam between the first two is the whole design.

```
snapshot facts ─► AudioDirector ─► AudioMixState ─► WebAudioEngine ─► AudioParam writes
  (pure data)     (pure, Vitest)   (preallocated)   (owns the graph)   (browser)
                                                          ▲
                            bootstrap/composition.ts ──────┘  (gesture + visibility adapters)
```

- **`src/game/audio/audioDirector.ts`** — pure. No `AudioContext`, no DOM, no `Date.now()`. Takes
  primitive facts, writes a preallocated `AudioMixState`. Every threshold, curve and hold timer in
  the subsystem lives here, so every one of them is unit-testable in Node. This is the acceptance
  criterion and it is also the reason the module exists.
- **`src/game/audio/audioEngine.ts`** — owns the four-bus graph, the synthesized hum, the context
  lifecycle, and the param writes. Decides *nothing*: it reads `AudioMixState` and moves gains.
- **`src/bootstrap/composition.ts`** — supplies `createContext()`, the one-shot gesture listener and
  the `visibilitychange` listener, exactly as it already supplies `PointerLockSurface`,
  `GamepadHost` and `KeyValueStorage`. `game/` never touches `window` or `document`.

Rejected: one `AudioSystem` class owning both. It is fewer files and it is what most codebases do,
and it makes the layer-state table (16 branches over throttle × warp × body class × warning ×
camera) reachable only through a real browser. The plan's acceptance text says "pure decision module
unit-tested without an AudioContext" precisely to prevent that.

Rejected: putting the director in `src/sim/`. It is a presentation decision that reads camera mode
and user settings — neither of which exists in `sim/`, and both of which would have to be pushed
into `SimSnapshot` (an ADR-gated change) to get there. `game/` is the right layer and the plan
already places it there.

## 2. Decision: **the game does not ship muted**

This is the one the task brief demands be argued and closed. Closed: **audio is on by default at
modest levels; it is not muted-until-you-find-the-slider.**

The case for muted-by-default is real and I took it seriously: a browser game is a link someone
opens at work, unbidden noise is hostile, and shipping muted makes the autoplay problem
disappear by construction.

It loses on three counts:

1. **The premise is already satisfied by the lifecycle, not by the mute.** The context is not
   constructed until a real user gesture (§3), and the only gesture that reaches it is one the
   player performed *inside the game* — the click that starts or resumes a session. Page load is
   silent. Tab-restore is silent. `?autostart=1` with no human present is silent, forever, because
   no gesture ever arrives. The hostile-autoplay scenario has no path to the speakers whether or not
   the default is 0.
2. **A default of zero is a default of "off".** The milestone is called "Alive". Audio the player
   must first discover in `Session & settings → Audio` is audio approximately nobody hears, and the
   subsequent tasks (adaptive stems, milestone chimes, the intro) would be built for an audience
   that has it disabled. Shipping a feature switched off is not a conservative launch posture, it is
   a non-launch.
3. **Consent is what the gesture means.** Chrome's autoplay policy is itself built on the premise
   that a user gesture on the page is consent to make sound. Clicking **New Game** is not an
   ambiguous gesture; it is the least ambiguous one in the product.

Defaults, deliberately below unity so the first second is not a surprise (spec §9 "default modest"):

| bus | default | why |
|---|---|---|
| master | 0.70 | leaves headroom above the default for a player on quiet speakers |
| music | 0.50 | the score is a bed, not the subject |
| sfx | 0.70 | the ship is the subject |
| ui | 0.50 | clicks confirm, they do not announce |

`exteriorMusic` defaults **true** (§5). All five persist in the profile document (§6).

What this costs, and accepted: a player who opens the game at a desk with speakers up and clicks New
Game hears the ship. The mixer is in Settings, reachable from the pause menu, and `master = 0`
persists. That is the standard bargain every game makes.

## 3. AudioContext lifecycle

**The context is not constructed until the first user gesture.** Not "constructed suspended and
resumed later" — not constructed at all.

That distinction is the whole autoplay story. Chrome emits the autoplay console warning when a
context exists and is blocked from starting; a context that does not exist cannot be blocked and
cannot warn. Constructing eagerly and resuming later is the more common pattern and it is the one
that produces the warning in a headless gate with no gesture — which is exactly the state
`?autostart=1` leaves the page in for six of our browser harnesses.

```
composition installs one-shot { pointerdown, keydown } listeners on window (capture, passive)
        │
        ├─ no gesture ever  ──► context === null, unlockAttemptCount 0, contextState 'none'
        │                        update() runs the director, touches nothing. Silence. No warning.
        │
        └─ first gesture   ──► engine.unlock()
                                 ├─ createContext()          (contextCreationCount → 1, once, ever)
                                 ├─ build graph + start hum  (oscillators run for the session)
                                 ├─ context.resume()         (promise; .catch swallows)
                                 └─ remove both listeners
```

`resume()` and `suspend()` return promises. Both get `.catch(() => undefined)`. An unhandled
rejection surfaces as a Playwright `pageerror`, which fails every browser gate — the same trap
`createCanvasPointerLockSurface` already documents for `requestPointerLock`.

**Hidden tab:** `document.visibilitychange` → `suspend()` when hidden, `resume()` when visible, but
only when the engine was unlocked and only when it was not already suspended for another reason. The
engine tracks `suspendedByVisibility` separately from `unlocked` so a tab hidden before the first
gesture does not "resume" into an unlocked state on return. Rejected: `AudioContext.suspend()` on
blur — blur fires when the player alt-tabs to a wiki with the game still visible on a second monitor,
and killing the score there is wrong.

The oscillators are started once and never stopped. `OscillatorNode` is single-use — a stopped one
cannot restart — so an engine that stopped the hum at throttle 0 would have to allocate a new node
per burn, in the frame path. Instead the hum runs for the session and is gated entirely by its gain.

## 4. The graph

Four `GainNode`s, as the acceptance criterion specifies, plus the hum's own chain:

```
                                    ┌─ music bus ──┐
  [T0145 stems] ──────────────────►─┤              │
                                    │              │
  saw A (detune −d) ┐               │              │
  saw B (detune +d) ┼─► lowpass ──►─┤  sfx bus ────┼──► master ──► destination
  noise (looped)  ──┘               │              │
                                    │              │
  [T0145 UI clicks] ──────────────►─┤  ui bus ─────┘
```

- **Music bus.** Nothing feeds it in this task; the crossfade weights are computed and published
  anyway (`AudioMixState.musicLayerGains`), so T0145 attaches four stem sources and is done.
- **SFX bus.** The engine hum lives here, because the hum is diegetic ship sound and Kubrick mode
  has to silence it along with everything else. Putting the hum on its own fifth bus was the first
  sketch and it was wrong: it would need the same Kubrick rule wired twice.
- **UI bus.** Never silenced by Kubrick. A settings panel whose buttons stop clicking because you
  switched to the observatory camera reads as a bug, and UI sound is not in the vacuum.

**The hum** (`2 detuned saws + noise through a lowpass`, keyed to throttle):

| element | value |
|---|---|
| saw A | `type 'sawtooth'`, 55 Hz (A1), `detune = −d` |
| saw B | `type 'sawtooth'`, 55 Hz, `detune = +d` |
| noise | 2 s of white noise in an `AudioBuffer`, `loop = true`, through its own −18 dB trim |
| filter | `BiquadFilterNode 'lowpass'`, `Q = 0.9`, cutoff keyed to throttle |

Two saws a few cents apart beat at `2·d·f/1200` Hz — at 55 Hz and 6 cents that is a 0.32 Hz sway,
which is what makes a synthesized drone sound like a machine rather than a test tone. Widening `d`
with throttle turns the sway into a growl without changing pitch, so the hum never sounds like it is
"revving" — a photon drive has no RPM and pitch-shifting it would be a lie about the propulsion the
whole codebase is careful about.

The noise buffer is 2 s of `Math.random()` filled once at unlock. Rejected: `createScriptProcessor`
or an `AudioWorklet` noise generator — a worklet is a second module fetched over the network for
white noise, and `ScriptProcessorNode` runs on the main thread and is deprecated.

## 5. Director decisions (the actual table)

All of this is `src/game/audio/audioDirector.ts` and all of it is unit-tested in Node.

### 5.1 Perspective — Kubrick mode

```
chase, cockpit         → 'interior'   sfx bus = sfx level
cinematic, observatory → 'exterior'   sfx bus = 0
```

Music on exterior follows `settings.exteriorMusic`: `true` keeps the score, `false` gives the full
2001 vacuum. UI is unaffected. Note `cockpit` and `cinematic` do not exist yet (T0124/T0125 add
them to `IMPLEMENTED_CAMERA_MODES`); the director maps all four now because the mapping is the
contract those tasks will inherit, and mapping only two would leave a `default:` branch that
silently classified `cockpit` as exterior on the day T0124 lands.

The transition is not instant. A hard `sfxBusGain = 0` on the frame the camera switches produces a
click; the engine ramps every bus with a 120 ms time constant (§7), and the camera cross-fade itself
is 0.7 s, so the silence arrives with the picture.

### 5.2 Music context

Priority, highest first:

1. `warning` — `warningFlags & IMPACT`, or `impactOccurred === 1`.
2. `near-sun` — dominant body class `star`.
3. `giant-approach` — dominant body class `giant`.
4. `deep-space` — otherwise.

Body class comes from an injected `readonly AudioBodyClass[]` indexed like `snapshot.bodyIds`, built
once at composition from `data/bodies.json`. The director never imports the catalog: it stays pure
and a test can hand it a three-element array. Classification: `surface.kind === 'stellar'` → `star`;
`surface.kind === 'gas'` → `giant` (Jupiter, Saturn, Uranus, Neptune — the four the catalog marks);
`kind === 'planet' | 'dwarf'` → `terrestrial`; `kind === 'moon'` → `moon`; `asteroid | comet` →
`small`; index `< 0` → `none`.

**Hysteresis.** Dominant body already has SOI hysteresis in `sim/analysis/dominantBody.ts`
(ADR-029), so `near-sun`/`giant-approach` cannot chatter. The impact warning can: a predicted impact
that flickers on and off across a periapsis would strobe the score. `warning` therefore has a 4.0 s
release hold — once entered it cannot be left for 4 s after the flag clears. Entry is immediate;
the whole point of the cue is that it is early.

Crossfade is **4 s** (spec §9) and lives here, as a per-layer linear approach to a one-hot target at
`1/4` per second. Doing it in the director rather than with `setTargetAtTime` on four gains means
the browser gate can read the intermediate weights and prove the crossfade happened, and it means
T0145 does not have to re-derive it.

### 5.3 Engine hum

```
engineGain    = IDLE + (1 − IDLE)·throttle^0.6           IDLE = 0.12
engineCutoff  = 220 + 3400·throttle^0.8                  Hz
engineDetune  = 6 + 18·throttle + 26·gammaStress         cents
```

`throttle^0.6` because loudness is roughly amplitude^0.6; a linear map makes the first 20% of the
lever do almost nothing audible. The idle bed at 0.12 is the reactor, not the drive — the ship is
never a dead object.

**Gamma.** `gammaStress = clamp01(log10(γ) / log10(10))`, so 0 at rest and 1 at γ = 10. It widens
the detune (the beat sharpens into unease) and ducks the music bus by up to 35%. Nothing about the
ship's interior physically changes with γ — the ship is at rest in its own frame — so pitching the
hum up would be dishonest. What is honest is that the drive is running at a power level that got you
there, and letting the ship's own voice take the room from the score as you approach c is a
composition choice, recorded as one.

**Warp.** `warpMuffle = clamp01(log10(warp) / log10(1000))` — 0 at 1×, 1 at `MAX_THRUST_WARP`
(1000×) and above. It cuts the hum by 85% and the sfx bus by 60%. At 1000× the throttle is force-
zeroed by `Commands.setThrottle` anyway, so a continuous drive tone up there would be describing a
burn that is not happening; and discrete SFX at 10⁷× would be a machine gun. Music is deliberately
untouched by warp: it is not diegetic, it is the only thing that should survive a time skip.

## 6. Settings: profile generation v6

Fifth generation of the same pattern, sixth document version. New key
`solar-voyager.settings.v6`, `LEGACY_V5_SETTINGS_STORAGE_KEY` added as read-and-migrate tier 2,
`migrateProfileV5ToV6` attaching `DEFAULT_AUDIO_SETTINGS`. Whole-document migration, not a per-field
backfill, for the reason each previous generation gives: `audio` is a brand-new required object and
there is nothing inside a v5 document to recover it from.

```ts
export interface AudioSettings {
  readonly master: number;         // [0,1]
  readonly music: number;
  readonly sfx: number;
  readonly ui: number;
  readonly exteriorMusic: boolean; // Kubrick: keep the score on exterior cameras
}
```

Levels are stored as the **slider position**, not the gain. The taper (`gain = v²`) is applied in the
director, so the persisted number is the one the UI shows and a future taper change does not
invalidate every stored profile. `v²` is chosen over a dB curve because it is exact at both ends
(0 → silence, 1 → unity) and monotone, and because a true `20·log10` fader needs a floor constant
that then has to be persisted too.

Blast radius of the key bump, all updated in this PR:
`src/game/settings.ts`, `src/game/settings.test.ts`, `src/game/sessionController.ts`(+test),
`src/ui/SessionSettingsPanel.tsx`(+test), `tests/render/sessionSettingsPage.tsx`,
`tools/tests/hudPresetProfile.mjs`, `tools/tests/hudPresetsRegression.mjs`,
`tools/tests/tutorialRegression.mjs`, `docs/architecture.md`. `tools/perf/browserSettings.mjs`
deliberately stays on the **v2** key: its whole job is to exercise the full migration chain on every
perf run, and it now exercises one tier more.

## 7. Frame path: what actually runs at 60 Hz

`frameLoop.ts` calls `audio.update(snapshot, cameraMode, deltaSec)` once per frame, in the UI window
(it is a consumer of the snapshot, not a producer). Inside:

1. `AudioDirector.update()` — arithmetic into a preallocated `AudioMixState`. No `new`, no literals,
   no closures, no array helpers. The four crossfade weights are a `Float64Array(4)` allocated once.
2. `WebAudioEngine.apply()` — for each of ~7 params, compare against the last written value and skip
   if `|Δ| < 1e-4`. Changed params get one `setTargetAtTime(target, currentTime, τ)` with
   `τ = 0.12` for buses and `0.05` for the hum. Steady flight writes **zero** params per frame;
   a throttle ramp writes two or three.

`setTargetAtTime` rather than `param.value = x`: a direct assignment applies at the next 128-sample
render quantum and holds, so 60 Hz assignment on a loud tone is a 16.7 ms staircase — audible zipper.
`setTargetAtTime` hands the interpolation to the audio thread, which is the whole reason `AudioParam`
has an automation API.

Before unlock, step 2 is skipped entirely (`context === null`) and step 1 still runs, so the
diagnostic is live and the browser gate can prove the *decisions* are correct while the *output* is
correctly silent.

## 8. Diagnostics

An eighth frozen `canvas.solarVoyager*` object, `solarVoyagerAudio`, declared in
`src/bootstrap/diagnostics.ts` next to the other seven and added to
`tests/architecture/diagnosticsContract.test.ts`'s `DIAGNOSTIC_PROPERTIES` and `EXPECTED_MEMBERS`.
Getter-only, `Object.create(null)`-prototyped, frozen, defined with a single-key `{ value }`
descriptor — the contract test checks all of that structurally.

**`RuntimeResourceCounts` is deliberately not extended.** `audioContextCreations` belongs there by
type, but two `assert.deepEqual` whole-shape pins in `tools/tests/mainMenuRegression.mjs` compare the
entire object, and the count is gesture-dependent (0 at the menu, 1 after the New Game click) — a
value that differs by *how* a harness reaches the space phase. Publishing
`solarVoyagerAudio.contextCreationCount` instead proves the same "exactly one context, ever" fact
without making an unrelated gate's fixture depend on gesture ordering.

## 9. Landmines found in existing code

1. **The smoke gate cannot see the warning it exists to catch.** `applicationSmokeContract.mjs`
   filters `message.type() === 'error'`; Chrome's autoplay message arrives at `warning` level
   through CDP `Log.entryAdded`. Every existing harness has the same filter. The new
   `tools/tests/audioEngineRegression.mjs` collects warnings separately and asserts the autoplay
   string is absent — otherwise the acceptance criterion would be unverifiable, and would have
   *looked* verified.
2. **`?autostart=1` is a no-gesture path.** Six harnesses drive the app through it. Anything that
   creates a context at composition time warns in all six. This is why unlock is lazy.
3. **`installProductionSmokeRafFreeze` stops the frame loop after one frame.** Nothing in the audio
   path may assume continuous updates for correctness — the engine must be correct after a single
   `apply()`, which the "write only on change" design gives for free.
4. **The frame loop keeps running while paused** (T0112: `simDeltaSec = 0`, `deltaSec` real). The
   audio update takes the **wall** delta, not the sim delta: a paused game should still finish its
   crossfade and its Kubrick ramp, and a 4 s music transition driven by a zeroed delta would freeze
   mid-blend for the whole menu visit.
5. **`sessionSettingsRegression.mjs` asserts `#session-status` by exact string equality** at six
   points and pins the panel to ≤ 720 px tall / ≤ 1280 px right on desktop and ≤ 390 px wide on
   mobile. The new Audio section must not publish to the status line on mount and must not push the
   panel past those bounds — the mixer is five compact controls in the existing grid classes for
   that reason.
6. **`hudPresetProfile.mjs` hand-writes the profile document on purpose** ("importing the app's own
   constant would let a schema change pass its gate by moving both sides at once"). The v6 bump has
   to be transcribed there by hand, and that is correct, not duplication.

## 10. Verification list

- `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm test`, `npm run build`.
- `npm run test:session-settings` — mixer controls, persistence, layout bounds.
- `npm run test:main-menu` — the settings-key bump did not orphan the menu profile read.
- `npm run test:smoke` — no console errors, no `pageerror` from a swallowed promise.
- `npm run test:perf-gates` — heap growth unchanged (the audio path allocates nothing).
- `npm run test:hud-presets`, `npm run test:tutorial` — the two other gates that seed the profile key.
- `npm run test:audio` (new) — context absent before gesture, no autoplay warning, running after a
  gesture, suspended when hidden, sfx bus zeroed on the observatory camera and restored on chase.
