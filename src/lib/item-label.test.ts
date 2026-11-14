// @vitest-environment jsdom
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendItemLabel, KIND_BY_TABLE, noteName } from './item-label';
import { ITEM_TABLES } from './moved-note-scan';

// lucide-react's icons use hooks, which under Vitest resolve against another
// preact instance than the one rendering here (see the react→preact aliasing
// TODO in vitest.config.ts): stand-ins that draw an SVG, as the real ones do
vi.mock('lucide-react', async () => {
  const { h } = await import('preact');
  return {
    FileText: () => h('svg', { 'data-icon': 'file-text' }),
    Scissors: () => h('svg', { 'data-icon': 'scissors' }),
  };
});

// #region HELPERS

/** A part of a vault path: a folder's name or a file's, without a slash. */
const segmentArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((segment) => !segment.includes('/'));

/**
 * A note's path, in a folder or at the root, with an extension or without,
 * and the name the user knows it by: its file name, less a `.md`.
 */
const noteArb = fc
  .record({
    folders: fc.array(segmentArb, { maxLength: 3 }),
    // Ending in `.md`, it would read as a name with one, given none
    file: segmentArb.filter((file) => !file.endsWith('.md')),
    extension: fc.constantFrom('', '.md', '.pdf'),
  })
  .map(({ folders, file, extension }) => ({
    name: extension === '.md' ? file : file + extension,
    path: [...folders, file + extension].join('/'),
  }));

// #endregion

describe('noteName', () => {
  it('property: is the file name, less a .md, wherever the note is', () => {
    fc.assert(
      fc.property(noteArb, ({ name, path }) => {
        expect(noteName(path)).toBe(name);
      })
    );
  });

  it('takes off only a trailing .md', () => {
    expect(noteName('notes/a.md.md')).toBe('a.md');
    expect(noteName('a.mdx')).toBe('a.mdx');
  });
});

describe('appendItemLabel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('property: names the item by its type icon and its note, the path on the name alone', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ITEM_TABLES),
        noteArb,
        (table, { name, path }) => {
          const parent = document.body.createDiv();

          const label = appendItemLabel(parent, path, table);

          expect(label.parentElement).toBe(parent);
          expect(label.classList.contains('ir-item-label')).toBe(true);
          const [icon, nameEl] = [...label.children] as HTMLElement[];
          expect(icon.classList.contains('ir-item-icon')).toBe(true);
          expect(icon.dataset.type).toBe(KIND_BY_TABLE[table]);
          expect(icon.querySelector('svg')).not.toBeNull();
          // Obsidian's tooltip handler throws on an SVG: never labelled
          expect(label.querySelectorAll('[aria-label]')).toHaveLength(1);
          expect(nameEl.classList.contains('ir-item-name')).toBe(true);
          expect(nameEl.textContent).toBe(name);
          expect(nameEl.getAttribute('aria-label')).toBe(path);
        }
      )
    );
  });
});
