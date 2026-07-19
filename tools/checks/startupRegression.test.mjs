import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STARTUP_REGRESSION_PATH = fileURLToPath(
  new URL('../tests/startupRegression.mjs', import.meta.url),
);
const BOUNDED_STAR_CAPTURE =
  /const starLoadingResult = await withTimeout\(\s*starLoading,\s*'star loading snapshot',?\s*\);/su;

describe('startup browser regression liveness', () => {
  it('bounds the intercepted star snapshot, always continues its route and reports phases', async () => {
    const source = await readFile(STARTUP_REGRESSION_PATH, 'utf8');

    expect(source).not.toContain('const starSeen = new Promise');
    expect(source).not.toContain('const starRelease = new Promise');
    expect(source).not.toContain('releaseStar');
    expect(source).toMatch(BOUNDED_STAR_CAPTURE);
    expect(source).toContain("const PLAYWRIGHT_OPERATION_TIMEOUT_MS = 30_000;");
    expect(source).toContain('finally {\n      await route.continue();\n    }');
    expect(source.match(/reportPhase\('/gu)).toHaveLength(5);
    expect(source.match(/reportColdLoadCheckpoint\('/gu)).toHaveLength(5);

    const boundedCapture = source.match(BOUNDED_STAR_CAPTURE)?.[0];
    expect(boundedCapture).toBeDefined();
    const unboundedMutation = boundedCapture.replace(
      'await withTimeout(',
      'await Promise.resolve(',
    );
    expect(unboundedMutation).not.toMatch(BOUNDED_STAR_CAPTURE);
  });
});
