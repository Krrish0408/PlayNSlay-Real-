/**
 * Play N' Slay - Standardized Timezone & Location Architecture
 *
 * Requirements:
 * - Transactional timestamps stored strictly in UTC (epoch milliseconds).
 * - Lounge / Location configured with IANA timezone (default: Asia/Kolkata).
 * - Never rely on server local timezone or client local timezone.
 * - Availability, operating hours, day boundaries, and pricing calculated in the lounge timezone.
 * - Frontend displays dates/times according to the booking location timezone.
 * - Full support for midnight boundaries, date changes, and daylight-saving (DST) locations.
 */

export interface LoungeLocation {
  id: string;
  name: string;
  timezone: string; // Validated IANA timezone
  city: string;
  country: string;
  currency: string;
  openingHour: number; // 0-23 (local time)
  closingHour: number; // 0-23 (local time; if closingHour < openingHour, crosses midnight)
  crossesMidnight: boolean;
}

// Default IANA timezone for Play N' Slay: Asia/Kolkata (IST, UTC+5:30)
export const DEFAULT_LOUNGE_TIMEZONE =
  (typeof process !== "undefined" && process.env?.LOUNGE_TIMEZONE) || "Asia/Kolkata";

export const DEFAULT_LOCATION_ID = "main-lounge";

export const LOUNGE_LOCATIONS: Record<string, LoungeLocation> = {
  "main-lounge": {
    id: "main-lounge",
    name: "Play N' Slay Gaming Lounge (Main)",
    timezone: DEFAULT_LOUNGE_TIMEZONE,
    city: "Mumbai",
    country: "IN",
    currency: "INR",
    openingHour: 10, // 10:00 AM local
    closingHour: 2,  // 02:00 AM local (overnight)
    crossesMidnight: true,
  },
  "ny-lounge": {
    id: "ny-lounge",
    name: "Play N' Slay New York",
    timezone: "America/New_York",
    city: "New York",
    country: "US",
    currency: "USD",
    openingHour: 10,
    closingHour: 2,
    crossesMidnight: true,
  },
  "london-lounge": {
    id: "london-lounge",
    name: "Play N' Slay London",
    timezone: "Europe/London",
    city: "London",
    country: "GB",
    currency: "GBP",
    openingHour: 10,
    closingHour: 2,
    crossesMidnight: true,
  },
  "tokyo-lounge": {
    id: "tokyo-lounge",
    name: "Play N' Slay Tokyo",
    timezone: "Asia/Tokyo",
    city: "Tokyo",
    country: "JP",
    currency: "JPY",
    openingHour: 10,
    closingHour: 2,
    crossesMidnight: true,
  },
};

/**
 * Validates whether a given timezone is a valid IANA timezone identifier.
 */
export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Retrieves location config by ID, falling back to default main lounge.
 */
export function getLocation(locationId?: string | null): LoungeLocation {
  if (locationId && LOUNGE_LOCATIONS[locationId]) {
    return LOUNGE_LOCATIONS[locationId];
  }
  return LOUNGE_LOCATIONS[DEFAULT_LOCATION_ID];
}

/**
 * Returns the effective IANA timezone for a location or default.
 */
export function getLoungeTimezone(locationId?: string | null): string {
  const loc = getLocation(locationId);
  return loc.timezone;
}

/**
 * Extracts zoned date/time parts in the given IANA timezone without depending on server local timezone.
 */
export function getZonedParts(date: Date | string | number, timeZone: string) {
  const d = new Date(date);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date provided to getZonedParts: ${date}`);
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(d);
  const p: Record<string, string> = {};
  for (const part of parts) {
    p[part.type] = part.value;
  }

  let hour = parseInt(p.hour || "0", 10);
  if (hour === 24) hour = 0;

  return {
    year: parseInt(p.year || "1970", 10),
    month: parseInt(p.month || "1", 10),
    day: parseInt(p.day || "1", 10),
    hour,
    minute: parseInt(p.minute || "0", 10),
    second: parseInt(p.second || "0", 10),
  };
}

/**
 * Converts a local calendar date ("YYYY-MM-DD") and time ("HH:mm") in a specific IANA timezone
 * into an absolute UTC Date.
 * Uses exact offset convergence (handles DST jumps and any timezone offset).
 */
export function parseZonedDateTime(
  dateStr: string,
  timeStr: string,
  timeZone: string
): Date {
  const dateMatch = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!dateMatch) {
    throw new Error(`Invalid date format (expected YYYY-MM-DD): "${dateStr}"`);
  }
  const [, yStr, mStr, dStr] = dateMatch;
  const year = parseInt(yStr, 10);
  const month = parseInt(mStr, 10);
  const day = parseInt(dStr, 10);

  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!timeMatch) {
    throw new Error(`Invalid time format (expected HH:mm): "${timeStr}"`);
  }
  const [, hStr, minStr, sStr] = timeMatch;
  const hour = parseInt(hStr, 10);
  const minute = parseInt(minStr, 10);
  const second = sStr ? parseInt(sStr, 10) : 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid hour/minute values: ${timeStr}`);
  }

  // Initial UTC guess
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);

  // Converge up to 4 iterations (handles DST shifts and odd offsets)
  for (let i = 0; i < 4; i++) {
    const d = new Date(utcMs);
    const zoned = getZonedParts(d, timeZone);
    const zonedMs = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
      0
    );
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    const diff = zonedMs - targetMs;
    if (diff === 0) break;
    utcMs -= diff;
  }

  return new Date(utcMs);
}

