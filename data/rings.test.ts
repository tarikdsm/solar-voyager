import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as unknown;
}

describe('ring catalog schema', () => {
  it('validates the checked-in catalog against its versioned JSON Schema', () => {
    const schema = readJson('rings.schema.json');
    const catalog = readJson('rings.json');
    const validate = new Ajv2020({
      allErrors: true,
      formats: { uri: true },
      strict: true,
    }).compile(schema);

    expect(validate(catalog), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});
