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
    expect(workflow.match(/^\s*run: npm run check:dashboard\s*$/gmu)).toHaveLength(1);
    expect(workflow).toContain(
      "- name: Public release readiness check\n        if: github.event_name == 'pull_request'\n        run: npm run check:release",
    );
    expect(workflow).toContain(
      "- name: Final public release readiness check\n        if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n        run: npm run check:release -- --final",
    );
    expect(workflow).toContain(
      '- name: Third-party license notices\n        run: npm run check:licenses -- --dist',
    );
    expect(workflow.match(/^\s*run: npm run check:release\s*$/gmu)).toHaveLength(1);
    expect(workflow.match(/^\s*run: npm run check:release -- --final\s*$/gmu)).toHaveLength(1);
    expect(workflow).toContain('actions/setup-python@v5');
    expect(workflow.match(/^\s*run: npm run test:tools\s*$/gmu)).toHaveLength(1);
    expect(workflow.match(/^\s*run: npm run test:trajectory-overlay\s*$/gmu)).toHaveLength(1);
    expect(workflow.match(/^\s*run: npm run test:relativistic-visuals\s*$/gmu)).toHaveLength(1);
    expect(workflow).toContain(
      '- name: Application smoke\n        timeout-minutes: 5\n        run: npm run test:smoke',
    );
    expect(workflow).toContain(
      '- name: Trajectory overlay regression\n        timeout-minutes: 4\n        run: npm run test:trajectory-overlay',
    );
    expect(workflow).toContain(
      '- name: Relativistic visuals regression\n        timeout-minutes: 2\n        run: npm run test:relativistic-visuals',
    );
    expect(workflow.match(/^\s*run: npm run format:check\s*$/gmu)).toHaveLength(1);
    expect(workflow).toContain('python-version: "3.9"');
  });
});
