import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { measureBundleSizes } from './bundleMeasurement.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe('measureBundleSizes', () => {
  it('measures the HTML entry and all JavaScript/CSS gzip payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'solar-voyager-bundle-'));
    temporaryDirectories.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const entry = 'export const answer = 42;\n';
    const chunk = 'export const label = "flight";\n';
    const css = 'body { color: white; }\n';
    await writeFile(
      join(root, 'index.html'),
      '<script type="module" src="/solar-voyager/assets/index-test.js"></script>',
    );
    await writeFile(join(assets, 'index-test.js'), entry);
    await writeFile(join(assets, 'chunk.js'), chunk);
    await writeFile(join(assets, 'index.css'), css);
    await writeFile(join(assets, 'decoder.wasm'), 'ignored');

    await expect(measureBundleSizes(root)).resolves.toEqual({
      entryFile: 'assets/index-test.js',
      entryGzipBytes: gzipSync(entry).byteLength,
      totalGzipBytes:
        gzipSync(entry).byteLength + gzipSync(chunk).byteLength + gzipSync(css).byteLength,
    });
  });

  it('fails closed when the built entry script is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'solar-voyager-bundle-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'index.html'), '<main>missing entry</main>');

    await expect(measureBundleSizes(root)).rejects.toThrow(
      'Unable to find the production entry script in dist/index.html.',
    );
  });
});

