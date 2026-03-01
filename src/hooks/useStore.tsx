import type { IRPluginState } from '#/lib/store';
import { useSelector } from 'react-redux';

export const useReduxStore = () => {
  return useSelector((state: IRPluginState) => state);
};
