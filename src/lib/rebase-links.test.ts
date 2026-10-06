import {
  makeLinkVault,
  cachePosition as position,
  sectionsOf,
  type LinkFormat,
} from '#/test/link-vault';
import fc from 'fast-check';
import type { FrontmatterLinkCache, ReferenceCache, TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import {
  applyFrontmatterLinkEdits,
  rebaseLinks,
  resolveLinks,
  type LinkCacheSnapshot,
} from './rebase-links';

// #region HELPERS
const NBSP = String.fromCharCode(0xa0);
const FOLDERS = ['', 'a', 'b', 'a/b', 'a/c', 'b/a', 'ab'] as const;
/**
 * Names as notes and files have them: spaces, dots, brackets, a `%`, and a
 * letter that has a decomposed form, which a link may spell either way.
 */
const NAMES = [
  'x',
  'y',
  'Note',
  'x y',
  'x.y',
  'Note (1)',
  '50% off',
  `Caf${String.fromCharCode(0xe9)}`,
] as const;
const EXTENSIONS = ['md', 'md', 'pdf', 'png'] as const;

const folderOf = (path: string) => path.substring(0, path.lastIndexOf('/'));
const join = (folder: string, name: string) =>
  folder === '' ? name : `${folder}/${name}`;

/** A vault path: some folder, some name, some extension. */
const pathArb = (extensions: readonly string[] = EXTENSIONS) =>
  fc
    .tuple(
      fc.constantFrom(...FOLDERS),
      fc.constantFrom(...NAMES),
      fc.constantFrom(...extensions)
    )
    .map(([folder, name, extension]) => join(folder, `${name}.${extension}`));

type Form = 'wiki' | 'markdown' | 'angled';

/**
 * `target` as a markdown link holds it, so that Obsidian reads it back: its
 * `%` escaped, since Obsidian URL-decodes the target, and when bare, its
 * spaces, backslashes and control characters encoded as Obsidian encodes them
 * (`YE` in its bundle).
 */
function heldAs(form: Form, target: string): string {
  if (form === 'wiki') return target;
  const escaped = target.replace(/%/g, '%25');
  return form === 'angled'
    ? escaped
    : // eslint-disable-next-line no-control-regex -- the characters Obsidian encodes
      escaped.replace(/[\\\x00\x08\x0B\x0C\x0E-\x1F ]/g, (c) =>
        encodeURIComponent(c)
      );
}

/** A path as a link of `form` holding it is read: decoded, normalized. */
const readAs = (form: Form, held: string) =>
  (form === 'wiki' ? held : decodeURI(held)).normalize('NFC');

/** `target` relative to the folder `from`, as a note there would link it. */
function relativeTo(from: string, target: string, dotted: boolean): string {
  let up = '';
  let folder = from;
  while (folder !== '' && !target.startsWith(`${folder}/`)) {
    up += '../';
    folder = folderOf(folder);
  }
  const rest = folder === '' ? target : target.slice(folder.length + 1);
  return up === '' && dotted ? `./${rest}` : up + rest;
}

type Style = 'name' | 'relative' | 'dotted' | 'absolute' | 'rooted' | 'tail';

/** What a generated link is made of; see {@link writeLink}. */
interface LinkSpec {
  /** Index into the vault's files, -1 for the original, or a free path */
  target: number | string;
  style: Style;
  withMd: boolean;
  form: Form;
  embed: boolean;
  subpath: string;
  alias: string | null;
  /** A wikilink's alias after `\|`, as in a table */
  escapedPipe: boolean;
  /** Spaces inside a wikilink's brackets, which Obsidian trims */
  padded: boolean;
  /** The path in capitals, which Obsidian matches regardless */
  upper: boolean;
  /** The path decomposed, which Obsidian reads composed */
  decomposed: boolean;
}

const linkSpecArb: fc.Arbitrary<LinkSpec> = fc.record({
  target: fc.oneof(
    fc.nat({ max: 9 }),
    fc.constant(-1),
    fc.constantFrom('nowhere', 'a/nowhere', '../nowhere.md')
  ),
  style: fc.constantFrom<Style>(
    'name',
    'relative',
    'dotted',
    'absolute',
    'rooted',
    'tail'
  ),
  withMd: fc.boolean(),
  form: fc.constantFrom<Form>('wiki', 'markdown', 'angled'),
  embed: fc.boolean(),
  subpath: fc.constantFrom('', '', '#Heading', '#^block', '#A#B', '#x y'),
  alias: fc.option(fc.constantFrom('alias', 'x', 'ir-hide-title', 'A b', ''), {
    nil: null,
  }),
  escapedPipe: fc.boolean(),
  padded: fc.boolean(),
  upper: fc.boolean(),
  decomposed: fc.boolean(),
});

/** The path a link written in `style` from `from` gives for `path`. */
function linkpathFor(
  path: string,
  { style, withMd, upper }: LinkSpec,
  from: string
): string {
  const keepExtension = withMd || !path.endsWith('.md');
  const full = keepExtension ? path : path.slice(0, -'.md'.length);
  const written = (() => {
    switch (style) {
      case 'name':
        return full.slice(full.lastIndexOf('/') + 1);
      case 'relative':
      case 'dotted':
        return relativeTo(folderOf(from), full, style === 'dotted');
      case 'absolute':
        return full;
      case 'rooted':
        return `/${full}`;
      case 'tail':
        return full.split('/').slice(-2).join('/');
    }
  })();
  return upper ? written.toUpperCase() : written;
}

/**
 * A link as written, split around its path, and the `link` Obsidian's cache
 * gives it: path and subpath, decoded, trimmed, composed.
 */
interface WrittenLink {
  form: Form;
  before: string;
  path: string;
  after: string;
  link: string;
}

function writeLink(spec: LinkSpec, linkpath: string): WrittenLink {
  const { form, embed, subpath, alias } = spec;
  const bang = embed ? '!' : '';
  const link = (linkpath + subpath).trim();
  const path = heldAs(
    form,
    spec.decomposed ? linkpath.normalize('NFD') : linkpath
  );
  if (form === 'wiki') {
    const pad = spec.padded ? ' ' : '';
    const pipe = spec.escapedPipe ? '\\|' : '|';
    return {
      form,
      before: `${bang}[[${pad}`,
      path,
      after: `${subpath}${alias === null ? pad : `${pipe}${alias}`}]]`,
      link,
    };
  }
  const [open, close] = form === 'angled' ? ['<', '>'] : ['', ''];
  return {
    form,
    before: `${bang}[${alias ?? ''}](${open}`,
    path,
    after: `${heldAs(form, subpath)}${close})`,
    link,
  };
}

const original = (w: WrittenLink) => w.before + w.path + w.after;

/** Two different paths in the vault, neither among `files`. */
const scenarioArb = fc
  .record({
    files: fc.uniqueArray(pathArb(), {
      maxLength: 10,
      selector: (path) => path.toLowerCase(),
    }),
    originalPath: pathArb(['md']),
    copyPath: pathArb(['md']),
    format: fc.constantFrom<LinkFormat>('shortest', 'relative', 'absolute'),
  })
  .filter(({ files, originalPath, copyPath }) => {
    const taken = files.map((path) => path.toLowerCase());
    return (
      !taken.includes(originalPath.toLowerCase()) &&
      !taken.includes(copyPath.toLowerCase()) &&
      originalPath.toLowerCase() !== copyPath.toLowerCase()
    );
  });

/** A vault and a note in it, with the copy to come. */
function setUp({
  files,
  originalPath,
  format,
}: {
  files: string[];
  originalPath: string;
  format: LinkFormat;
}) {
  const vault = makeLinkVault(
    Object.fromEntries(files.map((path) => [path, null])),
    { linkFormat: format }
  );
  const note = vault.add(originalPath);
  return { vault, note, fileList: files.map((path) => vault.files.get(path)!) };
}

/** The path `spec` links to: a file's, the original's, or none at all. */
function targetPath(spec: LinkSpec, files: TFile[], note: TFile) {
  if (typeof spec.target === 'string') return spec.target;
  if (spec.target === -1 || files.length === 0) return note.path;
  return files[spec.target % files.length].path;
}

/** How the rebase reaches the vault from the copy. */
function fromCopy(vault: ReturnType<typeof makeLinkVault>, copy: TFile) {
  return {
    resolve: (linkpath: string) => vault.resolve(linkpath, copy.path),
    linktext: (file: TFile, omitMd: boolean) =>
      vault.app.metadataCache.fileToLinktext(file, copy.path, omitMd),
  };
}

/**
 * The paths a link written as `w` may hold once re-based from `copy` to
 * `want`, as it holds them: as written, as the link format writes `want`'s,
 * or its whole path.
 */
function pathsAfter(
  vault: ReturnType<typeof makeLinkVault>,
  w: WrittenLink,
  copy: TFile,
  want: TFile | null
): string[] {
  if (!want) return [w.path];
  const wiki = w.form === 'wiki';
  const whole =
    wiki && want.extension === 'md' ? want.path.slice(0, -3) : want.path;
  return [
    w.path,
    heldAs(
      w.form,
      vault.app.metadataCache.fileToLinktext(want, copy.path, wiki)
    ),
    heldAs(w.form, whole),
  ];
}

/**
 * Check one link, written as `w`, which led to `was` from the original, as
 * `rebased` holds it at `at`: what is around its path is as written; its
 * path leads to `was` from the copy, or to the copy when `was` is the
 * original; and it is as written when it needed no change. Gives where in
 * `rebased` it ends.
 */
function checkRebased(
  vault: ReturnType<typeof makeLinkVault>,
  { note, copy }: { note: TFile; copy: TFile },
  w: WrittenLink,
  was: TFile | null,
  rebased: string,
  at: number
): number {
  const want = was === note ? copy : was;
  const held = pathsAfter(vault, w, copy, want)
    .filter((path) => rebased.startsWith(w.before + path + w.after, at))
    .sort((a, b) => b.length - a.length)[0];
  expect(held).toBeDefined();
  const unchanged =
    was === null || vault.resolve(w.link.split('#')[0], copy.path) === want;
  if (unchanged) {
    expect(held).toBe(w.path);
  } else {
    expect(vault.resolve(readAs(w.form, held), copy.path)).toBe(want);
  }
  return at + (w.before + held + w.after).length;
}
/**
 * Frontmatter as YAML gives it: lists and maps of strings and the rest, under
 * any property names, a `.` in some. The values and names a few often take
 * make edits that collide by key or by value likely.
 */
const frontmatterArb = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constantFrom('[[x]]', '[[../y]]', '[a](b.md)', 'text'),
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 3 }),
    tie('map')
  ),
  map: fc.dictionary(
    fc.oneof(
      fc.constantFrom('source', 'related', 'a', 'b', 'a.b', '0', ''),
      fc.string()
    ),
    tie('value'),
    { maxKeys: 4 }
  ),
})).map;

