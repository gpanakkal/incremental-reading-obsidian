import { DATA_DIRECTORY } from '#/lib/constants';
import { explorerComparator } from '#/lib/explorer-order';
import { parseTagList } from '#/lib/tags';
import fc from 'fast-check';
import { TFile, TFolder, type CachedMetadata } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { unimportChecks, type CandidateChecks } from './candidates';
import { listSource } from './list-source';
import { tagListText, tagSource } from './tag-source';
import type { ScanEvent } from './types';

// #region HELPERS
/** What a note opens with: no binary format's signature. */
const NOTE_BYTES = new TextEncoder().encode('# Content');

/** A note as generated: where it is, and its cached metadata. */
interface NoteSpec {
  dirs: string[];
  name: string;
  frontmatter: Record<string, unknown> | undefined;
  inline: string[] | undefined;
}

/** The notes `specs` make, each with its folders, and their metadata. */
function makeVault(specs: readonly NoteSpec[]) {
  const root = Object.assign(new TFolder(), { path: '/', name: '' });
  const folders = new Map<string, TFolder>();
  const folderAt = (dirs: readonly string[]): TFolder => {
    if (dirs.length === 0) return root;
    const path = dirs.join('/');
    let folder = folders.get(path);
    if (!folder) {
      folder = Object.assign(new TFolder(), {
        path,
        name: dirs[dirs.length - 1],
        parent: folderAt(dirs.slice(0, -1)),
      });
      folders.set(path, folder);
    }
    return folder;
  };
  const caches = new Map<TFile, CachedMetadata | null>();
  const files = specs.map((spec, i) => {
    // Numbered, so no two notes share a path
    const name = `${spec.name}${i}.md`;
    const file = Object.assign(new TFile(), {
      path: [...spec.dirs, name].join('/'),
      name,
      basename: `${spec.name}${i}`,
      extension: 'md',
      stat: { mtime: i, ctime: i, size: 0 },
      parent: folderAt(spec.dirs),
    });
    const cache: CachedMetadata = {
      ...(spec.frontmatter && { frontmatter: spec.frontmatter }),
      ...(spec.inline && {
        tags: spec.inline.map((tag) => ({ tag }) as never),
      }),
    };
    caches.set(file, spec.frontmatter || spec.inline ? cache : null);
    return file;
  });
  const getMarkdownFiles = vi.fn(() => [...files]);
  const readBinary = vi.fn(async (_file: TFile) => NOTE_BYTES.slice().buffer);
  const checks: CandidateChecks = {
    app: {
      vault: {
        readBinary,
        getResourcePath: (file: TFile) => `app://vault/${file.path}`,
      },
      metadataCache: {
        getFileCache: (file: TFile) => caches.get(file) ?? null,
      },
    } as never,
    isItemAtPath: () => false,
  };
  return { files, caches, vault: { getMarkdownFiles }, checks };
}

/** A tag as a note might carry it: nested or not, in any case. */
const carriedArb = fc.mixedCase(
  fc.constantFrom('read', 'read/later', 'reading', 'other/read', 'x')
);

const noteSpecArb: fc.Arbitrary<NoteSpec> = fc.record({
  dirs: fc.array(fc.constantFrom('a', 'b', DATA_DIRECTORY), { maxLength: 2 }),
  name: fc.constantFrom('n', 'N', 'm'),
  frontmatter: fc.option(
    fc.record(
      {
        tags: fc.oneof(
          fc.array(carriedArb, { maxLength: 2 }),
          carriedArb.map((tag) => `#${tag}`)
        ),
        'ir-id': fc.constantFrom('id-1', 'id-2'),
      },
      { requiredKeys: [] }
    ),
    { nil: undefined }
  ),
  inline: fc.option(
    fc.array(
      carriedArb.map((tag) => `#${tag}`),
      { maxLength: 2 }
    ),
    { nil: undefined }
  ),
});

/** Tags as the filter field reads them: lower case, with no `#`. */
const askedArb = fc.uniqueArray(
  fc.constantFrom('read', 'read/later', 'other', 'x', 'none'),
  { minLength: 1, maxLength: 3 }
);

