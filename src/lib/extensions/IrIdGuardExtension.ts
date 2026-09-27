import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from '#/lib/constants';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import {
  EditorState,
  type Extension,
  type Line,
  type Text,
  type Transaction,
} from '@codemirror/state';
import { getFrontMatterInfo } from 'obsidian';
import { irPluginFacet } from './irPluginFacet';
import { isExternalSync } from './SnippetHighlightExtension';

/**
 * CodeMirror extension that refuses user edits to the `ir-id` frontmatter entry
 * of this plugin's notes.
 *
 * `ir-id` is the identity pointer from a note to its database row: rewriting it
 * by hand detaches the note from its item (or, worse, points it at somebody
 * else's row), and nothing in the note body can put that back. Every other
 * frontmatter entry — tags, source, the user's own properties — stays editable.
 *
 * Obsidian has a guard of its own over the raw YAML region, but only in live
 * preview with `propertiesInDocument !== 'source'`: it lives in the lazily built
 * properties extension, which is only constructed while live preview is on, and
 * `toggleSource` reconfigures just the dynamic half of the compartment. Source
 * mode and raw-YAML mode are therefore unguarded, which is what this extension
 * covers.
 */

/** A frontmatter fence: `---` alone on its line. */
const FENCE = /^---\r?$/;

/** Length of the fence text itself, excluding any line break. */
const FENCE_LENGTH = 3;

/**
 * The `ir-id` entry at the head of a frontmatter line, with or without YAML
 * quoting around the key. Anchored at the line start and terminated by the
 * colon, so a key that merely contains the name (`my-ir-id:`, `ir-id-old:`)
 * never matches.
 *
 * Leading whitespace is tolerated: an indented `ir-id` is either a nested key
 * inside somebody else's mapping or malformed YAML that Obsidian's parser may
 * still read an id out of, and guarding one entry too many costs less than
 * leaving a live pointer editable.
 */
const ID_ENTRY = /^[ \t]*(?:ir-id|'ir-id'|"ir-id")[ \t]*:/;

/** Tags that mark a note as one of this plugin's items. */
const ITEM_TAGS: readonly string[] = [ARTICLE_TAG, SNIPPET_TAG, CARD_TAG];

/**
 * Shown when an edit to `ir-id` is refused, by the plugin's
 * `irIdLockedWarning`.
 */
export const IR_ID_LOCKED_NOTICE =
  'ir-id links this note to its Incremental Reading item and cannot be edited.';

/**
 * Width of a line's leading indentation, in characters. A line holding nothing
 * but whitespace counts as indentation all the way to its end, which is how
 * {@link entryEnd} recognises a blank line. A trailing CR counts as whitespace:
 * a document built with a `\n` line separator keeps it in the line's text.
 */
function indentWidth(text: string): number {
  const firstContent = text.search(/[^ \t\r]/);
  return firstContent === -1 ? text.length : firstContent;
}

/** The first line after line 1 that is a fence, or null when there is none. */
function findClosingFence(doc: Text): Line | null {
  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (FENCE.test(line.text)) return line;
  }
  return null;
}

/**
 * The end of the entry starting on `entry`, covering a value that continues onto
 * later lines — a block scalar, a nested mapping or sequence, a wrapped flow
 * collection. Every such continuation is indented deeper than its key, so the
 * entry ends at the last line that is.
 */
function entryEnd(doc: Text, entry: Line, lastLine: number): number {
  const indent = indentWidth(entry.text);
  let end = entry.to;
  for (let n = entry.number + 1; n <= lastLine; n++) {
    const line = doc.line(n);
    const lineIndent = indentWidth(line.text);
    // A blank line can sit inside a block scalar, so it does not end the entry;
    // it only belongs to the entry if a more-indented line follows, which is why
    // it moves nothing by itself and trailing blanks stay outside.
    if (lineIndent === line.text.length) continue;
    if (lineIndent <= indent) break;
    end = line.to;
  }
  return end;
}

/**
 * The span of `doc` holding the `ir-id` frontmatter entry, or null when the
 * document has no frontmatter block or no such entry.
 *
 * The span reaches one character past the entry on each side, over the line
 * break before it and the one after it, so that joining the entry onto a
 * neighbouring line — Delete at the end of the line above, Backspace at the
 * start of the line below — is refused along with edits inside it. Positions are
 * document offsets.
 */