/**
 * The key Obsidian gives a frontmatter link at `path`, the names and indexes
 * that lead to it, joined by `.`: a name under one that is empty starts the
 * key afresh, as in Obsidian's (`cD` in its bundle).
 */
const keyOf = (path: readonly string[]) =>
  path.reduce((key, name) => (key ? `${key}.${name}` : name), '');

/** Each string in `value`, with the names and indexes that lead to it. */
function stringsIn(value: unknown, path: string[] = []): [string[], string][] {
  if (typeof value === 'string') return [[path, value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([name, inner]) =>
    stringsIn(inner, [...path, name])
  );
}

// #endregion

describe('rebaseLinks', () => {
  it('leaves every link in the copy resolving to the file it did in the original, a link to the original resolving to the copy, and everything else as it was', () => {
    fc.assert(
      fc.property(
        scenarioArb,
        fc.array(fc.tuple(fc.string({ maxLength: 12 }), linkSpecArb), {
          maxLength: 8,
        }),
        fc.string({ maxLength: 12 }),
        (scenario, parts, tail) => {
          const { vault, note, fileList } = setUp(scenario);
          const links = parts.map(([, spec]) =>
            writeLink(
              spec,
              linkpathFor(targetPath(spec, fileList, note), spec, note.path)
            )
          );
          let text = '';
          const refs: ReferenceCache[] = [];
          const embeds: ReferenceCache[] = [];
          parts.forEach(([plain, spec], i) => {
            text += plain;
            const written = original(links[i]);
            (spec.embed ? embeds : refs).push({
              link: links[i].link,
              original: written,
              position: position(text.length, text.length + written.length),
            });
            text += written;
          });
          text += tail;
          // Where each link went before the copy was there to take it
          const before = links.map((w) =>
            vault.resolve(w.link.split('#')[0], note.path)
          );

          const resolved = resolveLinks(
            text,
            { links: refs, embeds, sections: sectionsOf(text) },
            (linkpath) => vault.resolve(linkpath, note.path)
          );
          const copy = vault.add(scenario.copyPath);
          const rebased = rebaseLinks(text, resolved!, {
            original: note,
            copy,
            ...fromCopy(vault, copy),
          });

          expect(rebased.frontmatter).toEqual([]);
          expect(rebased.missed).toBe(0);
          let at = 0;
          parts.forEach(([plain], i) => {
            expect(rebased.text.startsWith(plain, at)).toBe(true);
            at = checkRebased(
              vault,
              { note, copy },
              links[i],
              before[i],
              rebased.text,
              at + plain.length
            );
          });
          expect(rebased.text.slice(at)).toBe(tail);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('re-bases a frontmatter link by its key, leaving the text and other properties alone', () => {
    fc.assert(
      fc.property(
        scenarioArb,
        fc.array(
          fc.tuple(
            fc.constantFrom('source', 'related.0', 'related.1', 'a.b', 'a.b.0'),
            linkSpecArb.map(
              (spec): LinkSpec => ({
                ...spec,
                embed: false,
                escapedPipe: false,
                padded: false,
              })
            )
          ),
          { maxLength: 5 }
        ),
        fc.string({ maxLength: 12 }),
        (scenario, entries, text) => {
          const { vault, note, fileList } = setUp(scenario);
          const written = entries.map(([, spec]) =>
            writeLink(
              spec,
              linkpathFor(targetPath(spec, fileList, note), spec, note.path)
            )
          );
          const frontmatterLinks: FrontmatterLinkCache[] = entries.map(
            ([key], i) => ({
              key,
              link: written[i].link,
              original: original(written[i]),
            })
          );
          const before = written.map((w) =>
            vault.resolve(w.link.split('#')[0], note.path)
          );

          const resolved = resolveLinks(
            text,
            { frontmatterLinks, sections: sectionsOf(text) },
            (linkpath) => vault.resolve(linkpath, note.path)
          );
          const copy = vault.add(scenario.copyPath);
          const rebased = rebaseLinks(text, resolved!, {
            original: note,
            copy,
            ...fromCopy(vault, copy),
          });

          expect(rebased.text).toBe(text);
          expect(rebased.missed).toBe(0);
          frontmatterLinks.forEach((ref, i) => {
            const edits = rebased.frontmatter.filter(
              (edit) => edit.key === ref.key && edit.from === ref.original
            );
            const to = edits.length > 0 ? edits[0].to : ref.original;
            expect(edits.every((edit) => edit.to === to)).toBe(true);
            expect(
              checkRebased(vault, { note, copy }, written[i], before[i], to, 0)
            ).toBe(to.length);
            // An edit is given only for a link that changes
            expect(edits.length === 0 || to !== ref.original).toBe(true);
          });
        }
      ),
      { numRuns: 300 }
    );
  });

  it('writes a moved link in the vault link format, as seen from the copy', () => {
    const vault = makeLinkVault(
      {
        'a/x.md': null,
        'b/x.md': null,
        'IR/articles/x.md': null,
        'files/doc.pdf': null,
      },
      { linkFormat: 'relative' }
    );
    const note = vault.add('a/Note.md');
    const copy = vault.add('IR/articles/Note.md');
    const text = '[[x]] ![[../files/doc.pdf#page=2|doc]] [d](../files/doc.pdf)';
    const resolved = resolveLinks(
      text,
      {
        links: [
          { link: 'x', original: '[[x]]', position: position(0, 5) },
          {
            link: '../files/doc.pdf',
            original: '[d](../files/doc.pdf)',
            position: position(39, 60),
          },
        ],
        embeds: [
          {
            link: '../files/doc.pdf#page=2',
            original: '![[../files/doc.pdf#page=2|doc]]',
            position: position(6, 38),
          },
        ],
      },
      (linkpath) => vault.resolve(linkpath, note.path)
    );

    const rebased = rebaseLinks(text, resolved!, {
      original: note,
      copy,
      ...fromCopy(vault, copy),
    });

    expect(rebased).toEqual({
      text: '[[../../a/x]] ![[../../files/doc.pdf#page=2|doc]] [d](../../files/doc.pdf)',
      frontmatter: [],
      missed: 0,
    });
  });

  it('points a link to the original, by name or with a subpath, at the copy', () => {
    const vault = makeLinkVault({}, { linkFormat: 'shortest' });
    const note = vault.add('notes/Note.md');
    const copy = vault.add('IR/articles/Copied.md');
    const text = '[[Note#Heading]] ![[Note#^block]] [[#Local]]';
    const resolved = resolveLinks(
      text,
      {
        links: [
          {
            link: 'Note#Heading',
            original: '[[Note#Heading]]',
            position: position(0, 16),
          },
          {
            link: '#Local',
            original: '[[#Local]]',
            position: position(34, 44),
          },
        ],
        embeds: [
          {
            link: 'Note#^block',
            original: '![[Note#^block]]',
            position: position(17, 33),
          },
        ],
      },
      (linkpath) => vault.resolve(linkpath, note.path)
    );

    const rebased = rebaseLinks(text, resolved!, {
      original: note,
      copy,
      ...fromCopy(vault, copy),
    });

    expect(rebased.text).toBe(
      '[[Copied#Heading]] ![[Copied#^block]] [[#Local]]'
    );
  });

  it('writes the path of a link with no path of its own before its subpath', () => {
    const vault = makeLinkVault({ 'x.md': null });
    const note = vault.add('a/Note.md');
    const copy = vault.add('b/Note.md');
    const text = '[[#h]]';

    const rebased = rebaseLinks(
      text,
      [
        {
          reference: { link: '#h', original: text, position: position(0, 6) },
          target: vault.files.get('x.md')!,
        },
      ],
      {
        original: note,
        copy,
        resolve: (linkpath) =>
          linkpath === 'x' ? vault.files.get('x.md')! : null,
        linktext: () => 'x',
      }
    );

    expect(rebased.text).toBe('[[x#h]]');
  });

  it("writes the whole path where the relative format would name a file in the copy's folder that a namesake at the root takes", () => {
    const vault = makeLinkVault(
      { 'doc.pdf': null, 'IR/articles/doc.pdf': null },
      { linkFormat: 'relative' }
    );
    const note = vault.add('x.md');
    const copy = vault.add('IR/articles/x.md');
    const text = '[[x#h]] [x](x.md) ![[./IR/articles/doc.pdf]]';
    const resolved = resolveLinks(
      text,
      {
        links: [
          { link: 'x#h', original: '[[x#h]]', position: position(0, 7) },
          { link: 'x.md', original: '[x](x.md)', position: position(8, 17) },
        ],
        embeds: [
          {
            link: './IR/articles/doc.pdf',
            original: '![[./IR/articles/doc.pdf]]',
            position: position(18, 44),
          },
        ],
      },
      (linkpath) => vault.resolve(linkpath, note.path)
    );

    const rebased = rebaseLinks(text, resolved!, {
      original: note,
      copy,
      ...fromCopy(vault, copy),
    });

    expect(rebased.text).toBe(
      '[[IR/articles/x#h]] [x](IR/articles/x.md) ![[IR/articles/doc.pdf]]'
    );
  });

  it('leaves a link as written, and counts it, when no path written from the copy reaches its file', () => {
    const vault = makeLinkVault({ 'b/x.md': null });
    const note = vault.add('a/Note.md');
    const copy = vault.add('c/Note.md');
    const text = '[[../b/x]]';

    const rebased = rebaseLinks(
      text,
      [
        {
          reference: {
            link: '../b/x',
            original: text,
            position: position(0, 10),
          },
          target: vault.files.get('b/x.md')!,
        },
      ],
      { original: note, copy, resolve: () => null, linktext: () => 'b/x' }
    );

    expect(rebased).toEqual({ text, frontmatter: [], missed: 1 });
  });

  it("leaves a link as written, and counts it, when the only path to its file holds a '#', which ends a link's path", () => {
    const vault = makeLinkVault({
      'C#/notes.md': null,
      'IR/notes.md': null,
    });
    const note = vault.add('Notes/A.md');
    const copy = vault.add('IR/A.md');
    const text = '[[notes]] [n](notes.md)';
    const resolved = resolveLinks(
      text,
      {
        links: [
          { link: 'notes', original: '[[notes]]', position: position(0, 9) },
          {
            link: 'notes.md',
            original: '[n](notes.md)',
            position: position(10, 23),
          },
        ],
      },
      (linkpath) => vault.resolve(linkpath, note.path)
    );

    const rebased = rebaseLinks(text, resolved!, {
      original: note,
      copy,
      ...fromCopy(vault, copy),
    });

    expect(resolved!.map(({ target }) => target.path)).toEqual([
      'C#/notes.md',
      'C#/notes.md',
    ]);
    expect(rebased).toEqual({ text, frontmatter: [], missed: 2 });
  });

  it('encodes the round brackets of a bare markdown target when they would end it early, and only then', () => {
    const vault = makeLinkVault({
      'A/Part 1).md': null,
      'A/Part (2).md': null,
      'A/Part (3.md': null,
    });
    const note = vault.add('A/Note.md');
    const copy = vault.add('IR/x/Note.md');
    const text =
      '[x](Part%201%29.md) [y](<Part (2).md>) [z](Part%20(2).md) [w](Part%20%283.md)';
    const resolved = resolveLinks(
      text,
      {
        links: [
          {
            link: 'Part 1).md',
            original: '[x](Part%201%29.md)',
            position: position(0, 19),
          },
          {
            link: 'Part (2).md',
            original: '[y](<Part (2).md>)',
            position: position(20, 38),
          },
          {
            link: 'Part (2).md',
            original: '[z](Part%20(2).md)',
            position: position(39, 57),
          },
          {
            link: 'Part (3.md',
            original: '[w](Part%20%283.md)',
            position: position(58, 77),
          },
        ],
      },
      (linkpath) => vault.resolve(linkpath, note.path)
    );
    // Namesakes beside the copy take each link by name
    vault.add('IR/x/Part 1).md');
    vault.add('IR/x/Part (2).md');
    vault.add('IR/x/Part (3.md');

    const rebased = rebaseLinks(text, resolved!, {
      original: note,
      copy,
      ...fromCopy(vault, copy),
    });

    expect(rebased.text).toBe(
      '[x](A/Part%201%29.md) [y](<A/Part (2).md>) [z](A/Part%20(2).md) [w](A/Part%20%283.md)'
    );
  });

  it("encodes a markdown link's new path as Obsidian does, and keeps one in angle brackets as it is", () => {
    const vault = makeLinkVault(
      { 'my notes/x y.md': null },
      { linkFormat: 'relative' }
    );
    const note = vault.add('my notes/sub/Note.md');
    const copy = vault.add('IR/articles/Note.md');
    const text = '[a](../x%20y.md) [b](<../x y.md#h>)';
    const resolved = resolveLinks(
      text,
      {
        links: [
          {
            link: '../x y.md',
            original: '[a](../x%20y.md)',
            position: position(0, 16),
          },
          {
            link: '../x y.md#h',
            original: '[b](<../x y.md#h>)',
            position: position(17, 35),
          },
        ],
      },
      (linkpath) => vault.resolve(linkpath, note.path)
    );

    const rebased = rebaseLinks(text, resolved!, {
      original: note,
      copy,
      ...fromCopy(vault, copy),
    });

    expect(rebased.text).toBe(
      '[a](../../my%20notes/x%20y.md) [b](<../../my notes/x y.md#h>)'
    );
  });

  it("keeps a markdown link's title, and the spaces around its target, with a subpath or without", () => {
    const vault = makeLinkVault({ 'a/x.md': null }, { linkFormat: 'relative' });
    const note = vault.add('a/Note.md');
    const copy = vault.add('IR/Note.md');
    const text = '[t](  ./x.md#h "a title" ) [u](./x.md "title")';
    const resolved = resolveLinks(
      text,
      {
        links: [
          {
            link: './x.md#h',
            original: '[t](  ./x.md#h "a title" )',
            position: position(0, 26),
          },
          {
            link: './x.md',
            original: '[u](./x.md "title")',
            position: position(27, 46),
          },
        ],
      },
      (linkpath) => vault.resolve(linkpath, note.path)
    );

    const rebased = rebaseLinks(text, resolved!, {
      original: note,
      copy,
      ...fromCopy(vault, copy),
    });

    expect(rebased.text).toBe(
      '[t](  ../a/x.md#h "a title" ) [u](../a/x.md "title")'
    );
  });

  it('re-bases a linked image and the image inside it, each by its own path', () => {
    const vault = makeLinkVault({ 'x/note.md': null, 'img.png': null });
    const note = vault.add('a/Note.md');
    const copy = vault.add('a/b/Note.md');
    const text = '[![b](../img.png)](../x/note.md)';

    const resolved = resolveLinks(
      text,
      {
        links: [
          { link: '../x/note.md', original: text, position: position(0, 32) },
        ],
        embeds: [
          {
            link: '../img.png',
            original: '![b](../img.png)',
            position: position(1, 17),
          },
        ],
      },
      (linkpath) => vault.resolve(linkpath, note.path)
    );
    const rebased = rebaseLinks(text, resolved!, {
      original: note,
      copy,
      ...fromCopy(vault, copy),
    });

    expect(rebased.text).toBe('[![b](img.png)](x/note.md)');
  });

  it("leaves a link as written, and counts it, when what it holds isn't the path the cache read from it", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          // The cache's path, then what the note holds there
          ['../x', '[[../y]]'],
          ['../x', '[a](../y.md)'],
          ['../x.md', '[a](<../y.md>)'],
          // Not a link this reads at all
          ['../x', '[[../x'],
          ['../x', '[../x]]'],
          ['../x', '[[../x\\]]'],
          ['../x.md', '[a]../x.md)'],
          ['../x.md', '[a](<../x.md)'],
          ['../x.md', '[a](<../x.md'],
          ['../x.md', '[a](../x.md '],
          ['../x.md', 'a](../x.md)'],
          ['../x.md', '[a]](../x.md)'],
          // Never closed, so its target can't start anywhere
          ['[../x.md', '[../x.md)'],
          // Shapes that hold the path where a link would, but are no link
          ['../x', '[[../x!!'],
          ['../x', '!ab../x]]'],
          ['../x.md', '[a]x../x.md)'],
          ['../x.md', 'a[b](../x.md)'],
          // An entity Obsidian decodes and this doesn't
          ['../x&.md', '[a](../x&amp;.md)']
        ),
        ([link, written]) => {
          const vault = makeLinkVault({ 'x.md': null, 'y.md': null });
          const note = vault.add('a/Note.md');
          const copy = vault.add('a/b/Note 2.md');

          const rebased = rebaseLinks(
            written,
            [
              {
                reference: {
                  link,
                  original: written,
                  position: position(0, written.length),
                },
                target: vault.files.get('x.md')!,
              },
            ],
            {
              original: note,
              copy,
              // Only the path it would be given leads anywhere
              resolve: (linkpath) =>
                linkpath === 'x' ? vault.files.get('x.md')! : null,
              linktext: () => 'x',
            }
          );

          expect(rebased).toEqual({
            text: written,
            frontmatter: [],
            missed: 1,
          });
        }
      )
    );
  });

  it('reads a path as Obsidian does: a markdown one unescaped and decoded, in angle brackets or not, a wikilink one as written, both with no-break spaces as spaces', () => {
    const vault = makeLinkVault({
      '50% off.md': null,
      'My Note.md': null,
      'foo_bar.md': null,
      'x y.md': null,
      '50%25 off.md': null,
    });
    const note = vault.add('a/Note.md');
    const copy = vault.add('a/b/Note.md');
    const parts: [string, string, string][] = [
      ['[a](../50%25%20off.md)', '../50% off.md', '50% off.md'],
      ['[b](<../My%20Note.md>)', '../My Note.md', 'My Note.md'],
      ['[c](../foo\\_bar.md)', '../foo_bar.md', 'foo_bar.md'],
      [`[[../x${NBSP}y]]`, '../x y', 'x y.md'],
      ['[[../50%25 off]]', '../50%25 off', '50%25 off.md'],
      ['[e\\]](../x%20y.md)', '../x y.md', 'x y.md'],
    ];
    let text = '';
    const links: { reference: ReferenceCache; target: TFile }[] = [];
    for (const [written, link, target] of parts) {
      if (text !== '') text += ' ';
      links.push({
        reference: {
          link,
          original: written,
          position: position(text.length, text.length + written.length),
        },
        target: vault.files.get(target)!,
      });
      text += written;
    }

    const rebased = rebaseLinks(text, links, {
      original: note,
      copy,
      ...fromCopy(vault, copy),
    });

    expect(rebased.text).toBe(
      '[a](50%25%20off.md) [b](<My Note.md>) [c](foo_bar.md) [[x y]] [[50%25 off]] [e\\]](x%20y.md)'
    );
    expect(rebased.missed).toBe(0);
  });
});

describe('resolveLinks', () => {
  it('gives each link, embed and frontmatter link that resolves from the note, with the file it resolves to, a subpath alone resolving to the note', () => {
    const vault = makeLinkVault({ 'x.md': null, 'b/y.md': null });
    const note = vault.add('a/Note.md');
    const text = '[[x]] [[gone]] ![[b/y]] [[#Local]]';
    const links: ReferenceCache[] = [
      { link: 'x', original: '[[x]]', position: position(0, 5) },
      { link: 'gone', original: '[[gone]]', position: position(6, 14) },
      { link: '#Local', original: '[[#Local]]', position: position(24, 34) },
    ];
    const embeds: ReferenceCache[] = [
      { link: 'b/y', original: '![[b/y]]', position: position(15, 23) },
    ];
    const frontmatterLinks: FrontmatterLinkCache[] = [
      { key: 'source', link: 'Note#h', original: '[[Note#h]]' },
      { key: 'other', link: 'nowhere', original: '[[nowhere]]' },
    ];

    const resolved = resolveLinks(
      text,
      { links, embeds, frontmatterLinks, sections: sectionsOf(text) },
      (linkpath) => vault.resolve(linkpath, note.path)
    );

    expect(resolved).toEqual([
      { reference: links[0], target: vault.files.get('x.md') },
      { reference: links[2], target: note },
      { reference: embeds[0], target: vault.files.get('b/y.md') },
      { reference: frontmatterLinks[0], target: note },
    ]);
  });

  it('gives nothing for a note with no links, the cache lacking every list', () => {
    expect(resolveLinks('text', {}, () => null)).toEqual([]);
  });

  it('refuses a cache that describes other text: a link not where it says, or text past its last section', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 8 }),
        fc.string({ maxLength: 8 }),
        fc.oneof(
          // Something before the link, so it isn't where the cache says
          fc.record({
            kind: fc.constant('shift' as const),
            by: fc.string({ minLength: 1, maxLength: 3 }),
          }),
          // Text after the last section
          fc.record({
            kind: fc.constant('appended' as const),
            by: fc
              .string({ minLength: 1, maxLength: 3 })
              .filter((s) => s.trim() !== ''),
          }),
          // Text cut from the end, inside the last section
          fc.record({ kind: fc.constant('cut' as const), by: fc.constant('') }),
          // A link the cache read with no text, as on Publish
          fc.record({
            kind: fc.constant('unread' as const),
            by: fc.constant(''),
          })
        ),
        (head, between, { kind, by }) => {
          const link = '[[x]]';
          const read = `${head}${link}${between}.`;
          const cache: LinkCacheSnapshot = {
            links: [
              {
                link: 'x',
                original: kind === 'unread' ? (undefined as never) : link,
                position: position(head.length, head.length + link.length),
              },
            ],
            sections: sectionsOf(read),
          };
          const text =
            kind === 'shift'
              ? by + read
              : kind === 'appended'
                ? read + by
                : kind === 'cut'
                  ? read.slice(0, -1)
                  : read;

          expect(resolveLinks(text, cache, () => null)).toBeNull();
          // The text the cache was read from is accepted
          if (kind !== 'unread') {
            expect(resolveLinks(read, cache, () => null)).toEqual([]);
          }
        }
      )
    );
  });

  it('takes whitespace past the last section as the text the cache read', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 8 }),
        fc.stringMatching(/^[ \t\n\r]{0,4}$/),
        (body, trailing) => {
          const cache: LinkCacheSnapshot = { sections: sectionsOf(body) };
          expect(resolveLinks(body + trailing, cache, () => null)).toEqual([]);
        }
      )
    );
  });

  it('refuses a cache with no sections for text that is more than whitespace: it was read from an empty note', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), (text) => {
        expect(resolveLinks(text, { sections: [] }, () => null)).toEqual(
          text.trim() === '' ? [] : null
        );
      })
    );
  });

  it('refuses a missing cache: the note is not read yet', () => {
    expect(resolveLinks('[[x]]', null, () => null)).toBeNull();
  });

  it('checks links against the text alone when the cache has no sections', () => {
    const cache: LinkCacheSnapshot = {
      links: [{ link: 'x', original: '[[x]]', position: position(0, 5) }],
    };
    expect(resolveLinks('[[x]] and more', cache, () => null)).toEqual([]);
  });
});

