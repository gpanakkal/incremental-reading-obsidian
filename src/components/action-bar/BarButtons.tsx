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
      title={tooltip}
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
      title={tooltip}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
