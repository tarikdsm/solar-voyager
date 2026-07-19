import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadCanonicalTasks, renderDashboard } from './taskDashboard.mjs';

const REQUIRED_FILES = [
  'LICENSE',
  'public/THIRD_PARTY_LICENSES.txt',
  'docs/accessibility.md',
  'docs/controls.md',
  'docs/credits.md',
  'docs/privacy.md',
  'docs/release-notes.md',
];
const DEFERRED_TASKS = new Set(['T0060', 'T0061', 'T0062']);
const REQUIRED_RELEASE_TASKS = [...DEFERRED_TASKS, 'T0101'];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function localMarkdownLinks(source) {
  const links = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of source.matchAll(pattern)) {
    let target = match[1]?.trim() ?? '';
    if (target.startsWith('<') && target.includes('>'))
      target = target.slice(1, target.indexOf('>'));
    else target = target.split(/\s+["']/u, 1)[0] ?? '';
    if (target === '' || target.startsWith('#') || /^[a-z][a-z\d+.-]*:/iu.test(target)) continue;
    links.push(target.split(/[?#]/u, 1)[0] ?? target);
  }
  return links;
}

function isInside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Returns every release finding so CI can report all actionable drift at once. */
export async function verifyReleaseReadiness(repositoryRoot, { final = false } = {}) {
  const root = resolve(repositoryRoot);
  const findings = [];

  try {
    const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (packageMetadata.version !== '1.0.0') {
      findings.push(`package version must be 1.0.0; found ${String(packageMetadata.version)}`);
    }
  } catch (error) {
    findings.push(`package metadata: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const file of REQUIRED_FILES) {
    if (!(await exists(join(root, file)))) findings.push(`missing required file: ${file}`);
  }

  try {
    const readmePath = join(root, 'README.md');
    const readme = await readFile(readmePath, 'utf8');
    for (const link of localMarkdownLinks(readme)) {
      const decoded = decodeURIComponent(link);
      const target = resolve(dirname(readmePath), decoded);
      if (!isInside(root, target) || !(await exists(target))) {
        findings.push(`README.md has an unresolved local link: ${link}`);
      }
    }
  } catch (error) {
    findings.push(`README.md: ${error instanceof Error ? error.message : String(error)}`);
  }

  let tasks = [];
  try {
    tasks = await loadCanonicalTasks(join(root, 'tasks'));
    const taskIds = new Set(tasks.map(({ id }) => id));
    for (const id of REQUIRED_RELEASE_TASKS) {
      if (!taskIds.has(id)) findings.push(`missing canonical release task: ${id}`);
    }
    for (const task of tasks) {
      if (DEFERRED_TASKS.has(task.id)) {
        if (task.status !== 'BLOCKED') {
          findings.push(
            `${task.id} must remain BLOCKED for the deferred v1 scope; found ${String(task.status)}`,
          );
        }
      } else if (task.id === 'T0101') {
        const allowed = final ? ['DONE'] : ['IN_PROGRESS', 'REVIEW', 'DONE'];
        if (!allowed.includes(task.status)) {
          findings.push(
            `T0101 must be ${final ? 'DONE for final release' : 'IN_PROGRESS, REVIEW, or DONE'}; found ${String(task.status)}`,
          );
        }
      } else if (task.status !== 'DONE') {
        findings.push(`${task.id} must be DONE; found ${String(task.status)}`);
      }
    }
  } catch (error) {
    findings.push(`tasks: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const dashboardPath = join(root, 'docs', 'check_plan.html');
    const dashboard = await readFile(dashboardPath, 'utf8');
    if (renderDashboard(dashboard, tasks) !== dashboard) {
      findings.push('dashboard: docs/check_plan.html does not match canonical tasks');
    }
  } catch (error) {
    findings.push(`dashboard: ${error instanceof Error ? error.message : String(error)}`);
  }

  return findings;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const final = arguments_.includes('--final');
  const unknown = arguments_.filter((value) => value !== '--final');
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown.join(' ')}`);
  const findings = await verifyReleaseReadiness(process.cwd(), { final });
  if (findings.length > 0) throw new Error(findings.join('\n'));
  process.stdout.write(`Release readiness passed${final ? ' in final mode' : ''}.\n`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