async function collect(events: AsyncIterable<ScanEvent>): Promise<ScanEvent[]> {
  const all: ScanEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const scan = (source: {
  scan: (signal: AbortSignal) => AsyncIterable<ScanEvent>;
}) => collect(source.scan(new AbortController().signal));
// #endregion

describe('tagSource', () => {
  it('lists, as a list source would, the notes carrying any of the tags, in frontmatter or body, nested ones too', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(noteSpecArb, { maxLength: 8 }),
        askedArb,
        async (specs, tags) => {
          const { files, caches, vault, checks } = makeVault(specs);
          const compare = explorerComparator('alphabetical');
          const carries = (file: TFile) => {
            const cache = caches.get(file);
            const fm = cache?.frontmatter?.tags as
              | string[]
              | string
              | undefined;
            const held = [
              ...(Array.isArray(fm) ? fm : fm === undefined ? [] : [fm]),
              ...(cache?.tags ?? []).map(({ tag }) => tag),
            ].map((tag) => tag.replace(/^#/, '').toLowerCase());
            return tags.some((tag) =>
              held.some((h) => h === tag || h.startsWith(`${tag}/`))
            );
          };

          const events = await scan(tagSource(tags, vault, checks, compare));

          expect(events).toEqual(
            await scan(listSource(files.filter(carries), checks, compare, ''))
          );
        }
      )
    );
  });

  it('leaves out a note that is an item already, and one in the data directory', async () => {
    const { files, vault, checks } = makeVault([
      { dirs: [], name: 'a', frontmatter: { tags: 'read' }, inline: undefined },
      {
        dirs: [],
        name: 'b',
        frontmatter: { tags: 'read', 'ir-id': 'id' },
        inline: undefined,
      },
      {
        dirs: [DATA_DIRECTORY],
        name: 'c',
        frontmatter: undefined,
        inline: ['#read'],
      },
    ]);

    const events = await scan(
      tagSource(['read'], vault, checks, explorerComparator('alphabetical'))
    );

    expect(
      events.flatMap((event) => (event.type === 'file' ? [event.file] : []))
    ).toEqual([files[0]]);
  });

  it('lists, for an un-import, the tagged notes that are live articles alone, reading none', async () => {
    const { files, vault, checks } = makeVault([
      {
        dirs: [],
        name: 'plain',
        frontmatter: { tags: 'read' },
        inline: undefined,
      },
      {
        dirs: [],
        name: 'article',
        frontmatter: { tags: 'read', 'ir-id': 'id' },
        inline: undefined,
      },
      {
        dirs: [],
        name: 'untagged',
        frontmatter: { 'ir-id': 'id2' },
        inline: undefined,
      },
    ]);
    const articles = new Set<TFile>([files[1], files[2]]);

    const events = await scan(
      tagSource(
        ['read'],
        vault,
        unimportChecks(checks, {
          articleIdAt: (file) => (articles.has(file) ? 'id' : null),
        }),
        explorerComparator('alphabetical')
      )
    );

    expect(
      events.flatMap((event) => (event.type === 'file' ? [event.file] : []))
    ).toEqual([files[1]]);
    expect(checks.app.vault.readBinary).not.toHaveBeenCalled();
  });

  it('looks only at the vault’s notes, once, when made', () => {
    const { vault, checks } = makeVault([]);

    tagSource(['read'], vault, checks, () => 0);

    expect(vault.getMarkdownFiles).toHaveBeenCalledOnce();
  });

  it('is titled with the tags, each after one #, comma-separated', () => {
    fc.assert(
      fc.property(askedArb, (tags) => {
        const { vault, checks } = makeVault([]);

        expect(tagSource(tags, vault, checks, () => 0).title).toBe(
          tagListText(tags)
        );
      })
    );
  });
});

describe('tagListText', () => {
  it('writes each tag after a #, separated by a comma and a space, as the field reads back', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9/_-]{1,6}$/), {
          maxLength: 4,
        }),
        (tags) => {
          const text = tagListText(tags);

          expect(text.split(', ')).toEqual(
            tags.length === 0 ? [''] : tags.map((tag) => `#${tag}`)
          );
          expect(parseTagList(text)).toEqual(tags);
        }
      )
    );
  });
});
