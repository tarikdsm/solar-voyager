import { MeshStandardMaterial, Texture } from 'three';
import { describe, expect, it } from 'vitest';

import { prepareGasGiantAnimation } from './gasGiantAnimation.js';

function surfaceMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ map: new Texture() });
  material.name = 'mat_surface';
  return material;
}

describe('gas-giant animation facade', () => {
  it('ignores non-gas bodies without touching their material', () => {
    const material = surfaceMaterial();
    const compile = material.onBeforeCompile;
    const cacheKey = material.customProgramCacheKey;

    expect(prepareGasGiantAnimation('earth', 399, material)).toBeNull();
    expect(material.onBeforeCompile).toBe(compile);
    expect(material.customProgramCacheKey).toBe(cacheKey);
  });

  it('forwards time, quality, fallback, and disposal to one prepared state', () => {
    const material = surfaceMaterial();
    const compile = material.onBeforeCompile;
    const animation = prepareGasGiantAnimation('jupiter', 599, material);
    if (animation === null) throw new Error('Jupiter animation was not prepared.');

    animation.update(3_600);
    expect(animation.state.uniforms.uGasBandPhases.value.x).toBeGreaterThan(0);
    animation.setQuality('minimum');
    expect(animation.state.uniforms.uGasOctaves.value).toBe(1);
    animation.setEnabled(false);
    expect(animation.state.uniforms.uGasEnabled.value).toBe(0);

    animation.dispose();
    animation.dispose();
    expect(material.onBeforeCompile).toBe(compile);
  });
});
