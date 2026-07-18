import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = fileURLToPath(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
);

describe('CI workflow', () => {
  it('runs permanent project checks without scaffold conditions', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');

    expect(workflow).not.toContain('Detect scaffold');
    expect(workflow).not.toContain('steps.scaffold');
    expect(workflow).not.toContain('Docs-only repo');
    expect(workflow.match(/^\s*run: npm run check:budgets\s*$/gmu)).toHaveLength(1);
    expect(workflow.match(/^\s*run: npm run check:tasks\s*$/gmu)).toHaveLength(1);
    expect(workflow).toContain('actions/setup-python@v5');
    expect(workflow.match(/^\s*run: npm run test:tools\s*$/gmu)).toHaveLength(1);
    expect(workflow.match(/^\s*run: npm run test:trajectory-overlay\s*$/gmu)).toHaveLength(1);
    expect(workflow).toContain(
      '- name: Application smoke\n        timeout-minutes: 5\n        run: npm run test:smoke',
    );
    expect(workflow).toContain(
      '- name: Trajectory overlay regression\n        timeout-minutes: 4\n        run: npm run test:trajectory-overlay',
    );
    expect(workflow.match(/^\s*run: npm run format:check\s*$/gmu)).toHaveLength(1);
    expect(workflow).toContain('python-version: "3.9"');
  });
});
