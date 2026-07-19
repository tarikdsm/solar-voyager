# Stable Retained-Heap Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the retained-heap CI classifier robust to one narrow forced-GC
outlier without changing the 196,608-byte ceiling or allowing persistent frame-
loop growth.

**Architecture:** Pure utilities decide whether a primary heap sample passes,
fails immediately, or requires confirmation. The Playwright harness collects one
additional 30-second window only for a narrow primary failure, on the same
already-stabilized page, and validates the confirmation against the original
ceiling.

**Tech Stack:** Node.js 22 ESM, Playwright 1.61, Chromium precise heap metrics,
Vitest 4, GitHub Actions.

## Global Constraints

- Keep `tools/perf/performance-golden.json` byte-for-byte unchanged.
- Keep the production observation duration at 30,000 ms per window.
- A primary delta at or below 196,608 B passes directly.
- A primary delta above 245,760 B fails immediately.
- A primary delta in `(196,608 B, 245,760 B]` gets exactly one confirmation.
- Confirmation passes only at or below the original 196,608 B ceiling.
- Invalid/unavailable metrics fail closed.
- The retained-allocation fixture never receives confirmation and must fail.
- Do not alter draw-call, triangle, bundle, or asset budgets.

---

### Task 1: Pure heap-confirmation decisions

**Files:**

- Modify: `tools/perf/performanceGateUtils.test.mjs`
- Modify: `tools/perf/performanceGateUtils.mjs`

**Interfaces:**

- Produces: `classifyHeapConfirmation(measurement, maxRetainedGrowthBytes)`
  returning `'pass' | 'confirm' | 'fail'`
- Produces: `validateConfirmedHeapGrowth(primary, confirmation,
  maxRetainedGrowthBytes)` returning `string[]`
- Preserves: `validateHeapGrowth(measurement, maxRetainedGrowthBytes)`

- [x] **Step 1: Write failing classifier tests**

Add these cases beside `validateHeapGrowth` tests:

```js
describe('classifyHeapConfirmation', () => {
  const ceiling = 196_608;

  it('passes the original inclusive ceiling and confirms only the narrow band', () => {
    expect(classifyHeapConfirmation({ beforeBytes: 10_000_000, afterBytes: 10_196_608 }, ceiling)).toBe('pass');
    expect(classifyHeapConfirmation({ beforeBytes: 10_000_000, afterBytes: 10_196_609 }, ceiling)).toBe('confirm');
    expect(classifyHeapConfirmation({ beforeBytes: 10_000_000, afterBytes: 10_245_760 }, ceiling)).toBe('confirm');
    expect(classifyHeapConfirmation({ beforeBytes: 10_000_000, afterBytes: 10_245_761 }, ceiling)).toBe('fail');
  });

  it('fails closed for unavailable or malformed metrics', () => {
    expect(classifyHeapConfirmation({ beforeBytes: null, afterBytes: null }, ceiling)).toBe('fail');
    expect(classifyHeapConfirmation({ beforeBytes: 1, afterBytes: Number.NaN }, ceiling)).toBe('fail');
    expect(classifyHeapConfirmation({ beforeBytes: 1, afterBytes: 2 }, -1)).toBe('fail');
  });
});
```

Add confirmed validation cases:

```js
describe('validateConfirmedHeapGrowth', () => {
  const ceiling = 196_608;
  const primary = { beforeBytes: 10_000_000, afterBytes: 10_210_000 };

  it('accepts a narrow primary outlier only after an in-budget confirmation', () => {
    expect(validateConfirmedHeapGrowth(
      primary,
      { beforeBytes: 10_210_000, afterBytes: 10_300_000 },
      ceiling,
    )).toEqual([]);
  });

  it('rejects a repeated narrow failure and a missing confirmation', () => {
    expect(validateConfirmedHeapGrowth(
      primary,
      { beforeBytes: 10_210_000, afterBytes: 10_420_000 },
      ceiling,
    )).toEqual([
      'Confirmed retained heap growth must be <= 196,608 bytes; measured 210,000 bytes.',
    ]);
    expect(validateConfirmedHeapGrowth(primary, null, ceiling)).toEqual([
      'Narrow retained heap failure requires a confirmation measurement.',
    ]);
  });

  it('does not let confirmation rescue a large primary failure', () => {
    expect(validateConfirmedHeapGrowth(
      { beforeBytes: 10_000_000, afterBytes: 10_300_000 },
      { beforeBytes: 10_300_000, afterBytes: 10_300_000 },
      ceiling,
    )).toEqual([
      'Retained heap growth must be <= 196,608 bytes; measured 300,000 bytes.',
    ]);
  });
});
```

