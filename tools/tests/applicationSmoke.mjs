import { runApplicationSmokeContract } from '../smoke/applicationSmokeContract.mjs';

const result = await runApplicationSmokeContract({
  fixtureOnly: process.argv.includes('--fixture-runtime-error'),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