export function irIdProtectedRange(
  doc: Text
): readonly [number, number] | null {
  // Bail before walking the rest of the document: a frontmatter block opens on
  // the very first line, so a document whose first character cannot begin a fence
  // has none at all. Whether what is there really opens a block is Obsidian's
  // parser's call, below.
  if (doc.sliceString(0, 1) !== '-') return null;

  const closing = findClosingFence(doc);
  if (!closing) return null;

  // Hand Obsidian's own parser the block and nothing else, so a long article is
  // never copied per keystroke. Slicing to the end of the fence text rather than
  // the end of its line keeps a stray CR out, which its closing-fence pattern
  // would not match at the end of a string.
  const info = getFrontMatterInfo(
    doc.sliceString(0, closing.from + FENCE_LENGTH)
  );
  if (!info.exists) return null;

  const firstLine = doc.lineAt(info.from).number;
  // `info.to` is the offset of the closing fence, so the character before it is
  // the line break ending the last entry.
  const lastLine = doc.lineAt(info.to - 1).number;

  // An empty block has no entry lines between its fences, so `lastLine` lands on
  // the opening one and this walk does not run.
  for (let n = firstLine; n <= lastLine; n++) {
    const line = doc.line(n);
    if (!ID_ENTRY.test(line.text)) continue;
    // Both line breaks exist to reach over: the entry sits below the opening
    // fence, and the closing fence sits below the line `entryEnd` returns.
    return [line.from - 1, entryEnd(doc, line, lastLine) + 1];
  }
  return null;
}

/**
 * Whether the editor's file is one of this plugin's item notes.
 *
 * Same criterion as `ObsidianHelpers.getNoteType` — an `ir-article`,
 * `ir-text-snippet` or `ir-card` tag — but read off the metadata cache, because
 * a change filter has to answer synchronously and `getNoteType` goes through the
 * asynchronous `processFrontMatter`. A cache that has not caught up with a tag
 * written moments ago only leaves the guard off for that moment, and the write
 * that put the tag there is exempt anyway.
 */
function isItemNote(state: EditorState): boolean {
  const { info } = Obsidian.getFileInfoFromState(state);
  if (!info?.file || !info.app) return false;
  const cached: unknown = Obsidian.getFrontMatter(info.file, info.app)?.tags;
  // `getFrontMatter` hands back an array, but a lone tag sits in the cache as a
  // bare string, and a YAML tag need not be a string at all.
  const tags: unknown[] = Array.isArray(cached) ? cached : [cached];
  return tags.some((tag) => typeof tag === 'string' && ITEM_TAGS.includes(tag));
}

/**
 * Whether a transaction's changes reach into `[from, to)`.
 *
 * An insertion exactly at either boundary is legitimate — a line typed at the
 * end of the entry above, or at the start of the entry below — so only an
 * insertion strictly inside counts. Changes are iterated individually: merged
 * ranges would report an insertion next to a deletion as one span.
 */
function touchesRange(tr: Transaction, from: number, to: number): boolean {
  let touches = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    touches ||=
      fromA === toA ? fromA > from && fromA < to : fromA < to && toA > from;
  }, true);
  return touches;
}

/**
 * Explain a refusal.
 *
 * A dropped transaction is otherwise invisible: the keystroke, or the paste,
 * simply does nothing. Raising the notice from inside a change filter is a side
 * effect during filtering, but it touches no editor state and runs only on the
 * transactions that are refused.
 *
 * The plugin's warning is called once per refusal and folds a held key's
 * repeats into the one notice. Reached through the facet rather than held here,
 * so nothing outlives the plugin; an editor without the plugin on its state, or
 * one refusing before the warning exists, refuses without a word rather than
 * letting the edit through.
 */
function notifyRefusal(state: EditorState): void {
  state.facet(irPluginFacet)?.irIdLockedWarning?.warn();
}

/**
 * Change filter refusing edits that reach the `ir-id` entry.
 *
 * The whole transaction is refused rather than the offending range alone.
 * Returning ranges lets CodeMirror split a change that straddles the range —
 * `ChangeSet.filter` keeps the protected section and applies the rest — so
 * select-all-and-type would delete the fences and every other entry while
 * leaving the `ir-id` line stranded in the body: the pointer survives in text
 * that is no longer frontmatter, which is the state this guard exists to
 * prevent. Refusing everything keeps the note consistent, and the notice keeps
 * the refusal legible.
 */
export const irIdGuardExtension: Extension = EditorState.changeFilter.of(
  (tr) => {
    if (!tr.docChanged) return true;
    // Not the user editing here. Obsidian pushes an external file change into an
    // open editor as a minimal line diff tagged `userEvent: "set"`, and IREditor
    // re-syncs its `value` prop under `isExternalSync`. This plugin's own
    // frontmatter writes come back through the former, so refusing it would
    // block the very writes that set and repair `ir-id`.
    if (tr.isUserEvent('set') || tr.annotation(isExternalSync)) return true;
    if (!isItemNote(tr.startState)) return true;

    const range = irIdProtectedRange(tr.startState.doc);
    if (!range || !touchesRange(tr, range[0], range[1])) return true;

    notifyRefusal(tr.startState);
    return false;
  }
);
