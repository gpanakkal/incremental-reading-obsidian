import {
  frontmatterArb,
  obsidianCarries,
  obsidianFrontmatterTags,
  obsidianTypeOf,
  PLUGIN_TAGS,
} from '#/test/obsidian-tags';
import fc from 'fast-check';
import type { App, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG, SOURCE_TAG } from './constants';
import { classifyTag } from './ir-id-watch';
import {
  frontmatterTags,
  hasTag,
  isTag,
  matchFrontmatterTags,
  TAG_BY_TABLE,
  tagEntries,
  tagsKeyOf,
  typeOfTags,
  withTag,
} from './item-tags';
import { ITEM_TABLES } from './moved-note-scan';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import { vaultReader } from './relink';
import { matchAnyTags } from './tags';

// #region HELPERS

const ITEM_TAGS = [ARTICLE_TAG, SNIPPET_TAG, CARD_TAG];

const tagArb = fc.constantFrom(...ITEM_TAGS);

/** A tag the user might keep, item tags and lookalikes included. */
const otherTagArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom(
    ...ITEM_TAGS,
    ...ITEM_TAGS.map((tag) => `#${tag}`),
    ...ITEM_TAGS.map((tag) => `${tag}-x`),
    ...ITEM_TAGS.map((tag) => tag.toUpperCase())
  )
);

/** Anything YAML can leave in a `tags` list. */
const entryArb: fc.Arbitrary<unknown> = fc.oneof(
  otherTagArb,
  fc.constantFrom<unknown>(null, undefined, true, 0, 7),
  fc.constant({ nested: 'ir-article' }),
  fc.constant(['ir-article'])
);

/** Every shape a frontmatter `tags` value can take. */
const tagsValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.array(entryArb, { maxLength: 6 }),
  otherTagArb,
  fc
    .array(otherTagArb, { maxLength: 4 })
    .chain((tags) =>
      fc
        .constantFrom(', ', ',', ' ', '  ,\t')
        .map((separator) => tags.join(separator))
    ),
  fc.constantFrom<unknown>(undefined, null, '', 0, 5, true, { a: 1 })
);

/** A single tag as a lone string can hold one: no commas, no whitespace. */
const tokenArb = fc
  .string({ minLength: 1, maxLength: 10 })
  .filter((token) => !/[\s,]/.test(token));

/** A run of separators a hand-written `tags: a, b` might put between tags. */
const separatorArb = fc.constantFrom(', ', ',', ' ', '  ,\t', '\n', ',,');

/** `tokens` written as one string, with separators between and around them. */
const joinedArb = (tokens: readonly string[]) =>
  fc
    .tuple(
      fc.array(separatorArb, {
        minLength: tokens.length + 1,
        maxLength: tokens.length + 1,
      }),
      fc.boolean(),
      fc.boolean()
    )
    .map(
      ([separators, leading, trailing]) =>
        (leading ? separators[0] : '') +
        tokens
          .map((token, i) => (i === 0 ? token : separators[i] + token))
          .join('') +
        (trailing ? separators[tokens.length] : '')
    );

/** Every entry YAML leaves for an empty `tags:` or `- ` line, or one of spaces. */
const blankArb = fc.constantFrom<unknown>(null, undefined, '', '  ', '\t');

/** Whether Obsidian reads the list entry `entry` as `tag`. */
const entryIs = (entry: unknown, tag: string) =>
  obsidianCarries({ tags: [entry] }, tag);

/** A list entry that is not blank and that Obsidian does not read as `tag`. */
const keptEntryArb = (tag: string) =>
  entryArb.filter(
    (entry) =>
      !entryIs(entry, tag) &&
      entry !== null &&
      entry !== undefined &&
      !(typeof entry === 'string' && entry.trim() === '')
  );

/** `kept`, with blank entries slipped in anywhere. */
const withBlanksArb = (kept: readonly unknown[]) =>
  fc.array(fc.tuple(fc.nat(), blankArb), { maxLength: 4 }).map((blanks) => {
    const list = [...kept];
    for (const [at, blank] of blanks) {
      list.splice(at % (list.length + 1), 0, blank);
    }
    return list;
  });

/**
 * A frontmatter of any shape, or none, or something that is no frontmatter at
 * all, which no reader should take tags from.
 */
const anyFrontmatterArb: fc.Arbitrary<unknown> = fc.oneof(
  frontmatterArb,
  fc.constant(undefined),
  fc.anything()
);

/** A tag asked for: one of the plugin's, after a `#` or in another case. */
const askedTagArb = fc
  .constantFrom(...PLUGIN_TAGS)
  .chain((tag) =>
    fc.constantFrom(tag, `#${tag}`, tag.toUpperCase(), `#${tag.toUpperCase()}`)
  );

