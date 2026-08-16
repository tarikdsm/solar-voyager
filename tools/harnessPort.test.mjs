import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { HARNESS_PORT_SPAN, resolveHarnessPort, worktreeNameFor } from './harnessPort.mjs';

const MAIN = 'D:/repo';
const LANE_A = 'D:/repo/.worktrees/T0116';
const LANE_B = 'D:/repo/.worktrees/T0127';

describe('harness port isolation', () => {
  it('leaves a normal checkout on its historical port, which is what keeps CI identical', () => {
    assert.equal(resolveHarnessPort(4177, MAIN), 4177);
    assert.equal(worktreeNameFor(MAIN), null);
  });

  it('gives two worktrees different ports for the same harness', () => {
    assert.notEqual(resolveHarnessPort(4177, LANE_A), resolveHarnessPort(4177, LANE_B));
    assert.notEqual(resolveHarnessPort(4177, LANE_A), 4177);
  });

  it('is stable across calls, so a collision stays reproducible', () => {
    assert.equal(resolveHarnessPort(4177, LANE_A), resolveHarnessPort(4177, LANE_A));
  });

  it('keeps a lane internally collision-free for ports that differ on main', () => {
    // 4177 and 4178 are distinct harnesses; they must stay distinct after offsetting.
    assert.notEqual(resolveHarnessPort(4177, LANE_A), resolveHarnessPort(4178, LANE_A));
  });

  it('reserves a span wide enough for the whole 4174-4207 pool', () => {
    assert.ok(HARNESS_PORT_SPAN > 4207 - 4174);
  });

  it('recognises the worktree name regardless of separator', () => {
    assert.equal(worktreeNameFor(String.raw`D:\repo\.worktrees\T0131`), 'T0131');
  });
});
