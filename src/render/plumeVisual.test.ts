import { AdditiveBlending, DoubleSide, type WebGLRenderer } from 'three';
import { describe, expect, test } from 'vitest';

import { createRadialSpriteTexture } from './additivePointSprite.js';
import { beamLengthShipLengths } from './plumeRadiance.js';
import { PLUME_BEAM_SEGMENT_LADDER, PlumeVisual } from './plumeVisual.js';
import { SHIP_NOZZLE_THROAT_X_M } from './shipEffectAnchors.js';
import { SHIP_LENGTH_M } from './shipVisual.js';

function plume(): PlumeVisual {
  return new PlumeVisual(createRadialSpriteTexture());
}

/** Minimal shader object with the three.js chunk markers the hook rewrites. */
function shaderStub(): { vertexShader: string; fragmentShader: string; uniforms: object } {
  return {
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <opaque_fragment>\n}',
    uniforms: {},
  };
}

describe('plume beam geometry', () => {
  test('is one indexed lathe anchored at the nozzle throat, not the exit', () => {
    const visual = plume();
    try {
      expect(visual.beam.position.x).toBe(SHIP_NOZZLE_THROAT_X_M);
      expect(visual.beam.geometry.getAttribute('position').count).toBe(13 * 24);
      expect(visual.beam.geometry.getAttribute('aAxial')).toBeDefined();
      expect(visual.beam.geometry.getIndex()?.count).toBe(1_728 + 432 + 108);
    } finally {
      visual.dispose();
    }
  });

  test('carries three tessellations in one index buffer, selected by draw range', () => {
    const visual = plume();
    try {
      const ranges = PLUME_BEAM_SEGMENT_LADDER.map((segments) => {
        visual.setBeamSegments(segments);
        return { segments: visual.beamSegments, ...visual.beam.geometry.drawRange };
      });
      expect(ranges).toEqual([
        { segments: 24, start: 0, count: 1_728 },
        { segments: 12, start: 1_728, count: 432 },
        { segments: 6, start: 2_160, count: 108 },
      ]);
    } finally {
      visual.dispose();
    }
  });

  test('snaps an off-ladder segment count down to a tessellation that exists', () => {
    const visual = plume();
    try {
      visual.setBeamSegments(20);
      expect(visual.beamSegments).toBe(12);
      visual.setBeamSegments(1);
      expect(visual.beamSegments).toBe(6);
      visual.setBeamSegments(1_000);
      expect(visual.beamSegments).toBe(24);
      expect(() => visual.setBeamSegments(Number.NaN)).toThrow(RangeError);
    } finally {
      visual.dispose();
    }
  });
});

describe('plume throttle response', () => {
  test('draws nothing at all when coasting', () => {
    const visual = plume();
    try {
      visual.setThrottle(0);
      expect(visual.burning).toBe(false);
      expect(visual.beam.visible).toBe(false);
      expect(visual.glow.visible).toBe(false);
      expect(visual.beamLengthM).toBe(0);
      expect(visual.beamIntensity).toBe(0);
    } finally {
      visual.dispose();
    }
  });

  test('reaches four ship lengths at full throttle, on the plan curve', () => {
    const visual = plume();
    try {
      visual.setThrottle(1);
      expect(visual.beamLengthM).toBeCloseTo(4 * SHIP_LENGTH_M, 9);
      visual.setThrottle(0.25);
      expect(visual.beamLengthM).toBeCloseTo(beamLengthShipLengths(0.25) * SHIP_LENGTH_M, 9);
      expect(visual.burning).toBe(true);
    } finally {
      visual.dispose();
    }
  });

  test('one call is one frame: length and glow move together, immediately', () => {
    const visual = plume();
    try {
      visual.setThrottle(1);
      const fullGlow = (
        visual.glow.geometry.getAttribute('aPuffIntensity').array as Float32Array
      )[0];
      visual.setThrottle(0.1);
      const lowGlow = (
        visual.glow.geometry.getAttribute('aPuffIntensity').array as Float32Array
      )[0];
      expect(lowGlow as number).toBeLessThan(fullGlow as number);
      expect(visual.beamLengthM).toBeLessThan(4 * SHIP_LENGTH_M);
    } finally {
      visual.dispose();
    }
  });

  test('clamps a nonsense throttle instead of propagating it', () => {
    const visual = plume();
    try {
      visual.setThrottle(Number.NaN);
      expect(visual.throttle).toBe(0);
      visual.setThrottle(7);
      expect(visual.throttle).toBe(1);
      expect(visual.beamLengthM).toBeCloseTo(4 * SHIP_LENGTH_M, 9);
    } finally {
      visual.dispose();
    }
  });
});

describe('plume material policy', () => {
  test('is additive, depth-tested, non-depth-writing and drawn after bodies', () => {
    const visual = plume();
    try {
      for (const material of [visual.beam.material, visual.glow.material]) {
        expect(material.blending).toBe(AdditiveBlending);
        expect(material.transparent).toBe(true);
        expect(material.depthWrite).toBe(false);
        // Load-bearing twice: the nozzle liner hides the first 1.5 m of beam,
        // and a planet in front of the ship stays in front of the plume.
        expect(material.depthTest).toBe(true);
      }
      expect(visual.beam.material.side).toBe(DoubleSide);
      expect(visual.beam.renderOrder).toBe(2);
      expect(visual.glow.renderOrder).toBe(2);
    } finally {
      visual.dispose();
    }
  });

  test('the onBeforeCompile hook injects the shape and emission, and keeps its cache key', () => {
    const visual = plume();
    try {
      const shader = shaderStub();
      const material = visual.beam.material;
      material.onBeforeCompile(shader as never, {} as WebGLRenderer);
      expect(shader.vertexShader).toContain('uniform float uBeamLengthM;');
      expect(shader.vertexShader).toContain('vec3 transformed = vec3(');
      expect(shader.vertexShader).not.toContain('#include <begin_vertex>');
      expect(shader.fragmentShader).toContain('gl_FragColor = vec4(diffuse * beamAlpha');
      expect(shader.uniforms).toHaveProperty('uBeamLengthM');
      expect(material.customProgramCacheKey()).toContain('solar-voyager-plume-beam-v1');
    } finally {
      visual.dispose();
    }
  });

  test('a three.js chunk that stops existing fails loudly rather than silently', () => {
    const visual = plume();
    try {
      expect(() => {
        visual.beam.material.onBeforeCompile(
          { vertexShader: 'void main() {}', fragmentShader: '', uniforms: {} } as never,
          {} as WebGLRenderer,
        );
      }).toThrow(/#include <common>/u);
    } finally {
      visual.dispose();
    }
  });
});
