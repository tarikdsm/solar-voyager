import { gzipSync } from 'node:zlib';

import { minify } from 'terser';

export async function minifyStandaloneJavaScript(source) {
  const result = await minify(source, {
    compress: { passes: 2 },
    ecma: 2022,
    format: { comments: /@license|@preserve|^!/iu },
    mangle: true,
    module: false,
  });
  const candidate = result.code;
  if (candidate === undefined || gzipSync(candidate).byteLength >= gzipSync(source).byteLength) {
    return source;
  }
  return candidate;
}
