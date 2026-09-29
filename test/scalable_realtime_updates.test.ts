import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express from "express";
import { WebSocket } from "ws";
import {
  REALTIME_EVENT_TYPES,
  CHANNEL_STATIONS_PUBLIC,
  CHANNEL_OPERATIONAL_STAFF,
  getUserChannel,
  canSubscribeToChannel,
  sanitizeEventForPublic,
  RealtimeNotification,
  RealtimeNotificationSchema,
} from "../shared/realtime";
import {
  RealtimeManager,
  broadcastOperationalEvent,
  issueRealtimeTicket,
  consumeRealtimeTicket,
  MAX_CONNECTIONS_PER_IP,
  MAX_CONNECTIONS_PER_USER,
} from "../server/realtime-service";
import { realtimePubSub } from "../server/realtime-pubsub";

test("Scalable Real-Time Operational Updates Suite", async (t) => {
  let server: http.Server;
  let serverPort: number;
  let realtimeMgr: RealtimeManager;

  t.before(async () => {
    const app = express();
    server = http.createServer(app);
    realtimeMgr = new RealtimeManager();
    realtimeMgr.initialize(server, "/ws");

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  t.after(async () => {
    realtimeMgr.close();
    await realtimePubSub.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  await t.test("1. All 8 operational event types are strictly defined and validated", () => {
    const expected = [
      "booking_created",
      "booking_confirmed",
      "booking_cancelled",
      "booking_checked_in",
      "session_started",
      "session_stopped",
      "station_status_changed",
      "payment_status_changed",
    ];

    for (const type of expected) {
      assert.ok(
        (REALTIME_EVENT_TYPES as readonly string[]).includes(type),
        `Event type ${type} must be defined in REALTIME_EVENT_TYPES`
      );
    }
  });

  await t.test("2. Channel authorization matrix prevents unauthorized access and data leakage", () => {
    const anonymousUser = null;
    const memberUser = { id: 101, role: "member" };
    const employeeUser = { id: 202, role: "employee" };
    const adminUser = { id: 303, role: "admin" };

    // Public channel: open to everyone
    assert.strictEqual(canSubscribeToChannel(CHANNEL_STATIONS_PUBLIC, anonymousUser).allowed, true);
    assert.strictEqual(canSubscribeToChannel(CHANNEL_STATIONS_PUBLIC, memberUser).allowed, true);
    assert.strictEqual(canSubscribeToChannel(CHANNEL_STATIONS_PUBLIC, employeeUser).allowed, true);

    // Staff channel: strictly forbidden for anonymous and members
    assert.strictEqual(canSubscribeToChannel(CHANNEL_OPERATIONAL_STAFF, anonymousUser).allowed, false);
    assert.strictEqual(canSubscribeToChannel(CHANNEL_OPERATIONAL_STAFF, memberUser).allowed, false);
    assert.strictEqual(canSubscribeToChannel(CHANNEL_OPERATIONAL_STAFF, employeeUser).allowed, true);
    assert.strictEqual(canSubscribeToChannel(CHANNEL_OPERATIONAL_STAFF, adminUser).allowed, true);

    // Personal user channels: member cannot snoop on another user's channel
    assert.strictEqual(canSubscribeToChannel(getUserChannel(101), memberUser).allowed, true);
    assert.strictEqual(canSubscribeToChannel(getUserChannel(999), memberUser).allowed, false);
    assert.strictEqual(canSubscribeToChannel(getUserChannel(999), anonymousUser).allowed, false);

    // Staff can access user channels for customer service
    assert.strictEqual(canSubscribeToChannel(getUserChannel(101), employeeUser).allowed, true);
    assert.strictEqual(canSubscribeToChannel(getUserChannel(101), adminUser).allowed, true);
  });

  await t.test("3. Public channel sanitization strips private customer and booking info", () => {
    // Station status changed can be shared publicly
    const stationEvent: RealtimeNotification = {
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      type: "station_status_changed",
      timestamp: new Date().toISOString(),
      channel: CHANNEL_OPERATIONAL_STAFF,
      data: {
        stationId: 5,
        stationName: "PS5-01",
        gameTypeId: 1,
        status: "OCCUPIED",
        userId: 42, // Sensitive internal details
        customerName: "John Doe",
        bookingRef: "REF-123",
      },
    };

    const sanitized = sanitizeEventForPublic(stationEvent);
    assert.ok(sanitized, "Should produce sanitized public event");
    assert.strictEqual(sanitized!.channel, CHANNEL_STATIONS_PUBLIC);
    assert.strictEqual(sanitized!.data.stationId, 5);
    assert.strictEqual(sanitized!.data.status, "OCCUPIED");
    assert.strictEqual((sanitized!.data as any).userId, undefined, "userId must be stripped from public");
    assert.strictEqual((sanitized!.data as any).customerName, undefined, "customerName must be stripped");
    assert.strictEqual((sanitized!.data as any).bookingRef, undefined, "bookingRef must be stripped");

    // Other sensitive operational events (e.g. payment_status_changed) must NEVER be exposed publicly
    const paymentEvent: RealtimeNotification = {
      eventId: "550e8400-e29b-41d4-a716-446655440001",
      type: "payment_status_changed",
      timestamp: new Date().toISOString(),
      channel: CHANNEL_OPERATIONAL_STAFF,
      data: { paymentId: "pay_123", amount: 500, userId: 10 },
    };

    assert.strictEqual(
      sanitizeEventForPublic(paymentEvent),
      null,
      "Payments must never be broadcast on public channel"
    );
  });

  await t.test("4. Realtime ticket generation and single-use consumption", () => {
    const mockUser: any = { id: 77, username: "gamer77", role: "member" };
    const ticket = issueRealtimeTicket(mockUser);

    assert.ok(ticket.startsWith("rt_tkt_"));

    // First consumption succeeds
    const consumed = consumeRealtimeTicket(ticket);
    assert.ok(consumed);
    assert.strictEqual(consumed!.id, 77);
    assert.strictEqual(consumed!.username, "gamer77");

    // Second consumption fails (single-use token)
    const secondTry = consumeRealtimeTicket(ticket);
    assert.strictEqual(secondTry, null, "Ticket must be single-use only");
  });

  await t.test("5. Anonymous WebSocket connection receives connection_ack and public channel", async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws`);

    const ackMessage = await new Promise<any>((resolve, reject) => {
      ws.on("open", () => {});
      ws.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === "connection_ack") resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
      ws.on("error", reject);
    });

    assert.strictEqual(ackMessage.type, "connection_ack");
    assert.strictEqual(ackMessage.authenticated, false);
    assert.strictEqual(ackMessage.user, null);
    assert.ok(ackMessage.availableChannels.includes(CHANNEL_STATIONS_PUBLIC));
    assert.ok(!ackMessage.availableChannels.includes(CHANNEL_OPERATIONAL_STAFF));

    ws.close();
  });

  await t.test("6. Authenticated WebSocket connection via ticket subscribes to personal & staff channels", async () => {
    const mockAdmin: any = { id: 99, username: "admin_super", role: "admin" };
    const ticket = issueRealtimeTicket(mockAdmin);

    const ws = new WebSocket(`ws://localhost:${serverPort}/ws?ticket=${ticket}`);

    const ackMessage = await new Promise<any>((resolve, reject) => {
      ws.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === "connection_ack") resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
      ws.on("error", reject);
    });

    assert.strictEqual(ackMessage.type, "connection_ack");
    assert.strictEqual(ackMessage.authenticated, true);
    assert.strictEqual(ackMessage.user?.role, "admin");
    assert.ok(ackMessage.availableChannels.includes(CHANNEL_OPERATIONAL_STAFF));
    assert.ok(ackMessage.availableChannels.includes(getUserChannel(99)));

    ws.close();
  });

  await t.test("7. Client heartbeat ping-pong responds with heartbeat message", async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws`);

    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    ws.send(JSON.stringify({ type: "ping" }));

    const response = await new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === "heartbeat") resolve(parsed);
      });
    });

    assert.strictEqual(response.type, "heartbeat");
    assert.ok(response.timestamp);

    ws.close();
  });

  await t.test("8. Unauthorized channel subscription returns FORBIDDEN error", async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws`);

    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    // Anonymous attempts to subscribe to staff operational channel
    ws.send(JSON.stringify({ type: "subscribe", channel: CHANNEL_OPERATIONAL_STAFF }));

    const errorResponse = await new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === "error") resolve(parsed);
      });
    });

    assert.strictEqual(errorResponse.type, "error");
    assert.strictEqual(errorResponse.code, "FORBIDDEN");

    ws.close();
  });

  await t.test("9. End-to-end event broadcast delivers notifications across channels without leaking to public", async () => {
    // 1. Staff client
    const staffTicket = issueRealtimeTicket({ id: 1, username: "staff_guy", role: "employee" } as any);
    const staffWs = new WebSocket(`ws://localhost:${serverPort}/ws?ticket=${staffTicket}`);

    // 2. Customer A client
    const customerATicket = issueRealtimeTicket({ id: 50, username: "customer_a", role: "member" } as any);
    const customerAWs = new WebSocket(`ws://localhost:${serverPort}/ws?ticket=${customerATicket}`);

    // 3. Customer B client
    const customerBTicket = issueRealtimeTicket({ id: 60, username: "customer_b", role: "member" } as any);
    const customerBWs = new WebSocket(`ws://localhost:${serverPort}/ws?ticket=${customerBTicket}`);

    // 4. Public anonymous client
    const publicWs = new WebSocket(`ws://localhost:${serverPort}/ws`);

    await Promise.all([
      new Promise<void>((r) => staffWs.on("open", () => r())),
      new Promise<void>((r) => customerAWs.on("open", () => r())),
      new Promise<void>((r) => customerBWs.on("open", () => r())),
      new Promise<void>((r) => publicWs.on("open", () => r())),
    ]);

    // Track received events per client
    const staffReceived: any[] = [];
    const customerAReceived: any[] = [];
    const customerBReceived: any[] = [];
    const publicReceived: any[] = [];

    staffWs.on("message", (d) => {
      const p = JSON.parse(d.toString());
      if (p.type !== "connection_ack") staffReceived.push(p);
    });

    customerAWs.on("message", (d) => {
      const p = JSON.parse(d.toString());
      if (p.type !== "connection_ack") customerAReceived.push(p);
    });

    customerBWs.on("message", (d) => {
      const p = JSON.parse(d.toString());
      if (p.type !== "connection_ack") customerBReceived.push(p);
    });

    publicWs.on("message", (d) => {
      const p = JSON.parse(d.toString());
      if (p.type !== "connection_ack") publicReceived.push(p);
    });

    // Wait 50ms for subscriptions to settle
    await new Promise((r) => setTimeout(r, 50));

    // A. Broadcast customer A's private booking confirmation
    await broadcastOperationalEvent(
      "booking_confirmed",
      {
        bookingId: 777,
        userId: 50,
        status: "CONFIRMED",
        confirmedAt: new Date().toISOString(),
      },
      { channel: getUserChannel(50) }
    );

    // B. Broadcast station status change (publicly sanitized)
    await broadcastOperationalEvent(
      "station_status_changed",
      {
        stationId: 3,
        stationName: "VR-01",
        gameTypeId: 2,
        status: "OCCUPIED",
        updatedAt: new Date().toISOString(),
      },
      { channel: CHANNEL_STATIONS_PUBLIC }
    );

    // C. Broadcast staff-only operational session start
    await broadcastOperationalEvent(
      "session_started",
      {
        stationId: 3,
        stationName: "VR-01",
        bookingId: 777,
        startedAt: new Date().toISOString(),
      },
      { channel: CHANNEL_OPERATIONAL_STAFF }
    );

    // Allow distribution to complete
    await new Promise((r) => setTimeout(r, 100));

    // Assertions:
    // 1. Staff received booking_confirmed, station_status_changed, session_started
    assert.ok(staffReceived.some((e) => e.type === "session_started"));
    assert.ok(staffReceived.some((e) => e.type === "station_status_changed"));

    // 2. Customer A received their personal booking_confirmed and public station update
    assert.ok(customerAReceived.some((e) => e.type === "booking_confirmed" && e.data.bookingId === 777));
    assert.ok(customerAReceived.some((e) => e.type === "station_status_changed"));
    assert.ok(!customerAReceived.some((e) => e.type === "session_started"), "Customer A must NOT receive staff operational events");

    // 3. Customer B did NOT receive Customer A's booking_confirmed!
    assert.ok(
      !customerBReceived.some((e) => e.type === "booking_confirmed"),
      "Customer B must NEVER receive Customer A's private booking notification"
    );
    assert.ok(customerBReceived.some((e) => e.type === "station_status_changed"));

    // 4. Public client only received station_status_changed
    assert.ok(publicReceived.some((e) => e.type === "station_status_changed"));
    assert.ok(!publicReceived.some((e) => e.type === "booking_confirmed"), "Public client must not receive private bookings");
    assert.ok(!publicReceived.some((e) => e.type === "session_started"), "Public client must not receive staff session events");

    staffWs.close();
    customerAWs.close();
    customerBWs.close();
    publicWs.close();
  });

  await t.test("10. Per-User connection limits reject excessive simultaneous sockets", async () => {
    const limitedUser: any = { id: 888, username: "multi_client_user", role: "member" };
    const sockets: WebSocket[] = [];

    // Connect up to MAX_CONNECTIONS_PER_USER
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
      const ticket = issueRealtimeTicket(limitedUser);
      const ws = new WebSocket(`ws://localhost:${serverPort}/ws?ticket=${ticket}`);
      await new Promise<void>((r) => ws.on("open", () => r()));
      sockets.push(ws);
    }

    // Next connection attempt must be rejected with 429
    const excessTicket = issueRealtimeTicket(limitedUser);
    let rejected = false;

    await new Promise<void>((resolve) => {
      const excessWs = new WebSocket(`ws://localhost:${serverPort}/ws?ticket=${excessTicket}`);
      excessWs.on("unexpected-response", (_req, res) => {
        if (res.statusCode === 429) {
          rejected = true;
        }
        resolve();
      });
      excessWs.on("error", () => {
        resolve();
      });
      excessWs.on("open", () => {
        sockets.push(excessWs);
        resolve();
      });
    });

    assert.strictEqual(rejected, true, "Excess connection must be rejected with HTTP 429");

    sockets.forEach((s) => s.close());
  });

  await t.test("11. Backpressure detection identifies high buffered amount", () => {
    const mockWs: any = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 128 * 1024, // 128 KB > 64KB warning threshold
      send: () => {},
    };

    const mockClient: any = {
      id: "mock_slow_client",
      ws: mockWs,
      channels: new Set([CHANNEL_STATIONS_PUBLIC]),
      user: null,
      isAlive: true,
    };

    // Low-priority heartbeat message should be dropped when buffer is high
    const sent = realtimeMgr.sendToClient(mockClient, {
      type: "heartbeat",
      timestamp: new Date().toISOString(),
    });

    assert.strictEqual(sent, false, "Non-critical message must be dropped during high backpressure");
  });
});
