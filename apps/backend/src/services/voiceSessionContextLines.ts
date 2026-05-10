/**
 * Human-readable lines injected into the voice agent system prompt each turn.
 */

/** IANA timezone from the browser (e.g. America/Los_Angeles), when available. */
export function buildVoiceDateTimeContextLine(clientTimeZone?: string | null): string {
  const tz = clientTimeZone?.trim() || "UTC";
  const now = new Date();
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(now);
    return `Current date and time for the user (${tz}): ${formatted}.`;
  } catch {
    const iso = now.toISOString();
    return `Current date and time (UTC): ${iso}.`;
  }
}
