// @vitest-environment jsdom
import { parseTagList } from '#/lib/tags';
import fc from 'fast-check';
import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagSuggest, withSuggestion } from './TagSuggest';

// #region HELPERS
/** A suggest over a vault whose tags, as `getTags` lists them, are `tags`. */
function makeSuggest(tags: readonly string[] | null) {
  const getTags = vi.fn(() =>
    Object.fromEntries((tags ?? []).map((tag, i) => [tag, i + 1]))
  );
  const app = {
    metadataCache: tags === null ? {} : { getTags },
  } as unknown as App;
  const suggest = new TagSuggest(app, document.createElement('input'));
  return { suggest, getTags };
}

/** A tag's name: no separator in it, nested or not, in any case. */
const nameArb = fc.oneof(
  fc.mixedCase(fc.constantFrom('read', 'read/later', 'reading', 'x', 'é')),
  fc.stringMatching(/^[a-zA-Z0-9_/-]{1,6}$/)
);

/** The vault's tags as `getTags` keys them: each once, `#` first. */
const vaultTagsArb = fc.uniqueArray(
  nameArb.map((name) => `#${name}`),
  { maxLength: 10, selector: (tag) => tag.toLowerCase() }
);

/** What goes between two typed tags. */
const separatorArb = fc.constantFrom(',', ', ', ' ', ' ,\t', '\n');

/** A separator-free tag being typed, `#`s first or not. */
const typingArb = fc
  .tuple(
    fc.nat({ max: 2 }),
    fc.oneof(fc.constant(''), nameArb, fc.string({ maxLength: 3 }))
  )
  .map(([hashes, name]) => '#'.repeat(hashes) + name)
  .filter((text) => !/[\s,]/.test(text));
// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TagSuggest', () => {
  it('suggests each vault tag whose name holds the tag being typed, any case, # optional, but those listed already, in name order', () => {
    fc.assert(
      fc.property(
        vaultTagsArb,
        fc.array(fc.tuple(nameArb, separatorArb), { maxLength: 3 }),
        typingArb,
        (tags, earlier, typing) => {
          const { suggest } = makeSuggest(tags);
          const before = earlier
            .map(([name, sep]) => `#${name}${sep}`)
            .join('');

          const suggested = suggest.getSuggestions(before + typing);

          const needle = typing.replace(/^#+/, '').toLowerCase();
          const listed = new Set(parseTagList(before));
          expect([...suggested].sort()).toEqual(
            tags
              .filter((tag) => {
                const name = tag.slice(1).toLowerCase();
                return name.includes(needle) && !listed.has(name);
              })
              .sort()
          );
          for (let i = 1; i < suggested.length; i++) {
            expect(
              suggested[i - 1].localeCompare(suggested[i])
            ).toBeLessThanOrEqual(0);
          }
        }
      )
    );
  });

  it('never suggests a tag the plugin marks items with, nor one nested in it, however cased', () => {
    fc.assert(
      fc.property(
        vaultTagsArb,
        fc.uniqueArray(
          fc
            .tuple(
              fc.mixedCase(
                fc.constantFrom('ir-article', 'ir-card', 'ir-text-snippet')
              ),
              fc.constantFrom('', '/x', '/Deep/er')
            )
            .map(([tag, nested]) => `#${tag}${nested}`),
          { maxLength: 4, selector: (tag) => tag.toLowerCase() }
        ),
        typingArb,
        (tags, typeTags, typing) => {
          const { suggest } = makeSuggest([...tags, ...typeTags]);

          const suggested = suggest.getSuggestions(typing);

          expect(
            suggested.filter((tag) =>
              /^#(ir-article|ir-card|ir-text-snippet)(\/|$)/i.test(tag)
            )
          ).toEqual([]);
          // The rest are offered as ever
          expect([...suggested].sort()).toEqual(
            [...makeSuggest(tags).suggest.getSuggestions(typing)].sort()
          );
        }
      )
    );
  });

  it('suggests every tag for an empty field', () => {
    fc.assert(
      fc.property(vaultTagsArb, (tags) => {
        const { suggest } = makeSuggest(tags);

        expect([...suggest.getSuggestions('')].sort()).toEqual(
          [...tags].sort()
        );
      })
    );
  });

  it('takes a # inside the tag being typed as part of it', () => {
    const { suggest } = makeSuggest(['#xy', '#x#y']);

    expect(suggest.getSuggestions('x#y')).toEqual(['#x#y']);
  });

  it('suggests nothing when the vault cannot list its tags', () => {
    const { suggest } = makeSuggest(null);

    expect(suggest.getSuggestions('')).toEqual([]);
  });

  it('shows a tag as the vault lists it', () => {
    fc.assert(
      fc.property(vaultTagsArb, (tags) => {
        const { suggest } = makeSuggest(tags);
        for (const tag of tags) {
          const el = document.createElement('div');
          suggest.renderSuggestion(tag, el);
          expect(el.textContent).toBe(tag);
        }
      })
    );
  });
});

describe('withSuggestion', () => {
  it('puts the tag picked in place of the tag being typed, keeping what comes before it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(nameArb, separatorArb), { maxLength: 3 }),
        typingArb,
        nameArb,
        (earlier, typing, picked) => {
          const before = earlier
            .map(([name, sep]) => `#${name}${sep}`)
            .join('');

          expect(withSuggestion(before + typing, `#${picked}`)).toBe(
            `${before}#${picked}`
          );
        }
      )
    );
  });
});
