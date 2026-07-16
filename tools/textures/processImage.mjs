import { parseArgs } from 'node:util';

import sharp from 'sharp';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
  },
  strict: true,
});

if (values.input === undefined || values.output === undefined) {
  throw new Error('--input and --output are required');
}
const width = Number.parseInt(values.width ?? '', 10);
const height = Number.parseInt(values.height ?? '', 10);
if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width !== height * 2) {
  throw new Error('--width and --height must define a positive 2:1 image');
}

const source = sharp(values.input, { failOn: 'error', limitInputPixels: 200_000_000 });
const metadata = await source.metadata();
if (metadata.width === undefined || metadata.height === undefined || metadata.width !== metadata.height * 2) {
  throw new Error(`source must be equirectangular 2:1; measured ${metadata.width}x${metadata.height}`);
}

await source
  .rotate()
  .resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
  .removeAlpha()
  .toColourspace('srgb')
  .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
  .toFile(values.output);

const output = await sharp(values.output).metadata();
if (output.width !== width || output.height !== height || output.format !== 'png') {
  throw new Error('processed texture failed output validation');
}
