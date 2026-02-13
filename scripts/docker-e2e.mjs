/**
 * Run e2e tests inside a Docker container that mirrors the Ubuntu CI environment.
 *
 * Usage:
 *   npm run e2e:docker                          # reads GH_TOKEN from .env
 *   GH_TOKEN=$(gh auth token) npm run e2e:docker
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '../..');
const resultsDir = resolve(projectRoot, 'e2e-tests/test-results');
const imageName = 'incremental-reading-e2e';

// Resolve GH_TOKEN: environment variable > .env file
let ghToken = process.env.GH_TOKEN ?? '';
if (!ghToken) {
  try {
    const env = readFileSync(resolve(projectRoot, '.env'), 'utf-8');
    ghToken = env.match(/^GH_TOKEN=(.+)$/m)?.[1] ?? '';
  } catch {
    // .env doesn't exist, that's fine
  }
}

if (!ghToken) {
  console.error('GH_TOKEN is required to download Obsidian.\n');
  console.error('Set it in .env:');
  console.error("  echo 'GH_TOKEN=your_token_here' > .env\n");
  console.error('Or pass it directly:');
  console.error('  GH_TOKEN=<token> npm run e2e:docker');
  process.exit(1);
}

const run = (cmd, args) => {
  console.log(`> ${cmd} ${args.join(' ')}\n`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: projectRoot });
};

mkdirSync(resultsDir, { recursive: true });

console.log('🐳 Building Docker image...');
run('docker', ['build', '-t', imageName, '-f', 'Dockerfile.e2e', '.']);

console.log('\n🧪 Running e2e tests in Docker...');
run('docker', [
  'run',
  '--rm',
  '--shm-size=1g',
  '-e',
  `GH_TOKEN=${ghToken}`,
  '-v',
  `${resultsDir}:/app/e2e-tests/test-results`,
  imageName,
]);

console.log('\n✅ Done. Test results available at e2e-tests/test-results/');
