import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const PORT = 4187;
const SIZE = 512;
const FIXTURE_URL = `http://${HOST}:${PORT}/solar-voyager/tests/render/gasGiantAnimation.html`;
const BODY_IDS = ['jupiter', 'saturn', 'uranus', 'neptune'];
const EXPECTED_SEEDS = { jupiter: 599, saturn: 699, uranus: 799, neptune: 899 };
const MINIMUM_MOTION = { jupiter: 0.7, saturn: 0.35, uranus: 0.35, neptune: 0.7 };

async function image(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function luminance(subject, offset) {
  return (
    (subject.data[offset] ?? 0) * 0.2126 +
    (subject.data[offset + 1] ?? 0) * 0.7152 +
    (subject.data[offset + 2] ?? 0) * 0.0722
  );
}

function comparison(first, second) {
  let samples = 0;
  let absoluteRgbDelta = 0;
  let firstMean = 0;
  let secondMean = 0;
  let firstSquare = 0;
  let secondSquare = 0;
  let product = 0;
  for (let offset = 0; offset < first.data.length; offset += first.channels) {
    const firstLuminance = luminance(first, offset);
    const secondLuminance = luminance(second, offset);
    if (Math.max(firstLuminance, secondLuminance) < 3) continue;
    firstMean += firstLuminance;
    secondMean += secondLuminance;
    firstSquare += firstLuminance * firstLuminance;
    secondSquare += secondLuminance * secondLuminance;
    product += firstLuminance * secondLuminance;
    absoluteRgbDelta +=
      (Math.abs((first.data[offset] ?? 0) - (second.data[offset] ?? 0)) +
        Math.abs((first.data[offset + 1] ?? 0) - (second.data[offset + 1] ?? 0)) +
        Math.abs((first.data[offset + 2] ?? 0) - (second.data[offset + 2] ?? 0))) /
      3;
    samples += 1;
  }
  const firstAverage = firstMean / samples;
  const secondAverage = secondMean / samples;
  const covariance = product / samples - firstAverage * secondAverage;
  const firstVariance = firstSquare / samples - firstAverage * firstAverage;
  const secondVariance = secondSquare / samples - secondAverage * secondAverage;
  return {
    correlation: covariance / Math.sqrt(Math.max(1e-9, firstVariance * secondVariance)),
    meanAbsoluteRgbDelta: absoluteRgbDelta / samples,
    meanLuminanceDrift: Math.abs(secondAverage - firstAverage) / Math.max(1, firstAverage),
    samples,
  };
}

function redSpotCenter(subject) {
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestX = 0;
  let bestY = 0;
  for (let y = 32; y < subject.height - 32; y += 1) {
    for (let x = 32; x < subject.width - 32; x += 1) {
      const offset = (y * subject.width + x) * subject.channels;
      const red = subject.data[offset] ?? 0;
      const green = subject.data[offset + 1] ?? 0;
      const blue = subject.data[offset + 2] ?? 0;
      const score = red - green * 0.72 - blue * 0.28;
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }
  return { x: bestX, y: bestY, score: bestScore };
}

function cropDelta(first, second, centerX, centerY, halfWidth, halfHeight) {
  let total = 0;
  let samples = 0;
  for (let y = centerY - halfHeight; y <= centerY + halfHeight; y += 1) {
    for (let x = centerX - halfWidth; x <= centerX + halfWidth; x += 1) {
      if (x < 0 || y < 0 || x >= first.width || y >= first.height) continue;
      const offset = (y * first.width + x) * first.channels;
      total += Math.abs(luminance(first, offset) - luminance(second, offset));
      samples += 1;
    }
  }
  return total / samples;
}

const server = await createServer({
  root: process.cwd(),
  base: '/solar-voyager/',
  logLevel: 'error',
  server: { host: HOST, port: PORT, strictPort: true },
});
let browser;

try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=default'],
  });
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const requests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  page.on('requestfailed', (request) => failedRequests.push(request.url()));

  await page.goto(FIXTURE_URL, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.waitForFunction(() => globalThis.__gasGiantAnimationTest !== undefined, undefined, {
    timeout: 120_000,
  });

  const setup = await page.evaluate(() => globalThis.__gasGiantAnimationTest.setupSnapshot());
  assert.deepEqual(setup.loadedBodyIds, BODY_IDS);
  assert.equal(setup.programs.afterWarmUp, setup.programs.afterFirstPass);
  assert.equal(setup.glError, 0);

  const metrics = {};
  const diagnosticDirectory = process.env.GAS_GIANT_SCREENSHOTS;
  const diagnosticOutput = diagnosticDirectory === undefined ? null : resolve(diagnosticDirectory);
  if (diagnosticOutput !== null) await mkdir(diagnosticOutput, { recursive: true });
  for (const bodyId of BODY_IDS) {
    const captures = {};
    for (const [label, time, quality, enabled] of [
      ['static', 0, 'full', false],
      ['animatedStart', 0, 'full', true],
      ['animatedLater', 3_900, 'full', true],
      ['half', 3_900, 'half', true],
      ['minimum', 3_900, 'minimum', true],
    ]) {
      const snapshot = await page.evaluate(
        ([id, simTimeSec, selectedQuality, animationEnabled]) =>
          globalThis.__gasGiantAnimationTest.renderBody(
            id,
            simTimeSec,
            selectedQuality,
            animationEnabled,
          ),
        [bodyId, time, quality, enabled],
      );
      assert.equal(snapshot.glError, 0, `${bodyId}/${label}: WebGL error`);
      assert.equal(snapshot.seed, EXPECTED_SEEDS[bodyId], `${bodyId}: wrong seed`);
      const screenshot = await page.locator('canvas').screenshot();
      if (diagnosticOutput !== null) {
        await writeFile(resolve(diagnosticOutput, `${bodyId}-${label}.png`), screenshot);
      }
      captures[label] = { image: await image(screenshot), snapshot };
    }
    assert.equal(captures.static.snapshot.octaves, 4);
    assert.equal(captures.animatedStart.snapshot.octaves, 4);
    assert.equal(captures.half.snapshot.octaves, 2);
    assert.equal(captures.minimum.snapshot.octaves, 1);
    assert.equal(captures.static.snapshot.calls, captures.animatedStart.snapshot.calls);
    assert.equal(captures.static.snapshot.programs, captures.minimum.snapshot.programs);

    const identity = comparison(captures.static.image, captures.animatedStart.image);
    const motion = comparison(captures.animatedStart.image, captures.animatedLater.image);
    assert.ok(identity.samples > 8_000, `${bodyId}: body image is empty`);
    assert.ok(identity.correlation >= 0.94, `${bodyId}: authored identity distorted ${JSON.stringify(identity)}`);
    assert.ok(identity.meanLuminanceDrift <= 0.02, `${bodyId}: mean color drift ${JSON.stringify(identity)}`);
    metrics[bodyId] = { identity, motion, snapshots: Object.fromEntries(Object.entries(captures).map(([key, value]) => [key, value.snapshot])) };
  }
  for (const bodyId of BODY_IDS) {
    assert.ok(
      metrics[bodyId].motion.meanAbsoluteRgbDelta >= MINIMUM_MOTION[bodyId],
      `${bodyId}: animation is static ${JSON.stringify(metrics[bodyId].motion)}`,
    );
  }

  const spotStaticSnapshot = await page.evaluate(() =>
    globalThis.__gasGiantAnimationTest.renderSpot(0, false),
  );
  const spotStatic = await image(await page.locator('canvas').screenshot());
  const spotAnimatedSnapshot = await page.evaluate(() =>
    globalThis.__gasGiantAnimationTest.renderSpot(9.9 * 3_600, true),
  );
  const spotAnimated = await image(await page.locator('canvas').screenshot());
  assert.equal(spotStaticSnapshot.glError, 0);
  assert.equal(spotAnimatedSnapshot.glError, 0);
  const spotCenter = redSpotCenter(spotStatic);
  const spotDelta = cropDelta(spotStatic, spotAnimated, spotCenter.x, spotCenter.y, 38, 28);
  const controlY = spotCenter.y < SIZE / 2 ? SIZE - spotCenter.y : SIZE - spotCenter.y;
  const controlDelta = cropDelta(spotStatic, spotAnimated, spotCenter.x, controlY, 38, 28);
  assert.ok(spotCenter.score > 8, `Great Red Spot was not found: ${JSON.stringify(spotCenter)}`);
  assert.ok(
    spotDelta >= controlDelta * 1.1,
    `Great Red Spot rotation is not localized: ${JSON.stringify({ spotCenter, spotDelta, controlDelta })}`,
  );

  const textureRequests = requests.filter((url) => /\/textures\/.*\.ktx2(?:$|\?)/u.test(url));
  for (const url of textureRequests) {
    const pathname = new URL(url).pathname;
    assert.match(pathname, /_(?:albedo|detail_albedo|detail_normal|rings)(?:_[12]k|_tier2)?\.ktx2$/u);
    assert.doesNotMatch(pathname, /(?:flow|noise|storm|animation)/u);
  }
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);

  const screenshotDirectory = process.env.GAS_GIANT_SCREENSHOTS;
  if (screenshotDirectory !== undefined) {
    const output = resolve(screenshotDirectory);
    await mkdir(output, { recursive: true });
    for (const bodyId of BODY_IDS) {
      await page.evaluate((id) => globalThis.__gasGiantAnimationTest.renderBody(id, 3_600, 'full', true), bodyId);
      await writeFile(resolve(output, `${bodyId}.png`), await page.locator('canvas').screenshot());
    }
    await page.evaluate(() => globalThis.__gasGiantAnimationTest.renderSpot(9.9 * 3_600, true));
    await writeFile(resolve(output, 'jupiter-spot.png'), await page.locator('canvas').screenshot());
  }

  process.stdout.write(
    `${JSON.stringify({ programs: setup.programs, metrics, spot: { center: spotCenter, spotDelta, controlDelta }, textureRequests }, null, 2)}\n`,
  );
} finally {
  if (browser !== undefined) await browser.close();
  await server.close();
}
