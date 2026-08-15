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
unassisted spacecraft would; `X` stops it at any time. A rotation you are already carrying is real
angular momentum, so time warp compresses it like every other motion — leave the ship spinning with
the assist off and it will appear to spin faster as you warp up. Only your control inputs are
warp-corrected. Press `X` or turn the assist back on to stop, and raising warp past 100× clears the
rotation outright. **Attitude holds** point the ship at an
orbital direction and keep it there, turning at up to 15°/s. Touching the mouse or a rotation axis
hands control straight back to you.

In manual flight the drive is limited to 2 g of proper acceleration, well inside the 10 g the vessel
can produce; the full envelope is reserved for automated cruise.

## Gamepad

A standard-mapping gamepad (Xbox/PlayStation-style controller) works alongside the keyboard and mouse
with no setup: connect it and move a stick. Keyboard and gamepad axes add together, so a gamepad
resting on the desk never fights a keyboard-only player, and a connected gamepad never steals input
while a text field — a rebinding capture, an import/export box — has focus.

| Control       | Action                                             |
| ------------- | -------------------------------------------------- |
| Left stick    | Pitch (up/down) and yaw (left/right)               |
| Right stick X | Roll                                               |
| Right trigger | Throttle up, proportional to how far it is pressed |
| Left trigger  | Throttle down / cut                                |
| A             | Reserved for cruise engage (not yet implemented)   |
| B             | Reserved for cruise abort (not yet implemented)    |

The response curve and the deadzone are shared across every axis; **Session & settings → Gamepad**
exposes both, plus per-axis invert and sensitivity for pitch, yaw, roll, and throttle independently.
Inverting the pitch axis switches between "stick away from you pitches up" (the default, matching
mouse-look) and the aircraft-yoke convention. The throttle trigger sets the lever directly rather than
ramping it the way the keyboard `R`/`F` keys do: releasing the trigger holds the lever where the
trigger left it, exactly like releasing `R`/`F`. Manual rotation is still locked above the same warp
tier as keyboard and mouse-look, and gamepad rates are normalized by time warp identically to every
other input source.

## Camera and focus

The game starts behind your ship. The **chase** camera hangs on a spring arm a
few ship lengths back and slightly above, follows your attitude with a short
deliberate lag, and rolls when you roll — so a roll reads as the world turning
around you rather than the ship turning inside a fixed frame. The **observatory**
camera is v1's: it orbits a celestial body and ignores the ship entirely.

`O` switches between them, always as an animated move, never a cut. Focusing a
body (`[`, `]`, `E`, `J`) also switches to the observatory camera, and stepping
the focus ring back onto the ship returns you to chase.

Choosing a **navigation target** is not a camera command: it re-aims the
observatory camera for when you next switch to it and leaves you in the chase
view. The `Focus:` line in the HUD always names what the camera is actually
looking at, which is not necessarily your target.

| Action                     | Control                           |
| -------------------------- | --------------------------------- |
| Mouse-look (pointer lock)  | Double-click the view             |
| Release mouse-look         | `Escape`                          |
| Switch camera mode         | `O`                               |
| Swing the camera           | Primary-button drag               |
| Zoom camera                | Mouse wheel / trackpad scroll     |
| Keyboard orbit             | `Shift` + arrow keys              |
| Keyboard zoom              | `Shift` + `Page Up` / `Page Down` |
| Previous / next focus body | `[` / `]`                         |
| Focus Earth                | `E`                               |
| Focus Jupiter              | `J`                               |

In chase, dragging swings the arm around your own ship and the wheel sets its
length between 2 and 50 ship lengths; both keep working through any manoeuvre
because the offsets live in the ship's frame. In observatory, the same gestures
orbit and zoom the focused body exactly as they did in v1.

The chase camera also opens its field of view slightly as you advance the
throttle, and vibrates very slightly under heavy acceleration (0.15° at 5 g).
Both are on by default and both can be turned off in **Session & settings →
Camera**.

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
