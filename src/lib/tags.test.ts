import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from './constants';
import {
  formatTagList,
  isItemTypeTag,
  matchAnyTags,
  matchFrontmatterTags,
  parseTagList,
  stripFrontmatterTags,
} from './tags';

// #region HELPERS

/** What separates tags: a comma, whitespace as `\s` matches it, or a `#`. */
const SEPARATOR = /[\s,#]/;

/** A run of separators, as typed between two tags or around the list. */
const separatorsArb = fc
  .array(fc.constantFrom(',', ' ', '\t', '\n', '\r\n', ' ', ' ', '　', '#'), {
    minLength: 1,
    maxLength: 3,
  })
  .map((parts) => parts.join(''));

/** Separators, or nothing at all, as at either end of a list. */
const edgeArb = fc.oneof(fc.constant(''), separatorsArb);

/**
 * A tag as compared: any text with no separator in it, `#` included, often
 * one shaped like a real tag, a `/` inside it as like as not.
 */
const tagCoreArb = fc
  .oneof(
    fc.string({ unit: 'binary', minLength: 1, maxLength: 12 }),
    fc.stringMatching(/^[a-zA-Z0-9_-][a-zA-Z0-9_\-/]{0,10}$/)
  )
  .filter((text) => !SEPARATOR.test(text));

type WrittenTag = { written: string; tag: string };

/**
 * A tag as someone might write it: in any case, with any number of `#`s in
 * front. Returns what was written and the tag it should read as.
 */
const writtenTagArb: fc.Arbitrary<WrittenTag> = fc
  .tuple(
    tagCoreArb,
    fc.nat({ max: 2 }),
    fc.constantFrom<(text: string) => string>(
      (text) => text,
      (text) => text.toUpperCase(),
      (text) => text.toLowerCase()
    )
  )
  .map(([text, hashes, casing]) => {
    const cased = casing(text);
    return { written: '#'.repeat(hashes) + cased, tag: cased.toLowerCase() };
  });

/**
 * Tags written into one string, each separated from the next, or straight
 * after it when it starts with a `#`.
 */
const writtenListArb = fc
  .tuple(
    fc.array(
      fc.tuple(writtenTagArb, fc.oneof(fc.constant(''), separatorsArb)),
      { maxLength: 6 }
    ),
    edgeArb,
    edgeArb
  )
  .map(([entries, before, after]) => ({
    raw:
      before +
      entries
        .map(([{ written }, sep], i) => {
          if (i === 0) return written;
          // Two tags with nothing between them would read as one
          return (sep === '' && !written.startsWith('#') ? ',' : sep) + written;
        })
        .join('') +
      after,
    tags: entries.map(([{ tag }]) => tag),
  }));

/** Each of `items` once, where it first appears. */
const firstOfEach = (items: readonly string[]) => [...new Set(items)];

/** A tag key, as Obsidian reads it: `tags`, or the older `tag`, in any case. */
const tagKeyArb = fc.constantFrom('tags', 'tag', 'Tags', 'TAG', 'tAgS');

/** Keys that are not tag keys, though some come close. */
const otherKeyArb = fc
  .oneof(
    fc.constantFrom('aliases', 'tagss', ' tags', 'tags ', 'ir-tags', 'ta', ''),
    fc.string()
  )
  .filter((key) => !/^tags?$/i.test(key) && key !== '__proto__');

/** Values YAML can put under a key that are not a string. */
const nonStringArb = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double(),
  fc.dictionary(fc.string(), fc.string())
);

/**
 * A tag key's value: one string holding any number of tags, a list of such
 * strings mixed with values that are not strings, or a value that is neither.
 * Returns the value and the tags it carries.
 */
const tagValueArb: fc.Arbitrary<{ value: unknown; carried: string[] }> =
  fc.oneof(
    writtenListArb.map(({ raw, tags }) => ({ value: raw, carried: tags })),
    fc
      .array(
        fc.oneof(
          writtenListArb,
          nonStringArb.map((value) => ({ raw: value, tags: [] as string[] }))
        ),
        { maxLength: 4 }
      )
      .map((entries) => ({
        value: entries.map(({ raw }) => raw),
        carried: entries.flatMap(({ tags }) => tags),
      })),
    nonStringArb.map((value) => ({ value, carried: [] }))
  );

/**
 * Frontmatter with tags under any number of tag keys, and other keys holding
 * the same kinds of values, which carry no tags. Returns it with the tags its
 * tag keys carry.
 */
