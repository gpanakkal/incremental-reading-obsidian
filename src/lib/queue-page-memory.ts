import type { IRPluginState } from './store';

/** The review type filter the page was chosen under. */
type QueueFilter = IRPluginState['typesToReview'];

/**
 * The home screen's last chosen page of the upcoming table, kept so leaving
 * the home screen and coming back lands where the user was.
 *
 * Held in memory by the plugin instance and nowhere else: it is not a setting
 * and not synced, and a fresh launch starts at the first page.
 *
 * The page is remembered with the filter it was chosen under and reads as the
 * first page under any other. A filter change makes a different queue, where
 * page 3 of the old one names nothing in particular. Filters are told apart by
 * identity, not by the types they let through: the store builds a new one on
 * every change, so turning a type off and back on is a change too, even while
 * the home screen is not open to see it.
 */
export class QueuePageMemory {
  private filter: QueueFilter | null = null;
  private page = 0;

  /** The page last chosen under `filter`, or the first page. */
  get(filter: QueueFilter): number {
    return filter === this.filter ? this.page : 0;
  }

  /** Remember `page` as the one chosen under `filter`. */
  set(filter: QueueFilter, page: number) {
    this.filter = filter;
    this.page = page;
  }

  /** Forget the page, as the plugin does when it unloads. */
  clear() {
    // The page itself is left: no filter names it any more, so it reads as
    // the first page until the next set overwrites it.
    this.filter = null;
  }
}
