import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUNDLE_EXTENSIONS = new Set(['.css', '.js']);

async function listBundleFiles(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await listBundleFiles(entryPath, files);
    } else if (entry.isFile() && BUNDLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
}

function readEntryFile(html) {
  const match = html.match(/<script[^>]+src="[^"]*?(assets\/[^"]+\.js)"[^>]*>/iu);
  if (match?.[1] === undefined) {
    throw new Error('Unable to find the production entry script in dist/index.html.');
  }
  return match[1];
}

export async function measureBundleSizes(distRoot) {
  const root = resolve(distRoot);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const entryFile = readEntryFile(html);
  const files = [];
  await listBundleFiles(root, files);
  let entryGzipBytes = -1;
  let totalGzipBytes = 0;
  for (const file of files) {
    const gzipBytes = gzipSync(await readFile(file)).byteLength;
    totalGzipBytes += gzipBytes;
    if (relative(root, file).replaceAll('\\', '/') === entryFile) {
      entryGzipBytes = gzipBytes;
    }
  }
  if (entryGzipBytes < 0) {
    throw new Error(`Production entry script does not exist: ${entryFile}`);
  }
  return { entryFile, entryGzipBytes, totalGzipBytes };
}