/** Freeze `value` and everything in it, so any write to it throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** A note at `n.md`, as the readers that take a file are handed one. */
const NOTE = {
  path: 'n.md',
  name: 'n.md',
  basename: 'n',
  extension: 'md',
} as TFile;

/** An app whose one note, {@link NOTE}, has `frontmatter` in the cache. */
function appWith(frontmatter: unknown): App {
  return {
    vault: {
      getFileByPath: (path: string) => (path === NOTE.path ? NOTE : null),
    },
    metadataCache: {
      getFileCache: () => (frontmatter === undefined ? {} : { frontmatter }),
    },
  } as unknown as App;
}

// #endregion

describe('TAG_BY_TABLE', () => {
  it('names each item table by the tag its notes carry', () => {
    expect(TAG_BY_TABLE).toStrictEqual({
      article: ARTICLE_TAG,
      snippet: SNIPPET_TAG,
      srs_card: CARD_TAG,
    });
    expect(Object.keys(TAG_BY_TABLE).sort()).toStrictEqual(
      [...ITEM_TABLES].sort()
    );
  });
});

describe('tagEntries', () => {
  it('reads a list as it is, entry for entry', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 6 }), (tags) => {
        expect(tagEntries(tags)).toBe(tags);
      })
    );
  });

  it('splits a lone string on commas and whitespace, dropping the gaps', () => {
    fc.assert(
      fc.property(
        fc
          .array(tokenArb, { maxLength: 4 })
          .chain((tokens) =>
            joinedArb(tokens).map((joined) => ({ tokens, joined }))
          ),
        ({ tokens, joined }) => {
          expect(tagEntries(joined)).toStrictEqual(tokens);
        }
      )
    );
  });

  it('reads anything else as no tags at all', () => {
    for (const tags of [undefined, null, 0, 5, true, { a: 1 }]) {
      expect(tagEntries(tags)).toStrictEqual([]);
    }
  });
});

describe('frontmatterTags', () => {
  it("reads every frontmatter as Obsidian's parseFrontMatterTags does, each tag without its # and in lower case", () => {
    fc.assert(
      fc.property(anyFrontmatterArb, (frontmatter) => {
        const expected = (obsidianFrontmatterTags(frontmatter) ?? []).map(
          (tag) => tag.slice(1).toLowerCase()
        );
        expect([...frontmatterTags(frontmatter)].sort()).toStrictEqual(
          [...new Set(expected)].sort()
        );
      })
    );
  });

  it('reads tags as Obsidian does where it parts from a hand-written guess', () => {
    // One string is one tag, and one with a space in it no tag at all
    expect([...frontmatterTags({ tags: 'a, b' })]).toStrictEqual([]);
    expect([...frontmatterTags({ tags: 'a,b' })]).toStrictEqual(['a,b']);
    // `tags` in any case, the first such key only; never `tag`
    expect([...frontmatterTags({ Tags: null, tags: ['a'] })]).toStrictEqual([]);
    expect([...frontmatterTags({ tag: 'a' })]).toStrictEqual([]);
    // One `#` dropped, trimmed, case folded
    expect([
      ...frontmatterTags({ TAGS: [' #A ', '##b', 'c d'] }),
    ]).toStrictEqual(['a', '#b']);
    // Blank entries carry nothing; a lone `#` is the empty tag
    expect([...frontmatterTags({ tags: ['', '  ', 'a'] })]).toStrictEqual([
      'a',
    ]);
    expect([...frontmatterTags({ tags: '  ' })]).toStrictEqual([]);
    expect([...frontmatterTags({ tags: '#' })]).toStrictEqual(['']);
  });

  it('leaves the frontmatter it reads as it was', () => {
    fc.assert(
      fc.property(frontmatterArb, (frontmatter) => {
        const before = structuredClone(frontmatter);
        frontmatterTags(deepFreeze(frontmatter));
        expect(frontmatter).toStrictEqual(before);
      })
    );
  });
});

describe('hasTag', () => {
  it('finds a tag exactly where Obsidian does, # optional, in any case', () => {
    fc.assert(
      fc.property(anyFrontmatterArb, askedTagArb, (frontmatter, tag) => {
        expect(hasTag(frontmatter, tag)).toBe(
          obsidianCarries(frontmatter, tag)
        );
      })
    );
  });

  it('finds no tag a carried one is nested in, nor one it only starts or ends', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PLUGIN_TAGS),
        fc.constantFrom('/x', '-x', 'x'),
        fc.boolean(),
        (tag, extra, before) => {
          const carried = before ? `${extra}${tag}` : `${tag}${extra}`;
          expect(hasTag({ tags: [carried] }, tag)).toBe(false);
          expect(hasTag({ tags: carried }, tag)).toBe(false);
        }
      )
    );
  });
});

