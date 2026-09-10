// @vitest-environment jsdom
import fc from 'fast-check';
import type { ComponentChild } from 'preact';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueuePagination } from './QueuePagination';

// #region HELPERS

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

/**
 * Preact defers state updates to a microtask, so anything typed into the page
 * box reaches the DOM one flush later. No wall-clock timer is involved.
 */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A pager button by its label rather than its position, so a test about what
 * one button does cannot quietly start exercising its neighbour.
 */
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  );
  if (!found) throw new Error(`no "${label}" button rendered`);
  return found;
}

function firstButton(container: HTMLElement) {
  return button(container, 'First page');
}

function prevButton(container: HTMLElement) {
  return button(container, 'Previous page');
}

function nextButton(container: HTMLElement) {
  return button(container, 'Next page');
}

function lastButton(container: HTMLElement) {
  return button(container, 'Last page');
}

function pageInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    '.ir-queue-page-input'
  );
  if (!input) throw new Error('no page input rendered');
  return input;
}

/** The indicator read back as a whole, e.g. `2 of 5`. */
function indicatorText(container: HTMLElement): string {
  const total = container.querySelector('.ir-queue-page-total')?.textContent;
  return `${pageInput(container).value} ${total}`;
}

/** Type into the page box, as a user editing it does. */
async function typePage(container: HTMLElement, value: string) {
  const input = pageInput(container);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

async function pressKey(container: HTMLElement, key: string) {
  pageInput(container).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true })
  );
  await flush();
}

/** A page count, and a page that exists inside it. */
const pageAndCount = fc
  .integer({ min: 1, max: 50 })
  .chain((pageCount) =>
    fc.tuple(fc.constant(pageCount), fc.integer({ min: 0, max: pageCount - 1 }))
  );

// #endregion

