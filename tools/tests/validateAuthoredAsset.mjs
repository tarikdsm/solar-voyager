/**
 * Run the ingest source validator against one authored asset directory.
 *
 * `npm run assets:ingest` also compresses textures, which needs KTX-Software on
 * PATH; this runs only the MODELING-GUIDE contract half, so a builder can be
 * gated on any machine that has Node.
 *
 *   node tools/tests/validateAuthoredAsset.mjs <directory> <id> <category>
 */
import { validateAssetDirectory } from '../assets/assetIngest.mjs';

const [directory, id, category] = process.argv.slice(2);
if (directory === undefined || id === undefined || category === undefined) {
  console.error('Usage: node tools/tests/validateAuthoredAsset.mjs <directory> <id> <category>');
  process.exit(2);
}

const result = await validateAssetDirectory(directory, { category, id });
for (const finding of result.findings) {
  console.error(finding);
}
if (result.findings.length > 0) {
  console.error(`${id}: ${String(result.findings.length)} contract violation(s)`);
  process.exit(1);
}
console.log(
  `${id}: authored contract accepted (${result.triangles.toLocaleString('en-US')} triangles, ` +
    `${String(result.textures?.length ?? 0)} texture(s))`,
);
