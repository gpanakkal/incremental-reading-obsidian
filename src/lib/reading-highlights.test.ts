// @vitest-environment jsdom

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SnippetHighlight } from './SnippetOffsetTracker';
import { paintSectionHighlights, readingSection } from './reading-highlights';

// #region HELPERS

function makeHighlight(
  overrides: Partial<SnippetHighlight> = {}
): SnippetHighlight {
  return {
    id: 'snippet-1',
    type: 'snippet',
    reference: 'snippets/a.md',
    due: null,
    due_fuzz: null,
    interval: 1,
    dismissed: false,
    deleted: false,
    priority: 50,
    parent: 'articles/parent.md',
    start_offset: 0,
    end_offset: 10,
    scroll_top: 0,
    ...overrides,
  };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Inline syntax: `%%comments%%` (show nothing), `` `code` ``, `**bold**`,
 * `*emphasis*` and `_emphasis_`, `![[embed]]` (shows its note's text),
 * `[[target|alias]]` and `[text](url)` links (show their text), and `[^name]`
 * footnote references, numbered when `footnotes` defines them and left as
 * typed otherwise, as the real renderer does.
 */
function renderInline(text: string, footnotes: string[]): string {
  return escapeHtml(text)
    .replace(/%%.*?%%/g, '')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(
      /!\[\[(.+?)\]\]/g,
      '<span class="internal-embed"><span class="markdown-embed-content">text of $1</span></span>'
    )
    .replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, '<a class="internal-link">$1</a>')
    .replace(/\[([^\]^][^\]]*)\]\([^)]+\)/g, '<a class="external-link">$1</a>')
    .replace(/\[\^([^\]]+)\]/g, (ref: string, name: string) =>
      footnotes.includes(name)
        ? `<sup class="footnote-ref" data-footnote-id="fnref-${name}"><a>[${footnotes.indexOf(name) + 1}]</a></sup>`
        : ref
    );
}

const FOOTNOTE_DEFINITION = /^\[\^([^\]]+)\]: (.*)$/;

