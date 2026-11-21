import { instantOf } from "@table-craft/desktop/renderer/model/topicRead.js";

const MINUTES_PER_HOUR = 60;
const PAD = 2;
const ISO_DATE_TIME_LENGTH = 19;

/** `UTC+07:00`, `UTC−03:30`, `UTC`: the zone `offsetMinutes` east of UTC names. */
export function zoneLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "\u2212";
  const magnitude = Math.abs(offsetMinutes);
  const hours = String(Math.floor(magnitude / MINUTES_PER_HOUR)).padStart(PAD, "0");
  const minutes = String(magnitude % MINUTES_PER_HOUR).padStart(PAD, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

/** `Local (UTC+07:00)`: what a typed timestamp without a zone is read in, at `at`. */
export function localZoneSuffix(at: Date = new Date()): string {
  return `Local (${zoneLabel(-at.getTimezoneOffset())})`;
}

/** `= 2026-11-21 02:00:00 UTC`: the instant a typed timestamp resolves to; null while it does not read as one. */
export function utcInstantText(typed: string): string | null {
  const iso = instantOf(typed);
  return iso === null ? null : `= ${iso.slice(0, ISO_DATE_TIME_LENGTH).replace("T", " ")} UTC`;
}
