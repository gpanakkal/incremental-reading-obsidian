// @vitest-environment jsdom

import { CLOZE_DELIMITERS, CLOZE_GROUPS_PATTERN } from '#/lib/constants';
import { CardManager } from '#/lib/items/CardManager';
import { EditorState } from '@codemirror/state';
import { EditorView, type Decoration } from '@codemirror/view';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setReviewCallbacks,
  setReviewModeEffect,
  setShowAnswerEffect,
} from './ActionBarExtension';
import {
  ANSWER_REVEAL_CLEAR_MS,
  ANSWER_REVEAL_FADE_MS,
  answerRevealExtension,
  answerRevealField,
  clearAnswerRevealEffect,
  findRevealedAnswerRange,
} from './AnswerRevealExtension';

// #region HELPERS

const [LEFT, RIGHT] = CLOZE_DELIMITERS;

/**
 * A card note's frontmatter. `CardManager.createFileAndEntry` writes the
 * delimiters into a property, so a real card carries the delimiter strings
 * outside the cloze — the reason the frontmatter has to be skipped rather than
 * searched.
 */
const CARD_FRONTMATTER =
  '---\n' +
  'ir-id: 01234567-89ab-cdef-0123-456789abcdef\n' +
  'tags: ir-card\n' +
  'delimiters:\n' +
  `  - "${LEFT}"\n` +
  `  - "${RIGHT}"\n` +
  '---\n';

function makeCard(body: string, frontMatter: string = CARD_FRONTMATTER) {
  return frontMatter + body;
}

/**
 * Text that cannot form a cloze of its own, for the parts of a document
 * surrounding the one under test.
 */
function plainTextArb(maxLength = 30) {
  return fc
    .string({ maxLength })
    .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT));
}

/**
 * Bodies assembled from fragments that may themselves be delimiters, so that
 * unbalanced, nested and repeated clozes all occur. Filtered down to those that
 * actually contain a cloze.
 */
function clozeBodyArb() {
  return fc
    .array(
      fc.oneof(
        fc.string({ maxLength: 12 }),
        fc.constant(LEFT),
        fc.constant(RIGHT)
      ),
      { maxLength: 8 }
    )
    .map((parts) => parts.join(''))
    .filter((body) => CLOZE_GROUPS_PATTERN.test(body));
}

function commonPrefixLength(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string) {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) {
    i++;
  }
  return i;
}

/**
 * The cloze `CardManager.hideAnswer` blanks, recovered without reusing the
 * range-finding code: `hideAnswer` returns `pre + placeholder + post`, and the
 * placeholder shares no leading character with `LEFT` nor trailing character
 * with `RIGHT`, so the parts common to the two strings are exactly `pre` and
 * `post`.
 */
function blankedCloze(body: string): string {
  const hidden = CardManager.hideAnswer(body);
  const preLength = commonPrefixLength(body, hidden);
  const postLength = commonSuffixLength(body, hidden);
  return body.slice(
    preLength + LEFT.length,
    body.length - postLength - RIGHT.length
  );
}

function makeView(doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [answerRevealExtension],
  });
  return new EditorView({ state, parent: document.body });
}

/** Every highlight currently on the document, in order. */
function highlights(view: EditorView) {
  const found: { from: number; to: number; value: Decoration }[] = [];
  view.state
    .field(answerRevealField)
    .between(0, view.state.doc.length, (from, to, value) => {
      found.push({ from, to, value });
    });
  return found;
}

/** The text each highlight covers. */
function highlightedText(view: EditorView) {
  return highlights(view).map(({ from, to }) =>
    view.state.doc.sliceString(from, to)
  );
}

function reveal(view: EditorView) {
  view.dispatch({ effects: setShowAnswerEffect.of(true) });
}

/**
 * The plugin's stylesheet, read from the working directory rather than through
 * `import.meta.url`: Vitest rewrites module URLs under jsdom, leaving them on a
 * scheme `readFileSync` rejects.
 */
function readStylesheet() {
  return readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8');
}

