/**
 * The pause after the review tab moves to another item during which the
 * action bar and the review commands ignore presses, so the second click of a
 * double click — or a hotkey pressed twice — doesn't act on the item that just
 * replaced the one it was meant for.
 *
 * The pause starts when the bar shows something new, not when the press that
 * caused it lands: grading writes to the database and refetches before the
 * next item appears, and that wait is no part of the guard. Making a snippet
 * or card changes nothing on screen, so it starts the pause itself (`arm`).
 */
export class ActionCooldown {
  /** What the bar last showed; `undefined` until it has shown anything. */
  #shown: string | null | undefined = undefined;
  #changedAt = Number.NEGATIVE_INFINITY;

  /**
   * Note what the bar shows at `now`: a key naming the item (and whatever
   * else moves its buttons around), or null for no item. Only a key unlike the
   * last one starts the pause, so the current-item poll, which hands back the
   * same item every few seconds, never does.
   */
  show(key: string | null, now: number): void {
    if (key === this.#shown) return;
    this.#shown = key;
    this.#changedAt = now;
  }

  /**
   * Start the pause at `now` without anything new on screen: making a snippet
   * or card leaves the item where it is, yet a second press of the same
   * button or hotkey would make a second one. Leaves what was shown alone, so
   * the next refetch of the same item doesn't restart the pause either.
   */
  arm(now: number): void {
    this.#changedAt = now;
  }

  /** Whether a press at `now` falls inside a pause of `seconds`. */
  isCoolingDown(now: number, seconds: number): boolean {
    // Rounded to whole milliseconds: a slider step such as 1.1 s is
    // 1100.0000000000002 ms unrounded, which would hold a press at exactly
    // 1100 ms.
    return now - this.#changedAt < Math.round(seconds * 1000);
  }
}

const cooldowns = new WeakMap<object, ActionCooldown>();

/**
 * The cooldown of one review tab, keyed by its view, so the bar that arms it and
 * the commands that consult it share one without either owning the other.
 */
export function actionCooldownFor(reviewView: object): ActionCooldown {
  let cooldown = cooldowns.get(reviewView);
  if (!cooldown) {
    cooldown = new ActionCooldown();
    cooldowns.set(reviewView, cooldown);
  }
  return cooldown;
}
