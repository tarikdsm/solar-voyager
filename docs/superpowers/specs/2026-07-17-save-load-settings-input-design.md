# Save, Load, Settings, and Input Mapping Design

## Scope

T0058 delivers a complete browser-facing session persistence path for the 3D
space phase:

- save the current session to one versioned localStorage slot;
- load that slot atomically;
- export and import the same envelope as JSON;
- persist the quality lock and rebindable keyboard map;
- translate the configured keyboard actions into the existing `Commands`
  interface;
- reconstruct rails bodies from simulation time instead of serializing them.

The task does not implement the adaptive governor itself (T0091), multiple save
slots, cloud synchronization, launch-phase state, or a new scene state machine.

## Considered approaches

### 1. Validated session document plus fresh-core rehydration — selected

The game layer serializes an explicit, versioned DTO. Loading validates and
migrates the DTO, then constructs a fresh `SimulationCore` and swaps it into the
running application only after construction succeeds. This keeps corrupt input
from partially mutating the live session and lets the simulation rebuild rails,
integrator workspaces, and derived snapshot values from authoritative float64
state.

### 2. Serialize the complete `SimSnapshot` — rejected

This duplicates body positions and velocities even though rails bodies are a
function of time, couples persistence to a double-buffered frame view, and would
turn every snapshot extension into a save-format change.

### 3. Hydrate an existing core in place — rejected

In-place mutation would need to reset clocks, integrator checkpoints, burn-log
indices, cached rails evaluations, attitude workspaces, and both snapshot
buffers in a precise order. A failed import could leave a partially restored
session. Fresh-core construction is simpler and atomic.

## Boundaries and files

### Pure simulation persistence state

`src/sim/simulationState.ts` defines a setup-time `SimulationPersistentState`
and validation/copy helpers. It contains:

- simulation time;
- the full 12-component integrator state (relativistic state plus ledger
  accumulators);
- attitude quaternion;
- command state (throttle, attitude mode, rotation rates, requested warp, and
  target id);
- effective warp and clamp reason;
- the original kinetic-energy baseline used by the HUD;
- burn-log storage state, including an active burn's private continuation
  values.

`SimulationCore.exportPersistentState()` allocates and returns this setup-time
copy only when a save is requested. `SimulationCoreOptions.persistentState`
accepts a validated copy during construction. Neither method is called by the
frame loop. `SimSnapshot` and `Commands` remain unchanged, so no public-contract
ADR is required.

`src/sim/ship/ledger.ts` gains internal export/restore capability through the
existing controller. The public `BurnLogView` remains read-only. Restoring an
active burn preserves its basis vectors, starting ledger values, peak power,
and accumulated interval so continuing the burn produces the same history as an
uninterrupted run.

### Settings

`src/game/settings.ts` owns `GameSettingsV1`:

```ts
interface GameSettingsV1 {
  readonly version: 1;
  readonly qualityLock: 'auto' | 'low' | 'medium' | 'high';
  readonly inputBindings: InputBindings;
}
```

The module supplies immutable defaults, strict parsing, duplicate-key
rejection, and a repository backed by a small key/value storage port. The
browser adapter uses localStorage; tests use an in-memory implementation. A
manual quality lock is persisted now and exposed to the UI, ready for T0091 to
consume without inventing a second settings format.

### Input mapping

`src/game/inputMapping.ts` defines stable action ids and default codes for:

- throttle increase/decrease;
- warp increase/decrease;
- pitch, yaw, and roll in both directions;
- manual, prograde, and retrograde attitude modes.

`KeyboardCommandMapper` receives `Commands`, a snapshot provider, bindings, and
an event-target port. Keydown/keyup handlers only update preallocated boolean
state or issue edge-triggered commands. `update()` computes continuous rotation
rates and calls `Commands.rotate()` once per frame without allocating. Rebinding
is atomic, rejects reserved/duplicate codes, and releases any held action to
avoid stuck rotation. Text inputs and modified browser shortcuts are ignored.

