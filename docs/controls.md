# Controls

Solar Voyager supports keyboard-only flight and pointer-assisted camera control. Controls are active
only after a session enters space.

Flight input is suppressed in exactly two situations: while you are typing in an input, select, text
area, or editable region, and for a key that the focused control itself handles (for example the
arrow keys that move through burn-log rows). A focused button never disables the rest of the ship,
and `Shift` is an ordinary modifier — you can steer and move the camera at the same time.

## Rebindable flight controls

Open **Session & settings**, select a binding, and press the replacement key. Duplicate, whitespace,
empty, or reserved keys are rejected. `Escape`, `Tab`, `F1`, `F3`, `F5`, `F11`, `F12`, and the Meta
keys remain reserved for UI, browser, or operating-system behavior.

| Action              | Default   |
| ------------------- | --------- |
| Throttle up / down  | `R` / `F` |
| Time warp up / down | `=` / `-` |
| Pitch up / down     | `W` / `S` |
| Yaw left / right    | `A` / `D` |
| Roll left / right   | `Z` / `C` |
| Manual attitude     | `1`       |
| Prograde hold       | `2`       |
| Retrograde hold     | `3`       |
| Normal hold         | `4`       |
| Anti-normal hold    | `5`       |
| Radial-out hold     | `6`       |
| Radial-in hold      | `7`       |
| Target hold         | `8`       |
| Kill rotation       | `X`       |
| Stability assist    | `T`       |

Flight axes are continuous while held. The throttle is a continuous lever in the 0–100% range: a tap
nudges it by ten percent, and holding the key sweeps the full range in 1.5 seconds. Time warp follows
the canonical ladder and may be clamped automatically for safety or integration accuracy; above the
thrust-warp ceiling the drive is cut and resumes at the same lever position once warp drops back.

## Flying the ship

Mouse-look steering is the primary control: with pointer lock engaged, mouse motion sets the
direction you want the nose to point and the ship turns toward it, accelerating into the turn and
settling out of it rather than snapping. The keyboard and gamepad rotation axes are direct rate
controls instead — the ship turns while you hold them and stops the moment you let go.

Rotation authority is the same in wall-clock terms at every time-warp tier: a given mouse deflection
turns the ship through the same angle per real second at 1× as at 50×. Above 100× manual rotation is
unavailable and the attitude holds take over.

**Stability assist** is on by default: releasing the controls stops the rotation and holds the nose
where you left it. Turned off with `T`, the ship keeps rotating after you release, the way an
unassisted spacecraft would; `X` stops it at any time. **Attitude holds** point the ship at an
orbital direction and keep it there, turning at up to 15°/s. Touching the mouse or a rotation axis
hands control straight back to you.

In manual flight the drive is limited to 2 g of proper acceleration, well inside the 10 g the vessel
can produce; the full envelope is reserved for automated cruise.

## Camera and focus

| Action                     | Control                           |
| -------------------------- | --------------------------------- |
| Mouse-look (pointer lock)  | Double-click the view             |
| Release mouse-look         | `Escape`                          |
| Orbit camera               | Primary-button drag               |
| Zoom camera                | Mouse wheel / trackpad scroll     |
| Keyboard orbit             | `Shift` + arrow keys              |
| Keyboard zoom              | `Shift` + `Page Up` / `Page Down` |
| Previous / next focus body | `[` / `]`                         |
| Focus Earth                | `E`                               |
| Focus Jupiter              | `J`                               |

## Panels and session

| Action                   | Control                 |
| ------------------------ | ----------------------- |
| Open or close system map | `M`                     |
| Open performance details | `F3`                    |
| Traverse UI controls     | `Tab` / `Shift` + `Tab` |
| Activate focused control | `Enter` or `Space`      |

The system map, burn log, settings, save/load, import/export, quality selection, and tutorial all use
native DOM controls and remain operable without a pointer. The HUD camera-help line repeats the most
common camera and focus bindings during flight.
