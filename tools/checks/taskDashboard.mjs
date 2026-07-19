import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseDocument } from 'yaml';

export const TASK_DATA_START = '/* TASK_DATA_START */';
export const TASK_DATA_END = '/* TASK_DATA_END */';

function isCanonicalTaskFile(name) {
  return /^T\d{4}-.+\.ya?ml$/u.test(name);
}

function countOccurrences(source, value) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += value.length;
  }
  return count;
}

/** Reads the complete canonical task payload used by the static dashboard. */
export async function loadCanonicalTasks(tasksDirectory) {
  const names = (await readdir(tasksDirectory)).filter(isCanonicalTaskFile).sort();
  const tasks = [];
  const ids = new Set();

  for (const name of names) {
    const source = await readFile(join(tasksDirectory, name), 'utf8');
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error(`${name}: YAML ${document.errors.map(({ message }) => message).join('; ')}`);
    }
    const task = document.toJS();
    if (task === null || typeof task !== 'object' || Array.isArray(task)) {
      throw new Error(`${name}: YAML root must be a mapping`);
    }
    if (typeof task.id !== 'string' || !/^T\d{4}$/u.test(task.id)) {
      throw new Error(`${name}: invalid task id`);
    }
    if (ids.has(task.id)) throw new Error(`${name}: duplicate task id ${task.id}`);
    ids.add(task.id);
    tasks.push(task);
  }

  return tasks.sort((left, right) => left.id.localeCompare(right.id));
}

/** Replaces the single generated payload while preserving the hand-authored shell. */
export function renderDashboard(source, tasks) {
  if (
    countOccurrences(source, TASK_DATA_START) !== 1 ||
    countOccurrences(source, TASK_DATA_END) !== 1
  ) {
    throw new Error('dashboard must contain exactly one task data marker pair');
  }
  const start = source.indexOf(TASK_DATA_START);
  const end = source.indexOf(TASK_DATA_END, start);
  if (end < start) throw new Error('dashboard task data markers are out of order');

  const json = JSON.stringify(tasks, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  const payload = `${TASK_DATA_START}\n    const TASKS = ${json};\n    ${TASK_DATA_END}`;
  return `${source.slice(0, start)}${payload}${source.slice(end + TASK_DATA_END.length)}`;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const write = arguments_.includes('--write');
  const unknown = arguments_.filter((value) => value !== '--write');
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown.join(' ')}`);

  const root = resolve(process.cwd());
  const dashboardPath = join(root, 'docs', 'check_plan.html');
  const tasks = await loadCanonicalTasks(join(root, 'tasks'));
  const source = await readFile(dashboardPath, 'utf8');
  const rendered = renderDashboard(source, tasks);
  if (write) {
    await writeFile(dashboardPath, rendered, 'utf8');
    process.stdout.write(`Generated dashboard for ${String(tasks.length)} tasks.\n`);
    return;
  }
  if (rendered !== source) {
    throw new Error('docs/check_plan.html is stale; run npm run generate:dashboard');
  }
  process.stdout.write(`Dashboard matches ${String(tasks.length)} canonical tasks.\n`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
