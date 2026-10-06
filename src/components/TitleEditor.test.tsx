// @vitest-environment jsdom
import type { ReviewArticle } from '#/lib/types';
import fc from 'fast-check';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ReviewContext from './ReviewContext';
import { TitleEditor } from './TitleEditor';

// #region HELPERS

/** What the redux store hands `useAppSelector`: never in selection mode here. */
const reduxState = { selectionMode: null };

/**
 * Render the editor for a note named `basename`, with `renameArticle`
 * resolving to `renamed`, and return its title element.
 */
function mountEditor(basename: string, renamed: boolean) {
  const renameArticle = vi.fn().mockResolvedValue(renamed);
  vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
    reviewManager: { renameArticle },
  } as never);
  const item = { file: { basename } } as unknown as ReviewArticle;
  const container = document.createElement('div');
  document.body.appendChild(container);
  void act(() => {
    render(<TitleEditor item={item} />, container);
  });
  const title = container.querySelector<HTMLElement>('.ir-title')!;
  return { title, renameArticle, item };
}

/** Type `text` over the title and leave it, as the user commits an edit. */
async function editTitle(title: HTMLElement, text: string) {
  title.textContent = text;
  await act(async () => {
    // preact/compat listens for `onBlur` as focusout
    title.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await Promise.resolve();
  });
}

// #endregion

// react-redux is mocked rather than spied on because its exports are
// non-configurable: `vi.spyOn(ReactRedux, 'useSelector')` throws "Cannot
// redefine property". This is the documented cannot-be-spied case.
vi.mock('react-redux', () => ({
  useSelector: (select: (state: typeof reduxState) => unknown) =>
    select(reduxState),
  useStore: () => ({ getState: () => reduxState }),
  useDispatch: () => vi.fn(),
}));

describe('TitleEditor', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /** A new name: anything but blank, after trimming, or the old one. */
  const newNameArb = fc
    .string({ minLength: 1 })
    .filter((name) => name.trim() !== '' && name.trim() !== 'Old name');

  it('puts the old name back when the rename is refused or undone', async () => {
    await fc.assert(
      fc.asyncProperty(newNameArb, async (name) => {
        const { title, renameArticle, item } = mountEditor('Old name', false);
        await editTitle(title, name);
        expect(renameArticle).toHaveBeenCalledWith(item, name.trim());
        expect(title.textContent).toBe('Old name');
        document.body.innerHTML = '';
      })
    );
  });

  it('puts the old name back without renaming when the title is left blank or as it was', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom('', ' ', '\t'),
          fc.constantFrom('Old name', ' Old name ')
        ),
        async (name) => {
          const { title, renameArticle } = mountEditor('Old name', true);
          await editTitle(title, name);
          expect(renameArticle).not.toHaveBeenCalled();
          expect(title.textContent).toBe('Old name');
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('puts the old name back when the rename throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { title, renameArticle } = mountEditor('Old name', true);
    renameArticle.mockRejectedValue(new Error('vault error'));
    await editTitle(title, 'New name');
    expect(title.textContent).toBe('Old name');
  });

  it('keeps the new name once the rename goes through', async () => {
    await fc.assert(
      fc.asyncProperty(newNameArb, async (name) => {
        const { title, renameArticle } = mountEditor('Old name', true);
        await editTitle(title, name);
        expect(renameArticle).toHaveBeenCalledTimes(1);
        expect(title.textContent).toBe(name);
        document.body.innerHTML = '';
      })
    );
  });
});

describe('TitleEditor, when review moves on during a rename', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /** A rename that settles only when the test says, refused or thrown. */
  function pendingRename(outcome: 'refused' | 'thrown') {
    let settle = () => {};
    const renameArticle = vi.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          settle = () =>
            outcome === 'refused' ? resolve(false) : reject(new Error('x'));
        })
    );
    vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
      reviewManager: { renameArticle },
    } as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return () => settle();
  }

  const article = (basename: string) =>
    ({ file: { basename } }) as unknown as ReviewArticle;

  it.each(['refused', 'thrown'] as const)(
    'leaves the next item its own name once the old one is %s',
    async (outcome) => {
      const settle = pendingRename(outcome);
      const container = document.createElement('div');
      document.body.appendChild(container);
      void act(() => {
        render(<TitleEditor item={article('First')} />, container);
      });
      const title = container.querySelector<HTMLElement>('.ir-title')!;
      await editTitle(title, 'Renamed');
      void act(() => {
        render(<TitleEditor item={article('Second')} />, container);
      });
      await act(async () => {
        settle();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(title.textContent).toBe('Second');
    }
  );

  it.each(['refused', 'thrown'] as const)(
    'does nothing once the editor is gone and the rename is %s',
    async (outcome) => {
      const settle = pendingRename(outcome);
      const container = document.createElement('div');
      document.body.appendChild(container);
      void act(() => {
        render(<TitleEditor item={article('First')} />, container);
      });
      const title = container.querySelector<HTMLElement>('.ir-title')!;
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      await editTitle(title, 'Renamed');
      void act(() => {
        render(null, container);
      });
      await act(async () => {
        settle();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      process.off('unhandledRejection', onRejection);
      expect(rejections).toEqual([]);
    }
  );
});
