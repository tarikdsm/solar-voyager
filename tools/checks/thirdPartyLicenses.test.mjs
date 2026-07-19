import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { verifyThirdPartyLicenses } from './thirdPartyLicenses.mjs';

const MIT_LICENSE = 'MIT license body\nCopyright (c) Example Author\n';
const APACHE_LICENSE = [
  'Apache License',
  'Version 2.0, January 2004',
  'http://www.apache.org/licenses/',
  'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
  'END OF TERMS AND CONDITIONS',
  '',
].join('\n');

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'solar-voyager-licenses-'));
  const dependencies = [
    ['three', 'Three Authors'],
    ['preact', 'Jason Miller'],
    ['@preact/signals', 'Preact Team'],
    ['@preact/signals-core', 'Preact Team'],
  ];

  await mkdir(join(root, 'public'), { recursive: true });
  for (const [dependency] of dependencies) {
    await mkdir(join(root, 'node_modules', dependency), { recursive: true });
    await writeFile(join(root, 'node_modules', dependency, 'LICENSE'), MIT_LICENSE);
  }
  await mkdir(join(root, 'node_modules', 'playwright'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'playwright', 'LICENSE'), APACHE_LICENSE);

  const notice = [
    MIT_LICENSE.trim(),
    'Basis Universal',
    'Copyright 2019-2026 Binomial LLC',
    'Google Draco decoder',
    'Copyright 2017 The Draco Authors',
    APACHE_LICENSE,
  ].join('\n');
  await writeFile(join(root, 'public', 'THIRD_PARTY_LICENSES.txt'), notice);
  return root;
}

describe('third-party license notices', () => {
  it('accepts complete source notices and their identical built copy', async () => {
    const root = await createRepository();
    try {
      await expect(verifyThirdPartyLicenses(root)).resolves.toEqual([]);
      await mkdir(join(root, 'dist'));
      await writeFile(
        join(root, 'dist', 'THIRD_PARTY_LICENSES.txt'),
        await import('node:fs/promises').then(({ readFile }) =>
          readFile(join(root, 'public', 'THIRD_PARTY_LICENSES.txt')),
        ),
      );
      await expect(verifyThirdPartyLicenses(root, { requireBuiltArtifact: true })).resolves.toEqual(
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing dependency, codec, Apache and built-copy notices together', async () => {
    const root = await createRepository();
    try {
      await writeFile(join(root, 'public', 'THIRD_PARTY_LICENSES.txt'), 'incomplete\n');
      const findings = await verifyThirdPartyLicenses(root, { requireBuiltArtifact: true });
      expect(findings).toContain('missing complete installed license: three');
      expect(findings).toContain('missing codec notice: Basis Universal');
      expect(findings).toContain('missing codec notice: Google Draco decoder');
      expect(findings).toContain('missing complete Apache License 2.0 text');
      expect(findings).toContain('missing built notice: dist/THIRD_PARTY_LICENSES.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a built notice that differs from the public source', async () => {
    const root = await createRepository();
    try {
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'dist', 'THIRD_PARTY_LICENSES.txt'), 'stale\n');
      await expect(
        verifyThirdPartyLicenses(root, { requireBuiltArtifact: true }),
      ).resolves.toContain('built notice differs from public/THIRD_PARTY_LICENSES.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
