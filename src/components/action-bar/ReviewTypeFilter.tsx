import { TYPE_ICONS } from '#/components/icons/typeIcons';
import { useAppSelector } from '#/hooks/useAppSelector';
import { NOTE_TYPES, type NoteType } from '#/lib/types';
import { useReviewContext } from '../ReviewContext';

/** Plural nouns for the tooltips: "Reviewing articles", "Not reviewing cards". */
const TYPE_LABELS: Record<NoteType, string> = {
  article: 'articles',
  snippet: 'snippets',
  card: 'cards',
};

/** for tests and for anything anchoring to it. */
export function typeToggleId(type: NoteType): string {
  return `ir-type-filter-${type}`;
}

/**
 * One toggle per item type, deciding what review draws from. They sit together
 * in a single field, in {@link NOTE_TYPES} order, and read as a set rather than
 * as three separate bar buttons.
 * Each toggle is a `button` with `aria-pressed` rather than a checkbox: the
 * state is carried by colour on an icon, and a checkbox would drag in
 * Obsidian's own box drawing to hide again. The tooltip is `aria-label` on the
 * button, which is both the accessible name and what Obsidian renders its
 * themed tooltip from; the icon inside stays unlabelled so only one tooltip
 * appears.
 */
export function ReviewTypeFilter() {
  const { actions } = useReviewContext();
  const typesToReview = useAppSelector((state) => state.typesToReview);

  return (
    <div className="ir-type-filter" role="group">
      {NOTE_TYPES.map((type) => {
        const Icon = TYPE_ICONS[type];
        const enabled = Boolean(typesToReview[type]);
        return (
          <button
            key={type}
            id={typeToggleId(type)}
            className={'ir-type-filter-toggle' + (enabled ? ' is-enabled' : '')}
            data-type={type}
            aria-label={`${enabled ? 'Reviewing' : 'Not reviewing'} ${TYPE_LABELS[type]}`}
            aria-pressed={enabled}
            onClick={() => void actions.toggleReviewType(type)}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
