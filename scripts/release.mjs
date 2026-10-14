/**
 * Bump the version, commit, tag, and push a release.
 *
 * Usage:
 *   pnpm release 1.2.3
 */
import { execFileSync, execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline/promises';

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function fail(message) {
	console.error(message);
	process.exit(1);
}

function git(...args) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const version = process.argv[2];
if (!version) fail('Usage: pnpm release <version>');
if (!SEMVER.test(version)) fail(`"${version}" is not a valid semver version.`);

const pkgText = readFileSync('package.json', 'utf8');
const pkg = JSON.parse(pkgText);
const previous = pkg.version;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
	`About to release ${version}. Previous version is ${previous}. Please confirm (y/n) `
);
rl.close();
if (answer.trim().toLowerCase() !== 'y') fail('Release cancelled.');

if (git('status', '--porcelain') !== '') {
	fail(
		'Working tree is not clean. Commit, stash, or remove staged, unstaged, and untracked changes first.'
	);
}

if (git('tag', '--list', version) !== '') fail(`Tag ${version} already exists.`);

pkg.version = version;
const trailingNewline = pkgText.endsWith('\n') ? '\n' : '';
writeFileSync('package.json', JSON.stringify(pkg, null, '\t') + trailingNewline);

execSync('pnpm run version', { stdio: 'inherit' });

git('add', 'package.json');
git('commit', '-m', 'chore: increment version');
git('tag', '-a', version, '-m', version);
execFileSync('git', ['push', '--atomic', 'origin', 'HEAD', `refs/tags/${version}`], {
	stdio: 'inherit',
});

console.log(`Released ${version}.`);
