import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { renderDashboard } from './taskDashboard.mjs';
import { verifyReleaseReadiness } from './releaseReadiness.mjs';

const REQUIRED_DOCS = [
  'LICENSE',
  'docs/accessibility.md',
  'docs/controls.md',
  'docs/credits.md',
  'docs/privacy.md',
  'docs/release-notes.md',
];

function task(id, status) {
  return {
    id,
    title: `Task ${id}`,
    status,
    agent: status === 'TODO' || status === 'BLOCKED' ? '' : 'chatgpt',
    branch: status === 'TODO' || status === 'BLOCKED' ? '' : `task/${id}`,
    depends_on: [],
    milestone: 'M6',
    spec: `Implement ${id}.`,
    acceptance: [`${id} passes.`],
    handoff_notes: '',
  };
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'solar-voyager-release-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'tasks'));
  await writeFile(join(root, 'package.json'), '{"version":"1.0.0"}\n');
  for (const file of REQUIRED_DOCS) await writeFile(join(root, file), `# ${file}\n`);
  await writeFile(
    join(root, 'README.md'),
    REQUIRED_DOCS.map((file) => `[${file}](${file})`).join('\n'),
  );
  const tasks = [
    task('T0001', 'DONE'),
    task('T0060', 'BLOCKED'),
    task('T0061', 'BLOCKED'),
    task('T0062', 'BLOCKED'),
    task('T0101', 'IN_PROGRESS'),
  ];
  for (const value of tasks) {
    await writeFile(join(root, 'tasks', `${value.id}-task.yaml`), stringify(value));
  }
  const shell =
    '<script>\n/* TASK_DATA_START */\nconst TASKS = [];\n/* TASK_DATA_END */\n</script>\n';
  await writeFile(join(root, 'docs', 'check_plan.html'), renderDashboard(shell, tasks));
  return root;
}

describe('release readiness', () => {
  it('accepts the release branch state and requires T0101 DONE in final mode', async () => {
    const root = await createRepository();
    try {
      await expect(verifyReleaseReadiness(root)).resolves.toEqual([]);
      await expect(verifyReleaseReadiness(root, { final: true })).resolves.toContain(
        'T0101 must be DONE for final release; found IN_PROGRESS',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports version, document, local-link, dashboard and task-state drift together', async () => {
    const root = await createRepository();
    try {
      await writeFile(join(root, 'package.json'), '{"version":"0.0.0"}\n');
      await rm(join(root, 'docs', 'privacy.md'));
      await writeFile(join(root, 'README.md'), '[Missing](docs/missing.md)\n');
      await writeFile(join(root, 'docs', 'check_plan.html'), '<script>stale</script>\n');
      await writeFile(join(root, 'tasks', 'T0001-task.yaml'), stringify(task('T0001', 'REVIEW')));

      const findings = await verifyReleaseReadiness(root);
      expect(findings).toContain('package version must be 1.0.0; found 0.0.0');
      expect(findings).toContain('missing required file: docs/privacy.md');
      expect(findings).toContain('README.md has an unresolved local link: docs/missing.md');
      expect(findings.some((finding) => finding.startsWith('dashboard: '))).toBe(true);
      expect(findings).toContain('T0001 must be DONE; found REVIEW');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows only T0060-T0062 to remain BLOCKED', async () => {
    const root = await createRepository();
    try {
      await writeFile(join(root, 'tasks', 'T0001-task.yaml'), stringify(task('T0001', 'BLOCKED')));
      const findings = await verifyReleaseReadiness(root);
      expect(findings).toContain('T0001 must be DONE; found BLOCKED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a required release-boundary task is absent', async () => {
    const root = await createRepository();
    try {
      await rm(join(root, 'tasks', 'T0062-task.yaml'));
      const findings = await verifyReleaseReadiness(root);
      expect(findings).toContain('missing canonical release task: T0062');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
