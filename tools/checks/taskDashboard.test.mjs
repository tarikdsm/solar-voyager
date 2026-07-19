import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { loadCanonicalTasks, renderDashboard } from './taskDashboard.mjs';

const START = '/* TASK_DATA_START */';
const END = '/* TASK_DATA_END */';

function task(id, overrides = {}) {
  return {
    id,
    title: `Task ${id}`,
    status: 'DONE',
    agent: 'chatgpt',
    branch: `task/${id}`,
    depends_on: [],
    milestone: 'M0',
    spec: `Implement ${id}.`,
    acceptance: [`${id} passes.`],
    handoff_notes: `${id} delivered.`,
    ...overrides,
  };
}

async function withTasks(files, run) {
  const root = await mkdtemp(join(tmpdir(), 'solar-voyager-dashboard-'));
  const directory = join(root, 'tasks');
  await mkdir(directory);
  try {
    for (const [name, value] of Object.entries(files)) {
      await writeFile(join(directory, name), typeof value === 'string' ? value : stringify(value));
    }
    return await run(directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('task dashboard', () => {
  it('loads canonical YAML tasks in stable id order and ignores non-task files', async () => {
    await withTasks(
      {
        'T0002-second.yaml': task('T0002', { depends_on: ['T0001'] }),
        'T0001-first.yaml': task('T0001'),
        '_template.yaml': 'not: canonical\n',
      },
      async (directory) => {
        const tasks = await loadCanonicalTasks(directory);
        expect(tasks.map(({ id }) => id)).toEqual(['T0001', 'T0002']);
        expect(tasks[1]?.depends_on).toEqual(['T0001']);
      },
    );
  });

  it('rejects malformed YAML and duplicate ids', async () => {
    await withTasks({ 'T0001-bad.yaml': 'id: [\n' }, async (directory) => {
      await expect(loadCanonicalTasks(directory)).rejects.toThrow(/T0001-bad\.yaml.*YAML/iu);
    });
    await withTasks(
      { 'T0001-first.yaml': task('T0001'), 'T0002-copy.yaml': task('T0001') },
      async (directory) => {
        await expect(loadCanonicalTasks(directory)).rejects.toThrow(/duplicate task id T0001/iu);
      },
    );
  });

  it('replaces only the marked payload and escapes script-closing content', () => {
    const source = `<main>keep</main>\n<script>\n${START}\nconst TASKS = [];\n${END}\nrun();\n</script>\n`;
    const output = renderDashboard(source, [task('T0001', { title: '</script><p>safe</p>' })]);

    expect(output).toContain('<main>keep</main>');
    expect(output).toContain('run();');
    expect(output).toContain('const TASKS = [');
    expect(output).toContain('\\u003c/script>');
    expect(output).not.toContain('</script><p>safe</p>');
    expect(renderDashboard(output, [task('T0001', { title: '</script><p>safe</p>' })])).toBe(
      output,
    );
  });

  it('rejects missing or repeated payload markers', () => {
    expect(() => renderDashboard('<script></script>', [])).toThrow(
      /exactly one task data marker/iu,
    );
    expect(() => renderDashboard(`${START}\n${END}\n${START}\n${END}`, [])).toThrow(
      /exactly one task data marker/iu,
    );
  });
});
