# T0117 — Click-to-target in world and map — Design

Task: `T0117` (plan `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §T0117, spec
`docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §7).
Branch: `task/T0117-click-to-target`.

## 0. What was already there, and what this task actually owes

T0112 **over-delivered**. It landed `src/game/hud/bodyPicking.ts` (`pickBodyIndexAtPixel`), the
angular-disc math with the 8 px floor and the nearest-along-ray tie-break, unit tests, the pointer
gesture in `bootstrap/composition.ts`, and the browser assertion in `tools/tests/hudPresetsRegression.mjs`
that clicking a centred Earth reaches `Commands.setTarget`. Read the code before assuming otherwise:
this task is **not** a from-scratch picking task.

What T0112 did **not** deliver, and this task owes:

| Acceptance | Before T0117 | Owed |
|---|---|---|
| Space-view angular-disc picking, 8 px floor, nearest wins, ship excluded | landed | regression coverage only |
| **System map click** selects focus and target | absent — the map had a `<select>` and nothing else | new |
| **"Set as cruise target" affordance in both views** | absent | new |
| Target panel select stays as fallback, **all three paths converge on `Commands.setTarget`** | three independent call sites happened to call the same facade | new: one write point, enforced |
| Zero allocation per click frame | one `DOMRect` per click | new: removed |
| Picking math unit-tested from a known pose | landed | extended to the map pose and the tie-break |

So the shape of this task is: **one new pick surface, one new affordance, and a convergence that is
provable rather than coincidental.**

## 1. The one write point

Before: `SystemMapPanelModel.selectBody`, `App.TargetPanel`'s `<select>`, `SharedCameraControls`
(`focusBody`/`cycleFocus`) and the canvas pick handler each called `commands.setTarget(...)`
themselves. They all *happened* to hit the same `sessionCommands` facade, but nothing said so, and
a fifth caller would have been free to skip the validation the others do by hand.

`src/game/targetSelection.ts` — `TargetSelectionController` — is now the only caller of
`Commands.setTarget` in the application:

```ts
export type TargetSelectionSource = 'world' | 'map' | 'panel' | 'camera' | 'api';

export interface TargetSelectionPort {
  selectTarget(bodyId: string | null, source: TargetSelectionSource): boolean;
  readonly selectedBodyId: string | null;
}

export class TargetSelectionController implements TargetSelectionPort {
  constructor(ports: { commands: Commands; bodyIds: readonly string[] });
  selectTarget(bodyId: string | null, source: TargetSelectionSource): boolean;
  get selectedBodyId(): string | null;
  get selectionSource(): TargetSelectionSource | null;
  get selectionCount(): number;
  subscribe(listener: (bodyId: string | null, source: TargetSelectionSource) => void): () => void;
}
```

- It validates the id against the catalog and returns `false` for an unknown one instead of letting
  `SimulationCore.setTarget` throw. `SharedCameraControls` used to hand-roll that check because the
  camera focus ring contains `ship`, which is not a catalog body; it now just gets `false`.
- It is `game/`: pure TypeScript, no DOM, no three.js, unit-testable.
- **It re-writes an unchanged id.** Re-selecting the same body is not a no-op: the composition
  facade's `setTarget` also re-aims the observatory camera and invalidates the trajectory
  prediction, and "click Earth again to recentre" is behaviour the map's `<select>` has always had.
  The listeners still fire, so T0150 can observe a *click* rather than a *change*.

`tests/architecture/targetWritePoint.test.ts` scans `src/` for `.setTarget(` and asserts exactly two
files match: `game/targetSelection.ts` (the only caller) and `bootstrap/composition.ts` (the
`Commands` facade forwarding into the live `SimulationCore`). It is the same source-scan pattern
`tests/render/float32Boundary.test.ts` uses for the `Math.fround` boundary, and it is what turns
"all three paths converge" from a claim into a gate.

### API for T0119 and T0150 (do not reach into internals)

- **T0119 — "engage cruise" on the map's selected body.** Read `TargetSelectionController.selectedBodyId`
  (it equals the map focus, because a map click sets both) and put the button beside
  `#set-cruise-target` inside `.cruise-target-control`. `CruiseTargetControl` already takes an
  optional `children` slot for exactly this. Do **not** read `SystemMapController.focusId` — it also
  moves for camera-only focus changes that were rejected as targets.
- **T0150 — intro step 3, "click the Moon".** `subscribe((bodyId, source) => …)` and check
  `bodyId === 'moon' && source === 'world'`. The callback fires on every selection including a
  repeat of the same body, which is what a tutorial step needs. `TutorialController` already takes
  UI-event callbacks of this shape; wire it in `bootstrap/composition.ts` next to
  `handleTutorialSaveSucceeded`.

## 2. Map picking: the same math, a different radius rule

Rejected: a second picking module, and a three.js `Raycaster` on the icon `Points` (the brief
forbids it, and it would need the f32 camera-relative buffer — a second precision boundary).

