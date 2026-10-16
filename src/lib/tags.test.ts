import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatTagList, matchFrontmatterTags, parseTagList } from './tags';

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
