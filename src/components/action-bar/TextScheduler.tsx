import { ReviewArticle, ReviewText } from '#/lib/types';
import { SchedulingModal } from '#/views/SchedulingModal';
import { CalendarSync } from 'lucide-react';
import { useReviewContext } from '../ReviewContext';
import { ButtonWithIcon, Separator } from './BarButtons';
import { FixedIntervalField } from './FixedIntervalField';
import { PriorityField } from './PriorityField';

/**
 * Field to set the priority or fixed interval plus a button to open a
 * SchedulingModal
 */
export function TextScheduler({ text }: { text: ReviewText }) {
  const { plugin, actions } = useReviewContext();
  const strategy =
    text.data.type === 'article' && text.data.fixed_interval_days !== null
      ? 'fixed'
      : 'priority';

  return (
    <>
      {strategy === 'priority' && (
        <PriorityField
          key={text.data.id}
          onBlur={async (priority: number) => {
            await actions.reprioritize(text, priority);
          }}
          initialPriority={text.data.priority}
        />
      )}
      {strategy === 'fixed' && (
        <FixedIntervalField
          key={text.data.id}
          onBlur={async (intervalDays: number) => {
            await actions.manageFixedInterval(text as ReviewArticle, {
              newIntervalDays: intervalDays,
            });
          }}
          initialInterval={(text as ReviewArticle).data.fixed_interval_days}
        />
      )}
      <ButtonWithIcon
        tooltip="Change scheduling strategy"
        handleClick={() => {
          new SchedulingModal(plugin, text).open();
        }}
      >
        <CalendarSync />
      </ButtonWithIcon>
      <Separator />
    </>
  );
}
