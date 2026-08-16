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
| Cycle HUD preset    | `H`       |
| Toggle body labels  | `L`       |

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
camera is v1's: it orbits a celestial body and ignores the ship entirely. The
**cinematic** camera is for looking rather than flying: it orbits your own ship,
hides the HUD, adds roll and a field of view you can set, and drifts slowly on its
own if you leave it alone.

`O` steps through them — chase, cinematic, observatory — always as an animated
move, never a cut. Focusing a body (`[`, `]`, `E`, `J`) also switches to the
observatory camera, and stepping the focus ring back onto the ship returns you to
chase.

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
| Take a photo               | `P`                               |

In chase, dragging swings the arm around your own ship and the wheel sets its
length between 2 and 50 ship lengths; both keep working through any manoeuvre
because the offsets live in the ship's frame. In observatory, the same gestures
orbit and zoom the focused body exactly as they did in v1.

### Cinematic (photo) mode

`Q` and `E` roll the camera and `,` / `.` set its field of view between 20° and
90°, **only while the cinematic camera is running**. Outside it those keys mean
what they always meant: `E` focuses Earth, and `Q`, `,` and `.` do nothing. The
same key is deliberately two things in two modes, and nothing else changes
meaning: in cinematic the focus keys (`[`, `]`, `E`, `J`) stand down, because
every one of them would throw you out of the shot you are composing — `O` is the
way out. Dragging and the wheel still orbit and zoom around the ship, and roll,
field of view and the focus keys are all rebindable in **Session & settings →
Keyboard**.

`P` takes a photo in any camera mode. The picture is exactly what is on screen —
the HUD is drawn over the canvas, so it is never in the shot — and it is written
to your browser's downloads as
`solar-voyager-<mission UTC>-<body>-<number>.png`. Mission time, not wall-clock
time, so the files sort into flight order; the number keeps two shots of the same
paused instant apart. Nothing is uploaded anywhere.

The chase camera also opens its field of view slightly as you advance the
throttle, and vibrates very slightly under heavy acceleration (0.15° at 5 g).
Both are on by default and both can be turned off in **Session & settings →
Camera**.

## Audio

Sound starts the first time you click or press a key inside the game, and never
before: nothing is loaded, started or unmuted while the page is merely open.

**Session & settings → Audio** carries four independent levels — master, music,
ship and effects, interface — and they persist with the rest of your profile. The
ship and effects channel covers the drive hum, which follows the throttle.

Exterior cameras are **silent**, and that is the physics rather than a missing
feature: cinematic and observatory put you outside the hull, where there is no
medium to carry the ship's sound. Cockpit and chase are inside it and hear
everything. The score is not part of the ship, so it can follow you outside —
"Keep music on exterior cameras" is on by default; turn it off for total vacuum.
Interface sounds are never silenced by the camera.

## Panels and session

| Action                   | Control                 |
| ------------------------ | ----------------------- |
| Pause / resume           | `Escape`                |
| Open or close system map | `M`                     |
| Open performance details | `F3`                    |
| Traverse UI controls     | `Tab` / `Shift` + `Tab` |
| Activate focused control | `Enter` or `Space`      |

## HUD presets

The HUD ships in three presets and `H` cycles them:

| Preset       | Shows                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| **Clean**    | Reticle, target diamond, throttle/speed strip, cruise status, warnings   |
| **Pilot**    | Adds the navball, both clocks, radar altitude and the warp indicator     |
| **Engineer** | Adds every v1 panel: osculating orbit, energy ledger, state vectors, burn log, target list |

A new profile starts on Clean. The choice is saved, so it survives a reload, and
it can also be set in **Session & settings → HUD**. Accepting the optional
tutorial switches to Engineer, because the tour walks you through those panels.

In-world markers are independent of the preset: the target diamond carries its
distance and pins itself to the screen edge when the target is off-screen or
behind you, prograde and retrograde sit on the sky, and body labels with live
distances toggle with `L`. Clicking a body selects it as the navigation target —
the target list in the Engineer HUD remains as a fallback.

`Escape` pauses. The simulation genuinely stops: nothing moves, no time passes,
and the menu offers resume, settings, save and exit to the main menu. While the
system map is open `Escape` closes the map instead, and during a surface-contact
freeze the recovery overlay keeps it.

The system map, burn log, settings, save/load, import/export, quality selection, the pause menu, and
the tutorial all use native DOM controls and remain operable without a pointer. The HUD camera-help
line repeats the most common camera and focus bindings during flight (Engineer preset).
