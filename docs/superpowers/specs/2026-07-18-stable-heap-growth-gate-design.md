# Stable Retained-Heap Gate Design

## Context

The production performance gate currently takes one forced-GC heap snapshot,
runs the stabilized application for 30 seconds, takes a second forced-GC
snapshot, and compares the difference with the fixed 196,608-byte ceiling. The
same T0085 frame-loop implementation produced adjacent GitHub-runner deltas of
173,012 B (pass), 202,242 B, 213,120 B, and 211,256 B, while the local exact-head
gate produced -137,288 B. Draw calls, triangles, bundle sizes, and the retained
allocation fixture remained stable. This distribution shows that one narrow
positive forced-GC delta is not a reliable classifier for persistent retained
growth.

The project contract remains unchanged: the frame loop allocates nothing, the
production ceiling remains 196,608 B, the observation window remains 30 seconds,
and CI must mechanically reject persistent retained growth.

## Decision

Keep the existing primary 30-second measurement. Classify its result as follows:

1. At or below 196,608 B: pass without extra work.
2. Above 245,760 B (125% of the ceiling): fail immediately.
3. In `(196,608 B, 245,760 B]`: run one independent 30-second confirmation
   window on the same already-stabilized production page, with a fresh forced-GC
   baseline and endpoint.

A narrow primary failure passes only when the confirmation delta is at or below
the original 196,608-byte ceiling. If the confirmation also exceeds that ceiling,
the gate fails and reports both measurements. The 25% boundary is not a larger
pass budget: no individual failing measurement is reclassified as passing. It
only bounds when CI is allowed to spend time collecting independent evidence.

The same-page confirmation avoids repeating asset loading, shader compilation,
and browser startup. Those are setup work rather than the stabilized frame loop
under test. A persistent per-frame leak continues through both independent
windows and therefore fails.

## Components and data flow

Add pure decision helpers to `performanceGateUtils.mjs`:

- `classifyHeapConfirmation(primary, ceiling)` returns `pass`, `confirm`, or
  `fail`. It fails closed for missing/invalid metrics or malformed ceilings.
- `validateConfirmedHeapGrowth(primary, confirmation, ceiling)` applies the
  original ceiling to both windows and returns findings only after the decision
  above has requested confirmation.

`performanceGate.mjs` keeps `measurePage` as the owner of page lifecycle and
setup. Its production measurement gains an optional confirmation inside the same
page lifecycle, after the primary endpoint and only when the pure classifier
returns `confirm`. The confirmation performs a new forced-GC baseline, waits the
same `golden.heap.durationMs`, and takes a new forced-GC endpoint.

The result JSON retains `production.heap` as the primary measurement for backward
compatibility and adds `production.confirmationHeap` with either the second
measurement or `null`. Logs state explicitly when confirmation begins and ends.
Bundle and workload validation remain byte-for-byte unchanged.

## Negative controls and errors

The allocation fixture remains a separate page retaining 256 KiB on every frame.
It is validated against the unchanged ceiling and must still produce a retained-
growth finding. It does not receive confirmation: its purpose is to prove that
the base detector rejects a known leak, and its delta is far above the 125%
boundary.

Unavailable or invalid Chromium heap metrics fail immediately. A malformed
ceiling fails immediately. If confirmation is requested but missing or invalid,
the gate fails closed. Browser, console, workload, and bundle errors retain their
current behavior.

## Verification

Unit tests cover:

- primary pass at and below the original ceiling;
- immediate failure above 125% of the ceiling;
- confirmation requested at both inclusive narrow-band boundaries;
- confirmed pass only when the second window is within the original ceiling;
- confirmed failure when the second window remains above it;
- invalid metrics and malformed ceilings fail closed.

The executable gate must then demonstrate:

- production succeeds with either a direct pass or a reported confirmed pass;
- the retained-allocation fixture is rejected;
- draw-call, triangle, bundle, and 196,608-byte golden values are unchanged;
- the full CI job passes without manual reruns.

`docs/performance-spec.md` will clarify that a narrowly exceeded single sample is
confirmed by one independent same-page 30-second window. `docs/check_plan.html`
will include T0095 exactly once and derive its final checked state only after the
task reaches `DONE`.
