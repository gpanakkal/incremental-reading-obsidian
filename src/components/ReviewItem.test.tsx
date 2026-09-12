// @vitest-environment jsdom
import * as ReactQuery from '#/hooks/useReactQuery';
import type { NoteType, ReviewItem as TReviewItem } from '#/lib/types';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { type ComponentChild, render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as CardViewerModule from './CardViewer';
import * as IREditorModule from './IREditor';
import ReviewItem from './ReviewItem';

// #region HELPERS

/**
 * What the redux store hands `useAppSelector`. The mock below only reads it at
 * render time, so the hoisted factory cannot trip over the declaration.
 */
let reduxState: { showAnswer: boolean } = { showAnswer: false };

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

function makeItem({
  type,
  id = 'i1',
  path = 'sources/a.md',
}: {
  type: NoteType;
  id?: string;
  path?: string;
}): TReviewItem {
  return { data: { type, id }, file: { path } as TFile } as TReviewItem;
}

/**
 * Stub the one hook the component reads its item from, plus the two viewers it
 * can delegate to. The viewers are replaced rather than rendered because each
 * mounts a whole editor — CodeMirror, or Obsidian's markdown renderer — and
 * what this component decides is only which one gets the text, never what
 * either then does with it.
 */
function wireItem({
  item,
  text,
  isLoading,
  showAnswer,
}: {
  item: TReviewItem | null;
  text: string | undefined;
  isLoading: boolean;
  showAnswer: boolean;
}) {
  // Each property case is an independent render, and `vi.spyOn` on an
  // already-spied export hands back the existing spy, so without this the call
  // counts below would be cumulative totals for the whole run rather than
  // facts about one case. The DOM is cleared for the same reason.
  vi.restoreAllMocks();
  document.body.innerHTML = '';

  reduxState = { showAnswer };
  vi.spyOn(ReactQuery, 'useCurrentItemFileText').mockReturnValue({
    item,
    text,
    isLoading,
  });
  // An empty fragment rather than null: both viewers are declared as returning
  // an element, and rendering nothing is all the stubs need to do.
  const cardViewer = vi
    .spyOn(CardViewerModule, 'CardViewer')
    .mockReturnValue(<></>);
  const editor = vi.spyOn(IREditorModule, 'IREditor').mockReturnValue(<></>);
  return { cardViewer, editor };
}

function spinner(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.ir-loading');
}

function placeholder(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.ir-review-placeholder');
}

/** Every item shape the component can be handed, plus the absence of one. */
const itemArb = fc.option(
  fc.record({
    type: fc.constantFrom<NoteType>('article', 'snippet', 'card'),
    id: fc.string(),
    path: fc.string(),
  }),
  { nil: null }
);

/** Text the vault read produced. Empty is excluded — see the debrief. */
const loadedTextArb = fc.string({ minLength: 1 });

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

describe('ReviewItem', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows the loading indicator while the item or its text is still being fetched', () => {
    // The regression this screen exists for. The item and the text settle as
    // two separate queries, so while either is in flight the component holds
    // an arbitrary mix of the two — including no item at all, which is also
    // what an empty queue looks like. Loading has to win over every one of
    // those combinations, or the tab claims nothing is due while it is reading.
    fc.assert(
      fc.property(
        itemArb,
        fc.option(loadedTextArb, { nil: undefined }),
        fc.boolean(),
        (itemSpec, text, showAnswer) => {
          const { cardViewer, editor } = wireItem({
            item: itemSpec && makeItem(itemSpec),
            text,
            isLoading: true,
            showAnswer,
          });

          const container = mount(<ReviewItem />);

          expect(spinner(container)).not.toBeNull();
          expect(placeholder(container)).toBeNull();
          expect(cardViewer).not.toHaveBeenCalled();
          expect(editor).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('names what is loading, so the status is announced and not only seen', () => {
    wireItem({
      item: null,
      text: undefined,
      isLoading: true,
      showAnswer: false,
    });

    const container = mount(<ReviewItem />);

    expect(spinner(container)?.getAttribute('aria-label')).toBe(
      'Loading review item'
    );
  });

  it('says nothing is due once the queries settle with no item to show', () => {
    // The honest empty state: not loading, and nothing came back. Only
    // reachable after both queries have finished, which is what makes the
    // claim true rather than premature.
    fc.assert(
      fc.property(
        itemArb,
        fc.option(loadedTextArb, { nil: undefined }),
        fc.boolean(),
        (itemSpec, text, showAnswer) => {
          // Narrow to the settled-and-empty cases; the loaded ones are the
          // subject of the two tests below.
          fc.pre(itemSpec === null || text === undefined);
          const { cardViewer, editor } = wireItem({
            item: itemSpec && makeItem(itemSpec),
            text,
            isLoading: false,
            showAnswer,
          });

          const container = mount(<ReviewItem />);

          expect(placeholder(container)?.textContent).toBe(
            'Nothing due for review.'
          );
          expect(spinner(container)).toBeNull();
          expect(cardViewer).not.toHaveBeenCalled();
          expect(editor).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('hands a card awaiting its answer to the read-only viewer', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), loadedTextArb, (id, path, text) => {
        const { cardViewer, editor } = wireItem({
          item: makeItem({ type: 'card', id, path }),
          text,
          isLoading: false,
          showAnswer: false,
        });

        mount(<ReviewItem />);

        expect(editor).not.toHaveBeenCalled();
        expect(cardViewer).toHaveBeenCalledTimes(1);
        // Text and path must come from the same item: the viewer renders one
        // and resolves the note's links against the other.
        expect(cardViewer.mock.calls[0][0]).toMatchObject({
          cardText: text,
          cardFilePath: path,
        });
      })
    );
  });

  it('hands every other item, a revealed card included, to the editor', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<NoteType>('article', 'snippet', 'card'),
        fc.boolean(),
        fc.string(),
        fc.string(),
        loadedTextArb,
        (type, showAnswer, id, path, text) => {
          // The read-only viewer owns exactly one case: a card with its answer
          // still hidden. Everything else is edited in place.
          fc.pre(type !== 'card' || showAnswer);
          const item = makeItem({ type, id, path });
          const { cardViewer, editor } = wireItem({
            item,
            text,
            isLoading: false,
            showAnswer,
          });

          mount(<ReviewItem />);

          expect(cardViewer).not.toHaveBeenCalled();
          expect(editor).toHaveBeenCalledTimes(1);
          expect(editor.mock.calls[0][0]).toMatchObject({
            value: text,
            className: 'ir-editor',
            item,
          });
        }
      )
    );
  });
});
