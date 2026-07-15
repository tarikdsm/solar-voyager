import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { validateTaskDirectory } from './taskSchema.mjs';

const CHECKER_PATH = fileURLToPath(new URL('./taskSchema.mjs', import.meta.url));

function makeTask(overrides = {}) {
  return {
    id: 'T0001',
    title: 'First task',
    status: 'TODO',
    agent: '',
    branch: '',
    depends_on: [],
    milestone: 'M0',
    spec: 'Build the first task.',
    acceptance: ['The first task passes.'],
    handoff_notes: '',
    ...overrides,
  };
}

async function withTaskDirectory(files, run) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'solar-voyager-tasks-'));
  const tasksDirectory = join(rootDirectory, 'tasks');

  try {
    await mkdir(tasksDirectory);

    for (const [fileName, value] of Object.entries(files)) {
      const source = typeof value === 'string' ? value : stringify(value);
      await writeFile(join(tasksDirectory, fileName), source, 'utf8');
    }

    return await run({ rootDirectory, tasksDirectory });
  } finally {
    await rm(rootDirectory, { force: true, recursive: true });
  }
}

describe('validateTaskDirectory', () => {
  it('accepts a valid queue and ignores templates and non-task files', async () => {
    await withTaskDirectory(
      {
        'T0001-first.yaml': makeTask({
          status: 'DONE',
          agent: 'chatgpt',
          branch: 'task/T0001-first',
        }),
        'T0002-second.yaml': makeTask({
          id: 'T0002',
          title: 'Second task',
          status: 'BLOCKED',
          agent: 'chatgpt',
          branch: 'task/T0002-second',
          depends_on: ['T0001'],
        }),
        '_template.yaml': 'not: a task\n',
        'notes.yaml': 'not: a task\n',
        'README.md': 'not a task\n',
      },
      async ({ tasksDirectory }) => {
        await expect(validateTaskDirectory(tasksDirectory)).resolves.toEqual({
          taskCount: 2,
          findings: [],
        });
      },
    );
  });

  it('reports a missing field', async () => {
    const task = makeTask();
    delete task.title;

    await withTaskDirectory({ 'T0001-first.yaml': task }, async ({ tasksDirectory }) => {
      const result = await validateTaskDirectory(tasksDirectory);
      expect(result.findings).toContain('T0001-first.yaml: missing field "title"');
    });
  });

  it('reports an extra field', async () => {
    const task = makeTask({ unexpected: true });

    await withTaskDirectory({ 'T0001-first.yaml': task }, async ({ tasksDirectory }) => {
      const result = await validateTaskDirectory(tasksDirectory);
      expect(result.findings).toContain('T0001-first.yaml: unexpected field "unexpected"');
    });
  });

  it.each([
    ['id', 1],
    ['title', 1],
    ['status', 1],
    ['agent', 1],
    ['branch', 1],
    ['depends_on', 'T0002'],
    ['depends_on', [1]],
    ['milestone', 1],
    ['spec', []],
    ['acceptance', 'passes'],
    ['handoff_notes', 1],
  ])('reports the wrong type for %s', async (field, value) => {
    const task = makeTask({ [field]: value });

    await withTaskDirectory({ 'T0001-first.yaml': task }, async ({ tasksDirectory }) => {
      const result = await validateTaskDirectory(tasksDirectory);
      expect(result.findings.some((finding) => finding.includes(`field "${field}"`))).toBe(true);
    });
  });

  it('accepts acceptance as a list without constraining its entry shape', async () => {
    const task = makeTask({ acceptance: [{ 'Synthetic load': 'recovers within three rungs' }] });

    await withTaskDirectory({ 'T0001-first.yaml': task }, async ({ tasksDirectory }) => {
      const result = await validateTaskDirectory(tasksDirectory);
      expect(result.findings).toEqual([]);
    });
  });

  it('reports an invalid task id and status', async () => {
    const task = makeTask({ id: 'T1', status: 'WAITING' });

    await withTaskDirectory({ 'T0001-first.yaml': task }, async ({ tasksDirectory }) => {
      const result = await validateTaskDirectory(tasksDirectory);
      expect(result.findings).toContain('T0001-first.yaml: field "id" must match T####');
      expect(result.findings).toContain('T0001-first.yaml: invalid status "WAITING"');
    });
  });

  it('reports a filename and id mismatch', async () => {
    await withTaskDirectory(
      { 'T0002-second.yaml': makeTask() },
      async ({ tasksDirectory }) => {
        const result = await validateTaskDirectory(tasksDirectory);
        expect(result.findings).toContain(
          'T0002-second.yaml: filename id "T0002" does not match task id "T0001"',
        );
      },
    );
  });

  it('reports a duplicate id', async () => {
    await withTaskDirectory(
      {
        'T0001-first.yaml': makeTask(),
        'T0002-second.yaml': makeTask(),
      },
      async ({ tasksDirectory }) => {
        const result = await validateTaskDirectory(tasksDirectory);
        expect(result.findings).toContain(
          'T0002-second.yaml: duplicate id "T0001" also used by T0001-first.yaml',
        );
      },
    );
  });

  it('reports unknown and self dependencies', async () => {
    await withTaskDirectory(
      {
        'T0001-first.yaml': makeTask({ depends_on: ['T0001', 'T9999'] }),
      },
      async ({ tasksDirectory }) => {
        const result = await validateTaskDirectory(tasksDirectory);
        expect(result.findings).toContain('T0001-first.yaml: task "T0001" depends on itself');
        expect(result.findings).toContain(
          'T0001-first.yaml: unknown dependency "T9999" referenced by "T0001"',
        );
      },
    );
  });

  it('reports a multi-node dependency cycle', async () => {
    await withTaskDirectory(
      {
        'T0001-first.yaml': makeTask({ depends_on: ['T0002'] }),
        'T0002-second.yaml': makeTask({ id: 'T0002', depends_on: ['T0003'] }),
        'T0003-third.yaml': makeTask({ id: 'T0003', depends_on: ['T0001'] }),
      },
      async ({ tasksDirectory }) => {
        const result = await validateTaskDirectory(tasksDirectory);
        expect(result.findings).toContain('dependency cycle: T0001 -> T0002 -> T0003 -> T0001');
      },
    );
  });

  it.each([
    ['invalid syntax', 'id: [\n'],
    ['duplicate mapping key', 'id: T0001\nid: T0001\n'],
  ])('reports YAML %s before conversion', async (_description, source) => {
    await withTaskDirectory({ 'T0001-first.yaml': source }, async ({ tasksDirectory }) => {
      const result = await validateTaskDirectory(tasksDirectory);
      expect(result.findings.some((finding) => finding.startsWith('T0001-first.yaml: YAML '))).toBe(
        true,
      );
    });
  });

  it('enforces empty ownership for TODO tasks', async () => {
    const task = makeTask({ agent: 'chatgpt', branch: 'task/T0001-first' });

    await withTaskDirectory({ 'T0001-first.yaml': task }, async ({ tasksDirectory }) => {
      const result = await validateTaskDirectory(tasksDirectory);
      expect(result.findings).toContain(
        'T0001-first.yaml: TODO tasks must have empty agent and branch',
      );
    });
  });

  it.each(['CLAIMED', 'IN_PROGRESS', 'REVIEW'])(
    'requires ownership for %s tasks',
    async (status) => {
      await withTaskDirectory(
        { 'T0001-first.yaml': makeTask({ status }) },
        async ({ tasksDirectory }) => {
          const result = await validateTaskDirectory(tasksDirectory);
          expect(result.findings).toContain(
            `T0001-first.yaml: ${status} tasks require nonempty agent and branch`,
          );
        },
      );
    },
  );
});

describe('task schema CLI', () => {
  it('defaults to tasks, ignores non-task files, and prints the validated count', async () => {
    await withTaskDirectory(
      {
        'T0001-first.yaml': makeTask(),
        '_template.yaml': 'not: a task\n',
        'notes.yaml': 'not: a task\n',
      },
      async ({ rootDirectory }) => {
        const result = spawnSync(process.execPath, [CHECKER_PATH], {
          cwd: rootDirectory,
          encoding: 'utf8',
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Validated 1 task file.');
        expect(result.stderr).toBe('');
      },
    );
  });

  it('exits one and prints all findings', async () => {
    const missingTitle = makeTask();
    delete missingTitle.title;

    await withTaskDirectory(
      {
        'T0001-first.yaml': missingTitle,
        'T0002-second.yaml': makeTask({ id: 'T0002', status: 'WAITING' }),
      },
      async ({ tasksDirectory }) => {
        const result = spawnSync(process.execPath, [CHECKER_PATH, tasksDirectory], {
          encoding: 'utf8',
        });

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('Validated 2 task files.');
        expect(result.stderr).toContain('T0001-first.yaml: missing field "title"');
        expect(result.stderr).toContain('T0002-second.yaml: invalid status "WAITING"');
      },
    );
  });
});
