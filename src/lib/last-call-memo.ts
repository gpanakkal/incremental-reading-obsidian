/** A memo of one call at a time (see {@link lastCallMemo}). */
export interface LastCallMemo<A, T> {
  /** What `read` answers for `arg`, remembered or read now. */
  get(arg: A): T;
  /** Drop what is remembered, so the next `get` reads. */
  forget(): void;
}

/**
 * `read`, remembered for the last argument it was asked about for as long as
 * `keyOf` gives the same key and `forget` is not called: one read per key and
 * per change for a caller that asks the same thing over and over.
 */
export function lastCallMemo<A, T>(
  read: (arg: A) => T,
  keyOf: (arg: A) => string
): LastCallMemo<A, T> {
  let last: { key: string; value: T } | null = null;
  return {
    get(arg) {
      const key = keyOf(arg);
      if (last?.key !== key) last = { key, value: read(arg) };
      return last.value;
    },
    forget() {
      last = null;
    },
  };
}
