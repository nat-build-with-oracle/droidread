// time.ts — turn Messenger's separator labels into real timestamps.
//
// GROUND TRUTH (probed live, SM-A146P, Sept 2026 build). A conversation carries centred
// divider nodes whose text and content-desc are identical, in exactly three shapes:
//
//   "02:34"             today
//   "FRI AT 14:29"      within the last week
//   "17 SEPT AT 12:06"  older than a week
//
// The divider sits ABOVE the cluster it applies to, and every message below it shares
// that timestamp until the next divider. So resolution is CLUSTER-granular, not
// per-message: several messages genuinely carry the same time. Messenger exposes no
// finer signal without double-tapping each message individually.
//
// Relative labels ("FRI", a bare time) only mean anything relative to WHEN THEY WERE
// READ, so the raw string is always stored alongside the resolved value — a resolution
// made today cannot be recomputed correctly next week from the label alone.

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const BARE_TIME = /^(\d{1,2}):(\d{2})$/;
const DOW_TIME = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+at\s+(\d{1,2}):(\d{2})$/i;
const DATE_TIME = /^(\d{1,2})\s+([a-z]+)\s+at\s+(\d{1,2}):(\d{2})$/i;

/** True if s looks like one of Messenger's divider labels. */
export function isSeparatorLabel(s: string): boolean {
  const t = s.trim();
  return BARE_TIME.test(t) || DOW_TIME.test(t) || DATE_TIME.test(t);
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;

/**
 * Resolve a divider label to a local timestamp, relative to `now`.
 * Returns null for anything that does not match a known shape — never a guess.
 */
export function resolveSeparator(label: string, now = new Date()): string | null {
  const t = label.trim();

  const bare = BARE_TIME.exec(t);
  if (bare) {
    const d = new Date(now);
    d.setHours(+bare[1]!, +bare[2]!, 0, 0);
    // A bare time means today. If that lands in the future, the clock moved between
    // the message arriving and us reading it — clamp to yesterday rather than invent
    // a timestamp that has not happened yet.
    if (d.getTime() > now.getTime() + 60_000) d.setDate(d.getDate() - 1);
    return iso(d);
  }

  const dow = DOW_TIME.exec(t);
  if (dow) {
    const want = DOW[dow[1]!.slice(0, 3).toLowerCase()]!;
    const d = new Date(now);
    d.setHours(+dow[2]!, +dow[3]!, 0, 0);
    // Walk back to the most recent occurrence of that weekday, up to 7 days.
    let delta = (d.getDay() - want + 7) % 7;
    if (delta === 0 && d.getTime() > now.getTime()) delta = 7;
    d.setDate(d.getDate() - delta);
    return iso(d);
  }

  const dt = DATE_TIME.exec(t);
  if (dt) {
    const mon = MONTHS[dt[2]!.toLowerCase()];
    if (mon === undefined) return null;
    const d = new Date(now.getFullYear(), mon, +dt[1]!, +dt[3]!, +dt[4]!, 0, 0);
    // No year in the label. A date in the future means it belongs to last year.
    if (d.getTime() > now.getTime() + 86_400_000) d.setFullYear(d.getFullYear() - 1);
    return iso(d);
  }

  return null;
}
