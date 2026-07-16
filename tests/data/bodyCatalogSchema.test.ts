import AjvDraft2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import catalog from '../../data/bodies.json';
import schema from '../../data/bodies.schema.json';

const ajv = new AjvDraft2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

function cloneCatalog(): typeof catalog {
  return structuredClone(catalog);
}

function firstBody(value: typeof catalog): (typeof catalog.bodies)[number] {
  const body = value.bodies[0];
  if (body === undefined) throw new Error('Body catalog fixture must not be empty');
  return body;
}

describe('body catalog schema', () => {
  it('accepts the committed schema-v2 catalog', () => {
    expect(validate(catalog), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([0, -0.1, 1.1])('rejects polarRadiusRatio=%s', (ratio) => {
    const invalid = cloneCatalog();
    firstBody(invalid).visual.polarRadiusRatio = ratio;

    expect(validate(invalid)).toBe(false);
  });

  it('requires an explicit polarRadiusRatio for every body', () => {
    const invalid = cloneCatalog() as unknown as {
      bodies: Array<{ visual: { polarRadiusRatio?: number } }>;
    };
    const body = invalid.bodies[0];
    if (body === undefined) throw new Error('Body catalog fixture must not be empty');
    delete body.visual.polarRadiusRatio;

    expect(validate(invalid)).toBe(false);
  });
});
