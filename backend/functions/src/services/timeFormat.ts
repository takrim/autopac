/**
 * Centralised time-formatting helpers. All user-facing timestamps in AutoPac
 * are rendered in Seattle (America/Los_Angeles) local time.
 */
export const DISPLAY_TZ = "America/Los_Angeles";

/** "May 23, 2026, 14:07:31 PDT" — full timestamp with tz abbreviation. */
export function formatSeattleDateTime(d: Date | null | undefined): string {
  if (!d) return "unknown";
  return d.toLocaleString("en-US", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

/** "2026-05-23" — ISO date in Seattle local time. */
export function formatSeattleDate(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find(p => p.type === "year")?.value ?? "0000";
  const m = parts.find(p => p.type === "month")?.value ?? "00";
  const day = parts.find(p => p.type === "day")?.value ?? "00";
  return `${y}-${m}-${day}`;
}

/** "05-23 14:07" — compact MM-DD HH:MM in Seattle, for dense log lists. */
export function formatSeattleShort(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const mo = parts.find(p => p.type === "month")?.value ?? "00";
  const da = parts.find(p => p.type === "day")?.value ?? "00";
  const hr = parts.find(p => p.type === "hour")?.value ?? "00";
  const mi = parts.find(p => p.type === "minute")?.value ?? "00";
  return `${mo}-${da} ${hr}:${mi}`;
}
