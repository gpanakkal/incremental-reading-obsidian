import type { getMarkdownController } from '#/lib/obsidian-editor';
import type { NoteType, ReviewText, SchedulingStrategy } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import type { TFile } from 'obsidian';

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

/**
 * How an item is scheduled, for display in the review queue.
 * - `priority`: non-SRS items scheduled by priority (snippets always; articles
 *   without a fixed interval).
 * - `fixed-interval`: articles with a `fixed_interval_days` set.
 * - `none`: SRS cards, which are scheduled by the FSRS algorithm.
 */
export type QueueScheduling =
  | { kind: 'priority'; value: string }
  | { kind: 'fixed-interval'; value: string }
  | { kind: 'none'; value: null };

/**
 * A unified, redacted view of a review-queue item. Internal/sensitive columns
 * (`due_fuzz`, `scroll_top`, `start_offset`, `end_offset`, `dismissed`,
 * `deleted`) are intentionally omitted at this boundary — they must never be
 * rendered as queue columns. `id` and `file` are kept for keys, actions, and
 * navigation, but are not rendered as columns.
 */
export interface QueueRow {
  id: string;
  type: NoteType;
  file: TFile;
  /**
   * The fuzzed due date (`due + due_fuzz`); cards have no fuzz (treated as 0).
   * Null when the row has no due time — never coerce that to the epoch.
   */
  due: Date | null;
  reference: string;
  scheduling: QueueScheduling;
}

/**
 * Selects which items `ReviewManager.getQueue` returns. Shaped as a
 * discriminated union so `dismissed`/`deleted` subsets can be added later
 * without changing the method signature.
 */
export type QueueSubset = { kind: 'due'; date?: Date };

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
