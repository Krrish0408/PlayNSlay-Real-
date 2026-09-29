import { Server, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import {
  RealtimeNotification,
  RealtimeNotificationSchema,
  RealtimeEventType,
  ClientMessageSchema,
  ServerMessage,
  CHANNEL_STATIONS_PUBLIC,
  CHANNEL_OPERATIONAL_STAFF,
  getUserChannel,
  canSubscribeToChannel,
  sanitizeEventForPublic,
} from "@shared/realtime";
import { storage } from "./storage";
import { User } from "@shared/schema";
import { logger, metrics } from "./observability";
import { COOKIE_NAME } from "./session-service";
import { realtimePubSub } from "./realtime-pubsub";

// Connection Limits
export const MAX_GLOBAL_CONNECTIONS = 5000;
export const MAX_CONNECTIONS_PER_IP = 20;
export const MAX_CONNECTIONS_PER_USER = 5;

// Backpressure Thresholds (in bytes)
export const BUFFERED_AMOUNT_WARNING = 64 * 1024; // 64 KB
export const BUFFERED_AMOUNT_MAX = 256 * 1024;    // 256 KB

// Heartbeat Interval
export const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

export interface AuthenticatedClient {
  id: string;
  ws: WebSocket;
  ip: string;
  user: { id: number; username: string; role: string } | null;
  channels: Set<string>;
  isAlive: boolean;
  connectedAt: number;
}

// In-memory ticket store for single-use WebSocket connection tickets (60s TTL)
const ticketStore = new Map<string, { user: { id: number; username: string; role: string }; expiresAt: number }>();

export function issueRealtimeTicket(user: User): string {
  const ticket = `rt_tkt_${crypto.randomBytes(24).toString("hex")}`;
  ticketStore.set(ticket, {
    user: { id: user.id, username: user.username, role: user.role },
    expiresAt: Date.now() + 60 * 1000,
  });
  return ticket;
}

export function consumeRealtimeTicket(ticket: string): { id: number; username: string; role: string } | null {
  const item = ticketStore.get(ticket);
  if (!item) return null;
  ticketStore.delete(ticket);
  if (Date.now() > item.expiresAt) return null;
  return item.user;
}

// Clean up expired tickets periodically
const ticketCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of ticketStore.entries()) {
    if (now > value.expiresAt) ticketStore.delete(key);
  }
}, 60000);
ticketCleanupTimer.unref();

export class RealtimeManager {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, AuthenticatedClient>();
  private ipConnectionCounts = new Map<string, number>();
  private userConnectionCounts = new Map<number, number>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isListeningToPubSub = false;

