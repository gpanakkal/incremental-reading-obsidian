import type { TypedUseSelectorHook } from 'react-redux';
import { useSelector, useStore } from 'react-redux';
import { IRPluginState } from '#/lib/store';

/**
 * Subscribes the calling component to state changes and triggers re-renders,
 * but values can become stale in functions defined within the component.
 * Use store.getState() as an escape hatch for current state if needed.
 */
export const useAppSelector: TypedUseSelectorHook<IRPluginState> = useSelector;

export const useAppStore = useStore<IRPluginState>;
