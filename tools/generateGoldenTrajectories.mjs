import { spawnSync } from 'node:child_process';

const UPDATE_FLAG = '--update-goldens';

if (!process.argv.slice(2).includes(UPDATE_FLAG)) {
  console.error(`Refusing to regenerate golden trajectories without ${UPDATE_FLAG}`);
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'tests/golden/regenerateGoldenTrajectories.test.ts'],
  {
    cwd: process.cwd(),
    env: { ...process.env, SOLAR_VOYAGER_UPDATE_GOLDENS: 'explicitly-approved' },
    stdio: 'inherit',
  },
);

if (result.error !== undefined) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
