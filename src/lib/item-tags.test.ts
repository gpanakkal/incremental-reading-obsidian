import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from './constants';
import { TAG_BY_TABLE, hasTag, tagEntries, withTag } from './item-tags';
import { ITEM_TABLES } from './moved-note-scan';

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

/** A list entry that is not blank and is not `tag` itself. */
const keptEntryArb = (tag: string) =>
  entryArb.filter(
    (entry) =>
      entry !== tag &&
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

describe('hasTag', () => {
  /** Tags lacking `tag`, as a list or a lone string, and `tag` added to them. */
  const tagsAroundArb = (tag: string) =>
    fc.oneof(
      fc
        .tuple(fc.array(keptEntryArb(tag), { maxLength: 5 }), fc.nat())
        .map(([others, at]) => {
          const tagged = [...others];
          tagged.splice(at % (others.length + 1), 0, tag);
          return { without: others as unknown, tagged: tagged as unknown };
        }),
      fc
        .tuple(
          fc.array(
            tokenArb.filter((token) => token !== tag),
            { maxLength: 4 }
          ),
          fc.nat()
        )
        .chain(([others, at]) => {
          const tagged = [...others];
          tagged.splice(at % (others.length + 1), 0, tag);
          return fc
            .tuple(joinedArb(others), joinedArb(tagged))
            .map(([without, withIt]) => ({
              without: without as unknown,
              tagged: withIt as unknown,
            }));
        })
    );

  it('finds a tag only as a whole entry of its own, in a list or a lone string', () => {
    fc.assert(
      fc.property(
        tagArb.chain((tag) =>
          tagsAroundArb(tag).map((tags) => ({ tag, ...tags }))
        ),
        ({ tag, without, tagged }) => {
          expect(hasTag(tagged, tag)).toBe(true);
          expect(hasTag(without, tag)).toBe(false);
        }
      )
    );
  });

  it('finds no tag in anything but a list or a string', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<unknown>(undefined, null, 0, 5, true, {
          tags: ARTICLE_TAG,
        }),
        tagArb,
        (tags, tag) => {
          expect(hasTag(tags, tag)).toBe(false);
        }
      )
    );
  });

  it('finds the tag in a lone string that names it among others', () => {
    expect(hasTag('other, ir-article', ARTICLE_TAG)).toBe(true);
    expect(hasTag('ir-card other', CARD_TAG)).toBe(true);
    expect(hasTag('ir-article-x', ARTICLE_TAG)).toBe(false);
    expect(hasTag(['#ir-article'], ARTICLE_TAG)).toBe(false);
  });
});

describe('withTag', () => {
  it('hands back exactly what was there when the tag is already in it', () => {
    fc.assert(
      fc.property(tagsValueArb, tagArb, (tags, tag) => {
        fc.pre(hasTag(tags, tag));
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
              tokenArb.filter((token) => token !== tag),
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
        expect(hasTag(once, tag)).toBe(true);
        expect(withTag(once, tag)).toBe(once);
      })
    );
  });
});
