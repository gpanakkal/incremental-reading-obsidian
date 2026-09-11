import type { ReviewSession } from './plugin-data';
import type { ReviewPage } from './store';

/**
 * How long a cleared item has to stay cleared before it is written out.
 *
 * `currentItemId` goes null for a moment on every advance — `resetCurrentItem`
 * fires, then the next item's id arrives from `fetchNextItem` — so an immediate
 * write would erase the pointer between two items. The delay also gives
 * {@link SessionTracker.suspend} time to swallow the clear that plugin unload
 * and app quit push through the store on their way out.
 */
export const SESSION_CLEAR_DELAY = 500;

/** The slice of the review store this tracker mirrors. */
interface SessionStore {
  getState(): { page: ReviewPage; currentItemId: string | null };
  subscribe(listener: () => void): () => void;
}

interface SessionTrackerOptions {
  store: SessionStore;
  deviceId: string;
  save: (session: ReviewSession | null) => Promise<void>;
  /** What the last restore found on disk, so an unchanged pointer isn't rewritten. */
  initialItemId?: string | null;
  clearDelay?: number;
}

/**
 * Mirrors "the item currently open in review" into `data.json`.
 *
 * Both discard rules are already store transitions, so there is nothing to wire
 * into the components: going back to the home screen moves `page` off
 * `'review'`, and finishing the last item leaves `currentItemId` null once
 * `fetchNextItem` comes back empty. Both land here as "no item".
 *
 * Everything else that empties the store — closing the tab, unloading, quitting
 * — must not be read as either, and each says so first:
 * {@link SessionTracker.commit} for a closed tab, {@link SessionTracker.suspend}
 * for teardown.
 *
 * Writes of an actual item are immediate — a quit right after an advance must
 * not lose it — while clears are delayed, since a clear is also what closing and
 * teardown look like on their way through the store.
 */
export class SessionTracker {
  readonly #store: SessionStore;
  readonly #deviceId: string;
  readonly #save: (session: ReviewSession | null) => Promise<void>;
  readonly #clearDelay: number;

  /** The item id last written to disk, so writes are skipped when nothing moved. */
  #persisted: string | null;
  #timer: number | null = null;
  #suspended = false;
  /**
   * Set while a remembered item is being kept through an empty store: a closed
   * tab, or a launch whose review tab has not shown the item yet. Starts set,
   * since nothing is on screen until review puts it there — an item cannot be
   * left before it has been arrived at. See {@link commit}.
   */
  #holding = true;
  /** Serializes writes: `saveData` replaces the whole file, so order matters. */
  #pending: Promise<void> = Promise.resolve();

  constructor({
    store,
    deviceId,
    save,
    initialItemId = null,
    clearDelay = SESSION_CLEAR_DELAY,
  }: SessionTrackerOptions) {
    this.#store = store;
    this.#deviceId = deviceId;
    this.#save = save;
    this.#persisted = initialItemId;
    this.#clearDelay = clearDelay;
  }

  /**
   * Begin mirroring. Returns the cleanup to hand to `Plugin.register`.
   *
   * Reads the store once on the way in: a restored tab is already showing its
   * item by the time this runs, and the hold that carried the item over has to
   * lift on that, not wait for whatever the user does next.
   */
  start(): () => void {
    const unsubscribe = this.#store.subscribe(() => this.#handleChange());
    this.#handleChange();
    return () => {
      unsubscribe();
      this.#cancelPendingClear();
    };
  }

  /**
   * Stop writing, permanently.
   *
   * Call before anything tears the review session down — app quit, plugin
   * unload — so that nothing that teardown pushes through the store, and no
   * clear already sitting on the timer, can land after the user has left.
   */
  suspend(): void {
    this.#suspended = true;
    this.#cancelPendingClear();
  }

