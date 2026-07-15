import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as assetBudgets from './assetBudgets.mjs';

const { BUDGET_LIMITS, measureBudgets, validateBudgets } = assetBudgets;

const CHECKER_PATH = fileURLToPath(new URL('./assetBudgets.mjs', import.meta.url));
const MIB = 1024 * 1024;

async function withRepository(run) {
  const root = await mkdtemp(join(tmpdir(), 'solar-voyager-budgets-'));

  try {
    return await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function writeSparseFile(root, relativePath, sizeBytes) {
  const filePath = join(root, ...relativePath.split('/'));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, '');
  await truncate(filePath, sizeBytes);
  return filePath;
}

async function writeManifest(root, value) {
  const manifestPath = join(root, 'public', 'assets', 'manifest.json');
  await mkdir(dirname(manifestPath), { recursive: true });
  const source = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
  await writeFile(manifestPath, source, 'utf8');
}

async function findingsFor(root) {
  return validateBudgets(await measureBudgets(root));
}

describe('measureBudgets', () => {
  it('excludes generated and orchestration directories from repository content', async () => {
    await withRepository(async (root) => {
      await writeSparseFile(root, 'included.bin', 17);

      for (const directory of [
        '.git',
        'node_modules',
        '.worktrees',
        'dist',
        'coverage',
        '.superpowers',
        'output',
      ]) {
        await writeSparseFile(root, `${directory}/ignored.bin`, BUDGET_LIMITS.repoBytes);
      }

      const measurements = await measureBudgets(root);
      expect(measurements.repoBytes).toBe(17);
    });
  });

  it('includes public assets in repository content', async () => {
    await withRepository(async (root) => {
      await writeSparseFile(root, 'public/assets/models/mars.glb', 41);

      const measurements = await measureBudgets(root);
      expect(measurements.repoBytes).toBe(41);
      expect(measurements.publicAssetsBytes).toBe(41);
    });
  });

  it('sums built code and named critical runtime artifacts once per path', async () => {
    await withRepository(async (root) => {
      await writeSparseFile(root, 'dist/index.html', 100);
      await writeSparseFile(root, 'dist/assets/app.js', 200);
      await writeSparseFile(root, 'dist/assets/style.css', 300);
      await writeSparseFile(root, 'dist/assets/README.md', 1_000);
      await writeSparseFile(root, 'public/assets/models/sun-earth.glb', 400);
      await writeSparseFile(root, 'public/assets/data/stars.bin', 500);
      await writeSparseFile(root, 'public/assets/models/mars.glb', 2_000);

      const measurements = await measureBudgets(root);
      expect(measurements.criticalPathBytes).toBe(1_500);
    });
  });

  it('counts two critical aliases to one canonical file only once', async () => {
    await withRepository(async (root) => {
      const sharedFile = await writeSparseFile(root, 'shared/runtime.bin', 777);
      const sharedDirectory = dirname(sharedFile);
      const publicAssets = join(root, 'public', 'assets');
      await mkdir(publicAssets, { recursive: true });

      try {
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        await symlink(sharedDirectory, join(publicAssets, 'sun'), linkType);
        await symlink(sharedDirectory, join(publicAssets, 'earth'), linkType);
      } catch (error) {
        if (
          process.platform === 'win32' &&
          error instanceof Error &&
          'code' in error &&
          (error.code === 'EPERM' || error.code === 'EACCES')
        ) {
          const canonicalPaths = new Set();
          const addCanonicalSize = assetBudgets.addCanonicalSize;
          expect(addCanonicalSize?.(canonicalPaths, sharedFile, 777)).toBe(777);
          expect(addCanonicalSize?.(canonicalPaths, sharedFile, 777)).toBe(0);
          return;
        }
        throw error;
      }

      const measurements = await measureBudgets(root);
      expect(measurements.criticalPathBytes).toBe(777);
    });
  });

  it('counts a critical alias after a generic alias traverses the same directory first', async () => {
    await withRepository(async (root) => {
      const sharedFile = await writeSparseFile(root, 'shared/runtime.bin', 777);
      const sharedDirectory = dirname(sharedFile);
      const publicAssets = join(root, 'public', 'assets');
      await mkdir(publicAssets, { recursive: true });

      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      await symlink(sharedDirectory, join(publicAssets, 'aaa-generic'), linkType);
      await symlink(sharedDirectory, join(publicAssets, 'sun'), linkType);

      const measurements = await measureBudgets(root);
      expect(measurements.criticalPathBytes).toBe(777);
    });
  });

  it('reports and excludes a critical file symlink that resolves outside the repository', async () => {
    await withRepository(async (root) => {
      const outsideRoot = await mkdtemp(join(tmpdir(), 'solar-voyager-outside-'));

      try {
        const outsideFile = await writeSparseFile(outsideRoot, 'payload.bin', 777);
        const publicAssets = join(root, 'public', 'assets');
        await mkdir(publicAssets, { recursive: true });
        await symlink(outsideFile, join(publicAssets, 'sun.bin'), 'file');

        const measurements = await measureBudgets(root);
        expect(measurements.criticalPathBytes).toBe(0);
        expect(validateBudgets(measurements)).toContainEqual(
          expect.stringContaining(
            'public/assets/sun.bin resolves outside the repository root',
          ),
        );
      } finally {
        await rm(outsideRoot, { force: true, recursive: true });
      }
    });
  });

  it('reports and excludes a critical directory symlink that resolves outside the repository', async () => {
    await withRepository(async (root) => {
      const outsideRoot = await mkdtemp(join(tmpdir(), 'solar-voyager-outside-'));

      try {
        await writeSparseFile(outsideRoot, 'payload.bin', 777);
        const publicAssets = join(root, 'public', 'assets');
        await mkdir(publicAssets, { recursive: true });
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        await symlink(outsideRoot, join(publicAssets, 'sun'), linkType);

        const measurements = await measureBudgets(root);
        expect(measurements.criticalPathBytes).toBe(0);
        expect(validateBudgets(measurements)).toContainEqual(
          expect.stringContaining('public/assets/sun resolves outside the repository root'),
        );
      } finally {
        await rm(outsideRoot, { force: true, recursive: true });
      }
    });
  });

  it('uses zero built-code bytes when dist is absent', async () => {
    await withRepository(async (root) => {
      await writeSparseFile(root, 'public/assets/models/mars.glb', 10);

      const measurements = await measureBudgets(root);
      expect(measurements.criticalPathBytes).toBe(0);
    });
  });
});

describe('validateBudgets byte limits', () => {
  it('fails when repository content equals the 300 MiB limit', async () => {
    await withRepository(async (root) => {
      await writeSparseFile(root, 'payload.bin', BUDGET_LIMITS.repoBytes);
      expect(await findingsFor(root)).toContainEqual(expect.stringContaining('Repo content'));
    });
  });

  it('fails when public assets equal the 150 MiB limit', async () => {
    await withRepository(async (root) => {
      await writeSparseFile(root, 'public/assets/models/generic.glb', BUDGET_LIMITS.publicAssetsBytes);
      expect(await findingsFor(root)).toContainEqual(expect.stringContaining('public/assets'));
    });
  });

  it('fails when the critical path equals the 8 MiB limit', async () => {
    await withRepository(async (root) => {
      await writeSparseFile(root, 'dist/assets/app.js', 4 * MIB);
      await writeSparseFile(root, 'public/assets/models/earth.glb', 4 * MIB);
      expect(await findingsFor(root)).toContainEqual(expect.stringContaining('Critical path'));
    });
  });

  it('passes byte measurements one byte below every limit', () => {
    const findings = validateBudgets({
      repoBytes: BUDGET_LIMITS.repoBytes - 1,
      publicAssetsBytes: BUDGET_LIMITS.publicAssetsBytes - 1,
      criticalPathBytes: BUDGET_LIMITS.criticalPathBytes - 1,
      manifest: { present: false },
    });

    expect(findings).toEqual([]);
  });
});

describe('asset manifest validation', () => {
  it.each([
    ['planet', 50_000],
    ['sun', 50_000],
    ['major-moon', 50_000],
    ['asteroid', 5_000],
    ['comet', 5_000],
  ])('accepts the triangle limit for %s', async (category, triangles) => {
    await withRepository(async (root) => {
      await writeManifest(root, {
        assets: [{ id: `${category}-asset`, category, triangles }],
      });

      expect(await findingsFor(root)).toEqual([]);
    });
  });

  it.each([
    ['planet', 50_001, '50,000'],
    ['sun', 50_001, '50,000'],
    ['major-moon', 50_001, '50,000'],
    ['asteroid', 5_001, '5,000'],
    ['comet', 5_001, '5,000'],
  ])('rejects excess triangles for %s', async (category, triangles, limitText) => {
    await withRepository(async (root) => {
      await writeManifest(root, {
        assets: [{ id: `${category}-asset`, category, triangles }],
      });

      const findings = await findingsFor(root);
      expect(findings).toContainEqual(expect.stringContaining(`${triangles.toLocaleString('en-US')}`));
      expect(findings).toContainEqual(expect.stringContaining(limitText));
    });
  });

  it('allows a missing manifest before the ingest pipeline exists', async () => {
    await withRepository(async (root) => {
      expect(await findingsFor(root)).toEqual([]);
    });
  });

  it('reports malformed manifest JSON', async () => {
    await withRepository(async (root) => {
      await writeManifest(root, '{"assets": [');
      expect(await findingsFor(root)).toContainEqual(
        expect.stringContaining('manifest.json: malformed JSON'),
      );
    });
  });

  it.each([
    ['root array', []],
    ['missing assets', {}],
    ['asset is not an object', { assets: [null] }],
    ['missing id', { assets: [{ category: 'planet', triangles: 1 }] }],
    ['invalid category', { assets: [{ id: 'earth', category: 1, triangles: 1 }] }],
    ['invalid triangles', { assets: [{ id: 'earth', category: 'planet', triangles: -1 }] }],
    [
      'invalid files',
      { assets: [{ id: 'earth', category: 'planet', triangles: 1, files: 'earth.glb' }] },
    ],
  ])('reports invalid manifest schema for %s', async (_description, manifest) => {
    await withRepository(async (root) => {
      await writeManifest(root, manifest);
      expect(await findingsFor(root)).toContainEqual(expect.stringContaining('manifest.json:'));
    });
  });
});

describe('asset budget CLI', () => {
  it('exits one, prints totals, and reports all violations', async () => {
    await withRepository(async (root) => {
      await writeSparseFile(root, 'payload.bin', 150 * MIB);
      await writeSparseFile(root, 'public/assets/earth.bin', 8 * MIB);
      await writeSparseFile(root, 'public/assets/generic.bin', 142 * MIB);
      await writeManifest(root, {
        assets: [{ id: 'earth', category: 'planet', triangles: 50_001 }],
      });

      const result = spawnSync(process.execPath, [CHECKER_PATH, root], { encoding: 'utf8' });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Repo content:');
      expect(result.stdout).toContain('public/assets:');
      expect(result.stdout).toContain('Critical path:');
      expect(result.stderr).toContain('Repo content');
      expect(result.stderr).toContain('public/assets');
      expect(result.stderr).toContain('Critical path');
      expect(result.stderr).toContain('earth');
    });
  });
});