const FENCE_LINE = /^ {0,3}```/;
const QUOTE_LINE = /^[ \t]*>[ \t]?/;
const HEADING_LINE = /^[ \t]*(#{1,6})(?:[ \t]+(.*))?$/;
const LIST_LINE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[(.)\][ \t]+)?(.*)$/;

/**
 * Render block-level lines: code fences, quotes, headings, lists, paragraphs.
 */
function renderBlocks(lines: string[], footnotes: string[]): string {
  const html: string[] = [];
  let i = 0;
  // Consecutive lines from `i` that `test` accepts
  const run = (test: (line: string) => boolean) => {
    const taken: string[] = [];
    while (i < lines.length && test(lines[i])) taken.push(lines[i++]);
    return taken;
  };
  const plain = (line: string) =>
    line.trim() !== '' &&
    !FENCE_LINE.test(line) &&
    !QUOTE_LINE.test(line) &&
    !HEADING_LINE.test(line) &&
    !LIST_LINE.test(line);
  while (i < lines.length) {
    const line = lines[i];
    const heading = HEADING_LINE.exec(line);
    if (FENCE_LINE.test(line)) {
      i += 1;
      // To the closing fence, or the end; the code's text shows as typed
      const code = run((l) => !/^[ \t]{0,3}```[ \t]*$/.test(l));
      i += 1;
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}\n</code></pre>`);
    } else if (QUOTE_LINE.test(line)) {
      const inner = run((l) => QUOTE_LINE.test(l)).map((l) =>
        l.replace(QUOTE_LINE, '')
      );
      html.push(
        `<blockquote>\n${renderBlocks(inner, footnotes)}\n</blockquote>`
      );
    } else if (heading) {
      i += 1;
      const level = heading[1].length;
      html.push(
        `<h${level}><span class="heading-collapse-indicator"></span>${renderInline(heading[2] ?? '', footnotes)}</h${level}>`
      );
    } else if (LIST_LINE.test(line)) {
      const items = run((l) => LIST_LINE.test(l)).map((l) => {
        const [, task, text] = LIST_LINE.exec(l)!;
        const box = task === undefined ? '' : '<input type="checkbox">';
        return `<li><span class="list-bullet"></span>${box}${renderInline(text, footnotes)}</li>`;
      });
      html.push(`<ul>\n${items.join('\n')}\n</ul>`);
    } else if (plain(line)) {
      const paragraph = run(plain).map((l) => renderInline(l, footnotes));
      html.push(`<p>${paragraph.join('<br>\n')}</p>`);
    } else {
      i += 1;
    }
  }
  return html.join('\n');
}

/**
 * A stand-in for Obsidian's renderer covering the block syntax snippets sit
 * in: blockquotes, ATX headings (with the collapse indicator Obsidian
 * prepends), lists of any marker and task boxes (bullet span, newlines between
 * items, as Obsidian's HTML has), paragraphs (soft breaks as `<br>\n`),
 * footnote definitions (listed at the end). Markup turns into no text, like
 * the real thing.
 *
 * @param footnotes footnotes the rest of the note defines
 */
function renderMarkdown(
  markdown: string,
  into: HTMLElement,
  footnotes: string[] = []
): void {
  const lines = markdown.split('\n');
  const definitions = lines.flatMap((line) => {
    const match = FOOTNOTE_DEFINITION.exec(line);
    return match ? [match] : [];
  });
  const defined = [...footnotes, ...definitions.map(([, name]) => name)];
  const html = [
    renderBlocks(
      lines.filter((line) => !FOOTNOTE_DEFINITION.test(line)),
      defined
    ),
  ];
  if (definitions.length > 0) {
    const items = definitions.map(
      ([, name, text]) =>
        `<li data-footnote-id="fn-${name}">${escapeHtml(text)}</li>`
    );
    html.push(
      `<section class="footnotes"><ol>${items.join('')}</ol></section>`
    );
  }
  into.innerHTML = html.join('\n');
}

const render = (markdown: string, into: HTMLElement) => {
  renderMarkdown(markdown, into);
  return Promise.resolve();
};

/**
 * A section's element as Obsidian hands it to a post-processor.
 *
 * @param footnotes footnotes the rest of the note defines
 */
function sectionEl(source: string, footnotes: string[] = []): HTMLElement {
  const el = document.createElement('div');
  renderMarkdown(source, el, footnotes);
  return el;
}

/**
 * A section's markdown, with which of its characters reading mode shows: the
 * rest is markup or an embed's link.
 */
interface ModelSection {
  source: string;
  visible: boolean[];
  /** Offsets a highlight boundary can sit at without splitting markup */
  safe: number[];
}

/** Build a {@link ModelSection} from parts in order. */
function buildSection(
  parts: { text: string; visible: boolean; safeInside: boolean }[]
): ModelSection {
  let source = '';
  const visible: boolean[] = [];
  const safe = new Set<number>([0]);
  for (const { text, visible: shown, safeInside } of parts) {
    for (let i = 0; i < text.length; i += 1) {
      if (safeInside) safe.add(source.length + i);
      visible.push(shown);
    }
    source += text;
    safe.add(source.length);
  }
  return { source, visible, safe: [...safe].sort((a, b) => a - b) };
}

/** U+2E3B, the dash the markers are made of, which a note can hold too */
const DASH = String.fromCharCode(0x2e3b);

const wordArb = fc.string({
  unit: fc.constantFrom(...'abcxyz0189', DASH),
  minLength: 1,
  maxLength: 6,
});

/** Footnotes defined in the rest of the note, numbered past one digit. */
const NOTE_FOOTNOTES = [
  ...Array.from({ length: 11 }, (_, i) => `earlier${i}`),
  'a',
  'b',
];
const wordsArb = fc
  .array(wordArb, { minLength: 1, maxLength: 4 })
  .map((words) => words.join(' '));

type Part = Parameters<typeof buildSection>[0][number];
const shown = (text: string): Part => ({
  text,
  visible: true,
  safeInside: true,
});
// Markup a boundary may sit anywhere in: it renders as nothing either way
const prefix = (text: string): Part => ({
  text,
  visible: false,
  safeInside: true,
});
const markup = (text: string): Part => ({
  text,
  visible: false,
  safeInside: false,
});

const inlineArb: fc.Arbitrary<Part[]> = fc.oneof(
  wordsArb.map((text) => [shown(text)]),
  wordsArb.map((text) => [markup('**'), shown(text), markup('**')]),
  fc
    .tuple(fc.constantFrom('*', '_', '`'), wordsArb)
    .map(([mark, text]) => [markup(mark), shown(text), markup(mark)]),
  wordsArb.map((text) => [markup('['), shown(text), markup('](x.md)')]),
  wordsArb.map((text) => [markup('[[target|'), shown(text), markup(']]')]),
  wordsArb.map((text) => [markup(`%%${text}%%`)]),
  wordArb.map((name) => [markup(`![[${name}]]`)]),
  // Shows the note's number for it, which is not the section's to count
  fc.constantFrom('a', 'b').map((name) => [markup(`[^${name}]`)])
);