describe('a nested tag', () => {
  it('never counts as the tag it is nested in, for a type or for any other tag', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PLUGIN_TAGS, 'book'),
        fc.constantFrom('/x', '/fiction', '/a/b'),
        fc.boolean(),
        (tag, child, asList) => {
          const nested = `${tag}${child}`;
          const frontmatter = { tags: asList ? [nested] : nested };

          expect(hasTag(frontmatter, tag)).toBe(false);
          expect(matchFrontmatterTags(frontmatter, [tag])).toStrictEqual([]);
          expect(typeOfTags(frontmatter)).toBeNull();
          expect(hasTag(frontmatter, nested)).toBe(true);
        }
      )
    );
  });
});

describe('matchFrontmatterTags', () => {
  it('returns the tags asked for that the frontmatter carries, in the order asked, each as asked', () => {
    fc.assert(
      fc.property(
        anyFrontmatterArb,
        fc.array(fc.oneof(askedTagArb, fc.string({ maxLength: 6 })), {
          maxLength: 6,
        }),
        (frontmatter, tags) => {
          expect(matchFrontmatterTags(frontmatter, tags)).toStrictEqual(
            tags.filter((tag) => obsidianCarries(frontmatter, tag))
          );
        }
      )
    );
  });

  it('takes the tags to look for from any iterable, a set included', () => {
    expect(
      matchFrontmatterTags({ tags: ['b', 'c'] }, new Set(['a', 'b', 'c']))
    ).toStrictEqual(['b', 'c']);
  });

  it('leaves the frontmatter it reads as it was', () => {
    fc.assert(
      fc.property(frontmatterArb, askedTagArb, (frontmatter, tag) => {
        const before = structuredClone(frontmatter);
        matchFrontmatterTags(deepFreeze(frontmatter), [tag]);
        expect(frontmatter).toStrictEqual(before);
      })
    );
  });
});

describe('typeOfTags', () => {
  it('names the type of the highest-ranked type tag Obsidian reads there, article over snippet over card', () => {
    fc.assert(
      fc.property(anyFrontmatterArb, (frontmatter) => {
        expect(typeOfTags(frontmatter)).toBe(obsidianTypeOf(frontmatter));
      })
    );
  });

  it('ranks each type tag over every one below it', () => {
    expect(typeOfTags({ tags: [CARD_TAG, SNIPPET_TAG, ARTICLE_TAG] })).toBe(
      'article'
    );
    expect(typeOfTags({ tags: [CARD_TAG, SNIPPET_TAG] })).toBe('snippet');
    expect(typeOfTags({ tags: CARD_TAG })).toBe('card');
  });
});

describe('isTag', () => {
  it('holds for a tags entry exactly when Obsidian reads that entry as the tag', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          entryArb,
          // Padded, as YAML keeps a quoted entry
          askedTagArb.map((spelled) => ` ${spelled}\t`)
        ),
        askedTagArb,
        (entry, tag) => {
          expect(isTag(entry, tag)).toBe(entryIs(entry, tag));
        }
      )
    );
  });
});

describe('every tag reader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('agrees with Obsidian on whether a note carries each tag the plugin reads, whatever shape its frontmatter takes', async () => {
    await fc.assert(
      fc.asyncProperty(
        frontmatterArb,
        fc.constantFrom(...ITEM_TABLES),
        async (frontmatter, table) => {
          vi.restoreAllMocks();
          const app = appWith(frontmatter);
          const type = obsidianTypeOf(frontmatter);
          // The bars and review: from the metadata cache, and from the text
          expect(
            Obsidian.noteTypeFromCache(NOTE, { frontmatter } as never, app)
          ).toBe(type);
          vi.spyOn(Obsidian, 'readFrontMatter').mockResolvedValue(
            frontmatter ?? {}
          );
          await expect(Obsidian.getNoteType(NOTE, app)).resolves.toBe(type);
          // Relinking's mixed-kind guard
          const tagged =
            ITEM_TABLES.find((each) =>
              obsidianCarries(frontmatter, TAG_BY_TABLE[each])
            ) ?? null;
          expect(vaultReader(app).taggedTableOf(NOTE)).toBe(tagged);
          // The ir-id watch's lost-tag report
          const lost = classifyTag(
            { path: NOTE.path, irId: 'x' },
            frontmatter,
            [{ table, id: 'x', deleted: false }]
          );
          expect(lost === null).toBe(
            obsidianCarries(frontmatter, TAG_BY_TABLE[table])
          );
          // Orphan snippets' source notes
          expect(Obsidian.isSourceNote(NOTE, app)).toBe(
            obsidianCarries(frontmatter, SOURCE_TAG)
          );
          // The tag search of a bulk import finds at least as much
          for (const tag of PLUGIN_TAGS) {
            if (obsidianCarries(frontmatter, tag)) {
              expect(
                matchAnyTags({ frontmatter } as never, [tag])
              ).toStrictEqual([tag]);
            }
          }
        }
      )
    );
  });
});

