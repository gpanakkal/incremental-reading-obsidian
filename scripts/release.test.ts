import fc from 'fast-check';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The release script is driven as a child process against a throwaway git
// checkout, never this repo: it reads its worksheet from the checkout that
// holds the script, and everything past the confirm prompt commits, tags and
// pushes. Every run answers the prompt `n`, and the fixture has no remote.

// #region HELPERS
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const VERSION = '9.9.9';
const WORKSHEET = `plans/${VERSION}-copy.md`;
const RERUN = `pnpm run copy-diff --release ${VERSION}`;
const PROMPT = /About to release/;

/** The parent's env less git's own variables, so a hook's GIT_DIR can't aim git at this repo. */
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

let fixture: string;

function run(cmd: string, args: string[], input?: string) {
  return spawnSync(cmd, args, {
    cwd: fixture,
    env: childEnv,
    input,
    encoding: 'utf8',
  });
}

function git(...args: string[]) {
  const r = run('git', args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** `pnpm release 9.9.9`, answering the confirm prompt `n` if it gets that far. */
const release = (): SpawnSyncReturns<string> =>
  run(process.execPath, ['scripts/release.mjs', VERSION], 'n\n');

const typescriptLink = () => path.join(fixture, 'node_modules/typescript');
const worksheetFile = () => path.join(fixture, WORKSHEET);
const writeWorksheet = (text: string) => writeFileSync(worksheetFile(), text);

/** Each source file's copy after the tag: one added notice per line. */
const NOTICES = [
  'Moved the article to the archive',
  'Could not read the snippet file',
  'Scheduled the card for tomorrow',
  'Dismissed the item from review',
];

/** The worksheet copy-diff wrote for the fixture, every entry still unticked. */
let freshWorksheet: string;

const ENTRY = /^- \[ \] /gm;
const tickAll = (md: string) => md.replace(ENTRY, '- [x] ');

/** `md` with the entries at `untickedAt` (0-based) left unticked, the rest ticked. */
function tickAllBut(md: string, untickedAt: number[]) {
  let i = 0;
  return md.replace(ENTRY, (m) => (untickedAt.includes(i++) ? m : '- [x] '));
}

/** What a refusal before the prompt looks like: exit 1, prompt never shown. */
function expectRefusedBeforePrompt(r: SpawnSyncReturns<string>) {
  expect(r.status).toBe(1);
  expect(r.stdout).not.toMatch(PROMPT);
  expect(r.stderr).toContain(WORKSHEET);
  expect(r.stderr).toContain(RERUN);
}
// #endregion

beforeAll(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'ir-release-'));
  git('init', '-q');
  // the fixture's own identity and no signing, whatever the machine's config
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  // `.mjs` copies, so the script's own repo root is the fixture
  mkdirSync(path.join(fixture, 'scripts'));
  cpSync(
    path.join(repoRoot, 'scripts/release.mjs'),
    path.join(fixture, 'scripts/release.mjs')
  );
  cpSync(
    path.join(repoRoot, 'scripts/ui-text-diff.mjs'),
    path.join(fixture, 'scripts/ui-text-diff.mjs')
  );
  cpSync(
    path.join(repoRoot, 'scripts/lib'),
    path.join(fixture, 'scripts/lib'),
    {
      recursive: true,
      filter: (src) => !src.endsWith('.test.ts'),
    }
  );
  // `typescript` for the copy extractor, linked at its real path: pnpm's links
  // in node_modules are relative, and Windows resolves them against the path
  // they were reached by, so linking node_modules itself would leave them
  // dangling. A junction needs no elevation on Windows.
  mkdirSync(path.join(fixture, 'node_modules'));
  symlinkSync(
    realpathSync(path.join(repoRoot, 'node_modules/typescript')),
    typescriptLink(),
    'junction'
  );
  writeFileSync(path.join(fixture, '.gitignore'), 'node_modules\nplans/\n');
  writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, '\t') + '\n'
  );
  mkdirSync(path.join(fixture, 'src'));
  writeFileSync(path.join(fixture, 'src/a.ts'), 'export const x = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('tag', '1.0.0');
  writeFileSync(
    path.join(fixture, 'src/a.ts'),
    NOTICES.map((n, i) => `export const f${i} = () => notify('${n}');\n`).join(
      ''
    )
  );
  git('commit', '-q', '-am', 'copy');

  const made = run(process.execPath, [
    'scripts/ui-text-diff.mjs',
    '--release',
    VERSION,
  ]);
  if (made.status !== 0) throw new Error(`copy-diff: ${made.stderr}`);
  freshWorksheet = readFileSync(worksheetFile(), 'utf8');
}, 60_000);

afterAll(() => {
  if (!fixture) return;
  // drop the link first, so removing the fixture can never reach the real package
  if (existsSync(typescriptLink())) unlinkSync(typescriptLink());
  rmSync(fixture, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(worksheetFile(), { force: true });
});

// each case spawns node, so a loaded machine can take longer than the default
describe('release pre-flight', { timeout: 30_000 }, () => {
  it('lists one entry per copy change in the fixture', () => {
    // guards the cases below against a fixture whose worksheet has nothing to tick
    expect(freshWorksheet.match(ENTRY)).toHaveLength(NOTICES.length);
  });

  it('refuses before the prompt while the worksheet is missing', () => {
    expectRefusedBeforePrompt(release());
  });

  it('refuses before the prompt while any entry is unticked, naming how many', () => {
    const indices = NOTICES.map((_, i) => i);
    fc.assert(
      fc.property(fc.subarray(indices, { minLength: 1 }), (untickedAt) => {
        writeWorksheet(tickAllBut(freshWorksheet, untickedAt));
        const r = release();
        expectRefusedBeforePrompt(r);
        expect(r.stderr).toMatch(
          new RegExp(`\\b${untickedAt.length} unticked\\b`)
        );
      }),
      { numRuns: 5 }
    );
  });

  it('refuses before the prompt when the worksheet names no range', () => {
    writeWorksheet(
      tickAll(freshWorksheet).replace(/^# UI copy changes:.*\n/, '')
    );
    expectRefusedBeforePrompt(release());
  });

  it('refuses before the prompt when the copy changed after the review', () => {
    // a reviewed entry whose text no longer matches what the range holds
    writeWorksheet(
      tickAll(freshWorksheet).replace(NOTICES[0], `${NOTICES[0]} again`)
    );
    const r = release();
    expectRefusedBeforePrompt(r);
    expect(r.stderr).toMatch(/\b1 entry is new or different\b/);
  });

  it('asks to confirm once every entry is ticked, and leaves the checkout alone on no', () => {
    const head = git('rev-parse', 'HEAD');
    const pkg = readFileSync(path.join(fixture, 'package.json'), 'utf8');
    writeWorksheet(tickAll(freshWorksheet));
    const r = release();
    expect(r.stdout).toMatch(PROMPT);
    expect(r.stdout).toContain(VERSION);
    expect(r.stdout).toContain('1.0.0');
    expect(r.status).toBe(1);
    expect(git('tag', '--list', VERSION)).toBe('');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(path.join(fixture, 'package.json'), 'utf8')).toBe(pkg);
  });
});