/**
 * A line's text. Never opening on a comment: what follows it would then run
 * into the soft break's newline, which the model below can't tell.
 */
const lineArb = fc
  .array(inlineArb, { minLength: 1, maxLength: 4 })
  .filter(([first]) => !first[0].text.startsWith('%%'))
  .map((runs) =>
    runs.flatMap((run, i) => (i === 0 ? run : [shown(' '), ...run]))
  );

const blankArb = fc.stringMatching(/^[ \t]{1,3}$/);
const indentArb = fc.stringMatching(/^[ \t]{0,3}$/);

/** Lines joined by newlines, which show as nothing between blocks. */
const linesOf = (lines: Part[][]) =>
  lines.flatMap((line, i) => (i === 0 ? line : [prefix('\n'), ...line]));

/**
 * A paragraph's lines. Its soft break renders as `<br>\n`, a newline that
 * shows as the start of the next line's text, if that starts with text: on its
 * own before an element, it is the HTML's layout like any other.
 */
const paragraphArb = fc
  .array(lineArb, { minLength: 1, maxLength: 3 })
  .map((lines) =>
    lines.flatMap((line, i) =>
      i === 0 ? line : [line[0].visible ? shown('\n') : prefix('\n'), ...line]
    )
  );

const headingArb = fc
  .tuple(
    fc.integer({ min: 1, max: 6 }),
    fc.option(fc.tuple(blankArb, lineArb), { nil: undefined })
  )
  .map(([level, content]) =>
    content === undefined
      ? [prefix('#'.repeat(level))]
      : [prefix('#'.repeat(level) + content[0]), ...content[1]]
  );

const listMarkerArb = fc.oneof(
  fc.constantFrom('-', '*', '+'),
  fc
    .tuple(fc.integer({ min: 0, max: 999_999_999 }), fc.constantFrom('.', ')'))
    .map(([n, end]) => `${n}${end}`)
);

const listArb = fc
  .array(
    fc.tuple(
      indentArb,
      listMarkerArb,
      blankArb,
      fc.option(fc.tuple(fc.constantFrom(' ', 'x', 'X', '/'), blankArb), {
        nil: undefined,
      }),
      lineArb
    ),
    { minLength: 1, maxLength: 4 }
  )
  .map((items) =>
    linesOf(
      items.map(([indent, marker, gap, task, line]) => [
        prefix(indent + marker + gap + (task ? `[${task[0]}]${task[1]}` : '')),
        ...line,
      ])
    )
  );

const quoteArb = fc
  .tuple(
    fc.constantFrom('>', '> ', '>\t'),
    fc.oneof(paragraphArb, listArb, headingArb)
  )
  .map(([marker, inner]) => {
    // Every line of the quoted block gets the marker
    const quoted: Part[] = [prefix(marker)];
    for (const part of inner) {
      quoted.push(part);
      if (part.text === '\n') quoted.push(prefix(marker));
    }
    return quoted;
  });

/**
 * A fenced code block, whose lines show as typed, block syntax and all, and
 * end with a newline.
 */
