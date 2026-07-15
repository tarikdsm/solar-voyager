import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIB = 1024 * 1024;
const MANIFEST_RELATIVE_PATH = 'public/assets/manifest.json';
const REPO_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.worktrees',
  'dist',
  'coverage',
  '.superpowers',
  'output',
]);
const CODE_EXTENSIONS = new Set(['.css', '.html', '.js', '.mjs', '.wasm']);
const CRITICAL_ASSET_PATTERN = /(^|[/_.-])(sun|earth|moon|stars?)(?=$|[/_.-])/i;
const LARGE_MODEL_CATEGORIES = new Set(['planet', 'sun', 'major-moon']);
const SMALL_MODEL_CATEGORIES = new Set(['asteroid', 'comet']);
const MANIFEST_ASSET_FIELDS = new Set(['id', 'category', 'triangles', 'files']);

export const BUDGET_LIMITS = Object.freeze({
  repoBytes: 300 * MIB,
  publicAssetsBytes: 150 * MIB,
  criticalPathBytes: 8 * MIB,
  largeModelTriangles: 50_000,
  smallModelTriangles: 5_000,
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error) {
  return isRecord(error) && error.code === 'ENOENT';
}

function canonicalKey(filePath) {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

export function addCanonicalSize(canonicalPaths, canonicalPath, sizeBytes) {
  const key = canonicalKey(canonicalPath);
  if (canonicalPaths.has(key)) {
    return 0;
  }
  canonicalPaths.add(key);
  return sizeBytes;
}

async function sumFiles(directory, options = {}) {
  const {
    excludedDirectories = new Set(),
    includeFile = () => true,
    canonicalPaths,
    canonicalDirectories,
  } = options;
  let totalBytes = 0;
  let entries;

  try {
    if (canonicalDirectories !== undefined) {
      const directoryKey = canonicalKey(await realpath(directory));
      if (canonicalDirectories.has(directoryKey)) {
        return 0;
      }
      canonicalDirectories.add(directoryKey);
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return 0;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    const entryStats = entry.isSymbolicLink() && canonicalPaths !== undefined
      ? await stat(entryPath)
      : null;

    if (entry.isDirectory() || entryStats?.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        totalBytes += await sumFiles(entryPath, options);
      }
      continue;
    }

    if ((!entry.isFile() && !entryStats?.isFile()) || !includeFile(entryPath)) {
      continue;
    }

    if (canonicalPaths !== undefined) {
      totalBytes += addCanonicalSize(
        canonicalPaths,
        await realpath(entryPath),
        (entryStats ?? (await stat(entryPath))).size,
      );
      continue;
    }

    totalBytes += (await stat(entryPath)).size;
  }

  return totalBytes;
}

async function readManifest(root) {
  const manifestPath = resolve(root, ...MANIFEST_RELATIVE_PATH.split('/'));

  try {
    const source = await readFile(manifestPath, 'utf8');

    try {
      return { present: true, value: JSON.parse(source) };
    } catch {
      return { present: true, parseError: 'malformed JSON' };
    }
  } catch (error) {
    if (isMissing(error)) {
      return { present: false };
    }
    throw error;
  }
}

function isBuiltCode(filePath) {
  return CODE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function identifiesCriticalAsset(publicAssetsPath, filePath) {
  const normalizedPath = relative(publicAssetsPath, filePath).replaceAll('\\', '/').toLowerCase();
  return CRITICAL_ASSET_PATTERN.test(normalizedPath);
}

export async function measureBudgets(root) {
  const repositoryRoot = resolve(root);
  const publicAssetsPath = resolve(repositoryRoot, 'public', 'assets');
  const canonicalCriticalPaths = new Set();
  const canonicalCriticalDirectories = new Set();
  const repoBytes = await sumFiles(repositoryRoot, {
    excludedDirectories: REPO_EXCLUDED_DIRECTORIES,
  });
  const publicAssetsBytes = await sumFiles(publicAssetsPath);
  const builtCodeBytes = await sumFiles(resolve(repositoryRoot, 'dist'), {
    includeFile: isBuiltCode,
    canonicalPaths: canonicalCriticalPaths,
    canonicalDirectories: canonicalCriticalDirectories,
  });
  const runtimeCriticalBytes = await sumFiles(publicAssetsPath, {
    includeFile: (filePath) => identifiesCriticalAsset(publicAssetsPath, filePath),
    canonicalPaths: canonicalCriticalPaths,
    canonicalDirectories: canonicalCriticalDirectories,
  });

  return {
    repoBytes,
    publicAssetsBytes,
    criticalPathBytes: builtCodeBytes + runtimeCriticalBytes,
    manifest: await readManifest(repositoryRoot),
  };
}

function formatInteger(value) {
  return value.toLocaleString('en-US');
}

function formatMiB(bytes) {
  return (bytes / MIB).toFixed(2);
}

function validateByteLimit(findings, label, measuredBytes, limitBytes) {
  if (measuredBytes >= limitBytes) {
    findings.push(
      `${label} must be < ${formatMiB(limitBytes)} MiB; measured ${formatMiB(measuredBytes)} MiB (${formatInteger(measuredBytes)} bytes)`,
    );
  }
}

function normalizeCategory(category) {
  return category.trim().toLowerCase().replaceAll(/[ _]+/g, '-');
}

function validateManifestAsset(asset, index, findings) {
  const prefix = `${MANIFEST_RELATIVE_PATH}: assets[${String(index)}]`;

  if (!isRecord(asset)) {
    findings.push(`${prefix} must be an object`);
    return;
  }

  for (const field of Object.keys(asset)) {
    if (!MANIFEST_ASSET_FIELDS.has(field)) {
      findings.push(`${prefix} has unexpected field "${field}"`);
    }
  }

  if (typeof asset.id !== 'string' || asset.id.length === 0) {
    findings.push(`${prefix}.id must be a nonempty string`);
  }
  if (typeof asset.category !== 'string' || asset.category.length === 0) {
    findings.push(`${prefix}.category must be a nonempty string`);
  }
  if (!Number.isInteger(asset.triangles) || asset.triangles < 0) {
    findings.push(`${prefix}.triangles must be a nonnegative integer`);
  }
  if (
    asset.files !== undefined &&
    (!Array.isArray(asset.files) || asset.files.some((file) => typeof file !== 'string'))
  ) {
    findings.push(`${prefix}.files must be a list of strings`);
  }

  if (
    typeof asset.id !== 'string' ||
    typeof asset.category !== 'string' ||
    !Number.isInteger(asset.triangles) ||
    asset.triangles < 0
  ) {
    return;
  }

  const category = normalizeCategory(asset.category);
  const triangleLimit = LARGE_MODEL_CATEGORIES.has(category)
    ? BUDGET_LIMITS.largeModelTriangles
    : SMALL_MODEL_CATEGORIES.has(category)
      ? BUDGET_LIMITS.smallModelTriangles
      : null;

  if (triangleLimit !== null && asset.triangles > triangleLimit) {
    findings.push(
      `${MANIFEST_RELATIVE_PATH}: asset "${asset.id}" (${category}) has ${formatInteger(asset.triangles)} triangles; limit is ${formatInteger(triangleLimit)}`,
    );
  }
}

function validateManifest(manifest, findings) {
  if (!manifest.present) {
    return;
  }
  if (manifest.parseError !== undefined) {
    findings.push(`${MANIFEST_RELATIVE_PATH}: ${manifest.parseError}`);
    return;
  }
  if (!isRecord(manifest.value)) {
    findings.push(`${MANIFEST_RELATIVE_PATH}: root must be an object with an assets list`);
    return;
  }
  if (!Array.isArray(manifest.value.assets)) {
    findings.push(`${MANIFEST_RELATIVE_PATH}: field "assets" must be a list`);
    return;
  }

  for (const [index, asset] of manifest.value.assets.entries()) {
    validateManifestAsset(asset, index, findings);
  }
}

export function validateBudgets(measurements) {
  const findings = [];
  validateByteLimit(findings, 'Repo content', measurements.repoBytes, BUDGET_LIMITS.repoBytes);
  validateByteLimit(
    findings,
    'public/assets',
    measurements.publicAssetsBytes,
    BUDGET_LIMITS.publicAssetsBytes,
  );
  validateByteLimit(
    findings,
    'Critical path',
    measurements.criticalPathBytes,
    BUDGET_LIMITS.criticalPathBytes,
  );
  validateManifest(measurements.manifest, findings);
  return findings;
}

function printMeasurement(label, measuredBytes, limitBytes) {
  console.log(
    `${label}: ${formatInteger(measuredBytes)} bytes (${formatMiB(measuredBytes)} MiB); limit < ${formatMiB(limitBytes)} MiB`,
  );
}

async function runCli() {
  const defaultRoot = fileURLToPath(new URL('../..', import.meta.url));
  const root = resolve(process.argv[2] ?? defaultRoot);

  try {
    const measurements = await measureBudgets(root);
    printMeasurement('Repo content', measurements.repoBytes, BUDGET_LIMITS.repoBytes);
    printMeasurement(
      'public/assets',
      measurements.publicAssetsBytes,
      BUDGET_LIMITS.publicAssetsBytes,
    );
    printMeasurement(
      'Critical path',
      measurements.criticalPathBytes,
      BUDGET_LIMITS.criticalPathBytes,
    );

    const findings = validateBudgets(measurements);
    for (const finding of findings) {
      console.error(finding);
    }
    if (findings.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unable to check asset budgets: ${message}`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && pathToFileURL(resolve(entryPoint)).href === import.meta.url) {
  await runCli();
}
