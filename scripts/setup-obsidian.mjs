// @ts-check
// `pnpm run obsidian:setup`: runs the setup script for this platform,
// forwarding any arguments (e.g. `-CI` / `--ci`).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = (/** @type {string} */ name) =>
  fileURLToPath(new URL(name, import.meta.url));
const args = process.argv.slice(2);
const { status, error } =
  process.platform === 'win32'
    ? spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script('setup-obsidian.ps1'),
          ...args,
        ],
        { stdio: 'inherit' }
      )
    : spawnSync('bash', [script('setup-obsidian.sh'), ...args], {
        stdio: 'inherit',
      });
if (error) console.error(error.message);
process.exit(status ?? 1);
