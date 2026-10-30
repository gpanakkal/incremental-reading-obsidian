import { actionCooldownFor } from '#/lib/action-cooldown';
import { invalidateItemQuery } from '#/lib/query-client';
import type {
  ReviewArticle,
  ReviewText,
  SchedulingStrategy,
} from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import { Modal } from 'obsidian';
import { render } from 'preact';
import { SchedulingModalContent } from '../components/SchedulingModalContent';
import type ReviewView from './ReviewView';

export class SchedulingModal extends Modal {
  plugin: IncrementalReadingPlugin;
  item: ReviewText;
  /** The review tab it was opened for, if any; see {@link close}. */
  reviewView: ReviewView | undefined;
  /**
   * Whether it has closed yet (each opening is a new modal). A Confirm still
   * saving closes it once the save ends, maybe after Escape already has.
   */
  #closed = false;

  constructor(
    plugin: IncrementalReadingPlugin,
    item: ReviewText,
    reviewView?: ReviewView
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.item = item;
    this.reviewView = reviewView;
  }

  /**
   * Starts the review tab's double-click guard (see `ActionCooldown`) as the
   * modal closes, however it is closed. Obsidian hands focus back to what had
   * it before, often the bar's scheduling button, so the key repeat of an
   * Enter held on Confirm would click that button and open the modal again.
   *
   * Here rather than in `onClose`: on phones Obsidian runs `onClose` only once
   * the closing animation ends, but gives focus back at once (undocumented;
   * read from obsidian.asar).
   *
   * Only the first close starts it: a later one, when a slow save ends after
   * Escape, would hold the bar long after the modal went.
   */
  close() {
    if (this.reviewView && !this.#closed) {
      actionCooldownFor(this.reviewView).arm(performance.now());
    }
    this.#closed = true;
    super.close();
  }

  async handleClose(strategy: SchedulingStrategy, value: number) {
    const { plugin, item } = this;
    const promises = [];

    if (strategy === 'priority') {
      if (
        item.data.type === 'article' &&
        item.data.fixed_interval_days !== null
      ) {
        promises.push(
          plugin.actions.manageFixedInterval(item as ReviewArticle, {
            newPriority: value,
          })
        );
      } else {
        promises.push(plugin.actions.reprioritize(item, value));
      }
    } else {
      // fixed-interval strategy
      if (item.data.type !== 'article') {
        throw new TypeError(
          `Attempted to set a fixed interval on ${item.data.reference}, but this can only be set on articles`
        );
      }
      promises.push(
        plugin.actions.manageFixedInterval(item as ReviewArticle, {
          newIntervalDays: value,
        })
      );
    }

    await Promise.all(promises);
    await invalidateItemQuery(item.data.id);
  }

  onOpen() {
    const { plugin, item, contentEl } = this;
    const { data } = item;
    this.setTitle(item.file.basename);
    const schedule = {
      intervalDays: data.type === 'article' ? data.fixed_interval_days : null,
      priority: data.priority,
    };
    render(
      <SchedulingModalContent
        plugin={plugin}
        type={data.type}
        schedule={schedule}
        onClose={(args) => {
          if (args !== 'cancel') {
            void this.handleClose(args.strategy, args.value).finally(() =>
              this.close()
            );
          } else {
            this.close();
          }
        }}
      />,
      contentEl
    );
  }

  onClose() {
    render(null, this.contentEl);
  }
}
