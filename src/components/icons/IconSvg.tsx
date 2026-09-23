import type { ComponentChildren, SVGAttributes } from 'preact';

export type IconProps = SVGAttributes<SVGSVGElement>;

/**
 * The `<svg>` shell for this plugin's hand-drawn icons.
 *
 * Rendered attributes mirror lucide-react's own output, including the `lucide`
 * class that `styles.css` sizes icons through, so these drop in wherever a
 * Lucide icon does. It intentionally does not import from `lucide-react`:
 * component tests mock that module wholesale (its `useContext` resolves
 * against a second Preact copy), which would leave `createLucideIcon`
 * undefined here.
 *
 * No `aria-label`: icons are unlabelled by design, since their container
 * carries the label (see `queueCellTitles` and `ButtonWithIcon`).
 */
export function IconSvg({
  name,
  children,
  ...props
}: IconProps & { name: string; children: ComponentChildren }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`lucide lucide-${name}`}
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/**
 * The "create" badge in the top-right corner, drawn where Lucide's own
 * `image-plus` and `smile-plus` draw it. Whatever it sits on has to stop ~3
 * units short of it, or the strokes merge at 16-18px.
 */
export function CornerPlus() {
  return (
    <>
      <path d="M16 5h6" />
      <path d="M19 2v6" />
    </>
  );
}
