import { TYPE_ICONS } from '#/components/icons/typeIcons';
import type { NoteType } from '#/lib/types';
import { h, render as renderVNode } from 'preact';
import type { ItemTable } from './moved-note-scan';

/** A note's name as the user sees it: its file name, less a `.md`. */
export function noteName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.endsWith('.md') ? file.slice(0, -'.md'.length) : file;
}

/**
 * The kind of item each table holds, as the plugin names it to the user, and
 * as the type its icon and tint are drawn for.
 */
export const KIND_BY_TABLE: Readonly<Record<ItemTable, NoteType>> = {
  article: 'article',
  snippet: 'snippet',
  srs_card: 'card',
};

/**
 * Name the item of `table` whose note is at `path`, under `parent`, as the
 * queue would: its type's icon on its type's tint, then its name, the full
 * path on hover for two notes of the same name. Icon and name sit in one
 * `.ir-item-label`, so the icon stays beside the name's first line when the
 * name wraps.
 * @returns the label
 */
export function appendItemLabel(
  parent: HTMLElement | DocumentFragment,
  path: string,
  table: ItemTable
): HTMLElement {
  const type = KIND_BY_TABLE[table];
  const label = parent.createSpan('ir-item-label');
  const icon = label.createSpan({
    cls: 'ir-item-icon',
    attr: { 'data-type': type },
  });
  renderVNode(h(TYPE_ICONS[type], {}), icon);
  // On the name, never the icon: Obsidian's tooltip handler throws on an SVG
  label.createSpan({
    cls: 'ir-item-name',
    text: noteName(path),
    attr: { 'aria-label': path },
  });
  return label;
}
