/**
 * A bare change signal: listeners subscribe, and `emit` calls each of them.
 * `subscribe` returns the unsubscribe, as `useSyncExternalStore` expects.
 */
export function createEmitter() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    emit() {
      listeners.forEach((fn) => fn());
    },
  };
}
