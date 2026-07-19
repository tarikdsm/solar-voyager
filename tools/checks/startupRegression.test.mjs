import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STARTUP_REGRESSION_PATH = fileURLToPath(
  new URL('../tests/startupRegression.mjs', import.meta.url),
);

describe('startup browser regression liveness', () => {
  it('bounds the intercepted star request and reports each serial phase', async () => {
    const source = await readFile(STARTUP_REGRESSION_PATH, 'utf8');

    expect(source).not.toContain('const starSeen = new Promise');
    expect(source).toContain("const starSeen = page.waitForRequest(");
    expect(source).toContain('{ timeout: 30_000 }');
    expect(source.match(/reportPhase\('/gu)).toHaveLength(5);
  });
});
