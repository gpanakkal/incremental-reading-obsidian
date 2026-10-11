import type ReviewView from '#/views/ReviewView';
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
 * Put `ranges` on screen in `editor` the way a note tab puts search results
 * or a linked heading there (`highlightSearchMatches`, obsidian.asar 1.13):
 * all flashed, with the cursor at the start of the first, scrolled to the
 * middle.
 *
 * `addHighlights` is undocumented: the editor's `is-flashing` marks,
 * replacing any already there, and with its last argument `true` unfolding
 * whatever fold hides a range, as Obsidian passes it (obsidian.asar 1.13).
 * obsidian-typings has that argument as an `EditorSelection`, wrongly.
 */
export function positionEditor(
  editor: Editor,
  ranges: readonly OffsetRange[]
): void {
  const [first] = ranges;
  if (!first) return;
  const highlighter = editor as unknown as {
    addHighlights(
      ranges: EditorRange[],
      style: 'is-flashing',
      removePrevious: boolean,
      unfold: boolean
    ): void;
  };
  highlighter.addHighlights(
    ranges.map(({ from, to }) => ({
      from: editor.offsetToPos(from),
      to: editor.offsetToPos(to),
    })),
    'is-flashing',
    true,
    true
  );
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
    positionEditor(editor, ranges);
  });
}
