# T0098 Burn Log and Mission Clock Design

## Scope and invariants

T0098 surfaces the existing `SimulationCore.burnLog` and the existing UTC-only
display mapping. It does not change `SimSnapshot`, `Commands`, the save schema,
the ledger formulae, or `physics-spec.md`, so no ADR is required. The simulation
remains the sole owner of burn history and proper time.

The UI must show completed and active burns with system UTC start/end, ship
proper-time start/end, energy, proper delta-v, peak power, dominant body, and
signed prograde/normal/radial components. The completed list is newest-first,
bounded by the canonical 256-entry capacity, keyboard navigable, and collapsed
by default. The existing dual clock becomes explicitly labelled as mission UTC
derived from TDB display time; no astronomical TDB/UTC formula is introduced.

## Data flow

`BurnLogSignalStore` lives in `src/ui/` and accepts the public `BurnLogView`.
`main.ts` calls it only when the existing 10 Hz HUD publisher commits. The store
preallocates 256 completed row-model signal graphs plus one active row at setup.
It detects structural history changes by count and exact comparison of every
field on the newest entry, including `dominantBodyId`; it uses no hash or
collision-prone aggregate. A structural change copies chronological ring values
newest-first into stable slots with indexed loops. It never creates or replaces
arrays, row objects, computed signals, or Preact list identities during rAF, and
never walks the 256 entries on unchanged animation frames.

All 256 bounded DOM row identities are mounted at application setup and hidden
by stable per-slot visibility signals until used. Later ring overwrites cannot
silently mutate visible history. The active row copies numeric values into
preallocated signals at the HUD cadence. Shared setup-created computed
formatters provide UTC, proper duration, energy, power, body names, unsigned
proper delta-v, and signed axis components.

On New Game, Continue, or import, the session replacement callback synchronously
calls `rebind(replacement.burnLog)`, clears every stale visible/active slot, and
rebuilds the replacement history immediately, independent of the HUD store's
100 ms throttle. During normal rAF work, `publish()` is called only when
`hudStore.publish()` returns `true`. The existing v2 persistence remains
authoritative and receives focused round-trip coverage for empty, active,
completed, and wrapped logs.

A burn that starts and completes between two HUD commits is detected from the
changed newest entry and appears directly as completed. The same rule covers the
257th burn when count remains 256 and the oldest entry advances. A throttle tap
with no intervening `SimulationCore.step()` remains the ledger's canonical empty
burn and is not displayed.

## UI and accessibility

`BurnLogPanel` is mounted once in the space HUD. A button controls a labelled
panel with `aria-expanded` and a polite count/status summary. Empty, active, and
completed states are distinct. Each completed entry contains a real `button`,
which the existing keyboard input mapper already excludes from flight controls.
ArrowDown moves toward older records, ArrowUp toward newer records, Home to the
newest, and End to the oldest; limits do not wrap. Escape collapses and restores
focus to the toggle. Tests rebind those keys to flight actions and prove no
`Commands` call escapes the panel. The precreated list is capped at 256 rows.

Desktop and compact layouts use the existing HUD visual language. Compact mode
limits panel height and keeps the list scrollable; reduced-motion disables panel
transitions. Opening, closing, and navigation are event-driven and add no rAF
work.

## Browser evidence and diagnostics

A fixed `solarVoyagerBurnLog` diagnostic object is attached to the canvas and
mutated directly from the raw `SimulationCore.burnLog`, independently of UI
signals and formatters. It reports completed count, active state, every raw
latest-entry field, publish count, and structural rebuild count; its identity
never changes.
The permanent browser regression performs a real keyboard burn, verifies the
active row within one HUD update, completes it, compares displayed values with
the canonical diagnostic, exercises row keyboard navigation, saves/reloads, and
checks desktop/compact layouts with no console or page errors. It uses
`page.keyboard`, proves active by at most `publishCount + 1`, compares every raw
field and formatted text, reloads through real Save/Continue controls, and
proves many frames plus multiple unchanged HUD commits do not rebuild history.

System timestamps use `tdbSecondsToUtcTimeMs` and are labelled as the J2026
TDB-to-mission-UTC display mapping, not astronomical UTC. Proper start/end are
accumulated MET durations; an active end is the current synchronized endpoint.
Relativistic tests explicitly show coordinate and proper endpoints diverging.

## Rejected alternatives

- Adding the full burn log to `SimSnapshot`: protected-interface churn and a
  per-frame copy of up to 256 entries.
- Polling and mapping the entire ring in Preact: violates the bounded frame-loop
  contract and creates avoidable arrays/strings.
- A second UI-owned ledger: risks divergence from save/load and physics.
- Virtualizing fewer than 256 entries: unnecessary at this capacity and makes
  keyboard/accessibility semantics more complex than a bounded expanded list.
