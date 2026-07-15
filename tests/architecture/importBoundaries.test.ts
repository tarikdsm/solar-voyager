import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

import { APP_TITLE } from '../../src/core/appInfo.js';
import { createScaffoldState } from '../../src/game/createScaffoldState.js';
import type { ScaffoldState } from '../../src/sim/scaffoldState.js';

describe('scaffold state boundaries', () => {
  test('exports the exact application title', () => {
    expect(APP_TITLE).toBe('Solar Voyager');
  });

  test('creates state from lower-layer values', () => {
    const state: ScaffoldState = createScaffoldState();

    expect(state).toEqual({ title: APP_TITLE });
  });
});

test('rejects an extensionless sim import from render', async () => {
  const projectRoot = process.cwd();
  const fixtureId = `${process.pid}-${Date.now()}`;
  const renderDirectory = join(projectRoot, 'src', 'render');
  const renderFixture = join(renderDirectory, `boundary-${fixtureId}.ts`);
  const virtualSimFixture = join(projectRoot, 'src', 'sim', `boundary-${fixtureId}.ts`);
  let ownsRenderDirectory = false;

  try {
    try {
      await mkdir(renderDirectory);
      ownsRenderDirectory = true;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }
    }

    await writeFile(renderFixture, 'export const renderOnlyValue = 1;\n');

    const eslint = new ESLint({ cwd: projectRoot });
    const invalidSimSource = [
      `import { renderOnlyValue } from '../render/boundary-${fixtureId}';`,
      '',
      'export const leakedValue = renderOnlyValue;',
    ].join('\n');
    const [result] = await eslint.lintText(invalidSimSource, {
      filePath: virtualSimFixture,
    });

    expect(result?.messages.map(({ ruleId }) => ruleId)).toContain('import/no-restricted-paths');
  } finally {
    await rm(renderFixture, { force: true });
    if (ownsRenderDirectory) {
      await rm(renderDirectory);
    }
  }
}, 15_000);
