# Save, Load, Settings, and Input Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver atomic localStorage/JSON session persistence, version migration, quality settings, and rebindable keyboard commands for the playable space phase.

**Architecture:** A validated v2 game-layer envelope stores a setup-time copy of `SimulationCore` persistent state and settings, then loading constructs a fresh core before replacing the live reference. Simulation export/restore remains pure and off-frame; settings and input use narrow ports so browser I/O is testable without weakening `core ← sim ← game ← render/ui`.

**Tech Stack:** TypeScript 6 strict mode, Vitest 4, Preact 10, Vite 8, browser localStorage/File/Blob APIs, Playwright regression harness.

## Global Constraints

- Do not change `SimSnapshot` or `Commands`; either change would require an ADR.
- Do not serialize rails body positions or velocities; derive them from `simTimeSec`.
- Keep `src/sim/` and `src/core/` pure TypeScript with no DOM, three.js, globals, or side effects.
- No new runtime or development dependency.
- Persistence allocations may occur only on explicit save/load/import/export actions.
- `KeyboardCommandMapper.update()` must allocate nothing in the frame loop.
- JSON parsing begins from `unknown` and rejects non-finite physics values, invalid enum values, invalid array lengths, and unsupported versions.
- Loading and importing are atomic: the live simulation and settings change only after validation and replacement construction succeed.

---

### Task 1: Pure simulation export and restore

**Files:**
- Create: `src/sim/simulationState.ts`
- Create: `src/sim/simulationState.test.ts`
- Modify: `src/sim/ship/ledger.ts`
- Modify: `src/sim/ship/ledger.test.ts`
- Modify: `src/sim/simulation.ts`
- Modify: `src/sim/simulation.test.ts`

**Interfaces:**
- Consumes: existing `SimulationCore`, `CommandState`, `BurnLogController`, and 12-component `SIMULATION_STATE_DIMENSION`.
- Produces: `SimulationPersistentState`, `BurnLogPersistentState`, `SimulationCore.exportPersistentState()`, and `SimulationCoreOptions.persistentState`.

- [ ] **Step 1: Write failing ledger restore tests**

Add tests that complete one burn, keep a second burn active, export the private
state, create a second log from that state, and assert all public entries plus
continued active-burn decomposition match.

```ts
test('restores completed and active burns without losing continuation state', () => {
  const original = createBurnLog(4);
  recordCompletedAndActiveBurn(original.recorder);
  const persisted = original.persistence.exportState();
  const restored = createBurnLog(4, persisted);

  expect(copyBurnLog(restored.view)).toEqual(copyBurnLog(original.view));
  continueActiveBurn(original.recorder);
  continueActiveBurn(restored.recorder);
  expect(copyBurnLog(restored.view)).toEqual(copyBurnLog(original.view));
});
```

- [ ] **Step 2: Verify the ledger test fails for the missing persistence capability**

Run: `npm test -- src/sim/ship/ledger.test.ts`

Expected: FAIL because `persistence` and the restore argument do not exist.

- [ ] **Step 3: Implement fixed-capacity ledger export/restore**

Add JSON-independent pure types and a private capability:

```ts
export interface BurnLogPersistentState {
  readonly capacity: number;
  readonly entries: readonly BurnLogEntry[];
  readonly active: BurnLogActivePersistentState | null;
}

export interface BurnLogPersistence {
  exportState(): BurnLogPersistentState;
}

export interface BurnLogController {
  readonly view: BurnLogView;
  readonly recorder: BurnLogRecorder;
  readonly persistence: BurnLogPersistence;
}

export function createBurnLog(
  capacity = DEFAULT_BURN_LOG_CAPACITY,
  persistentState: BurnLogPersistentState | null = null,
): BurnLogController;
```

Restore through validated copies into the preallocated ring and active-burn
scratch fields. Never expose mutation through `BurnLogView`.

- [ ] **Step 4: Verify ledger tests pass**

Run: `npm test -- src/sim/ship/ledger.test.ts`

Expected: PASS with no warnings.

- [ ] **Step 5: Write failing simulation round-trip tests**

Create `simulationState.test.ts` and extend `simulation.test.ts` to exercise a
non-default target, warp, attitude, rotation, throttle history, completed and
active burns. Export, reconstruct, and compare snapshot scalars/typed arrays,
burn log, and the next propagated frame.

