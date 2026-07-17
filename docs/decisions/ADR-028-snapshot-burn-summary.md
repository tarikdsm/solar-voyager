# ADR-028: Snapshot-backed active or latest burn summary

**Status:** accepted (2026-07-17)

## Context

The v1 energy HUD must show both per-session and per-burn energy figures.
`SimulationCore` already owns a fixed-capacity burn log, but UI and render layers
are consumers of `SimSnapshot`; exposing `SimulationCore.burnLog` to the UI would
create a second state boundary and couple presentation to the mutable core owner.

Adding fields to `SimSnapshot` changes an ADR-gated public interface. The frame
loop also forbids allocating a burn-summary object on each publication.

## Decision

1. `SimSnapshot` adds four primitive fields: `burnSummaryAvailable`,
   `burnSummaryActive`, `burnEnergySpentJ`, and `burnProperDeltaVMS`.
2. During snapshot publication, `SimulationCore` selects the active burn when
   one exists; otherwise it selects the newest completed entry. With no burn,
   availability and activity are false and both numeric fields are zero.
3. Snapshot buffers retain these primitives in their existing double-buffered
   storage. No burn-log entry or summary object is copied or allocated.
4. The HUD labels the selected record as `Active burn` or `Last burn`, formats
   its energy through the shared Wh formatter, and keeps cumulative session
   values in the existing headline.
5. Full burn history remains available only through `SimulationCore.burnLog` for
   future persistence and dedicated log UI; this summary does not replace it.

## Consequences

- UI remains a pure snapshot consumer and can present the required per-burn and
  per-session figures without reaching into the simulation owner.
- Consumers that construct snapshot buffers receive a deterministic neutral
  no-burn state.
- The public snapshot grows by two booleans and two float64 scalar values, with
  no frame-loop allocation or typed-array schema change.
- The summary intentionally favors the active burn over completed history so
  values update live while thrusting.
