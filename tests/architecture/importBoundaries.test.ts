import { ESLint } from 'eslint';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { test, expect } from 'vitest';

test.sequential('rejects an extensionless sim import from render', async () => {
  const projectRoot = process.cwd();
  const fixtureId = `${process.pid}-${Date.now()}`;
  const renderDirectory = join(projectRoot, 'src', 'render');
  const virtualSimFixture = join(projectRoot, 'src', 'sim', `boundary-${fixtureId}.ts`);
  const renderFixture = join(projectRoot, 'src', 'render', `boundary-${fixtureId}.ts`);
  let createdRenderDirectory = false;

  try {
    createdRenderDirectory = (await mkdir(renderDirectory, { recursive: true })) !== undefined;
    await writeFile(renderFixture, 'export const forbiddenValue = 1;\n');
    const invalidSimSource = `import { forbiddenValue } from '../render/boundary-${fixtureId}';\n\nexport const leakedValue = forbiddenValue;\n`;

    const eslint = new ESLint({
      cwd: projectRoot,
      overrideConfig: {
        languageOptions: {
          parserOptions: {
            projectService: {
              allowDefaultProject: ['src/sim/boundary-*.ts'],
            },
          },
        },
      },
    });
    const [result] = await eslint.lintText(invalidSimSource, { filePath: virtualSimFixture });

    expect(
      result?.messages.some(({ ruleId }) => ruleId === 'import/no-restricted-paths'),
      JSON.stringify(result?.messages),
    ).toBe(true);
  } finally {
    await rm(renderFixture, { force: true });
    if (createdRenderDirectory) {
      await rm(renderDirectory);
    }
  }
}, 15_000);