```ts
const saved = original.exportPersistentState();
const restored = new SimulationCore({
  catalog,
  initialShipState,
  shipMassKg,
  persistentState: saved,
});

expect(copySnapshot(restored.snapshot)).toEqual(copySnapshot(original.snapshot));
expect(copyBurnLog(restored.burnLog)).toEqual(copyBurnLog(original.burnLog));
expect(copySnapshot(restored.step(0.25))).toEqual(copySnapshot(original.step(0.25)));
```

- [ ] **Step 6: Verify simulation tests fail for the missing API**

Run: `npm test -- src/sim/simulationState.test.ts src/sim/simulation.test.ts`

Expected: FAIL because `SimulationPersistentState`, `persistentState`, and
`exportPersistentState()` do not exist.

- [ ] **Step 7: Implement validated persistent-state copies and core restore**

Define the setup DTO:

```ts
export interface SimulationPersistentState {
  readonly simTimeSec: number;
  readonly state: Float64Array;
  readonly attitudeQuaternion: Float64Array;
  readonly throttle: number;
  readonly attitudeMode: AttitudeMode;
  readonly rotationRatesRadS: Float64Array;
  readonly requestedWarp: WarpFactor;
  readonly effectiveWarp: WarpFactor;
  readonly warpClampReason: WarpClampReason;
  readonly targetBodyId: string | null;
  readonly initialKineticEnergyJ: number;
  readonly burnLog: BurnLogPersistentState;
}
```

Add `copyAndValidateSimulationPersistentState(source, bodyIds)` and use it in
the constructor before workspaces/snapshots are initialized. Export copies the
current private ship state, command state, attitude, baseline, warp state, and
ledger. Restore both ship buffers from the full 12-component state and derive
rails/snapshot data normally.

- [ ] **Step 8: Run focused and full simulation tests**

Run: `npm test -- src/sim/simulationState.test.ts src/sim/simulation.test.ts src/sim/ship/ledger.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the pure simulation slice**

```bash
git add src/sim/simulationState.ts src/sim/simulationState.test.ts src/sim/simulation.ts src/sim/simulation.test.ts src/sim/ship/ledger.ts src/sim/ship/ledger.test.ts
git commit -m "feat(sim): [T0058] export and restore simulation state"
```

### Task 2: Versioned settings and rebindable defaults

**Files:**
- Create: `src/game/settings.ts`
- Create: `src/game/settings.test.ts`

**Interfaces:**
- Consumes: no browser globals; a `KeyValueStorage` port.
- Produces: `QualityLock`, `InputAction`, `InputBindings`, `GameSettingsV1`, `DEFAULT_GAME_SETTINGS`, `parseGameSettings`, and `SettingsRepository`.

- [ ] **Step 1: Write failing tests for defaults, strict parsing, persistence, and conflicts**

```ts
test('loads immutable defaults when no settings exist', () => {
  const repository = new SettingsRepository(new MemoryStorage());
  expect(repository.load()).toEqual(DEFAULT_GAME_SETTINGS);
});

test('rejects duplicate bindings', () => {
  expect(() => parseGameSettings(settingsWithDuplicate('KeyW'))).toThrow(/already bound/u);
});
```

Cover unknown quality locks, missing actions, extra actions, empty/reserved
codes, corrupt stored JSON fallback with an error result, save failures, and
copy-on-write rebinding.

- [ ] **Step 2: Verify settings tests fail**

Run: `npm test -- src/game/settings.test.ts`

Expected: FAIL because `settings.ts` does not exist.

- [ ] **Step 3: Implement the settings model and repository**

Use one exhaustive action tuple and derive the union:

```ts
export const INPUT_ACTIONS = Object.freeze([
  'throttleIncrease', 'throttleDecrease', 'warpIncrease', 'warpDecrease',
  'pitchUp', 'pitchDown', 'yawLeft', 'yawRight', 'rollLeft', 'rollRight',
  'attitudeManual', 'attitudePrograde', 'attitudeRetrograde',
] as const);

export type InputAction = (typeof INPUT_ACTIONS)[number];
export type QualityLock = 'auto' | 'low' | 'medium' | 'high';
```

Repository methods return discriminated results rather than throwing for
storage availability/quota errors. Parsing always returns fresh frozen data.

- [ ] **Step 4: Verify settings tests pass**

Run: `npm test -- src/game/settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit settings**

