import type IncrementalReadingPlugin from '#/main';
import { SchedulingModal } from '#/views/SchedulingModal';
import { type Grade, Rating } from 'ts-fsrs';
import { getCurrentItemSync } from './query-client';
import { cardsOnly, setShowAnswer, store } from './store';
import { isReviewCard, isReviewText } from './types';

/** Commands corresponding to buttons on the action bar */
export function initReviewCommands(plugin: IncrementalReadingPlugin) {
  plugin.addCommand({
    id: 'mark-review',
    name: 'Review: show answer/mark reviewed',
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
      else void plugin.actions.review(currentItem);
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
      void plugin.actions.skipItem(item);
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
      void plugin.actions.dismissItem(item);
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
      void plugin.actions.unDismissItem(item);
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
      void plugin.actions.setCardsOnly(!showCardsOnly);
    },
  });

  // Obsidian's own `editor:toggle-source` cannot serve the review tab. Its
  // check is `workspace.activeEditor instanceof MarkdownView`, which a
  // `FileView` never satisfies, and its effect is to put a markdown view in the
  // leaf (`leaf.setViewState({ type: 'markdown', state: { source } })`) — which
  // would replace review with a plain note pane rather than switch its editor.
  // So the switch review already owns gets a command of its own here.
  plugin.addCommand({
    id: 'toggle-source-mode',
    name: 'Toggle live preview/source mode',
    icon: 'lucide-code-2',
    checkCallback: (checking) => {
      // The same gate as the tab's own menu entry: a mounted editor is what the
      // switch acts on, and a card still asking its question is rendered
      // markdown rather than an editor.
      const view = plugin.getActiveReviewView();
      if (!view?.reviewEditor()) return false;
      if (checking) return true;
      view.toggleSourceMode();
    },
  });

  const gradeCommandCb = (checking: boolean, grade: Grade): boolean | void => {
    if (!store.getState().showAnswer) return false;
    const view = plugin.getActiveReviewView();
    if (!view || !view.file) return false;
    const item = getCurrentItemSync();
    if (!item || !isReviewCard(item)) return false;
    if (checking) return true;
    void plugin.actions.gradeCard(item, grade);
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

  plugin.addCommand({
    id: 'go-to-context',
    name: 'Go to context',
    checkCallback: (checking) => {
      const file = plugin.getActiveReviewView()?.currentItemFile();
      if (!file) return false;
      if (checking) return true;

      void plugin.actions.goToContext(file);
    },
  });
}
