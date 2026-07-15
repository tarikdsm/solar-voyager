import { ESLint } from 'eslint';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { test, expect } from 'vitest';

test.sequential('rejects an extensionless sim import from render', async () => {
  const projectRoot = process.cwd();
  const fixtureId = `${process.pid}-${Date.now()}`;
  const simFixture = join(projectRoot, 'src', 'sim', `boundary-${fixtureId}.ts`);
  const renderFixture = join(projectRoot, 'src', 'render', `boundary-${fixtureId}.ts`);

  try {
    await mkdir(join(projectRoot, 'src', 'sim'), { recursive: true });
    await mkdir(join(projectRoot, 'src', 'render'), { recursive: true });
    await writeFile(renderFixture, 'export const forbiddenValue = 1;\n');
    await writeFile(
      simFixture,
      `import { forbiddenValue } from '../render/boundary-${fixtureId}';\n\nexport const leakedValue = forbiddenValue;\n`,
    );

    const eslint = new ESLint({ cwd: projectRoot });
    const [result] = await eslint.lintFiles([simFixture]);

    expect(result?.messages.some(({ ruleId }) => ruleId === 'import/no-restricted-paths')).toBe(true);
  } finally {
    await Promise.all([
      rm(simFixture, { force: true }),
      rm(renderFixture, { force: true }),
    ]);
  }
}, 15_000);