const fenceArb = fc
  .tuple(
    fc.constantFrom('```\n', '```js\n', ' ```js\n', '   ```\n'),
    fc.array(fc.stringMatching(/^[a-z0-9#>*.-][a-z0-9 #>*.-]{0,10}$/), {
      minLength: 1,
      maxLength: 3,
    })
  )
  .map(([open, lines]) => [
    markup(open),
    ...lines.flatMap((line) => [shown(line), shown('\n')]),
    markup('```'),
  ]);

/** One reading-mode section: a paragraph, heading, list, quote or code. */
const sectionArb: fc.Arbitrary<ModelSection> = fc
  .oneof(paragraphArb, headingArb, listArb, quoteArb, fenceArb)
  .map(buildSection);

/** A section, where it starts in the body, and highlights placed on it. */
const scenarioArb = sectionArb.chain((section) => {
  const bodyOffset = fc.nat({ max: 500 });
  // Safe boundaries in the section, or anywhere outside it
  const boundary = (offset: number) =>
    fc.oneof(
      fc.constantFrom(...section.safe).map((at) => offset + at),
      fc.integer({ min: 0, max: offset }),
      fc.integer({
        min: offset + section.source.length,
        max: offset + section.source.length + 50,
      })
    );
  return bodyOffset.chain((offset) =>
    fc.record({
      section: fc.constant(section),
      bodyOffset: fc.constant(offset),
      highlights: highlightsArb(boundary(offset)),
    })
  );
});

/** Up to four highlights, each between two boundaries `boundary` draws. */
function highlightsArb(boundary: fc.Arbitrary<number>) {
  return fc.array(fc.tuple(boundary, boundary), { maxLength: 4 }).map((pairs) =>
    pairs.map(([a, b], i) =>
      makeHighlight({
        id: `snippet-${i}`,
        reference: `snippets/${i}.md`,
        start_offset: Math.min(a, b),
        end_offset: Math.max(a, b),
      })
    )
  );
}

/** A section with highlights whose boundaries may fall anywhere at all. */
const looseScenarioArb = sectionArb.chain((section) =>
  fc.record({
    section: fc.constant(section),
    highlights: highlightsArb(fc.nat({ max: section.source.length + 10 })),
  })
);

/** Note text made of lines, for {@link readingSection}. */
const noteTextArb = fc
  .array(fc.string({ unit: fc.constantFrom('a', ' ', '-', '#', '\r') }), {
    minLength: 1,
    maxLength: 8,
  })
  .map((lines) => lines.join('\n'));

/** What a highlight over `[start, end)` of the section's source shows. */
function visibleText(section: ModelSection, start: number, end: number) {
  let text = '';
  for (
    let i = Math.max(start, 0);
    i < Math.min(end, section.source.length);
    i += 1
  ) {
    if (section.visible[i]) text += section.source[i];
  }
  return text;
}

/** The text each highlight paints in `el`, by snippet id. */
function painted(el: HTMLElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const span of el.querySelectorAll('.ir-snippet-highlight')) {
    const id = span.getAttribute('data-snippet-id') ?? '';
    result[id] = (result[id] ?? '') + span.textContent;
  }
  return result;
}

// #endregion

