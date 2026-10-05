import { CLOZE_DELIMITERS } from '#/lib/constants';
import { LEGACY_ENTITIES, Markdown } from '#/lib/Markdown';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fc from 'fast-check';
import * as fs from 'node:fs/promises';
import { expectPlainText, readMarkdown, squashed } from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  shouldCleanup,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

// #region HELPERS

const [LEFT, RIGHT] = CLOZE_DELIMITERS;

/** What escaped text reads as once the escapes Markdown honors are read. */
const unescape = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** `text` with the answer at `range` escaped around and delimited, as a card from a PDF is. */
function delimited(text: string, range: [number, number]) {
  const escaped = Markdown.escapeAround(text, range);
  const [from, to] = escaped.range;
  return (
    escaped.text.slice(0, from) +
    `${LEFT} ${escaped.text.slice(from, to)} ${RIGHT}` +
    escaped.text.slice(to)
  );
}

/** A card note's body with its answer hidden, as review shows it. */
const hideAnswer = (page: Page, body: string) =>
  page.evaluate((body) => {
    const { app } = window as unknown as {
      app: {
        plugins: {
          plugins: Record<
            string,
            {
              reviewManager: {
                cards: { constructor: { hideAnswer(text: string): string } };
              };
            }
          >;
        };
      };
    };
    return app.plugins.plugins[
      'incremental-reading'
    ].reviewManager.cards.constructor.hideAnswer(body);
  }, body);

/**
 * Check that the card made of `text` with the answer at `range` reads as
 * itself in all three parsers, its delimiters and all, and in review, its
 * answer hidden, as the text around a blank.
 */
async function expectCardPlain(text: string, range: [number, number]) {
  const body = delimited(text, range);
  expectPlainText(await readMarkdown(window, body), unescape(body));
  const hidden = await hideAnswer(window, body);
  const pre = body.slice(0, body.indexOf(LEFT));
  const post = body.slice(body.indexOf(RIGHT) + RIGHT.length);
  // Review renders it with `MarkdownRenderer`, reading view's renderer: it
  // is never a note, so live preview and the cache never read it
  const readings = await readMarkdown(window, hidden, [
    'mark.ir-hidden-answer',
  ]);
  expect(readings.reading.syntax).toEqual([]);
  expect(readings.reading.blocks.map(({ tag }) => tag)).toEqual(
    readings.reading.blocks.map(() => 'P')
  );
  expect(
    squashed(readings.reading.blocks.map((block) => block.text).join(' '))
  ).toBe(squashed(`${unescape(pre)}______${unescape(post)}`));
}

/** Text of the characters Markdown and Obsidian read, and a range of it for an answer. */
const unitArb = fc.oneof(
  fc.constantFrom(
    ...'\\`*_{}[]#$%&<>^=~!|()-+.:/@ \n'.split(''),
    '\u00a0',
    '\t',
    '![[',
    '[[',
    '](',
    '#tag',
    '#ir-card',
    '#1',
    '(}',
    '{)',
    '{{',
    '}}',
    '<%*',
    '%%',
    '==',
    '[^1]',
    '^[',
    ' ^block',
    '---',
    '1. ',
    '-5',
    '> ',
    '[!note]',
    '<b>',
    '&amp',
    '&notit;',
    '```',
    'https://e.x/t',
    'www.e.x',
    'a@b.co',
    'josé@b.co',
    'doi:10.1/x',
    'arxiv.org/a',
    'www1.e.x',
    'snake_case',
    'AT&T',
    'a_b_é',
    ' $5',
    '$x$',
    '(k:: v)',
    'a|b',
    '<https://e.x>'
  ),
  fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 1 })
);
const caseArb = fc
  .string({ unit: unitArb, minLength: 1, maxLength: 30 })
  .chain((text) =>
    fc.tuple(fc.nat(text.length), fc.nat(text.length)).map(([x, y]) => ({
      text,
      range: [Math.min(x, y), Math.max(x, y)] as [number, number],
    }))
  );
// #endregion

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('escape');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

/*
 * Fixed cases, from what Obsidian 1.13.7 was seen to read (task 0032's
 * audit). The escaper leaves some syntax characters bare where Obsidian forms
 * nothing of them; should an update change that, these fail.
 */