```bash
git add src/game/settings.ts src/game/settings.test.ts
git commit -m "feat(game): [T0058] add versioned quality and input settings"
```

### Task 3: Keyboard-to-Commands mapper

**Files:**
- Create: `src/game/inputMapping.ts`
- Create: `src/game/inputMapping.test.ts`

**Interfaces:**
- Consumes: existing `Commands`, snapshot provider, `GameSettingsV1`, and a narrow keyboard event target.
- Produces: `KeyboardCommandMapper` with `updateCommands`, `updateBindings`, `update`, and `dispose`.

- [ ] **Step 1: Write failing edge-action and held-rotation tests**

Use a fake event target and the real `createCommandController()` facade.

```ts
target.keyDown('Equal');
expect(controller.state.requestedWarp).toBe(5);

target.keyDown('KeyW');
mapper.update();
expect([...controller.state.rotationRatesRadS]).toEqual([ROTATION_RATE_RAD_S, 0, 0]);
target.keyUp('KeyW');
mapper.update();
expect([...controller.state.rotationRatesRadS]).toEqual([0, 0, 0]);
```

Also cover throttle clamping, warp ladder boundaries, repeat suppression,
editable targets, modified shortcuts, rebind release, command replacement after
load, and `dispose()`.

- [ ] **Step 2: Verify input tests fail**

Run: `npm test -- src/game/inputMapping.test.ts`

Expected: FAIL because the mapper does not exist.

- [ ] **Step 3: Implement allocation-free mapper update**

Precompute `code → action index` outside `update()`, store held states in a
fixed `Uint8Array`, and use scalar branches in the hot method:

```ts
update(): void {
  const pitch = this.heldPitchUp - this.heldPitchDown;
  const yaw = this.heldYawRight - this.heldYawLeft;
  const roll = this.heldRollRight - this.heldRollLeft;
  this.commands.rotate(
    pitch * ROTATION_RATE_RAD_S,
    yaw * ROTATION_RATE_RAD_S,
    roll * ROTATION_RATE_RAD_S,
  );
}
```

Event handlers may use setup-time maps but must not allocate per animation
frame. `updateCommands()` is used after loading a replacement simulation.

- [ ] **Step 4: Verify focused tests and lint pass**

Run: `npm test -- src/game/inputMapping.test.ts && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit input mapping**

```bash
git add src/game/inputMapping.ts src/game/inputMapping.test.ts
git commit -m "feat(game): [T0058] map rebindable keyboard input to commands"
```

### Task 4: Save envelope, JSON conversion, and v1 migration

**Files:**
- Create: `src/game/saveLoad.ts`
- Create: `src/game/saveLoad.test.ts`
- Create: `tests/fixtures/save-v1.json`

**Interfaces:**
- Consumes: `SimulationPersistentState`, settings parser, and `KeyValueStorage`.
- Produces: `SaveEnvelopeV2`, `createSaveEnvelope`, `serializeSaveEnvelope`, `parseSaveEnvelope`, `SaveRepository`, and v1 migration.

- [ ] **Step 1: Commit a concrete v1 fixture and write failing migration tests**

The fixture contains seven ship values, ledger totals, one completed burn, and
v1 settings. Test exact migrated v2 values, not just `version === 2`.

```ts
const migrated = parseSaveEnvelope(readFixture('save-v1.json'), BODY_IDS);
expect(migrated.version).toBe(2);
expect([...migrated.simulation.state]).toEqual([
  ...fixture.shipState,
  fixture.ledger.energySpentJ,
  fixture.ledger.properDeltaVMS,
  0, 0, 0,
]);
```

- [ ] **Step 2: Write failing v2 round-trip and invalid-input tests**

Assert `JSON.stringify` output contains neither `bodyPositionsKm` nor
`bodyVelocitiesKmS`. Cover malformed JSON, unknown version, NaN encoded as null,
wrong state lengths, invalid target ids, invalid burn log, invalid settings,
missing slot, and storage exceptions.

- [ ] **Step 3: Verify save tests fail**

Run: `npm test -- src/game/saveLoad.test.ts`

Expected: FAIL because save/load functions do not exist.

- [ ] **Step 4: Implement explicit JSON DTO conversion and migration dispatch**

```ts
export const CURRENT_SAVE_VERSION = 2;
export const SAVE_STORAGE_KEY = 'solar-voyager.save.v2';