- [x] **Step 2: Run the utility tests and verify RED**

```powershell
npx vitest run tools/perf/performanceGateUtils.test.mjs
```

Expected: import/export failure because both confirmation helpers are absent.

- [x] **Step 3: Implement the pure decisions**

Add a fixed factor without changing the golden:

```js
const HEAP_CONFIRMATION_FACTOR = 1.25;

export function classifyHeapConfirmation(measurement, maxRetainedGrowthBytes) {
  if (validateHeapGrowth(measurement, maxRetainedGrowthBytes).length === 0) return 'pass';
  if (
    measurement.beforeBytes === null ||
    measurement.afterBytes === null ||
    !validNonnegativeNumber(measurement.beforeBytes) ||
    !validNonnegativeNumber(measurement.afterBytes) ||
    !Number.isInteger(maxRetainedGrowthBytes) ||
    maxRetainedGrowthBytes < 0
  ) {
    return 'fail';
  }
  const growthBytes = measurement.afterBytes - measurement.beforeBytes;
  return growthBytes <= maxRetainedGrowthBytes * HEAP_CONFIRMATION_FACTOR ? 'confirm' : 'fail';
}

export function validateConfirmedHeapGrowth(primary, confirmation, maxRetainedGrowthBytes) {
  const decision = classifyHeapConfirmation(primary, maxRetainedGrowthBytes);
  if (decision === 'pass') return [];
  if (decision === 'fail') return validateHeapGrowth(primary, maxRetainedGrowthBytes);
  if (confirmation === null) {
    return ['Narrow retained heap failure requires a confirmation measurement.'];
  }
  return validateHeapGrowth(confirmation, maxRetainedGrowthBytes).map((finding) =>
    finding.replace('Retained heap growth', 'Confirmed retained heap growth'),
  );
}
```

- [x] **Step 4: Run focused tests and verify GREEN**

```powershell
npx vitest run tools/perf/performanceGateUtils.test.mjs
```

Expected: every performance utility test passes, including the unchanged base
validator and budget parsers.

- [x] **Step 5: Commit the pure decision layer**

```powershell
git add tools/perf/performanceGateUtils.mjs tools/perf/performanceGateUtils.test.mjs
git commit -m "test(perf): [T0095] classify narrow heap outliers"
```

---

### Task 2: Conditional same-page confirmation

**Files:**

- Modify: `tools/perf/performanceGate.mjs`
- Modify: `docs/performance-spec.md`

**Interfaces:**

- Consumes: `classifyHeapConfirmation` and `validateConfirmedHeapGrowth`
- Produces: `production.confirmationHeap`, either a heap measurement or `null`
- Preserves: allocation fixture, draw fixture, bundle and workload result shapes

- [x] **Step 1: Add an executable confirmation hook before production code**

Extract one window so both samples use identical mechanics:

```js
async function measureHeapWindow(page, durationMs, label) {
  const beforeBytes = await forceGc(page);
  console.log(`Performance gate measuring: ${label}`);
  await page.waitForTimeout(durationMs);
  const afterBytes = await forceGc(page);
  console.log(`Performance gate measured: ${label}`);
  return { afterBytes, beforeBytes, deltaBytes: afterBytes - beforeBytes };
}
```

Change `measurePage` to accept `confirmationCeilingBytes = null`. After the
primary window, classify and collect exactly one confirmation only when asked:

```js
const heap = await measureHeapWindow(page, durationMs, label);
let confirmationHeap = null;
if (
  confirmationCeilingBytes !== null &&
  classifyHeapConfirmation(heap, confirmationCeilingBytes) === 'confirm'
) {
  confirmationHeap = await measureHeapWindow(page, durationMs, `${label} confirmation`);
}
return { confirmationHeap, heap, workload };
```

