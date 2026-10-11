// @ts-check
// Per-module mutation score: same as stryker.config.mjs, but only the tests
// colocated with the files given to --mutate run (src/lib/foo.ts ->
// src/lib/foo.test.ts), via Stryker's `testFiles` option. Comma-separated
// lists, mutation ranges (`:1-10`) and globs all map over; `!` patterns are dropped.
//   pnpm exec stryker run stryker.scoped.config.mjs --mutate src/lib/foo.ts
import base from './stryker.config.mjs';

/** @param {string[]} argv */
function mutateArgs(argv) {
  const patterns = [];
  argv.forEach((arg, i) => {
    if (arg === '--mutate' || arg === '-m') patterns.push(argv[i + 1] ?? '');
    else if (arg.startsWith('--mutate='))
      patterns.push(arg.slice('--mutate='.length));
  });
  return patterns.flatMap((list) => list.split(','));
}

/** @param {string} pattern */
function colocatedTest(pattern) {
  if (pattern.startsWith('!')) return undefined;
  const file = pattern.replace(/(:\d+(:\d+)?-\d+(:\d+)?)$/, '');
  const test = file.replace(/(\.\{[^}/]+\}|\.[^./]+)$/, '.test$1');
  return test === file ? undefined : test;
}

const testFiles = [
  ...new Set(
    mutateArgs(process.argv)
      .map(colocatedTest)
      .filter((t) => t !== undefined)
  ),
];
if (testFiles.length === 0) {
  throw new Error(
    'stryker.scoped.config.mjs needs --mutate <file>; use stryker.config.mjs for a full run'
  );
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = { ...base, testFiles };
export default config;