describe('QueuePagination', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows a 1-based page indicator and correct disabled states for any page', () => {
    fc.assert(
      fc.property(pageAndCount, ([pageCount, pageNumber]) => {
        document.body.innerHTML = '';
        const container = mount(
          <QueuePagination
            pageNumber={pageNumber}
            pageCount={pageCount}
            onPageChange={() => {}}
          />
        );
        expect(indicatorText(container)).toBe(
          `${pageNumber + 1} of ${pageCount}`
        );
        // Both left-hand arrows have somewhere to go from every page but the
        // first, and both right-hand ones from every page but the last.
        expect(firstButton(container).disabled).toBe(pageNumber === 0);
        expect(prevButton(container).disabled).toBe(pageNumber === 0);
        expect(nextButton(container).disabled).toBe(
          pageNumber === pageCount - 1
        );
        expect(lastButton(container).disabled).toBe(
          pageNumber === pageCount - 1
        );
      })
    );
  });

  it('lays the arrows out as two pairs around the page box', () => {
    const container = mount(
      <QueuePagination pageNumber={2} pageCount={5} onPageChange={() => {}} />
    );

    // The end jumps sit outside the steps they extend, so how far a control
    // moves grows with its distance from the number it is moving.
    const parts = [...container.querySelectorAll('button, input')];
    const labels = parts.map(
      (el) => el.textContent || (el as HTMLInputElement).value
    );
    expect(labels).toEqual(['<<', '<', '3', '>', '>>']);
  });

  it('requests the previous page on prev click', () => {
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={2}
        pageCount={5}
        onPageChange={onPageChange}
      />
    );
    prevButton(container).click();
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('requests the next page on next click', () => {
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={2}
        pageCount={5}
        onPageChange={onPageChange}
      />
    );
    nextButton(container).click();
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('requests the first page from anywhere past it', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 2, max: 50 })
          .chain((pageCount) =>
            fc.tuple(
              fc.constant(pageCount),
              fc.integer({ min: 1, max: pageCount - 1 })
            )
          ),
        ([pageCount, pageNumber]) => {
          document.body.innerHTML = '';
          const onPageChange = vi.fn();
          const container = mount(
            <QueuePagination
              pageNumber={pageNumber}
              pageCount={pageCount}
              onPageChange={onPageChange}
            />
          );
          firstButton(container).click();
          // One hop however far back it is, which is the whole point of it.
          expect(onPageChange).toHaveBeenCalledWith(0);
        }
      )
    );
  });

  it('requests the last page from anywhere before it', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 2, max: 50 })
          .chain((pageCount) =>
            fc.tuple(
              fc.constant(pageCount),
              fc.integer({ min: 0, max: pageCount - 2 })
            )
          ),
        ([pageCount, pageNumber]) => {
          document.body.innerHTML = '';
          const onPageChange = vi.fn();
          const container = mount(
            <QueuePagination
              pageNumber={pageNumber}
              pageCount={pageCount}
              onPageChange={onPageChange}
            />
          );
          lastButton(container).click();
          expect(onPageChange).toHaveBeenCalledWith(pageCount - 1);
        }
      )
    );
  });

  it('does not request a page past either end (buttons disabled)', () => {
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={0}
        pageCount={1}
        onPageChange={onPageChange}
      />
    );
    firstButton(container).click();
    prevButton(container).click();
    nextButton(container).click();
    lastButton(container).click();
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('goes to any page typed into the box on enter', async () => {
    await fc.assert(
      fc.asyncProperty(
        pageAndCount.chain(([pageCount, pageNumber]) =>
          fc.tuple(
            fc.constant(pageCount),
            fc.constant(pageNumber),
            fc.integer({ min: 1, max: pageCount })
          )
        ),
        async ([pageCount, pageNumber, entered]) => {
          document.body.innerHTML = '';
          const onPageChange = vi.fn();
          const container = mount(
            <QueuePagination
              pageNumber={pageNumber}
              pageCount={pageCount}
              onPageChange={onPageChange}
            />
          );

          await typePage(container, String(entered));
          await pressKey(container, 'Enter');

          // The box is 1-based and the prop is 0-based. Re-entering the page
          // already shown asks for nothing: unlike the date field beside it,
          // where one day can span several pages, a page number names exactly
          // the page on screen.
          if (entered - 1 === pageNumber) {
            expect(onPageChange).not.toHaveBeenCalled();
          } else {
            expect(onPageChange).toHaveBeenCalledWith(entered - 1);
          }
        }
      )
    );
  });

  it('waits for the entry to be committed before changing page', async () => {
    // "12" passes through "1" on the way in. Acting on each keystroke would
    // load page 1 first — a wasted query whose rows flash up in place of the
    // ones asked for.
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={0}
        pageCount={20}
        onPageChange={onPageChange}
      />
    );

    await typePage(container, '1');
    await typePage(container, '12');

    expect(onPageChange).not.toHaveBeenCalled();
    expect(pageInput(container).value).toBe('12');

    await pressKey(container, 'Enter');
    expect(onPageChange).toHaveBeenCalledTimes(1);
    expect(onPageChange).toHaveBeenCalledWith(11);
  });

  it('commits the entry when the box loses focus', async () => {
    // Typing a page and then reaching for the arrows or the date field is a
    // commit as much as pressing enter is.
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={0}
        pageCount={5}
        onPageChange={onPageChange}
      />
    );

    pageInput(container).focus();
    await typePage(container, '4');
    pageInput(container).blur();
    await flush();

    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('clamps an entry past the end to the last page', async () => {
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={0}
        pageCount={3}
        onPageChange={onPageChange}
      />
    );

    await typePage(container, '999');
    await pressKey(container, 'Enter');

    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('clamps a zero entry to the first page', async () => {
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={2}
        pageCount={3}
        onPageChange={onPageChange}
      />
    );

    await typePage(container, '0');
    await pressKey(container, 'Enter');

    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it('restores the current page when a clamped entry moves nothing', async () => {
    // The case the box cannot leave to the parent: already on the last page,
    // so the clamp re-renders this component with the props it already had,
    // and the typed number would sit there looking accepted.
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={2}
        pageCount={3}
        onPageChange={onPageChange}
      />
    );

    await typePage(container, '999');
    await pressKey(container, 'Enter');

    expect(onPageChange).not.toHaveBeenCalled();
    expect(pageInput(container).value).toBe('3');
  });

  it('refuses anything that is not a digit', async () => {
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={1}
        pageCount={5}
        onPageChange={onPageChange}
      />
    );

    // What a number input would have taken as the start of a number, and then
    // reported as an empty string.
    await typePage(container, '2e-1.5');

    // Filtered as typed, so what is on screen is what enter will act on.
    expect(pageInput(container).value).toBe('215');
  });

  it('stands pat when the box is emptied', async () => {
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={1}
        pageCount={5}
        onPageChange={onPageChange}
      />
    );

    await typePage(container, '');
    await pressKey(container, 'Enter');

    expect(onPageChange).not.toHaveBeenCalled();
    expect(pageInput(container).value).toBe('2');
  });

  it('abandons the entry on escape', async () => {
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={1}
        pageCount={5}
        onPageChange={onPageChange}
      />
    );

    await typePage(container, '4');
    await pressKey(container, 'Escape');

    expect(onPageChange).not.toHaveBeenCalled();
    expect(pageInput(container).value).toBe('2');
  });

  it('selects the page number when the box is focused', () => {
    // One short value, always: typing over it is the only edit worth making,
    // so it should not have to be cleared first.
    const container = mount(
      <QueuePagination pageNumber={11} pageCount={20} onPageChange={() => {}} />
    );

    const input = pageInput(container);
    input.focus();

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('12'.length);
  });

  it('follows the page when it changes elsewhere', async () => {
    // The arrows and the date field above the table both move the page. The
    // box shows the page rather than holding a value of its own, so it has to
    // follow them.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const rerender = (pageNumber: number) =>
      render(
        (
          <QueuePagination
            pageNumber={pageNumber}
            pageCount={5}
            onPageChange={() => {}}
          />
        ) as never,
        container
      );

    rerender(0);
    expect(pageInput(container).value).toBe('1');

    rerender(3);
    await flush();

    expect(indicatorText(container)).toBe('4 of 5');
  });

  it('sizes the box to the widest page number the queue can reach', () => {
    // Sized in digits so the bar does not budge as the number grows, and so a
    // four-figure queue is not typed into a box built for one page.
    const container = mount(
      <QueuePagination
        pageNumber={0}
        pageCount={1234}
        onPageChange={() => {}}
      />
    );

    expect(pageInput(container).size).toBe(4);
  });
});
