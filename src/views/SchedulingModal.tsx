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

export class SchedulingModal extends Modal {
  plugin: IncrementalReadingPlugin;
  item: ReviewText;

  constructor(plugin: IncrementalReadingPlugin, item: ReviewText) {
    super(plugin.app);
    this.plugin = plugin;
    this.item = item;
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