describe('paintSectionHighlights', () => {
  it('paints a highlight on its text in a paragraph', async () => {
    const source = 'The quick brown fox';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 4, end_offset: 9 })],
      render
    );
    expect(painted(el)).toEqual({ 'snippet-1': 'quick' });
  });

  it('paints from the text when a highlight starts at a list line', async () => {
    const source = '- first item\n- second item';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 13, end_offset: source.length })],
      render
    );
    expect(painted(el)).toEqual({ 'snippet-1': 'second item' });
  });

  it('paints from the text when a highlight starts at a heading line', async () => {
    const source = '## Some heading';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 0, end_offset: 7 })],
      render
    );
    expect(painted(el)).toEqual({ 'snippet-1': 'Some' });
  });

  it('keeps every span inside a list item when a highlight spans items', async () => {
    const source = '- first item\n- second item';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 8, end_offset: 21 })],
      render
    );
    expect(painted(el)).toEqual({ 'snippet-1': 'itemsecond' });
    expect(el.querySelectorAll('ul > .ir-snippet-highlight')).toHaveLength(0);
  });

  it.each([
    ['still loading in the section', true],
    ['loaded in the section', false],
  ])(
    'paints text after an embed %s on its own text',
    async (_, emptyInSection) => {
      const source = 'See ![[card]] and more words';
      const el = sectionEl(source);
      if (emptyInSection)
        el.querySelector('.internal-embed')!.replaceChildren();
      await paintSectionHighlights(
        el,
        { source, bodyOffset: 0 },
        [makeHighlight({ start_offset: 18, end_offset: 22 })],
        render
      );
      expect(painted(el)).toEqual({ 'snippet-1': 'more' });
      expect(
        el.querySelectorAll('.internal-embed .ir-snippet-highlight')
      ).toHaveLength(0);
    }
  );

  it('paints each highlight on exactly the text its offsets cover', async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArb,
        async ({ section, bodyOffset, highlights }) => {
          const el = sectionEl(section.source, NOTE_FOOTNOTES);
          await paintSectionHighlights(
            el,
            { source: section.source, bodyOffset },
            highlights,
            render
          );
          const result = painted(el);
          for (const { id, start_offset, end_offset } of highlights) {
            expect(result[id] ?? '').toBe(
              visibleText(
                section,
                start_offset - bodyOffset,
                end_offset - bodyOffset
              )
            );
          }
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('changes no text and puts no span between blocks, wherever offsets fall', async () => {
    await fc.assert(
      fc.asyncProperty(looseScenarioArb, async ({ section, highlights }) => {
        const el = sectionEl(section.source, NOTE_FOOTNOTES);
        const before = el.textContent;
        await paintSectionHighlights(
          el,
          { source: section.source, bodyOffset: 0 },
          highlights,
          render
        );
        expect(el.textContent).toBe(before);
        for (const span of el.querySelectorAll('.ir-snippet-highlight')) {
          expect(span.textContent).not.toBe('');
          expect(span.parentElement?.matches('div, ul, blockquote')).toBe(
            false
          );
          expect(span.closest('.internal-embed, [data-footnote-id]')).toBe(
            null
          );
        }
      }),
      { numRuns: 300 }
    );
  });

  it('gives each span its snippet id and reference', async () => {
    const source = '- first item\n- second item';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [
        makeHighlight({
          id: 'abc',
          reference: 'snippets/abc.md',
          start_offset: 2,
          end_offset: 21,
        }),
      ],
      render
    );
    const spans = [...el.querySelectorAll('.ir-snippet-highlight')];
    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) {
      expect(span.tagName).toBe('SPAN');
      expect(span.className).toBe('ir-snippet-highlight');
      expect(span.getAttribute('data-snippet-id')).toBe('abc');
      expect(span.getAttribute('data-snippet-ref')).toBe('snippets/abc.md');
    }
  });

  it('renders once, and only for a highlight boundary inside the section', async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArb,
        async ({ section, bodyOffset, highlights }) => {
          const el = sectionEl(section.source, NOTE_FOOTNOTES);
          let calls = 0;
          await paintSectionHighlights(
            el,
            { source: section.source, bodyOffset },
            highlights,
            (markdown, into) => {
              calls += 1;
              return render(markdown, into);
            }
          );
          const { length } = section.source;
          const inside = (offset: number) =>
            offset > bodyOffset && offset < bodyOffset + length;
          const needsMarker = highlights.some(
            ({ start_offset, end_offset }) =>
              Math.max(start_offset, bodyOffset) <
                Math.min(end_offset, bodyOffset + length) &&
              (inside(start_offset) || inside(end_offset))
          );
          expect(calls).toBe(needsMarker ? 1 : 0);
        }
      )
    );
  });

  it('puts no marker at the edges of a section that cannot take one', async () => {
    // A marker before the fence or after its close would undo the code block
    const source = '```js\nconst x = foo;\n```';
    const el = sectionEl(source);
    const rendered: string[] = [];
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [
        makeHighlight({ id: 'start', start_offset: 0, end_offset: 11 }),
        makeHighlight({ id: 'end', start_offset: 16, end_offset: 99 }),
      ],
      (markdown, into) => {
        rendered.push(markdown);
        return render(markdown, into);
      }
    );
    expect(rendered[0].startsWith('```js\n')).toBe(true);
    expect(rendered[0].endsWith('\n```')).toBe(true);
    expect(painted(el)).toEqual({ start: 'const', end: 'foo;\n' });
  });

  it('puts no span around an empty text node', async () => {
    const source = 'The quick brown fox';
    const el = sectionEl(source);
    el.querySelector('p')!.prepend(document.createTextNode(''));
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 0, end_offset: 3 })],
      render
    );
    const spans = [...el.querySelectorAll('.ir-snippet-highlight')];
    expect(spans.map((span) => span.textContent)).toEqual(['The']);
  });

  it('paints text after a footnote reference the note numbers past nine', async () => {
    const source = 'See this[^a] and that';
    const el = sectionEl(source, NOTE_FOOTNOTES);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 17, end_offset: 20 })],
      render
    );
    expect(painted(el)).toEqual({ 'snippet-1': 'tha' });
  });

  it('nests the highlight that starts later inside, as live preview does', async () => {
    const source = 'one two three four';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [
        makeHighlight({ id: 'inner', start_offset: 4, end_offset: 7 }),
        makeHighlight({ id: 'outer', start_offset: 0, end_offset: 13 }),
      ],
      render
    );
    const inner = el.querySelector('[data-snippet-id="inner"]')!;
    expect(inner.textContent).toBe('two');
    expect(inner.parentElement?.getAttribute('data-snippet-id')).toBe('outer');
  });

  it('paints text after a footnote reference whose name is not a word', async () => {
    const source = 'See this[^my-note] and that';
    const el = sectionEl(source, ['my-note']);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 23, end_offset: 27 })],
      render
    );
    expect(painted(el)).toEqual({ 'snippet-1': 'that' });
  });

  it("paints a heading's text that reads like a list marker", async () => {
    const source = '## 1. Introduction';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 3, end_offset: 8 })],
      render
    );
    expect(painted(el)).toEqual({ 'snippet-1': '1. In' });
  });

  it('keeps the paragraphs of a quote apart when a boundary is on the line between', async () => {
    const source = '> one\n>\n> two words';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [
        makeHighlight({ id: 'first', start_offset: 2, end_offset: 6 }),
        makeHighlight({ id: 'second', start_offset: 14, end_offset: 17 }),
      ],
      render
    );
    expect(painted(el)).toEqual({ first: 'one', second: 'wor' });
  });

  it('leaves a quote opening on a line of only `>` a paragraph', async () => {
    const source = '>\n> text';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 1, end_offset: 6 })],
      render
    );
    expect(painted(el)).toEqual({ 'snippet-1': 'te' });
  });

  it('treats a section as code only when it opens with a fence', async () => {
    const source = '- one\n- two ~~~ three';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 6, end_offset: 11 })],
      render
    );
    expect(painted(el)).toEqual({ 'snippet-1': 'two' });
  });

  it('renders nothing for a highlight with no text', async () => {
    const source = 'The quick brown fox';
    let calls = 0;
    await paintSectionHighlights(
      sectionEl(source),
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 4, end_offset: 4 })],
      () => {
        calls += 1;
        return Promise.resolve();
      }
    );
    expect(calls).toBe(0);
  });

  it('counts the whitespace of code that highlighting splits differently', async () => {
    // Highlighting tokenizes the section's own code, but a marker cutting a
    // keyword leaves its line one run of text
    const source = '```js\nif (x) {\n  return y;\n}\n```';
    const el = document.createElement('div');
    el.innerHTML =
      '<pre><code>if (x) {<span class="token">\n  </span>' +
      '<span class="keyword">return</span> y;\n}\n</code></pre>';
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 20, end_offset: 25 })],
      render
    );
    expect(painted(el)).toEqual({ 'snippet-1': 'urn y' });
  });

  it('paints nothing, and does not throw, when the render drops the markers', async () => {
    const source = 'The quick brown fox';
    const el = sectionEl(source);
    await paintSectionHighlights(
      el,
      { source, bodyOffset: 0 },
      [makeHighlight({ start_offset: 4, end_offset: 9 })],
      (_, into) => {
        into.textContent = 'The quick brown fox';
        return Promise.resolve();
      }
    );
    expect(painted(el)).toEqual({});
  });
});

