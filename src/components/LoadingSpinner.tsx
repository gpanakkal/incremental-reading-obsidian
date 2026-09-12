/**
 * Indeterminate loading indicator for any slot that waits on a query.
 *
 * The spinner itself stays invisible for a moment before fading in (see
 * `.ir-spinner` in styles.css), so the sub-frame waits that make up most of
 * this plugin's loading — a warm query settling, a vault read of a file
 * already in Obsidian's cache — pass without flashing a spinner on screen.
 * That delay is CSS, so callers can mount this the instant they start loading
 * instead of each scheduling and tearing down a timer of its own.
 *
 * `role="status"` makes the wrapper a polite live region, and `label` is what
 * assistive tech announces, so it must name what is loading rather than just
 * say "loading". Obsidian also renders `aria-label` as a hover tooltip, which
 * is harmless here: the pointer cannot reach a spinner this short-lived.
 */
export function LoadingSpinner({ label }: { label: string }) {
  return (
    <div className="ir-loading" role="status" aria-label={label}>
      <div className="ir-spinner" />
    </div>
  );
}
