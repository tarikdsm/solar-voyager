/**
 * Shared browser waits for the T0110 camera, bounded in **both** dimensions.
 *
 * Why frames. `CameraDirector` advances its 1.5 s mode blend by the frame delta,
 * and `RenderTelemetry.beginFrame` clamps that delta to `MAX_GAME_DELTA_SEC = 0.1`.
 * A mode change therefore costs **at least 15 rendered frames** whatever the
 * frame rate, and settles after `max(1.5 s, 15 / fps)`: 1.8 s at the ~8 fps a
 * software rasteriser gives this page, 15 s at 1 fps, over a minute below
 * 0.25 fps. A wall-clock-only timeout around that is a frame-rate assumption,
 * which is what made the first two versions of this gate fail wrongly.
 *
 * Why also a wall cap. A frame budget alone is unbounded in time — 600 frames at
 * 0.3 fps is half an hour — and an hour-long hang is strictly worse than a wrong
 * failure in four minutes: it burns the runner, blocks the queue and yields no
 * signal. So every wait carries a frame budget *and* a wall cap, and the caps on
 * one harness's critical path are sized to sum inside its `timeout-minutes`, so
 * the step always fails with a diagnostic rather than being killed without one.
 *
 * Whichever bound trips, the message reports frames advanced, frames needed and
 * the observed frame rate, so "runner at 0.3 fps", "frame loop dead" and "mode
 * never changed" are distinguishable without re-deriving any of it.
 */

/** Frames a blend needs at the clamped delta (1.5 / 0.1). */
export const BLEND_FRAME_COST = 15;
/** Four times the blend cost: generous for a stall, tight enough to fail fast. */
const DEFAULT_FRAME_BUDGET = 60;
/** Sized with the rest of a harness's critical path to fit its step timeout. */
const DEFAULT_WALL_CAP_MS = 45_000;

async function readCameraState(page) {
  return page.evaluate(() => {
    const canvas = globalThis.document.querySelector('#space-canvas');
    const camera = canvas?.solarVoyagerCamera;
    return {
      activeElement: globalThis.document.activeElement?.tagName ?? null,
      cameraReady: canvas?.dataset.cameraReady ?? null,
      focusId: camera?.focusId ?? null,
      frameCount: canvas?.solarVoyagerTelemetry?.snapshot.frameCount ?? -1,
      mode: camera?.mode ?? null,
      pointerLock: globalThis.document.pointerLockElement?.id ?? null,
      systemMapMode: canvas?.dataset.systemMapMode ?? null,
      transitioning: camera?.transitioning ?? null,
    };
  });
}

/**
 * Turns "it did not happen" into a statement of which bound tripped and why.
 *
 * The three causes need opposite responses — wait longer, fix the app, fix the
 * runner — and telling them apart from a bare timeout has already cost two CI
 * rounds on this branch.
 */
export function describeCameraWait(label, before, after, elapsedMs, frameBudget) {
  const frames = after.frameCount - before.frameCount;
  const fps = elapsedMs > 0 ? (frames / elapsedMs) * 1_000 : 0;
  const cause =
    frames <= 1
      ? 'the frame loop stopped — no frames rendered while waiting'
      : frames > frameBudget
        ? `the app rendered ${String(frames)} frames without getting there, past the ` +
          `${String(frameBudget)}-frame budget (a blend needs ${String(BLEND_FRAME_COST)}), ` +
          'so this is the app, not the runner'
        : `the runner rendered only ${String(frames)} frames in ${String(Math.round(elapsedMs))} ms ` +
          `(${fps.toFixed(2)} fps); a blend needs ${String(BLEND_FRAME_COST)} frames, so this is ` +
          'the runner being slow, not the app being wrong';
  return `${label}: ${cause}. ${JSON.stringify({ after, before, elapsedMs: Math.round(elapsedMs), fps: Number(fps.toFixed(2)) })}`;
}

/**
 * Waits for the camera to reach `mode` and stop animating into it.
 *
 * Bounded by rendered frames first and wall clock second; both report through
 * {@link describeCameraWait}.
 */
export async function waitForCameraMode(page, mode, options = {}) {
  const frameBudget = options.frameBudget ?? DEFAULT_FRAME_BUDGET;
  const wallCapMs = options.wallCapMs ?? DEFAULT_WALL_CAP_MS;
  const before = await readCameraState(page);
  const startedMs = Date.now();
  try {
    await page.waitForFunction(
      ({ budget, expected, startedAtFrame }) => {
        const canvas = globalThis.document.querySelector('#space-canvas');
        const camera = canvas?.solarVoyagerCamera;
        if (camera === undefined) throw new Error('camera diagnostic is missing');
        if (camera.mode === expected && !camera.transitioning) return true;
        const rendered =
          (canvas?.solarVoyagerTelemetry?.snapshot.frameCount ?? 0) - startedAtFrame;
        if (rendered > budget) throw new Error(`frame budget exhausted after ${String(rendered)}`);
        return false;
      },
      { budget: frameBudget, expected: mode, startedAtFrame: before.frameCount },
      { timeout: wallCapMs },
    );
  } catch (cause) {
    throw new Error(
      describeCameraWait(
        `waitForCameraMode(${mode})`,
        before,
        await readCameraState(page),
        Date.now() - startedMs,
        frameBudget,
      ),
      { cause },
    );
  }
}
