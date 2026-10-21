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
 * A PDF article in review, in Obsidian's own PDF viewer: toolbar, zoom, find
 * and sidebar as in a PDF tab, with review's action bar above it.
 *
 * Mount it keyed on the item's id: the viewer is built once per mount.
 *
 * Shows `fallback` instead whenever the viewer can't be had: when Obsidian's
 * PDF internals aren't what `obsidian-pdf` knows, found at once or only when
 * the viewer first opens the file.
 *
 * The item opens where its reader stopped, kept as they read by the plugin's
 * position store (localStorage as they read, the database once the item is
 * left), with the passages its snippets were extracted from highlighted.
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
  const { positions } = plugin;
  const itemId = item.data.id;
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
    // under the item, or else where the store says they stopped, then kept
    // current by the viewer.
    let position: PdfPosition | null = getPdfLocation(shown);
    // This view's hold on the item's position. pdf.js reports a move every
    // frame; the store keeps each in memory and leaves the database alone
    // until the last view on the item lets go. Opening at the saved position
    // reports it straight back, which the store takes for no move.
    const held = positions.open(itemId);
    const moved = (to: PdfPosition) => {
      position = to;
      held.set(packPdfPosition(to.page, to.top));
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

    // A link followed in the review tab to a page or passage of this article
    // — Go to context from one of its snippets — opens it there instead: at
    // once if one was followed before this mounted, else as it is followed.
    let started = false;
    let linkedAt: string | null = null;
    const stopArrivals = reviewView.onArrival(itemId, (eState) => {
      const subpath = (eState as { subpath?: unknown } | null)?.subpath;
      if (typeof subpath !== 'string' || subpath === '') return;
      if (started) open(subpath);
      else linkedAt = subpath;
    });
    started = true;
    const modifyRef = vault.on('modify', (changed) => {
      if (changed !== file) return;
      // Reopening drops the view to page 1: put it back where it was
      open(position ? pdfPositionSubpath(position) : undefined);
    });

    // Where it opens: where a link put it, where the reader is, carried over,
    // or else where the store says they stopped
    const start = linkedAt
      ? Promise.resolve(linkedAt)
      : position
        ? Promise.resolve(pdfPositionSubpath(position))
        : held
            .restore()
            .catch(() => null)
            .then((saved) => {
              position ??= saved === null ? null : unpackPdfPosition(saved);
              return position ? pdfPositionSubpath(position) : undefined;
            });
    void start.then((at) => {
      if (active) open(at);
    });

    return () => {
      active = false;
      stopArrivals();
      vault.offref(modifyRef);
      stopWatching();
      // The last view on the item letting go writes it to the database
      held.close();
    };
  }, [shown, item.file, itemId, reviewView, vault, positions]);

  if (!shown) return <>{fallback}</>;
  return <div className="ir-pdf-article" ref={hostRef} />;
}
