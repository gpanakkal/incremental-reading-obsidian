// @ts-check
// Builds the copy review report (`scripts/ui-text-diff.mjs`) from a checkout's
// git history. Its own module so that `pnpm release` can rebuild the report
// for its pre-flight without running the copy-diff command line.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { reportHeading } from './copy-review.mjs';
import { diffCopy, escapeMd, extractCopy, wordDiff } from './ui-text.mjs';

/** @param {string} repo */
const gitIn =
  (repo) =>
  (/** @type {string[]} */ ...a) =>
    execFileSync('git', ['-C', repo, ...a], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
const isCode = (/** @type {string} */ f) =>
  /^src\/.*\.tsx?$/.test(f) && !/\.test\.tsx?$|\/(test|__mocks__)\//.test(f);
const isDoc = (/** @type {string} */ f) =>
  /\.md$/.test(f) && !/^(plans|e2e-tests)\//.test(f);

/**
 * Links VS Code's Markdown preview opens at the line, relative to the file
 * the report is written to (or to the repo when it goes to stdout).
 * @param {string} repo @param {string | undefined} outFile
 */
function linker(repo, outFile) {
  const base = outFile ? path.relative(path.dirname(outFile), repo) : '';
  return (/** @type {string} */ file, /** @type {number} */ line) => {
    const target = path.posix.join(base.split(path.sep).join('/'), file);
    const href = path.isAbsolute(base) ? `file:///${target}` : target;
    return `[${path.basename(file)}:${line}](${encodeURI(href)}#L${line})`;
  };
}

/**
 * Counts of the copy in a checkout's `src/`, by kind and by file.
 * @param {{ repo: string }} options
 */
export function inventoryReport({ repo }) {
  const files = gitIn(repo)('ls-files', 'src').split('\n').filter(isCode);
  /** @type {Record<string, number>} */
  const byKind = {};
  const byFile = files.map((f) => {
    const entries = extractCopy(readFileSync(path.join(repo, f), 'utf8'), f);
    for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    return {
      f,
      n: entries.length,
      sure: entries.filter((e) => e.kind !== 'prose?').length,
    };
  });
  const md = [
    `# UI copy inventory (${files.length} source files)`,
    '',
    '| Kind | Count |',
    '| --- | --- |',
  ];
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1]))
    md.push(`| ${k} | ${n} |`);
  md.push('', '| File | Sink strings | + prose? |', '| --- | --- | --- |');
  for (const { f, n, sure } of byFile
    .sort((a, b) => b.n - a.n)
    .filter((x) => x.n))
    md.push(`| ${f} | ${sure} | ${n - sure} |`);
  return md.join('\n') + '\n';
}

/**
 * The copy review report for a range: `<base>..<head>`, `<base>` against the
 * working tree (untracked files included), `--cached` (HEAD against the
 * index), or the latest tag..HEAD when no range is given. The heading names
 * the range as given, the latest tag resolved, so the report can be rebuilt.
 * @param {{ repo: string, range?: string, outFile?: string }} options
 */
export function buildReport({ repo, range: spec, outFile }) {
  const git = gitIn(repo);
  const link = linker(repo, outFile);
  const cached = spec === '--cached';
  /** @type {[string, string | undefined]} */
  const [base, head] = cached
    ? ['HEAD', ':']
    : spec
      ? /** @type {[string, string | undefined]} */ (spec.split('..'))
      : [git('describe', '--tags', '--abbrev=0').trim(), 'HEAD'];
  /** @param {string | undefined} rev @param {string} file */
  const read = (rev, file) => {
    if (rev === undefined) return readFileSync(path.join(repo, file), 'utf8');
    try {
      return git('show', rev === ':' ? `:${file}` : `${rev}:${file}`);
    } catch {
      return ''; // absent on that side: added or deleted
    }
  };
  const range = cached ? '--cached' : head ? `${base}..${head}` : base;
  const diffArgs = cached ? ['--cached'] : head ? [base, head] : [base];
  const status = git('diff', '--name-status', '-M', ...diffArgs)
    .split('\n')
    .filter(Boolean);
  if (!cached && !head)
    for (const f of git('ls-files', '--others', '--exclude-standard')
      .split('\n')
      .filter(Boolean))
      status.push(`A\t${f}`);
  const files = status
    .map((l) => l.split('\t'))
    .map(([s, a, b]) => ({ s, oldPath: s === 'A' ? '' : a, file: b ?? a }));
  const code = files.filter((f) => isCode(f.file));
  /** @type {Record<string, number>} */
  const tally = { changed: 0, added: 0, removed: 0, 'prose?': 0, docs: 0 };
  /** @type {string[]} */
  const body = [];
  // a line break inside the copy would end the list entry
  const oneLine = (/** @type {string} */ s) => s.replace(/\r?\n/g, '↵');
  for (const { s, oldPath, file } of code) {
    const before = oldPath ? extractCopy(read(base, oldPath), oldPath) : [];
    const after = s === 'D' ? [] : extractCopy(read(head, file), file);
    const changes = diffCopy(before, after);
    if (!changes.length) continue;
    body.push(`### ${file}`, '');
    for (const c of changes) {
      tally[c.change]++;
      if (c.kind === 'prose?') tally['prose?']++;
      const at = c.new
        ? link(file, c.new.line)
        : `${oldPath}:${c.old?.line} (gone)`;
      const scope = (c.new ?? c.old)?.scope;
      body.push(
        `- [ ] **${c.change}** \`${c.kind}\` ${at}${scope ? ` in \`${scope}\`` : ''}`
      );
      const w = c.old && c.new ? wordDiff(c.old.text, c.new.text) : undefined;
      if (c.old)
        body.push(`  - old: ${oneLine(w?.old ?? escapeMd(c.old.text))}`);
      if (c.new)
        body.push(`  - new: ${oneLine(w?.new ?? escapeMd(c.new.text))}`);
    }
    body.push('');
  }
  const docs = files.filter((f) => isDoc(f.file));
  if (docs.length) body.push('## Docs', '');
  for (const { file } of docs) {
    const patch = git(
      'diff',
      '-U0',
      '--word-diff=plain',
      ...diffArgs,
      '--',
      file
    );
    body.push(`### ${file}`, '');
    // one entry per hunk, its text as git's word diff: [-removed-]{+added+}
    for (const hunk of patch.split(/^(?=@@ )/m).slice(1)) {
      const [header, ...text] = hunk.trimEnd().split('\n');
      const line = Number(/\+(\d+)/.exec(header)?.[1] ?? 1);
      tally.docs++;
      // longer than any backtick run in the hunk, so a fence in the doc can't close it
      const runs = text.join('\n').match(/`+/g) ?? [];
      const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
      body.push(
        `- [ ] ${link(file, line)}`,
        `  ${fence}text`,
        ...text.map((l) => `  ${l}`),
        `  ${fence}`
      );
    }
    body.push('');
  }
  return (
    [
      reportHeading(range),
      '',
      `${tally.changed} changed, ${tally.added} added, ${tally.removed} removed across ${code.length} changed source files; ${tally['prose?']} of them \`prose?\` (prose-like, outside known sinks: check they are shown). ${tally.docs} docs hunks in ${docs.length} files.`,
      '',
      'Tick each entry once its wording is right. Rerunning keeps the ticks.',
      '',
      ...body,
    ].join('\n') + '\n'
  );
}