test.describe('Escaped PDF text, case by case', () => {
  test('reads as itself where the escaper leaves syntax characters bare', async () => {
    const cases = [
      'C# and #1, #2. #3) x # y x(#a x/#b x—#c x\u200b#d x\u00ad#e ##f',
      'costs $5 and $10, $5, $10 and $20 today',
      'x < 5, x <5, a<1, a <- b <= c, a<é>b',
      'x > 5 and y >= 2',
      'AT&T R&D Q&A S&P P&L &Amp &foo',
      'see [1], [2] and [Smith 2003] [sic].',
      '[1] [2] and [a] [b] [a][b] [a](b) [a]: x ![a](b.png) [[a]] [^1]',
      'x^2 + y^2 more, a ^b c',
      '-5 degrees\n1.5 million\n+3 more\n= x\n3)x\n1234567890. x',
      'a_b_c snake_case_name x_1_y',
      'f(x) {a, b} ({x}) C:\\Users\\a b a\\b',
      'a ~x~ b a=b 50% a:b a//b x.y',
    ];
    for (const text of cases) {
      expectPlainText(await readMarkdown(window, Markdown.escape(text)), text);
    }
  });

  test('escapes a tag after whitespace of every kind Obsidian takes for it', async () => {
    const spaces = [
      ' ',
      '\t',
      '\u00a0',
      '\u2009',
      '\u200a',
      '\u202f',
      '\u3000',
      '\ufeff',
      '\u2028',
    ];
    for (const space of spaces) {
      const text = `x${space}#tag x${space}#1st`;
      // Bare, a tag: what makes the escape needed
      expect((await readMarkdown(window, text)).cache.found).toHaveProperty(
        'tags'
      );
      expectPlainText(await readMarkdown(window, Markdown.escape(text)), text);
    }
  });

  test('escapes a `$` that could close math, as one after a line break or a non-breaking space can', async () => {
    const cases = [
      'x $5\n$ z',
      'x $5 y\u00a0$ z',
      '$5 and 10$ x',
      '$5 and (10)$ x',
      'US$5 and $10 x',
      '($5) and ($10)',
      'x $a b$5 c$ d',
      'a $$ b $$ c',
      '$$5',
      '$5$',
    ];
    for (const text of cases) {
      expectPlainText(await readMarkdown(window, Markdown.escape(text)), text);
    }
    // Bare, math: what makes the escape needed
    for (const text of ['x $5\n$ z', 'x $5 y\u00a0$ z']) {
      expect(
        (await readMarkdown(window, text)).reading.syntax.length
      ).toBeGreaterThan(0);
    }
  });

  test('escapes a line marker before whitespace of any kind, and drops indents of any kind', async () => {
    const cases = [
      '-\u00a0x',
      '1.\u3000x',
      '-\u2003x',
      '-\u000bx',
      '-\u000cx',
      '+\tx',
      '1)\tx',
      '\u00a0- x',
      '\u3000- x',
      '\u00a0\u00a01. x',
      '\u00a0\u00a0\u00a0\u00a0\u00a0code',
      '    code',
      'a\n==  ',
      'a\n=\t',
      'a\n- -',
      'a\n---',
      'x\n2. y',
      'x\n> y',
      'x\n#tag',
      '-\n+\n1.',
    ];
    for (const text of cases) {
      expectPlainText(
        await readMarkdown(window, Markdown.escape(text)),
        text.replace(/(^|\n)\s+/g, '$1')
      );
    }
  });

  test('escapes what reading view links: an autolink, after a `<` or not', async () => {
    const cases = [
      'see <https://e.x> now',
      '<<https://e.x>',
      'a <<mailto:a@b.co>',
    ];
    for (const text of cases) {
      // Bare, a link in reading view: what makes the escape needed
      expect(
        (await readMarkdown(window, text)).reading.syntax.some((el) =>
          el.startsWith('<a')
        )
      ).toBe(true);
      expectPlainText(await readMarkdown(window, Markdown.escape(text)), text);
    }
  });

  test('escapes what live preview links: a scheme in its list, a numbered www host, a domain before a path, an address of any letters', async () => {
    const cases = [
      'see arxiv.org/abs/2101.00001 for details',
      'github.com/user/repo',
      'doi:10.1038/nphys1170',
      'tel:5551234 and urn:isbn:0451450523 and geo:1,2',
      'javascript:alert(1) file:///etc/passwd',
      'www1.e.x and WWW999.e.x',
      'contact josé@example.com today',
      'mailto:a@b.co',
      'see javascript:/a/,alert(1) now',
      'see file:/etc/passwd now',
      'see https:/evil.example/login now',
      '<<https://e.x>',
    ];
    for (const text of cases) {
      // Bare, a link in live preview: what makes the escape needed.
      // Undocumented: `cm-url`, the class live preview gives a link it finds
      expect((await readMarkdown(window, text)).live.classes).toContain(
        'cm-url'
      );
      expectPlainText(await readMarkdown(window, Markdown.escape(text)), text);
    }
  });

  test('escapes every entity a browser reads without its `;`', async () => {
    for (const name of LEGACY_ENTITIES) {
      const text = `x&${name}q &${name};`;
      // Bare, decoded: what makes the escape needed
      const bare = await readMarkdown(window, text);
      expect(squashed(bare.reading.blocks[0].text)).not.toBe(text);
      expectPlainText(await readMarkdown(window, Markdown.escape(text)), text);
    }
    expectPlainText(
      await readMarkdown(
        window,
        Markdown.escape('&#38 &#x26; &notit; &section &copy2024 &x;')
      ),
      '&#38 &#x26; &notit; &section &copy2024 &x;'
    );
  });

  test('reads a card as itself, its answer hidden or not, whatever stands beside its ends', async () => {
    const cases: [string, [number, number]][] = [
      ['a_b_c', [2, 3]],
      ['[a]b', [3, 4]],
      ['C#x', [1, 3]],
      ['a\n-b', [0, 3]],
      ['x *y* z', [3, 4]],
      ['x #1 y', [4, 6]],
      ['x ^ab', [4, 5]],
      ['a $5 b', [3, 6]],
      ['www.e.x', [3, 7]],
      ['AT&amp;', [3, 7]],
      ['<%* x %>', [1, 8]],
      ['a\\', [1, 2]],
      ['a\\b', [2, 3]],
      ['(}x{)', [2, 3]],
      // An answer ending in a line break: the closing delimiter's space
      // starts the next line
      ['www1.e.x|arxiv.org/a\nA', [0, 21]],
    ];
    for (const [text, range] of cases) await expectCardPlain(text, range);
  });
});

test('renders escaped text as the text itself in all three of its parsers, as a note, a card, and a card under review', async () => {
  test.setTimeout(600_000);
  await fc.assert(
    fc.asyncProperty(caseArb, async ({ text, range }) => {
      const escaped = Markdown.escape(text);
      expectPlainText(await readMarkdown(window, escaped), unescape(escaped));
      await expectCardPlain(text, range);
    }),
    { numRuns: 100 }
  );
});