  /**
   * A review tab is closing: write what it was showing, and keep that through
   * the emptying of the store that follows.
   *
   * The closing tab has the last word, so whichever tab closes last is the one
   * `data.json` remembers — the shape the future multiple-review-tabs feature
   * needs, where the pointer cannot be left to whichever write happened to land
   * most recently. A tab closing on an item writes that item; a tab that had
   * already left it — the home screen, or "nothing due" after the last item —
   * writes the departure out on the spot rather than leaving it on the timer,
   * where a quit moments later would cancel it and resume an item the user
   * walked away from.
   *
   * Only a tab that reached an item is held afterwards: the `resetSession` the
   * close dispatches is indistinguishable from leaving review, and the hold has
   * to outlast it — reopening the tab can land on the home screen, which would
   * otherwise clear on arrival — so it lifts on the next item shown rather than
   * on a timer.
   *
   * A hold already in force short-circuits the whole thing: nothing has been on
   * screen since the last tab committed, so this tab has no state of its own to
   * record and the earlier tab's pointer stands.
   */
  commit(): void {
    if (this.#suspended) return;
    if (this.#holding) return;

    const itemId = this.#shownItemId();
    this.#cancelPendingClear();
    if (itemId !== this.#persisted) {
      this.#persisted = itemId;
      this.#write(
        itemId === null ? null : { deviceId: this.#deviceId, itemId }
      );
    }
    // Held either way: the tab is gone, so nothing is on screen to leave, and
    // a tab that reopens onto the home screen has no state of its own to
    // record. The next item shown lifts it.
    this.#holding = true;
  }

  /**
   * Review is done with the item it was showing — reviewed, skipped, dismissed
   * or deleted — so there is nothing to come back to, and any hold covering it
   * lifts.
   *
   * Told rather than inferred, because the store cannot tell the difference: a
   * finished item and a closed tab both arrive here as `currentItemId` going
   * null, and the two race. Acting on the item runs a database write first, so
   * closing the tab in the moments after the click reaches {@link commit} while
   * the item is still on screen — the tab commits and holds that item, the
   * finish lands after it, and the pointer would survive an item the user is
   * done with. Whenever the finish lands, it wins.
   *
   * Leaves the clear on its usual timer, so advancing to the next item still
   * writes once rather than writing a null in between. Called from
   * `Actions.getNext`, which every finishing action ends on.
   */
  finish(): void {
    this.#holding = false;
  }

  /**
   * The item review is meant to come back to, as of right now.
   *
   * Null the moment review leaves the item, while the write recording that is
   * still on the timer: `data.json` lags a departure by up to
   * {@link SESSION_CLEAR_DELAY}, so a resume reading the file inside that window
   * would reopen the item review just finished with. Read this instead —
   * see `Plugin.resumeSession`.
   */
  get itemId(): string | null {
    return this.#timer === null ? this.#persisted : null;
  }

  /** What review is showing right now, as a pointer: null unless on an item. */
  #shownItemId(): string | null {
    const { page, currentItemId } = this.#store.getState();
    return page === 'review' ? currentItemId : null;
  }

  #handleChange(): void {
    if (this.#suspended) return;
    const itemId = this.#shownItemId();

    if (itemId === null) {
      if (this.#holding) return;
      this.#scheduleClear();
      return;
    }
    this.#holding = false;
    this.#cancelPendingClear();
    if (itemId === this.#persisted) return;
    this.#persisted = itemId;
    this.#write({ deviceId: this.#deviceId, itemId });
  }

  #scheduleClear(): void {
    if (this.#timer !== null) return;
    // No suspended check inside: suspending cancels the timer, so a fired
    // callback is by definition one that was never suspended.
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      this.#clear();
    }, this.#clearDelay);
  }

  #cancelPendingClear(): void {
    if (this.#timer === null) return;
    window.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #clear(): void {
    if (this.#persisted === null) return;
    this.#persisted = null;
    this.#write(null);
  }

  #write(session: ReviewSession | null): void {
    this.#pending = this.#pending
      .then(() => this.#save(session))
      .catch((error: unknown) => {
        console.error('Incremental Reading - failed to save session:', error);
      });
  }
}
