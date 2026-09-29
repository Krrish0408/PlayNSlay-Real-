import { z } from "zod";

/**
 * Play N' Slay — Real-Time Event Types & Channels
 *
 * WebSockets provide push notifications to invalidate client state.
 * PostgreSQL remains the 100% authoritative source of truth.
 */

export const REALTIME_EVENT_TYPES = [
  "booking_created",
  "booking_confirmed",
  "booking_cancelled",
  "booking_checked_in",
  "session_started",
  "session_stopped",
  "station_status_changed",
  "payment_status_changed",
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

// System-level messages
export const SYSTEM_EVENT_TYPES = [
  "connection_ack",
  "heartbeat",
  "subscribed",
  "unsubscribed",
  "error",
] as const;

export type SystemEventType = (typeof SYSTEM_EVENT_TYPES)[number];

// Channel definitions
export const CHANNEL_STATIONS_PUBLIC = "stations:public";
export const CHANNEL_OPERATIONAL_STAFF = "operational:staff";

export function getUserChannel(userId: number | string): string {
  return `user:${userId}`;
}

export function isUserChannel(channel: string): boolean {
  return /^user:\d+$/.test(channel);
}

export function parseUserIdFromChannel(channel: string): number | null {
  const match = channel.match(/^user:(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

// =========================================================================
// Event Payloads (Sanitized - Zero sensitive PII / Secrets)
// =========================================================================

export const BookingCreatedPayloadSchema = z.object({
  bookingId: z.number(),
  userId: z.number(),
  stationId: z.number().nullable().optional(),
  gameTypeId: z.number(),
  startTime: z.string(),
  endTime: z.string(),
  status: z.string(),
});

export const BookingConfirmedPayloadSchema = z.object({
  bookingId: z.number(),
  userId: z.number(),
  stationId: z.number().nullable().optional(),
  status: z.literal("CONFIRMED"),
  confirmedAt: z.string(),
});

export const BookingCancelledPayloadSchema = z.object({
  bookingId: z.number(),
  userId: z.number(),
  status: z.literal("CANCELLED"),
  cancelledAt: z.string(),
  reason: z.string().optional(),
});

export const BookingCheckedInPayloadSchema = z.object({
  bookingId: z.number(),
  userId: z.number(),
  stationId: z.number(),
  checkedInAt: z.string(),
  status: z.string(),
});

export const SessionStartedPayloadSchema = z.object({
  stationId: z.number(),
  stationName: z.string().optional(),
  bookingId: z.number().optional(),
  startedAt: z.string(),
  durationMinutes: z.number().optional(),
});

export const SessionStoppedPayloadSchema = z.object({
  stationId: z.number(),
  stationName: z.string().optional(),
  bookingId: z.number().optional(),
  stoppedAt: z.string(),
});

export const StationStatusChangedPayloadSchema = z.object({
  stationId: z.number(),
  stationName: z.string(),
  gameTypeId: z.number(),
  status: z.string(),
  updatedAt: z.string(),
});

export const PaymentStatusChangedPayloadSchema = z.object({
  paymentId: z.string().or(z.number()),
  bookingId: z.number().optional(),
  userId: z.number(),
  status: z.enum(["PENDING", "COMPLETED", "FAILED", "REFUNDED"]),
  amount: z.number(),
  updatedAt: z.string(),
});

// Comprehensive Notification Schema
export const RealtimeNotificationSchema = z.object({
  eventId: z.string().uuid(),
  type: z.enum(REALTIME_EVENT_TYPES),
  timestamp: z.string(),
  channel: z.string(),
  data: z.record(z.any()),
});

export type RealtimeNotification = z.infer<typeof RealtimeNotificationSchema>;

// Client -> Server incoming message schema
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    channel: z.string().min(1).max(100),
  }),
  z.object({
    type: z.literal("unsubscribe"),
    channel: z.string().min(1).max(100),
  }),
  z.object({
    type: z.literal("ping"),
  }),
  z.object({
    type: z.literal("auth"),
    ticket: z.string().min(1),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// Server -> Client outgoing message schema
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connection_ack"),
    clientId: z.string(),
    authenticated: z.boolean(),
    user: z
      .object({
        id: z.number(),
        username: z.string(),
        role: z.string(),
      })
      .nullable(),
    availableChannels: z.array(z.string()),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("subscribed"),
    channel: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("unsubscribed"),
    channel: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("heartbeat"),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    timestamp: z.string(),
  }),
  // Operational event notification
  z.object({
    type: z.enum(REALTIME_EVENT_TYPES),
    eventId: z.string().uuid(),
    timestamp: z.string(),
    channel: z.string(),
    data: z.record(z.any()),
  }),
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/**
 * Sanitizes an operational event for the public channel (stations:public).
 * Strips any customer names, user IDs, booking IDs, or internal pricing.
 */
export function sanitizeEventForPublic(event: RealtimeNotification): RealtimeNotification | null {
  // Public channel ONLY allows station_status_changed events
  if (event.type === "station_status_changed") {
    return {
      eventId: event.eventId,
      type: "station_status_changed",
      timestamp: event.timestamp,
      channel: CHANNEL_STATIONS_PUBLIC,
      data: {
        stationId: event.data.stationId,
        stationName: event.data.stationName,
        gameTypeId: event.data.gameTypeId,
        status: event.data.status,
        updatedAt: event.data.updatedAt || event.timestamp,
      },
    };
  }
  // No other events may be broadcast on the public channel
  return null;
}

/**
 * Verifies if a user role is authorized to subscribe to a target channel.
 */
export function canSubscribeToChannel(
  channel: string,
  user?: { id: number; role: string } | null
): { allowed: boolean; reason?: string } {
  // Public station channel
  if (channel === CHANNEL_STATIONS_PUBLIC) {
    return { allowed: true };
  }

  // Staff operational channel
  if (channel === CHANNEL_OPERATIONAL_STAFF) {
    if (!user) {
      return { allowed: false, reason: "Authentication required for operational staff channel." };
    }
    if (user.role === "admin" || user.role === "employee") {
      return { allowed: true };
    }
    return { allowed: false, reason: "Forbidden: Staff or admin privilege required." };
  }

  // Personal user channel (e.g. user:123)
  if (isUserChannel(channel)) {
    const targetUserId = parseUserIdFromChannel(channel);
    if (!user) {
      return { allowed: false, reason: "Authentication required for personal channel." };
    }
    // Staff/admins can subscribe to any, user can only subscribe to their own
    if (user.role === "admin" || user.role === "employee" || user.id === targetUserId) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "Forbidden: You cannot subscribe to another user's private notification channel.",
    };
  }

  return { allowed: false, reason: `Unknown or disallowed channel: ${channel}` };
}
