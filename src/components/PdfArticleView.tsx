import { showPdfItemHighlights } from '#/lib/extensions/PdfItemHighlights';
import {
  createPdfViewer,
  getPdfLocation,
  onPdfViewMove,
  type PdfViewer,
  setPdfPosition,
} from '#/lib/pdf/obsidian-pdf';
import {
  packPdfPosition,
  type PdfPosition,
  pdfPositionSubpath,
  unpackPdfPosition,
} from '#/lib/pdf/position';
import type { ReviewItem } from '#/lib/types';
import type { ComponentChild } from 'preact';
import { useEffect, useRef, useState } from 'react';
import { useReviewContext } from './ReviewContext';

/**
 * How long the view has to rest before where it rests is saved. pdf.js
 * reports a scroll every frame; this saves it once it ends.
 */
const POSITION_SAVE_DELAY_MS = 500;

/**
 * A PDF article in review, in Obsidian's own PDF viewer: toolbar, zoom, find
 * and sidebar as in a PDF tab, with review's action bar above it.
 *
 * Mount it keyed on the item's id: the viewer is built once per mount.
 *
 * Shows `fallback` instead whenever the viewer can't be had: when Obsidian's
 * PDF internals aren't what `obsidian-pdf` knows, found at once or only when
 * the viewer first opens the file.
 *
 * The item opens where its reader stopped, saved as they read, with the
 * passages its snippets were extracted from highlighted.
 */
export function PdfArticleView({
  item,
  fallback,
}: {
  item: ReviewItem;
  fallback: ComponentChild;
}) {
  const { plugin, reviewView } = useReviewContext();
  const { vault } = plugin.app;
  const { reviewManager } = plugin;
  const hostRef = useRef<HTMLDivElement>(null);
  // Built during the first render, so a missing viewer shows the fallback on
  // the first frame rather than flashing an empty pane. Building loads nothing.
  const [viewer] = useState(() => createPdfViewer(plugin.app));
  const [unsupported, setUnsupported] = useState(false);
  /** The viewer while it is what shows, `null` while the fallback is. */
  const shown: PdfViewer | null = unsupported ? null : viewer;

  // The viewer itself, on screen and in charge of the tab's keys while shown
  useEffect(() => {
    const host = hostRef.current;
    if (!shown || !host) return;
    // Attached before anything opens: it opens only once it is on screen
    host.append(shown.containerEl);
    shown.load();
    reviewView.attachPdfViewer(shown);
    return () => {
      reviewView.detachPdfViewer(shown);
      shown.unload();
      shown.containerEl.remove();
    };
  }, [shown, reviewView]);

  // The passages already extracted to snippets or made into cards,
  // highlighted on its pages
  useEffect(() => {
    if (!shown) return;
    return showPdfItemHighlights(plugin, item.file, shown.containerEl);
  }, [shown, item.file, plugin]);

  // The item's file in it, where its reader stopped, opened afresh whenever it
  // changes on disk, as Obsidian's PDF tab does
  useEffect(() => {
    if (!shown) return;
    let active = true;
    const file = item.file;
    // Where the reader is. Carried over when this reruns for a file swapped
    // under the item, or else where the item's row says they stopped, then
    // kept current by the viewer.
    let position: PdfPosition | null = getPdfLocation(shown);
    /** What the item's row holds, as far as this view knows. */
    let stored: number | null = null;
    let saveTimer: number | undefined;

    // Only a position the row doesn't hold yet: opening at the saved one
    // reports it straight back. Each save writes the whole database out.
    const save = () => {
      window.clearTimeout(saveTimer);
      if (!position) return;
      const packed = packPdfPosition(position.page, position.top);
      if (packed === stored) return;
      stored = packed;
      reviewManager.saveScrollPosition(file, packed).catch((error: unknown) => {
        console.warn('Incremental Reading: PDF position not saved', error);
      });
    };
    const moved = (to: PdfPosition) => {
      position = to;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(save, POSITION_SAVE_DELAY_MS);
    };
    const stopWatching = onPdfViewMove(shown, {
      moved,
      // pdf.js moves the view a little when the viewer is resized, as in
      // Obsidian's own PDF tab: put it back where the reader left it, or where
      // it opened, which is no move of the reader's to save
      resized: () => {
        if (position && setPdfPosition(shown, position)) return;
        // It can't be put back: keep where the resize left it, as a move
        const here = getPdfLocation(shown);
        if (here) moved(here);
      },
    });

    const open = (at: string | undefined) => {
      void shown.open(file, at).then((result) => {
        if (active && result === 'unsupported') setUnsupported(true);
      });
    };
    const modifyRef = vault.on('modify', (changed) => {
      if (changed !== file) return;
      // Reopening drops the view to page 1: put it back where it was
      open(position ? pdfPositionSubpath(position) : undefined);
    });

    // Where it opens: where the reader is, carried over, or else where the
    // item's row says they stopped
    const start = position
      ? Promise.resolve(pdfPositionSubpath(position))
      : reviewManager
          .loadScrollPosition(file)
          .catch(() => null)
          .then((saved) => {
            stored = saved;
            position ??= saved === null ? null : unpackPdfPosition(saved);
            return position ? pdfPositionSubpath(position) : undefined;
          });
    void start.then((at) => {
      if (active) open(at);
    });

    return () => {
      active = false;
      vault.offref(modifyRef);
      stopWatching();
      // Left before the view rested long enough to be saved
      save();
    };
  }, [shown, item.file, vault, reviewManager]);

  if (!shown) return <>{fallback}</>;
  return <div className="ir-pdf-article" ref={hostRef} />;
}
