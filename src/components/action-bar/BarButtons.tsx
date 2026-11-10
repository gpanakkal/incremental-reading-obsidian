import { setIcon } from 'obsidian';
import { useLayoutEffect, useRef } from 'react';

/**
 * Tooltips use `aria-label` rather than `title` since Obsidian renders its own
 * themed tooltip for aria-labelled elements.
 */
export function ButtonWithIcon({
  children,
  icon,
  handleClick,
  onPointerOver,
  disabled,
  ariaDisabled,
  tooltip,
  id,
  className,
}: React.PropsWithChildren<{
  /**
   * An Obsidian icon id to draw in place of `children`, for a button that
   * shows what a menu entry elsewhere shows.
   */
  icon?: string;
  handleClick: (e: MouseEvent) => Promise<void> | void;
  onPointerOver?: (e: PointerEvent) => void;
  disabled?: boolean;
  /** Marked off but still clickable, for a button whose click explains why. */
  ariaDisabled?: boolean;
  tooltip?: string;
  id?: string;
  className?: string;
}>) {
  const ref = useRef<HTMLButtonElement>(null);
  // Drawn into the button itself, as Obsidian draws its own icon buttons:
  // `setIcon` swaps out the first child, and the button has no other
  useLayoutEffect(() => {
    if (icon && ref.current) setIcon(ref.current, icon);
  }, [icon]);

  return (
    <button
      ref={ref}
      className={withClass('ir-review-button clickable-icon', className)}
      id={id}
      onClick={(e) => void handleClick(e)}
      onPointerOver={onPointerOver}
      aria-label={tooltip}
      aria-disabled={ariaDisabled || undefined}
      disabled={disabled}
    >
      {icon ? null : children}
    </button>
  );
}

export function TextButton({
  children,
  handleClick,
  disabled,
  tooltip,
  id,
}: React.PropsWithChildren<{
  handleClick: (e: MouseEvent) => Promise<void> | void;
  disabled?: boolean;
  tooltip?: string;
  id?: string;
}>) {
  return (
    <button
      className="ir-review-button"
      id={id}
      onClick={(e) => void handleClick(e)}
      aria-label={tooltip}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Separator({ className }: { className?: string } = {}) {
  return (
    <div
      className={withClass('ir-bar-separator', className)}
      role="separator"
      aria-orientation="vertical"
    />
  );
}

function withClass(base: string, extra: string | undefined): string {
  return extra ? `${base} ${extra}` : base;
}
