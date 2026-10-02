import { createPdfViewer } from '#/lib/pdf/obsidian-pdf';
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
  const hostRef = useRef<HTMLDivElement>(null);
  // Built during the first render, so a missing viewer shows the fallback on
  // the first frame rather than flashing an empty pane. Building loads nothing.
  const [viewer] = useState(() => createPdfViewer(plugin.app));
  const [unsupported, setUnsupported] = useState(false);
  /** The viewer while it is what shows, `null` while the fallback is. */
  const shown = unsupported ? null : viewer;

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

  // The item's file in it, opened afresh whenever it changes on disk, as
  // Obsidian's PDF tab does
  useEffect(() => {
    if (!shown) return;
    let active = true;
    const open = () => {
      void shown.open(item.file).then((result) => {
        if (active && result === 'unsupported') setUnsupported(true);
      });
    };
    const modifyRef = vault.on('modify', (file) => {
      if (file === item.file) open();
    });
    open();
    return () => {
      active = false;
      vault.offref(modifyRef);
    };
  }, [shown, item.file, vault]);

  if (!shown) return <>{fallback}</>;
  return <div className="ir-pdf-article" ref={hostRef} />;
}
