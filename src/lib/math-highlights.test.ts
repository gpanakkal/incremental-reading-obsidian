// @vitest-environment jsdom

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearMath,
  displayMath,
  mathMarkCount,
  mathTex,
  paintMath,
  paintSectionMath,
  type MathHighlight,
} from './math-highlights';
import type { SnippetHighlight } from './SnippetOffsetTracker';

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

/**
 * MathJax as far as these tests need it: each `\class{c}{…}` an element of
 * class `c` holding what it wraps, each other character a glyph element
 * holding it, and `\error` anywhere a parse error, as MathJax's `noerrors`
 * draws one.
 */
function fakeRender(tex: string): HTMLElement {
  const container = document.createElement('mjx-container');
  container.className = 'MathJax';
  const math = document.createElement('mjx-math');
  container.append(math);
  if (tex.includes('\\error')) {
    const error = document.createElement('mjx-merror');
    error.setAttribute('data-mjx-error', 'Undefined control sequence');
    error.textContent = tex;
    math.append(error);
    return container;
  }
  let node: Element = math;
  const opened: boolean[] = [];
  for (let i = 0; i < tex.length; i += 1) {
    const wrapper = /^\\class\{([^}]*)\}\{/.exec(tex.slice(i));
    if (wrapper) {
      const el = document.createElement('mjx-mrow');
      el.className = wrapper[1];
      node.append(el);
      node = el;
      opened.push(true);
      i += wrapper[0].length - 1;
    } else if (tex[i] === '{') {
      opened.push(false);
    } else if (tex[i] === '}') {
      if (opened.pop()) node = node.parentElement!;
    } else if (/\S/.test(tex[i])) {
      const glyph = document.createElement('mjx-c');
      glyph.textContent = tex[i];
      node.append(glyph);
    }
  }
  return container;
}

/** A `.math` block Obsidian has drawn `tex` into, in `parent` if given. */
function makeBlock(tex: string, parent?: HTMLElement): HTMLElement {
  const block = document.createElement('div');
  block.className = 'math math-block is-loaded';
  block.append(fakeRender(tex));
  parent?.append(block);
  return block;
}

const containerOf = (block: HTMLElement) =>
  block.querySelector<HTMLElement>(':scope > mjx-container')!;

/** The marks in `block` below its formula, each as id, ref and glyphs. */
const innerMarks = (block: HTMLElement) =>
  Array.from(
    containerOf(block).querySelectorAll<HTMLElement>('.ir-snippet-highlight')
  ).map((el) => ({
    id: el.getAttribute('data-snippet-id'),
    ref: el.getAttribute('data-snippet-ref'),
    text: el.textContent,
  }));

/** The highlight the whole formula shows, by id, if any. */
const wholeMark = (block: HTMLElement) => {
  const container = containerOf(block);
  return container.classList.contains('ir-snippet-highlight')
    ? container.getAttribute('data-snippet-id')
    : null;
};

const at = (
  tex: string,
  part: string,
  id = 'snippet-1',
  extra = 0
): MathHighlight => {
  const start = tex.indexOf(part);
  return {
    highlight: makeHighlight({ id, reference: `snippets/${id}.md` }),
    start: start - extra,
    end: start + part.length + extra,
  };
};

const BLOCK = '\na^2 + b^2 = c^2\n\\quad\\text{and}\\quad\ne^{i\\pi} + 1 = 0\n';
const LINE = 'a^2 + b^2 = c^2';

/** Plain lines of TeX: letters, digits, operators, spaces, newlines */
const plainTexArb = fc
  .array(fc.constantFrom('a', 'b', '2', '+', '=', ' ', '\n', '  '), {
    minLength: 1,
    maxLength: 30,
  })
  .map((parts) => parts.join(''));

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('displayMath', () => {
  /** Markdown made of text, `$$` math and escaped dollars, with each math's TeX span */
  const markdownArb = fc
    .array(
      fc.oneof(
        fc
          .array(fc.constantFrom('a', ' ', '\n', '#', '\\$', '\\\\'), {
            maxLength: 6,
          })
          .map((t) => ({ text: t.join(''), math: false })),
        fc
          .array(
            fc.constantFrom('x', ' ', '\n', '^', '{', '}', '\\alpha', '\\$'),
            {
              maxLength: 6,
            }
          )
          .map((t) => ({ text: t.join(''), math: true }))
      ),
      { maxLength: 6 }
    )
    .map((parts) => {
      let source = '';
      const spans: { texStart: number; texEnd: number }[] = [];
      for (const { text, math } of parts) {
        if (math) {
          spans.push({
            texStart: source.length + 2,
            texEnd: source.length + 2 + text.length,
          });
          source += `$$${text}$$`;
        } else {
          source += text;
        }
      }
      return { source, spans };
    });

  it('finds each $$-delimited math, by where its TeX lies, escaped dollars left out', () => {
    fc.assert(
      fc.property(markdownArb, ({ source, spans }) => {
        expect(displayMath(source)).toEqual(spans);
      })
    );
  });

  it('pairs no delimiter left over', () => {
    expect(displayMath('$$a$$ and $$b')).toEqual([{ texStart: 2, texEnd: 3 }]);
  });
});

