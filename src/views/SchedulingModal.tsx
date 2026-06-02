import { invalidateItemQuery } from '#/lib/query-client';
import type {
  ReviewArticle,
  ReviewSnippet,
  ReviewText,
  SchedulingStrategy,
} from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import type { TFile } from 'obsidian';
import { Modal } from 'obsidian';
import { render } from 'preact';
import { SchedulingModalContent } from '../components/SchedulingModalContent';

export class SchedulingModal extends Modal {
  plugin: IncrementalReadingPlugin;
  file: TFile;
  data: ReviewText['data'] | null;

  constructor(
    plugin: IncrementalReadingPlugin,
    item: { file: TFile; data: ReviewText['data'] | null }
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = item.file;
    this.data = item.data;
  }

  async handleClose(strategy: SchedulingStrategy, value: number) {
    const { plugin, file, data } = this;
    if (data === null) {
      // item doesn't exist, so import it as an article
      const props: [priority: number, intervalDays: number | null] =
        strategy === 'priority'
          ? [value, null]
          : [plugin.settings.defaultPriority, value];
      const importedArticle = await plugin.reviewManager.importArticle(
        file,
        ...props
      );
      if (!importedArticle) {
        throw new Error(`Failed to import article ${file.path}`);
      }

      if (plugin.getOpenReviewLeaf()) {
        await plugin.learn(importedArticle);
      }
    } else {
      const item: ReviewText =
        data.type === 'article'
          ? ({ file, data } satisfies ReviewArticle)
          : ({ file, data } satisfies ReviewSnippet);
      const promises = [];
      // item already exists, so update its properties

      if (strategy === 'priority') {
        if (item.data.type === 'article') {
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
            `Attempted to set a fixed interval on ${data.reference}, but this can only be set on articles`
          );
        }
        promises.push(
          plugin.actions.manageFixedInterval(item as ReviewArticle, {
            newIntervalDays: value,
          })
        );
      }

      await Promise.all(promises);
      // invalidate cache for immediate updates
      await invalidateItemQuery(item.data.id);
    }
  }

  onOpen() {
    const { plugin, contentEl, data } = this;
    const schedule = {
      intervalDays: null as number | null,
      priority: plugin.settings.defaultPriority,
    };

    if (data) {
      schedule.priority = data.priority;
      if (data.type === 'article') {
        schedule.intervalDays = data.fixed_interval_days;
      }
    }
    render(
      <SchedulingModalContent
        plugin={plugin}
        type={data ? data.type : 'article'}
        schedule={schedule}
        onClose={(args) => {
          if (args !== 'cancel') {
            void this.handleClose(args.strategy, args.value).finally(() =>
              this.close()
            );
          }
        }}
      />,
      contentEl
    );
  }

  onClose() {
    const { contentEl } = this;
    render(null, contentEl);
  }
}