describe('readingSection', () => {
  it('is the lines asked for, newlines and all, where the body has them', () => {
    fc.assert(
      fc.property(
        noteTextArb,
        fc.nat({ max: 10 }),
        fc.nat({ max: 10 }),
        fc.nat({ max: 30 }),
        (text, a, b, rawBodyStart) => {
          const [lineStart, lineEnd] = [Math.min(a, b), Math.max(a, b)];
          const bodyStart = Math.min(rawBodyStart, text.length);
          const lineCount = text.split('\n').length;
          const result = readingSection(text, lineStart, lineEnd, bodyStart);
          if (result === null) {
            // Only for a section past the end, or one starting before the body
            const startsBeforeBody =
              lineStart < lineCount &&
              text.split('\n', lineStart).join('\n').length +
                (lineStart > 0 ? 1 : 0) <
                bodyStart;
            expect(lineStart >= lineCount || startsBeforeBody).toBe(true);
            return;
          }
          const start = bodyStart + result.bodyOffset;
          // It starts a line and runs to the end of one, in the text itself
          expect(text.slice(start, start + result.source.length)).toBe(
            result.source
          );
          expect(start === 0 || text[start - 1] === '\n').toBe(true);
          const after = text[start + result.source.length];
          expect(after === undefined || after === '\n').toBe(true);
          // At line `lineStart`, spanning the lines asked for that exist
          expect(text.slice(0, start).split('\n')).toHaveLength(lineStart + 1);
          expect(result.source.split('\n')).toHaveLength(
            Math.min(lineEnd, lineCount - 1) - lineStart + 1
          );
        }
      )
    );
  });
});
