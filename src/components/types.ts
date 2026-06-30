import type { getMarkdownController } from '#/lib/obsidian-editor';
import type { ReviewText, SchedulingStrategy } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';

export interface EditCoordinates {
  x: number;
  y: number;
}

export enum EditingState {
  cancel,
  complete,
}

export type EditState = EditCoordinates | EditingState;

export type MarkdownController = ReturnType<typeof getMarkdownController>;

/** For React components rendered inside Obsidian Modals */
export interface SchedulingModalProps {
  plugin: IncrementalReadingPlugin;
  type: ReviewText['data']['type'];
  schedule: {
    intervalDays: number | null;
    priority: number;
  };
  onClose: (
    args: 'cancel' | { strategy: SchedulingStrategy; value: number }
  ) => void;
}

export interface ImportModalProps {
  plugin: IncrementalReadingPlugin;
  schedule: {
    intervalDays: number | null;
    priority: number;
  };
  defaultCopyOnImport: boolean;
  onClose: (
    args:
      | 'cancel'
      | { strategy: SchedulingStrategy; value: number; makeCopy: boolean }
  ) => void;
}