export function parseSaveEnvelope(text: string, bodyIds: readonly string[]): SaveEnvelopeV2;
export function serializeSaveEnvelope(envelope: SaveEnvelopeV2): string;
```

Do not cast parsed JSON. Use record/array/finite-number guards and named path
errors. Dispatch v1 to `migrateV1ToV2`, then pass the result through the same v2
validator.

- [ ] **Step 5: Verify save tests pass**

Run: `npm test -- src/game/saveLoad.test.ts src/game/settings.test.ts src/sim/simulationState.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit envelope and migration**

```bash
git add src/game/saveLoad.ts src/game/saveLoad.test.ts tests/fixtures/save-v1.json
git commit -m "feat(game): [T0058] add versioned save envelope and migration"
```

### Task 5: Atomic game-session controller

**Files:**
- Create: `src/game/sessionController.ts`
- Create: `src/game/sessionController.test.ts`
- Modify: `src/game/createNewGameSimulation.ts`

**Interfaces:**
- Consumes: current `SimulationCore`, `SaveRepository`, `SettingsRepository`, and a replacement-core factory.
- Produces: `GameSessionController`, `createGameSimulationFromPersistentState`, and event results for UI.

- [ ] **Step 1: Write failing save/reload identity and atomic failure tests**

```ts
const before = copySnapshot(controller.simulation.snapshot);
expect(controller.saveLocal().ok).toBe(true);
controller.simulation.step(60);
expect(controller.loadLocal().ok).toBe(true);
expect(copySnapshot(controller.simulation.snapshot)).toEqual(before);
```

Assert body arrays match because the replacement core derives them from time.
Inject a factory that throws after parsing and prove the original simulation
and settings object remain identical. Cover JSON import without an implicit
localStorage write and export of the current session.

- [ ] **Step 2: Verify session tests fail**

Run: `npm test -- src/game/sessionController.test.ts`

Expected: FAIL because the controller and restore factory do not exist.

- [ ] **Step 3: Implement catalog-sharing restore factory and controller**

Factor canonical catalog/LEO setup in `createNewGameSimulation.ts` so restore
uses the same catalog and ship mass:

```ts
export function createGameSimulationFromPersistentState(
  shipMassKg: number,
  persistentState: SimulationPersistentState,
): SimulationCore;
```

The controller exposes a `simulation` getter, `settings` getter, `saveLocal`,
`loadLocal`, `exportJson`, `importJson`, `updateQualityLock`, and `rebind`.
Construct candidates in locals; assign controller fields only after every step
succeeds.

- [ ] **Step 4: Verify acceptance round-trip passes**

Run: `npm test -- src/game/sessionController.test.ts src/game/saveLoad.test.ts src/sim/simulation.test.ts`

Expected: PASS, including identical derived body state after reload.

- [ ] **Step 5: Commit session controller**

```bash
git add src/game/sessionController.ts src/game/sessionController.test.ts src/game/createNewGameSimulation.ts
git commit -m "feat(game): [T0058] add atomic session controller"
```

### Task 6: Session/settings panel and application wiring

**Files:**
- Create: `src/ui/SessionSettingsPanel.tsx`
- Create: `src/ui/sessionSettingsPanel.test.ts`
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/app.css`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: a `SessionSettingsPort` with session/settings operations and a stable `GameSessionController`.
- Produces: accessible panel controls, status signals, local save/load, JSON import/export, quality selection, and key capture.

- [ ] **Step 1: Write failing view-model tests for panel actions**

Keep browser-only mechanics behind injected ports and test the controller logic
without jsdom:

```ts
const model = createSessionSettingsModel(fakePort);
expect(model.save().message).toBe('Session saved');
expect(model.selectQuality('low').settings.qualityLock).toBe('low');
expect(model.captureBinding('pitchUp', 'KeyI').settings.inputBindings.pitchUp).toBe('KeyI');
```

Cover rejected duplicate/reserved rebinds, load/import failures, file cancel,
and object URL revocation.

- [ ] **Step 2: Verify UI-model tests fail**

Run: `npm test -- src/ui/sessionSettingsPanel.test.ts`

Expected: FAIL because the panel model does not exist.

- [ ] **Step 3: Implement panel and styles**

Add a collapsible `details` panel with stable ids:

```tsx
<SessionSettingsPanel session={sessionSettingsPort} />
```

Controls: `#session-save`, `#session-load`, `#session-export`,
`#session-import-input`, `#quality-lock`, one binding button per action, and
`#session-status[aria-live="polite"]`. Use English UI copy per coding standards.
The desktop panel must not overlap the existing HUD; mobile order follows the
scrolling overlay.

