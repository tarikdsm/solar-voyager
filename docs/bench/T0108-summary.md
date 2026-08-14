# T0108 flight controller benchmark

## Environment and method

- Before SHA: `dc89304d1eb6c53bd6d42219d8f089ae5df39f3b` (this branch's base, post-T0107)
- After SHA: `53a96029c7ca07eab779167a18d633e123ba814d`
- Renderer: ANGLE / Intel(R) UHD Graphics (0x00009A60) / Direct3D 11
- Canvas: 640 x 360, device scale factor 1
- Harness: `npm run bench`, production Vite build, one deterministic 900-frame
  route (LEO → Moon flyby → Jupiter approach, seed 1511506142), 30 s steady-heap
  settle plus 30 s measurement
- Raw reports: `T0108-before.json` and `T0108-after.json`
- Allocation/cost isolation: `npm run bench:sim` (extended by this task, below)

This PR replaces the per-frame `InputCommandBridge.apply()` with
`FlightInputRouter.apply()` + `FlightController.update()`, so it touches the
frame loop and bench evidence is required by the v2 plan's Global Constraints
even though no `render/` module changed.

## Before/after result

| Metric             |       Before |        After |     Delta |
| ------------------ | -----------: | -----------: | --------: |
| Frame median       |     6.100 ms |     6.100 ms |     0.000 |
| Frame p75          |     6.200 ms |     6.200 ms |     0.000 |
| Frame p99          |    24.301 ms |    24.200 ms |    -0.101 |
| Frame-work median  |     2.400 ms |     2.350 ms |    -0.050 |
| Frame-work p75     |     3.900 ms |     3.500 ms |    -0.400 |
| Frame-work p99     |     8.802 ms |     8.001 ms |    -0.801 |
| Steady heap growth |     86,004 B |     92,508 B |  +6,504 B |
| Path heap delta    | 26,647,749 B | 26,673,349 B | +25,600 B |
| Maximum draw calls |           26 |           26 |         0 |
| Maximum triangles  |       49,530 |       49,530 |         0 |
| Entry gzip         |    127,970 B |    129,715 B |  +1,745 B |
| Total gzip         |    557,750 B |    559,495 B |  +1,745 B |

Both reports completed with empty stability findings.

Frame cost is unchanged. Every timing column moved _down_, which is
run-to-run variance on this integrated GPU rather than an improvement — the
stable medians are identical and the controller's measured cost (below) is three
orders of magnitude smaller than the p99 differences. The steady-heap and
path-heap deltas are likewise inside the noise this harness shows around zero;
both are far below the 196,608 B window limit.

## Isolated controller cost and allocation

`bench:sim` grew from one arm to three so the frame-loop addition is measured
rather than inferred:

| Arm                   | What it times                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `averageStepMs`       | `SimulationCore.step` alone in a prograde hold — the historical figure, unchanged in shape so it stays comparable to earlier summaries                                 |
| `averageControllerMs` | `FlightInputRouter.apply` + `FlightController.update` alone, against a fixed snapshot, with an alternating look delta so the unsaturated pursuit path runs every frame |
| `averageFlightStepMs` | the loop `main.ts` actually runs: router → controller → `core.step`, with a live mouse sweep; this is the arm the retained-heap assertion covers                       |

```
before (base, single-arm harness)
{ "averageStepMs": 0.08266332, "retainedHeapGrowthBytes": -202384 }

after
{ "averageStepMs":        0.08334207,
  "averageControllerMs":  0.00055256,
  "averageFlightStepMs":  0.08002215,
  "retainedHeapGrowthBytes": -216872 }
```

**The controller costs 0.55 µs per frame** — 0.003% of a 16.7 ms budget. Two
independent runs gave 0.00054 and 0.00055 ms.

The controller arm is deliberately _not_ computed by differencing two
`core.step` arms. The controller steers, so two arms that steer differently fly
different trajectories, and DP54's adaptive step count follows the trajectory:
an early attempt at that differencing reported a spurious 0.020 ms because the
two arms were flying different orbits at different throttles, twenty times the
real figure.

`averageFlightStepMs` is _lower_ than `averageStepMs` for the same reason and is
not a regression: arm A holds prograde, which re-solves the hold direction at
every DP54 stage, while the flight-loop arm is in manual attitude, which is a
single body-rate quaternion. The two are different sim work, not different
controller work.

`retainedHeapGrowthBytes` is negative on every run, i.e. the 10,000-frame
sampled window with a live mouse sweep allocates nothing. All controller state
is allocated in the constructor: six `Float64Array`s (one of length 4, five of
length 3) and scalars.

## Gates

`npm run test:perf-gates` against the after build: all findings empty.

- Production performance fixture: 10 draw calls, 77,071 triangles — both exactly
  on the committed goldens, **no re-baseline requested**.
- Retained heap growth over the 30 s browser window: **-206,051 B** against the
  196,608 B limit.
- Bundle: 129,715 B entry gzip and 559,495 B total gzip against the fixed
  285,000 B and 570,000 B ceilings — 155,285 B and 10,505 B of headroom.
- Allocation and draw-call negative controls were both rejected as expected.

## Bundle

The 1,745-gzip-byte entry growth is the whole cost of the task: the flight
controller, the input router, seven new binding actions with their labels, and
the append-safe binding parser, minus the deleted `inputCommandBridge.ts`.

Total gzip headroom is now 10,505 B against the v1 570,000 B ceiling. The v2
plan §13 raises that ceiling to ~1 MB via a dedicated reviewed commit; this task
does not request the raise, but the next JS-adding task will need it.

## Test totals

Vitest: 139 files passed, 1 skipped; 932 tests passed, 3 skipped (base commit:
138 files, 1 skipped; 906 passed, 3 skipped). Browser gates run for this change:
session settings, burn log, tutorial, camera controls, smoke, perf gates — all
green.

Absolute timing here is from this machine's Intel UHD integrated GPU rather than
the discrete reference target used for earlier summaries; CI remains the portable
final arbiter.
