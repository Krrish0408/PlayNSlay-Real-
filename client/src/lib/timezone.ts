import {
  formatInTimezone,
  formatLocalDate,
  formatLocalTime,
  formatLocalDateTime,
  getTimezoneAbbr,
  getLoungeTimezone,
  getLocation,
  DEFAULT_LOCATION_ID,
  DEFAULT_LOUNGE_TIMEZONE,
  buildBookingInterval,
  getStartOfDayInTimezone,
  getEndOfDayInTimezone,
  parseZonedDateTime,
  type LoungeLocation,
  LOUNGE_LOCATIONS,
} from "@shared/timezone";

export {
  formatInTimezone,
  formatLocalDate,
  formatLocalTime,
  formatLocalDateTime,
  getTimezoneAbbr,
  getLoungeTimezone,
  getLocation,
  DEFAULT_LOCATION_ID,
  DEFAULT_LOUNGE_TIMEZONE,
  buildBookingInterval,
  getStartOfDayInTimezone,
  getEndOfDayInTimezone,
  parseZonedDateTime,
  type LoungeLocation,
  LOUNGE_LOCATIONS,
};

/**
 * Format a booking timestamp to local date in lounge timezone (e.g. "Monday, September 28, 2026")
 */
export function formatLoungeDate(date: Date | string | number, locationId?: string | null): string {
  const tz = getLoungeTimezone(locationId);
  return formatLocalDate(date, tz);
}

/**
 * Format a booking timestamp to local time in lounge timezone (e.g. "06:00 PM")
 */
export function formatLoungeTime(date: Date | string | number, locationId?: string | null): string {
  const tz = getLoungeTimezone(locationId);
  return formatLocalTime(date, tz);
}

/**
 * Format a booking timestamp to full local date and time with timezone abbreviation (e.g. "Sep 28, 2026, 06:00 PM IST")
 */
export function formatLoungeDateTime(date: Date | string | number, locationId?: string | null): string {
  const tz = getLoungeTimezone(locationId);
  return formatLocalDateTime(date, tz);
}
