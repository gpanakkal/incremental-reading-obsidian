import { MIDDLE_MOUSE_BUTTON } from '#/lib/extensions/SnippetHighlightExtension';
import { CardManager } from '#/lib/items/CardManager';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { Component, Keymap, MarkdownRenderer } from 'obsidian';
import { useEffect, useRef } from 'react';
import { useReviewContext } from './ReviewContext';

/** Read-only card viewer */
export function CardViewer({
  cardText,
  cardFilePath,
}: {
  cardText: string;
  cardFilePath: string;
}) {
  const { reviewView } = useReviewContext();
  const containerRef = useRef<HTMLDivElement>(null);

  const cls = [
    'markdown-preview-view',
    'markdown-rendered',
    'node-insert-event',
    'is-readable-line-width',
    'is-folding',
    'allow-fold-headings',
    'allow-fold-lists',
    'show-indentation-guide',
  ];

  useEffect(() => {
    if (!containerRef.current) return;

    const splitResult = Obsidian.splitFrontMatter(cardText);
    if (!splitResult) {
      throw new Error('Failed to parse frontmatter from note:\n' + cardText);
    }

    const withAnswerHidden = CardManager.hideAnswer(splitResult.body);
    const component = new Component();
    component.load();
    containerRef.current.empty();
    const container = containerRef.current;
    void MarkdownRenderer.render(
      reviewView.app,
      withAnswerHidden,
      container,
      cardFilePath,
      component
    );

    const linkAt = (evt: MouseEvent) =>
      (evt.target as HTMLElement).closest<HTMLAnchorElement>(
        'a.internal-link[data-href]'
      );
    // Where the modifier keys say, as a link in a note opens: the review tab
    // for a plain click, which shows an item in review, and a new tab, split
    // or window otherwise, which shows the note
    const handleLinkClick = (evt: MouseEvent) => {
      const anchor = linkAt(evt);
      if (!anchor) return;
      evt.preventDefault();
      evt.stopPropagation();
      void reviewView.app.workspace.openLinkText(
        anchor.dataset.href!,
        cardFilePath,
        Keymap.isModEvent(evt)
      );
    };
    // A middle click fires `auxclick` rather than `click`; a right click does
    // too, for the context menu, which is left alone
    const handleAuxClick = (evt: MouseEvent) => {
      if (evt.button === MIDDLE_MOUSE_BUTTON) handleLinkClick(evt);
    };
    // A middle press autoscrolls on Windows and pastes on Linux
    const handleMouseDown = (evt: MouseEvent) => {
      if (evt.button === MIDDLE_MOUSE_BUTTON && linkAt(evt)) {
        evt.preventDefault();
      }
    };
    container.addEventListener('click', handleLinkClick);
    container.addEventListener('auxclick', handleAuxClick);
    container.addEventListener('mousedown', handleMouseDown);

    return () => {
      component.unload();
      container.removeEventListener('click', handleLinkClick);
      container.removeEventListener('auxclick', handleAuxClick);
      container.removeEventListener('mousedown', handleMouseDown);
    };
  }, [cardText, cardFilePath, reviewView.app]);

  return (
    <div className={cls.join(' ')}>
      <div
        ref={containerRef}
        className={'markdown-preview-sizer ir-card-viewer'}
      />
    </div>
  );
}
