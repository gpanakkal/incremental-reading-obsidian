import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'preact/hooks';
import { useDispatch } from 'react-redux';
import { Rating } from 'ts-fsrs';
import { useAppSelector, useAppStore } from '#/hooks/useAppSelector';
import { setShowAnswer } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import {
  isReviewCard,
  type ReviewCard,
  type ReviewSnippet,
  type ReviewArticle,
  isReviewArticle,
  isReviewSnippet,
} from '#/lib/types';
import { transformPriority } from '#/lib/utils';
import { useReviewContext } from './ReviewContext';

export function ActionBar() {
  const store = useAppStore();
  const { reviewManager } = useReviewContext();
  const { data: currentItem } = useQuery({
    queryKey: [store.getState().currentItem?.data.id],
    queryFn: async () => {
      const currentItem = store.getState().currentItem;
      if (!currentItem) return;
      const item = await reviewManager.getReviewItemFromFile(currentItem.file);
      return item ?? undefined;
    },
  });

  return (
    <div className="ir-action-bar" tabIndex={-1}>
      {/* setting a tabIndex makes the action bar focusable */}
      {currentItem && (
        <>
          {isReviewCard(currentItem) && <CardActions card={currentItem} />}
          {isReviewArticle(currentItem) && (
            <ArticleActions article={currentItem} />
          )}
          {isReviewSnippet(currentItem) && (
            <SnippetActions snippet={currentItem} />
          )}
          <ItemActions reviewItem={currentItem} />
        </>
      )}
      <GlobalActions />
    </div>
  );
}

/**
 * TODO:
 * - forward/back
 * - view queue
 * - undo last review
 */
function GlobalActions() {
  return <></>;
}

/**
 * Actions common to articles, snippets, and cards
 */
function ItemActions({ reviewItem }: { reviewItem: ReviewItem }) {
  const {
    dismissItem,
    unDismissItem,
    skipItem,
    reviewView,
    registerActionBarHotkey,
    plugin,
  } = useReviewContext();
  const isDismissed = reviewItem.data.dismissed;

  const stopEditing = (evt: KeyboardEvent) => {
    const editor = document.querySelector(
      'div.ir-review-interface div.cm-editor'
    );
    const actionBar = document.querySelector(
      'div.ir-review-interface div.ir-action-bar'
    );
    if (!editor || !actionBar) {
      console.warn(`Editor or action bar not found!`);
      return;
    }
    if (editor.contains(document.activeElement)) {
      (actionBar as HTMLElement).focus();
      // intercept other keybinds
      evt.stopImmediatePropagation();
    }
  };

  useEffect(
    function initHotkeys() {
      const handlers = [
        reviewView.scope.register(null, 'Escape', (evt) => {
          if (!plugin.settings.allowEscBind) return;
          stopEditing(evt);
        }),
        registerActionBarHotkey(['Alt'], 'd', async () => {
          return isDismissed
            ? await unDismissItem(reviewItem)
            : await dismissItem(reviewItem);
        }),
        registerActionBarHotkey(['Alt'], 's', () => {
          skipItem(reviewItem);
        }),
      ];

      return () => {
        handlers.forEach((handler) => reviewView.scope.unregister(handler));
      };
    },
    [reviewItem]
  );

  return (
    <>
      {isDismissed ? (
        <Button
          label="Un-dismiss"
          tooltip="Alt + D"
          handleClick={async () => await unDismissItem(reviewItem)}
        />
      ) : (
        <Button
          label="Dismiss"
          tooltip="Alt + D"
          handleClick={async () => await dismissItem(reviewItem)}
        />
      )}
      <Button
        label={'Skip'}
        tooltip="Alt + S"
        handleClick={() => {
          skipItem(reviewItem);
        }}
      />
    </>
  );
}

/**
 * TODO:
 * - manual scheduling
 */
