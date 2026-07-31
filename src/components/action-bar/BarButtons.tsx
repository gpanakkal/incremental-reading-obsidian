/**
 * Tooltips use `aria-label` rather than `title` since Obsidian renders its own
 * themed tooltip for aria-labelled elements.
 */
export function ButtonWithIcon({
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
      className="ir-review-button clickable-icon"
      id={id}
      onClick={(e) => void handleClick(e)}
      aria-label={tooltip}
      disabled={disabled}
    >
      {children}
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

export function Separator() {
  return (
    <div
      className="ir-bar-separator"
      role="separator"
      aria-orientation="vertical"
    />
  );
}