`bodyPicking.ts` gains `pickMapBodyIndexAtPixel`. It shares the projection loop with
`pickBodyIndexAtPixel`; the two differ in exactly one input:

- **Space view** — candidate radius is `max(8 px, apparentRadiusPx(meanRadiusKm, depth))`. The disc
  you see is the disc you click.
- **System map** — candidate radius is a flat `8 px` for every body. The map does **not** draw
  bodies at their angular size; it draws one `gl_PointSize` icon batch at a constant 8 CSS px
  (14 when selected), so an angular disc would make the Sun clickable across a third of the screen
  where no icon is drawn, and Bennu clickable nowhere. A flat floor equal to `MIN_PICK_RADIUS_PX`
  covers the 4 px icon radius with slop and keeps one constant for both views.

Nearest-along-ray still wins, so clicking the tangle of Galilean moons picks the near one, and the
ship is still excluded structurally: `SimSnapshot.bodyPositionsKm` carries catalog bodies only and
the length assertion fails loudly if that ever changes.

### The map camera pose

`OrbitCameraController` publishes `cameraPositionKm` and `lookDirection` but no up hint and no field
of view, because the map's three.js camera supplies both implicitly:

- `SystemMapScene.update()` calls `camera.lookAt(lookDirection)` with the camera at the render
  origin and never touches `camera.up`, so the hint is three.js's default `(0, 1, 0)`.
- `CameraRelativeSpaceScene` constructs `new PerspectiveCamera(75, …)`.

`pickMapBodyIndexAtPixel` therefore fills a module-scratch pose with that hint and
`SYSTEM_MAP_CAMERA_FOV_DEG = 75`. `game/` may not import `render/`, so the constant is duplicated
and `src/render/systemMapScene.test.ts` asserts it equals the exported `SPACE_CAMERA_FOV_DEG` —
the same agreement-test pattern as `markerCameraAgreement.test.ts`.

**Landmine found:** the map genuinely reaches the degenerate pose the space view rarely does. Yaw
90°, pitch 0 gives `lookDirection = (0, −1, 0)`, antiparallel to the `(0, 1, 0)` hint, so
`cross(forward, hint)` vanishes. `writeCameraBasisInto` already replicates three.js's nudge for this
(T0112), which is the whole reason picking and rendering stay in agreement there instead of the
picker returning −1 while icons keep drawing. A unit test pins it.

## 3. "Set as cruise target" in both views

There is exactly one cruise/navigation target — the `Commands.setTarget` body. The affordance is
therefore not a second piece of state; it is a labelled, keyboard-reachable control that names the
current selection and commits it, mounted twice:

- **Space view** — inside `CruiseStatus` (`#cruise-status`, the `cruiseStatus` HUD surface, visible
  in Clean). This is deliberate: T0119 replaces this section with the real cruise strip and inherits
  the mount point and the CSS row that T0112 reserved.
- **System map** — inside `#system-map-panel`, under the focus `<select>`.

Both render the same `CruiseTargetControl` component, both call
`TargetSelectionController.selectTarget`, and the button label names the body
(`Set Mars as cruise target`) so the control is self-describing to a screen reader.

Rejected: making the click a *selection* that the button then *commits*. It would have introduced a
second target-ish state, and it would have broken the behaviour T0112 shipped and gated — a click
already targets, in both views, and the button is the discoverable and accessible equivalent.

## 4. Zero allocation per click

The picking math was already allocation-free (module-level `Float64Array` scratch, no closures, no
literals). The click *handler* was not: `canvas.getBoundingClientRect()` allocates a `DOMRect` per
gesture. Both handlers now read `event.offsetX` / `event.offsetY` (CSS pixels relative to the
target's padding box — the canvas is the listener target and has no padding or border) together with
`canvas.clientWidth` / `clientHeight`. No allocation, and one fewer forced layout per click.

Proof is browser-side, in the repo's established style: `tools/tests/clickToTargetRegression.mjs`
drives 120 real picks across both views and asserts `JSHeapUsedSize` growth stays inside the same
256 KiB envelope `systemMapRegression.mjs` uses for its toggle loop.

## 5. Files

New: `src/game/targetSelection.ts` (+ test), `src/ui/CruiseTargetControl.tsx`,
`tests/architecture/targetWritePoint.test.ts`, `tools/tests/clickToTargetRegression.mjs`.

Modified: `src/game/hud/bodyPicking.ts` (+ tests), `src/bootstrap/composition.ts`,
`src/ui/App.tsx`, `src/ui/FlightStrip.tsx`, `src/ui/SystemMapPanel.tsx`,
`src/ui/sharedCameraControls.ts`, `src/ui/app.css`, `src/render/spaceScene.ts`
(export the field-of-view constant), `src/render/systemMapScene.ts` (consume it),
`package.json`, `.github/workflows/ci.yml`, `docs/architecture.md`.

No `sim/` change, no `Commands` change, no `SimSnapshot` change, so no ADR (plan §8).
