// @ts-check
// The release copy review worksheet: `plans/<release>-copy.md`, written by
// `pnpm run copy-diff` and checked by `pnpm release`. Each change in it is a
// `- [ ]` entry the user ticks once its wording is right.

/** Repo-relative path of the worksheet for a release. @param {string} version */
export const copyReviewPath = (version) => `plans/${version}-copy.md`;

const ENTRY = /^- \[([ xX])\] /;

/**
 * Every entry in a worksheet: its `### file` section and text, less line
 * numbers (which shift between runs), so the same change matches across runs.
 * @param {string} markdown
 */
function entries(markdown) {
  const lines = markdown.split('\n');
  let section = '';
  /** @type {{ key: string, done: boolean, at: number }[]} */
  const out = [];
  lines.forEach((line, i) => {
    if (line.startsWith('### ')) section = line;
    const match = ENTRY.exec(line);
    if (!match) return;
    let end = i + 1;
    while (end < lines.length && lines[end].startsWith('  ')) end++;
    const body = [line.slice(6), ...lines.slice(i + 1, end)]
      .join('\n')
      .replace(/:\d+\]\([^)]*\)|:\d+ \(gone\)/g, '');
    out.push({ key: `${section}\n${body}`, done: match[1] !== ' ', at: i });
  });
  return out;
}

/**
 * `next` with the entries already ticked in `previous` ticked again, so
 * rerunning the report mid-review keeps the user's progress. Each tick carries
 * over once: two identical entries need two ticks.
 * @param {string} previous @param {string} next
 */
export function carryChecks(previous, next) {
  /** @type {Map<string, number>} */
  const ticked = new Map();
  for (const { key, done } of entries(previous))
    if (done) ticked.set(key, (ticked.get(key) ?? 0) + 1);
  const lines = next.split('\n');
  for (const { key, at } of entries(next)) {
    const left = ticked.get(key) ?? 0;
    if (!left) continue;
    ticked.set(key, left - 1);
    lines[at] = lines[at].replace(ENTRY, '- [x] ');
  }
  return lines.join('\n');
}

/** How many entries of a worksheet are not ticked yet. @param {string} markdown */
export const uncheckedCount = (markdown) =>
  entries(markdown).filter((e) => !e.done).length;

/** The worksheet's first line, naming the range it lists. @param {string} range */
export const reportHeading = (range) => `# UI copy changes: \`${range}\``;

/**
 * The range a worksheet was made for, as its heading names it, or undefined
 * for a worksheet without one.
 * @param {string} markdown
 */
export function reportRange(markdown) {
  return /^# UI copy changes: `([^`\r\n]+)`$/m.exec(markdown)?.[1];
}

/**
 * How many entries of a fresh report have no tick in the reviewed worksheet:
 * copy that changed or turned up after the review.
 * @param {string} reviewed @param {string} fresh
 */
export const unreviewedCount = (reviewed, fresh) =>
  uncheckedCount(carryChecks(reviewed, fresh));

/** The patch release after `version`, or undefined unless it is `x.y.z`. @param {string} version */
export function nextPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : undefined;
}
