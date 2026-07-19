# T0096 Main Menu and New-Game Flow Design

## Context

The v1 architecture requires `MainMenu -> SpacePhase`, but `main.ts` currently
constructs the simulation, input mapper, worker, world, HUD, and animation loop
immediately. The browser therefore enters gameplay without an explicit player
decision. Save/load already reconstructs simulations atomically and the
canonical 400 km LEO factory already exists; this task composes those contracts
instead of changing physics.

## Decisions

### Pure phase boundary

Add `game/sceneManager.ts` with the v1 phases `main-menu | space`. A small
controller owns the one-way transition and delegates New Game and Continue to a
narrow session port. Failed actions leave the phase unchanged. Once space is
active, repeated activation attempts are rejected without calling a factory or
loader again. Successful imported/loaded sessions can be accepted through the
same boundary.

### Atomic session operations

`GameSessionController` receives a `createNewSimulation` factory, exposes
`startNewGame()` and `hasValidLocalSave()`, and keeps the same replacement seam
used by save/import. New Game constructs a candidate before replacing the live
reference. Continue validates the complete saved envelope before the menu is
enabled and calls the existing atomic `loadLocal()` operation.

### Menu UI

`MainMenu` is a semantic Preact navigation/dialog surface with:

- prominent New Game and conditionally enabled Continue actions;
- canonical 400 km LEO and controls context;
- session import and quality/input settings through the existing settings panel;
- keyboard-first focus, visible focus states, live action errors, compact layout,
  and reduced-motion behavior.

The gameplay HUD is not mounted while the menu is active. A successful New
Game, Continue, Load, or Import switches the App to SpacePhase exactly once.

### Runtime lifecycle

Renderer/world preparation remains one-time setup, but input handling,
trajectory invalidation, simulation stepping, HUD publication, and the rAF loop
start only after the phase controller enters SpacePhase. The activation function
is idempotent, so repeated UI events cannot create a second mapper, worker,
renderer, world, listener set, or animation loop. New Game resets the existing
session to a freshly constructed canonical simulation before activation.

The normal URL always opens MainMenu. Repository production harnesses may opt
into deterministic direct activation with `?autostart=1`; this is an explicit
test/benchmark route, not an environment or host heuristic. T0096 adds a browser
regression for the normal URL, so the menu contract cannot be bypassed silently.

### Dashboard continuity

The development dashboard gains the six new formal tasks T0096-T0101 exactly
once. Roadmap actions converted into those tasks are removed from the non-task
list. Existing objects and unrelated actions remain intact.

## Verification

- TDD for scene transitions and session new-game/valid-save behavior.
- Component tests for disabled Continue, error retention, imported activation,
  keyboard semantics, and no duplicate activation.
- Real-browser regression: fresh storage menu, canonical New Game, valid and
  invalid Continue, reload, keyboard focus, compact viewport, reduced motion,
  and single canvas/runtime evidence.
- Existing save/load, smoke, camera, trajectory, performance, unit, build,
  schema, dashboard, and budget gates.

No `SimSnapshot`, `Commands`, physics formula, catalog schema, or runtime
dependency changes; no ADR is required.
