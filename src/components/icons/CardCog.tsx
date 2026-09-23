import { CornerPlus, IconSvg, type IconProps } from './IconSvg';

/**
 * Lucide's 8-spoke gear cluster, reused across `calendar-cog`, `file-cog` and
 * friends, unchanged and centred on (18, 18).
 */
function Gear() {
  return (
    <>
      <path d="m15.228 16.852-.923-.383" />
      <path d="m15.228 19.148-.923.383" />
      <path d="m16.47 14.305.382.923" />
      <path d="m16.852 20.772-.383.924" />
      <path d="m19.148 15.228.383-.923" />
      <path d="m19.53 21.696-.382-.924" />
      <path d="m20.772 16.852.924-.383" />
      <path d="m20.772 19.148.924.383" />
      <circle cx="18" cy="18" r="3" />
    </>
  );
}

/**
 * Flash-card-with-a-gear icon, for the "card" item type.
 *
 * Lucide has no `card-cog`, so this composes one: the card is a portrait
 * rounded rect, and the gear is Lucide's own (see `Gear`).
 *
 * Two details are load-bearing at the 16-18px the queue table and action bar
 * actually render at:
 * - The card is an open path rather than a `<rect>`, stopping short of the
 *   gear on both sides. This is how Lucide itself makes room for a gear
 *   (compare `calendar-cog`, which drops its whole bottom-right quadrant);
 *   drawing the full rect underneath instead leaves the gear sitting in a
 *   closed box.
 * - The card spans x6-18, not the full width. That puts its bottom-right
 *   corner under the gear's centre, so half the gear breaks past the card's
 *   edge instead of reading as noise inside it, and leaves the whole glyph
 *   optically the same size as the `FileText` and `Scissors` it sits beside.
 */
export function CardCog(props: IconProps) {
  return (
    <IconSvg name="card-cog" {...props}>
      <path d="M4 6v12" />
      <path d="M18 13.5V5a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5.5" />
      <Gear />
    </IconSvg>
  );
}

/**
 * `CardCog` with a plus in the corner, for the create-card action, so it
 * reads differently from the type filter's plain `CardCog` beside it.
 *
 * The card's top-right corner gives way to the plus: its top edge stops at
 * x13 and its right edge survives only as the stub between plus and gear.
 */
export function CardCogPlus(props: IconProps) {
  return (
    <IconSvg name="card-cog-plus" {...props}>
      <path d="M4 6v12" />
      <path d="M13 3H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5.5" />
      <path d="M18 11v2.5" />
      <Gear />
      <CornerPlus />
    </IconSvg>
  );
}
