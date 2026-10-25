// @vitest-environment jsdom
import { ReviewContextProvider } from '#/components/ReviewContext';
import { NOTE_TYPES, type NoteType } from '#/lib/types';
import fc from 'fast-check';
import { Scope } from 'obsidian';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewTypeFilter } from './ReviewTypeFilter';

// #region HELPERS

let mounted: HTMLElement | null = null;

function unmount() {
  const root = mounted;
  mounted = null;
  if (root) void act(() => render(null, root));
  document.body.innerHTML = '';
}

/**
 * Put `types` on in the store, mount the filter and open its menu. Returns the
 * toggle action, which is all the filter reaches out of itself for.
 *
 * Mocks are made here rather than shared: the properties below run this many
 * times per `it`, and a spy counted across cases would read as a click the
 * filter never made.
 */
function mountOpenFilter(types: readonly NoteType[]) {
  unmount();
  reduxState.typesToReview = Object.fromEntries(
    types.map((type) => [type, true])
  );
  const toggleReviewType = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  mounted = container;
  void act(() => {
    render(
      <ReviewContextProvider
        plugin={
          {
            actions: { toggleReviewType },
            app: {
              scope: new Scope(),
              keymap: { pushScope: vi.fn(), popScope: vi.fn() },
            },
          } as never
        }
        reviewView={{} as never}
        reviewManager={{} as never}
      >
        <ReviewTypeFilter />
      </ReviewContextProvider>,
      container
    );
  });
  void act(() => {
    container
      .querySelector('.ir-type-filter-button')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
  return { toggleReviewType };
}

function row(type: NoteType): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `.ir-type-filter-row[data-type="${type}"]`
  );
  if (!found) throw new Error(`no row for ${type}`);
  return found;
}

const typesArb = fc.subarray([...NOTE_TYPES]);

// #endregion

// lucide-react resolves `useContext` against its own preact copy, which is not
// the instance rendering here (see the react→preact aliasing TODO in
// vitest.config.ts). The glyphs are not this component's behavior.
vi.mock('lucide-react', () => ({
  Check: () => null,
  FileText: () => null,
  Funnel: () => null,
  Scissors: () => null,
}));

// react-redux is mocked rather than spied on because its exports are
// non-configurable: `vi.spyOn(ReactRedux, 'useSelector')` throws "Cannot
// redefine property". This is the documented cannot-be-spied case.
const reduxState: { typesToReview: Partial<Record<NoteType, true>> } = {
  typesToReview: {},
};
vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: (selector: (state: unknown) => unknown) => selector(reduxState),
  useStore: () => ({ getState: () => reduxState }),
}));

describe('ReviewTypeFilter', () => {
  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
  });

  it('shows the types review draws from as checked', () => {
    fc.assert(
      fc.property(typesArb, (types) => {
        mountOpenFilter(types);

        for (const type of NOTE_TYPES) {
          expect(row(type).getAttribute('aria-checked')).toBe(
            String(types.includes(type))
          );
        }
      })
    );
  });

  it('asks review to flip the pressed type', () => {
    fc.assert(
      fc.property(
        typesArb,
        fc.constantFrom(...NOTE_TYPES),
        (types, clicked) => {
          const { toggleReviewType } = mountOpenFilter(types);

          void act(() => row(clicked).click());

          expect(toggleReviewType.mock.calls).toEqual([[clicked]]);
        }
      )
    );
  });

  it('gives the icon a tooltip of its own', () => {
    mountOpenFilter(NOTE_TYPES);

    expect(
      document
        .querySelector('.ir-type-filter-button')
        ?.getAttribute('aria-label')
    ).toMatch(/\S/);
  });
});