const frontmatterArb = fc
  .tuple(
    fc.uniqueArray(fc.tuple(tagKeyArb, tagValueArb), {
      selector: ([key]) => key,
      maxLength: 3,
    }),
    fc.uniqueArray(fc.tuple(otherKeyArb, tagValueArb), {
      selector: ([key]) => key,
      maxLength: 3,
    })
  )
  .map(([tagEntries, otherEntries]) => ({
    frontmatter: Object.fromEntries([
      ...otherEntries.map(([key, { value }]) => [key, value]),
      ...tagEntries.map(([key, { value }]) => [key, value]),
    ]) as Record<string, unknown>,
    carried: new Set(tagEntries.flatMap(([, { carried }]) => carried)),
  }));

/** Freeze `value` and everything inside it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** A casing someone might write a tag in. */
const casingArb = fc.constantFrom<(text: string) => string>(
  (text) => text,
  (text) => text.toUpperCase(),
  (text) => text.toLowerCase()
);

/** One level of a nested tag: a tag with no `/` in it. */
const segmentArb = tagCoreArb.filter((text) => !text.includes('/'));

/** A tag nested any number of levels deep, as its levels. */
const nestedArb = fc.array(segmentArb, { minLength: 1, maxLength: 4 });

/**
 * The tags a note's body holds, as Obsidian caches them (`cache.tags`): each
 * after one `#`, in any case. Returns them with the tags they read as.
 */
const inlineTagsArb = fc
  .array(fc.tuple(tagCoreArb, casingArb), { maxLength: 4 })
  .map((entries) => ({
    tags: entries.map(([text, casing]) => ({ tag: `#${casing(text)}` })),
    carried: entries.map(([text, casing]) => casing(text).toLowerCase()),
  }));

type TagCache = NonNullable<Parameters<typeof matchAnyTags>[0]>;

/**
 * A note's metadata, as the metadata cache holds it: frontmatter or none,
 * body tags or none, and a field that carries no tags. Returns it with the
 * tags it carries, as compared.
 */
const cacheArb = fc
  .tuple(
    fc.option(frontmatterArb, { nil: undefined }),
    fc.option(inlineTagsArb, { nil: undefined })
  )
  .map(([fm, inline]) => ({
    cache: {
      ...(fm && { frontmatter: fm.frontmatter }),
      ...(inline && { tags: inline.tags }),
      links: [{ link: 'tag', original: '[[tag]]', displayText: 'tag' }],
    } as TagCache,
    carried: new Set([...(fm?.carried ?? []), ...(inline?.carried ?? [])]),
  }));

/**
 * Whether a note carrying `carried` has `asked`, by Obsidian's tag search:
 * the tag itself, or one nested in it.
 */
const carriesTag = (carried: ReadonlySet<string>, asked: string) => {
  const tag = asked.replace(/^#+/, '').toLowerCase();
  return (
    tag !== '' &&
    [...carried].some((held) => held === tag || held.startsWith(`${tag}/`))
  );
};

// #endregion

describe('parseTagList', () => {
  it('reads each tag between commas, whitespace and #s, in lower case, once each, in order', () => {
    fc.assert(
      fc.property(writtenListArb, ({ raw, tags }) => {
        expect(parseTagList(raw)).toEqual(firstOfEach(tags));
      })
    );
  });

  it('reads a tag written twice in different ways once', () => {
    fc.assert(
      fc.property(
        tagCoreArb,
        fc.nat({ max: 2 }),
        separatorsArb,
        (core, hashes, sep) => {
          fc.pre(core.toUpperCase().toLowerCase() === core.toLowerCase());
          const raw = `${core.toLowerCase()}${sep}${'#'.repeat(hashes)}${core.toUpperCase()}`;

          expect(parseTagList(raw)).toEqual([core.toLowerCase()]);
        }
      )
    );
  });

  it('reads tags written one straight after another, each after its #s, as it reads them written one space apart', () => {
    expect(parseTagList('#ir-import#Clippings')).toEqual([
      'ir-import',
      'clippings',
    ]);
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            tagCoreArb,
            fc.integer({ min: 1, max: 3 }),
            fc.oneof(fc.constant(''), separatorsArb)
          ),
          { maxLength: 6 }
        ),
        (entries) => {
          const glued = entries
            .map(([core, hashes, sep]) => '#'.repeat(hashes) + core + sep)
            .join('');
          const spaced = entries.map(([core]) => `#${core}`).join(' ');

          expect(parseTagList(glued)).toEqual(parseTagList(spaced));
          expect(parseTagList(glued)).toEqual(
            firstOfEach(entries.map(([core]) => core.toLowerCase()))
          );
        }
      )
    );
  });

  it('reads no tags from separators and lone #s', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(separatorsArb, fc.stringMatching(/^#{1,3}$/))),
        (parts) => {
          expect(parseTagList(parts.join(','))).toEqual([]);
        }
      )
    );
  });

  it('turns any text into distinct, non-empty, lower-case tags with no separator or leading #, read back unchanged', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (raw) => {
        const tags = parseTagList(raw);

        expect(new Set(tags).size).toBe(tags.length);
        for (const tag of tags) {
          expect(tag).not.toBe('');
          expect(tag).not.toMatch(SEPARATOR);
          expect(tag.startsWith('#')).toBe(false);
          expect(tag).toBe(tag.toLowerCase());
        }
        expect(parseTagList(tags.join(', '))).toEqual(tags);
      })
    );
  });
});

