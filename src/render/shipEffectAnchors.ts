/**
 * Where the ship's VFX attach, in **model metres, glTF axes** (T0122).
 *
 * Every number here is transcribed from `tools/blender/ship_config.py`, which is
 * the source of truth for the asset. The transcription exists because the plume,
 * the nozzle glow and the RCS puff pool must be in the scene for
 * `createEpochWorld`'s warm-up `compileAsync` pass, and `ship.glb` is lazily
 * fetched long after it — an effect parented to the loaded model cannot be
 * precompiled, which is the first-burn shader stall T0122 is required to avoid.
 *
 * The transcription is *verified*, not trusted: `ShipEffects.bindModel` measures
 * every anchor node's local position against these constants once the model
 * resolves and publishes the worst error as `anchorErrorM`, so a re-export that
 * moves a node fails a browser gate instead of hanging a plume in space.
 *
 * Frame conversion, for anyone comparing with the Python: Blender authors Z-up
 * (`+X` nose, `+Y` port, `+Z` up) and the glTF exporter writes
 * `(x, y, z)_blender -> (x, z, -y)_gltf`. So model `+Y` is up and model `+Z` is
 * starboard, exactly as `tasks/T0121-ship-remodel.yaml` states.
 */

/** `NOZZLE_ORIGIN_X` in `ship_config.py`: the `engine_nozzle` node origin. */
export const SHIP_NOZZLE_THROAT_X_M = -11.5;

/**
 * `NOZZLE_EXIT_X_M` — the bell mouth, 1.5 m aft of the throat.
 *
 * T0121's landmine: the node origin is the **throat**, and the bell is a closed
 * shell with a 5 cm liner. A plume drawn between these two stations is occluded
 * by that liner, which is the correct look — the beam emerges from the mouth.
 */
export const SHIP_NOZZLE_EXIT_X_M = -13;

/** `NOZZLE_PROFILE[-1].radius` — throat radius, where the beam is born. */
export const SHIP_NOZZLE_THROAT_RADIUS_M = 1.05;

/** `NOZZLE_PROFILE[0].radius` — bell-mouth radius, which sizes the nozzle glow. */
export const SHIP_NOZZLE_EXIT_RADIUS_M = 1.94;

/** Node names T0121 froze as API; `bindModel` looks up exactly these. */
export const SHIP_NOZZLE_NODE_NAME = 'engine_nozzle';
export const SHIP_RCS_POD_NODE_NAMES = [
  'rcs_pod_1',
  'rcs_pod_2',
  'rcs_pod_3',
  'rcs_pod_4',
] as const;

/** Emissive materials T0121 authored with a low baseline; blink belongs to T0122. */
export const SHIP_BEACON_MATERIAL_NAME = 'mat_light_beacon';
export const SHIP_NAV_PORT_MATERIAL_NAME = 'mat_light_nav_l';
export const SHIP_NAV_STARBOARD_MATERIAL_NAME = 'mat_light_nav_r';

/**
 * `rcs_pod_1..4` origins in model metres.
 *
 * `ship_config.rcs_pod_origin()` places pods at hull stations `+5.60` (forward)
 * and `-6.40` (aft), standing `RCS_POD_STANDOFF = 0.24 m` off the hull radius at
 * that station — `1.9171` and `2.1381`, so `2.1571` and `2.3781` laterally.
 * Numbering is 1 forward-port, 2 forward-starboard, 3 aft-port, 4 aft-starboard;
 * port is model `-Z`.
 */
export const SHIP_RCS_POD_ORIGINS_M: readonly (readonly [number, number, number])[] = Object.freeze(
  [
    Object.freeze([5.6, 0, -2.157_142_857_142_857_5] as const),
    Object.freeze([5.6, 0, 2.157_142_857_142_857_5] as const),
    Object.freeze([-6.4, 0, -2.378_095_238_095_238] as const),
    Object.freeze([-6.4, 0, 2.378_095_238_095_238] as const),
  ],
);

/**
 * Distance from a pod centre to each bell mouth, by exhaust axis.
 *
 * `_rcs_pod_mesh()` seats the fore/aft bells at `±0.52` and the tangential pair
 * at `±0.32` in pod-local axes, each bell 0.16 m deep.
 */
export const SHIP_RCS_AXIAL_BELL_OFFSET_M = 0.68;
export const SHIP_RCS_TANGENTIAL_BELL_OFFSET_M = 0.48;

/**
 * Largest anchor error, in metres, that `bindModel` accepts as "same asset".
 *
 * Blender stores `obj.location` as float32 (T0121's handoff), so the authored
 * f64 literals above cannot round-trip exactly; a millimetre is four orders of
 * magnitude tighter than any modelling change and comfortably looser than
 * float32 on a 13 m coordinate (~1e-6 m).
 */
export const SHIP_ANCHOR_TOLERANCE_M = 1e-3;
