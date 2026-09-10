import { useState } from 'react';

interface QueuePaginationProps {
  /** 0-based index of the displayed page. */
  pageNumber: number;
  pageCount: number;
  onPageChange: (pageNumber: number) => void;
}

/**
 * The queue's page controls: jump to either end, step one page at a time, or
 * type a page number into the indicator.
 *
 * The indicator is a text box rather than a number input. A number input
 * carries its own spinner buttons, which would sit among four arrows that
 * already do that job, and it treats `e`, `+`, `-` and `.` as the start of a
 * number while reporting an empty string for them — so the entry would need
 * validating anyway, with less say over what the box displays meanwhile.
 *
 * A page outside the queue is clamped to the nearest end rather than refused,
 * so "the last page" can be asked for with any number large enough.
 *
 * Tooltips use `aria-label` rather than `title`, since Obsidian renders its
 * own themed tooltip for aria-labelled elements. The arrows need one: `<<`
 * does not say on its own how much further it goes than `<`.
 */
export function QueuePagination({
  pageNumber,
  pageCount,
  onPageChange,
}: QueuePaginationProps) {
  /**
   * What the user has typed, or null when the box is simply showing the page
   * it is on. Held apart from the page itself so an entry is acted on only
   * once it is whole: typing "12" passes through "1", and a box that reported
   * every keystroke would load page 1 on the way to page 12.
   */
  const [draft, setDraft] = useState<string | null>(null);

  const atFirst = pageNumber <= 0;
  const atLast = pageNumber >= pageCount - 1;

  /** Pull a 1-based page number inside the queue's range. */
  function clamp(page: number) {
    return Math.min(Math.max(page, 1), pageCount);
  }

  /**
   * Act on whatever is in the box, then drop the draft so the box goes back to
   * displaying the page. Dropping it is what corrects a rejected entry: the
   * cases where nothing moves — a number past the end, or the page already
   * shown — are exactly the ones where the parent re-renders this component
   * unchanged, and the typed text would otherwise stay on screen.
   */
  function commitDraft() {
    if (draft === null) return;
    const entered = Number.parseInt(draft, 10);
    setDraft(null);
    // Empty, which is what clearing the box or typing only rejected
    // characters leaves. Nothing to go to, so the page stands.
    if (Number.isNaN(entered)) return;
    const target = clamp(entered) - 1;
    if (target !== pageNumber) onPageChange(target);
  }

  function handleInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    // Digits only. Filtering as it is typed keeps the box from ever showing
    // something it will not act on; the cost is that a rejected character puts
    // the caret at the end, which is where it already is when typing normally.
    setDraft(input.value.replace(/\D/g, ''));
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      // Nothing here submits a form, but the queue can sit inside one, and an
      // implicit submit would tear the view down mid-jump.
      event.preventDefault();
      commitDraft();
      return;
    }

    if (event.key === 'Escape') {
      // Abandon the entry: the draft is what the box is showing, so dropping
      // it restores the current page.
      event.preventDefault();
      setDraft(null);
    }
  }

  return (
    <div className="ir-queue-pagination">
      <button
        type="button"
        className="ir-review-button"
        aria-label="First page"
        disabled={atFirst}
        onClick={() => onPageChange(0)}
      >
        {'<<'}
      </button>
      <button
        type="button"
        className="ir-review-button"
        aria-label="Previous page"
        disabled={atFirst}
        onClick={() => onPageChange(pageNumber - 1)}
      >
        {'<'}
      </button>
      <span className="ir-queue-pagination-indicator">
        <input
          type="text"
          className="ir-queue-page-input"
          aria-label="Page number"
          // A numeric keypad on mobile, where the alternative is hunting for
          // digits on a keyboard raised for a box that takes nothing else.
          inputMode="numeric"
          // Sized in characters, so the box fits the queue's largest page
          // number and no more. No maximum length: a number past the end is
          // clamped rather than refused, and cutting the entry short would
          // turn "999" into a jump to page 9.
          size={String(pageCount).length}
          value={draft ?? String(pageNumber + 1)}
          // Selected on focus so the page can be typed straight over, rather
          // than cleared first — the box holds one short value, always.
          onFocus={(event) => event.currentTarget.select()}
          // `onInput` rather than `onChange`: plain Preact treats `onChange` as
          // the DOM `change` event while preact/compat rewrites it to `input`,
          // so its meaning would depend on whether compat is in the module
          // graph. `onInput` is the `input` event in both.
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          // Clicking away is as much a commit as pressing enter, and is what
          // catches an entry the user typed and then went to the arrows or the
          // date field with.
          onBlur={commitDraft}
        />
        <span className="ir-queue-page-total">of {pageCount}</span>
      </span>
      <button
        type="button"
        className="ir-review-button"
        aria-label="Next page"
        disabled={atLast}
        onClick={() => onPageChange(pageNumber + 1)}
      >
        {'>'}
      </button>
      <button
        type="button"
        className="ir-review-button"
        aria-label="Last page"
        disabled={atLast}
        onClick={() => onPageChange(pageCount - 1)}
      >
        {'>>'}
      </button>
    </div>
  );
}
