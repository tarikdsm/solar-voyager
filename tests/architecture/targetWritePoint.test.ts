import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { expect, test } from 'vitest';

/**
 * One write point for the navigation target (T0117, spec §7).
 *
 * The acceptance criterion is that the world click, the system-map click, the
 * map `<select>` and the target panel `<select>` all converge on
 * `Commands.setTarget` — one write point, not four. Before T0117 they merely
 * happened to call the same composition-root facade, each with its own
 * hand-rolled catalog check; nothing stopped a fifth caller from skipping it.
 *
 * This is a source scan for the same reason `tests/render/float32Boundary.test.ts`
 * is one: the property is "no other file does this", which no unit test of an
 * existing file can express.
 */
async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) result.push(path);
  }
  return result;
}

test('routes every navigation-target write through TargetSelectionController', async () => {
  const matches: string[] = [];
  for (const path of await sourceFiles(join(process.cwd(), 'src'))) {
    if (/\.setTarget\(/.test(await readFile(path, 'utf8'))) {
      matches.push(relative(process.cwd(), path).replaceAll('\\', '/'));
    }
  }

  // `game/targetSelection.ts` is the only caller. `bootstrap/composition.ts` is
  // the `Commands` facade it writes *to*: it forwards into the live
  // `SimulationCore` and adds the side effects a target change owes (observatory
  // camera, map focus, trajectory invalidation). Any other file appearing here
  // is a second write point — route it through the controller instead.
  expect(matches.sort()).toEqual(['src/bootstrap/composition.ts', 'src/game/targetSelection.ts']);
});
