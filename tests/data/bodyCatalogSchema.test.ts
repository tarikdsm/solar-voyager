import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import catalog from '../../data/bodies.json';
import schema from '../../data/bodies.schema.json';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

function cloneCatalog(): typeof catalog {
  return structuredClone(catalog);
}

describe('body catalog schema', () => {
  it('accepts the committed schema-v2 catalog', () => {
    expect(validate(catalog), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([0, -0.1, 1.1])('rejects polarRadiusRatio=%s', (ratio) => {
    const invalid = cloneCatalog();
    invalid.bodies[0]!.visual.polarRadiusRatio = ratio;

    expect(validate(invalid)).toBe(false);
  });

  it('requires an explicit polarRadiusRatio for every body', () => {
    const invalid = cloneCatalog() as unknown as {
      bodies: Array<{ visual: { polarRadiusRatio?: number } }>;
    };
    delete invalid.bodies[0]!.visual.polarRadiusRatio;

    expect(validate(invalid)).toBe(false);
  });
});