The existing target selector continues to call `Commands.setTarget()` directly;
target cycling is not added because it is not needed to prove keyboard mapping
and the canonical UI already provides that command.

### Save envelope and migrations

`src/game/saveLoad.ts` owns the JSON-safe document:

```ts
interface SaveEnvelopeV2 {
  readonly version: 2;
  readonly phase: 'space';
  readonly simulation: JsonSimulationPersistentState;
  readonly settings: GameSettingsV1;
}
```

The current localStorage key is `solar-voyager.save.v2`. Serialization converts
typed arrays to finite number arrays. Parsing starts from `unknown`, rejects
unknown versions, invalid lengths, non-finite numbers, invalid enums, invalid
body targets, and malformed burn-log data, and never silently substitutes
defaults for corrupt session physics.

Version 1 is a committed fixture representing the earlier architecture shape:
`{version, simTimeSec, phase, shipState, ledger, burnLog, settings}`. Migration
builds the 12-component simulation state from the seven ship components and the
ledger totals, initializes the unrecorded proper-delta-v vector to zero, carries
completed burn entries, and supplies safe default command/attitude state. The
migrated result is then validated by the same v2 parser.

The envelope never contains rails body positions or velocities. A loaded core
evaluates them from `simTimeSec` and the catalog during construction.

### Application and UI integration

`src/main.ts` owns a mutable current simulation reference and one session
controller. Load/import performs this sequence:

1. parse, migrate, and validate without changing live state;
2. construct a replacement simulation using the existing catalog and ship
   configuration;
3. replace the current simulation reference;
4. republish the HUD and update input mapper commands/settings;
5. report success to the settings panel.

`src/ui/SessionSettingsPanel.tsx` provides Save, Load, Export JSON, and Import
JSON controls, a quality-lock selector, and key-binding buttons. Import uses a
hidden file input and passes text to the game controller. Export creates a Blob
and object URL only from a user click, then revokes the URL. Status messages use
an `aria-live` region. The panel is setup/event driven; it does not rerender from
the 60 fps snapshot stream.

The renderer does not consume the quality lock in T0058. Applying governor
knobs before T0091 would duplicate that task's ownership and conflict with
ADR-008.

## Error handling and atomicity

- Saving reports storage quota/security failures without stopping the game.
- Loading a missing slot returns a distinct `not-found` result.
- Malformed JSON, unsupported versions, invalid settings, and invalid physics
  state return concise user-facing errors while retaining the live session.
- Import never writes localStorage until parsing and replacement construction
  both succeed.
- Rebinding rejects reserved browser codes and any key already assigned to a
  different action.
- File cancellation is a no-op.

## Verification

Unit tests use red-green-refactor cycles for every new behavior:

1. simulation persistent-state round-trip, including active and completed burn
   logs, commands, attitude, warp, and kinetic-energy baseline;
2. save → JSON/localStorage → reload produces the same ship and derived body
   state, while the JSON contains no rails body arrays;
3. the committed v1 fixture migrates to a valid v2 envelope;
4. invalid schemas and non-finite values fail atomically;
5. settings defaults, strict parsing, persistence, and rebinding conflicts;
6. keyboard edge actions and continuous rotation invoke the real `Commands`
   facade correctly without changing that interface;
7. Preact panel interaction tests cover save/load/export/import, quality
   selection, rebinding, and accessible status output;
8. typecheck, lint, full Vitest suite, production build, task schema, and asset
   budgets remain green;
9. a real-browser regression verifies the settings panel, one save/load cycle,
   a key rebind, and zero console errors.

## Performance and compatibility

Persistence work occurs only on explicit user actions. Typed-array conversion,
JSON parsing, Blob creation, and new-core construction never run inside the
frame loop. The mapper preallocates its held-action state and performs no array
creation, closures, spreads, or iterator helpers in `update()`. No runtime or
development dependency is added.