describe('paintMath', () => {
  it('does nothing to a block MathJax has not drawn yet', () => {
    const block = document.createElement('div');
    block.textContent = LINE;
    const render = vi.fn(fakeRender);
    expect(paintMath(block, BLOCK, [at(BLOCK, LINE)], render)).toBe(false);
    expect(block.innerHTML).toBe(LINE);
    expect(render).not.toHaveBeenCalled();
  });

  it('marks the part of the formula a highlight was cut from, opening its snippet', () => {
    const block = makeBlock(BLOCK);
    const before = containerOf(block);
    expect(paintMath(block, BLOCK, [at(BLOCK, LINE)], fakeRender)).toBe(true);
    expect(containerOf(block)).not.toBe(before);
    expect(innerMarks(block)).toEqual([
      { id: 'snippet-1', ref: 'snippets/snippet-1.md', text: 'a^2+b^2=c^2' },
    ]);
    expect(wholeMark(block)).toBeNull();
    expect(containerOf(block).querySelector('.ir-inert-highlight')).toBeNull();
  });

  it('marks inert parts with no snippet to open', () => {
    const block = makeBlock(BLOCK);
    paintMath(block, BLOCK, [at(BLOCK, LINE)], fakeRender, { inert: true });
    const mark = containerOf(block).querySelector('.ir-snippet-highlight')!;
    expect(mark.classList.contains('ir-inert-highlight')).toBe(true);
    expect(mark.getAttribute('data-snippet-id')).toBe('snippet-1');
    expect(mark.hasAttribute('data-snippet-ref')).toBe(false);
  });

  it('marks the whole formula, as drawn, for a highlight over all of it', () => {
    const block = makeBlock(BLOCK);
    const before = containerOf(block);
    const render = vi.fn(fakeRender);
    paintMath(block, BLOCK, [at(BLOCK, BLOCK.trim(), 'snippet-1', 1)], render);
    expect(containerOf(block)).toBe(before);
    expect(wholeMark(block)).toBe('snippet-1');
    expect(before.getAttribute('data-snippet-ref')).toBe(
      'snippets/snippet-1.md'
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('marks nothing for a highlight over blanks only', () => {
    const block = makeBlock(BLOCK);
    const before = block.innerHTML;
    const render = vi.fn(fakeRender);
    paintMath(block, BLOCK, [{ ...at(BLOCK, LINE), start: 0, end: 1 }], render);
    expect(block.innerHTML).toBe(before);
    expect(render).not.toHaveBeenCalled();
  });

  it('shows on every part of the formula a highlight can be told apart in', () => {
    fc.assert(
      fc.property(
        plainTexArb.chain((tex) =>
          fc.tuple(fc.constant(tex), fc.nat(tex.length), fc.nat(tex.length))
        ),
        ([tex, a, b]) => {
          const [start, end] = [Math.min(a, b), Math.max(a, b)];
          const block = makeBlock(tex);
          const highlight = { highlight: makeHighlight(), start, end };
          paintMath(block, tex, [highlight], fakeRender);
          const glyphs = (s: string) => s.replace(/\s/g, '');
          // Snapped out to whole tokens, as words aren't: letters are one each
          const touched = glyphs(tex.slice(start, end));
          if (touched === '') {
            expect(mathMarkCount(block)).toBe(0);
          } else if (touched === glyphs(tex)) {
            expect(wholeMark(block)).toBe('snippet-1');
            expect(innerMarks(block)).toEqual([]);
          } else {
            expect(wholeMark(block)).toBeNull();
            expect(
              innerMarks(block)
                .map((m) => m.text)
                .join('')
            ).toBe(touched);
          }
        }
      )
    );
  });

  it('marks the whole formula when the wrapped TeX does not parse', () => {
    const tex = 'a + \\error + b';
    const block = makeBlock('a + b');
    const before = containerOf(block);
    paintMath(block, tex, [at(tex, 'a')], fakeRender);
    expect(containerOf(block)).toBe(before);
    expect(wholeMark(block)).toBe('snippet-1');
  });

  it('marks the whole formula when drawing the wrapped TeX throws', () => {
    const block = makeBlock(BLOCK);
    const before = containerOf(block);
    const render = vi.fn(() => {
      throw new Error('MathJax not loaded');
    });
    expect(paintMath(block, BLOCK, [at(BLOCK, LINE)], render)).toBe(true);
    expect(containerOf(block)).toBe(before);
    expect(wholeMark(block)).toBe('snippet-1');
  });

  it('marks the whole formula when MathJax drops the class', () => {
    const block = makeBlock(BLOCK);
    const classless = (tex: string) =>
      fakeRender(tex.replace(/\\class\{[^}]*\}/g, ''));
    paintMath(block, BLOCK, [at(BLOCK, LINE)], classless);
    expect(wholeMark(block)).toBe('snippet-1');
    expect(innerMarks(block)).toEqual([]);
  });

  it('shows the later-starting of two highlights on the whole formula', () => {
    const block = makeBlock(BLOCK);
    const later = at(BLOCK, BLOCK.trim(), 'later');
    const earlier = { ...at(BLOCK, BLOCK, 'earlier'), start: 0 };
    paintMath(block, BLOCK, [later, earlier], fakeRender);
    expect(wholeMark(block)).toBe('later');
  });

  it('gives overlapping highlights each their part, by where they start', () => {
    const tex = 'a + b + c';
    const block = makeBlock(tex);
    paintMath(
      block,
      tex,
      [at(tex, 'b + c', 'second'), at(tex, 'a + b', 'first')],
      fakeRender
    );
    expect(innerMarks(block)).toEqual([
      { id: 'first', ref: 'snippets/first.md', text: 'a' },
      { id: 'first', ref: 'snippets/first.md', text: '+' },
      { id: 'first', ref: 'snippets/first.md', text: 'b' },
      { id: 'second', ref: 'snippets/second.md', text: 'b' },
      { id: 'second', ref: 'snippets/second.md', text: '+' },
      { id: 'second', ref: 'snippets/second.md', text: 'c' },
    ]);
  });

  it('takes off what it showed before, drawing its own rendering again', () => {
    const block = makeBlock(BLOCK);
    paintMath(block, BLOCK, [at(BLOCK, LINE)], fakeRender);
    const render = vi.fn(fakeRender);
    expect(paintMath(block, BLOCK, [], render)).toBe(true);
    expect(render).toHaveBeenCalledWith(BLOCK);
    expect(containerOf(block).outerHTML).toBe(fakeRender(BLOCK).outerHTML);
  });

  it('marks a rendering of its own drawn from the same TeX again without drawing it', () => {
    const block = makeBlock(BLOCK);
    paintMath(block, BLOCK, [at(BLOCK, LINE, 'old')], fakeRender);
    const drawn = containerOf(block);
    const render = vi.fn(fakeRender);
    // Inert now, for another highlight on the same part
    paintMath(block, BLOCK, [at(BLOCK, LINE, 'new')], render, { inert: true });
    expect(render).not.toHaveBeenCalled();
    expect(containerOf(block)).toBe(drawn);
    expect(innerMarks(block)).toEqual([
      { id: 'new', ref: null, text: 'a^2+b^2=c^2' },
    ]);
    expect(
      containerOf(block).querySelectorAll('.ir-inert-highlight')
    ).toHaveLength(1);
  });

  it('draws once, from the new wrapped TeX, when a highlight moves', () => {
    const block = makeBlock(BLOCK);
    paintMath(block, BLOCK, [at(BLOCK, LINE)], fakeRender);
    const render = vi.fn(fakeRender);
    paintMath(block, BLOCK, [at(BLOCK, 'e^{i\\pi} + 1 = 0')], render);
    expect(render).toHaveBeenCalledTimes(1);
    expect(innerMarks(block)).toEqual([
      { id: 'snippet-1', ref: 'snippets/snippet-1.md', text: 'e^i\\pi+1=0' },
    ]);
  });

  it('takes a whole-formula mark off the rendering it is on', () => {
    const block = makeBlock(BLOCK);
    const before = containerOf(block);
    paintMath(block, BLOCK, [at(BLOCK, BLOCK.trim())], fakeRender);
    const render = vi.fn(fakeRender);
    paintMath(block, BLOCK, [], render);
    expect(containerOf(block)).toBe(before);
    expect(before.outerHTML).toBe(fakeRender(BLOCK).outerHTML);
    expect(render).not.toHaveBeenCalled();
  });

  it('swaps one part for another as the highlights change', () => {
    const block = makeBlock(BLOCK);
    paintMath(block, BLOCK, [at(BLOCK, LINE)], fakeRender);
    paintMath(
      block,
      BLOCK,
      [at(BLOCK, 'e^{i\\pi} + 1 = 0', 'other')],
      fakeRender
    );
    expect(innerMarks(block)).toEqual([
      // The fake draws no braces
      { id: 'other', ref: 'snippets/other.md', text: 'e^i\\pi+1=0' },
    ]);
  });

  it('gives up on a rendering of its own it cannot draw again', () => {
    const block = makeBlock(BLOCK);
    paintMath(block, BLOCK, [at(BLOCK, LINE)], fakeRender);
    const ours = containerOf(block);
    const broken = () => {
      throw new Error('gone');
    };
    expect(paintMath(block, BLOCK, [], broken)).toBe(false);
    expect(containerOf(block)).toBe(ours);
  });
});

describe('clearMath', () => {
  it('takes every highlight off the formulas in a root', () => {
    const root = document.createElement('div');
    const partial = makeBlock(BLOCK, root);
    const whole = makeBlock(BLOCK, root);
    paintMath(partial, BLOCK, [at(BLOCK, LINE)], fakeRender);
    paintMath(whole, BLOCK, [at(BLOCK, BLOCK.trim())], fakeRender);
    expect(mathMarkCount(root)).toBe(2);
    clearMath(root, fakeRender);
    expect(mathMarkCount(root)).toBe(0);
    expect(root.innerHTML).toBe(
      makeBlock(BLOCK).outerHTML + makeBlock(BLOCK).outerHTML
    );
  });
});

describe('mathMarkCount', () => {
  it('counts marks on formulas and in them, and none elsewhere', () => {
    const root = document.createElement('div');
    const block = makeBlock('a + b', root);
    const span = document.createElement('span');
    span.className = 'ir-snippet-highlight';
    root.append(span);
    expect(mathMarkCount(root)).toBe(0);
    paintMath(block, 'a + b', [at('a + b', 'a'), at('a + b', 'b')], fakeRender);
    expect(mathMarkCount(root)).toBe(2);
    paintMath(block, 'a + b', [at('a + b', 'a + b')], fakeRender);
    expect(mathMarkCount(root)).toBe(1);
  });
});

describe('mathTex', () => {
  /** Lines of TeX, none starting with a quote marker */
  const linesArb = fc.array(
    fc
      .array(fc.constantFrom('a', '+', ' ', '\\alpha', '>', '{x}'), {
        maxLength: 5,
      })
      .map((parts) => parts.join(''))
      // Obsidian takes a space after a quote marker as part of the marker
      .filter((line) => !/^[ \t]*>/.test(line) && !/^[ \t]/.test(line)),
    { minLength: 1, maxLength: 4 }
  );

  it('is what lies between the delimiters of math outside a quote', () => {
    fc.assert(
      fc.property(fc.string(), linesArb, (before, lines) => {
        const lead = before.replace(/[$\\>\n]/g, '');
        const source = `${lead}$$${lines.join('\n')}$$`;
        const [span] = displayMath(source);
        const { tex, offsets } = mathTex(source, span);
        expect(tex).toBe(lines.join('\n'));
        expect(offsets).toEqual(
          Array.from({ length: tex.length + 1 }, (_, i) => span.texStart + i)
        );
      })
    );
  });

  it('leaves out the quote markers of math in a quote, placing each character where the markdown has it', () => {
    fc.assert(
      fc.property(
        linesArb,
        fc.constantFrom('> ', '>', '> > ', '  > '),
        fc.constantFrom('', '[!note]\n> '),
        (lines, marker, title) => {
          const source = `${marker}${title}$$${lines.join(`\n${marker}`)}$$`;
          const [span] = displayMath(source);
          const { tex, offsets } = mathTex(source, span);
          expect(tex).toBe(lines.join('\n'));
          expect(offsets).toHaveLength(tex.length + 1);
          Array.from(tex).forEach((c, i) => expect(source[offsets[i]]).toBe(c));
          expect(offsets.at(-1)).toBe(span.texEnd);
          for (let i = 1; i < offsets.length; i += 1) {
            expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
          }
        }
      )
    );
  });

  it('keeps a line’s quote marker in math outside a quote', () => {
    const source = '$$a\n> b$$';
    expect(mathTex(source, displayMath(source)[0]).tex).toBe('a\n> b');
  });

  it('keeps a quote marker after the opening delimiter', () => {
    const source = 'a $$> b\n> c$$';
    expect(mathTex(source, displayMath(source)[0]).tex).toBe('> b\n> c');
  });

  it('keeps a line of math in a quote that has no marker of its own', () => {
    const source = '> $$a\nb$$';
    expect(mathTex(source, displayMath(source)[0]).tex).toBe('a\nb');
  });

  it('stops at the closing delimiter of a line of only markers', () => {
    const source = '> $$a\n> $$';
    expect(mathTex(source, displayMath(source)[0])).toEqual({
      tex: 'a\n',
      offsets: [4, 5, 8],
    });
  });
});

describe('paintSectionMath', () => {
  const source = `Intro $$x$$ line\n\n$$${BLOCK}$$`;
  const bodyOffset = 7;
  const section = { source, bodyOffset };
  /** A highlight over `part` of the section, by offsets in the note's body */
  const over = (part: string, id = 'snippet-1', from = source.indexOf(part)) =>
    makeHighlight({
      id,
      reference: `snippets/${id}.md`,
      start_offset: bodyOffset + from,
      end_offset: bodyOffset + from + part.length,
    });
  /** The section's formulas, as reading mode draws them */
  const drawn = (el: HTMLElement) => [makeBlock('x', el), makeBlock(BLOCK, el)];

  it('marks the part of each formula a highlight covers', () => {
    const el = document.createElement('div');
    const [inline, block] = drawn(el);
    paintSectionMath(el, section, [over(LINE)], fakeRender);
    expect(innerMarks(block).map((m) => m.text)).toEqual(['a^2+b^2=c^2']);
    expect(mathMarkCount(inline)).toBe(0);
  });

  it('passes inert on to the marks', () => {
    const el = document.createElement('div');
    const [, block] = drawn(el);
    paintSectionMath(el, section, [over(LINE)], fakeRender, { inert: true });
    expect(innerMarks(block)[0].ref).toBeNull();
  });

  it('marks a formula with the part of a highlight that runs past it', () => {
    const el = document.createElement('div');
    const [inline, block] = drawn(el);
    const all = over(source.slice(0, source.indexOf(LINE) + 1), 'snippet-1', 0);
    paintSectionMath(el, section, [all], fakeRender);
    expect(wholeMark(inline)).toBe('snippet-1');
    // The script's base alone, as the highlight ends after it
    expect(innerMarks(block).map((m) => m.text)).toEqual(['a']);
  });

  it('marks the part of a formula in a callout, its quote markers left out', () => {
    const quoted = `> [!note]\n> $$\n> ${LINE}\n> b = c\n> $$`;
    const el = document.createElement('div');
    const block = makeBlock(`\n${LINE}\nb = c\n`, el);
    paintSectionMath(
      el,
      { source: quoted, bodyOffset: 0 },
      [
        makeHighlight({
          start_offset: quoted.indexOf(LINE),
          end_offset: quoted.indexOf('b = c') + 1,
        }),
      ],
      fakeRender
    );
    expect(innerMarks(block).map((m) => m.text)).toEqual(['a^2+b^2=c^2b']);
  });

  it('leaves out math in an embed of another note', () => {
    const el = document.createElement('div');
    const [, block] = drawn(el);
    const embed = document.createElement('div');
    embed.className = 'internal-embed';
    makeBlock('z', embed);
    el.prepend(embed);
    paintSectionMath(el, section, [over(LINE)], fakeRender);
    expect(innerMarks(block)).toHaveLength(1);
  });

  it('marks none when formulas and $$ pairs do not match, taking old marks off', () => {
    const el = document.createElement('div');
    const [, block] = drawn(el);
    paintSectionMath(el, section, [over(LINE)], fakeRender);
    makeBlock('extra', el);
    paintSectionMath(el, section, [over(LINE)], fakeRender);
    expect(mathMarkCount(el)).toBe(0);
    expect(containerOf(block).outerHTML).toBe(fakeRender(BLOCK).outerHTML);
  });
});
