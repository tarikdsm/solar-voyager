import { parseArgs } from 'node:util';

import sharp from 'sharp';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    format: { type: 'string', default: 'png' },
    quality: { type: 'string', default: '90' },
    contrast: { type: 'string', default: '1' },
    grayscale: { type: 'boolean', default: false },
    normalize: { type: 'boolean', default: false },
    blur: { type: 'string', default: '0' },
  },
  strict: true,
});

if (values.input === undefined || values.output === undefined) {
  throw new Error('--input and --output are required');
}
const width = Number.parseInt(values.width ?? '', 10);
const height = Number.parseInt(values.height ?? '', 10);
const quality = Number.parseInt(values.quality, 10);
const contrast = Number.parseFloat(values.contrast);
const blur = Number.parseFloat(values.blur);
if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width !== height * 2) {
  throw new Error('--width and --height must define a positive 2:1 image');
}
if (!['png', 'jpeg'].includes(values.format) || !Number.isInteger(quality) || quality < 1 || quality > 100) {
  throw new Error('--format and --quality must define a supported encoder');
}
if (!Number.isFinite(contrast) || contrast <= 0 || !Number.isFinite(blur) || blur < 0) {
  throw new Error('--contrast and --blur must be finite and nonnegative');
}

const source = sharp(values.input, { failOn: 'error', limitInputPixels: 200_000_000 });
const metadata = await source.metadata();
if (metadata.width === undefined || metadata.height === undefined || metadata.width !== metadata.height * 2) {
  throw new Error(`source must be equirectangular 2:1; measured ${metadata.width}x${metadata.height}`);
}

let pipeline = source
  .rotate()
  .resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
  .removeAlpha();
if (values.grayscale) pipeline = pipeline.greyscale();
if (values.normalize) pipeline = pipeline.normalise();
if (blur > 0) pipeline = pipeline.blur(blur);
if (contrast !== 1) pipeline = pipeline.linear(contrast, 128 * (1 - contrast));
pipeline = pipeline.toColourspace(values.grayscale ? 'b-w' : 'srgb');
if (values.format === 'png') {
  pipeline = pipeline.png({ adaptiveFiltering: false, compressionLevel: 9, palette: false });
} else {
  pipeline = pipeline.jpeg({ chromaSubsampling: '4:4:4', mozjpeg: false, quality });
}
await pipeline.toFile(values.output);

const output = await sharp(values.output).metadata();
if (output.width !== width || output.height !== height || output.format !== values.format) {
  throw new Error('processed texture failed output validation');
}