Pass `golden.heap.maxRetainedGrowthBytes` only for production. Pass `null` for
the allocation fixture. Replace production validation with:

```js
const heapFindings = validateConfirmedHeapGrowth(
  production.heap,
  production.confirmationHeap,
  golden.heap.maxRetainedGrowthBytes,
);
```

- [x] **Step 2: Run the production-only gate**

```powershell
npm run build
npm run test:perf-gates -- --production-only
```

Expected: exit 0. JSON contains `confirmationHeap: null` for a direct pass or a
second 30-second measurement for a confirmed pass. The reported ceiling remains
196,608 B.

- [x] **Step 3: Run the complete gate with negative controls**

```powershell
npm run test:perf-gates
```

Expected: exit 0; production passes, allocation fixture reports a retained heap
finding, draw fixture reports draw/triangle findings, and neither fixture is
accepted as production.

- [x] **Step 4: Document the measurement semantics**

Append to performance spec section 6:

```markdown
A production sample that exceeds the fixed heap ceiling by no more than 25% is
confirmed with one independent same-page window of the same duration. The
confirmation must meet the original ceiling; larger or repeated failures fail.
The known retained-allocation fixture is never eligible for confirmation.
```

- [x] **Step 5: Run focused and repository gates**

```powershell
npx vitest run tools/perf/performanceGateUtils.test.mjs
npm test
npm run lint
npm run typecheck
npm run format:check
npm run build
npm run check:tasks
git diff --check
```

Expected: all commands exit 0 with no new skip or budget change.

- [x] **Step 6: Commit the integrated gate**

```powershell
git add tools/perf/performanceGate.mjs docs/performance-spec.md
git commit -m "fix(perf): [T0095] confirm narrow heap gate failures"
```

---

### Task 3: Dashboard, review, and delivery

**Files:**

- Modify: `docs/check_plan.html`
- Modify: `tasks/T0095-stable-heap-growth-gate.yaml`
- Modify: `docs/superpowers/plans/2026-07-18-stable-heap-growth-gate.md`

**Interfaces:**

- Produces: complete T0095 handoff, REVIEW/DONE transitions, and green CI
- Preserves: every existing dashboard task object and non-task roadmap action

- [x] **Step 1: Rebase and reconcile the dashboard owner first**

Fetch `origin/main` and inspect both the T0094 branch and any local/user-owned
`docs/check_plan.html` diff. Do not overwrite a newer dashboard snapshot. Rebase
onto the latest merged owner version, then regenerate or minimally append the
canonical T0095 object from its YAML so it occurs exactly once and remains
unchecked until `status: DONE`.

- [x] **Step 2: Validate the inventory and task schema**

```powershell
npm run check:tasks
@'
from pathlib import Path
html = Path('docs/check_plan.html').read_text(encoding='utf-8')
assert html.count('"id":"T0095"') == 1
assert html.count('"id":"T0094"') == 1
'@ | python -
```

Expected: 54 task files validate and each newest task id occurs exactly once.

- [x] **Step 3: Request independent exact-head review**

The different reviewer verifies the unchanged golden, classifier boundaries,
same-page independence, fail-closed behavior, negative fixture, JSON evidence,
spec wording, dashboard reconciliation, and full gates. Address every finding
with a failing test before production changes.

- [ ] **Step 4: Move T0095 to REVIEW and publish**

Fill `handoff_notes` with primary/confirmation values, negative-control values,
commands, exact review SHA/verdict, and the T0085 CI runs that motivated the
task. Flip `IN_PROGRESS -> REVIEW`, commit, rebase onto `origin/main`, push, and
open PR `[T0095] Stable retained-heap CI confirmation`.

- [ ] **Step 5: Complete after green CI**

After the PR check passes, flip `REVIEW -> DONE`, push, wait for the final check,
merge with a merge commit while retaining the branch, and fetch `origin/main`.
Then rebase T0085 on the merged fix and rerun its required CI.
