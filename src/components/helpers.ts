import { CSS_CLASS_PREFIX } from '#/lib/constants';
import type { EditCoordinates, EditState } from './types';

/** Adds the plugin prefix to each of a space-separated list of classes */
export const prefixedClasses = (classes: string) =>
  classes
    .split(' ')
    .map((cls) => `${CSS_CLASS_PREFIX}-${cls.trim()}`)
    .join(' ');

export function isEditing(state?: EditState): state is EditCoordinates {
  if (!state) return false;
  if (typeof state === 'number') return false;
  return true;
}
