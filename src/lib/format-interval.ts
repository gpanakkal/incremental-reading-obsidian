const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_YEAR = 365 * MS_PER_DAY;
const MS_PER_MONTH = MS_PER_YEAR / 12;

/**
 * A duration as a grade button shows it: one count in the largest unit that
 * keeps it at 1 or more — `<1m`, `10m`, `3h`, `4d`, `2mo`, `1.2y`.
 *
 * Each unit rounds to the nearest whole one, years to a tenth, and a count that
 * rounds up to a whole next unit is shown in that unit instead (59.5 minutes
 * is `1h`, never `60m`). Months are a twelfth of a year, so the last month a
 * label shows (`11mo`) is shorter than the first year (`1y`), as `23h` is than
 * `1d`: a longer duration never reads as a shorter one.
 *
 * Anything under half a minute, and any negative or NaN duration — a due date
 * already passed — is `<1m`.
 */
export function formatInterval(ms: number): string {
  const minutes = Math.round(ms / MS_PER_MINUTE);
  if (!(minutes >= 1)) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.round(ms / MS_PER_HOUR);
  if (hours < 24) return `${hours}h`;

  const days = Math.round(ms / MS_PER_DAY);
  if (days < 30) return `${days}d`;

  const months = Math.round(ms / MS_PER_MONTH);
  if (months < 12) return `${months}mo`;

  // `String` drops a trailing `.0`, so a whole number of years reads `1y`
  return `${String(Math.round((ms / MS_PER_YEAR) * 10) / 10)}y`;
}
