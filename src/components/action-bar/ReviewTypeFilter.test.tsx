// @vitest-environment jsdom
import { ReviewContextProvider } from '#/components/ReviewContext';
import { NOTE_TYPES, type NoteType } from '#/lib/types';
import fc from 'fast-check';
import { type ComponentChild, render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewTypeFilter, typeToggleId } from './ReviewTypeFilter';

// #region HELPERS

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

/**
 * Put `types` on in the store and mount the filter. Returns the container and
 * the toggle action, which is all the filter reaches out of itself for.
 *
 * Mocks are cleared here rather than in `afterEach`: the properties below run
 * this many times per `it`, and a spy counted across cases would read as a
 * click the filter never made.
 */
function mountFilter(types: readonly NoteType[]) {
  document.body.innerHTML = '';
  reduxState.typesToReview = types.reduce(
    (acc, type) => Object.assign(acc, { [type]: true }),
    {} as Partial<Record<NoteType, true>>
  );
  const toggleReviewType = vi.fn();
  const container = mount(
    <ReviewContextProvider
      plugin={{ actions: { toggleReviewType } } as never}
      reviewView={{} as never}
      reviewManager={{} as never}
    >
      <ReviewTypeFilter />
    </ReviewContextProvider>
  );
  return { container, toggleReviewType };
}

function toggle(container: HTMLElement, type: NoteType): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `#${typeToggleId(type)}`
  );
  if (!button) throw new Error(`no toggle rendered for ${type}`);
  return button;
}

/** Every set of types review can be left filtered to, the empty one included. */
const typesArb = fc.subarray([...NOTE_TYPES]);

// #endregion

// lucide-react resolves `useContext` against its own preact copy, which is not
// the instance rendering here (see the react→preact aliasing TODO in
// vitest.config.ts). Which glyph each type draws is not this component's
// behavior — `typeIcons.ts` decides that.
vi.mock('lucide-react', () => ({
  FileText: () => null,
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
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders one toggle per item type, in reading order', () => {
    // An article yields snippets and a snippet yields cards, so the row reads
    // left to right the way a session runs.
    const { container } = mountFilter(NOTE_TYPES);

    const ids = Array.from(
      container.querySelectorAll('.ir-type-filter-toggle')
    ).map((el) => el.id);

    expect(ids).toEqual(NOTE_TYPES.map(typeToggleId));
  });

  it('holds the toggles in a single box rather than loose in the bar', () => {
    // The group is one field, like the priority input beside it: styles.css
    // hangs the box, the icon size and the enabled colours off this class.
    const { container } = mountFilter(NOTE_TYPES);

    const group = container.querySelector('.ir-type-filter');

    expect(group).not.toBeNull();
    expect(group?.querySelectorAll('.ir-type-filter-toggle')).toHaveLength(
      NOTE_TYPES.length
    );
  });

  it('tags each toggle with its type, which the tints hang off', () => {
    // styles.css gives an enabled toggle the same wash the queue table gives
    // that type's rows, and reaches both through `data-type`.
    const { container } = mountFilter(NOTE_TYPES);

    for (const type of NOTE_TYPES) {
      expect(toggle(container, type).dataset.type).toBe(type);
    }
  });

  it('marks a toggle enabled exactly when its type is being reviewed', () => {
    fc.assert(
      fc.property(typesArb, (types) => {
        const { container } = mountFilter(types);

        for (const type of NOTE_TYPES) {
          const enabled = types.includes(type);
          // The whole class list, not just `is-enabled`: styles.css reaches
          // the toggle through `ir-type-filter-toggle`, and a disabled one
          // must carry that and nothing else.
          expect(Array.from(toggle(container, type).classList)).toEqual(
            enabled
              ? ['ir-type-filter-toggle', 'is-enabled']
              : ['ir-type-filter-toggle']
          );
          expect(toggle(container, type).getAttribute('aria-pressed')).toBe(
            String(enabled)
          );
        }
      })
    );
  });

  it('says in its tooltip whether each type is being reviewed', () => {
    // `aria-label` is both the accessible name and what Obsidian renders its
    // themed tooltip from, so the two cannot disagree.
    fc.assert(
      fc.property(typesArb, (types) => {
        const { container } = mountFilter(types);

        expect(toggle(container, 'article').getAttribute('aria-label')).toBe(
          types.includes('article')
            ? 'Reviewing articles'
            : 'Not reviewing articles'
        );
        expect(toggle(container, 'snippet').getAttribute('aria-label')).toBe(
          types.includes('snippet')
            ? 'Reviewing snippets'
            : 'Not reviewing snippets'
        );
        expect(toggle(container, 'card').getAttribute('aria-label')).toBe(
          types.includes('card') ? 'Reviewing cards' : 'Not reviewing cards'
        );
      })
    );
  });

  it('leaves the icons unlabelled so only the toggle draws a tooltip', () => {
    // A label on the SVG renders a second tooltip inside the button's own —
    // and crashes Obsidian's tooltip handler, which is HTMLElement-only.
    const { container } = mountFilter(NOTE_TYPES);

    for (const svg of container.querySelectorAll('svg')) {
      expect(svg.hasAttribute('aria-label')).toBe(false);
    }
  });

  it('hands the clicked type to the filter, whatever it was set to', () => {
    fc.assert(
      fc.property(
        typesArb,
        fc.constantFrom(...NOTE_TYPES),
        (types, clicked) => {
          const { container, toggleReviewType } = mountFilter(types);

          toggle(container, clicked).click();

          expect(toggleReviewType.mock.calls).toEqual([[clicked]]);
        }
      )
    );
  });

  it('changes nothing on its own — the click only asks', () => {
    // The rendered state comes from the store, so a toggle that painted itself
    // would disagree with review the moment the change was rejected or racing.
    fc.assert(
      fc.property(
        typesArb,
        fc.constantFrom(...NOTE_TYPES),
        (types, clicked) => {
          const { container } = mountFilter(types);

          toggle(container, clicked).click();

          expect(
            toggle(container, clicked).classList.contains('is-enabled')
          ).toBe(types.includes(clicked));
          expect(toggle(container, clicked).getAttribute('aria-pressed')).toBe(
            String(types.includes(clicked))
          );
        }
      )
    );
  });
});
