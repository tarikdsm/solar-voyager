# ADR-034: VesselConfig — configurable ship, save envelope v3

**Status:** accepted (2026-08-14)

## Context

Until now the ship was two loose numbers. Rest mass was a literal
`const SHIP_MASS_KG = 10_000` in `src/main.ts`, copy-pasted into
`src/game/flightBenchmarkRoute.ts`, and passed to `SimulationCore` as a bare
`shipMassKg: number`. The drive limit was a separate optional
`maxProperAccelerationMS2` that defaulted to standard gravity
(`DEFAULT_MAX_PROPER_ACCELERATION_M_S2 = 9.80665`, ADR-025).

v2.0's second pillar (ADR-032) is continuous proper-acceleration torchship
flight "up to ~10 g cruise". Delivering it needs three more per-ship numbers
beyond rest mass: the absolute drive limit, the lower ceiling the manual flight
regime will apply (T0108), and the bounded hold-mode slew rate that replaces
today's snap-to-target attitude (T0107). Adding those as three more constructor
parameters and three more bootstrap constants would multiply the problem this
ADR exists to remove, and would force a second save-format migration once
T0107/T0108 land.

The values are load-bearing beyond this task: the v2 plan's §2 interface
contract is what T0107 (slew), T0108 (`FlightController` ports), T0114
(intercept solver `alphaMS2`) and T0116 (cruise director) are written against.

Three constraints shaped the design:

1. **The ledger/persistence coupling.** `sim/simulation.ts` prices energy as
   `E = ∫ m·α·c dt` and power as `P = m·α·c`, and captures an orbital burn basis
   on each throttle change. Recorded joules are only meaningful against the mass
   that produced them, and **a document does not record that mass anywhere a
   validator can recover it.**

   It is important to be exact about what the existing loader does and does not
   guarantee, because the natural assumption is wrong.
   `validateActiveBurnConsistency` in `sim/simulationState.ts` compares the
   active burn entry's `energySpentJ` / `properDeltaVMS` / per-axis components
   against deltas taken from the *same document's* state vector
   (`state[STATE_ENERGY_J] − active.startEnergyJ`, and so on). Both sides of
   every comparison come from the same document, and **no mass term appears in
   any of them**. The check is therefore an internal-consistency check — it
   catches a hand-edited or truncated burn log — and it is *mass-independent by
   construction*. It cannot detect that a document priced by one ship is being
   restored under another. Nor can `initialKineticEnergyJ` be used for that: it
   is the kinetic-energy baseline at *session start*, while `state` holds the
   current celerity, and the two legitimately diverge the moment the ship
   maneuvers — that divergence is exactly what the published
   `kineticEnergyChangeJ` reports.

   The consequence is that the mass mismatch has exactly one place it can be
   caught: the boundary where a mass-less legacy document acquires a vessel. See
   decision 5.
2. **The goldens are inviolable** (`docs/coding-standards.md`, ADR-017).
   Changing the default α must not move a single golden byte.
3. **v1.0 is deployed** to GitHub Pages with real saves in real browsers, and
   every merged PR must leave that build playable (ADR-032 / v2 plan §Global
   Constraints).

## Decision

1. **One immutable value object.** `src/sim/ship/vessel.ts` owns

   ```ts
   export interface VesselConfig {
     readonly restMassKg: number;        // default 10_000
     readonly alphaMaxMS2: number;       // default 98.0665  (10 g)
     readonly alphaManualMaxMS2: number; // default 19.6133  (2 g)
     readonly maxSlewRadPerSimS: number; // default 0.261799 (15 deg/s)
   }
   export const DEFAULT_VESSEL: VesselConfig;          // frozen
   export function validateVesselConfig(source: VesselConfig): VesselConfig;
   ```

   Field names and defaults are exactly the v2 plan §2 contract. The
   accelerations are written as decimal literals, not as multiples of standard
   gravity, because `10 * 9.80665` is not bit-identical to `98.0665` in float64
   and the literals are the contract. `validateVesselConfig` requires every
   field finite and positive and `alphaManualMaxMS2 <= alphaMaxMS2`, and returns
   a frozen copy — untrusted saves cannot inject a zero mass and divide the
   ledger by nonsense.

