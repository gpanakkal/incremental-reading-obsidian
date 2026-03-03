import type { IRPluginState } from '#/lib/store';
import { useSelector } from 'react-redux';

/**
 * Subscribes the calling component to state changes and triggers re-renders,
 * but values can become stale. Use store.getState() as an escape hatch for
 * current state if needed.
 */
export const useReduxStore = () => {
  return useSelector((state: IRPluginState) => state);
};
