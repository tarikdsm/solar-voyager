/**
 * Shared browser waits for the T0110 camera, budgeted in **rendered frames**.
 *
 * Why frames and not milliseconds. `CameraDirector` advances its 1.5 s mode
 * blend by the frame delta, and `RenderTelemetry.beginFrame` clamps that delta to
 * `MAX_GAME_DELTA_SEC = 0.1`. A mode change therefore costs **at least 15
 * rendered frames**, whatever the frame rate, and settles after
 * `max(1.5 s, 15 / fps)` of wall clock: 1.8 s at the 8 fps this repo's harnesses
 * see on a software rasteriser, 15 s at 1 fps, a minute at 0.25 fps on a
 * contended runner.
 *
 * A wall-clock timeout around that is a frame-rate assumption wearing a
 * timeout's clothes — the same defect that made the first version of this gate
 * flaky one level down, and then made its replacement time out in CI. So the
 * patience is expressed in the quantity the director actually consumes, and the
 * wall clock is left as a backstop for the one thing frames cannot detect: a
 * frame loop that has stopped entirely.
 *
 * The failure message distinguishes the two, because "it was slow" and "it is
 * dead" need completely different responses and guessing between them has
 * already cost two CI rounds.
 */

/** Blend frames needed at the clamped delta (1.5 / 0.1), times four for headroom. */
const DEFAULT_FRAME_BUDGET = 60;
/** Only ever reached when the frame loop has stopped, or is below ~0.2 fps. */
const WALL_BACKSTOP_MS = 300_000;

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
 * Waits for the camera to reach `mode` and stop animating into it.
 *
 * Gives up after `frameBudget` *rendered* frames, so a slow renderer takes
 * longer instead of failing, and a genuinely stuck director still fails fast.
 */
export async function waitForCameraMode(page, mode, options = {}) {
  const frameBudget = options.frameBudget ?? DEFAULT_FRAME_BUDGET;
  const before = await readCameraState(page);
  try {
    await page.waitForFunction(
      ({ budget, expected, startedAtFrame }) => {
        const canvas = globalThis.document.querySelector('#space-canvas');
        const camera = canvas?.solarVoyagerCamera;
        if (camera === undefined) throw new Error('camera diagnostic is missing');
        if (camera.mode === expected && !camera.transitioning) return true;
        const rendered =
          (canvas?.solarVoyagerTelemetry?.snapshot.frameCount ?? 0) - startedAtFrame;
        if (rendered > budget) {
          throw new Error(
            `the camera never reached "${expected}": still mode=${camera.mode} ` +
              `transitioning=${String(camera.transitioning)} after ${String(rendered)} ` +
              `rendered frames (a mode blend needs 15)`,
          );
        }
        return false;
      },
      { budget: frameBudget, expected: mode, startedAtFrame: before.frameCount },
      { timeout: WALL_BACKSTOP_MS },
    );
  } catch (cause) {
    const after = await readCameraState(page);
    const rendered = after.frameCount - before.frameCount;
    const reason =
      rendered <= 1
        ? 'the frame loop stopped: no frames rendered while waiting'
        : `only ${String(rendered)} frames rendered in ${String(WALL_BACKSTOP_MS)} ms`;
    throw new Error(
      `waitForCameraMode(${mode}) failed — ${reason}. ${JSON.stringify({ after, before })}`,
      { cause },
    );
  }
}
