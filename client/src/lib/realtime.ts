import { useEffect, useRef, useState, useCallback } from "react";
import { queryClient } from "./queryClient";
import {
  RealtimeNotification,
  CHANNEL_STATIONS_PUBLIC,
  CHANNEL_OPERATIONAL_STAFF,
  getUserChannel,
  RealtimeEventType,
} from "@shared/realtime";

export type RealtimeEventHandler = (event: RealtimeNotification) => void;

class RealtimeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private channels = new Set<string>();
  private listeners = new Map<string, Set<RealtimeEventHandler>>();
  private anyListeners = new Set<RealtimeEventHandler>();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private isExplicitlyClosed = false;
  private onStatusChangeCallbacks = new Set<(connected: boolean) => void>();

  constructor() {
    const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "localhost:5000";
    this.url = `${protocol}//${host}/ws`;
  }

  public connect(): void {
    if (typeof window === "undefined") return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isExplicitlyClosed = false;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.notifyStatus(true);
        this.startHeartbeat();

        // Re-subscribe to all subscribed channels
        for (const channel of this.channels) {
          this.sendMessage({ type: "subscribe", channel });
        }

        // On reconnect, invalidate operational queries to re-sync with authoritative PostgreSQL
        this.invalidateOperationalQueries();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          // Handle system messages
          if (message.type === "connection_ack" || message.type === "subscribed" || message.type === "unsubscribed" || message.type === "heartbeat") {
            return;
          }

          // Handle operational event notification
          const notification = message as RealtimeNotification;
          if (notification.type && notification.channel) {
            this.handleNotification(notification);
          }
        } catch {
          // Ignore parse errors on raw pings/pongs
        }
      };

      this.ws.onclose = () => {
        this.notifyStatus(false);
        this.stopHeartbeat();
        this.ws = null;
        if (!this.isExplicitlyClosed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        if (this.ws) {
          this.ws.close();
        }
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendMessage({ type: "ping" });
      }
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    // Exponential backoff with jitter: 1s -> 2s -> 4s -> max 30s (+-20% jitter)
    const baseDelay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    const jitter = baseDelay * (0.8 + Math.random() * 0.4);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, jitter);
  }

  public subscribe(channel: string, handler?: RealtimeEventHandler): () => void {
    this.channels.add(channel);

    if (handler) {
      if (!this.listeners.has(channel)) {
        this.listeners.set(channel, new Set());
      }
      this.listeners.get(channel)!.add(handler);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendMessage({ type: "subscribe", channel });
    } else {
      this.connect();
    }

    return () => {
      if (handler && this.listeners.has(channel)) {
        this.listeners.get(channel)!.delete(handler);
      }
    };
  }

  public onAny(handler: RealtimeEventHandler): () => void {
    this.anyListeners.add(handler);
    return () => {
      this.anyListeners.delete(handler);
    };
  }

  public onStatusChange(callback: (connected: boolean) => void): () => void {
    this.onStatusChangeCallbacks.add(callback);
    callback(this.isConnected());
    return () => {
      this.onStatusChangeCallbacks.delete(callback);
    };
  }

  private notifyStatus(connected: boolean): void {
    for (const cb of this.onStatusChangeCallbacks) {
      try {
        cb(connected);
      } catch {}
    }
  }

  public isConnected(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  private handleNotification(notification: RealtimeNotification): void {
    // 1. Notify global listeners
    for (const listener of this.anyListeners) {
      try {
        listener(notification);
      } catch {}
    }

    // 2. Notify channel-specific listeners
    const channelListeners = this.listeners.get(notification.channel);
    if (channelListeners) {
      for (const listener of channelListeners) {
        try {
          listener(notification);
        } catch {}
      }
    }

    // 3. PostgreSQL Authoritative Sync: Invalidate matching TanStack query keys
    this.invalidateQueriesForEvent(notification);
  }

  /**
   * Invalidates TanStack Query caches so the UI fetches fresh, authoritative state from PostgreSQL.
   */
  private invalidateQueriesForEvent(notification: RealtimeNotification): void {
    switch (notification.type) {
      case "station_status_changed":
        queryClient.invalidateQueries({ queryKey: ["/api/stations"] });
        break;

      case "booking_created":
      case "booking_confirmed":
      case "booking_cancelled":
      case "booking_checked_in":
        queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
        queryClient.invalidateQueries({ queryKey: ["/api/stations"] });
        queryClient.invalidateQueries({ queryKey: ["/api/employee/stats"] });
        queryClient.invalidateQueries({ queryKey: ["/api/admin/stats/comprehensive"] });
        break;

      case "session_started":
      case "session_stopped":
        queryClient.invalidateQueries({ queryKey: ["/api/stations"] });
        queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
        queryClient.invalidateQueries({ queryKey: ["/api/employee/stats"] });
        break;

      case "payment_status_changed":
        queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
        queryClient.invalidateQueries({ queryKey: ["/api/employee/stats"] });
        queryClient.invalidateQueries({ queryKey: ["/api/admin/stats/comprehensive"] });
        break;
    }
  }

  private invalidateOperationalQueries(): void {
    queryClient.invalidateQueries({ queryKey: ["/api/stations"] });
    queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
    queryClient.invalidateQueries({ queryKey: ["/api/employee/stats"] });
  }

  private sendMessage(msg: Record<string, any>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public disconnect(): void {
    this.isExplicitlyClosed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const realtimeClient = new RealtimeClient();

/**
 * React hook to listen for real-time operational dashboard updates.
 */
export function useRealtimeUpdates(options?: {
  channels?: string[];
  onEvent?: (event: RealtimeNotification) => void;
  enabled?: boolean;
}) {
  const [isConnected, setIsConnected] = useState(realtimeClient.isConnected());
  const [lastEvent, setLastEvent] = useState<RealtimeNotification | null>(null);
  const onEventRef = useRef(options?.onEvent);
  onEventRef.current = options?.onEvent;

  useEffect(() => {
    if (options?.enabled === false) return;

    // Connect socket
    realtimeClient.connect();

    // Track connection status
    const unsubStatus = realtimeClient.onStatusChange((status) => {
      setIsConnected(status);
    });

    // Listen to channels
    const channels = options?.channels || [CHANNEL_STATIONS_PUBLIC];
    const unsubs: (() => void)[] = [];

    const handleEvent = (event: RealtimeNotification) => {
      setLastEvent(event);
      if (onEventRef.current) {
        onEventRef.current(event);
      }
    };

    for (const channel of channels) {
      unsubs.push(realtimeClient.subscribe(channel, handleEvent));
    }

    return () => {
      unsubStatus();
      unsubs.forEach((unsub) => unsub());
    };
  }, [options?.enabled, JSON.stringify(options?.channels)]);

  return { isConnected, lastEvent };
}
