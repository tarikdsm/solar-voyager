import preactPreset from '@preact/preset-vite';
import { minify } from 'terser';
import { defineConfig } from 'vite';

import { minifyStandaloneJavaScript } from './tools/checks/minifyStandaloneAssets.mjs';

export default defineConfig({
  base: '/solar-voyager/',
  plugins: [
    preactPreset(),
    {
      name: 'minify-production-javascript',
      async generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === 'asset' && output.fileName.endsWith('.js')) {
            const source =
              typeof output.source === 'string'
                ? output.source
                : new TextDecoder().decode(output.source);
            output.source = await minifyStandaloneJavaScript(source);
          } else if (output.type === 'chunk' && output.isEntry) {
            // Deterministic post-processing preserves cache identity because the Oxc output is its input.
            const result = await minify(output.code, {
              compress: { passes: 4 },
              ecma: 2022,
              mangle: true,
              module: true,
            });
            if (result.code !== undefined) output.code = result.code;
          }
        }
      },
    },
  ],
});