2. **`SimulationCore` takes a required `vessel`.** `SimulationCoreOptions`
   loses `shipMassKg` and `maxProperAccelerationMS2` and gains
   `vessel: VesselConfig` — required, because an implicit default would
   reintroduce exactly the invisible constant this ADR removes. The core caches
   `restMassKg` and the km/s² drive limit into private number fields at
   construction, so the frame loop reads two scalars, allocates nothing, and
   executes the same arithmetic as before (`docs/performance-spec.md` §5).
   `SimulationCore.vessel` is public so the game layer can hand the same frozen
   object to T0108's `FlightController` without re-deriving it.

3. **The vessel is per-session state, not a user setting.** It lives in
   `SimulationPersistentState` — a field of the same document that carries the
   ledger it priced — and is validated by
   `copyAndValidateSimulationPersistentState` through the same
   `validateVesselConfig`. Co-locating them does not *verify* the pairing
   (nothing can, per constraint 1); it makes the pairing structural, so a v3
   document can never be separated from the mass that priced it in the first
   place. The settings profile
   (`solar-voyager.settings.v2`) is untouched, and the embedded
   `GameSettingsV1` preferences DTO stays exactly as it is: that is a
   deliberate compatibility contract, and a vessel is not a preference.

4. **The persisted vessel wins on restore.** When `persistentState` is present,
   its vessel supersedes `options.vessel`, matching how every other persisted
   field (`simTimeSec`, `effectiveWarp`, `warpClampReason`) already behaves.
   `options.vessel` is the fresh-session vessel. For a v3 document this is what
   keeps constraint 1 honest: the recorded energy and proper Δv are restored
   under the mass stored alongside them, so a caller cannot re-price them by
   passing a different vessel. It is a *structural* guarantee, not a checked
   one — see decision 5 for the case where no such structure exists.

5. **Save envelope v3, same storage slot.** `CURRENT_SAVE_VERSION` becomes `3`
   and the `simulation` sub-document gains `vessel`.
   `SAVE_STORAGE_KEY` deliberately **stays** `'solar-voyager.save.v2'`: the key
   names the storage *slot*, the document names its own version. Migration is
   explicit and total — `v1 -> v3` and `v2 -> v3`, each with committed fixtures
   (`tests/fixtures/save-v1.json`, `tests/fixtures/save-v2.json`, and
   `tests/fixtures/save-v2-midburn.json` for the active-burn case). v2 and v3 are
   validated against separate strict key lists, so a v2 document carrying a
   `vessel` and a v3 document missing one are both rejected.

   A migrated document adopts the vessel the caller is running, but **only if
   that vessel's `restMassKg` is `LEGACY_SAVE_REST_MASS_KG` (10 000)** — the rest
   mass of the only ship that ever wrote a pre-v3 document. Otherwise migration
   fails closed with an explicit error. This assertion is the *entire* protection
   against re-pricing a legacy ledger: per constraint 1 nothing downstream can
   detect the substitution, so a mid-burn v2 document migrated under, say, a 42 t
   vessel would otherwise parse silently, keeping its 10 t-priced burn log while
   the continuation ran at 42 t. Latent while every caller passes
   `DEFAULT_VESSEL`, but live the moment a non-default vessel exists — which is
   where T0108/T0116 are heading. `alphaMaxMS2`, `alphaManualMaxMS2` and
   `maxSlewRadPerSimS` may differ freely: they govern future thrust only and
   appear nowhere in the ledger.

6. **`DEFAULT_MAX_PROPER_ACCELERATION_M_S2` is renamed to
   `STANDARD_GRAVITY_M_S2`.** After this ADR 9.80665 m/s² is not any default;
   keeping the old name would leave a constant that lies about its role. It
   stays in `sim/ship/thrust.ts` as the physical reference the 10 g and 2 g
   defaults are expressed against.

