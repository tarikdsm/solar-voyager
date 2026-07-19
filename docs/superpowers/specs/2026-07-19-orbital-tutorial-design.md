# T0099 Orbital Navigation Tutorial — Design

## Goal

Ship an opt-in, first-profile tutorial that is completed with the real Solar Voyager controls and simulation. It must remain resumable and accessible without becoming a second source of gameplay state, and it must disappear completely from the gameplay frame path after completion or skip.

## Product flow

A profile with no settings document starts with tutorial status `unoffered`. After **New game**, a non-modal tutorial card offers **Start tutorial** and **Not now**. Existing v1 profiles migrate to `skipped` so the new feature never blocks returning players; the settings panel still exposes **Resume tutorial** and **Reset tutorial**.

The active sequence is:

1. `focus-target`: select a navigation target and make it the real camera/map focus.
2. `camera`: orbit and zoom the real camera. Pointer controls remain supported; Arrow keys orbit and Page Up/Page Down zoom for keyboard-only play.
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

The independent profile key becomes `solar-voyager.settings.v2`. Repository load order is v2, then the legacy v1 key, then defaults. A valid v1 profile migrates preferences and becomes `skipped` at `focus-target`; a missing profile becomes `unoffered`. Documents remain strict and frozen.

Save v2 intentionally retains its existing `GameSettingsV1` preferences DTO. Saving projects v2 profile settings to `{version: 1, qualityLock, inputBindings}`. Loading/importing merges only those preferences into the current profile, preserving tutorial progress. This keeps all existing save documents valid and prevents an old or shared save from overwriting profile onboarding.

No protected interface changes: `SimSnapshot`, `Commands`, `bodies.json`, and physics formulas are untouched, so no ADR is required. `docs/architecture.md` will describe the two settings schemas and merge rule.

## Runtime architecture

`src/game/tutorialController.ts` is a DOM-free state machine. It owns current persisted progress plus setup-time booleans for facts such as camera orbit/zoom, readout readiness, burn completion, map open/return, and panel actions. A persistence port validates and commits every transition before the controller publishes it. It exposes a small subscription API for UI rendering.

The bootstrap wires observation at existing seams:

- `sessionCommands` observes target, attitude, throttle, and warp only after forwarding the real command.
- camera and system-map callbacks report completed real interactions.
- the existing 10 Hz HUD publication reports primitive snapshot/readout and burn-count facts while the tutorial is active.
- burn-log, performance-panel, hardware-warning, and successful-save handlers emit explicit UI events.

The 10 Hz observer is a nullable stable function. Completion or skip sets it to `null`. The render loop allocates no tutorial objects, and completed/skipped profiles add zero gameplay frame-loop allocations.

`src/ui/TutorialOverlay.tsx` renders a non-modal accessible card outside `SpaceHudSurfaces`, so map instructions remain visible. It subscribes only while mounted, uses semantic headings/buttons, moves focus to a non-editable heading for flight-control steps, and has compact/reduced-motion CSS. Hidden/completed UI has no key listener and cannot capture thrust or warp input.

`SessionSettingsPanel` receives a narrow optional tutorial port and displays status plus Resume/Reset controls in both menu and flight. Existing callers remain valid.

## Input and accessibility

Camera keyboard controls are additive: Arrow keys orbit and Page Up/Page Down zoom. Camera input adopts the same editable-target guard as other global controls, so typing or focused buttons do not steer the camera. Tutorial action buttons use normal Tab/Enter/Space navigation. Flight steps programmatically focus a `tabIndex=-1` heading, not a button, so rebindable thrust/warp keys reach the gameplay mapper.

Skip is always a visible button. Resume and Reset are always available in session settings. The card does not cover the full viewport and uses no animated transitions under `prefers-reduced-motion: reduce`.

## Diagnostics and verification

A fixed `canvas.solarVoyagerTutorial` diagnostic object exposes identity, persisted status/step, transition count, active observer state, and observed real-control counters without replacing object identities in the frame loop.

A permanent Playwright regression starts from cleared storage and the real main menu, completes every step with UI/keyboard/pointer controls, reloads to prove completion persistence and absence of the overlay, then covers skip/resume/reset, keyboard-only, compact viewport, and reduced motion. It records console/page errors and rejects orphaned overlays. Unit tests cover strict migration, save/profile separation, controller transitions/failures, camera keyboard controls, and UI semantics.

