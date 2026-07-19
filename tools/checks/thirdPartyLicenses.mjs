import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHIPPED_DEPENDENCIES = [
  ['three', 'node_modules/three/LICENSE'],
  ['preact', 'node_modules/preact/LICENSE'],
  ['@preact/signals', 'node_modules/@preact/signals/LICENSE'],
  ['@preact/signals-core', 'node_modules/@preact/signals-core/LICENSE'],
];
const CODEC_NOTICES = [
  ['Basis Universal', 'Copyright 2019-2026 Binomial LLC'],
  ['Google Draco decoder', 'Copyright 2017 The Draco Authors'],
];

function normalize(source) {
  return source.replaceAll('\r\n', '\n').trim();
}

function apacheTerms(source) {
  const normalized = normalize(source);
  const start = normalized.indexOf('Apache License');
  const endMarker = 'END OF TERMS AND CONDITIONS';
  const end = normalized.indexOf(endMarker, start);
  return start >= 0 && end >= 0 ? normalized.slice(start, end + endMarker.length) : '';
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Verifies notices for every third-party component shipped by the public build. */
export async function verifyThirdPartyLicenses(
  repositoryRoot,
  { requireBuiltArtifact = false } = {},
) {
  const root = resolve(repositoryRoot);
  const findings = [];
  const sourcePath = join(root, 'public', 'THIRD_PARTY_LICENSES.txt');
  const source = await readText(sourcePath);

  if (source === undefined) {
    return ['missing public notice: public/THIRD_PARTY_LICENSES.txt'];
  }
  const normalizedNotice = normalize(source);

  for (const [name, relativePath] of SHIPPED_DEPENDENCIES) {
    const license = await readText(join(root, relativePath));
    if (license === undefined || !normalizedNotice.includes(normalize(license))) {
      findings.push(`missing complete installed license: ${name}`);
    }
  }

  for (const [name, copyright] of CODEC_NOTICES) {
    if (!normalizedNotice.includes(name) || !normalizedNotice.includes(copyright)) {
      findings.push(`missing codec notice: ${name}`);
    }
  }

  const apacheReference = await readText(join(root, 'node_modules', 'playwright', 'LICENSE'));
  const completeApacheTerms = apacheReference === undefined ? '' : apacheTerms(apacheReference);
  if (completeApacheTerms === '' || !normalizedNotice.includes(completeApacheTerms)) {
    findings.push('missing complete Apache License 2.0 text');
  }

  if (requireBuiltArtifact) {
    const built = await readText(join(root, 'dist', 'THIRD_PARTY_LICENSES.txt'));
    if (built === undefined) findings.push('missing built notice: dist/THIRD_PARTY_LICENSES.txt');
    else if (built !== source)
      findings.push('built notice differs from public/THIRD_PARTY_LICENSES.txt');
  }

  return findings;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const requireBuiltArtifact = arguments_.includes('--dist');
  const unknown = arguments_.filter((value) => value !== '--dist');
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown.join(' ')}`);
  const findings = await verifyThirdPartyLicenses(process.cwd(), { requireBuiltArtifact });
  if (findings.length > 0) throw new Error(findings.join('\n'));
  process.stdout.write(
    `Third-party license notices passed${requireBuiltArtifact ? ' with built copy' : ''}.\n`,
  );
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