  public initialize(httpServer: Server, wsPath = "/ws"): WebSocketServer {
    if (this.wss) return this.wss;

    this.wss = new WebSocketServer({
      noServer: true, // Handle upgrade manually for auth and connection limits
    });

    // Handle HTTP upgrade manually to enforce authentication and connection limits before opening socket
    httpServer.on("upgrade", async (req, socket, head) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== wsPath) {
        return; // Let other upgrade handlers handle if any
      }

      const clientIp = this.getClientIp(req);

      // 1. Enforce Global Connection Limit
      if (this.clients.size >= MAX_GLOBAL_CONNECTIONS) {
        logger.warn({ activeConnections: this.clients.size }, "[WS] Global connection limit reached. Rejecting upgrade.");
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      // 2. Enforce Per-IP Connection Limit
      const currentIpCount = this.ipConnectionCounts.get(clientIp) || 0;
      if (currentIpCount >= MAX_CONNECTIONS_PER_IP) {
        logger.warn({ clientIp, currentIpCount }, "[WS] Per-IP connection limit reached. Rejecting upgrade.");
        socket.write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n");
        socket.destroy();
        return;
      }

      // 3. Resolve user identity from cookie or ticket
      const user = await this.authenticateUpgradeRequest(req, url);

      // 4. Enforce Per-User Connection Limit if authenticated
      if (user) {
        const currentUserCount = this.userConnectionCounts.get(user.id) || 0;
        if (currentUserCount >= MAX_CONNECTIONS_PER_USER) {
          logger.warn({ userId: user.id, currentUserCount }, "[WS] Per-User connection limit reached. Rejecting upgrade.");
          socket.write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n");
          socket.destroy();
          return;
        }
      }

      // Upgrade connection
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req, user, clientIp);
      });
    });

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage, initialUser?: any, clientIp?: string) => {
      const ip = clientIp || this.getClientIp(req);
      const clientId = `ws_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

      const client: AuthenticatedClient = {
        id: clientId,
        ws,
        ip,
        user: initialUser || null,
        channels: new Set<string>(),
        isAlive: true,
        connectedAt: Date.now(),
      };

      this.registerClient(client);

      // Send initial connection acknowledgement with available channels
      const availableChannels = [CHANNEL_STATIONS_PUBLIC];
      if (client.user?.role === "admin" || client.user?.role === "employee") {
        availableChannels.push(CHANNEL_OPERATIONAL_STAFF);
      }
      if (client.user?.id) {
        availableChannels.push(getUserChannel(client.user.id));
      }

      this.sendToClient(client, {
        type: "connection_ack",
        clientId,
        authenticated: Boolean(client.user),
        user: client.user,
        availableChannels,
        timestamp: new Date().toISOString(),
      });

      // Automatically subscribe authenticated user to their personal notification channel
      if (client.user?.id) {
        client.channels.add(getUserChannel(client.user.id));
      }

      // Automatically subscribe staff to operational staff channel
      if (client.user?.role === "admin" || client.user?.role === "employee") {
        client.channels.add(CHANNEL_OPERATIONAL_STAFF);
      }

      // Always subscribe to public station status by default
      client.channels.add(CHANNEL_STATIONS_PUBLIC);

      // Handle incoming client messages
      ws.on("message", async (data) => {
        await this.handleClientMessage(client, data);
      });

      // Handle pong for heartbeat
      ws.on("pong", () => {
        client.isAlive = true;
      });

      // Handle connection close
      ws.on("close", () => {
        this.unregisterClient(client);
      });

      // Handle connection error
      ws.on("error", (err) => {
        logger.warn({ clientId, error: err.message }, "[WS] Client connection error");
        this.unregisterClient(client);
      });
    });

    // Start server heartbeat monitor
    this.startHeartbeat();

    // Attach to distributed Pub/Sub bus
    if (!this.isListeningToPubSub) {
      realtimePubSub.initialize().then(() => {
        realtimePubSub.onEvent((event) => {
          this.distributeEventToLocalClients(event);
        });
        this.isListeningToPubSub = true;
      });
    }

    logger.info({ path: wsPath }, "[WS] Scalable Realtime WebSocket Manager initialized.");
    return this.wss;
  }

  /**
   * Registers client in connection maps and metrics.
   */
  private registerClient(client: AuthenticatedClient): void {
    this.clients.set(client.id, client);
    this.ipConnectionCounts.set(client.ip, (this.ipConnectionCounts.get(client.ip) || 0) + 1);

    if (client.user?.id) {
      this.userConnectionCounts.set(client.user.id, (this.userConnectionCounts.get(client.user.id) || 0) + 1);
    }

    metrics.setWebSocketConnections(this.clients.size);
    logger.debug(
      {
        clientId: client.id,
        userId: client.user?.id,
        role: client.user?.role || "ANONYMOUS",
        activeConnections: this.clients.size,
      },
      "[WS] Client connected and registered"
    );
  }

  /**
   * Unregisters client from connection maps and metrics.
   */
  private unregisterClient(client: AuthenticatedClient): void {
    if (!this.clients.has(client.id)) return;
    this.clients.delete(client.id);

    const ipCount = this.ipConnectionCounts.get(client.ip) || 1;
    if (ipCount <= 1) {
      this.ipConnectionCounts.delete(client.ip);
    } else {
      this.ipConnectionCounts.set(client.ip, ipCount - 1);
    }

    if (client.user?.id) {
      const userCount = this.userConnectionCounts.get(client.user.id) || 1;
      if (userCount <= 1) {
        this.userConnectionCounts.delete(client.user.id);
      } else {
        this.userConnectionCounts.set(client.user.id, userCount - 1);
      }
    }

    metrics.setWebSocketConnections(this.clients.size);
    logger.debug(
      {
        clientId: client.id,
        activeConnections: this.clients.size,
      },
      "[WS] Client disconnected"
    );
  }

  /**
   * Handles messages received from client (subscribe, unsubscribe, ping, auth).
   */
  private async handleClientMessage(client: AuthenticatedClient, rawData: any): Promise<void> {
    try {
      const str = rawData.toString();
      // Handle simple text ping
      if (str === "ping") {
        client.ws.send("pong");
        return;
      }

      const json = JSON.parse(str);
      const parsed = ClientMessageSchema.safeParse(json);

      if (!parsed.success) {
        this.sendToClient(client, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Message payload does not conform to WebSocket protocol specification.",
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const message = parsed.data;

      switch (message.type) {
        case "ping": {
          this.sendToClient(client, {
            type: "heartbeat",
            timestamp: new Date().toISOString(),
          });
          break;
        }

        case "auth": {
          const authenticatedUser = consumeRealtimeTicket(message.ticket);
          if (!authenticatedUser) {
            this.sendToClient(client, {
              type: "error",
              code: "AUTH_FAILED",
              message: "Invalid or expired realtime authentication ticket.",
              timestamp: new Date().toISOString(),
            });
            return;
          }

          client.user = authenticatedUser;
          // Subscribe to personal user channel
          client.channels.add(getUserChannel(authenticatedUser.id));
          if (authenticatedUser.role === "admin" || authenticatedUser.role === "employee") {
            client.channels.add(CHANNEL_OPERATIONAL_STAFF);
          }

          this.sendToClient(client, {
            type: "connection_ack",
            clientId: client.id,
            authenticated: true,
            user: client.user,
            availableChannels: [
              CHANNEL_STATIONS_PUBLIC,
              ...(authenticatedUser.role === "admin" || authenticatedUser.role === "employee"
                ? [CHANNEL_OPERATIONAL_STAFF]
                : []),
              getUserChannel(authenticatedUser.id),
            ],
            timestamp: new Date().toISOString(),
          });
          break;
        }

        case "subscribe": {
          const authCheck = canSubscribeToChannel(message.channel, client.user);
          if (!authCheck.allowed) {
            this.sendToClient(client, {
              type: "error",
              code: "FORBIDDEN",
              message: authCheck.reason || "Unauthorized to subscribe to channel.",
              timestamp: new Date().toISOString(),
            });
            return;
          }

          client.channels.add(message.channel);
          this.sendToClient(client, {
            type: "subscribed",
            channel: message.channel,
            timestamp: new Date().toISOString(),
          });
          break;
        }

        case "unsubscribe": {
          client.channels.delete(message.channel);
          this.sendToClient(client, {
            type: "unsubscribed",
            channel: message.channel,
            timestamp: new Date().toISOString(),
          });
          break;
        }
      }
    } catch (err: any) {
      this.sendToClient(client, {
        type: "error",
        code: "PARSE_ERROR",
        message: "Failed to parse incoming WebSocket message.",
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Distributes an event from the distributed PubSub bus to local WebSocket clients.
   * Ensures strict privacy filtering and backpressure protection.
   */
  public distributeEventToLocalClients(event: RealtimeNotification): void {
    const rawPublicEvent = sanitizeEventForPublic(event);

    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      let eventToSend: any = null;

      // 1. Staff channel: client is subscribed to operational:staff and has staff role
      if (
        client.channels.has(CHANNEL_OPERATIONAL_STAFF) &&
        (client.user?.role === "admin" || client.user?.role === "employee") &&
        (event.channel === CHANNEL_OPERATIONAL_STAFF || event.channel.startsWith("operational:"))
      ) {
        eventToSend = event;
      }
      // 2. Personal user channel: client is subscribed to user:XYZ matching their ID (or staff)
      else if (
        client.channels.has(event.channel) &&
        (client.user?.role === "admin" ||
          client.user?.role === "employee" ||
          client.channels.has(getUserChannel(client.user?.id || 0)))
      ) {
        eventToSend = event;
      }
      // 3. Public station updates
      else if (client.channels.has(CHANNEL_STATIONS_PUBLIC) && rawPublicEvent) {
        eventToSend = rawPublicEvent;
      }

      if (eventToSend) {
        this.sendToClient(client, eventToSend);
      }
    }
  }

  /**
   * Sends message to client with backpressure protection.
   */
  public sendToClient(client: AuthenticatedClient, message: ServerMessage | RealtimeNotification): boolean {
    if (client.ws.readyState !== WebSocket.OPEN) return false;

    // Check backpressure
    const buffered = client.ws.bufferedAmount;

    if (buffered > BUFFERED_AMOUNT_MAX) {
      logger.warn(
        { clientId: client.id, buffered, max: BUFFERED_AMOUNT_MAX },
        "[WS BACKPRESSURE] Slow consumer exceeded max buffered amount. Terminating connection."
      );
      client.ws.terminate();
      this.unregisterClient(client);
      return false;
    }

    if (buffered > BUFFERED_AMOUNT_WARNING) {
      logger.warn(
        { clientId: client.id, buffered },
        "[WS BACKPRESSURE] Client buffer high. Discarding non-critical notification."
      );
      // If it's a heartbeat, discard it to let buffer drain
      if (message.type === "heartbeat") return false;
    }

    try {
      client.ws.send(JSON.stringify(message));
      return true;
    } catch (err: any) {
      logger.warn({ clientId: client.id, error: err.message }, "[WS] Failed to send message to client");
      return false;
    }
  }

  /**
   * Heartbeat monitor running every 30 seconds.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.isAlive) {
          logger.debug({ clientId: client.id }, "[WS HEARTBEAT] Client missed heartbeat ping. Terminating.");
          client.ws.terminate();
          this.unregisterClient(client);
        } else {
          client.isAlive = false;
          client.ws.ping();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  /**
   * Extracts user from session cookie or ticket during upgrade.
   */
  private async authenticateUpgradeRequest(
    req: IncomingMessage,
    url: URL
  ): Promise<{ id: number; username: string; role: string } | null> {
    // 1. Check ticket query parameter (?ticket=...)
    const ticket = url.searchParams.get("ticket");
    if (ticket) {
      const user = consumeRealtimeTicket(ticket);
      if (user) return user;
    }

    // 2. Check session cookie
    const cookies = this.parseCookies(req.headers.cookie);
    const rawCookie = cookies[COOKIE_NAME];
    if (!rawCookie) return null;

    const sessionId = this.extractSessionId(rawCookie);
    if (!sessionId) return null;

    try {
      const session = await new Promise<any>((resolve) => {
        storage.sessionStore.get(sessionId, (err, sess) => {
          if (err || !sess) resolve(null);
          else resolve(sess);
        });
      });

      if (!session || !session.passport?.user) return null;

      const userId = session.passport.user;
      const user = await storage.getUser(userId);
      if (!user) return null;

      return {
        id: user.id,
        username: user.username,
        role: user.role,
      };
    } catch {
      return null;
    }
  }

  private parseCookies(cookieHeader?: string): Record<string, string> {
    const list: Record<string, string> = {};
    if (!cookieHeader) return list;
    cookieHeader.split(";").forEach((cookie) => {
      const [rawName, ...rest] = cookie.split("=");
      const name = rawName?.trim();
      if (!name) return;
      const value = rest.join("=").trim();
      list[name] = decodeURIComponent(value);
    });
    return list;
  }

  private extractSessionId(cookieValue: string): string {
    if (cookieValue.startsWith("s:")) {
      const raw = cookieValue.slice(2);
      const dotIndex = raw.indexOf(".");
      return dotIndex > 0 ? raw.slice(0, dotIndex) : raw;
    }
    return cookieValue;
  }

  private getClientIp(req: IncomingMessage): string {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string") {
      return xff.split(",")[0].trim();
    }
    return req.socket.remoteAddress || "127.0.0.1";
  }

  public getActiveClientsCount(): number {
    return this.clients.size;
  }

  public getClient(id: string): AuthenticatedClient | undefined {
    return this.clients.get(id);
  }

  public close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.clients.clear();
    this.ipConnectionCounts.clear();
    this.userConnectionCounts.clear();
  }
}

export const realtimeManager = new RealtimeManager();

/**
 * Public API to broadcast operational events across the system.
 * Emits to distributed Pub/Sub so all backend instances notify their WebSocket clients.
 */
export async function broadcastOperationalEvent(
  type: RealtimeEventType,
  data: Record<string, any>,
  options?: { channel?: string; userId?: number }
): Promise<RealtimeNotification> {
  const channel = options?.channel || (options?.userId ? getUserChannel(options.userId) : CHANNEL_OPERATIONAL_STAFF);

  const event: RealtimeNotification = {
    eventId: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    channel,
    data,
  };

  await realtimePubSub.publish(event);
  return event;
}
