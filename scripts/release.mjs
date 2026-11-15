/**
 * Bump the version, commit, tag, and push a release.
 *
 * Usage:
 *   pnpm release 1.2.3
 */
import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { copyReviewPath, reportRange, uncheckedCount, unreviewedCount } from './lib/copy-review.mjs';
import { buildReport } from './lib/copy-report.mjs';

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

// The release copy review: every copy change since the last tag, ticked off.
const copyReview = copyReviewPath(version);
// from the repo root, wherever the script is run from
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const copyReviewFile = path.join(repoRoot, copyReview);
const rerun = `pnpm run copy-diff --release ${version}`;
if (!existsSync(copyReviewFile)) {
	fail(`${copyReview} is missing. Run \`${rerun}\` and review the copy first.`);
}
const reviewed = readFileSync(copyReviewFile, 'utf8');
const unticked = uncheckedCount(reviewed);
if (unticked > 0) {
	fail(
		`${copyReview} has ${unticked} unticked ${unticked === 1 ? 'entry' : 'entries'}. Review ${unticked === 1 ? 'it' : 'them'}, rerunning \`${rerun}\` if the copy changed since.`
	);
}
// The worksheet is only as current as the copy it was made from: rebuild the
// report for its range and check every entry still carries a tick.
const range = reportRange(reviewed);
if (range === undefined) {
	fail(`${copyReview} doesn't name the range it covers. Rerun \`${rerun}\` and review the copy.`);
}
const unreviewed = unreviewedCount(
	reviewed,
	buildReport({ repo: repoRoot, range, outFile: copyReviewFile })
);
if (unreviewed > 0) {
	fail(
		`The copy changed since ${copyReview} was reviewed: ${unreviewed} ${unreviewed === 1 ? 'entry is' : 'entries are'} new or different. Rerun \`${rerun}\` and review the unticked ${unreviewed === 1 ? 'one' : 'ones'}.`
	);
}

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