/**
 * Calculates start of day (midnight 00:00:00.000) for a given date in the target timezone.
 * Returns the exact UTC Date.
 */
export function getStartOfDayInTimezone(date: Date | string | number, timeZone: string): Date {
  const d = new Date(date);
  const parts = getZonedParts(d, timeZone);
  const dateStr = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  return parseZonedDateTime(dateStr, "00:00", timeZone);
}

/**
 * Calculates end of day (23:59:59.999) for a given date in the target timezone.
 * Returns the exact UTC Date.
 */
export function getEndOfDayInTimezone(date: Date | string | number, timeZone: string): Date {
  const startOfDay = getStartOfDayInTimezone(date, timeZone);
  // 1 full day = 86,400,000 ms minus 1 ms
  return new Date(startOfDay.getTime() + 86400000 - 1);
}

/**
 * Builds timezone-aware booking interval with automatic midnight-crossing detection.
 * If endTimeStr is <= startTimeStr (e.g. 23:00 to 01:00), endTime automatically increments to the next day.
 */
export function buildBookingInterval(
  dateStr: string,
  startTimeStr: string,
  endTimeStr: string,
  timeZone: string
): {
  startTime: Date;
  endTime: Date;
  durationHours: number;
  crossesMidnight: boolean;
} {
  const startUtc = parseZonedDateTime(dateStr, startTimeStr, timeZone);

  // Check if endTime indicates crossing midnight (e.g., 23:00 to 01:00 or 02:00)
  const [startH, startM] = startTimeStr.split(":").map(Number);
  const [endH, endM] = endTimeStr.split(":").map(Number);

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  const crossesMidnight = endMinutes <= startMinutes;

  let endUtc: Date;
  if (crossesMidnight) {
    // Next calendar day in target timezone
    const [y, m, d] = dateStr.split("-").map(Number);
    // Add 1 day
    const nextDayDate = new Date(Date.UTC(y, m - 1, d + 1));
    const nextDayStr = `${nextDayDate.getUTCFullYear()}-${String(nextDayDate.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDayDate.getUTCDate()).padStart(2, "0")}`;
    endUtc = parseZonedDateTime(nextDayStr, endTimeStr, timeZone);
  } else {
    endUtc = parseZonedDateTime(dateStr, endTimeStr, timeZone);
  }

  const durationMs = endUtc.getTime() - startUtc.getTime();
  const durationHours = durationMs / (1000 * 60 * 60);

  return {
    startTime: startUtc,
    endTime: endUtc,
    durationHours,
    crossesMidnight,
  };
}

/**
 * Formats a date/timestamp strictly according to the specified lounge timezone.
 */
export function formatInTimezone(
  date: Date | string | number,
  timeZone: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    ...options,
  }).format(d);
}

/**
 * Formats local date in the lounge timezone, e.g. "Monday, September 28, 2026"
 */
export function formatLocalDate(date: Date | string | number, timeZone: string): string {
  return formatInTimezone(date, timeZone, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Formats local time in the lounge timezone, e.g. "06:00 PM"
 */
export function formatLocalTime(date: Date | string | number, timeZone: string): string {
  return formatInTimezone(date, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Formats local date and time with timezone abbreviation, e.g. "Sep 28, 2026, 06:00 PM IST"
 */
export function formatLocalDateTime(date: Date | string | number, timeZone: string): string {
  const dateStr = formatInTimezone(date, timeZone, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const abbr = getTimezoneAbbr(date, timeZone);
  return `${dateStr} ${abbr}`;
}

/**
 * Returns timezone abbreviation for a given date and timezone (e.g. "IST", "EDT", "EST", "BST", "GMT").
 */
export function getTimezoneAbbr(date: Date | string | number, timeZone: string): string {
  const d = new Date(date);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(d);
  const tzPart = parts.find((p) => p.type === "timeZoneName");
  const raw = tzPart ? tzPart.value : timeZone;

  // Enhance offset strings to common canonical abbreviations for known regions
  if (timeZone === "Asia/Kolkata" && (raw === "GMT+5:30" || raw === "UTC+5:30")) {
    return "IST";
  }
  if (timeZone === "Europe/London") {
    if (raw === "GMT+1" || raw === "UTC+1") return "BST";
    if (raw === "GMT" || raw === "UTC") return "GMT";
  }
  return raw;
}
