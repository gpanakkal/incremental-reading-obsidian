import { CornerPlus, IconSvg, type IconProps } from './IconSvg';

/**
 * Lucide's `scissors` with a plus in the corner, for the extract-snippet
 * action, so it reads differently from the type filter's plain `Scissors`
 * beside it.
 *
 * The upper blade normally runs out to (20, 4), straight through the plus, so
 * it stops at (15, 9) instead. Everything else is Lucide's path data
 * unchanged.
 */
export function ScissorsPlus(props: IconProps) {
  return (
    <IconSvg name="scissors-plus" {...props}>
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12 12 12" />
      <path d="M15 9 8.12 15.88" />
      <circle cx="6" cy="18" r="3" />
      <path d="M14.8 14.8 20 20" />
      <CornerPlus />
    </IconSvg>
  );
}
