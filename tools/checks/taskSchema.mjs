import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseDocument } from 'yaml';

const EXPECTED_FIELDS = [
  'id',
  'title',
  'status',
  'agent',
  'branch',
  'depends_on',
  'milestone',
  'spec',
  'acceptance',
  'handoff_notes',
];
const EXPECTED_FIELD_SET = new Set(EXPECTED_FIELDS);
const VALID_STATUSES = new Set([
  'TODO',
  'CLAIMED',
  'IN_PROGRESS',
  'REVIEW',
  'DONE',
  'BLOCKED',
]);
const OWNED_STATUSES = new Set(['CLAIMED', 'IN_PROGRESS', 'REVIEW']);
const TASK_ID_PATTERN = /^T\d{4}$/;
const TASK_FILE_PATTERN = /^(T\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record, field) {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function validateStringField(record, field, fileName, findings) {
  if (hasOwn(record, field) && typeof record[field] !== 'string') {
    findings.push(`${fileName}: field "${field}" must be a string`);
  }
}

function validateStringListField(record, field, fileName, findings) {
  if (
    hasOwn(record, field) &&
    (!Array.isArray(record[field]) || record[field].some((value) => typeof value !== 'string'))
  ) {
    findings.push(`${fileName}: field "${field}" must be a list of strings`);
  }
}

function validateListField(record, field, fileName, findings) {
  if (hasOwn(record, field) && !Array.isArray(record[field])) {
    findings.push(`${fileName}: field "${field}" must be a list`);
  }
}

function validateExactFields(record, fileName, findings) {
  for (const field of EXPECTED_FIELDS) {
    if (!hasOwn(record, field)) {
      findings.push(`${fileName}: missing field "${field}"`);
    }
  }

  for (const field of Object.keys(record)) {
    if (!EXPECTED_FIELD_SET.has(field)) {
      findings.push(`${fileName}: unexpected field "${field}"`);
    }
  }
}

function validateFieldTypes(record, fileName, findings) {
  for (const field of [
    'id',
    'title',
    'status',
    'agent',
    'branch',
    'milestone',
    'spec',
    'handoff_notes',
  ]) {
    validateStringField(record, field, fileName, findings);
  }

  validateStringListField(record, 'depends_on', fileName, findings);
  validateListField(record, 'acceptance', fileName, findings);
}

function validateIdAndStatus(record, fileName, findings) {
  if (typeof record.id === 'string' && !TASK_ID_PATTERN.test(record.id)) {
    findings.push(`${fileName}: field "id" must match T####`);
  }

  if (typeof record.status === 'string' && !VALID_STATUSES.has(record.status)) {
    findings.push(`${fileName}: invalid status "${record.status}"`);
  }
}

function validateOwnership(record, fileName, findings) {
  if (
    typeof record.status !== 'string' ||
    typeof record.agent !== 'string' ||
    typeof record.branch !== 'string'
  ) {
    return;
  }

  if (record.status === 'TODO' && (record.agent !== '' || record.branch !== '')) {
    findings.push(`${fileName}: TODO tasks must have empty agent and branch`);
  }

  if (OWNED_STATUSES.has(record.status) && (record.agent === '' || record.branch === '')) {
    findings.push(`${fileName}: ${record.status} tasks require nonempty agent and branch`);
  }
}

function validateFileName(record, fileName, findings) {
  const match = TASK_FILE_PATTERN.exec(fileName);

  if (match === null) {
    findings.push(`${fileName}: filename must match T####-slug.yaml`);
    return;
  }

  const fileId = match[1];
  if (typeof record.id === 'string' && fileId !== record.id) {
    findings.push(`${fileName}: filename id "${fileId}" does not match task id "${record.id}"`);
  }
}

function validateTaskRecord(record, fileName, findings) {
  validateExactFields(record, fileName, findings);
  validateFieldTypes(record, fileName, findings);
  validateIdAndStatus(record, fileName, findings);
  validateOwnership(record, fileName, findings);
  validateFileName(record, fileName, findings);
}

async function readTaskRecord(tasksDirectory, fileName, findings) {
  const source = await readFile(resolve(tasksDirectory, fileName), 'utf8');
  const document = parseDocument(source, {
    uniqueKeys: true,
    prettyErrors: true,
    strict: true,
  });

  if (document.errors.length > 0) {
    for (const error of document.errors) {
      findings.push(`${fileName}: YAML ${error.message}`);
    }
    return null;
  }

  const value = document.toJS();
  if (!isRecord(value)) {
    findings.push(`${fileName}: task document must be a mapping`);
    return null;
  }

  validateTaskRecord(value, fileName, findings);
  return { fileName, value };
}

function validateDuplicates(tasks, findings) {
  const firstFileById = new Map();

  for (const task of tasks) {
    const { id } = task.value;
    if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) {
      continue;
    }

    const firstFile = firstFileById.get(id);
    if (firstFile === undefined) {
      firstFileById.set(id, task.fileName);
    } else {
      findings.push(`${task.fileName}: duplicate id "${id}" also used by ${firstFile}`);
    }
  }
}

