import type IncrementalReadingPlugin from '#/main';
import { SchedulingModal } from '#/views/SchedulingModal';
import type { Grade } from 'ts-fsrs';
import { Rating } from 'ts-fsrs';
import { Actions } from './Actions';
import { getCurrentItemSync } from './query-client';
import { cardsOnly, setShowAnswer, store } from './store';
import { isReviewCard, isReviewText } from './types';

/** Commands corresponding to buttons on the action bar */
export function initReviewCommands(plugin: IncrementalReadingPlugin) {
  const actions = new Actions(plugin);

  plugin.addCommand({
    id: 'mark-review',
    name: 'Review: show answer/mark as reviewed',
    // hotkeys: [{ key: 'A', modifiers: ['Alt'] }],
    checkCallback: (checking) => {
      const view = plugin.getActiveReviewView();
      if (!view || !view.file) return false;
      const currentItem = getCurrentItemSync();
      if (!currentItem) return false;
      const isCard = isReviewCard(currentItem);
      if (isCard && store.getState().showAnswer) {
        return false;
      }
      if (checking) return true;

      if (isCard) void store.dispatch(setShowAnswer(true));
      else void actions.review(currentItem);
    },
  });

  plugin.addCommand({
    id: 'skip-item',
    name: 'Review: skip for current session',
    // hotkeys: [{ key: 'S', modifiers: ['Alt'] }],
    checkCallback: (checking) => {
      const view = plugin.getActiveReviewView();
      if (!view) return false;
      const item = getCurrentItemSync();
      if (!item) return false;
      if (checking) return true;
      void actions.skipItem(item);
    },
  });

  plugin.addCommand({
    id: 'dismiss-item',
    name: 'Review: dismiss from future review',
    // hotkeys: [{ key: 'D', modifiers: ['Alt'] }],
    checkCallback: (checking) => {
      const view = plugin.getActiveReviewView();
      if (!view) return false;
      const item = getCurrentItemSync();
      if (!item || item.data.dismissed) return false;
      if (checking) return true;
      void actions.dismissItem(item);
    },
  });

  plugin.addCommand({
    id: 'undismiss-item',
    name: 'Review: un-dismiss',
    // hotkeys: [{ key: 'D', modifiers: ['Alt'] }],
    checkCallback: (checking) => {
      const view = plugin.getActiveReviewView();
      if (!view) return false;
      const item = getCurrentItemSync();
      if (!item || !item.data.dismissed) return false;
      if (checking) return true;
      void actions.unDismissItem(item);
    },
  });

  plugin.addCommand({
    id: 'open-scheduling-modal',
    name: 'Manage item scheduling',
    checkCallback: (checking) => {
      const view = plugin.getActiveReviewView();
      if (!view) return false;
      const item = getCurrentItemSync();
      if (!item || !isReviewText(item)) return false;
      if (checking) return true;
      new SchedulingModal(plugin, item).open();
    },
  });

  plugin.addCommand({
    id: 'toggle-cards-only',
    name: 'Review: toggle reviewing cards only',
    checkCallback: (checking) => {
      const view = plugin.getActiveReviewView();
      if (!view) return false;
      if (checking) return true;
      const showCardsOnly = cardsOnly(store.getState());
      void actions.setCardsOnly(!showCardsOnly);
    },
  });

  const gradeCommandCb = (checking: boolean, grade: Grade): boolean | void => {
    if (!store.getState().showAnswer) return false;
    const view = plugin.getActiveReviewView();
    if (!view || !view.file) return false;
    const item = getCurrentItemSync();
    if (!item || !isReviewCard(item)) return false;
    if (checking) return true;
    void actions.gradeCard(item, grade);
  };

  plugin.addCommand({
    id: 'grade-card-again',
    name: 'Review: grade card 1 (again)',
    // hotkeys: [{ key: '1', modifiers: ['Alt'] }],
    checkCallback: (checking) => gradeCommandCb(checking, Rating.Again),
  });

  plugin.addCommand({
    id: 'grade-card-hard',
    name: 'Review: grade card 2 (hard)',
    // hotkeys: [{ key: '2', modifiers: ['Alt'] }],
    checkCallback: (checking) => gradeCommandCb(checking, Rating.Hard),
  });

  plugin.addCommand({
    id: 'grade-card-good',
    name: 'Review: grade card 3 (good)',
    // hotkeys: [{ key: '3', modifiers: ['Alt'] }],
    checkCallback: (checking) => gradeCommandCb(checking, Rating.Good),
  });

  plugin.addCommand({
    id: 'grade-card-easy',
    name: 'Review: grade card 4 (easy)',
    // hotkeys: [{ key: '4', modifiers: ['Alt'] }],
    checkCallback: (checking) => gradeCommandCb(checking, Rating.Easy),
  });
}
