import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STARTUP_REGRESSION_PATH = fileURLToPath(
  new URL('../tests/startupRegression.mjs', import.meta.url),
);
const BOUNDED_STAR_WAIT =
  /const starSeen = page\.waitForRequest\(\s*\(request\) => criticalFileFor\(request\.url\(\)\) === 'data\/stars\.bin',\s*\{ timeout: 30_000 \},\s*\);/su;

describe('startup browser regression liveness', () => {
  it('bounds the intercepted star request and reports each serial phase', async () => {
    const source = await readFile(STARTUP_REGRESSION_PATH, 'utf8');

    expect(source).not.toContain('const starSeen = new Promise');
    expect(source).toMatch(BOUNDED_STAR_WAIT);
    expect(source.match(/reportPhase\('/gu)).toHaveLength(5);

    const boundedStarWait = source.match(BOUNDED_STAR_WAIT)?.[0];
    expect(boundedStarWait).toBeDefined();
    const unboundedMutation = boundedStarWait.replace('{ timeout: 30_000 },', 'undefined,');
    expect(unboundedMutation).not.toMatch(BOUNDED_STAR_WAIT);
  });
});
