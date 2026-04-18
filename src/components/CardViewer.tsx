import { CardManager } from '#/lib/items/CardManager';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { Component, MarkdownRenderer } from 'obsidian';
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

    const handleLinkClick = (evt: MouseEvent) => {
      const anchor = (evt.target as HTMLElement).closest<HTMLAnchorElement>('a.internal-link[data-href]');
      if (!anchor) return;
      evt.preventDefault();
      evt.stopPropagation();
      void reviewView.app.workspace.openLinkText(anchor.dataset.href!, cardFilePath);
    };
    container.addEventListener('click', handleLinkClick);

    return () => {
      component.unload();
      container.removeEventListener('click', handleLinkClick);
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
