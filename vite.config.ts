import preactPreset from '@preact/preset-vite';
import { minify } from 'terser';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/solar-voyager/',
  plugins: [
    preactPreset(),
    {
      name: 'minify-entry',
      async generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk' || !output.isEntry) continue;
          // Deterministic post-processing preserves cache identity because the Oxc output is its input.
          const result = await minify(output.code, {
            compress: { passes: 3 },
            ecma: 2022,
            mangle: true,
            module: true,
          });
          if (result.code !== undefined) output.code = result.code;
        }
      },
    },
  ],
});
