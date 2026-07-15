import { describe, expect, it } from 'vitest';

import { calculateDrawingBufferDimension } from './drawingBufferSize.js';

describe('calculateDrawingBufferDimension', () => {
  it('floors the client dimension scaled by the renderer pixel ratio', () => {
    expect(calculateDrawingBufferDimension(853, 1.25)).toBe(1066);
  });
});
