import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { expect, test } from 'vitest';

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !/^boundary-\d+-\d+\.ts$/.test(entry.name)
    ) {
      result.push(path);
    }
  }
  return result;
}

test('keeps the explicit physics-position float32 bridge in spaceScene.ts only', async () => {
  const matches: string[] = [];
  for (const path of await sourceFiles(join(process.cwd(), 'src'))) {
    if ((await readFile(path, 'utf8')).includes('Math.fround(')) {
      matches.push(relative(process.cwd(), path).replaceAll('\\', '/'));
    }
  }

  expect(matches).toEqual(['src/render/spaceScene.ts']);
});