7. **Pre-existing 1 g regressions are pinned, not re-baselined.** Every test
   whose analytic expectation assumed the old default constructs an explicit 1 g
   vessel (`src/sim/simulation.test.ts`, `src/sim/energyLedger.test.ts`). The
   golden trajectories are structurally unaffected — `tests/golden/` never
   constructs `SimulationCore`; it drives `createRelativisticDerivative`
   directly with a hardcoded zero proper-acceleration evaluator — and the three
   golden JSON files are byte-identical after this change.

8. **Stored now, consumed later.** The simulation validates and persists
   `alphaManualMaxMS2` and `maxSlewRadPerSimS` but does not act on them. The sim
   enforces no flight *regime*; it knows only the absolute limit. T0107 consumes
   the slew rate, T0108 applies the manual ceiling. Persisting them now means
   neither task needs another envelope migration.

## Consequences

- `SHIP_MASS_KG` is gone from `src/main.ts` and
  `src/game/flightBenchmarkRoute.ts`; both use `DEFAULT_VESSEL`. The literal
  survives only in `src/render/stateVectorModel.ts`, where it is a widget
  axis-scale heuristic rather than vessel physics — binding a display range to a
  configurable mass is a HUD decision for T0112/T0124, deliberately not a side
  effect of this ADR.
- The default ship now accelerates at 10 g, ten times the v1 ceiling. Anything
  that depended on the old default without saying so would change behavior;
  everything in the repo that did has been pinned explicitly (point 7).
- Players' existing saves keep loading: the slot is unchanged and v2 documents
  migrate in place on read, then rewrite as v3.
- v3 documents are not readable by the deployed v1.0 build. Downgrade was never
  supported (v1 -> v2 had the same property) and remains out of scope.
- Later vessel fields (RCS authority, drive efficiency, multiple hulls) are now
  additive: one field, one `requireExactKeys` entry, one migration.
- A player who somehow holds a legacy save and a non-10 t vessel gets a hard,
  explanatory load failure rather than a quietly mis-priced session. No such
  combination is reachable today; the guard exists so it stays unreachable.
- **Guidance for later tasks:** do not treat any loader check as protection
  against a mass mismatch. `validateActiveBurnConsistency` is mass-independent
  and `initialKineticEnergyJ` is a session-start baseline that legitimately
  disagrees with the current state. If a future feature can pair a ledger with a
  mass it was not priced by, that pairing must be rejected where it is created,
  the way `requireLegacyRestMass` does at the migration boundary.

## Alternatives considered

- **Bump `SAVE_STORAGE_KEY` to `solar-voyager.save.v3`.** Rejected: it silently
  orphans every save on the live GitHub Pages build, and it reduces the v2 -> v3
  migration to dead code that could only ever run on hand-imported JSON —
  writing a migration whose production path is unreachable is worse than not
  writing one.
- **Keep `shipMassKg` and add `alphaMaxMS2`/`alphaManualMaxMS2`/
  `maxSlewRadPerSimS` as further optional options.** Rejected: four independent
  optional parameters with silent defaults is the failure mode this task was
  created to end, and each new field would need its own envelope migration.
- **Store the vessel as a sibling of `simulation` in the envelope, or in the
  settings profile.** Rejected: it breaks constraint 1. Since nothing downstream
  can *detect* a mass substitution, the only available defence is to make the
  pairing structural — the mass must arrive inside the same document as the
  ledger it priced, so the two cannot drift apart. A sibling field can be edited
  independently; a settings profile is worse still, being shared across sessions,
  so a preference change would retroactively re-price every saved ledger.
- **Let `options.vessel` win over the persisted vessel on restore.** Rejected
  for the same reason: it would re-price a completed burn history against a
  different mass, silently — `validateActiveBurnConsistency` would *not* catch
  it, because it compares document-internal deltas that contain no mass term.
- **Regenerate the goldens at 10 g.** Never considered viable — the goldens are
  inviolable (ADR-017) and, as it happens, structurally independent of α.