function ArticleActions({ article: article }: { article: ReviewArticle }) {
  const [display, setDisplay] = useState({
    priority: article.data.priority / 10,
  });
  const { reviewArticle, reviewView, reprioritize, registerActionBarHotkey } =
    useReviewContext();

  const updateDisplay = (updates: Partial<typeof display>) => {
    setDisplay((prev) => ({ ...prev, ...updates }));
  };

  useEffect(() => {
    setDisplay({ priority: article.data.priority / 10 });
  }, [article]);

  useEffect(
    function initHotkeys() {
      const handler = registerActionBarHotkey(['Alt'], 'c', async () => {
        await reviewArticle(article);
      });
      return () => {
        if (handler) reviewView.scope.unregister(handler);
      };
    },
    [reviewView, article, reviewArticle]
  );

  return (
    <>
      <Button
        label="Continue"
        tooltip="Alt + C"
        handleClick={async () => await reviewArticle(article)}
      />
      <label className={'ir-priority-label'}>
        Priority
        <input
          id={'ir-priority-input'}
          value={display.priority}
          className={'ir-priority-input'}
          type="text"
          inputMode="decimal"
          onChange={(e) => {
            const transformed = transformPriority(e.currentTarget.value);
            updateDisplay({ priority: transformed / 10 });
          }}
          onBlur={() => {
            void reprioritize(article, display.priority);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void reprioritize(article, display.priority);
            } else if (e.key === 'Escape') {
              updateDisplay({ priority: article.data.priority });
              e.currentTarget.select();
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
    </>
  );
}

/**
 * TODO:
 * - manual scheduling
 */
function SnippetActions({ snippet }: { snippet: ReviewSnippet }) {
  const [display, setDisplay] = useState({
    priority: snippet.data.priority / 10,
  });
  const { reviewSnippet, reviewView, reprioritize, registerActionBarHotkey } =
    useReviewContext();

  const updateDisplay = (updates: Partial<typeof display>) => {
    setDisplay((prev) => ({ ...prev, ...updates }));
  };

  useEffect(() => {
    setDisplay({ priority: snippet.data.priority / 10 });
  }, [snippet]);

  useEffect(
    function initHotkeys() {
      const handler = registerActionBarHotkey(['Alt'], 'c', async () => {
        await reviewSnippet(snippet);
      });
      return () => {
        reviewView.scope.unregister(handler);
      };
    },
    [reviewView, snippet, reviewSnippet]
  );

  return (
    <>
      <Button
        label="Continue"
        tooltip="Alt + C"
        handleClick={async () => await reviewSnippet(snippet)}
      />
      <div className="ir-priority-container">
        <label className={'ir-priority-label'}>
          Priority
          <input
            id={'ir-priority-input'}
            value={display.priority}
            className={'ir-priority-input'}
            type="text"
            inputMode="decimal"
            onChange={(e) => {
              const transformed = transformPriority(e.currentTarget.value);
              updateDisplay({ priority: transformed / 10 });
            }}
            onBlur={() => void reprioritize(snippet, display.priority)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void reprioritize(snippet, display.priority);
              } else if (e.key === 'Escape') {
                updateDisplay({ priority: snippet.data.priority });
                e.currentTarget.select();
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
      </div>
    </>
  );
}

function CardActions({ card }: { card: ReviewCard }) {
  const dispatch = useDispatch();
  const showAnswer = useAppSelector((state) => state.showAnswer);
  const { gradeCard, reviewView, registerActionBarHotkey } = useReviewContext();

  useEffect(
    function initShowAnswerHotkey() {
      const handler = registerActionBarHotkey(['Alt'], 'c', () => {
        dispatch(setShowAnswer(true));
      });
      return () => {
        reviewView.scope.unregister(handler);
      };
    },
    [reviewView, card]
  );

  useEffect(
    function initGradingHotkeys() {
      if (!showAnswer) return;

      const handlers = [
        registerActionBarHotkey(null, '1', async () => {
          await gradeCard(card, Rating.Again);
        }),
        registerActionBarHotkey(null, '2', async () => {
          await gradeCard(card, Rating.Hard);
        }),
        registerActionBarHotkey(null, '3', async () => {
          await gradeCard(card, Rating.Good);
        }),
        registerActionBarHotkey(null, '4', async () => {
          await gradeCard(card, Rating.Easy);
        }),
      ];
      return () => {
        handlers.forEach((handler) => reviewView.scope.unregister(handler));
      };
    },
    [card, showAnswer]
  );

  return (
    <>
      {showAnswer ? (
        <>
          <Button
            label="🔁 Again"
            tooltip="1"
            handleClick={async () => await gradeCard(card, Rating.Again)}
          />
          <Button
            label="👎 Hard"
            tooltip="2"
            handleClick={async () => await gradeCard(card, Rating.Hard)}
          />
          <Button
            label="👍 Good"
            tooltip="3"
            handleClick={async () => await gradeCard(card, Rating.Good)}
          />
          <Button
            label="✅ Easy"
            tooltip="4"
            handleClick={async () => await gradeCard(card, Rating.Easy)}
          />
        </>
      ) : (
        <>
          <Button
            label="Show Answer"
            tooltip="Alt + C"
            handleClick={() => {
              dispatch(setShowAnswer(true));
            }}
          />
        </>
      )}
    </>
  );
}

function Button({
  label,
  handleClick,
  disabled,
  tooltip,
}: {
  label: string;
  handleClick: (e: MouseEvent) => Promise<void> | void;
  disabled?: boolean;
  tooltip?: string;
}) {
  return (
    <button
      className="ir-review-button"
      onClick={(e) => void handleClick(e)}
      title={tooltip}
      disabled={disabled}
    >
      {label}
    </button>
  );
}
