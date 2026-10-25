import { SCHEDULING_BUTTON_LABEL } from '#/lib/constants';
import type { ReviewArticle, ReviewText } from '#/lib/types';
import { SchedulingModal } from '#/views/SchedulingModal';
import { CalendarSync, Flag } from 'lucide-react';
import type { ComponentChildren } from 'preact';
import { useReviewContext } from '../ReviewContext';
import { ButtonWithIcon } from './BarButtons';
import { FixedIntervalField } from './FixedIntervalField';
import { PriorityField } from './PriorityField';

/** Class on the icon button that opens the {@link SchedulingModal}. */
export const SCHEDULING_BUTTON_CLASS = 'ir-scheduling-button';

/**
 * Field to set the priority or fixed interval, led by an icon naming the
 * strategy in place of a text label: a flag for priority, `calendar-sync` for
 * a fixed interval. The icon opens a {@link SchedulingModal}.
 */
export function TextScheduler({ text }: { text: ReviewText }) {
  const { plugin, actions } = useReviewContext();
  const isFixedInterval =
    text.data.type === 'article' && text.data.fixed_interval_days !== null;

  const schedulingButton = (icon: ComponentChildren) => (
    <ButtonWithIcon
      className={SCHEDULING_BUTTON_CLASS}
      tooltip={SCHEDULING_BUTTON_LABEL}
      handleClick={() => {
        new SchedulingModal(plugin, text).open();
      }}
    >
      {icon}
    </ButtonWithIcon>
  );

  return isFixedInterval ? (
    <FixedIntervalField
      key={text.data.id}
      leading={schedulingButton(<CalendarSync />)}
      onBlur={async (intervalDays: number) => {
        await actions.manageFixedInterval(text as ReviewArticle, {
          newIntervalDays: intervalDays,
        });
      }}
      initialInterval={(text as ReviewArticle).data.fixed_interval_days}
    />
  ) : (
    <PriorityField
      key={text.data.id}
      leading={schedulingButton(<Flag />)}
      onBlur={async (priority: number) => {
        await actions.reprioritize(text, priority);
      }}
      initialPriority={text.data.priority}
    />
  );
}
