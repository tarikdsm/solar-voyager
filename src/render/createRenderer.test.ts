import { describe, expect, it } from 'vitest';

import { createRendererParameters } from './createRenderer.js';

describe('createRendererParameters', () => {
  it('enables the logarithmic depth fallback without mixing depth strategies', () => {
    const canvas = {} as HTMLCanvasElement;
    const parameters = createRendererParameters(canvas);

    expect(parameters.canvas).toBe(canvas);
    expect(parameters.logarithmicDepthBuffer).toBe(true);
    expect(parameters.reversedDepthBuffer).not.toBe(true);
    expect(parameters.powerPreference).toBe('high-performance');
    expect(parameters.antialias).toBe(false);
  });
});
