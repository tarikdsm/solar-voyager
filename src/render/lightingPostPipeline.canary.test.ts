import { REVISION } from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BLOOM_INTERNAL_FIELDS,
  DEFAULT_POST_BACKEND,
  SMAA_INTERNAL_FIELDS,
  VALIDATED_THREE_REVISION,
  assertPassInternals,
} from './lightingPostPipeline.js';

/**
 * Canary for the three.js private-field contract the adaptive post passes depend on.
 *
 * `AdaptiveSmaaPass` and `AdaptiveBloomPass` read render targets and materials that
 * three.js does not export, and they rewrite the stock vertex shaders. None of that
 * is covered by three.js' semver promise, so a dependency bump must fail *here*,
 * with an actionable message, instead of silently degrading a browser gate or —
 * worse — shipping. Nothing in this file needs a GPU: SMAA only uses `Image` as a
 * `{ src, onload }` bag, so a stub is enough to construct the real passes.
 */

class StubImage {
  src = '';
  onload: (() => void) | null = null;
}

const globals = globalThis as { Image?: unknown };
let originalImage: unknown;

beforeAll(() => {
  originalImage = globals.Image;
  globals.Image = StubImage;
});

afterAll(() => {
  if (originalImage === undefined) delete globals.Image;
  else globals.Image = originalImage;
});

function fieldsOf(owner: object): ReadonlySet<string> {
  const names = new Set<string>();
  for (const key of Object.keys(owner)) names.add(key);
  return names;
}

describe('three.js post-processing internals canary', () => {
  it('pins the three.js revision the private-field reads were validated against', () => {
    expect(REVISION).toBe(VALIDATED_THREE_REVISION);
  });

  it('finds every SMAA internal the adaptive render scale mutates', () => {
    const smaaPass = DEFAULT_POST_BACKEND.createSmaaPass();
    const present = fieldsOf(smaaPass);
    for (const field of SMAA_INTERNAL_FIELDS) expect(present.has(field)).toBe(true);
    smaaPass.dispose();
  });

  it('finds every bloom internal, with the blur chain arity the scaling loop assumes', () => {
    const bloomPass = DEFAULT_POST_BACKEND.createBloomPass();
    const present = fieldsOf(bloomPass);
    for (const field of BLOOM_INTERNAL_FIELDS) expect(present.has(field)).toBe(true);
    const internals = bloomPass as unknown as {
      renderTargetsHorizontal: readonly unknown[];
      renderTargetsVertical: readonly unknown[];
      separableBlurMaterials: readonly unknown[];
    };
    expect(internals.renderTargetsHorizontal.length).toBe(5);
    expect(internals.renderTargetsVertical.length).toBe(5);
    expect(internals.separableBlurMaterials.length).toBe(5);
    bloomPass.dispose();
  });

  it('constructs every adaptive pass, proving the rewritten vertex shaders still match', () => {
    // `installUvScale` throws when the stock `vUv = uv;` assignment it rewrites is
    // gone, so successful construction *is* the shader-source assertion.
    expect(() => DEFAULT_POST_BACKEND.createSmaaPass().dispose()).not.toThrow();
    expect(() => DEFAULT_POST_BACKEND.createBloomPass().dispose()).not.toThrow();
    expect(() => DEFAULT_POST_BACKEND.createFxaaPass().dispose()).not.toThrow();
    expect(() => DEFAULT_POST_BACKEND.createOutputPass().dispose()).not.toThrow();
  });

  it('names the missing field and the validated revision when an internal disappears', () => {
    expect(() =>
      assertPassInternals('AdaptiveSmaaPass', { _edgesRT: {} }, SMAA_INTERNAL_FIELDS),
    ).toThrow(/_weightsRT/u);
    expect(() =>
      assertPassInternals('AdaptiveSmaaPass', { _edgesRT: {} }, SMAA_INTERNAL_FIELDS),
    ).toThrow(new RegExp(`r${VALIDATED_THREE_REVISION}`, 'u'));
  });
});
