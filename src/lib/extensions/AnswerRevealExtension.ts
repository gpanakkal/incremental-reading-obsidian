import { CLOZE_DELIMITERS, CLOZE_GROUPS_PATTERN } from '#/lib/constants';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { type Extension, StateEffect, StateField } from '@codemirror/state';
import {
  type DecorationSet,
  type ViewUpdate,
  Decoration,
  EditorView,
  ViewPlugin,
} from '@codemirror/view';
import { setShowAnswerEffect } from './ActionBarExtension';

/**
 * How long the revealed answer stays highlighted, in milliseconds. Must match
 * the duration of the `ir-answer-reveal-fade` animation in styles.css: the CSS
 * plays the fade, this only decides when the by-then invisible decoration is
 * dropped.
 */
export const ANSWER_REVEAL_FADE_MS = 1000;

/**
 * Grace period added to the fade before the decoration goes away. The timer
 * starts when the reveal transaction is dispatched but the animation only
 * starts on the following paint, so clearing at exactly the fade duration would
 * cut the last frames off and end the highlight on a visible step.
 */
export const ANSWER_REVEAL_CLEAR_MS = ANSWER_REVEAL_FADE_MS + 250;

/** Drops the reveal highlight once its fade has played out. */
export const clearAnswerRevealEffect = StateEffect.define<null>();

const answerRevealMark = Decoration.mark({ class: 'ir-revealed-answer' });

/**
 * Where a card's cloze answer sits in the note, as absolute document offsets.
 *
 * The blanked card is built by `CardManager.hideAnswer`, which matches
 * `CLOZE_GROUPS_PATTERN` against the note body; matching the same pattern
 * against the same text puts the highlight on exactly the span the `______`
 * placeholder stood in for, whatever its length. Frontmatter is skipped rather
 * than searched: a card note records its own `delimiters` as a property, and
 * searching there could highlight a YAML value.
 *
 * The delimiters and the spaces `CardManager.delimitText` pads the answer with
 * are left out, so the highlight covers the answer text and nothing else.
 *
 * @returns null when the note holds no cloze, or when the cloze is empty or
 * all whitespace — neither has answer text to highlight.
 */
export function findRevealedAnswerRange(
  docText: string
): { from: number; to: number } | null {
  const bodyStart = Obsidian.getBodyStartOffset(docText);
  const match = docText.slice(bodyStart).match(CLOZE_GROUPS_PATTERN);
  if (!match) return null;

  const [, pre, answer] = match;
  const trimmed = answer.trim();
  if (trimmed.length === 0) return null;

  const leadingSpace = answer.length - answer.trimStart().length;
  const from =
    bodyStart + pre.length + CLOZE_DELIMITERS[0].length + leadingSpace;
  return { from, to: from + trimmed.length };
}

/**
 * The highlight on a card's answer, present only for the moment following a
 * reveal.
 *
 * Held in a state field rather than rebuilt per view update so that it is tied
 * to the reveal itself: nothing else in a card's lifetime adds it, and a
 * document edit during the fade maps it along with the text it marks.
 */
export const answerRevealField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(highlight, tr) {
    for (const effect of tr.effects) {
      if (effect.is(clearAnswerRevealEffect)) return Decoration.none;
      if (!effect.is(setShowAnswerEffect)) continue;
      if (!effect.value) return Decoration.none;

      // `tr.newDoc`, not `tr.state.doc`: reading `tr.state` from inside a state
      // field's own update is what computes that state, so it would recurse.
      const range = findRevealedAnswerRange(tr.newDoc.toString());
      if (!range) return Decoration.none;
      return Decoration.set([answerRevealMark.range(range.from, range.to)]);
    }
    return highlight.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Removes the reveal highlight once its fade has finished.
 *
 * The decoration cannot just be left sitting at `transparent`: CodeMirror
 * rebuilds the DOM of lines that scroll out of the viewport and back, and a
 * rebuilt element restarts the CSS animation — the answer would flash yellow
 * again every time the user scrolled past it.
 */
export const answerRevealTimer = ViewPlugin.fromClass(
  class AnswerRevealTimer {
    private view: EditorView;
    private win: Window;
    private timeout: number | null = null;

    constructor(view: EditorView) {
      this.view = view;
      // Resolved from the view's own document so a popped-out review window
      // clears the handle on the window that issued it.
      this.win = view.dom.ownerDocument.defaultView ?? window;
    }

    update(update: ViewUpdate) {
      const revealed = update.transactions.some((tr) =>
        tr.effects.some(
          (effect) => effect.is(setShowAnswerEffect) && effect.value
        )
      );
      if (!revealed) return;

      this.cancel();
      this.timeout = this.win.setTimeout(() => {
        this.timeout = null;
        this.view.dispatch({ effects: clearAnswerRevealEffect.of(null) });
      }, ANSWER_REVEAL_CLEAR_MS);
    }

    destroy() {
      this.cancel();
    }

    private cancel() {
      if (this.timeout === null) return;
      this.win.clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
);

/**
 * Highlights a card's answer at the moment it is revealed, then fades the
 * highlight out.
 *
 * Reviewing a card blanks the answer behind a highlighted `______`; revealing it
 * replaces the whole rendered card with an editor, so that highlight — and the
 * cue telling the eye where to look — disappears with it. This re-applies the
 * cue to the answer text itself and lets it decay.
 */
export const answerRevealExtension: Extension = [
  answerRevealField,
  answerRevealTimer,
];
