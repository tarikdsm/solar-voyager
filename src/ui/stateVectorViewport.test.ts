import { describe, expect, it } from 'vitest';

import {
  STATE_VECTOR_VIEWPORT_COMPONENT_COUNT,
  writeStateVectorViewportPixelsInto,
} from './stateVectorViewport.js';

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

describe('state-vector viewport layout', () => {
  it('converts top-left CSS bounds into bottom-left drawing-buffer pixels', () => {
    const output = new Float64Array(STATE_VECTOR_VIEWPORT_COMPONENT_COUNT);

    writeStateVectorViewportPixelsInto(
      output,
      rect(0, 0, 1_200, 800),
      rect(940, 520, 240, 240),
      2_400,
      1_600,
    );

    expect(Array.from(output)).toEqual([1_880, 80, 480, 480]);
  });

  it('clips a partially off-canvas panel and returns zero for a hidden panel', () => {
    const output = new Float64Array(STATE_VECTOR_VIEWPORT_COMPONENT_COUNT);
    const canvas = rect(10, 20, 1_000, 500);

    writeStateVectorViewportPixelsInto(output, canvas, rect(950, 440, 120, 120), 1_000, 500);
    expect(Array.from(output)).toEqual([940, 0, 60, 80]);

    writeStateVectorViewportPixelsInto(output, canvas, rect(1_100, 600, 100, 100), 1_000, 500);
    expect(Array.from(output)).toEqual([1_000, 0, 0, 0]);
  });

  it('rejects undersized output and unusable canvas geometry', () => {
    const valid = rect(0, 0, 100, 100);
    expect(() =>
      writeStateVectorViewportPixelsInto(new Float64Array(3), valid, valid, 100, 100),
    ).toThrow(RangeError);
    expect(() =>
      writeStateVectorViewportPixelsInto(new Float64Array(4), rect(0, 0, 0, 100), valid, 100, 100),
    ).toThrow(RangeError);
  });
});
