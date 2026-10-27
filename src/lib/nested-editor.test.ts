// @vitest-environment jsdom
import type { EditorView } from '@codemirror/view';
import fc from 'fast-check';
import type { MarkdownFileInfo } from 'obsidian';
import { afterEach, describe, expect, it } from 'vitest';
import { isNestedEditor } from './nested-editor';

// #region HELPERS

/** Classes an ancestor of an editor may carry, CodeMirror's among them. */
const CLASSES = [
  'cm-editor',
  'cm-scroller',
  'cm-content',
  'markdown-source-view',
  'table-cell-wrapper',
  'cm-editor-like',
  'workspace-leaf',
] as const;

/** An element's classes: any subset, in any order. */
const arbClasses = fc.uniqueArray(fc.constantFrom(...CLASSES), {
  maxLength: 3,
});

/**
 * The ancestors above an editor's DOM, outermost first: none (detached, as
 * the cell editor is while Obsidian builds it), or a chain of elements, each
 * with its own classes.
 */
const arbAncestors = fc.array(arbClasses, { maxLength: 6 });

/** Whether the editor's chain is attached to the document. */
const arbAttached = fc.boolean();

/** A fake EditorView: only `dom` is read. */
const makeView = (ancestors: string[][], attached: boolean): EditorView => {
  const dom = document.createElement('div');
  dom.className = 'cm-editor';
  let parent: HTMLElement | null = null;
  for (const classes of ancestors) {
    const el = document.createElement('div');
    el.className = classes.join(' ');
    if (parent) parent.append(el);
    else if (attached) document.body.append(el);
    parent = el;
  }
  parent?.append(dom);
  return { dom } as unknown as EditorView;
};

type OwnerShape = 'none' | 'no-editor' | 'no-cm' | 'self' | 'other' | 'throws';

/** The owner `editorInfoField` holds, in every shape that matters. */
const arbOwner = fc.constantFrom<OwnerShape>(
  'none',
  'no-editor',
  'no-cm',
  'self',
  'other',
  'throws'
);

const makeInfo = (
  shape: OwnerShape,
  view: EditorView
): MarkdownFileInfo | null => {
  switch (shape) {
    case 'none':
      return null;
    case 'no-editor':
      return {} as MarkdownFileInfo;
    case 'no-cm':
      return { editor: {} } as unknown as MarkdownFileInfo;
    case 'self':
      return { editor: { cm: view } } as unknown as MarkdownFileInfo;
    case 'other':
      return {
        editor: { cm: { dom: document.createElement('div') } },
      } as unknown as MarkdownFileInfo;
    case 'throws':
      // As the review tab's owner does before its editor is assigned
      return {
        get editor(): never {
          throw new TypeError('editor is not assigned yet');
        },
      } as unknown as MarkdownFileInfo;
  }
};

// #endregion

afterEach(() => {
  document.body.replaceChildren();
});

describe('isNestedEditor', () => {
  it('is nested exactly when an ancestor is an editor or the owner edits in another one', () => {
    fc.assert(
      fc.property(
        arbAncestors,
        arbAttached,
        arbOwner,
        (ancestors, attached, owner) => {
          document.body.replaceChildren();
          const view = makeView(ancestors, attached);
          const insideEditor = ancestors.some((classes) =>
            classes.includes('cm-editor')
          );
          expect(isNestedEditor(view, makeInfo(owner, view))).toBe(
            insideEditor || owner === 'other'
          );
        }
      )
    );
  });

  it("is nested while still detached, once the owner's editor is another one", () => {
    const view = makeView([], false);
    expect(isNestedEditor(view, makeInfo('other', view))).toBe(true);
  });

  it("is a note's own editor when it is its owner's editor and no editor holds it", () => {
    const view = makeView([['workspace-leaf'], ['markdown-source-view']], true);
    expect(isNestedEditor(view, makeInfo('self', view))).toBe(false);
  });
});