describe('formatTagList', () => {
  it('writes each tag after a #, separated by single spaces', () => {
    expect(formatTagList(['ir-import', 'clippings'])).toBe(
      '#ir-import #clippings'
    );
    expect(formatTagList([])).toBe('');
  });

  it('writes each tag read from a list once, after one #, in order, with one space between each', () => {
    fc.assert(
      fc.property(writtenListArb, ({ tags }) => {
        const read = firstOfEach(tags);

        const written = formatTagList(read);

        if (read.length === 0) {
          expect(written).toBe('');
        } else {
          expect(written.split(' ')).toEqual(read.map((tag) => `#${tag}`));
        }
      })
    );
  });

  it('writes tags that read back as the same tags', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          writtenListArb.map(({ tags }) => firstOfEach(tags)),
          fc.string({ unit: 'binary' }).map(parseTagList)
        ),
        (tags) => {
          expect(parseTagList(formatTagList(tags))).toEqual(tags);
        }
      )
    );
  });
});

describe('matchFrontmatterTags', () => {
  it('returns the tags asked for that any tag key carries, in the order asked', () => {
    fc.assert(
      fc.property(
        frontmatterArb,
        fc.array(writtenTagArb, { maxLength: 6 }),
        ({ frontmatter, carried }, asked) => {
          // Some of what is asked for is carried, written its own way
          const fromCarried = [...carried].map(
            (tag, i) =>
              [`#${tag}`, `##${tag.toUpperCase()}`, tag.toUpperCase()][i % 3]
          );
          const tags = [...asked.map(({ written }) => written), ...fromCarried];

          expect(matchFrontmatterTags(frontmatter, tags)).toEqual(
            tags.filter((tag) =>
              carried.has(tag.replace(/^#+/, '').toLowerCase())
            )
          );
        }
      )
    );
  });

  it('never matches a tag asked for with a # inside it to the tag it would be without that #', () => {
    fc.assert(
      fc.property(
        tagCoreArb,
        tagCoreArb,
        fc.nat({ max: 2 }),
        (left, right, hashes) => {
          const asked = `${'#'.repeat(hashes)}${left}#${right}`;

          expect(
            matchFrontmatterTags({ tags: `${left}${right}` }, [asked])
          ).toEqual([]);
        }
      )
    );
  });

  it('matches a tag key whatever the case of the tag and of the key', () => {
    fc.assert(
      fc.property(
        tagKeyArb,
        writtenTagArb,
        fc.boolean(),
        (key, { written, tag }, asList) => {
          const frontmatter = { [key]: asList ? [written] : written };

          expect(matchFrontmatterTags(frontmatter, [tag])).toEqual([tag]);
          expect(matchFrontmatterTags(frontmatter, [`#${tag}`])).toEqual([
            `#${tag}`,
          ]);
        }
      )
    );
  });

  it('matches every tag in a string or list entry holding several, split by commas, whitespace or #s', () => {
    const frontmatter = {
      tags: 'one, #Two three#nine',
      tag: ['four,five', 'six\tseven', 7, null],
    };

    expect(
      matchFrontmatterTags(frontmatter, [
        'seven',
        'one',
        'two',
        'three',
        'four',
        'five',
        'six',
        '7',
        'eight',
        '#nine',
      ])
    ).toEqual(['seven', 'one', 'two', 'three', 'four', 'five', 'six', '#nine']);
  });

  it('ignores tags under any other key', () => {
    fc.assert(
      fc.property(otherKeyArb, writtenTagArb, (key, { written, tag }) => {
        expect(matchFrontmatterTags({ [key]: written }, [tag])).toEqual([]);
        expect(matchFrontmatterTags({ [key]: [written] }, [tag])).toEqual([]);
      })
    );
  });

  it('matches nothing without frontmatter or without tags to look for', () => {
    fc.assert(
      fc.property(frontmatterArb, ({ frontmatter }) => {
        expect(matchFrontmatterTags(frontmatter, [])).toEqual([]);
      })
    );
    expect(matchFrontmatterTags(null, ['a'])).toEqual([]);
    expect(matchFrontmatterTags(undefined, ['a'])).toEqual([]);
  });

  it('takes the tags to look for from any iterable, a set included', () => {
    expect(
      matchFrontmatterTags({ tags: ['b', 'c'] }, new Set(['a', 'b', 'c']))
    ).toEqual(['b', 'c']);
  });

  it('leaves the frontmatter it reads as it was', () => {
    fc.assert(
      fc.property(
        frontmatterArb,
        fc.array(fc.string()),
        ({ frontmatter }, tags) => {
          const before = structuredClone(frontmatter);

          matchFrontmatterTags(deepFreeze(frontmatter), tags);

          expect(frontmatter).toEqual(before);
        }
      )
    );
  });
});

describe('stripFrontmatterTags', () => {
  /**
   * Tags to take off: some the frontmatter carries, written any way that
   * matches them, and others, a blank and a lone `#` among them.
   */
  const strippedArb = (carried: ReadonlySet<string>) =>
    fc
      .tuple(
        fc.subarray([...carried]),
        fc.array(
          fc.oneof(
            writtenTagArb.map(({ written }) => written),
            fc.constantFrom('', '#', '##')
          ),
          { maxLength: 4 }
        ),
        fc.nat()
      )
      .map(([some, others, spelling]) => [
        ...some.map(
          (tag, i) => [tag, `#${tag}`, tag.toUpperCase()][(spelling + i) % 3]
        ),
        ...others,
      ]);
  const casesArb = frontmatterArb.chain(({ frontmatter, carried }) =>
    strippedArb(carried).map((stripped) => ({
      frontmatter,
      carried,
      stripped,
    }))
  );
  const asCompared = (tag: string) => tag.replace(/^#+/, '').toLowerCase();

  it('takes every tag asked for off every tag key, leaving every other tag carried', () => {
    fc.assert(
      fc.property(casesArb, ({ frontmatter, carried, stripped }) => {
        const gone = new Set(stripped.map(asCompared));

        stripFrontmatterTags(frontmatter, stripped);

        expect(matchFrontmatterTags(frontmatter, stripped)).toEqual([]);
        expect(matchFrontmatterTags(frontmatter, carried)).toEqual(
          [...carried].filter((tag) => !gone.has(tag))
        );
      })
    );
  });

  it('leaves each key that held none of them as it was, and returns what each other key held, to put back', () => {
    fc.assert(
      fc.property(casesArb, ({ frontmatter, stripped }) => {
        const before = { ...frontmatter };
        const snapshot = structuredClone(frontmatter);

        const changed = stripFrontmatterTags(frontmatter, stripped);

        for (const [key, value] of Object.entries(before)) {
          if (Object.hasOwn(changed, key)) {
            expect(changed[key]).toBe(value);
            expect(
              matchFrontmatterTags({ [key]: value }, stripped)
            ).not.toEqual([]);
          } else {
            expect(frontmatter[key]).toBe(value);
          }
        }
        expect(Object.keys(changed).every((key) => key in before)).toBe(true);
        expect(Object.assign(frontmatter, changed)).toEqual(snapshot);
      })
    );
  });

  it('leaves a key it changed as a list of what is left in it, with no blanks, or drops it when nothing is', () => {
    fc.assert(
      fc.property(casesArb, ({ frontmatter, stripped }) => {
        const changed = stripFrontmatterTags(frontmatter, stripped);

        for (const key of Object.keys(changed)) {
          if (!(key in frontmatter)) continue;
          const left = frontmatter[key] as unknown[];
          expect(Array.isArray(left)).toBe(true);
          expect(left.length).toBeGreaterThan(0);
          for (const entry of left) {
            expect(entry === null || entry === undefined).toBe(false);
            if (typeof entry === 'string') {
              expect(entry.trim()).not.toBe('');
            }
          }
        }
      })
    );
  });

  it('keeps each other tag of a key it changed as it was spelled, less its #, and every entry that held none as it was', () => {
    const frontmatter: Record<string, unknown> = {
      tags: [
        '#Keep this',
        'IR-Import, #Clip#Other',
        3,
        null,
        '',
        ' 	',
        undefined,
        false,
      ],
      tag: '#ir-import',
      Tags: 'one two',
      aliases: ['ir-import'],
    };

    const changed = stripFrontmatterTags(frontmatter, ['ir-import', 'clip']);

    expect(frontmatter).toEqual({
      tags: ['#Keep this', 'Other', 3, false],
      Tags: 'one two',
      aliases: ['ir-import'],
    });
    expect(changed).toEqual({
      tags: [
        '#Keep this',
        'IR-Import, #Clip#Other',
        3,
        null,
        '',
        ' 	',
        undefined,
        false,
      ],
      tag: '#ir-import',
    });
  });

  it('turns a lone string it changed into the list of the tags left in it', () => {
    const frontmatter: Record<string, unknown> = {
      tags: 'ir-import Read, #Later',
    };

    stripFrontmatterTags(frontmatter, ['#IR-IMPORT']);

    expect(frontmatter).toEqual({ tags: ['Read', 'Later'] });
  });

  it('takes the tags to take off from any iterable, a set included', () => {
    const frontmatter: Record<string, unknown> = { tags: ['a', 'b', 'c'] };

    stripFrontmatterTags(frontmatter, new Set(['a', 'c']));

    expect(frontmatter).toEqual({ tags: ['b'] });
  });

  it('takes off a tag asked for after several #s, in any case, but no tag that only starts with it', () => {
    const frontmatter: Record<string, unknown> = {
      tags: ['ÉTÉ', 'été-x', 'été/sub', '#Later'],
      TAG: 'later',
    };

    stripFrontmatterTags(frontmatter, ['##été', 'LATER']);

    expect(frontmatter).toEqual({ tags: ['été-x', 'été/sub'] });
  });
});

describe('matchAnyTags', () => {
  it('matches a tag the note carries, and each tag it is nested in, in its frontmatter or its body, in any case, # optional', () => {
    fc.assert(
      fc.property(
        nestedArb,
        fc.nat(),
        casingArb,
        casingArb,
        fc.nat({ max: 2 }),
        fc.constantFrom('string', 'list', 'body'),
        tagKeyArb,
        (levels, cut, carriedCase, askedCase, hashes, where, key) => {
          const depth = (cut % levels.length) + 1;
          const asked = levels.slice(0, depth).map(askedCase);
          // Only casings that read alike: `ß` upper-cased is `SS`
          fc.pre(
            asked.every(
              (level, i) =>
                level.toLowerCase() === carriedCase(levels[i]).toLowerCase()
            )
          );
          const written = levels.map(carriedCase).join('/');
          const cache: TagCache =
            where === 'body'
              ? { tags: [{ tag: `#${written}` }] as TagCache['tags'] }
              : {
                  frontmatter: {
                    [key]: where === 'list' ? [written] : `x, ${written}`,
                  },
                };
          const tag = '#'.repeat(hashes) + asked.join('/');

          expect(matchAnyTags(cache, [tag])).toEqual([tag]);
        }
      )
    );
  });

  it('never matches a tag nested in one the note carries, nor one the carried tag only starts with', () => {
    fc.assert(
      fc.property(
        nestedArb,
        segmentArb,
        fc.boolean(),
        fc.boolean(),
        (levels, more, deeper, inBody) => {
          const carried = levels.join('/');
          const asked = deeper ? `${carried}/${more}` : `${carried}${more}`;
          const cache: TagCache = inBody
            ? { tags: [{ tag: `#${carried}` }] as TagCache['tags'] }
            : { frontmatter: { tags: carried } };

          expect(matchAnyTags(cache, [asked])).toEqual([]);
        }
      )
    );
  });

  it('returns which of the tags asked for the note carries, in the order asked', () => {
    fc.assert(
      fc.property(
        cacheArb,
        fc.array(writtenTagArb, { maxLength: 6 }),
        fc.array(fc.nat(), { maxLength: 4 }),
        ({ cache, carried }, asked, picks) => {
          // Some of what is asked for is carried, or a tag a carried one is
          // nested in, written its own way
          const held = [...carried];
          const fromCarried =
            held.length === 0
              ? []
              : picks.map((pick, i) => {
                  const tag = held[pick % held.length];
                  const parent = tag.includes('/')
                    ? tag.slice(0, tag.indexOf('/'))
                    : tag;
                  return [`#${tag}`, parent, `##${parent}`][i % 3];
                });
          const tags = [...asked.map(({ written }) => written), ...fromCarried];

          expect(matchAnyTags(cache, tags)).toEqual(
            tags.filter((tag) => carriesTag(carried, tag))
          );
        }
      )
    );
  });

  it('finds every tag the frontmatter matcher finds', () => {
    fc.assert(
      fc.property(
        frontmatterArb,
        fc.array(writtenTagArb, { maxLength: 6 }),
        ({ frontmatter, carried }, asked) => {
          const tags = [
            ...asked.map(({ written }) => written),
            ...[...carried].map((tag) => `#${tag}`),
          ];
          const matched = matchFrontmatterTags(frontmatter, tags);

          expect(
            matchAnyTags({ frontmatter }, tags).filter((tag) =>
              matched.includes(tag)
            )
          ).toEqual(matched);
        }
      )
    );
  });

  it('matches nothing for a note with no metadata, for no tags asked, or for a tag of only #s', () => {
    fc.assert(
      fc.property(cacheArb, fc.nat({ max: 3 }), ({ cache }, hashes) => {
        expect(matchAnyTags(cache, [])).toEqual([]);
        expect(matchAnyTags(cache, ['#'.repeat(hashes)])).toEqual([]);
      })
    );
    // Tags that start with `/`, which an empty tag nests nothing in
    expect(matchAnyTags({ frontmatter: { tags: '/x' } }, ['#', ''])).toEqual(
      []
    );
    expect(
      matchAnyTags({ tags: [{ tag: '#/x' }] as TagCache['tags'] }, ['#'])
    ).toEqual([]);
    expect(matchAnyTags(null, ['a'])).toEqual([]);
    expect(matchAnyTags(undefined, ['a'])).toEqual([]);
    expect(matchAnyTags({}, ['a'])).toEqual([]);
  });

  it('takes the tags to look for from any iterable, a set included', () => {
    expect(
      matchAnyTags(
        { tags: [{ tag: '#b' }] as TagCache['tags'] },
        new Set(['a', 'b'])
      )
    ).toEqual(['b']);
  });

  it('leaves the metadata it reads as it was', () => {
    fc.assert(
      fc.property(cacheArb, fc.array(fc.string()), ({ cache }, tags) => {
        const before = structuredClone(cache);

        matchAnyTags(deepFreeze(cache), tags);

        expect(cache).toEqual(before);
      })
    );
  });
});

describe('isItemTypeTag', () => {
  const typeTagArb = fc.constantFrom(ARTICLE_TAG, SNIPPET_TAG, CARD_TAG);

  it('holds for each tag the plugin marks an item type with, and each nested in one, in any case, # optional', () => {
    fc.assert(
      fc.property(
        typeTagArb,
        fc.array(segmentArb, { maxLength: 2 }),
        casingArb,
        fc.nat({ max: 2 }),
        (typeTag, nested, casing, hashes) => {
          const name = casing([typeTag, ...nested].join('/'));
          // Only casings that read alike: `ß` upper-cased is `SS`
          fc.pre(name.toLowerCase().startsWith(typeTag));

          expect(isItemTypeTag('#'.repeat(hashes) + name)).toBe(true);
        }
      )
    );
  });

  it('holds for no other tag: not one a type tag only starts with, nor one it is nested in', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          tagCoreArb,
          fc.tuple(typeTagArb, segmentArb).map(([t, more]) => `${t}${more}`),
          fc
            .tuple(segmentArb, typeTagArb)
            .map(([outer, typeTag]) => `${outer}/${typeTag}`),
          fc.constantFrom('ir', 'ir-', 'ir-import', 'ir-source', '')
        ),
        (tag) => {
          const name = tag.toLowerCase();
          fc.pre(
            ![ARTICLE_TAG, SNIPPET_TAG, CARD_TAG].some(
              (t) => name === t || name.startsWith(`${t}/`)
            )
          );

          expect(isItemTypeTag(tag)).toBe(false);
          expect(isItemTypeTag(`#${tag}`)).toBe(false);
        }
      )
    );
  });
});
