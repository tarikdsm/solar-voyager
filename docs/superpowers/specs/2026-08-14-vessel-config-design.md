# VesselConfig — per-task design (T0104)

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §4.2, §12.2.
Plan: `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §2 (binding interface), §T0104.
Decision record: `docs/decisions/ADR-034-vessel-config.md` (same PR).

## Problem

The ship's rest mass is a hardcoded `const SHIP_MASS_KG = 10_000` in `src/main.ts`,
duplicated verbatim in `src/game/flightBenchmarkRoute.ts`, and threaded into
`SimulationCore` as a bare `shipMassKg: number`. Maximum proper acceleration is a
separate optional `maxProperAccelerationMS2` defaulting to 1 g. v2 needs a torchship
that cruises up to 10 g, a manual-flight regime capped lower, and a bounded attitude
slew rate — three more numbers that would otherwise become three more loose
constructor parameters and three more hardcoded constants in the bootstrap.

## Decision summary

One immutable value object, `VesselConfig`, owned by `src/sim/ship/vessel.ts`,
replaces `shipMassKg` + `maxProperAccelerationMS2` everywhere. It is per-session
state (serialized with the simulation), not a user preference (settings profile
untouched).

### Interface (fixed by plan §2 — not re-litigated here)

```ts
export interface VesselConfig {
  readonly restMassKg: number;        // > 0;        default 10_000
  readonly alphaMaxMS2: number;       // > 0;        default 98.0665  (10 g)
  readonly alphaManualMaxMS2: number; // (0, max];   default 19.6133  (2 g)
  readonly maxSlewRadPerSimS: number; // > 0;        default 0.261799 (15 deg/s)
}
export const DEFAULT_VESSEL: VesselConfig;
export function validateVesselConfig(source: VesselConfig): VesselConfig;
```

`alphaManualMaxMS2` and `maxSlewRadPerSimS` are **stored and validated but not
consumed** by the sim in this task. `maxSlewRadPerSimS` is consumed by T0107
(hold-mode slew); `alphaManualMaxMS2` is applied by T0108's manual flight regime.
The sim deliberately enforces no regime — it only knows the absolute drive limit
`alphaMaxMS2`. Storing them now means T0107/T0108/T0116 need no further envelope
migration.

## Where the vessel lives

### 1. `SimulationCore`

`SimulationCoreOptions.shipMassKg` and `.maxProperAccelerationMS2` are **deleted**
and replaced by a single required `vessel: VesselConfig`. Required, not optional:
the acceptance criterion is "SimulationCore constructed with VesselConfig", and an
implicit default would resurrect the invisible-constant problem this task exists to
remove. `SimulationCore` exposes `readonly vessel` so `game/` can hand the same
object to T0108's `FlightController` without re-deriving it.

The constructor caches `restMassKg` and `maximumProperAccelerationKmS2` as private
number fields exactly as it cached `shipMassKg` before. The frame loop therefore
reads two numbers, not a property chain through a frozen object, and allocates
nothing new (performance-spec §5).

### 2. `SimulationPersistentState` (the tri-coupling)

The vessel is a field of `SimulationPersistentState`, not a sibling of it.

`simulation.ts` captures a burn basis on throttle change and prices energy as
`E = ∫ m·α·c dt` and power as `P = m·α·c`. Those recorded joules are only
meaningful against the mass that produced them.

Note precisely what the loader does **not** do:
`simulationState.ts`'s `validateActiveBurnConsistency` compares the burn entry
against deltas of the *same document's* state vector, so no mass term enters any
comparison — it is an internal-consistency check and is mass-independent by
construction. `initialKineticEnergyJ` cannot substitute for one either: it is a
session-start baseline that legitimately diverges from the current state once the
ship maneuvers. So no downstream validator can detect a mass substitution.

Putting `vessel` inside the persistent state therefore does not *verify* the
pairing; it makes it structural, so the document that carries the ledger cannot
be separated from the mass that priced it. Legacy documents have no such
structure, so `migrateV1`/`migrateV2` assert the caller's vessel carries the
10 000 kg rest mass that priced every pre-v3 document, and fail closed
otherwise (`requireLegacyRestMass`).

Precedence on restore follows the existing pattern for every other persisted field
(`simTimeSec`, `effectiveWarp`, `warpClampReason`): **the persisted vessel wins**
over `options.vessel`. `options.vessel` is the fresh-session vessel; a restore
reconstructs the vessel that produced the ledger.

`copyAndValidateSimulationPersistentState` validates the vessel through the same
`validateVesselConfig` used at construction, so an untrusted save cannot inject a
zero or negative mass and divide the ledger by nonsense.

### 3. Save envelope v3

- `SaveEnvelopeV3 = { version: 3, phase: 'space', simulation, settings }` — the
  shape is unchanged; `simulation` gains its `vessel` sub-document.
- The embedded settings DTO **stays `GameSettingsV1`**. That is a compatibility
  contract (architecture.md "Save v2"), and the vessel is explicitly not a user
  setting, so nothing about settings changes.
- `parseV2` is retained as a migration source, not deleted: a stored v2 document is
  parsed with its own strict key list (which has no `vessel`) and then migrated by
  injecting the caller-supplied vessel. `migrateV1` chains v1 → v2 shape → v3.
- **`SAVE_STORAGE_KEY` stays `'solar-voyager.save.v2'`.** The key names the storage
  *slot*, not the document version; the document carries its own `version` field.
  Renaming the key to `.v3` would orphan every live player's save on the deployed
  GitHub Pages build and would reduce the v2→v3 migration to dead code that only
  ever runs on hand-imported JSON. Rationale and the rejected alternative are
  recorded in ADR-034.

## Consequences for existing physics tests

Changing the default α from 9.80665 to 98.0665 changes what an *unpinned*
`SimulationCore` accelerates at. Every existing test that relied on the old default
is pinned to an explicit 9.80665 vessel so its arithmetic is unchanged:

- `src/sim/simulation.test.ts`, `src/sim/energyLedger.test.ts`,
  `src/sim/simulation.performance.test.ts` — pinned via a local
  `ONE_G_VESSEL` built from `STANDARD_GRAVITY_M_S2`.
- `tests/golden/*` are **unaffected**: the golden harness never constructs
  `SimulationCore`. It drives `createRelativisticDerivative` directly with a
  hardcoded zero proper-acceleration evaluator, so no golden byte can move. This
  was verified before any code changed, and the goldens are re-run unmodified.

`DEFAULT_MAX_PROPER_ACCELERATION_M_S2` is renamed to `STANDARD_GRAVITY_M_S2` in
`src/sim/ship/thrust.ts`. After this task the value 9.80665 is no longer any
default — leaving the old name would make the constant lie about its role. It
remains the physical reference the 10 g and 2 g defaults are expressed against.

## Files

| File | Change |
|---|---|
| `src/sim/ship/vessel.ts` | NEW — interface, `DEFAULT_VESSEL`, `validateVesselConfig` |
| `src/sim/ship/vessel.test.ts` | NEW — defaults, bounds, immutability |
| `src/sim/ship/thrust.ts` | rename `DEFAULT_MAX_PROPER_ACCELERATION_M_S2` → `STANDARD_GRAVITY_M_S2` |
| `src/sim/simulation.ts` | `vessel` option; persisted vessel wins; cached scalars |
| `src/sim/simulationState.ts` | `vessel` in persistent state + validation |
| `src/game/saveLoad.ts` | envelope v3, `parseVessel`, v2→v3 and v1→v3 migration |
| `src/game/createNewGameSimulation.ts` | takes `VesselConfig` |
| `src/game/flightBenchmarkRoute.ts` | `SHIP_MASS_KG` deleted → `DEFAULT_VESSEL` |
| `src/main.ts` | `SHIP_MASS_KG` deleted → `DEFAULT_VESSEL` |
| `tools/bench/simulationCoreBench.mjs` | loads `DEFAULT_VESSEL` |
| `tests/fixtures/save-v2.json` | NEW — committed v2 migration fixture (coasting) |
| `tests/fixtures/save-v2-midburn.json` | NEW — committed v2 fixture with an active burn |
| `docs/physics-spec.md` §3.0.1 | default α_max now vessel-supplied |
| `docs/architecture.md` | save v3 line, `ship/vessel.ts` promoted from planned |
| `docs/decisions/ADR-034-vessel-config.md` | NEW |

## Out of scope (deliberate)

- `src/render/stateVectorModel.ts` keeps its own local `SHIP_MASS_KG = 10_000`. It
  is a widget axis-scale heuristic, not vessel physics; binding a display range to
  a configurable vessel mass is a presentation decision for the HUD tasks
  (T0112/T0124), not a silent side effect of this one. Value is unchanged either
  way today.
- No regime enforcement (`alphaManualMaxMS2`), no slew (`maxSlewRadPerSimS`), no UI
  for editing the vessel, no multiple vessel presets.

## Verification

1. `vessel.ts` unit tests: exact defaults, rejection of non-finite / non-positive /
   `alphaManualMaxMS2 > alphaMaxMS2`, frozen result.
2. `throttle × alphaMaxMS2` at the 10 g default reproduces `P = m·α·c` to 1e-12
   relative, and `|α| = throttle · alphaMaxMS2` — proves the new ceiling is
   reachable, not clamped to the old one.
3. Committed `tests/fixtures/save-v2.json` migrates to v3 with `vessel` =
   defaults and a byte-identical `simulation` state otherwise.
4. Round-trip: v3 serialize → parse → deep-equal, including the vessel.
5. Restore precedence: a core built with a 1 g vessel and a persistent state
   carrying a 10 g vessel restores at 10 g.
6. Energy-ledger Hohmann / plane-change / warp-invariance tests unchanged and green
   at their pinned α.
7. Goldens byte-identical.
8. `npm run bench:sim` before/after: `averageStepMs` and retained heap.
