import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { loadCanonicalTasks, renderDashboard } from './taskDashboard.mjs';
import { verifyReleaseReadiness } from './releaseReadiness.mjs';

const REQUIRED_DOCS = [
  'LICENSE',
  'public/THIRD_PARTY_LICENSES.txt',
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

const V1_RELEASED_TASK_IDS = ['T0001', 'T0060', 'T0061', 'T0062', 'T0101'];

/** Mirrors `npm run generate:dashboard`: regenerates the dashboard for the tasks on disk. */
async function regenerateDashboard(root) {
  const dashboardPath = join(root, 'docs', 'check_plan.html');
  const tasks = await loadCanonicalTasks(join(root, 'tasks'));
  const current = await readFile(dashboardPath, 'utf8');
  await writeFile(dashboardPath, renderDashboard(current, tasks));
}

async function writeReleaseManifest(root, releases) {
  const manifest = { schemaVersion: 1 };
  for (const [release, taskIds] of Object.entries(releases)) {
    manifest[release] = { description: `${release} fixture scope.`, taskIds };
  }
  await writeFile(
    join(root, 'tools', 'checks', 'releaseManifest.json'),
    JSON.stringify(manifest, null, 2),
  );
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'solar-voyager-release-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'public'), { recursive: true });
  await mkdir(join(root, 'tasks'));
  await mkdir(join(root, 'tools', 'checks'), { recursive: true });
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
  await writeReleaseManifest(root, { v1: V1_RELEASED_TASK_IDS });
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

describe('release-scoped manifest (ADR-033)', () => {
  it('exempts a task outside the v1 release manifest from the DONE requirement', async () => {
    const root = await createRepository();
    try {
      await writeFile(
        join(root, 'tasks', 'T9999-scratch.yaml'),
        stringify(task('T9999', 'TODO')),
      );
      await regenerateDashboard(root);

      const findings = await verifyReleaseReadiness(root);

      expect(findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps exempt tasks out of --final findings too (final only tightens T0101)', async () => {
    const root = await createRepository();
    try {
      await writeFile(join(root, 'tasks', 'T0101-task.yaml'), stringify(task('T0101', 'DONE')));
      await writeFile(
        join(root, 'tasks', 'T9999-scratch.yaml'),
        stringify(task('T9999', 'CLAIMED')),
      );
      await regenerateDashboard(root);

      const findings = await verifyReleaseReadiness(root, { final: true });

      expect(findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still requires v1-scoped tasks to be DONE alongside an exempt task', async () => {
    const root = await createRepository();
    try {
      await writeFile(join(root, 'tasks', 'T0001-task.yaml'), stringify(task('T0001', 'REVIEW')));
      await writeFile(
        join(root, 'tasks', 'T9999-scratch.yaml'),
        stringify(task('T9999', 'TODO')),
      );
      await regenerateDashboard(root);

      const findings = await verifyReleaseReadiness(root);

      expect(findings).toContain('T0001 must be DONE; found REVIEW');
      expect(findings).not.toContain('T9999 must be DONE; found TODO');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the requested release scope is not defined in the manifest', async () => {
    const root = await createRepository();
    try {
      const findings = await verifyReleaseReadiness(root, { release: 'v2' });

      expect(
        findings.some(
          (finding) =>
            finding.startsWith('release manifest: ') && finding.includes('"v2"'),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the release manifest is malformed', async () => {
    const root = await createRepository();
    try {
      await writeFile(join(root, 'tools', 'checks', 'releaseManifest.json'), '{ not json');

      const findings = await verifyReleaseReadiness(root);

      expect(findings.some((finding) => finding.startsWith('release manifest: '))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('--release=v2 holds v2-scoped tasks to the DONE rule while v1 keeps exempting them', async () => {
    const root = await createRepository();
    try {
      await writeFile(
        join(root, 'tasks', 'T0102-task.yaml'),
        stringify(task('T0102', 'TODO')),
      );
      await regenerateDashboard(root);
      await writeReleaseManifest(root, {
        v1: V1_RELEASED_TASK_IDS,
        v2: [...V1_RELEASED_TASK_IDS, 'T0102'],
      });

      const v1Findings = await verifyReleaseReadiness(root, { release: 'v1' });
      const defaultFindings = await verifyReleaseReadiness(root);
      const v2Findings = await verifyReleaseReadiness(root, { release: 'v2' });

      expect(v1Findings.some((finding) => finding.startsWith('T0102 '))).toBe(false);
      expect(defaultFindings.some((finding) => finding.startsWith('T0102 '))).toBe(false);
      expect(v2Findings).toContain('T0102 must be DONE; found TODO');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('v2 scope still enforces the permanent T0060-T0062 and T0101 invariants', async () => {
    const root = await createRepository();
    try {
      await writeFile(join(root, 'tasks', 'T0060-task.yaml'), stringify(task('T0060', 'DONE')));
      await regenerateDashboard(root);
      await writeReleaseManifest(root, {
        v1: V1_RELEASED_TASK_IDS,
        v2: V1_RELEASED_TASK_IDS,
      });

      const findings = await verifyReleaseReadiness(root, { release: 'v2' });

      expect(findings).toContain(
        'T0060 must remain BLOCKED for the deferred v1 scope; found DONE',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
