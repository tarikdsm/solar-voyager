import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const BASIS_NOTICE = [
  'NOTICE',
  '',
  'Basis Universal™ Supercompressed GPU Texture Compression Library',
  '',
  'Copyright © 2016–2026 Binomial LLC.',
  'All rights reserved except as granted under the [Apache 2.0 license](https://github.com/BinomialLLC/basis_universal/blob/master/LICENSE).',
  '"Basis Universal" is a trademark of Binomial LLC.',
  '',
  'The documents in the Basis Universal wiki, and the Basis Universal library, example, and tool source code, fall under the Apache 2.0 license, unless otherwise explicitly indicated.',
  '',
  'Redistributions or derivative works must include a readable copy of the attribution notices from this NOTICE file (see Apache License 2.0 §4(d)).',
  '',
  'If you modify the Basis Universal source code, specifications, or wiki documents and redistribute the files, you must cause any modified files to carry prominent notices stating that you changed the files (see Apache 2.0 §4(b)).',
  '',
  '**This software, documentation and specifications are provided "as is", without warranty of any kind (see Apache 2.0 §§7–8).**',
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
  await mkdir(join(root, 'tools', 'checks', 'fixtures'), { recursive: true });
  await writeFile(
    join(root, 'tools', 'checks', 'fixtures', 'basis-universal-NOTICE.txt'),
    BASIS_NOTICE,
  );
  for (const [dependency] of dependencies) {
    await mkdir(join(root, 'node_modules', dependency), { recursive: true });
    await writeFile(join(root, 'node_modules', dependency, 'LICENSE'), MIT_LICENSE);
  }
  await mkdir(join(root, 'node_modules', 'playwright'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'playwright', 'LICENSE'), APACHE_LICENSE);

  const notice = [
    MIT_LICENSE.trim(),
    BASIS_NOTICE,
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
      expect(findings).toContain('missing complete Basis Universal NOTICE');
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

  it('rejects a forged Basis NOTICE even when public and fixture copies match', async () => {
    const root = await createRepository();
    try {
      const forged = BASIS_NOTICE.replace('All rights reserved', 'Some rights reserved');
      const noticePath = join(root, 'public', 'THIRD_PARTY_LICENSES.txt');
      await writeFile(
        noticePath,
        (await readFile(noticePath, 'utf8')).replace(BASIS_NOTICE, forged),
      );
      await writeFile(
        join(root, 'tools', 'checks', 'fixtures', 'basis-universal-NOTICE.txt'),
        forged,
      );
      await expect(verifyThirdPartyLicenses(root)).resolves.toContain(
        'Basis Universal NOTICE fixture does not match pinned upstream SHA-256',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