- [ ] **Step 4: Wire main without stale references**

Replace the immutable simulation local with the session controller. Each frame
reads `session.simulation`; input mapper receives updated commands after load;
HUD republishes immediately after replacement. Call `inputMapper.update()` once
per frame before `simulation.step()`.

- [ ] **Step 5: Verify unit, type, lint, and build gates**

Run:

```bash
npm test -- src/ui/sessionSettingsPanel.test.ts src/game/sessionController.test.ts src/game/inputMapping.test.ts
npm run typecheck
npm run lint
npm run build
```

Expected: every command exits 0.

- [ ] **Step 6: Commit UI integration**

```bash
git add src/ui/SessionSettingsPanel.tsx src/ui/sessionSettingsPanel.test.ts src/ui/App.tsx src/ui/app.css src/main.ts
git commit -m "feat(ui): [T0058] add session and input settings panel"
```

### Task 7: Real-browser regression, documentation, and delivery gates

**Files:**
- Create: `tests/render/sessionSettings.html`
- Create: `tests/render/sessionSettingsPage.tsx`
- Create: `tools/tests/sessionSettingsRegression.mjs`
- Modify: `package.json`
- Modify: `docs/architecture.md`
- Modify: `tasks/T0058-save-load-settings-input.yaml`

**Interfaces:**
- Consumes: production panel, controller, and mapper.
- Produces: `npm run test:session-settings`, current architecture details, and REVIEW task metadata.

- [ ] **Step 1: Write the browser regression and observe it fail before wiring the harness**

The Playwright script must:

```js
await page.getByRole('button', { name: 'Save session', exact: true }).click();
await page.locator('#quality-lock').selectOption('low');
await page.getByRole('button', { name: 'Pitch up: KeyW', exact: true }).click();
await page.keyboard.press('KeyI');
await page.getByRole('button', { name: 'Load session', exact: true }).click();
assert.deepEqual(await page.evaluate(() => globalThis.__sessionHarness.snapshot()), expected);
assert.deepEqual(pageErrors, []);
assert.deepEqual(consoleErrors, []);
```

Also verify 1280×720 and 390×844 have no horizontal overflow, clipped panel,
or HUD collision.

Run: `node tools/tests/sessionSettingsRegression.mjs`

Expected: FAIL until the HTML/harness and package script are complete.

- [ ] **Step 2: Add harness, package script, and architecture details**

Add `"test:session-settings": "node tools/tests/sessionSettingsRegression.mjs"`.
Update `docs/architecture.md` state/persistence section with v2 envelope fields,
storage keys, migration path, atomic replacement, quality lock ownership, and
the rule that rails bodies are derived from time.

- [ ] **Step 3: Run browser regression and all required gates**

Run:

```bash
npm run test:session-settings
npm run lint
npm run typecheck
npm test
npm run build
npm run check:tasks
npm run check:budgets
npm run format:check
git diff --check main...HEAD
```

Expected: all commands exit 0; Vitest count is at least the 448-test baseline;
browser console/page error arrays are empty.

- [ ] **Step 4: Mark task REVIEW and commit delivery metadata**

Set `status: REVIEW` and record acceptance evidence in `handoff_notes`.

```bash
git add package.json docs/architecture.md tests/render/sessionSettings.html tests/render/sessionSettingsPage.tsx tools/tests/sessionSettingsRegression.mjs tasks/T0058-save-load-settings-input.yaml
git commit -m "test(game): [T0058] verify session persistence flow"
```

- [ ] **Step 5: Rebase, rerun affected gates, push, and open PR**

```bash
git rebase main
npm run lint && npm run typecheck && npm test && npm run build
git push -u origin task/T0058-save-load-settings-input
```

Open PR `[T0058] Save/load, settings, input mapping` and map each acceptance
criterion to exact tests and browser evidence. Request an independent reviewer;
do not merge until findings are resolved and CI is green on the exact head.
