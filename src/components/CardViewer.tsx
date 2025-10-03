import classcat from 'classcat';
import { Component, MarkdownRenderer } from 'obsidian';
import { useEffect, useRef } from 'react';
import SRSCard from '#/lib/SRSCard';
import { splitFrontMatter } from '#/lib/utils';
import { useReviewContext } from './ReviewContext';

/** Read-only card viewer */
export function CardViewer({ cardText }: { cardText: string }) {
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
    'show-properties',
  ];

  useEffect(() => {
    if (!containerRef.current) return;

    const splitResult = splitFrontMatter(cardText);
    if (!splitResult) {
      throw new Error('Failed to parse frontmatter from note:\n' + cardText);
    }

    const withAnswerHidden = SRSCard.hideAnswer(splitResult.body);
    const component = new Component();
    component.load();
    containerRef.current.empty();
    MarkdownRenderer.render(
      reviewView.app,
      withAnswerHidden,
      containerRef.current,
      '', // source path - empty string for embedded content
      component
    );

    // Cleanup on unmount or when cardText changes
    return () => {
      component.unload();
    };
  }, [cardText, reviewView.app]);

  return <div ref={containerRef} className={classcat(cls)} />;
}