describe('applyFrontmatterLinkEdits', () => {
  it('changes exactly the strings an edit names by key and old value, wherever they are nested, and nothing else', () => {
    fc.assert(
      fc.property(
        frontmatterArb,
        fc.array(
          fc.tuple(
            fc.nat(),
            fc.constantFrom('match', 'stale', 'missing', 'other', 'chain')
          ),
          { maxLength: 6 }
        ),
        (frontmatter, picks) => {
          const strings = stringsIn(frontmatter);
          // A match names a string's key and value; another for the same
          // one gives it another value, or one that is a string's own, which
          // a later edit may name in turn: only the first edit applies
          const edits = picks.flatMap(([index, kind]) => {
            if (kind === 'missing') {
              return [{ key: 'nowhere.0', from: '[[x]]', to: 'new' }];
            }
            if (strings.length === 0) return [];
            const [path, value] = strings[index % strings.length];
            const key = keyOf(path);
            if (kind === 'stale') {
              return [{ key, from: `${value} stale`, to: 'stale' }];
            }
            const to =
              kind === 'match'
                ? `${key}=${value}!`
                : kind === 'other'
                  ? `${key}=${value}?`
                  : strings[(index + 1) % strings.length][1];
            return [{ key, from: value, to }];
          });
          // The first edit naming a string's key and value replaces it
          const expected = structuredClone(frontmatter);
          for (const [path, value] of strings) {
            const key = keyOf(path);
            const edit = edits.find((e) => e.key === key && e.from === value);
            if (!edit) continue;
            let holder = expected;
            for (const name of path.slice(0, -1)) {
              holder = holder[name] as Record<string, unknown>;
            }
            // As its own property, `__proto__` included
            Object.defineProperty(holder, path[path.length - 1], {
              value: edit.to,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
          const actual = structuredClone(frontmatter);

          applyFrontmatterLinkEdits(actual, edits);

          expect(actual).toEqual(expected);
        }
      )
    );
  });

  it('sets each edited link where its key and its old value say, as Obsidian keys them, and nothing else', () => {
    const frontmatter: Record<string, unknown> = {
      source: '[[../x]]',
      related: ['[[../y]]', '[[../x]]', 3],
      'a.b': '[[../x]]',
      a: { b: '[[../z]]', c: null },
      other: '[[../x]]',
      empty: null,
    };

    applyFrontmatterLinkEdits(frontmatter, [
      { key: 'source', from: '[[../x]]', to: '[[x]]' },
      { key: 'related.1', from: '[[../x]]', to: '[[x]]' },
      { key: 'related.0', from: '[[stale]]', to: '[[y]]' },
      { key: 'a.b', from: '[[../x]]', to: '[[x]]' },
      { key: 'a.b', from: '[[../z]]', to: '[[z]]' },
      { key: 'missing', from: '[[../x]]', to: '[[x]]' },
    ]);

    expect(frontmatter).toEqual({
      source: '[[x]]',
      related: ['[[../y]]', '[[x]]', 3],
      'a.b': '[[x]]',
      a: { b: '[[z]]', c: null },
      other: '[[../x]]',
      empty: null,
    });
  });
});
