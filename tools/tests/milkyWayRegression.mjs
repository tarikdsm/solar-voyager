import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { resolveHarnessPort } from '../harnessPort.mjs';

const HOST = '127.0.0.1';
const PORT = resolveHarnessPort(4194);
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/milkyWay.html`;

/**
 * The whole point of the task, as a number.
 *
 * With a star pinned to screen centre, the panorama texel under the crosshair is
 * the one whose own true direction is that star's - but only if the sphere is
 * displaced by the same map the star Points are. So the sampled sky colour under
 * a given star must not change with beta.
 *
 * The tolerance is relative because the samples span two orders of magnitude of
 * sky brightness; it covers bilinear filtering and the 64x32 sphere's
 * piecewise-linear warp. A second, independently written aberration would land
 * on a different part of the galactic plane entirely and miss by tens of levels.
 */
const MAX_ABERRATION_DRIFT_FRACTION = 0.15;
const MAX_ABERRATION_DRIFT_FLOOR = 1;
/** Below this the panorama is background and byte quantisation dominates. */
const COHERENCE_SIGNAL_FLOOR = 5;

/** rendering-spec.md §5.2 — the zodiacal band's display budget. */
const MAX_ZODIACAL_NITS = 2;

function assertSampleCoherence(restSnapshot, boostedSnapshot, report) {
  const rest = new Map(restSnapshot.samples.map((sample) => [sample.name, sample]));
  let compared = 0;
  for (const boosted of boostedSnapshot.samples) {
    const still = rest.get(boosted.name);
    assert.ok(still, `reference star ${boosted.name} is missing from the rest snapshot`);
    if (still.luminance < COHERENCE_SIGNAL_FLOOR) continue;
    const drift = Math.abs(still.luminance - boosted.luminance);
    const allowed = Math.max(
      MAX_ABERRATION_DRIFT_FLOOR,
      MAX_ABERRATION_DRIFT_FRACTION * still.luminance,
    );
    report.push(
      `    beta ${boostedSnapshot.beta}: ${boosted.name} ${still.luminance.toFixed(2)} -> ` +
        `${boosted.luminance.toFixed(2)} (drift ${drift.toFixed(2)}, allowed ${allowed.toFixed(2)})`,
    );
    assert.ok(
      drift <= allowed,
      `${boosted.name}: panorama sheared against the stars — sky luminance ${still.luminance.toFixed(2)} ` +
        `at rest vs ${boosted.luminance.toFixed(2)} at beta ${boostedSnapshot.beta}; drift ` +
        `${drift.toFixed(2)} exceeds ${allowed.toFixed(2)}`,
    );
    compared += 1;
  }
  assert.ok(
    compared >= 2,
    `aberration coherence needs at least two high-signal reference stars, compared ${compared}`,
  );
}

async function main() {
  const server = await createServer({
    configFile: 'vite.config.ts',
    server: { host: HOST, port: PORT, strictPort: true },
    logLevel: 'error',
  });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    await page.goto(FIXTURE_URL, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.__milkyWayHarness !== undefined, null, {
      timeout: 60_000,
    });
    await page.evaluate(async () => {
      await globalThis.__milkyWayHarness.ready();
    });

    const diagnostics = await page.evaluate(() => globalThis.__milkyWayHarness.diagnostics());
    assert.equal(
      diagnostics.panoramaLoadState,
      'ready',
      `panorama did not load: ${diagnostics.panoramaLoadState}`,
    );
    assert.equal(diagnostics.panoramaResident, true, 'panorama texture is not resident');
    assert.equal(diagnostics.starCount, 9_096, 'star catalog changed size');
    assert.ok(
      diagnostics.segmentCount >= 600 && diagnostics.segmentCount <= 1_024,
      `constellation payload has ${diagnostics.segmentCount} segments`,
    );

    // 1. Panorama only: it must actually paint, and it must be one draw call.
    await page.evaluate(() => {
      globalThis.__milkyWayHarness.setLayers({
        panorama: true,
        zodiacal: false,
        constellations: false,
        stars: false,
      });
      globalThis.__milkyWayHarness.setHeliocentricDistanceAu(1);
    });
    const rest = await page.evaluate(() => globalThis.__milkyWayHarness.render(0));
    assert.equal(rest.glError, 0, `WebGL error ${rest.glError}`);
    assert.equal(rest.drawCalls, 1, `panorama must be one draw call, measured ${rest.drawCalls}`);
    assert.equal(
      rest.triangles,
      3_968,
      `sky sphere triangle count changed: ${rest.triangles}`,
    );
    assert.ok(rest.maxLuminance > 20, `panorama is unexpectedly dark: peak ${rest.maxLuminance}`);

    // 2. Orientation. Aiming at each catalog star and reading the sky behind it
    //    is a direct registration check: stars in the galactic plane must sit on
    //    bright sky and stars far from it on dark sky. A wrong pole, node or
    //    handedness scrambles this ordering completely.
    const byName = new Map(rest.samples.map((sample) => [sample.name, sample]));
    const report = ['  registration (sky luminance behind each catalog star):'];
    for (const sample of rest.samples) {
      report.push(
        `    ${sample.name.padEnd(8)} l=${sample.galacticLongitudeDeg.toFixed(2).padStart(6)} ` +
          `b=${sample.galacticLatitudeDeg.toFixed(2).padStart(6)}  sky ${sample.luminance.toFixed(2)}`,
      );
    }
    const inPlane = ['Shaula', 'Acrux'].map((name) => byName.get(name));
    const offPlane = ['Vega', 'Canopus'].map((name) => byName.get(name));
    for (const sample of [...inPlane, ...offPlane]) {
      assert.ok(sample, 'reference samples are incomplete');
    }
    for (const sample of inPlane) {
      assert.ok(
        Math.abs(sample.galacticLatitudeDeg) < 5,
        `${sample.name} should sit in the galactic plane, measured b=${sample.galacticLatitudeDeg}`,
      );
    }
    for (const sample of offPlane) {
      assert.ok(
        Math.abs(sample.galacticLatitudeDeg) > 15,
        `${sample.name} should sit off the galactic plane, measured b=${sample.galacticLatitudeDeg}`,
      );
    }
    const dimmestInPlane = Math.min(...inPlane.map((sample) => sample.luminance));
    const brightestOffPlane = Math.max(...offPlane.map((sample) => sample.luminance));
    assert.ok(
      dimmestInPlane > 5 * brightestOffPlane,
      `panorama is mis-oriented: galactic-plane sky (${dimmestInPlane.toFixed(2)}) is not five times ` +
        `brighter than high-latitude sky (${brightestOffPlane.toFixed(2)})`,
    );

    // 3. THE rule: the sky must aberrate exactly like the stars.
    report.push('  aberration coherence:');
    for (const beta of [0.5, 0.9]) {
      const boosted = await page.evaluate(
        (value) => globalThis.__milkyWayHarness.render(value),
        beta,
      );
      assert.equal(boosted.glError, 0, `WebGL error ${boosted.glError} at beta ${beta}`);
      assertSampleCoherence(rest, boosted, report);
    }

    // 4. Zodiacal light: bounded, toggleable, and it fades outward.
    await page.evaluate(() => {
      globalThis.__milkyWayHarness.setLayers({ panorama: false, zodiacal: true });
      globalThis.__milkyWayHarness.setHeliocentricDistanceAu(1);
    });
    const zodiacal = await page.evaluate(() => globalThis.__milkyWayHarness.render(0));
    const nearNits = await page.evaluate(() => globalThis.__milkyWayHarness.zodiacalPeakNits());
    assert.ok(
      nearNits > 0 && nearNits <= MAX_ZODIACAL_NITS,
      `zodiacal peak ${nearNits} nits is outside (0, ${MAX_ZODIACAL_NITS}]`,
    );
    assert.ok(zodiacal.meanLuminance > 0, 'zodiacal light did not render');
    assert.ok(
      zodiacal.maxLuminance <= 96,
      `zodiacal light is too bright: peak byte ${zodiacal.maxLuminance}`,
    );
    await page.evaluate(() => {
      globalThis.__milkyWayHarness.setHeliocentricDistanceAu(30);
    });
    const farNits = await page.evaluate(() => globalThis.__milkyWayHarness.zodiacalPeakNits());
    assert.ok(
      farNits < nearNits / 100,
      `zodiacal light must fade outward: ${nearNits} nits at 1 AU vs ${farNits} at 30 AU`,
    );

    await page.evaluate(() => {
      globalThis.__milkyWayHarness.setLayers({ zodiacal: false });
      globalThis.__milkyWayHarness.setHeliocentricDistanceAu(1);
    });
    const dark = await page.evaluate(() => globalThis.__milkyWayHarness.render(0));
    assert.equal(dark.drawCalls, 0, 'an empty sky must not be drawn at all');
    assert.equal(dark.maxLuminance, 0, 'the sky is not dark with every layer off');

    // 5. Constellations: one draw call, zero triangles, and nothing at all when
    //    the overlay is off — which is how it ships.
    await page.evaluate(() => {
      globalThis.__milkyWayHarness.setLayers({
        panorama: false,
        zodiacal: false,
        constellations: true,
      });
    });
    const overlay = await page.evaluate(() => globalThis.__milkyWayHarness.render(0));
    assert.equal(
      overlay.drawCalls,
      1,
      `the constellation batch must be a single draw call, measured ${overlay.drawCalls}`,
    );
    assert.equal(overlay.triangles, 0, `constellations must add no triangles: ${overlay.triangles}`);
    assert.ok(
      overlay.maxLuminance > 20,
      `constellation lines did not render: peak ${overlay.maxLuminance}`,
    );
    report.push(
      `  constellations: 1 draw call, 0 triangles, peak ${overlay.maxLuminance.toFixed(1)}`,
    );

    await page.evaluate(() => {
      globalThis.__milkyWayHarness.setLayers({ panorama: true, constellations: true });
    });
    const both = await page.evaluate(() => globalThis.__milkyWayHarness.render(0));
    assert.equal(
      both.drawCalls,
      2,
      `panorama plus constellations must be two draw calls, measured ${both.drawCalls}`,
    );

    // 6. Governor rung: the tier reaches the resident texture and 'off' stops
    //    the panorama drawing without touching the zodiacal band.
    await page.evaluate(() => {
      globalThis.__milkyWayHarness.setLayers({ constellations: false });
    });
    await page.evaluate(async () => {
      await globalThis.__milkyWayHarness.setTier('half');
    });
    const half = await page.evaluate(() => globalThis.__milkyWayHarness.diagnostics());
    assert.equal(half.skyboxTier, 'half', 'governor tier did not reach the sky');
    assert.equal(half.panoramaLoadState, 'ready', 'half-tier panorama did not load');
    const halfSnapshot = await page.evaluate(() => globalThis.__milkyWayHarness.render(0));
    assert.ok(
      halfSnapshot.maxLuminance > 20,
      `half-tier panorama is unexpectedly dark: peak ${halfSnapshot.maxLuminance}`,
    );

    await page.evaluate(async () => {
      await globalThis.__milkyWayHarness.setTier('off');
    });
    const off = await page.evaluate(() => globalThis.__milkyWayHarness.render(0));
    assert.equal(off.drawCalls, 0, 'skybox tier "off" must stop the sky draw entirely');
    const offDiagnostics = await page.evaluate(() => globalThis.__milkyWayHarness.diagnostics());
    assert.equal(offDiagnostics.skyVisible, false, 'skybox tier "off" left the mesh visible');

    assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
    console.log(report.join('\n'));
    console.log(
      `Milky Way regression passed: ${String(diagnostics.segmentCount)} constellation segments, ` +
        `${rest.triangles.toLocaleString('en-US')} sky triangles, 1 sky draw call, ` +
        `zodiacal peak ${nearNits.toFixed(3)} nits at 1 AU / ${farNits.toExponential(2)} at 30 AU.`,
    );
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
