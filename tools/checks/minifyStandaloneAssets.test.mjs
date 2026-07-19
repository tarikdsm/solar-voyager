import { describe, expect, it } from 'vitest';

import { minifyStandaloneJavaScript } from './minifyStandaloneAssets.mjs';

describe('minifyStandaloneJavaScript', () => {
  it('shrinks standalone decoder-style scripts without changing their behavior', async () => {
    const source = `
      /*! Decoder license */
      function decoderAdd(left, right) {
        const unused = 0;
        return left + right + unused;
      }
    `;

    const output = await minifyStandaloneJavaScript(source);

    expect(output.length).toBeLessThan(source.length);
    expect(output).toContain('Decoder license');
    expect(Function(`${output}; return decoderAdd(2, 3);`)()).toBe(5);
  });

  it('preserves an asset when minification does not improve its gzip size', async () => {
    const source = 'x=1';

    await expect(minifyStandaloneJavaScript(source)).resolves.toBe(source);
  });
});
