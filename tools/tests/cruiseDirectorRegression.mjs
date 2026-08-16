import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4199;
const PAGE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/cruiseDirector.html`;
/** The scenarios are minutes of simulated flight; the runner needs room. */
const HARNESS_TIMEOUT_MS = 900_000;

const server = await createServer({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  server: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 400 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__cruiseDirectorHarness !== undefined);
  await page.waitForFunction(() => globalThis.__cruiseDirectorHarness.status !== 'running', null, {
    timeout: HARNESS_TIMEOUT_MS,
  });
  const harness = await page.evaluate(() => globalThis.__cruiseDirectorHarness);

  assert.equal(harness.status, 'done', `cruise harness failed: ${harness.error ?? 'unknown'}`);
  assert.deepEqual(pageErrors, [], 'cruise harness raised page errors');
  assert.deepEqual(consoleErrors, [], 'cruise harness logged console errors');

  // --- Acceptance: LEO -> Jupiter 'orbit', unattended, <= 5 wall minutes. -----
  const { jupiter, moon, fuzz } = harness;
  assert.equal(jupiter.engaged, true, 'LEO->Jupiter failed to engage');
  assert.equal(jupiter.phase, 'done', `LEO->Jupiter ended in phase ${jupiter.phase}`);
  assert.equal(jupiter.impactOccurred, false, 'LEO->Jupiter hit something');
  assert.ok(
    jupiter.wallSec <= harness.arrivalWallBudgetSec,
    `LEO->Jupiter took ${jupiter.wallSec.toFixed(1)} s of unattended wall clock, budget ${harness.arrivalWallBudgetSec}`,
  );
  assert.ok(
    jupiter.eccentricity < 0.05,
    `LEO->Jupiter arrival eccentricity ${jupiter.eccentricity}`,
  );
  const jupiterAltitudeError = Math.abs(jupiter.altitudeKm / jupiter.presetAltitudeKm - 1);
  assert.ok(
    jupiterAltitudeError < 0.1,
    `LEO->Jupiter altitude off preset by ${(jupiterAltitudeError * 100).toFixed(2)}%`,
  );
  // physics-spec §8.5 — the stand-off must clear the Thebe gossamer ring.
  assert.ok(
    jupiter.arrivalRadiusKm > 270_000,
    `Jupiter stand-off ${jupiter.arrivalRadiusKm} km is inside the ring system`,
  );

  // --- Acceptance: ledger honesty (no side channel), physics-spec §5. --------
  for (const [name, result] of [
    ['jupiter', jupiter],
    ['moon', moon],
  ]) {
    assert.ok(
      Math.abs(result.ledgerIdentityRatio - 1) <= 0.02,
      `${name} cruise energy is not the integrator ledger: ratio ${result.ledgerIdentityRatio}`,
    );
    assert.ok(result.energySpentJ > 0, `${name} cruise spent no energy`);
  }

  assert.equal(moon.phase, 'done', `LEO->Moon ended in phase ${moon.phase}`);
  assert.ok(moon.eccentricity < 0.05, `LEO->Moon arrival eccentricity ${moon.eccentricity}`);

  // --- Acceptance: abort at any phase leaves a valid controllable state. -----
  assert.equal(fuzz.runs, 200, `abort fuzz ran ${fuzz.runs} samples`);
  assert.deepEqual(
    fuzz.failures,
    [],
    `abort fuzz failures: ${fuzz.failures.map((f) => `@${f.abortAtFrame} ${f.reason}`).join('; ')}`,
  );
  assert.ok(
    fuzz.maxDecompressionWallSec <= 1,
    `abort decompression took ${fuzz.maxDecompressionWallSec} s of wall clock`,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        jupiter: {
          wallSec: Number(jupiter.wallSec.toFixed(1)),
          simDays: Number((jupiter.simTimeSec / 86_400).toFixed(3)),
          eccentricity: Number(jupiter.eccentricity.toFixed(5)),
          altitudeKm: Math.round(jupiter.altitudeKm),
          presetAltitudeKm: Math.round(jupiter.presetAltitudeKm),
          altitudeErrorPercent: Number((jupiterAltitudeError * 100).toFixed(3)),
          peakBeta: Number(jupiter.peakBeta.toFixed(6)),
          ledgerIdentityRatio: Number(jupiter.ledgerIdentityRatio.toFixed(5)),
          profileEnergyRatio: Number(jupiter.profileEnergyRatio.toFixed(4)),
          kineticBoundRatio: Number(jupiter.energyRatio.toFixed(2)),
        },
        moon: {
          wallSec: Number(moon.wallSec.toFixed(1)),
          eccentricity: Number(moon.eccentricity.toFixed(5)),
          ledgerIdentityRatio: Number(moon.ledgerIdentityRatio.toFixed(5)),
        },
        abortFuzz: {
          runs: fuzz.runs,
          phasesSeen: fuzz.phasesSeen,
          maxDecompressionWallSec: fuzz.maxDecompressionWallSec,
          failures: fuzz.failures.length,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
