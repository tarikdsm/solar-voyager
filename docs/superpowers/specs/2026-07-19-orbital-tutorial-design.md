# T0099 Orbital Navigation Tutorial — Design

## Goal

Ship an opt-in, first-profile tutorial that is completed with the real Solar Voyager controls and simulation. It must remain resumable and accessible without becoming a second source of gameplay state, and it must disappear completely from the gameplay frame path after completion or skip.

## Product flow

A profile with no settings document starts with tutorial status `unoffered`. After **New game**, a non-modal tutorial card offers **Start tutorial** and **Not now**. Existing v1 profiles migrate to `skipped` so the new feature never blocks returning players; the settings panel still exposes **Resume tutorial** and **Reset tutorial**.

The active sequence is:

1. `focus-target`: select a navigation target and make it the real camera/map focus.
2. `camera`: orbit and zoom the real camera. Pointer controls remain supported; Shift+Arrow keys orbit and Shift+Page Up/Page Down zoom for keyboard-only play. The gameplay mapper ignores Shift-modified commands, so a rebound flight action can never execute beside a camera action.
3. `readouts`: wait for a valid real orbit and a completed real trajectory prediction, then acknowledge the highlighted readouts.
4. `attitude-thrust`: change attitude mode and start a real photon-drive burn.
5. `thrust-off`: return real throttle to zero, producing a completed burn.
6. `warp`: change the requested real time-warp tier after thrust is off.
7. `map-open`: open the live system map.
8. `map-return`: close the system map and return to the flight view.
9. `burn-log`: open the actual burn log with the completed tutorial burn visible.
10. `performance`: open the actual F3 performance panel on accelerated hardware, or acknowledge the actual hardware-acceleration warning when it exists.
11. `save`: complete a successful local save through the real session control.
12. `return-to-play`: explicitly finish; the overlay unmounts and gameplay retains all state created by the player.

Steps advance only from observable control events or real published state. There are no timers and no tutorial calls to `Commands`.

## Persistence and compatibility

`src/game/settings.ts` gains a profile settings v2 envelope:

```ts
interface GameSettingsV2 {
  readonly version: 2;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
  readonly tutorial: {
    readonly status: 'unoffered' | 'active' | 'skipped' | 'completed';
    readonly stepId: TutorialStepId;
  };
}
```

The independent profile key becomes `solar-voyager.settings.v2`. Repository load precedence is exact: an existing valid v2 wins; an existing invalid v2 reports corruption and returns defaults without consulting v1; only an absent v2 allows reading v1. A valid v1 profile migrates preferences, becomes `skipped` at `focus-target`, and is written immediately as v2. If that write fails, migration fails closed with defaults and a warning. A missing profile becomes `unoffered`. Documents remain strict and frozen, and the legacy key is never deleted.

Save v2 intentionally retains its existing `GameSettingsV1` preferences DTO. Saving projects v2 profile settings to `{version: 1, qualityLock, inputBindings}`. Loading/importing merges only those preferences into the current profile, preserving tutorial progress. This keeps all existing save documents valid and prevents an old or shared save from overwriting profile onboarding.

No protected interface changes: `SimSnapshot`, `Commands`, `bodies.json`, and physics formulas are untouched, so no ADR is required. `docs/architecture.md` will describe the two settings schemas and merge rule.

## Runtime architecture

`src/game/tutorialController.ts` is a DOM-free state machine. `GameSessionController` remains the sole owner of the full profile envelope and exposes a functional tutorial update that merges against its current settings, validates, persists, and only then publishes. The tutorial controller retains only tutorial progress and setup-time facts for the current step; it can never write a stale quality/binding snapshot. Each transition goes through that session port before publication. Tutorial-only settings changes stay out of the preference callback, so they never rebuild input bindings or release held flight axes. If a runtime persistence attempt fails, durable progress remains unchanged and the tutorial card announces the storage failure for retry.

Every resumable step is self-contained. Current snapshot/view state can re-establish target/focus, valid readouts, non-manual attitude with live thrust, throttle off, non-1× warp, map mode, and a non-empty burn log. Orbit/zoom, panel opening, and acknowledgements can simply be repeated after resume. No step depends exclusively on an in-memory fact produced by an earlier step, so reload, skip/resume, load, or New Game cannot strand progress.

The bootstrap wires observation at existing seams:

- `sessionCommands` only forwards gameplay commands; target, attitude, throttle, and warp completion is confirmed from the subsequent real snapshot/view publication, so repeated or no-op commands cannot advance the tutorial.
- camera and system-map callbacks report completed real interactions.
- the existing 10 Hz HUD publication reports primitive snapshot/readout and burn-count facts while the tutorial is active.
- burn-log, performance-panel, hardware-warning, and successful-save handlers emit explicit UI events.

The 10 Hz observer is a nullable stable function. Completion or skip sets it to `null`. It accepts only primitive values and allocates no observation object. The render loop allocates no tutorial objects, and completed/skipped profiles add zero gameplay frame-loop allocations.

`src/ui/TutorialOverlay.tsx` renders a pure, non-modal accessible card outside `SpaceHudSurfaces`, so map instructions remain visible. A setup-owned, event-only `App` subscription mirrors controller progress and also makes terminal Resume/Reset actions observable; the overlay itself creates no subscription. `App` conditionally mounts it only for `unoffered`/`active`, so skip/completion removes the DOM rather than hiding markup. It uses semantic headings/buttons, moves focus to a non-editable heading for flight-control steps, and reuses compact/reduced-motion-safe UI styles. Hidden/completed UI has no key listener or DOM node and cannot capture thrust or warp input.

`SessionSettingsPanel` receives a narrow optional tutorial port and displays status plus Resume/Reset controls in both menu and flight. Existing callers remain valid.

## Input and accessibility

Camera keyboard controls are additive: Shift+Arrow keys orbit and Shift+Page Up/Page Down zoom. Camera input ignores text-entry and editable targets (`input`, `select`, `textarea`, and `contenteditable`), while ordinary focused buttons retain the shortcuts so closing a panel does not strand camera control. The gameplay mapper ignores Shift-modified events, making the camera chord disjoint from every rebindable `KeyboardEvent.code`. Tutorial action buttons use normal Tab/Enter/Space navigation. Flight steps programmatically focus a `tabIndex=-1` heading, not a button, so rebindable thrust/warp keys reach the gameplay mapper.

Skip is always a visible button. Resume and Reset are always available in session settings. The card does not cover the full viewport and uses no animated transitions under `prefers-reduced-motion: reduce`.

## Diagnostics and verification

A fixed, read-only `canvas.solarVoyagerTutorial` diagnostic object exposes persisted status/step, transition count, active observer state, and observed real-control counters without replacing object identities in the frame loop. It exposes no controller or command methods.

A permanent Playwright regression starts from cleared storage and the real main menu, completes every step only through locators, keyboard, pointer, and wheel controls, reloads to prove completion persistence and absence of the overlay, then covers skip/resume/reset and the keyboard-only path. It never invokes controller/`Commands` from page evaluation. Compact assertions prove the card remains inside 360×480 and does not cover the instructed control; reduced-motion assertions inspect computed animation/transition values; focus assertions track the active heading/button; terminal assertions require no tutorial DOM, a false diagnostic observer flag, and at most one overlay throughout. It records console/page errors and rejects orphaned overlays. Unit tests cover strict migration, save/profile separation, controller transitions/failures, camera keyboard controls, and UI semantics.
