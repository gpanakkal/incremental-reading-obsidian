import type { NoteType } from '#/lib/types';
import { FileText, Scissors } from 'lucide-react';
import type { ComponentType } from 'preact';
import { CardCog } from './CardCog';

/**
 * The glyph standing for each item type, wherever one is drawn — the queue
 * table's type column and the action bar's type filter both read it here so
 * the two cannot drift apart.
 *
 * None of them carries an `aria-label`: the element wrapping the icon is what
 * gets labelled, since a label on the SVG renders a second tooltip inside the
 * container's own (and crashes Obsidian's tooltip handler besides).
 */
export const TYPE_ICONS: Record<NoteType, ComponentType> = {
  article: FileText,
  snippet: Scissors,
  card: CardCog,
};
