import { IconSvg, type IconProps } from './IconSvg';

/**
 * Lucide's `files` (two stacked sheets) with a plus in the bottom-right
 * corner, for the bulk-import action. Lucide has no stacked-sheets-plus glyph.
 *
 * The plus is the size of `CornerPlus`, centred on (19, 19). As there, the
 * sheets stop ~3 units short of it so the strokes don't merge at 16-18px: the
 * front sheet loses its bottom-right corner (right edge stops at y13, bottom
 * edge at x13), and the back sheet's bottom edge stops at x13 instead of
 * curving up behind the front one. The fold is Lucide's path data unchanged.
 */
export function FilesPlus(props: IconProps) {
  return (
    <IconSvg name="files-plus" {...props}>
      <path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2" />
      <path d="M21 8v5" />
      <path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z" />
      <path d="M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8" />
      <path d="M16 19h6" />
      <path d="M19 16v6" />
    </IconSvg>
  );
}
