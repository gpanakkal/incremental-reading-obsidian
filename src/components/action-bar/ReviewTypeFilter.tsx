import { TypeFilterMenu } from '#/components/TypeFilterMenu';
import { useAppSelector } from '#/hooks/useAppSelector';
import { useReviewContext } from '../ReviewContext';

/**
 * The review bar's type filter: the shared {@link TypeFilterMenu} wired to the
 * set of types review draws from. The store is the only source of what is on,
 * so a toggle only asks for the change and the menu repaints from the result.
 */
export function ReviewTypeFilter() {
  const { actions, plugin } = useReviewContext();
  const typesToReview = useAppSelector((state) => state.typesToReview);

  return (
    <TypeFilterMenu
      app={plugin.app}
      enabled={typesToReview}
      onToggle={(type) => void actions.toggleReviewType(type)}
      tooltip="Choose item types to review"
    />
  );
}