describe('withTag', () => {
  it('hands back exactly what was there when the tag is already in it', () => {
    fc.assert(
      fc.property(tagsValueArb, tagArb, (tags, tag) => {
        fc.pre(hasTag({ tags }, tag));
        expect(withTag(tags, tag)).toBe(tags);
      })
    );
  });

  it('appends the tag after every other entry of a list, in their order, dropping blanks', () => {
    fc.assert(
      fc.property(
        tagArb.chain((tag) =>
          fc
            .array(keptEntryArb(tag), { maxLength: 5 })
            .chain((kept) =>
              withBlanksArb(kept).map((tags) => ({ tag, kept, tags }))
            )
        ),
        ({ tag, kept, tags }) => {
          expect(withTag(tags, tag)).toStrictEqual([...kept, tag]);
        }
      )
    );
  });

  it('turns a lone string into the list of tags it names, with the tag last', () => {
    fc.assert(
      fc.property(
        tagArb.chain((tag) =>
          fc
            .array(
              tokenArb.filter((token) => !entryIs(token, tag)),
              { maxLength: 4 }
            )
            .chain((tokens) =>
              joinedArb(tokens).map((joined) => ({ tag, tokens, joined }))
            )
        ),
        ({ tag, tokens, joined }) => {
          expect(withTag(joined, tag)).toStrictEqual([...tokens, tag]);
        }
      )
    );
  });

  it('turns a lone string naming the tag among other tags into their list, adding it no second time', () => {
    fc.assert(
      fc.property(
        tagArb.chain((tag) =>
          fc
            .tuple(
              fc.array(tokenArb, { minLength: 1, maxLength: 3 }),
              fc.nat(),
              fc.constantFrom(tag, `#${tag}`, tag.toUpperCase())
            )
            .chain(([others, at, spelled]) => {
              const tokens = [...others];
              tokens.splice(at % (others.length + 1), 0, spelled);
              return joinedArb(tokens).map((joined) => ({
                tag,
                tokens,
                joined,
              }));
            })
        ),
        ({ tag, tokens, joined }) => {
          expect(withTag(joined, tag)).toStrictEqual(tokens);
        }
      )
    );
  });

  it('keeps any other value there as an entry ahead of the tag, and reads a missing one as none', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<unknown>(0, 5, true, false, { nested: ARTICLE_TAG }),
        tagArb,
        (tags, tag) => {
          expect(withTag(tags, tag)).toStrictEqual([tags, tag]);
        }
      )
    );
    fc.assert(
      fc.property(
        fc.constantFrom<unknown>(null, undefined),
        tagArb,
        (tags, tag) => {
          expect(withTag(tags, tag)).toStrictEqual([tag]);
        }
      )
    );
  });

  it('leaves a list it was given untouched', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 6 }), tagArb, (tags, tag) => {
        const before = [...tags];
        withTag(tags, tag);
        expect(tags).toStrictEqual(before);
      })
    );
  });

  it('reads as carrying the tag once added, so a second pass writes nothing', () => {
    fc.assert(
      fc.property(tagsValueArb, tagArb, (tags, tag) => {
        const once = withTag(tags, tag);
        expect(hasTag({ tags: once }, tag)).toBe(true);
        expect(withTag(once, tag)).toBe(once);
      })
    );
  });
});

describe('tagsKeyOf', () => {
  it('names the key Obsidian reads tags from, so a tag written there is one Obsidian reads and every other key stays as it was', () => {
    fc.assert(
      fc.property(
        frontmatterArb,
        fc.constantFrom(...PLUGIN_TAGS),
        (frontmatter, tag) => {
          const before = frontmatter ?? {};
          const written = structuredClone(before);
          const key = tagsKeyOf(written);

          written[key] = withTag(written[key], tag);

          expect(obsidianCarries(written, tag)).toBe(true);
          const { [key]: _was, ...rest } = before;
          const { [key]: _now, ...restAfter } = written;
          expect(restAfter).toStrictEqual(rest);
        }
      ),
      {
        examples: [
          [{ Tags: 'mine' }, ARTICLE_TAG],
          [{ TAGS: ['mine'], tags: ['other'] }, SNIPPET_TAG],
          [{ Tags: null, tags: [ARTICLE_TAG] }, ARTICLE_TAG],
        ],
      }
    );
  });

  it('names the first key named tags in any case, and tags itself when there is none', () => {
    expect(tagsKeyOf({ title: 'x', Tags: ['a'], tags: ['b'] })).toBe('Tags');
    expect(tagsKeyOf({ TAGS: null })).toBe('TAGS');
    expect(tagsKeyOf({ tag: ['a'], mytags: ['b'], ' tags': ['c'] })).toBe(
      'tags'
    );
    expect(tagsKeyOf({})).toBe('tags');
  });
});
