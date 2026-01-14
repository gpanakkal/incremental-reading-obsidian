import { editorInfoField } from 'obsidian';
import type { EditorState } from '@codemirror/state';
import type { App, TFile } from 'obsidian';
import { ARTICLE_TAG, SNIPPET_TAG, CARD_TAG } from '#/lib/constants';

export type IRNoteType = 'article' | 'snippet' | 'card';

/**
 * Get the file associated with the current editor state.
 * Returns null if no file is associated (e.g., in a new unsaved buffer).
 */
export function getFileFromState(state: EditorState): TFile | null {
  const info = state.field(editorInfoField, false);
  return info?.file ?? null;
}

/**
 * Get the app instance from the current editor state.
 * Returns null if not available.
 */
export function getAppFromState(state: EditorState): App | null {
  const info = state.field(editorInfoField, false);
  return info?.app ?? null;
}

/**
 * Determine the IR note type from frontmatter tags.
 * Returns null if the file doesn't have any IR tags.
 */
export function getIRNoteType(app: App, file: TFile): IRNoteType | null {
  const cache = app.metadataCache.getFileCache(file);
  const tags = cache?.frontmatter?.tags;
  if (!tags) return null;

  const tagSet = new Set(Array.isArray(tags) ? tags : [tags]);

  if (tagSet.has(ARTICLE_TAG)) return 'article';
  if (tagSet.has(SNIPPET_TAG)) return 'snippet';
  if (tagSet.has(CARD_TAG)) return 'card';

  return null;
}

/**
 * Check if a file is an IR note (has any ir-* tag).
 */
export function isIRNote(app: App, file: TFile): boolean {
  return getIRNoteType(app, file) !== null;
}

/**
 * Get IR note type directly from editor state.
 * Convenience function combining getFileFromState and getIRNoteType.
 */
export function getIRNoteTypeFromState(state: EditorState): IRNoteType | null {
  const app = getAppFromState(state);
  const file = getFileFromState(state);
  if (!app || !file) return null;
  return getIRNoteType(app, file);
}