/** The colour `ir-answer-reveal-fade` starts from, exactly as declared. */
function fadeStartColor(css: string) {
  const from = css.match(
    /@keyframes\s+ir-answer-reveal-fade\s*\{\s*from\s*\{\s*background-color:\s*([^;]+);/
  );
  expect(from).not.toBeNull();
  return from![1].trim();
}

// #endregion

// ---------------------------------------------------------------------------
// findRevealedAnswerRange
// ---------------------------------------------------------------------------
describe('findRevealedAnswerRange', () => {
  it('splits the note into the text before the answer, the answer, and the text after', () => {
    fc.assert(
      fc.property(
        plainTextArb(),
        plainTextArb(),
        plainTextArb(),
        (pre, answer, post) => {
          fc.pre(answer.trim().length > 0);
          const leading = answer.slice(
            0,
            answer.length - answer.trimStart().length
          );
          const trailing = answer.slice(answer.trimEnd().length);
          const doc = makeCard(`${pre}${LEFT}${answer}${RIGHT}${post}`);

          const range = findRevealedAnswerRange(doc);

          expect(range).not.toBeNull();
          expect(doc.slice(0, range!.from)).toBe(
            `${CARD_FRONTMATTER}${pre}${LEFT}${leading}`
          );
          expect(doc.slice(range!.from, range!.to)).toBe(answer.trim());
          expect(doc.slice(range!.to)).toBe(`${trailing}${RIGHT}${post}`);
        }
      )
    );
  });

  it('covers the same cloze the blanked card replaces with the placeholder', () => {
    fc.assert(
      fc.property(clozeBodyArb(), (body) => {
        const inner = blankedCloze(body);
        const doc = makeCard(body);

        const range = findRevealedAnswerRange(doc);

        if (inner.trim().length === 0) {
          expect(range).toBeNull();
          return;
        }
        expect(range).not.toBeNull();
        expect(doc.slice(range!.from, range!.to)).toBe(inner.trim());
      })
    );
  });

  it('never reaches into the frontmatter, which holds the delimiters itself', () => {
    fc.assert(
      fc.property(plainTextArb(), (body) => {
        expect(findRevealedAnswerRange(makeCard(body))).toBeNull();
      })
    );
  });

  it('finds the answer in a note that has no frontmatter', () => {
    const range = findRevealedAnswerRange(`Q: ${LEFT}Paris${RIGHT}`);

    expect(range).not.toBeNull();
    expect(`Q: ${LEFT}Paris${RIGHT}`.slice(range!.from, range!.to)).toBe(
      'Paris'
    );
  });

  it('leaves out the spaces the cloze is padded with when it is created', () => {
    // The shape CardManager.delimitText writes: `(} answer {)`.
    const doc = makeCard(`The capital is ${LEFT} Paris ${RIGHT}.`);

    const range = findRevealedAnswerRange(doc);

    expect(doc.slice(range!.from, range!.to)).toBe('Paris');
  });

  it('covers an answer that spans several lines', () => {
    const answer = 'first line\nsecond line';
    const doc = makeCard(`Recite:\n${LEFT}${answer}${RIGHT}\n`);

    const range = findRevealedAnswerRange(doc);

    expect(doc.slice(range!.from, range!.to)).toBe(answer);
  });

  it('returns nothing for a note with no cloze at all', () => {
    fc.assert(
      fc.property(plainTextArb(200), (text) => {
        fc.pre(!text.startsWith('---\n'));
        expect(findRevealedAnswerRange(text)).toBeNull();
      })
    );
  });

  it('returns nothing when the cloze is empty', () => {
    expect(findRevealedAnswerRange(makeCard(`Q: ${LEFT}${RIGHT}`))).toBeNull();
  });

  it('returns nothing when the cloze holds only whitespace', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[ \t\n]+$/).filter((s) => s.length > 0),
        (blank) => {
          expect(
            findRevealedAnswerRange(makeCard(`Q: ${LEFT}${blank}${RIGHT}`))
          ).toBeNull();
        }
      )
    );
  });

  it('returns nothing when the closing delimiter comes before the opening one', () => {
    expect(findRevealedAnswerRange(makeCard(`a${RIGHT}b${LEFT}c`))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// answerRevealExtension: the highlight itself
// ---------------------------------------------------------------------------
describe('answerRevealExtension', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('leaves the card unmarked until the answer is revealed', () => {
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));

    expect(highlights(view)).toHaveLength(0);

    view.destroy();
  });

  it('highlights the answer when the answer is revealed', () => {
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));

    reveal(view);

    expect(highlightedText(view)).toEqual(['Paris']);

    view.destroy();
  });

  it('marks the answer with the class the fade is styled on', () => {
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));

    reveal(view);

    const spec = highlights(view)[0].value.spec as { class?: string };
    expect(spec.class).toBe('ir-revealed-answer');

    view.destroy();
  });

  it('highlights nothing in a note that has no answer to reveal', () => {
    const view = makeView(makeCard('An article about Paris.'));

    reveal(view);

    expect(highlights(view)).toHaveLength(0);

    view.destroy();
  });

  it('takes the highlight back off when the answer is hidden again', () => {
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));
    reveal(view);

    view.dispatch({ effects: setShowAnswerEffect.of(false) });

    expect(highlights(view)).toHaveLength(0);

    view.destroy();
  });

  it('keeps the highlight on the answer when the note is edited mid-fade', () => {
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));
    reveal(view);
    const before = highlights(view)[0];

    view.dispatch({ changes: { from: 0, insert: 'inserted ahead\n' } });

    expect(highlightedText(view)).toEqual(['Paris']);
    expect(highlights(view)[0].from).toBe(
      before.from + 'inserted ahead\n'.length
    );

    view.destroy();
  });

  it('survives the other effects the review interface dispatches', () => {
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));
    reveal(view);

    // The action bar re-publishes its callbacks on every item and toggles
    // review mode; neither is a reveal, and neither may disturb one in
    // progress.
    view.dispatch({ effects: setReviewCallbacks.of({}) });
    view.dispatch({ effects: setReviewModeEffect.of(false) });

    expect(highlightedText(view)).toEqual(['Paris']);

    view.destroy();
  });

  it('is not put up by an effect that is not a reveal', () => {
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));

    view.dispatch({ effects: setReviewCallbacks.of({}) });
    view.dispatch({ effects: setReviewModeEffect.of(true) });

    expect(highlights(view)).toHaveLength(0);

    view.destroy();
  });

  it('drops the highlight the moment the effect says to', () => {
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));
    reveal(view);

    view.dispatch({ effects: clearAnswerRevealEffect.of(null) });

    expect(highlights(view)).toHaveLength(0);

    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// answerRevealExtension: the fade's lifetime