function buildTaskGraph(tasks, findings) {
  const knownIds = new Set();
  const graph = new Map();

  for (const task of tasks) {
    const { id } = task.value;
    if (typeof id === 'string' && TASK_ID_PATTERN.test(id)) {
      knownIds.add(id);
    }
  }

  for (const task of tasks) {
    const { id, depends_on: dependencies } = task.value;
    if (
      typeof id !== 'string' ||
      !TASK_ID_PATTERN.test(id) ||
      !Array.isArray(dependencies) ||
      dependencies.some((dependency) => typeof dependency !== 'string')
    ) {
      continue;
    }

    if (!graph.has(id)) {
      graph.set(id, dependencies);
    }

    for (const dependency of dependencies) {
      if (dependency === id) {
        findings.push(`${task.fileName}: task "${id}" depends on itself`);
      } else if (!knownIds.has(dependency)) {
        findings.push(`${task.fileName}: unknown dependency "${dependency}" referenced by "${id}"`);
      }
    }
  }

  return graph;
}

function validateCycles(graph, findings) {
  const states = new Map();
  const path = [];
  const reportedCycles = new Set();

  function visit(taskId) {
    states.set(taskId, 'visiting');
    path.push(taskId);

    for (const dependency of graph.get(taskId) ?? []) {
      if (dependency === taskId || !graph.has(dependency)) {
        continue;
      }

      const dependencyState = states.get(dependency);
      if (dependencyState === undefined) {
        visit(dependency);
      } else if (dependencyState === 'visiting') {
        const cycleStart = path.indexOf(dependency);
        const cycle = [...path.slice(cycleStart), dependency];
        const cycleKey = cycle.slice(0, -1).toSorted().join('|');

        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          findings.push(`dependency cycle: ${cycle.join(' -> ')}`);
        }
      }
    }

    path.pop();
    states.set(taskId, 'visited');
  }

  for (const taskId of [...graph.keys()].toSorted()) {
    if (states.get(taskId) === undefined) {
      visit(taskId);
    }
  }
}

export async function validateTaskDirectory(tasksDirectory) {
  const entries = await readdir(tasksDirectory, { withFileTypes: true });
  const taskFileNames = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('T') && entry.name.endsWith('.yaml'))
    .map((entry) => entry.name)
    .toSorted();
  const findings = [];
  const tasks = [];

  for (const fileName of taskFileNames) {
    const task = await readTaskRecord(tasksDirectory, fileName, findings);
    if (task !== null) {
      tasks.push(task);
    }
  }

  validateDuplicates(tasks, findings);
  const graph = buildTaskGraph(tasks, findings);
  validateCycles(graph, findings);

  return { taskCount: taskFileNames.length, findings };
}

async function runCli() {
  const tasksDirectory = resolve(process.argv[2] ?? 'tasks');

  try {
    const result = await validateTaskDirectory(tasksDirectory);
    const noun = result.taskCount === 1 ? 'file' : 'files';
    console.log(`Validated ${String(result.taskCount)} task ${noun}.`);

    if (result.findings.length > 0) {
      for (const finding of result.findings) {
        console.error(finding);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unable to validate task queue: ${message}`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && pathToFileURL(resolve(entryPoint)).href === import.meta.url) {
  await runCli();
}
