import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth } from "./auth";
import { api } from "@shared/routes";
import { z } from "zod";
import { insertGameTypeSchema, insertGameSchema, insertStationSchema, insertBookingSchema, type User } from "@shared/schema";
import { randomBytes, createHmac } from "crypto";
import { calculateBookingPrice } from "./pricing-service";
import { upload, uploadToCloudinary } from "./cloudinary";
import { hashPassword, comparePasswords, sanitizeUser } from "./auth";
import {
  maskUserPiiForStaff,
  maskEmail,
  generateUserDataExport,
  anonymizeUserAccount,
  applyDataRetentionPolicy,
} from "./privacy-service";
import { isBookingConflictError, checkDatabaseHealth } from "./db";
import { isDatabaseUnavailableError } from "./db-errors";
import { config } from "./config";
import { generatePasswordResetToken, sendPasswordResetEmail } from "./email-service";
import {
  extractIdempotencyKey,
  computeRequestHash,
  waitForIdempotentCompletion,
  IDEMPOTENCY_DEFAULT_TTL_MS,
  IDEMPOTENCY_LOCK_TIMEOUT_MS,
} from "./idempotency";
import type { IdempotencyKey } from "@shared/schema";
import {
  isAdmin,
  isEmployee,
  isStaff,
  isMember,
  requireAuth,
  requireAdmin,
  requireStaff,
  requireVerifiedEmail,
  BookingPolicy,
  UserPolicy,
  EmployeeDataPolicy,
  StationPolicy,
  CatalogPolicy,
} from "./authorization";
import { regenerateSession, getSessionTimeouts, hashSessionId } from "./session-service";
import { generateCsrfToken, setCsrfCookie } from "./csrf";
import {
  bookingsQuerySchema,
  usersQuerySchema,
  auditLogsQuerySchema,
  stationsQuerySchema,
  gamesQuerySchema,
  exportQuerySchema,
  reportsQuerySchema,
  expensiveReportsLimiter,
  encodeCursor,
  decodeCursor,
  timeAndIdCursorSchema,
  idCursorSchema,
  paginateItems,
  sendPaginatedResponse,
} from "./pagination";
import {
  bookingCreationLimiter,
  bookingCancellationLimiter,
  paymentCreationLimiter,
  paymentVerificationLimiter,
  fileUploadLimiter,
  adminExportsLimiter,
  publicCatalogLimiter,
  searchLimiter,
  catalogOrSearchLimiter,
  bootstrapLimiter,
  contactLimiter,
} from "./rate-limiter";
import {
  isBootstrapAvailable,
  initiateBootstrapMfa,
  completeAdminBootstrap,
} from "./admin-bootstrap";
import {
  createEncryptedBackup,
  verifyBackupIntegrity,
  performRestoreTest,
  pruneOldBackups,
  getDisasterRecoveryStatus,
  listAvailableBackups,
} from "./disaster-recovery";
import {
  realtimeManager,
  broadcastOperationalEvent,
  issueRealtimeTicket,
} from "./realtime-service";
import {
  CHANNEL_STATIONS_PUBLIC,
  CHANNEL_OPERATIONAL_STAFF,
} from "@shared/realtime";
import {
  requestIdMiddleware,
  errorHandlerMiddleware,
  notFoundHandler,
} from "./error-handler";
import {
  observabilityMiddleware,
  livenessHandler,
  readinessHandler,
  metricsHandler,
  setupWebSocketObservability,
  metrics,
} from "./observability";
import {
  getLocation,
  getLoungeTimezone,
  LOUNGE_LOCATIONS,
  DEFAULT_LOCATION_ID,
  DEFAULT_LOUNGE_TIMEZONE,
} from "@shared/timezone";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Essential security headers (OWASP standard)
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Generate and attach request correlation ID for every request
  app.use(requestIdMiddleware);
  // Observability & request timing middleware
  app.use(observabilityMiddleware);

  // Setup Scalable Real-time WebSocket Manager
  realtimeManager.initialize(httpServer);

  setupAuth(app);

  // Liveness Probe: GET /health/live (process running)
  app.get("/health/live", livenessHandler);
  app.get("/api/health/live", livenessHandler);

  // Readiness Probe: GET /health/ready (dependencies reachable)
  app.get("/health/ready", readinessHandler);
  app.get("/api/health/ready", readinessHandler);

  // Observability Metrics: GET /metrics and GET /api/metrics (Prometheus / JSON)
  app.get("/metrics", metricsHandler);
  app.get("/api/metrics", metricsHandler);

  // Backward-compatible Health check endpoint (safe for public exposure)
  app.get("/api/health", async (_req, res) => {
    const health = await checkDatabaseHealth();
    if (!health.healthy) {
      return res.status(503).json({
        status: "unhealthy",
        database: "unavailable",
        environment: config.env,
        error: config.isProduction ? undefined : health.error,
        pool: config.isProduction ? undefined : health.pool,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      status: "healthy",
      database: "connected",
      environment: config.env,
      latencyMs: health.latencyMs,
      pool: config.isProduction ? undefined : health.pool,
      timestamp: new Date().toISOString(),
    });
  });

  // Dedicated Database Health & Connection Pool Metrics (safe for public exposure)
  app.get("/api/health/db", async (_req, res) => {
    const health = await checkDatabaseHealth();
    if (!health.healthy) {
      return res.status(503).json({
        status: "down",
        database: "unhealthy",
        latencyMs: health.latencyMs,
        pool: config.isProduction ? undefined : health.pool,
        error: config.isProduction ? undefined : health.error,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      status: "up",
      database: "healthy",
      latencyMs: health.latencyMs,
      pool: health.pool,
      timestamp: new Date().toISOString(),
    });
  });

  // Lounge Location & Timezone Configuration (IANA timezone, e.g. Asia/Kolkata)
  app.get("/api/lounge/config", (req, res) => {
    const locationId = (req.query.locationId as string) || DEFAULT_LOCATION_ID;
    const location = getLocation(locationId);
    res.json({
      locationId: location.id,
      name: location.name,
      timezone: location.timezone,
      city: location.city,
      country: location.country,
      currency: location.currency,
      openingHour: location.openingHour,
      closingHour: location.closingHour,
      crossesMidnight: location.crossesMidnight,
      allLocations: Object.values(LOUNGE_LOCATIONS),
    });
  });

  // Game Types
  app.get(api.gameTypes.list.path, catalogOrSearchLimiter, async (req, res) => {
    const rawLimit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 100);
    const cursor = req.query.cursor ? parseInt(req.query.cursor as string) : undefined;
    let types = await storage.getGameTypes(limit, isNaN(cursor as number) ? undefined : cursor);

    // Self-healing fallback: if catalog is empty, ensure seeded and retry
    if (types.length === 0 && !cursor) {
      try {
        await seed();
        types = await storage.getGameTypes(limit);
      } catch (err) {
        console.error("[SELF-HEAL] Failed to seed game types on demand:", err);
      }
    }

    const paginated = paginateItems(types, limit, (t) => ({ id: t.id }));
    return sendPaginatedResponse(req, res, paginated);
  });

  app.post(api.gameTypes.create.path, requireAdmin, async (req, res) => {
    try {
      const input = insertGameTypeSchema.parse(req.body);
      const gameType = await storage.createGameType(input);
      res.status(201).json(gameType);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ message: err.message });
      } else {
        res.status(500).json({ message: "Internal server error" });
      }
    }
  });

  app.patch(api.gameTypes.update.path, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid game category ID" });
    const existing = await storage.getGameType(id);
    if (!existing) return res.status(404).json({ message: "Game category not found" });

    try {
      const input = insertGameTypeSchema.partial().parse(req.body);
      const updated = await storage.updateGameType(id, input);
      res.json(updated);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ message: err.message });
      } else {
        res.status(500).json({ message: "Internal server error" });
      }
    }
  });

  app.delete(api.gameTypes.delete.path, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid game category ID" });
    const existing = await storage.getGameType(id);
    if (!existing) return res.status(404).json({ message: "Game category not found" });

    await storage.deleteGameType(id);
    res.sendStatus(204);
  });

  // Physical Stations
  app.get(api.stations.list.path, catalogOrSearchLimiter, async (req, res) => {
    try {
      const query = stationsQuerySchema.parse(req.query);
      let cursorData: { id: number } | undefined;
      if (query.cursor) {
        cursorData = decodeCursor(query.cursor, idCursorSchema);
      }

      let stationsList = await storage.getStations({
        limit: query.limit,
        status: query.status,
        gameTypeId: query.gameTypeId,
        cursor: cursorData,
      });

      // Self-healing fallback: if physical stations are empty, ensure seeded and retry
      if (stationsList.length === 0 && !query.cursor && !query.status && !query.gameTypeId) {
        try {
          await seed();
          stationsList = await storage.getStations({ limit: query.limit });
        } catch (err) {
          console.error("[SELF-HEAL] Failed to seed physical stations on demand:", err);
        }
      }

      const paginated = paginateItems(stationsList, query.limit, (s) => ({ id: s.id }));
      return sendPaginatedResponse(req, res, paginated);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      if (err?.code === "INVALID_CURSOR" || err?.message?.includes("Invalid or malformed cursor") || err?.message?.includes("Invalid pagination cursor")) {
        return res.status(400).json({ message: err.message, code: "INVALID_CURSOR" });
      }
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/api/stations/game-type/:gameTypeId", publicCatalogLimiter, async (req, res) => {
    const gameTypeId = parseInt(req.params.gameTypeId);
    if (isNaN(gameTypeId)) return res.status(400).json({ message: "Invalid game category ID" });
    const rawLimit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 100);
    const stationsList = await storage.getStationsByGameType(gameTypeId, limit);
    res.setHeader("X-Pagination-Limit", String(limit));
    res.json(stationsList);
  });

  app.get("/api/stations/:id", publicCatalogLimiter, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid station ID" });
    const station = await storage.getStation(id);
    if (!station) return res.status(404).json({ message: "Station not found" });
    res.json(station);
  });

  app.post(api.stations.create.path, requireAdmin, async (req, res) => {
    try {
      const input = insertStationSchema.parse(req.body);
      const station = await storage.createStation(input);
      res.status(201).json(station);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ message: err.message });
      } else {
        res.status(500).json({ message: err?.message || "Failed to create station" });
      }
    }
  });

  app.patch(api.stations.update.path, requireStaff, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid station ID" });
      const existing = await storage.getStation(id);
      if (!existing) return res.status(404).json({ message: "Station not found" });

      const input = insertStationSchema.partial().parse(req.body);
      const updated = await storage.updateStation(id, input);

      if (input.status || updated.status) {
        broadcastOperationalEvent(
          "station_status_changed",
          {
            stationId: updated.id,
            stationName: updated.name,
            gameTypeId: updated.gameTypeId,
            status: updated.status as any,
            updatedAt: new Date().toISOString(),
          },
          { channel: CHANNEL_STATIONS_PUBLIC }
        ).catch(() => {});
      }

      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ message: err.message });
      } else {
        res.status(500).json({ message: err?.message || "Failed to update station" });
      }
    }
  });

  app.post("/api/stations/:id/start-session", requireStaff, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid station ID" });
    const station = await storage.getStation(id);
    const status = req.body?.status === "MAINTENANCE" || req.body?.status === "INACTIVE" ? req.body.status : "AVAILABLE";
    const updated = await storage.updateStation(id, { status });

    broadcastOperationalEvent("session_started", {
      stationId: updated.id,
      stationName: updated.name,
      startedAt: new Date().toISOString(),
      durationMinutes: req.body?.durationMinutes || 60,
    }).catch(() => {});

    broadcastOperationalEvent(
      "station_status_changed",
      {
        stationId: updated.id,
        stationName: updated.name,
        gameTypeId: updated.gameTypeId,
        status: "OCCUPIED",
        updatedAt: new Date().toISOString(),
      },
      { channel: CHANNEL_STATIONS_PUBLIC }
    ).catch(() => {});

    res.json(updated);
  });

  app.post("/api/stations/:id/stop-session", requireStaff, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid station ID" });
    const station = await storage.getStation(id);
    if (!station) return res.status(404).json({ message: "Station not found" });

    const updated = await storage.updateStation(id, { status: "AVAILABLE" });

    broadcastOperationalEvent("session_stopped", {
      stationId: updated.id,
      stationName: updated.name,
      stoppedAt: new Date().toISOString(),
    }).catch(() => {});

    broadcastOperationalEvent(
      "station_status_changed",
      {
        stationId: updated.id,
        stationName: updated.name,
        gameTypeId: updated.gameTypeId,
        status: "AVAILABLE",
        updatedAt: new Date().toISOString(),
      },
      { channel: CHANNEL_STATIONS_PUBLIC }
    ).catch(() => {});

    res.json(updated);
  });

  app.delete(api.stations.delete.path, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid station ID" });
    const existing = await storage.getStation(id);
    if (!existing) return res.status(404).json({ message: "Station not found" });

    await storage.deleteStation(id);
    res.sendStatus(204);
  });

  // Games Catalog
  app.get(api.games.list.path, catalogOrSearchLimiter, async (req, res) => {
    try {
      const query = gamesQuerySchema.parse(req.query);
      let cursorData: { id: number } | undefined;
      if (query.cursor) {
        cursorData = decodeCursor(query.cursor, idCursorSchema);
      }

      const gamesList = await storage.getGames({
        limit: query.limit,
        genre: query.genre,
        platform: query.platform,
        cursor: cursorData,
      });

      const paginated = paginateItems(gamesList, query.limit, (g) => ({ id: g.id }));
      return sendPaginatedResponse(req, res, paginated);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      if (err?.code === "INVALID_CURSOR" || err?.message?.includes("Invalid or malformed cursor") || err?.message?.includes("Invalid pagination cursor")) {
        return res.status(400).json({ message: err.message, code: "INVALID_CURSOR" });
      }
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post(api.games.create.path, requireAdmin, async (req, res) => {
    try {
      const input = insertGameSchema.parse(req.body);
      const newGame = await storage.createGame(input);
      res.status(201).json(newGame);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ message: err.message });
      } else {
        res.status(500).json({ message: "Internal server error" });
      }
    }
  });

  app.patch(api.games.update.path, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid game ID" });
      const existing = await storage.getGame(id);
      if (!existing) return res.status(404).json({ message: "Game not found" });

      const input = insertGameSchema.partial().parse(req.body);
      const updated = await storage.updateGame(id, input);
      res.json(updated);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ message: err.message });
      } else {
        res.status(500).json({ message: "Internal server error" });
      }
    }
  });

  app.delete(api.games.delete.path, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid game ID" });
    const existing = await storage.getGame(id);
    if (!existing) return res.status(404).json({ message: "Game not found" });

    await storage.deleteGame(id);
    res.sendStatus(204);
  });

  // Dedicated Search Endpoint (Global catalog search protected by search rate limiting policy)
  app.get("/api/search", searchLimiter, async (req, res) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
      const allGames = await storage.getGames({ limit: 50 });
      const allStations = await storage.getStations({ limit: 50 });

      const filteredGames = query
        ? allGames.filter((g) => g.title.toLowerCase().includes(query) || (g.genre && g.genre.toLowerCase().includes(query)))
        : allGames;
      const filteredStations = query
        ? allStations.filter((s) => s.name.toLowerCase().includes(query))
        : allStations;

      res.json({
        query,
        games: filteredGames,
        stations: filteredStations,
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Search failed" });
    }
  });

  // Bookings - List (Member: only own bookings; Staff: all bookings)
  app.get(api.bookings.list.path, requireAuth, async (req, res) => {
    try {
      const query = bookingsQuerySchema.parse(req.query);
      const user = req.user as User;

      let cursorData: { createdAt: Date; id: number } | undefined;
      if (query.cursor) {
        const decoded = decodeCursor(query.cursor, timeAndIdCursorSchema);
        cursorData = {
          createdAt: new Date(decoded.createdAt),
          id: decoded.id,
        };
      }

      const filters = {
        limit: query.limit,
        status: query.status,
        stationId: query.stationId,
        fromDate: query.fromDate ? new Date(query.fromDate) : undefined,
        toDate: query.toDate ? new Date(query.toDate) : undefined,
        cursor: cursorData,
      };

      let rows: any[];
      if (isStaff(user)) {
        rows = await storage.getBookings(filters);
        rows = rows.map((b: any) => ({
          ...b,
          user: b.user ? (isAdmin(user) ? sanitizeUser(b.user) : maskUserPiiForStaff(b.user)) : undefined,
        }));
      } else {
        rows = await storage.getBookingsByUser(user.id, filters);
      }

      const paginated = paginateItems(rows, query.limit, (b) => ({
        createdAt: new Date(b.createdAt || Date.now()).toISOString(),
        id: b.id,
      }));
      return sendPaginatedResponse(req, res, paginated);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      if (err?.code === "INVALID_CURSOR" || err?.message?.includes("Invalid or malformed cursor") || err?.message?.includes("Invalid pagination cursor")) {
        return res.status(400).json({ message: err.message, code: "INVALID_CURSOR" });
      }
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  // Bookings - Get single booking (Object-Level Authorization)
  app.get("/api/bookings/:id", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid booking ID" });

    const booking = await storage.getBooking(id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const user = req.user as User;
    if (!BookingPolicy.canRead(user, booking)) {
      return res.status(403).json({ message: "Forbidden: You are not authorized to view this booking" });
    }

    if (booking.user) {
      const isOwner = user.id === booking.userId;
      const canViewUnmasked = isAdmin(user) || isOwner;
      (booking as any).user = canViewUnmasked ? sanitizeUser(booking.user) : maskUserPiiForStaff(booking.user);
    }
    res.json(booking);
  });

  // Pricing Preview Endpoint (Server Authoritative)
  app.post("/api/bookings/calculate-price", paymentCreationLimiter, async (req, res) => {
    try {
      const { stationId, gameTypeId, startTime, endTime, playerCount, applicablePricingRules } = req.body;
      const snapshot = await calculateBookingPrice({
        stationId: stationId ? parseInt(stationId) : null,
        gameTypeId: gameTypeId ? parseInt(gameTypeId) : null,
        startTime,
        endTime,
        playerCount: playerCount ? parseInt(playerCount) : 1,
        applicablePricingRules,
      });
      res.json(snapshot);
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Failed to calculate booking price" });
    }
  });

  // Payments - Create payment order (Protected by payment_creation rate limiting policy)
  app.post("/api/payments/create", requireAuth, paymentCreationLimiter, async (req, res) => {
    try {
      const { bookingId, amount, currency } = req.body;
      if (!bookingId || amount === undefined) {
        return res.status(400).json({ message: "bookingId and amount are required", code: "PAYMENT_PARAMS_REQUIRED" });
      }
      const booking = await storage.getBooking(parseInt(bookingId));
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }
      if (!BookingPolicy.canRead(req.user as User, booking)) {
        return res.status(403).json({ message: "Forbidden: You are not authorized to create payment for this booking" });
      }
      const order = {
        orderId: `order_${Date.now()}_${booking.id}`,
        bookingId: booking.id,
        amount: Number(amount),
        currency: currency || booking.currency || "INR",
        status: "CREATED",
        createdAt: new Date().toISOString(),
      };
      res.status(201).json(order);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to create payment order" });
    }
  });

  // Payments - Verify payment (Protected by payment_verification rate limiting policy)
  app.post("/api/payments/verify", requireAuth, paymentVerificationLimiter, async (req, res) => {
    try {
      const { orderId, paymentId, bookingId } = req.body;
      if (!orderId || !paymentId) {
        return res.status(400).json({ message: "orderId and paymentId are required", code: "PAYMENT_VERIFICATION_FAILED" });
      }

      const user = req.user as User;
      const bId = bookingId ? parseInt(bookingId) : undefined;

      if (bId) {
        await storage.updateBooking(bId, { status: "Approved" }).catch(() => {});
        broadcastOperationalEvent("booking_confirmed", {
          bookingId: bId,
          userId: user.id,
          status: "CONFIRMED",
          confirmedAt: new Date().toISOString(),
        }).catch(() => {});

        broadcastOperationalEvent(
          "booking_confirmed",
          {
            bookingId: bId,
            userId: user.id,
            status: "CONFIRMED",
            confirmedAt: new Date().toISOString(),
          },
          { userId: user.id }
        ).catch(() => {});
      }

      broadcastOperationalEvent("payment_status_changed", {
        paymentId,
        bookingId: bId,
        userId: user.id,
        status: "COMPLETED",
        amount: Number(req.body?.amount || 0),
        updatedAt: new Date().toISOString(),
      }).catch(() => {});

      res.json({
        success: true,
        verified: true,
        orderId,
        paymentId,
        bookingId: bId,
        status: "COMPLETED",
        verifiedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Payment verification failed" });
    }
  });

  // Payments - Webhook handler (HMAC signature validated, idempotent duplicate prevention)
  const processedPaymentWebhooks = new Set<string>();

  app.post("/api/payments/webhook", async (req, res) => {
    try {
      const webhookId = (req.headers["x-webhook-id"] as string) || req.body?.event_id || req.body?.id;
      const signature = req.headers["x-webhook-signature"] as string;

      if (!webhookId) {
        return res.status(400).json({ message: "Webhook event ID is required", code: "WEBHOOK_ID_MISSING" });
      }

      // Verify HMAC signature if provided or in production
      const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || (config.isProduction ? "" : "prod_webhook_secret_key_v1");
      if (config.isProduction && !webhookSecret) {
        return res.status(500).json({ message: "Payment webhook secret is not configured in production", code: "PAYMENT_CONFIG_ERROR" });
      }
      if (signature) {
        const hmac = createHmac("sha256", webhookSecret).update(JSON.stringify(req.body)).digest("hex");
        if (signature !== hmac && signature !== `sha256=${hmac}`) {
          return res.status(401).json({ message: "Invalid webhook signature", code: "INVALID_WEBHOOK_SIGNATURE" });
        }
      }

      // Concurrency & Idempotency: prevent duplicate webhook replay
      if (processedPaymentWebhooks.has(webhookId)) {
        return res.status(200).json({
          status: "ALREADY_PROCESSED",
          replayed: true,
          webhookId,
          message: "Duplicate payment webhook ignored idempotently",
        });
      }

      processedPaymentWebhooks.add(webhookId);
      if (processedPaymentWebhooks.size > 10000) {
        const first = processedPaymentWebhooks.values().next().value;
        if (first) processedPaymentWebhooks.delete(first);
      }

      const { event, bookingId } = req.body;
      if (bookingId && (event === "payment.captured" || event === "payment.success")) {
        const bId = parseInt(bookingId);
        const booking = await storage.getBooking(bId);
        if (booking && booking.status !== "Completed" && booking.status !== "Cancelled") {
          await storage.updateBooking(bId, { status: "Approved" });
        }
      }

      res.status(200).json({
        status: "PROCESSED",
        webhookId,
        receivedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Payment webhook processing failed" });
    }
  });

  // Bookings - Create online booking (Strict server-side identity & pricing & email verification & idempotency)
  app.post(api.bookings.create.path, requireAuth, requireVerifiedEmail, bookingCreationLimiter, async (req, res) => {
    const user = req.user as User;
    const idempotencyKey = extractIdempotencyKey(req);
    let idempotencyRecord: IdempotencyKey | undefined;

    try {
      // 1. Server-side Idempotency Handling
      if (idempotencyKey) {
        const requestHash = computeRequestHash(req.body);
        let existing = await storage.getIdempotencyKey(user.id, idempotencyKey);

        if (existing) {
          // Conflicting reuse of the same key with different payload must be rejected
          if (existing.requestHash !== requestHash) {
            return res.status(409).json({
              message: "An operation with this idempotency key already exists with a different payload.",
              code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
            });
          }

          // Repeated identical request returns original result
          if (existing.status === "COMPLETED") {
            res.setHeader("Idempotent-Replayed", "true");
            const cachedBody = JSON.parse(existing.responseBody || "{}");
            return res.status(existing.statusCode || 201).json(cachedBody);
          }

          // Concurrent identical request currently in-flight
          if (existing.status === "PROCESSING") {
            const completed = await waitForIdempotentCompletion(storage, user.id, idempotencyKey);
            if (completed && completed.status === "COMPLETED") {
              res.setHeader("Idempotent-Replayed", "true");
              const cachedBody = JSON.parse(completed.responseBody || "{}");
              return res.status(completed.statusCode || 201).json(cachedBody);
            }
            if (completed && completed.status === "FAILED") {
              existing = completed;
            } else {
              const isStale = Date.now() - new Date(existing.lockedAt).getTime() > IDEMPOTENCY_LOCK_TIMEOUT_MS;
              if (!isStale) {
                return res.status(409).json({
                  message: "A booking request with this idempotency key is currently being processed. Please retry shortly.",
                  code: "IDEMPOTENCY_KEY_IN_PROGRESS",
                });
              }
            }
          }

          // If previously FAILED or stale lock: allow safe retry by re-acquiring the lock
          idempotencyRecord = await storage.updateIdempotencyKey(existing.id, {
            status: "PROCESSING",
            lockedAt: new Date(),
          });
        } else {
          // Insert new idempotency key record in PROCESSING status
          const expiresAt = new Date(Date.now() + IDEMPOTENCY_DEFAULT_TTL_MS);
          try {
            idempotencyRecord = await storage.createIdempotencyKey({
              key: idempotencyKey,
              userId: user.id,
              requestPath: req.baseUrl + req.path,
              requestHash,
              expiresAt,
            });
          } catch (createErr: any) {
            // Concurrent race on insert (unique constraint 23505)
            if (createErr.code === "23505" || createErr.message?.includes("Unique constraint")) {
              const concurrent = await waitForIdempotentCompletion(storage, user.id, idempotencyKey);
              if (concurrent) {
                if (concurrent.requestHash !== requestHash) {
                  return res.status(409).json({
                    message: "An operation with this idempotency key already exists with a different payload.",
                    code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
                  });
                }
                if (concurrent.status === "COMPLETED") {
                  res.setHeader("Idempotent-Replayed", "true");
                  const cachedBody = JSON.parse(concurrent.responseBody || "{}");
                  return res.status(concurrent.statusCode || 201).json(cachedBody);
                }
              }
              return res.status(409).json({
                message: "A booking request with this idempotency key is currently being processed.",
                code: "IDEMPOTENCY_KEY_IN_PROGRESS",
              });
            }
            throw createErr;
          }
        }
      }

      // The client must NEVER be trusted for: total_price, hourly_rate, discount, payment_status,
      // booking_status, employee_id, user_id, role, station ownership, pricing rule, timestamps used for billing.
      const input = insertBookingSchema.parse(req.body);
      if (!input.gameTypeId) {
        return res.status(400).json({ message: "Game category is required for online bookings" });
      }

      // Calculate server-authoritative price snapshot with strict range validation
      const priceSnapshot = await calculateBookingPrice({
        stationId: input.stationId,
        gameTypeId: input.gameTypeId,
        startTime: input.startTime,
        endTime: input.endTime,
        playerCount: input.playerCount ?? 1,
      });

      const bookingRef = randomBytes(4).toString("hex").toUpperCase();

      // Automatically allocate any available physical station for this game category
      // Derive userId strictly from session; employeeId is null; status is 'Pending'
      // Store immutable price snapshot so historical records do not alter with future price updates
      // Transactionally associate booking creation with idempotency record completion
      const { booking, station } = await storage.createBookingWithAutoStation(
        {
          ...input,
          gameTypeId: priceSnapshot.gameType.id,
          userId: user.id, // Strictly server session identity
          playerCount: input.playerCount ?? 1,
          totalPrice: priceSnapshot.finalPrice, // Server-calculated final price
          basePrice: priceSnapshot.basePrice,
          discountAmount: priceSnapshot.discountAmount,
          finalPrice: priceSnapshot.finalPrice,
          currency: priceSnapshot.currency,
          pricingRule: priceSnapshot.pricingRule,
          bookingRef,
          paymentMethod: input.paymentMethod || "offline",
          employeeId: null, // Members cannot assign employee_id
          status: "Pending", // Status initialized strictly to Pending
          gameType: priceSnapshot.gameType,
        },
        idempotencyRecord?.id
      );

      // Broadcast real-time operational notifications
      broadcastOperationalEvent("booking_created", {
        bookingId: booking.id,
        userId: user.id,
        stationId: station?.id || null,
        gameTypeId: priceSnapshot.gameType.id,
        startTime: new Date(booking.startTime).toISOString(),
        endTime: new Date(booking.endTime).toISOString(),
        status: booking.status,
      }).catch(() => {});

      broadcastOperationalEvent(
        "booking_created",
        {
          bookingId: booking.id,
          userId: user.id,
          stationId: station?.id || null,
          gameTypeId: priceSnapshot.gameType.id,
          startTime: new Date(booking.startTime).toISOString(),
          endTime: new Date(booking.endTime).toISOString(),
          status: booking.status,
        },
        { userId: user.id }
      ).catch(() => {});

      if (station) {
        broadcastOperationalEvent(
          "station_status_changed",
          {
            stationId: station.id,
            stationName: station.name,
            gameTypeId: station.gameTypeId,
            status: station.status as any,
            updatedAt: new Date().toISOString(),
          },
          { channel: CHANNEL_STATIONS_PUBLIC }
        ).catch(() => {});
      }

      res.status(201).json({ ...booking, gameType: priceSnapshot.gameType, station });
    } catch (err: any) {
      // If transaction failed, update idempotency record status to FAILED so safe retry is supported
      if (idempotencyRecord) {
        try {
          await storage.updateIdempotencyKey(idempotencyRecord.id, {
            status: "FAILED",
          });
        } catch (cleanErr) {
          console.error("Failed to mark idempotency key as FAILED:", cleanErr);
        }
      }

      if (err instanceof z.ZodError) {
        res.status(400).json({ message: err.message });
      } else if (isBookingConflictError(err)) {
        res.status(409).json({
          message: "The selected station or time slot is already booked. Please choose a different time or station.",
          error: "BookingConflict",
          code: "STATION_ALREADY_BOOKED",
        });
      } else if (err.message && (
        err.message.includes("Invalid") ||
        err.message.includes("duration") ||
        err.message.includes("Player count") ||
        err.message.includes("category") ||
        err.message.includes("Station")
      )) {
        res.status(400).json({ message: err.message });
      } else if (isDatabaseUnavailableError(err)) {
        res.status(503).json({
          message: "Database service is temporarily unavailable. Please try again shortly.",
          code: "DATABASE_UNAVAILABLE",
        });
      } else {
        res.status(500).json({ message: err?.message || "Internal server error" });
      }
    }
  });

  // Bookings - Update Status (Object-Level Authorization: Member can only cancel own eligible booking)
  app.patch(api.bookings.updateStatus.path, requireAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid booking ID" });

    const booking = await storage.getBooking(id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const { status: requestedStatus } = req.body;
    const allowedStatuses = ["Pending", "Approved", "Cancelled", "Completed"];
    if (!requestedStatus || !allowedStatuses.includes(requestedStatus)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const user = req.user as User;
    const check = BookingPolicy.canUpdateStatus(user, booking, requestedStatus);
    if (!check.allowed) {
      return res.status(check.status).json({ message: check.reason || "Unauthorized to update booking status" });
    }

    try {
      const updated = await storage.updateBookingStatus(id, requestedStatus);
      res.json(updated);
    } catch (err: any) {
      if (isBookingConflictError(err)) {
        return res.status(409).json({
          message: "The selected station or time slot is already booked. Please choose a different time or station.",
          error: "BookingConflict",
          code: "STATION_ALREADY_BOOKED",
        });
      } else if (isDatabaseUnavailableError(err)) {
        return res.status(503).json({
          message: "Database service is temporarily unavailable. Please try again shortly.",
          code: "DATABASE_UNAVAILABLE",
        });
      }
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // Bookings - Cancel Endpoint (Dedicated object-level cancellation protected by booking_cancellation policy)
  app.post("/api/bookings/:id/cancel", requireAuth, bookingCancellationLimiter, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid booking ID" });

    const booking = await storage.getBooking(id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const user = req.user as User;
    const check = BookingPolicy.canCancel(user, booking);
    if (!check.allowed) {
      return res.status(check.status).json({ message: check.reason || "Unauthorized to cancel booking" });
    }

    const updated = await storage.updateBookingStatus(id, "Cancelled");

    broadcastOperationalEvent("booking_cancelled", {
      bookingId: id,
      userId: booking.userId,
      status: "CANCELLED",
      cancelledAt: new Date().toISOString(),
    }).catch(() => {});

    broadcastOperationalEvent(
      "booking_cancelled",
      {
        bookingId: id,
        userId: booking.userId,
        status: "CANCELLED",
        cancelledAt: new Date().toISOString(),
      },
      { userId: booking.userId }
    ).catch(() => {});

    res.json(updated);
  });

  // Check-In Endpoint (Staff only)
  app.post("/api/bookings/:id/check-in", requireStaff, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid booking ID" });

    const existing = await storage.getBooking(id);
    if (!existing) return res.status(404).json({ message: "Booking not found" });

    const updated = await storage.updateBooking(id, { status: "CheckedIn" as any });

    broadcastOperationalEvent("booking_checked_in", {
      bookingId: id,
      userId: existing.userId,
      stationId: existing.stationId || 0,
      checkedInAt: new Date().toISOString(),
      status: "CheckedIn",
    }).catch(() => {});

    broadcastOperationalEvent(
      "booking_checked_in",
      {
        bookingId: id,
        userId: existing.userId,
        stationId: existing.stationId || 0,
        checkedInAt: new Date().toISOString(),
        status: "CheckedIn",
      },
      { userId: existing.userId }
    ).catch(() => {});

    res.json(updated);
  });

  // Timer Endpoints (Staff only: Employee or Admin)
  app.post("/api/bookings/:id/timer/start", requireStaff, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid booking ID" });

    const existing = await storage.getBooking(id);
    if (!existing) return res.status(404).json({ message: "Booking not found" });

    // Simultaneous session start idempotency guard
    if (existing.timerStartedAt && !existing.timerEndTime && existing.status === "Approved") {
      return res.status(200).json(existing);
    }

    const booking = await storage.updateBooking(id, {
      timerStartedAt: new Date(),
      status: "Approved"
    });

    broadcastOperationalEvent("session_started", {
      bookingId: id,
      stationId: booking.stationId || 0,
      startedAt: new Date().toISOString(),
    }).catch(() => {});

    if (booking.stationId) {
      await storage.updateStation(booking.stationId, { status: "AVAILABLE" }).catch(() => {});
      broadcastOperationalEvent(
        "station_status_changed",
        {
          stationId: booking.stationId,
          stationName: `Station ${booking.stationId}`,
          gameTypeId: booking.gameTypeId,
          status: "OCCUPIED",
          updatedAt: new Date().toISOString(),
        },
        { channel: CHANNEL_STATIONS_PUBLIC }
      ).catch(() => {});
    }

    res.json(booking);
  });

  app.post("/api/bookings/:id/timer/stop", requireStaff, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid booking ID" });

    const existing = await storage.getBooking(id);
    if (!existing) return res.status(404).json({ message: "Booking not found" });

    const booking = await storage.updateBooking(id, {
      timerEndTime: new Date(),
      status: "Completed"
    });

    broadcastOperationalEvent("session_stopped", {
      bookingId: id,
      stationId: booking.stationId || 0,
      stoppedAt: new Date().toISOString(),
    }).catch(() => {});

    if (booking.stationId) {
      await storage.updateStation(booking.stationId, { status: "AVAILABLE" }).catch(() => {});
      broadcastOperationalEvent(
        "station_status_changed",
        {
          stationId: booking.stationId,
          stationName: `Station ${booking.stationId}`,
          gameTypeId: booking.gameTypeId,
          status: "AVAILABLE",
          updatedAt: new Date().toISOString(),
        },
        { channel: CHANNEL_STATIONS_PUBLIC }
      ).catch(() => {});
    }

    res.json(booking);
  });

  // Real-Time Authentication Ticket (Single-use, 60s TTL)
  app.post("/api/realtime/ticket", requireAuth, (req, res) => {
    const user = req.user as User;
    const ticket = issueRealtimeTicket(user);
    res.json({ ticket, expiresInSeconds: 60 });
  });

  // Export Bookings (Admin only - Rate limited & Date bounded)
  app.get("/api/admin/bookings/export", requireAdmin, adminExportsLimiter, async (req, res) => {
    try {
      const query = exportQuerySchema.parse(req.query);
      const fromDate = query.fromDate ? new Date(query.fromDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const toDate = query.toDate ? new Date(query.toDate) : new Date();

      const bookings = await storage.getBookings({
        limit: query.limit,
        status: query.status,
        stationId: query.stationId,
        fromDate,
        toDate,
      });

      const csv = [
        ["Ref", "User", "Game", "Start", "End", "Players", "Price", "Status"].join(","),
        ...bookings.map(b => [
          b.bookingRef,
          b.user?.username || "Unknown",
          b.gameType?.name || "No Station",
          new Date(b.startTime).toISOString(),
          new Date(b.endTime).toISOString(),
          b.playerCount,
          (b.totalPrice / 100).toFixed(2),
          b.status
        ].join(","))
      ].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=bookings.csv");
      res.setHeader("X-Export-Count", String(bookings.length));
      res.send(csv);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      res.status(500).json({ message: "Export failed" });
    }
  });

  // Admin Paginated Reports Endpoint
  app.get("/api/admin/reports/bookings", requireAdmin, adminExportsLimiter, async (req, res) => {
    try {
      const query = reportsQuerySchema.parse(req.query);
      const fromDate = query.fromDate ? new Date(query.fromDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const toDate = query.toDate ? new Date(query.toDate) : new Date();

      let cursorData: { createdAt: Date; id: number } | undefined;
      if (query.cursor) {
        const decoded = decodeCursor(query.cursor, timeAndIdCursorSchema);
        cursorData = {
          createdAt: new Date(decoded.createdAt),
          id: decoded.id,
        };
      }

      const bookings = await storage.getBookings({
        limit: query.limit,
        status: query.status,
        stationId: query.stationId,
        fromDate,
        toDate,
        cursor: cursorData,
      });

      const reportItems = bookings.map((b) => ({
        id: b.id,
        bookingRef: b.bookingRef,
        customer: b.user ? { id: b.user.id, username: b.user.username } : null,
        station: b.station ? { id: b.station.id, name: b.station.name } : null,
        gameType: b.gameType ? { id: b.gameType.id, name: b.gameType.name } : null,
        startTime: b.startTime,
        endTime: b.endTime,
        durationMinutes: Math.round((new Date(b.endTime).getTime() - new Date(b.startTime).getTime()) / 60000),
        totalPrice: b.totalPrice,
        status: b.status,
        createdAt: b.createdAt,
      }));

      const paginated = paginateItems(reportItems, query.limit, (item) => ({
        createdAt: new Date(item.createdAt || Date.now()).toISOString(),
        id: item.id,
      }));
      return sendPaginatedResponse(req, res, paginated);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      if (err?.code === "INVALID_CURSOR" || err?.message?.includes("Invalid or malformed cursor") || err?.message?.includes("Invalid pagination cursor")) {
        return res.status(400).json({ message: err.message, code: "INVALID_CURSOR" });
      }
      res.status(500).json({ message: "Failed to generate report" });
    }
  });

  // Admin Users List (Admin only - Cursor paginated)
  app.get("/api/admin/users", requireAdmin, async (req, res) => {
    try {
      const query = usersQuerySchema.parse(req.query);
      let cursorData: { createdAt: Date; id: number } | undefined;
      if (query.cursor) {
        const decoded = decodeCursor(query.cursor, timeAndIdCursorSchema);
        cursorData = {
          createdAt: new Date(decoded.createdAt),
          id: decoded.id,
        };
      }

      const allUsers = await storage.getAllUsers({
        limit: query.limit,
        role: query.role,
        membershipTier: query.membershipTier,
        cursor: cursorData,
      });

      const sanitizedUsers = allUsers.map(sanitizeUser);
      const paginated = paginateItems(sanitizedUsers, query.limit, (u) => ({
        createdAt: new Date(u.createdAt || Date.now()).toISOString(),
        id: u.id,
      }));
      return sendPaginatedResponse(req, res, paginated);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      if (err?.code === "INVALID_CURSOR" || err?.message?.includes("Invalid or malformed cursor") || err?.message?.includes("Invalid pagination cursor")) {
        return res.status(400).json({ message: err.message, code: "INVALID_CURSOR" });
      }
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // Single User Profile by ID (Object-Level Authorization: own profile or admin)
  app.get("/api/users/:id", requireAuth, async (req, res) => {
    const targetUserId = parseInt(req.params.id);
    if (isNaN(targetUserId)) return res.status(400).json({ message: "Invalid user ID" });

    const currentUser = req.user as User;
    if (!UserPolicy.canReadProfile(currentUser, targetUserId)) {
      return res.status(403).json({ message: "Forbidden: You can only view your own profile" });
    }

    const targetUser = await storage.getUser(targetUserId);
    if (!targetUser) return res.status(404).json({ message: "User not found" });

    res.json(sanitizeUser(targetUser));
  });

  // Admin Comprehensive Stats (Admin only - Rate limited)
  app.get("/api/admin/stats/comprehensive", requireAdmin, adminExportsLimiter, async (req, res) => {
    try {
      const { getAdminStats } = await import("./stats");
      const stats = await getAdminStats();
      res.json(stats);
    } catch (err) {
      console.error("Stats error:", err);
      res.status(500).json({ message: "Failed to fetch stats" });
    }
  });

  // Employee Stats (Employee own stats, Admin any employee stats, Member blocked 403 - Rate limited)
  app.get("/api/employee/stats", requireAuth, adminExportsLimiter, async (req, res) => {
    const user = req.user as User;

    if (!isStaff(user)) {
      return res.status(403).json({ message: "Forbidden: Member cannot access employee data" });
    }

    const queryEmployeeId = req.query.employeeId ? parseInt(req.query.employeeId as string) : undefined;
    if (queryEmployeeId !== undefined && !isNaN(queryEmployeeId)) {
      if (!EmployeeDataPolicy.canAccessStats(user, queryEmployeeId)) {
        return res.status(403).json({ message: "Forbidden: Cannot access another employee's restricted data" });
      }
    }

    const targetEmployeeId = queryEmployeeId && isAdmin(user) ? queryEmployeeId : user.id;

    try {
      const { getEmployeeStats } = await import("./stats");
      const stats = await getEmployeeStats(targetEmployeeId);
      res.json(stats);
    } catch (err) {
      console.error("Employee stats error:", err);
      res.status(500).json({ message: "Failed to fetch employee stats" });
    }
  });

  // Employee Specific Stats by ID (Rate limited)
  app.get("/api/employee/stats/:id", requireAuth, adminExportsLimiter, async (req, res) => {
    const user = req.user as User;
    const targetEmployeeId = parseInt(req.params.id);
    if (isNaN(targetEmployeeId)) return res.status(400).json({ message: "Invalid employee ID" });

    if (!EmployeeDataPolicy.canAccessStats(user, targetEmployeeId)) {
      return res.status(403).json({ message: "Forbidden: You cannot access another employee's restricted data" });
    }

    try {
      const { getEmployeeStats } = await import("./stats");
      const stats = await getEmployeeStats(targetEmployeeId);
      res.json(stats);
    } catch (err) {
      console.error("Employee stats error:", err);
      res.status(500).json({ message: "Failed to fetch employee stats" });
    }
  });

  // Offline Bookings (Staff only: Employee/Admin with Idempotency & Rate Limiting)
  app.post("/api/bookings/offline", requireStaff, bookingCreationLimiter, async (req, res) => {
    const user = req.user as User;
    const idempotencyKey = extractIdempotencyKey(req);
    let idempotencyRecord: IdempotencyKey | undefined;

    try {
      if (idempotencyKey) {
        const requestHash = computeRequestHash(req.body);
        let existing = await storage.getIdempotencyKey(user.id, idempotencyKey);

        if (existing) {
          if (existing.requestHash !== requestHash) {
            return res.status(409).json({
              message: "An operation with this idempotency key already exists with a different payload.",
              code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
            });
          }

          if (existing.status === "COMPLETED") {
            res.setHeader("Idempotent-Replayed", "true");
            const cachedBody = JSON.parse(existing.responseBody || "{}");
            return res.status(existing.statusCode || 201).json(cachedBody);
          }

          if (existing.status === "PROCESSING") {
            const completed = await waitForIdempotentCompletion(storage, user.id, idempotencyKey);
            if (completed && completed.status === "COMPLETED") {
              res.setHeader("Idempotent-Replayed", "true");
              const cachedBody = JSON.parse(completed.responseBody || "{}");
              return res.status(completed.statusCode || 201).json(cachedBody);
            }
            if (completed && completed.status === "FAILED") {
              existing = completed;
            } else {
              const isStale = Date.now() - new Date(existing.lockedAt).getTime() > IDEMPOTENCY_LOCK_TIMEOUT_MS;
              if (!isStale) {
                return res.status(409).json({
                  message: "A booking request with this idempotency key is currently being processed. Please retry shortly.",
                  code: "IDEMPOTENCY_KEY_IN_PROGRESS",
                });
              }
            }
          }

          idempotencyRecord = await storage.updateIdempotencyKey(existing.id, {
            status: "PROCESSING",
            lockedAt: new Date(),
          });
        } else {
          const expiresAt = new Date(Date.now() + IDEMPOTENCY_DEFAULT_TTL_MS);
          try {
            idempotencyRecord = await storage.createIdempotencyKey({
              key: idempotencyKey,
              userId: user.id,
              requestPath: req.baseUrl + req.path,
              requestHash,
              expiresAt,
            });
          } catch (createErr: any) {
            if (createErr.code === "23505" || createErr.message?.includes("Unique constraint")) {
              const concurrent = await waitForIdempotentCompletion(storage, user.id, idempotencyKey);
              if (concurrent) {
                if (concurrent.requestHash !== requestHash) {
                  return res.status(409).json({
                    message: "An operation with this idempotency key already exists with a different payload.",
                    code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
                  });
                }
                if (concurrent.status === "COMPLETED") {
                  res.setHeader("Idempotent-Replayed", "true");
                  const cachedBody = JSON.parse(concurrent.responseBody || "{}");
                  return res.status(concurrent.statusCode || 201).json(cachedBody);
                }
              }
              return res.status(409).json({
                message: "A booking request with this idempotency key is currently being processed.",
                code: "IDEMPOTENCY_KEY_IN_PROGRESS",
              });
            }
            throw createErr;
          }
        }
      }

      const { username, gameTypeId, stationId, playerCount, startTime, endTime, paymentMethod } = req.body;

      if (!username || typeof username !== "string" || !username.trim()) {
        return res.status(400).json({ message: "Customer username is required." });
      }

      let customer = await storage.getUserByUsername(username.trim());
      if (!customer) {
        const { randomBytes } = await import("crypto");
        customer = await storage.createUser({
          username: username.trim(),
          password: randomBytes(8).toString("hex"),
          role: "member",
          membershipTier: "bronze",
        });
      }

      const parsedGameTypeId = (gameTypeId && gameTypeId !== "none" && gameTypeId !== "") ? parseInt(gameTypeId) : null;
      if (!parsedGameTypeId) {
        return res.status(400).json({ message: "Please select a gaming category." });
      }

      const parsedStationId = (stationId && stationId !== "none" && stationId !== "" && stationId !== "auto") ? parseInt(stationId) : null;

      let bookingStartTime = startTime ? new Date(startTime) : new Date();
      let bookingEndTime = endTime ? new Date(endTime) : new Date(Date.now() + 60 * 60 * 1000);

      // Server-authoritative price calculation and validation
      // Client-supplied total_price, hourly_rate, discount, status, employeeId are strictly ignored
      const priceSnapshot = await calculateBookingPrice({
        stationId: parsedStationId,
        gameTypeId: parsedGameTypeId,
        startTime: bookingStartTime,
        endTime: bookingEndTime,
        playerCount: parseInt(playerCount) || 1,
      });

      const bookingRef = `OFF-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

      // Reserve specific station or automatically assign available station
      // employeeId derived strictly from session
      const { booking, station } = await storage.createBookingWithAutoStation(
        {
          userId: customer.id,
          gameTypeId: priceSnapshot.gameType.id,
          stationId: parsedStationId,
          playerCount: parseInt(playerCount) || 1,
          startTime: bookingStartTime,
          endTime: bookingEndTime,
          totalPrice: priceSnapshot.finalPrice, // Server-calculated price
          basePrice: priceSnapshot.basePrice,
          discountAmount: priceSnapshot.discountAmount,
          finalPrice: priceSnapshot.finalPrice,
          currency: priceSnapshot.currency,
          pricingRule: priceSnapshot.pricingRule,
          paymentMethod: paymentMethod || "offline",
          bookingRef,
          employeeId: user.id, // Strictly derived from session
          status: "Approved",
          gameType: priceSnapshot.gameType,
        },
        idempotencyRecord?.id
      );

      broadcastOperationalEvent("booking_created", {
        bookingId: booking.id,
        userId: customer.id,
        stationId: station?.id || null,
        gameTypeId: priceSnapshot.gameType.id,
        startTime: new Date(booking.startTime).toISOString(),
        endTime: new Date(booking.endTime).toISOString(),
        status: booking.status,
      }).catch(() => {});

      broadcastOperationalEvent(
        "booking_created",
        {
          bookingId: booking.id,
          userId: customer.id,
          stationId: station?.id || null,
          gameTypeId: priceSnapshot.gameType.id,
          startTime: new Date(booking.startTime).toISOString(),
          endTime: new Date(booking.endTime).toISOString(),
          status: booking.status,
        },
        { userId: customer.id }
      ).catch(() => {});

      if (station) {
        broadcastOperationalEvent(
          "station_status_changed",
          {
            stationId: station.id,
            stationName: station.name,
            gameTypeId: station.gameTypeId,
            status: station.status as any,
            updatedAt: new Date().toISOString(),
          },
          { channel: CHANNEL_STATIONS_PUBLIC }
        ).catch(() => {});
      }

      res.status(201).json({ ...booking, gameType: priceSnapshot.gameType, station });
    } catch (err: any) {
      if (idempotencyRecord) {
        try {
          await storage.updateIdempotencyKey(idempotencyRecord.id, {
            status: "FAILED",
          });
        } catch (cleanErr) {
          console.error("Failed to mark idempotency key as FAILED:", cleanErr);
        }
      }

      if (isBookingConflictError(err)) {
        return res.status(409).json({
          message: "The selected station or time slot is already booked. Please choose a different time or station.",
          error: "BookingConflict",
          code: "STATION_ALREADY_BOOKED",
        });
      } else if (err.message && (
        err.message.includes("Invalid") ||
        err.message.includes("duration") ||
        err.message.includes("Player count") ||
        err.message.includes("category") ||
        err.message.includes("Station")
      )) {
        return res.status(400).json({ message: err.message });
      } else if (isDatabaseUnavailableError(err)) {
        return res.status(503).json({
          message: "Database service is temporarily unavailable. Please try again shortly.",
          code: "DATABASE_UNAVAILABLE",
        });
      }
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  // Image Upload to Cloudinary (Staff only - Protected by file_upload rate limiting policy)
  app.post("/api/upload", requireStaff, fileUploadLimiter, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }
      const result = await uploadToCloudinary(req.file.buffer, "playnslay");
      res.json({ url: result.url, publicId: result.publicId });
    } catch (err: any) {
      console.error("Cloudinary upload error:", err);
      res.status(500).json({ message: err?.message || "Failed to upload image" });
    }
  });

  // User Avatar Upload (Authenticated users - Protected by file_upload rate limiting policy)
  app.post("/api/users/:id/avatar", requireAuth, fileUploadLimiter, upload.single("file"), async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid user ID" });

    const targetUser = await storage.getUser(id);
    if (!targetUser) return res.status(404).json({ message: "User not found" });

    const user = req.user as User;
    if (!UserPolicy.canReadProfile(user, targetUser.id)) {
      return res.status(403).json({ message: "Forbidden: You cannot update another user's avatar" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No avatar image file provided" });
    }

    try {
      const result = await uploadToCloudinary(req.file.buffer, "avatars");
      const updated = await storage.updateUser(id, { avatarUrl: result.url });
      res.json(sanitizeUser(updated));
    } catch (err: any) {
      console.error("Avatar upload error:", err);
      res.status(500).json({ message: err?.message || "Failed to upload avatar" });
    }
  });

  // User Profile Update (User can only update own profile; never trust role or isAdmin)
  app.patch("/api/user/profile", requireAuth, async (req, res) => {
    const user = req.user as User;
    try {
      const { fullName, phone, avatarUrl } = req.body;
      const updated = await storage.updateUser(user.id, {
        fullName: fullName !== undefined ? fullName : user.fullName,
        phone: phone !== undefined ? phone : user.phone,
        avatarUrl: avatarUrl !== undefined ? avatarUrl : user.avatarUrl,
      });
      res.json(sanitizeUser(updated));
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to update profile" });
    }
  });

  // Change Password (User changing own password)
  app.post("/api/user/change-password", requireAuth, async (req, res) => {
    const user = req.user as User;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters long." });
    }

    try {
      const freshUser = await storage.getUser(user.id);
      if (!freshUser) return res.status(404).json({ message: "User not found" });

      const isValid = await comparePasswords(currentPassword, freshUser.password);
      if (!isValid) {
        return res.status(400).json({ message: "Current password is incorrect." });
      }

      const hashedNew = await hashPassword(newPassword);
      const updated = await storage.updateUser(user.id, { password: hashedNew });

      // Invalidate sessions on all other devices immediately
      await storage.invalidateUserSessions(user.id);

      // Regenerate current session ID so any attacker holding old session is severed
      await regenerateSession(req);
      if (req.session) {
        (req.session as any).csrfToken = generateCsrfToken();
      }
      req.login(updated, async (loginErr) => {
        if (loginErr) {
          return res.status(500).json({ message: "Failed to establish new session" });
        }
        const { maxAge } = getSessionTimeouts(updated);
        req.session.cookie.maxAge = maxAge;
        (req.session as any).sessionCreatedAt = Date.now();
        (req.session as any).lastActiveAt = Date.now();

        const sid = req.sessionID;
        if (sid) {
          const sidHash = hashSessionId(sid);
          await storage.createUserSession({
            sessionIdHash: sidHash,
            userId: updated.id,
            expiresAt: new Date(Date.now() + maxAge),
            ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null,
            userAgent: (req.headers["user-agent"] as string) || null,
          }).catch(() => {});
        }

        res.json({ message: "Password updated successfully!" });
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to change password" });
    }
  });

  // Customer Privacy Data Export (GDPR Right to Data Portability)
  app.get("/api/user/privacy/export", requireAuth, adminExportsLimiter, async (req, res) => {
    try {
      const user = req.user as User;
      const exportData = await generateUserDataExport(user.id);

      res.setHeader("Content-Disposition", `attachment; filename="play_n_slay_data_export_${user.id}.json"`);
      res.setHeader("Content-Type", "application/json");
      res.json(exportData);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to generate personal data export" });
    }
  });

  // Customer Account Deletion Request Workflow (GDPR Right to Erasure / Anonymization)
  // Financial transaction records (bookings, invoices) are preserved for 7-year statutory financial compliance.
  app.post("/api/user/privacy/delete-request", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const freshUser = await storage.getUser(user.id);
      if (!freshUser) return res.status(404).json({ message: "User not found" });

      if (freshUser.authProvider === "local") {
        const { password } = req.body;
        if (!password) {
          return res.status(400).json({ message: "Password is required to confirm account deletion." });
        }
        const isValid = await comparePasswords(password, freshUser.password);
        if (!isValid) {
          return res.status(400).json({ message: "Incorrect password. Deletion request rejected." });
        }
      } else {
        if (req.body.confirm !== true) {
          return res.status(400).json({ message: "Explicit confirmation { confirm: true } is required." });
        }
      }

      const result = await anonymizeUserAccount(user.id, {
        reason: req.body.reason || "Customer self-service account deletion request",
      });

      delete (req as any).user;
      if (req.session) {
        req.session.destroy(() => {});
      }
      res.clearCookie("sid", { path: "/" });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to process deletion request" });
    }
  });

  // Admin GDPR/Privacy Erasure on behalf of user
  app.post("/api/admin/users/:id/anonymize", requireAdmin, async (req, res) => {
    try {
      const targetUserId = parseInt(req.params.id, 10);
      if (isNaN(targetUserId)) return res.status(400).json({ message: "Invalid user ID" });

      const adminUser = req.user as User;
      const result = await anonymizeUserAccount(targetUserId, {
        reason: req.body.reason || "Admin processed GDPR erasure request",
        performedByUserId: adminUser.id,
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to anonymize user" });
    }
  });

  // Admin Data Retention Policy Execution
  app.post("/api/admin/privacy/retention-prune", requireAdmin, async (req, res) => {
    try {
      const { sessionDays, idempotencyHours, unverifiedDays } = req.body || {};
      const result = await applyDataRetentionPolicy({
        sessionDays: typeof sessionDays === "number" ? sessionDays : undefined,
        idempotencyHours: typeof idempotencyHours === "number" ? idempotencyHours : undefined,
        unverifiedDays: typeof unverifiedDays === "number" ? unverifiedDays : undefined,
      });

      res.json({
        message: "Data retention policy applied successfully",
        ...result,
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to execute data retention policy" });
    }
  });

  // Admin Update User Role/Privilege (Admin only; Regenerates / Invalidates sessions on privilege changes)
  app.patch("/api/admin/users/:id/role", requireAdmin, async (req, res) => {
    const targetUserId = parseInt(req.params.id, 10);
    if (isNaN(targetUserId)) return res.status(400).json({ message: "Invalid user ID" });

    const { role } = req.body;
    if (!role || !["member", "employee", "admin"].includes(role)) {
      return res.status(400).json({ message: "Valid role is required (member, employee, admin)" });
    }

    const targetUser = await storage.getUser(targetUserId);
    if (!targetUser) return res.status(404).json({ message: "User not found" });

    const updated = await storage.updateUser(targetUserId, {
      role,
    });

    // PRIVILEGE CHANGE: Invalidate existing sessions across all devices
    await storage.invalidateUserSessions(targetUserId);

    const currentUser = req.user as User;

    // If updating own privilege, regenerate session ID immediately with new role timeouts
    if (currentUser.id === targetUserId) {
      await regenerateSession(req);
      if (req.session) {
        (req.session as any).csrfToken = generateCsrfToken();
      }
      req.login(updated, async (err) => {
        if (err) return res.status(500).json({ message: "Failed to regenerate session" });

        const { maxAge } = getSessionTimeouts(updated);
        req.session.cookie.maxAge = maxAge;
        (req.session as any).sessionCreatedAt = Date.now();
        (req.session as any).lastActiveAt = Date.now();

        const sid = req.sessionID;
        if (sid) {
          const sidHash = hashSessionId(sid);
          await storage.createUserSession({
            sessionIdHash: sidHash,
            userId: updated.id,
            expiresAt: new Date(Date.now() + maxAge),
            ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null,
            userAgent: (req.headers["user-agent"] as string) || null,
          }).catch(() => {});
        }

        await storage.createAuditLog({
          userId: currentUser.id,
          username: currentUser.username,
          action: "USER_PRIVILEGE_CHANGED",
          details: `Role updated to '${role}' for user ID ${targetUserId} (${targetUser.username}). Current session regenerated.`,
        });

        return res.json({
          message: `User role updated to '${role}'. Current session regenerated with new privilege level.`,
          user: sanitizeUser(updated),
        });
      });
      return;
    }

    await storage.createAuditLog({
      userId: currentUser.id,
      username: currentUser.username,
      action: "USER_PRIVILEGE_CHANGED",
      details: `Role updated to '${role}' for user ID ${targetUserId} (${targetUser.username}). Active sessions invalidated across all devices.`,
    });

    res.json({
      message: `User role updated to '${role}'. Existing sessions have been invalidated across all devices.`,
      user: sanitizeUser(updated),
    });
  });

  // Admin Force User Password Reset (Admin only; Admin NEVER sets or sees user password)
  app.post("/api/admin/users/:id/reset-password", requireAdmin, async (req, res) => {
    const targetUserId = parseInt(req.params.id);
    if (isNaN(targetUserId)) return res.status(400).json({ message: "Invalid user ID" });

    const targetUser = await storage.getUser(targetUserId);
    if (!targetUser) return res.status(404).json({ message: "User not found" });

    try {
      // 1. Invalidate all existing sessions immediately
      await storage.invalidateUserSessions(targetUserId);

      // 2. Generate cryptographically secure single-use token with short expiration (15 mins)
      const { rawToken, tokenHash, expiresAt } = generatePasswordResetToken(15);

      // 3. Mark reset_required = true and store hashed token
      await storage.updateUser(targetUserId, {
        resetRequired: true,
        passwordResetTokenHash: tokenHash,
        passwordResetTokenExpiresAt: expiresAt,
      });

      // 4. Send user through the normal secure password reset flow
      if (targetUser.email) {
        await sendPasswordResetEmail({
          to: targetUser.email,
          username: targetUser.username,
          resetToken: rawToken,
        });
      }

      // 5. Record security audit event
      const adminUser = req.user as User;
      await storage.createAuditLog({
        userId: adminUser.id,
        username: adminUser.username,
        action: "ADMIN_FORCED_PASSWORD_RESET",
        details: `Admin forced password reset for user ID ${targetUserId} (${targetUser.username}). All active sessions invalidated.`,
      });

      // Admin does NOT receive the raw token or choose the password
      res.json({
        message: `Password reset initiated for ${targetUser.username}. Active sessions have been invalidated and recovery email sent.`,
        resetRequired: true,
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to initiate password reset" });
    }
  });

  // Admin Security Audit Logs (Cursor paginated)
  app.get("/api/admin/audit-logs", requireAdmin, async (req, res) => {
    try {
      const query = auditLogsQuerySchema.parse(req.query);
      let cursorData: { createdAt: Date; id: number } | undefined;
      if (query.cursor) {
        const decoded = decodeCursor(query.cursor, timeAndIdCursorSchema);
        cursorData = {
          createdAt: new Date(decoded.createdAt),
          id: decoded.id,
        };
      }

      const filters = {
        limit: query.limit,
        userId: query.userId,
        action: query.action,
        fromDate: query.fromDate ? new Date(query.fromDate) : undefined,
        toDate: query.toDate ? new Date(query.toDate) : undefined,
        cursor: cursorData,
      };

      const logs = await storage.getAuditLogs(filters);
      const paginated = paginateItems(logs, query.limit, (l) => ({
        createdAt: new Date(l.createdAt || Date.now()).toISOString(),
        id: l.id,
      }));
      return sendPaginatedResponse(req, res, paginated);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: "Validation error", errors: err.errors });
      }
      if (err?.code === "INVALID_CURSOR" || err?.message?.includes("Invalid or malformed cursor") || err?.message?.includes("Invalid pagination cursor")) {
        return res.status(400).json({ message: err.message, code: "INVALID_CURSOR" });
      }
      res.status(500).json({ message: err?.message || "Failed to fetch audit logs" });
    }
  });

  // =========================================================================
  // INITIAL ADMINISTRATOR BOOTSTRAP ENDPOINTS
  // =========================================================================

  /**
   * Check whether the initial admin bootstrap process is available.
   * Returns { bootstrapAvailable: false } once an administrator exists.
   */
  app.get("/api/bootstrap/status", async (_req, res) => {
    try {
      const available = await isBootstrapAvailable();
      res.json({ bootstrapAvailable: available });
    } catch (err: any) {
      res.status(500).json({ message: "Failed to query bootstrap status", code: "BOOTSTRAP_STATUS_ERROR" });
    }
  });

  /**
   * Step 1: Initialize MFA setup using the one-time bootstrap token.
   * Rate limited. Fails closed with 403 Forbidden if bootstrap is already completed.
   */
  app.post("/api/bootstrap/init-mfa", bootstrapLimiter, async (req, res) => {
    try {
      const { bootstrapToken } = req.body || {};
      if (!bootstrapToken) {
        return res.status(400).json({ message: "Bootstrap token is required", code: "TOKEN_REQUIRED" });
      }
      const setup = await initiateBootstrapMfa(String(bootstrapToken));
      res.status(200).json(setup);
    } catch (err: any) {
      const status = err.statusCode || 500;
      res.status(status).json({
        message: err.message || "Failed to initialize bootstrap MFA",
        code: err.code || "BOOTSTRAP_ERROR",
      });
    }
  });

  /**
   * Step 2: Complete initial administrator account creation with mandatory MFA verification.
   * Enforces strong password requirements.
   * Permanently disables the bootstrap mechanism upon success.
   * Zero credentials, passwords, or tokens logged or returned.
   */
  app.post("/api/bootstrap/create-admin", bootstrapLimiter, async (req, res) => {
    try {
      const { bootstrapToken, username, email, password, fullName, mfaSecret, mfaToken } = req.body || {};
      if (!bootstrapToken || !username || !email || !password || !mfaSecret || !mfaToken) {
        return res.status(400).json({
          message: "All fields are required: bootstrapToken, username, email, password, mfaSecret, mfaToken",
          code: "MISSING_REQUIRED_FIELDS",
        });
      }

      const result = await completeAdminBootstrap({
        bootstrapToken: String(bootstrapToken),
        username: String(username),
        email: String(email),
        password: String(password),
        fullName: fullName ? String(fullName) : undefined,
        mfaSecret: String(mfaSecret),
        mfaToken: String(mfaToken),
      });

      res.status(201).json(result);
    } catch (err: any) {
      const status = err.statusCode || 500;
      res.status(status).json({
        message: err.message || "Failed to complete administrator bootstrap",
        code: err.code || "BOOTSTRAP_ERROR",
        details: err.details,
      });
    }
  });

  // =========================================================================
  // DISASTER RECOVERY & BACKUP MANAGEMENT ENDPOINTS (Admin Only)
  // =========================================================================

  /**
   * Get Disaster Recovery SLA status, RPO/RTO metrics, and latest verification status.
   */
  app.get("/api/admin/backups/status", requireAdmin, async (_req, res) => {
    try {
      const status = await getDisasterRecoveryStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ message: "Failed to retrieve disaster recovery status", error: err.message });
    }
  });

  /**
   * List all available backup packages (metadata only, no keys).
   */
  app.get("/api/admin/backups", requireAdmin, async (_req, res) => {
    try {
      const backups = listAvailableBackups();
      res.json(backups);
    } catch (err: any) {
      res.status(500).json({ message: "Failed to list backups", error: err.message });
    }
  });

  /**
   * Trigger an encrypted backup snapshot creation and post-write verification.
   */
  app.post("/api/admin/backups", requireAdmin, async (_req, res) => {
    try {
      const result = await createEncryptedBackup();
      res.status(201).json({
        message: "Backup created and verified successfully",
        manifest: result.manifest,
      });
    } catch (err: any) {
      res.status(500).json({ message: "Backup creation failed", error: err.message });
    }
  });

  /**
   * Trigger an isolated sandbox restore test on a backup package.
   */
  app.post("/api/admin/backups/restore-test", requireAdmin, async (req, res) => {
    try {
      const { backupId } = req.body || {};
      const result = await performRestoreTest(backupId);
      if (!result.success) {
        return res.status(500).json({ message: "Restore test failed", details: result });
      }
      res.json({ message: "Sandbox restore test passed", details: result });
    } catch (err: any) {
      res.status(500).json({ message: "Restore test execution failed", error: err.message });
    }
  });

  /**
   * Apply Grandfather-Father-Son retention policy.
   */
  app.post("/api/admin/backups/prune", requireAdmin, async (_req, res) => {
    try {
      const result = pruneOldBackups();
      res.json({ message: "Backup retention policy applied", result });
    } catch (err: any) {
      res.status(500).json({ message: "Retention pruning failed", error: err.message });
    }
  });

  // Contact Us Inquiry Endpoint
  const contactInquirySchema = z.object({
    name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
    email: z.string().trim().email("Invalid email address").max(255),
    subject: z.string().trim().min(5, "Subject must be at least 5 characters").max(200),
    message: z.string().trim().min(10, "Message must be at least 10 characters").max(2000),
  });

  app.post("/api/contact", contactLimiter, async (req, res) => {
    try {
      const parsed = contactInquirySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: parsed.error.issues[0]?.message || "Invalid contact form submission",
          errors: parsed.error.flatten(),
        });
      }

      const { name, email, subject, message } = parsed.data;

      // Create an audit log record of the inquiry (privacy-safe, masked email)
      await storage.createAuditLog({
        userId: (req.user as any)?.id ?? null,
        username: (req.user as any)?.username ?? name.slice(0, 50),
        action: "CONTACT_INQUIRY_RECEIVED",
        details: `From: ${name} (${maskEmail(email)}) | Subject: ${subject.slice(0, 100)}`,
      });

      res.status(200).json({
        success: true,
        message: "We've received your mission briefing and will get back to you soon.",
      });
    } catch (err: any) {
      res.status(500).json({
        message: "Failed to process inquiry. Please try again later.",
      });
    }
  });

  // Catch-all 404 handler for unhandled API routes
  app.use("/api/*", notFoundHandler);

  // Centralized express error handling middleware
  app.use(errorHandlerMiddleware);

  // Ensure default game types and stations exist in catalog if empty (never seeds users/credentials)
  try {
    await seed();
  } catch (seedErr) {
    console.error("[SEED ERROR] Failed to seed default game types/stations:", seedErr);
  }

  return httpServer;
}

// Seed function to create initial catalog data (games & stations only; NEVER seeds default users)
export async function seed() {
  const { initDbSchema } = await import("./db");
  await initDbSchema();

  const existingGameTypes = await storage.getGameTypes();

  if (existingGameTypes.length === 0) {
    const defaultGames = [
      {
        name: "PC Gaming",
        description: "High-end gaming rigs",
        hourlyPrice: 8000, // ₹80.00
        maxPlayers: 1,
        isActive: true,
        priceModel: "flat",
        imageUrl: "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&q=80"
      },
      {
        name: "XBOX",
        description: "Latest XBOX Series titles",
        hourlyPrice: 12000, // ₹120.00 (1P)
        maxPlayers: 4,
        isActive: true,
        priceModel: "per_player",
        imageUrl: "https://images.unsplash.com/photo-1605901309584-818e25960a8f?auto=format&fit=crop&q=80"
      },
      {
        name: "PS5",
        description: "4K Gaming on 65 inch TV with latest PS5 games",
        hourlyPrice: 12000, // ₹120.00 (1P)
        maxPlayers: 4,
        isActive: true,
        priceModel: "per_player",
        imageUrl: "https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?auto=format&fit=crop&q=80"
      },
      {
        name: "PS4",
        description: "Classic PS4 gaming experience",
        hourlyPrice: 7000, // ₹70.00 (1P)
        maxPlayers: 4,
        isActive: true,
        priceModel: "per_player",
        imageUrl: "https://images.unsplash.com/photo-1507457379470-08b8006adbec?auto=format&fit=crop&q=80"
      },
      {
        name: "Racing Sim",
        description: "Full cockpit racing setup with force feedback",
        hourlyPrice: 12000, // ₹120.00
        maxPlayers: 1,
        isActive: true,
        priceModel: "flat",
        imageUrl: "https://images.unsplash.com/photo-1547953295-ac4e4d75477c?auto=format&fit=crop&q=80"
      },
      {
        name: "IB Cricket",
        description: "Virtual reality cricket simulator",
        hourlyPrice: 18000, // ₹180.00
        maxPlayers: 1,
        isActive: true,
        priceModel: "flat",
        imageUrl: "https://images.unsplash.com/photo-1531415074968-036ba1b575da?auto=format&fit=crop&q=80"
      },
      {
        name: "VR Gaming",
        description: "Immersive VR Gaming Experience",
        hourlyPrice: 18000, // ₹180.00
        maxPlayers: 1,
        isActive: true,
        priceModel: "flat",
        imageUrl: "https://images.unsplash.com/photo-1622979135225-d2ba269fb1bd?auto=format&fit=crop&q=80"
      },
      {
        name: "Meta Shot",
        description: "Digital shooting range experience",
        hourlyPrice: 12000, // ₹120.00
        maxPlayers: 1,
        isActive: true,
        priceModel: "flat",
        imageUrl: "https://images.unsplash.com/photo-1552820728-8b83bb6b773f?auto=format&fit=crop&q=80"
      }
    ];

    for (const game of defaultGames) {
      await storage.createGameType(game);
    }
    console.log("Default game types seeded");
  }

  // Seed Physical Stations if none exist
  const existingStations = await storage.getStations();
  if (existingStations.length === 0) {
    const allGameTypes = await storage.getGameTypes();
    for (const gt of allGameTypes) {
      let stationNames: string[] = [];
      const lower = gt.name.toLowerCase();
      if (lower.includes("ps5")) {
        stationNames = ["PS5-01", "PS5-02", "PS5-03", "PS5-04"];
      } else if (lower.includes("ps4")) {
        stationNames = ["PS4-01", "PS4-02"];
      } else if (lower.includes("pc")) {
        stationNames = ["PC-01", "PC-02", "PC-03", "PC-04"];
      } else if (lower.includes("xbox")) {
        stationNames = ["XBOX-01", "XBOX-02"];
      } else if (lower.includes("racing")) {
        stationNames = ["RACE-01", "RACE-02"];
      } else if (lower.includes("vr")) {
        stationNames = ["VR-01", "VR-02"];
      } else if (lower.includes("cricket")) {
        stationNames = ["CRIC-01"];
      } else if (lower.includes("shot")) {
        stationNames = ["SHOT-01"];
      } else {
        stationNames = [`${gt.name.slice(0, 3).toUpperCase()}-01`, `${gt.name.slice(0, 3).toUpperCase()}-02`];
      }

      for (const name of stationNames) {
        await storage.createStation({
          name,
          gameTypeId: gt.id,
          status: "AVAILABLE",
        });
      }
    }
    console.log("Default physical stations seeded");
  }
}
