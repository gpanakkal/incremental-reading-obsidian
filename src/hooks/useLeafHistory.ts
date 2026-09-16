import type { WorkspaceLeaf } from 'obsidian';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether `leaf` has anywhere to go back or forward to, kept current as its
 * history changes.
 *
 * The stacks are mutated in place, so each flag is its own snapshot: a boolean
 * compares by value, where the arrays would compare equal forever. Leaf
 * `history-change` fires on every push and after every move through history.
 */
export function useLeafHistory(leaf: WorkspaceLeaf): {
  canGoBack: boolean;
  canGoForward: boolean;
} {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const ref = leaf.on('history-change', onChange);
      return () => leaf.offref(ref);
    },
    [leaf]
  );
  const canGoBack = useSyncExternalStore(
    subscribe,
    () => leaf.history.backHistory.length > 0
  );
  const canGoForward = useSyncExternalStore(
    subscribe,
    () => leaf.history.forwardHistory.length > 0
  );
  return { canGoBack, canGoForward };
}
