// @ts-check
/**
 * Release copy review: lists every user-facing string and docs passage that
 * changed in a range, as a Markdown worksheet with a `- [ ]` per change and
 * `file#Lline` links (VS Code's Markdown preview opens them at the line).
 *
 * Usage:
 *   pnpm run copy-diff                     latest tag..HEAD → plans/<release>-copy.md
 *   pnpm run copy-diff <base>..<head>      a range of commits
 *   pnpm run copy-diff <base>              <base> against the working tree (untracked included)
 *   pnpm run copy-diff --cached [-C <tree>]  HEAD against the index, e.g. a task worktree
 *   pnpm run copy-diff --inventory         count the copy in src/ by kind and file
 *
 * Options:
 *   --release <version>  names the worksheet; defaults to the checked-out branch
 *                        when it is a version (release branches are, e.g. 0.8.3)
 *   --out <file>         write there instead; `--out -` prints to stdout
 *   -C <repo>            run against another checkout or worktree
 *
 * Rerunning keeps the ticks of entries that are still in the report, so it is
 * safe mid-review. `pnpm release <version>` refuses to run while
 * `plans/<version>-copy.md` is missing or has unticked entries, and rebuilds
 * the report for the range in its heading to refuse when copy changed after
 * it was ticked.
 *
 * What counts as copy: strings in a known sink (see `lib/ui-copy-sinks.mjs`,
 * shared with the Stryker `ui-strings` ignorer, plus JSX text and copy
 * attributes), and `prose?`: prose-like strings anywhere else, which is how
 * copy built in helpers shows up. Sentences assembled from pieces show up as
 * pieces; text made at runtime (dates, intervals) shows as its template.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildReport, inventoryReport } from './lib/copy-report.mjs';
import { carryChecks, copyReviewPath, nextPatch } from './lib/copy-review.mjs';

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const repo = path.resolve(flag('-C') ?? '.');
const release = flag('--release');
const outArg = flag('--out');
const inventory = args.includes('--inventory');
const cached = args.includes('--cached');

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The release after the one in the manifest, to suggest when none is given. */
function suggestedRelease() {
  try {
    const { version } = JSON.parse(
      readFileSync(path.join(repo, 'manifest.json'), 'utf8')
    );
    return typeof version === 'string' ? nextPatch(version) : undefined;
  } catch {
    return undefined;
  }
}

/** Where the report goes: a path, or undefined for stdout. */
function outPath() {
  if (outArg === '-' || (inventory && !outArg)) return undefined;
  if (outArg) return path.resolve(outArg);
  const version =
    release ??
    execFileSync('git', ['-C', repo, 'branch', '--show-current'], {
      encoding: 'utf8',
    }).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    const next = suggestedRelease();
    fail(
      `"${version}" is not a release version; pass --release <version>${next ? ` (the next patch is ${next})` : ''} to name the worksheet, or --out <file>.`
    );
  }
  return path.join(repo, copyReviewPath(version));
}
const outFile = outPath();

let text = inventory
  ? inventoryReport({ repo })
  : buildReport({
      repo,
      range: cached ? '--cached' : args.find((a) => !a.startsWith('-')),
      outFile,
    });
if (outFile) {
  if (existsSync(outFile))
    text = carryChecks(readFileSync(outFile, 'utf8'), text);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, text);
  console.log(`Wrote ${path.relative(process.cwd(), outFile) || outFile}`);
} else process.stdout.write(text);
