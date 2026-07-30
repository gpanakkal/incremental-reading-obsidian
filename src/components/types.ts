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

export type QueueScheduling =
  | { kind: 'priority'; value: string }
  | { kind: 'fixed-interval'; value: string }
  | { kind: 'srs'; value: QueueCardMemory };

/**
 * The three-factor model state for cards, shown in the scheduling column
 */
export interface QueueCardMemory {
  difficulty: number;
  stability: number;
  retrievability: number | null;
}

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
  /**
   * ID of the item that this item came from. For snippets and cards that is
   * the parent article/snippet's vault path, resolved from the row's `parent`
   * id; for articles it is the note they were imported from, resolved from
   * their `source` frontmatter. Null when there is no such origin.
   */
  parent: string | null;
  scheduling: QueueScheduling;
}

/**
 * Narrows which items `ReviewManager.getQueue` returns and how they are
 * windowed. Everything is optional; an empty subset means the whole due
 * queue.
 */
export type QueueSubset = {
  date?: Date;
  slice?: {
    pageNumber: number;
    entriesPerPage: number;
  };
};

/**
 * One page of the review queue. `totalRows` is the size of the whole subset
 * before slicing, so callers can derive the page count.
 */
export interface QueuePage {
  rows: QueueRow[];
  totalRows: number;
}

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
