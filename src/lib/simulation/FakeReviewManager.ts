import type { ReviewItem } from '#/lib/types';

export class FakeReviewManager {
  #nextItem: ReviewItem | null = null;
  #gate: Promise<void> = Promise.resolve();
  #gateResolve: (() => void) | null = null;
  fetchCallCount = 0;

  setNextItem(item: ReviewItem | null): void {
    this.#nextItem = item;
  }

  blockFetch(): void {
    this.#gate = new Promise((resolve) => {
      this.#gateResolve = resolve;
    });
  }

  resumeFetch(): void {
    this.#gateResolve?.();
    this.#gateResolve = null;
  }

  async getReviewItemFromId(_id: string): Promise<ReviewItem | null> {
    this.fetchCallCount++;
    await this.#gate;
    return this.#nextItem;
  }
}
