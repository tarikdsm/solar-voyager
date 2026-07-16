import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingestAssets } from './ingest.mjs';

function parseArguments(argv) {
  const onlyIds = [];
  let modelsRoot;
  let outputRoot;
  let ktxExecutable;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--only' && value !== undefined) { onlyIds.push(value); index += 1; }
    else if (argument === '--models' && value !== undefined) { modelsRoot = value; index += 1; }
    else if (argument === '--output' && value !== undefined) { outputRoot = value; index += 1; }
    else if (argument === '--ktx' && value !== undefined) { ktxExecutable = value; index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return { onlyIds, modelsRoot, outputRoot, ktxExecutable };
}

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

try {
  const args = parseArguments(process.argv.slice(2));
  const result = await ingestAssets({
    modelsRoot: resolve(args.modelsRoot ?? repositoryRoot, args.modelsRoot === undefined ? 'assets/models' : ''),
    outputRoot: resolve(args.outputRoot ?? repositoryRoot, args.outputRoot === undefined ? 'public/assets' : ''),
    ...(args.onlyIds.length > 0 ? { onlyIds: args.onlyIds } : {}),
    ...(args.ktxExecutable !== undefined ? { ktxExecutable: args.ktxExecutable } : {}),
  });
  for (const asset of result.assets) {
    console.log(`${asset.id}: ${asset.triangles.toLocaleString('en-US')} triangles; ${asset.files.length} files`);
  }
  console.log(`Published ${result.assets.length} assets to ${result.outputRoot}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

