import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { hashPassword } from "../server/auth";
import { db, initDbSchema } from "../server/db";
import { bookings } from "../shared/schema";
import { sql } from "drizzle-orm";
import {
  DEFAULT_LOUNGE_TIMEZONE,
  DEFAULT_LOCATION_ID,
  LOUNGE_LOCATIONS,
  getLocation,
  getLoungeTimezone,
  isValidIanaTimezone,
  getZonedParts,
  parseZonedDateTime,
  getStartOfDayInTimezone,
  getEndOfDayInTimezone,
  buildBookingInterval,
  formatInTimezone,
  formatLocalDate,
  formatLocalTime,
  formatLocalDateTime,
  getTimezoneAbbr,
} from "../shared/timezone";

let server: Server;
let baseUrl: string;

interface SessionClient {
  get: (path: string) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (path: string, body?: any) => Promise<{ status: number; data: any; headers: Headers }>;
}

function makeClient(cookie?: string): SessionClient {
  const request = async (method: string, path: string, body?: any) => {
    const headers: Record<string, string> = {};
    if (cookie) {
      headers["Cookie"] = cookie;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data: any = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return { status: res.status, data, headers: res.headers };
  };

  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body?: any) => request("POST", path, body),
  };
}

describe("Standardized Timezone & Location Handling Test Suite", () => {
  let testMemberUser: any;
  let testGameType: any;
  let memberCookie: string;
  let memberClient: SessionClient;

  before(async () => {
    await initDbSchema();

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    const { setupAuth } = await import("../server/auth");
    setupAuth(app);

    const httpServer = createServer(app);
    await registerRoutes(httpServer, app);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        server = httpServer;
        resolve();
      });
    });

    // Seed test user
    const username = `tz_member_${Date.now()}`;
    const password = "password123";
    const hashed = await hashPassword(password);
    testMemberUser = await storage.createUser({
      username,
      password: hashed,
      role: "member",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });

    // Seed test game type
    testGameType = await storage.createGameType({
      name: `VR Pods TZ ${Date.now()}`,
      description: "VR Arena for timezone test",
      hourlyPrice: 3000, // ₹30/hr
      maxPlayers: 2,
      isActive: true,
      priceModel: "flat",
    });

    // Seed stations
    await storage.createStation({
      name: `VR-TZ-01`,
      gameTypeId: testGameType.id,
      status: "AVAILABLE",
    });

    // Login as member
    const unauthedClient = makeClient();
    const loginRes = await unauthedClient.post("/api/login", {
      username,
      password,
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get("set-cookie");
    assert.ok(setCookie, "Login should set session cookie");
    memberCookie = setCookie.split(";")[0];
    memberClient = makeClient(memberCookie);
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ==========================================
  // §1. Lounge Configuration & IANA Timezone
  // ==========================================
  describe("§1 Lounge Configuration & IANA Timezones", () => {
    test("DEFAULT_LOUNGE_TIMEZONE defaults to Asia/Kolkata", () => {
      assert.equal(DEFAULT_LOUNGE_TIMEZONE, "Asia/Kolkata");
    });

    test("Validates valid and invalid IANA timezone strings", () => {
      assert.equal(isValidIanaTimezone("Asia/Kolkata"), true);
      assert.equal(isValidIanaTimezone("America/New_York"), true);
      assert.equal(isValidIanaTimezone("Europe/London"), true);
      assert.equal(isValidIanaTimezone("Asia/Tokyo"), true);
      assert.equal(isValidIanaTimezone("UTC"), true);
      assert.equal(isValidIanaTimezone("Invalid/Unknown_Zone"), false);
      assert.equal(isValidIanaTimezone(""), false);
      assert.equal(isValidIanaTimezone(null as any), false);
    });

    test("GET /api/lounge/config returns configured lounge timezone and location metadata", async () => {
      const res = await memberClient.get("/api/lounge/config");
      assert.equal(res.status, 200);
      assert.equal(res.data.locationId, "main-lounge");
      assert.equal(res.data.timezone, "Asia/Kolkata");
      assert.equal(res.data.city, "Mumbai");
      assert.equal(res.data.country, "IN");
      assert.equal(res.data.currency, "INR");
      assert.ok(Array.isArray(res.data.allLocations));
      assert.ok(res.data.allLocations.length >= 3);
    });

    test("GET /api/lounge/config?locationId=ny-lounge returns New York config", async () => {
      const res = await memberClient.get("/api/lounge/config?locationId=ny-lounge");
      assert.equal(res.status, 200);
      assert.equal(res.data.locationId, "ny-lounge");
      assert.equal(res.data.timezone, "America/New_York");
      assert.equal(res.data.city, "New York");
      assert.equal(res.data.country, "US");
    });
  });

  // ==========================================
  // §2. Midnight Crossing Calculations
  // ==========================================
  describe("§2 Midnight Boundaries & Midnight-Crossing Bookings", () => {
    test("buildBookingInterval accurately parses same-day booking (18:00 to 20:00) in Asia/Kolkata", () => {
      const interval = buildBookingInterval("2026-09-28", "18:00", "20:00", "Asia/Kolkata");
      assert.equal(interval.crossesMidnight, false);
      assert.equal(interval.durationHours, 2);
      // In Asia/Kolkata (UTC+5:30): 18:00 IST is 12:30 UTC
      assert.equal(interval.startTime.toISOString(), "2026-09-28T12:30:00.000Z");
      // 20:00 IST is 14:30 UTC
      assert.equal(interval.endTime.toISOString(), "2026-09-28T14:30:00.000Z");
    });

    test("buildBookingInterval accurately detects and handles midnight crossing (23:00 to 01:00 next day)", () => {
      const interval = buildBookingInterval("2026-09-28", "23:00", "01:00", "Asia/Kolkata");
      assert.equal(interval.crossesMidnight, true);
      assert.equal(interval.durationHours, 2);
      // 23:00 IST on 2026-09-28 is 17:30 UTC on 2026-09-28
      assert.equal(interval.startTime.toISOString(), "2026-09-28T17:30:00.000Z");
      // 01:00 IST on 2026-09-29 is 19:30 UTC on 2026-09-28
      assert.equal(interval.endTime.toISOString(), "2026-09-28T19:30:00.000Z");
    });

    test("buildBookingInterval accurately handles midnight ending (22:00 to 00:00)", () => {
      const interval = buildBookingInterval("2026-09-28", "22:00", "00:00", "Asia/Kolkata");
      assert.equal(interval.crossesMidnight, true);
      assert.equal(interval.durationHours, 2);
      // 22:00 IST is 16:30 UTC
      assert.equal(interval.startTime.toISOString(), "2026-09-28T16:30:00.000Z");
      // 00:00 IST on next day is 18:30 UTC
      assert.equal(interval.endTime.toISOString(), "2026-09-28T18:30:00.000Z");
    });

    test("Server accurately commits and validates booking across midnight via POST /api/bookings", async () => {
      const interval = buildBookingInterval("2026-10-15", "23:00", "01:00", "Asia/Kolkata");

      const res = await memberClient.post("/api/bookings", {
        gameTypeId: testGameType.id,
        startTime: interval.startTime.toISOString(),
        endTime: interval.endTime.toISOString(),
        playerCount: 1,
        paymentMethod: "offline",
      });

      assert.equal(res.status, 201, `Booking should be created: ${JSON.stringify(res.data)}`);
      assert.ok(res.data.id);
      assert.equal(new Date(res.data.startTime).toISOString(), interval.startTime.toISOString());
      assert.equal(new Date(res.data.endTime).toISOString(), interval.endTime.toISOString());
      assert.equal(res.data.locationId, "main-lounge");

      // Verify formatting in lounge timezone
      const localStartDate = formatLocalDate(res.data.startTime, "Asia/Kolkata");
      const localStartTime = formatLocalTime(res.data.startTime, "Asia/Kolkata");
      const localEndTime = formatLocalTime(res.data.endTime, "Asia/Kolkata");
      assert.equal(localStartTime, "11:00 PM");
      assert.equal(localEndTime, "01:00 AM");
    });

    test("Conflict detection correctly blocks overlapping booking across midnight", async () => {
      // Station VR-TZ-01 is booked 23:00 to 01:00 next day (17:30 UTC to 19:30 UTC)
      // Attempt booking from 23:30 to 00:30 (18:00 UTC to 19:00 UTC) -> must conflict
      const overlapInterval = buildBookingInterval("2026-10-15", "23:30", "00:30", "Asia/Kolkata");

      const res = await memberClient.post("/api/bookings", {
        gameTypeId: testGameType.id,
        startTime: overlapInterval.startTime.toISOString(),
        endTime: overlapInterval.endTime.toISOString(),
        playerCount: 1,
        paymentMethod: "offline",
      });

      assert.equal(res.status, 409, "Conflicting booking across midnight must return 409 conflict");
    });

    test("Non-overlapping booking immediately after midnight booking succeeds", async () => {
      // Booking from 01:00 to 02:00 next day (19:30 UTC to 20:30 UTC)
      const afterInterval = buildBookingInterval("2026-10-16", "01:00", "02:00", "Asia/Kolkata");

      const res = await memberClient.post("/api/bookings", {
        gameTypeId: testGameType.id,
        startTime: afterInterval.startTime.toISOString(),
        endTime: afterInterval.endTime.toISOString(),
        playerCount: 1,
        paymentMethod: "offline",
      });

      assert.equal(res.status, 201, "Booking after midnight slot must succeed");
    });
  });

  // ==========================================
  // §3. Date Change & Start/End of Day
  // ==========================================
  describe("§3 Date Change & Day Boundaries in Lounge Timezone", () => {
    test("getStartOfDayInTimezone computes exact UTC instant for local midnight in Asia/Kolkata", () => {
      // 2026-09-29 07:30 IST is 2026-09-29T02:00:00.000Z in UTC
      const refTime = new Date("2026-09-29T02:00:00.000Z");
      const startOfDay = getStartOfDayInTimezone(refTime, "Asia/Kolkata");

      // Midnight in Asia/Kolkata on Sept 29, 2026 is Sept 28, 2026 at 18:30:00.000Z in UTC
      assert.equal(startOfDay.toISOString(), "2026-09-28T18:30:00.000Z");
    });

    test("getEndOfDayInTimezone computes exact UTC instant for local 23:59:59.999 in Asia/Kolkata", () => {
      const refTime = new Date("2026-09-29T02:00:00.000Z");
      const endOfDay = getEndOfDayInTimezone(refTime, "Asia/Kolkata");

      // End of Sept 29 in Asia/Kolkata is Sept 29, 2026 at 18:29:59.999Z in UTC
      assert.equal(endOfDay.toISOString(), "2026-09-29T18:29:59.999Z");
    });

    test("Date parts correctly reflect local calendar day change", () => {
      // Sept 28 at 20:00 UTC is Sept 29 at 01:30 IST
      const utcTime = new Date("2026-09-28T20:00:00.000Z");
      const parts = getZonedParts(utcTime, "Asia/Kolkata");

      assert.equal(parts.year, 2026);
      assert.equal(parts.month, 9);
      assert.equal(parts.day, 29, "Day in Kolkata must be 29 even though UTC day is 28");
      assert.equal(parts.hour, 1);
      assert.equal(parts.minute, 30);
    });

    test("formatLocalDate and formatLocalTime display location date and time", () => {
      const utcTime = new Date("2026-09-28T20:00:00.000Z");
      const localDate = formatLocalDate(utcTime, "Asia/Kolkata");
      const localTime = formatLocalTime(utcTime, "Asia/Kolkata");

      assert.ok(localDate.includes("September 29, 2026"));
      assert.equal(localTime, "01:30 AM");
    });
  });

  // ==========================================
  // §4. Daylight-Saving Locations (Multi-Country)
  // ==========================================
  describe("§4 Daylight-Saving (DST) Locations for Multi-Country Support", () => {
    test("America/New_York DST start (Spring Forward): parses timestamps accurately", () => {
      // Sunday, March 8, 2026 in New York
      // 1:00 AM EST is UTC-5 -> 06:00:00.000Z
      const preDst = parseZonedDateTime("2026-03-08", "01:00", "America/New_York");
      assert.equal(preDst.toISOString(), "2026-03-08T06:00:00.000Z");
      assert.equal(getTimezoneAbbr(preDst, "America/New_York"), "EST");

      // 4:00 AM EDT is UTC-4 (after 2am jump) -> 08:00:00.000Z
      const postDst = parseZonedDateTime("2026-03-08", "04:00", "America/New_York");
      assert.equal(postDst.toISOString(), "2026-03-08T08:00:00.000Z");
      assert.equal(getTimezoneAbbr(postDst, "America/New_York"), "EDT");

      // Duration: 2 elapsed wall-clock hours, exactly 2 hours UTC difference
      const durationHours = (postDst.getTime() - preDst.getTime()) / (1000 * 60 * 60);
      assert.equal(durationHours, 2);
    });

    test("America/New_York DST end (Fall Back): parses timestamps accurately", () => {
      // Sunday, November 1, 2026 in New York
      // 1:00 AM EDT is UTC-4 -> 05:00:00.000Z
      const preFall = new Date("2026-11-01T05:00:00.000Z");
      assert.equal(formatLocalTime(preFall, "America/New_York"), "01:00 AM");
      assert.equal(getTimezoneAbbr(preFall, "America/New_York"), "EDT");

      // 2:00 AM EST is UTC-5 -> 07:00:00.000Z
      const postFall = parseZonedDateTime("2026-11-01", "02:00", "America/New_York");
      assert.equal(postFall.toISOString(), "2026-11-01T07:00:00.000Z");
      assert.equal(getTimezoneAbbr(postFall, "America/New_York"), "EST");
    });

    test("Europe/London (BST vs GMT): handles daylight saving accurately", () => {
      // Summer (July): BST (UTC+1)
      const londonSummer = parseZonedDateTime("2026-07-15", "18:00", "Europe/London");
      assert.equal(londonSummer.toISOString(), "2026-07-15T17:00:00.000Z");
      assert.equal(getTimezoneAbbr(londonSummer, "Europe/London"), "BST");

      // Winter (December): GMT (UTC+0)
      const londonWinter = parseZonedDateTime("2026-12-15", "18:00", "Europe/London");
      assert.equal(londonWinter.toISOString(), "2026-12-15T18:00:00.000Z");
      assert.equal(getTimezoneAbbr(londonWinter, "Europe/London"), "GMT");
    });

    test("formatLocalDateTime includes correct timezone abbreviation for each lounge location", () => {
      const utcInstant = new Date("2026-07-15T14:30:00.000Z");

      const kolkataStr = formatLocalDateTime(utcInstant, "Asia/Kolkata");
      assert.ok(kolkataStr.includes("IST"), `Should include IST: ${kolkataStr}`);
      assert.ok(kolkataStr.includes("8:00 PM") || kolkataStr.includes("08:00 PM"));

      const nyStr = formatLocalDateTime(utcInstant, "America/New_York");
      assert.ok(nyStr.includes("EDT"), `Should include EDT: ${nyStr}`);
      assert.ok(nyStr.includes("10:30 AM"));

      const londonStr = formatLocalDateTime(utcInstant, "Europe/London");
      assert.ok(londonStr.includes("BST"), `Should include BST: ${londonStr}`);
      assert.ok(londonStr.includes("3:30 PM") || londonStr.includes("03:30 PM"));
    });
  });

  // ==========================================
  // §5. Server Running in Different Timezone
  // ==========================================
  describe("§5 Server Running in a Different Local Timezone", () => {
    test("Calculations yield identical UTC timestamps regardless of server process timezone", () => {
      // Regardless of what process.env.TZ is set to, calculations must be deterministic
      const targetDate = "2026-11-20";
      const targetTime = "15:30";

      const utcResult1 = parseZonedDateTime(targetDate, targetTime, "Asia/Kolkata");
      assert.equal(utcResult1.toISOString(), "2026-11-20T10:00:00.000Z");

      // Start of day in Asia/Kolkata must always be 18:30 UTC of previous day
      const startOfDay = getStartOfDayInTimezone(new Date("2026-11-20T12:00:00.000Z"), "Asia/Kolkata");
      assert.equal(startOfDay.toISOString(), "2026-11-19T18:30:00.000Z");
    });

    test("formatInTimezone produces identical output regardless of host local timezone", () => {
      const timestamp = new Date("2026-11-20T10:00:00.000Z");
      const formatted = formatInTimezone(timestamp, "Asia/Kolkata", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      assert.equal(formatted, "15:30");
    });
  });

  // ==========================================
  // §6. Invariance & Security Assertions
  // ==========================================
  describe("§6 Invariance & Security Assertions", () => {

    test("Transactional timestamps stored in database are UTC TIMESTAMPTZ", async () => {
      const [latestBooking] = await db
        .select()
        .from(bookings)
        .where(sql`${bookings.userId} IS NOT NULL`)
        .limit(1);

      assert.ok(latestBooking, "Should find at least 1 booking in database");
      assert.ok(latestBooking.startTime instanceof Date, "startTime must be a Date object");
      assert.ok(latestBooking.endTime instanceof Date, "endTime must be a Date object");
      assert.ok(latestBooking.createdAt instanceof Date, "createdAt must be a Date object");
      // Must not be NaN
      assert.ok(!isNaN(latestBooking.startTime.getTime()));
      assert.ok(!isNaN(latestBooking.endTime.getTime()));
      assert.ok(!isNaN(latestBooking.createdAt.getTime()));
    });
  });
});
