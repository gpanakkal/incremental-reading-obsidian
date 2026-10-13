import { flashRanges } from '#/lib/extensions/ContextFlashExtension';
import type ReviewView from '#/views/ReviewView';
import type { EditorView } from '@codemirror/view';
import {
  resolveSubpath,
  type App,
  type Editor,
  type EditorRange,
  type SubpathResult,
  type TFile,
} from 'obsidian';
import { markEState } from './ephemeral-position';

/** A span of a note's text, as offsets from its start: `from <= to`. */
export type OffsetRange = { from: number; to: number };

/**
 * The spans of a note a link opened it at, in a note `length` long — what the
 * review editor puts on screen in place of where the reader last was. The
 * first is where it goes; all are flashed.
 *
 * Read the way a note tab reads the same ephemeral state
 * (`MarkdownView.setEphemeralState`, obsidian.asar 1.13): a non-empty
 * `subpath` (`#Heading`, `#^block`), resolved in the note, wins, and runs to
 * the end of what it names or else of the note; failing that, the ranges of a
 * `match`, absolute offsets as search, backlinks and Go to context build it.
 * Offsets reported past either end are kept inside the note, since the note
 * can have changed since they were taken.
 *
 * @param resolveSubpath what the subpath names in the note, as Obsidian's
 *   `resolveSubpath` answers it against the note's cache, or `null`
 * @returns none when the state names no place in the note
 */
export function arrivalRanges(
  eState: unknown,
  length: number,
  resolveSubpath: (subpath: string) => SubpathResult | null
): OffsetRange[] {
  if (typeof eState !== 'object' || eState === null) return [];
  const { subpath, match } = eState as Record<string, unknown>;

  if (typeof subpath === 'string' && subpath !== '') {
    const resolved = resolveSubpath(subpath);
    if (resolved) {
      return [
        ordered(resolved.start.offset, resolved.end?.offset ?? length, length),
      ];
    }
  }

  if (typeof match !== 'object' || match === null) return [];
  const { matches } = match as Record<string, unknown>;
  if (!Array.isArray(matches)) return [];
  return matches.flatMap((pair: unknown) => {
    if (!Array.isArray(pair)) return [];
    const [a, b] = pair as unknown[];
    if (typeof a !== 'number' || typeof b !== 'number') return [];
    return [ordered(a, b, length)];
  });
}

/** `a` and `b` kept inside a note `length` long, the lesser first. */
function ordered(a: number, b: number, length: number): OffsetRange {
  const inside = (n: number) => Math.min(Math.max(n, 0), length);
  const [from, to] = [inside(a), inside(b)];
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Resolve a link's subpath in whatever note `file` answers with when asked,
 * as a note tab does, through Obsidian's `resolveSubpath`: nothing for a note
 * the metadata cache has not read.
 */
export function subpathResolver(
  app: App,
  file: () => TFile
): (subpath: string) => SubpathResult | null {
  return (subpath) => {
    const cache = app.metadataCache.getFileCache(file());
    return cache ? resolveSubpath(cache, subpath) : null;
  };
}

/**
 * The class of the highlight {@link positionEditor} has Obsidian put on and
 * take straight back off for a flashed arrival, for the unfolding that comes
 * with it. Nothing styles it, so it shows nothing in the moment it is there,
 * nor afterwards in an editor Obsidian won't take it off of (one not on
 * screen).
 */
export const UNFOLD_CLASS = 'ir-context-unfold';

/** The ephemeral states Go to context opened a snippet's context with. */
const contextFlashes = new WeakSet<object>();

/**
 * Have the review editor flash the place `eState` opens at for a moment (see
 * {@link positionEditor}), as Go to context does a snippet's passage, rather
 * than mark it until the next click.
 */
export function markContextFlash(eState: object): void {
  contextFlashes.add(eState);
}

/** Whether `eState` was marked by {@link markContextFlash}. */
function isContextFlash(eState: unknown): boolean {
  // Answers false for anything that isn't an object, never throwing
  return contextFlashes.has(eState as object);
}

/**
 * Put `ranges` on screen in `editor` the way a note tab puts search results
 * or a linked heading there (`highlightSearchMatches`, obsidian.asar 1.13):
 * all flashed, with the cursor at the start of the first, scrolled to the
 * middle.
 *
 * With `flash`, as for Go to context's snippet passage, they are flashed for
 * a moment instead (see `contextFlashExtension`), unfolded all the same, so
 * that the snippet's own highlight is readable again once the eye has found
 * it.
 *
 * `addHighlights` is undocumented: the editor's highlights of a class,
 * replacing any of it already there, and with its last argument `true`
 * unfolding whatever fold hides a range, as Obsidian passes it (obsidian.asar
 * 1.13); obsidian-typings has that argument as an `EditorSelection`, wrongly.
 * `removeHighlights`, taking a class's highlights off, and `editor.cm`, the
 * editor's CodeMirror view, are undocumented too.
 */
export function positionEditor(
  editor: Editor,
  ranges: readonly OffsetRange[],
  flash = false
): void {
  const [first] = ranges;
  if (!first) return;
  const highlighter = editor as unknown as {
    addHighlights(
      ranges: EditorRange[],
      style: string,
      removePrevious: boolean,
      unfold: boolean
    ): void;
    removeHighlights(style: string): void;
  };
  highlighter.addHighlights(
    ranges.map(({ from, to }) => ({
      from: editor.offsetToPos(from),
      to: editor.offsetToPos(to),
    })),
    flash ? UNFOLD_CLASS : 'is-flashing',
    true,
    true
  );
  if (flash) {
    highlighter.removeHighlights(UNFOLD_CLASS);
    // Nor one an earlier link left in this editor
    highlighter.removeHighlights('is-flashing');
    // obsidian-typings types `cm` against CodeMirror's CommonJS declarations,
    // which TypeScript keeps apart from the ES ones imported here
    flashRanges(editor.cm as unknown as EditorView, ranges);
  }
  const from = editor.offsetToPos(first.from);
  editor.setCursor(from);
  editor.scrollIntoView({ from: editor.offsetToPos(first.to), to: from }, true);
}

/**
 * Keep the review editor showing `itemId` at whatever place in it a link
 * followed in the review tab names — see `ReviewView.onArrival` — for as long
 * as the editor is up; call the returned function as it goes.
 *
 * A place it can't find in the note leaves the editor alone, unmarked, so the
 * reader's last scroll position is restored as it would be otherwise. One it
 * can find marks `owner` — the editor's `editorInfoField` owner, which scroll
 * restore checks — so the restore stands aside for it.
 */
export function positionOnArrival({
  reviewView,
  itemId,
  owner,
  editor,
  resolveSubpath,
}: {
  reviewView: Pick<ReviewView, 'onArrival'>;
  itemId: string;
  owner: object;
  editor: Editor;
  resolveSubpath: (subpath: string) => SubpathResult | null;
}): () => void {
  return reviewView.onArrival(itemId, (eState) => {
    const ranges = arrivalRanges(
      eState,
      editor.getValue().length,
      resolveSubpath
    );
    if (ranges.length === 0) return;
    markEState(owner, eState);
    positionEditor(editor, ranges, isContextFlash(eState));
  });
}
