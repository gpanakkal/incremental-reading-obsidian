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

function prevButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelectorAll('button')[0] as HTMLButtonElement;
}

function nextButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelectorAll('button')[1] as HTMLButtonElement;
}

function indicatorText(container: HTMLElement): string | null | undefined {
  return container.querySelector('.ir-queue-pagination-indicator')?.textContent;
}

// #endregion

describe('QueuePagination', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows a 1-based page indicator and correct disabled states for any page', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 50 })
          .chain((pageCount) =>
            fc.tuple(
              fc.constant(pageCount),
              fc.integer({ min: 0, max: pageCount - 1 })
            )
          ),
        ([pageCount, pageNumber]) => {
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
          expect(prevButton(container).disabled).toBe(pageNumber === 0);
          expect(nextButton(container).disabled).toBe(
            pageNumber === pageCount - 1
          );
        }
      )
    );
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

  it('does not request a page past either end (buttons disabled)', () => {
    const onPageChange = vi.fn();
    const container = mount(
      <QueuePagination
        pageNumber={0}
        pageCount={1}
        onPageChange={onPageChange}
      />
    );
    prevButton(container).click();
    nextButton(container).click();
    expect(onPageChange).not.toHaveBeenCalled();
  });
});