// ---------------------------------------------------------------------------
describe('answerRevealExtension fade lifetime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('holds the highlight for the whole fade', () => {
    vi.useFakeTimers();
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));
    reveal(view);

    vi.advanceTimersByTime(ANSWER_REVEAL_CLEAR_MS - 1);

    expect(highlightedText(view)).toEqual(['Paris']);

    view.destroy();
  });

  it('removes the highlight once the fade has finished', () => {
    vi.useFakeTimers();
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));
    reveal(view);

    vi.advanceTimersByTime(ANSWER_REVEAL_CLEAR_MS);

    expect(highlights(view)).toHaveLength(0);

    view.destroy();
  });

  it('outlasts the fade it is waiting on, so the highlight never cuts out mid-animation', () => {
    expect(ANSWER_REVEAL_CLEAR_MS).toBeGreaterThan(ANSWER_REVEAL_FADE_MS);
  });

  it('fades for as long as the stylesheet animates', () => {
    const css = readStylesheet();

    const duration = css.match(
      /animation:\s*ir-answer-reveal-fade\s+([\d.]+)(m?s)/
    );

    expect(duration).not.toBeNull();
    const [, value, unit] = duration!;
    const ms = unit === 's' ? Number(value) * 1000 : Number(value);
    expect(ms).toBe(ANSWER_REVEAL_FADE_MS);
  });

  it('fades from the highlight the blanked answer is already wearing', () => {
    const css = readStylesheet();

    // `.ir-hidden-answer` cannot declare that highlight: Obsidian's
    // `.markdown-rendered mark` sets `background-color: var(--text-highlight-bg)`
    // and outranks a lone class, so a background declared there is dead and
    // matching it would mean matching a colour nobody sees.
    const blankedRule = css.match(/\.ir-hidden-answer\s*\{([^}]*)\}/);
    expect(blankedRule).not.toBeNull();
    expect(blankedRule![1]).not.toMatch(/background-color/);

    // Which leaves one way for the two to agree: read the same theme token.
    //
    // Read at the point of use, not aliased to a plugin variable first. Obsidian
    // declares `--text-highlight-bg` on `body`, and a `var()` nested inside a
    // custom property is substituted against the element that property is
    // declared on — so an alias in `:root` looks the token up on `<html>`, finds
    // nothing, and the animation renders with no background at all.
    expect(fadeStartColor(css)).toBe('var(--text-highlight-bg)');
  });

  it('restarts the fade when the answer is revealed a second time', () => {
    vi.useFakeTimers();
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));
    reveal(view);

    vi.advanceTimersByTime(ANSWER_REVEAL_CLEAR_MS - 1);
    reveal(view);
    vi.advanceTimersByTime(ANSWER_REVEAL_CLEAR_MS - 1);

    expect(highlightedText(view)).toEqual(['Paris']);

    vi.advanceTimersByTime(1);
    expect(highlights(view)).toHaveLength(0);

    view.destroy();
  });

  it('does not reach a review that has already moved on', () => {
    vi.useFakeTimers();
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));
    reveal(view);

    // Grading a card tears the editor down mid-fade. A removal still pending
    // afterwards would be dispatching into a view the review has left behind.
    view.destroy();
    const dispatch = vi.spyOn(view, 'dispatch');

    expect(() => vi.advanceTimersByTime(ANSWER_REVEAL_CLEAR_MS)).not.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('starts the fade from a reveal that arrives alongside other transactions', () => {
    vi.useFakeTimers();
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));

    // Two transactions in one update, only the second a reveal: the shape
    // CodeMirror produces when a transaction is dispatched while another is
    // already being applied.
    const edit = view.state.update({ changes: { from: 0, insert: 'x' } });
    view.dispatch([
      edit,
      edit.state.update({ effects: setShowAnswerEffect.of(true) }),
    ]);
    expect(highlightedText(view)).toEqual(['Paris']);

    vi.advanceTimersByTime(ANSWER_REVEAL_CLEAR_MS);

    expect(highlights(view)).toHaveLength(0);

    view.destroy();
  });

  it('still clears itself in a document that has no window of its own', () => {
    vi.useFakeTimers();
    // A document built this way has a null `defaultView`, the case the timer's
    // fallback covers.
    const detached = document.implementation.createHTMLDocument();
    const view = new EditorView({
      state: EditorState.create({
        doc: makeCard(`Q: ${LEFT}Paris${RIGHT}`),
        extensions: [answerRevealExtension],
      }),
      parent: detached.body,
    });
    reveal(view);
    expect(highlightedText(view)).toEqual(['Paris']);

    vi.advanceTimersByTime(ANSWER_REVEAL_CLEAR_MS);

    expect(highlights(view)).toHaveLength(0);

    view.destroy();
  });

  it('is not held open by transactions that are not a reveal', () => {
    vi.useFakeTimers();
    const view = makeView(makeCard(`Q: ${LEFT}Paris${RIGHT}`));
    reveal(view);

    // Edits and action bar effects both land during a fade; neither may push
    // the removal further out.
    vi.advanceTimersByTime(ANSWER_REVEAL_CLEAR_MS - 1);
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    view.dispatch({ effects: setReviewCallbacks.of({}) });
    vi.advanceTimersByTime(1);

    expect(highlights(view)).toHaveLength(0);

    view.destroy();
  });
});
