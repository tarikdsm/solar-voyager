import { runApplicationSmokeContract } from '../smoke/applicationSmokeContract.mjs';

const result = await runApplicationSmokeContract({
  delayedFixtureOnly: process.argv.includes('--fixture-delayed-runtime-error'),
  fixtureOnly: process.argv.includes('--fixture-runtime-error'),
  productionOnly: process.argv.includes('--production-only'),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
