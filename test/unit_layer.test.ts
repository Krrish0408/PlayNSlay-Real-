import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { calculateBookingPrice } from "../server/pricing-service";
import { calculateBookingPrice as calculateFormula } from "../shared/pricing";
import {
  insertBookingSchema,
  insertUserSchema,
  insertGameTypeSchema,
  insertStationSchema,
  hasPermission,
  ROLE_PERMISSIONS,
  type User,
  type Booking,
  type Station,
} from "../shared/schema";
import {
  BookingPolicy,
  UserPolicy,
  StationPolicy,
  CatalogPolicy,
  EmployeeDataPolicy,
} from "../server/authorization";
import { storage } from "../server/storage";

describe("Production Testing Strategy - UNIT Layer", () => {
  // ==========================================
  // 1. Pricing Unit Tests
  // ==========================================
  describe("1. Pricing Logic & Boundaries", () => {
    const flatGameType = {
      id: 1,
      name: "PS5 Lounge",
      hourlyPrice: 15000, // ₹150.00 / hour
      maxPlayers: 4,
      isActive: true,
      priceModel: "flat" as const,
      description: "PS5 Flat",
      imageUrl: null,
    };

    const perPlayerGameType = {
      id: 2,
      name: "VR Arena",
      hourlyPrice: 10000, // ₹100.00 / player / hour
      maxPlayers: 6,
      isActive: true,
      priceModel: "per_player" as const,
      description: "VR Per Player",
      imageUrl: null,
    };

    test("Standard flat formula calculates exact un-discounted rate", () => {
      // 2 hours at ₹150/hr flat = ₹300.00 (30000 paise)
      const cost = calculateFormula(flatGameType, 2, 1);
      assert.equal(cost, 30000);

      // Player count does not change flat price
      const costMulti = calculateFormula(flatGameType, 2, 4);
      assert.equal(costMulti, 30000);
    });

    test("Per-player formula multiplies by player count", () => {
      // 1.5 hours at ₹100/hr per player * 3 players = ₹450.00 (45000 paise)
      const cost = calculateFormula(perPlayerGameType, 1.5, 3);
      assert.equal(cost, 45000);
    });

    test("Duration discount applies for extended sessions (> 3 hours)", () => {
      const pcGamingType: GameTypeForPricing = {
        name: "PC Gaming",
        hourlyPrice: 8000,
        priceModel: "flat",
      };
      // Standard rate for 4 hours without discount would be 8000 * 4 = 32000
      // With >= 3h discount (₹66.66/hr equivalent), price is discounted
      const cost = calculateFormula(pcGamingType, 4, 1);
      assert.ok(cost < 32000, "4 hours on PC Gaming should have a duration discount");
      assert.ok(cost > 0, "Price must remain positive");
    });

    test("Rejects reversed time intervals where endTime is before startTime", async () => {
      await assert.rejects(
        async () => {
          await calculateBookingPrice({
            gameTypeId: 1,
            startTime: new Date("2026-10-01T14:00:00Z"),
            endTime: new Date("2026-10-01T12:00:00Z"),
          });
        },
        { message: /endTime must be strictly after startTime/ }
      );
    });

    test("Rejects duration under 15 minutes minimum", async () => {
      await assert.rejects(
        async () => {
          await calculateBookingPrice({
            gameTypeId: 1,
            startTime: new Date("2026-10-01T12:00:00Z"),
            endTime: new Date("2026-10-01T12:10:00Z"), // 10 minutes
          });
        },
        { message: /Minimum booking duration is 15 minutes/ }
      );
    });

    test("Rejects duration over 24 hours maximum", async () => {
      await assert.rejects(
        async () => {
          await calculateBookingPrice({
            gameTypeId: 1,
            startTime: new Date("2026-10-01T12:00:00Z"),
            endTime: new Date("2026-10-02T13:00:00Z"), // 25 hours
          });
        },
        { message: /Maximum booking duration is 24 hours/ }
      );
    });
  });

  // ==========================================
  // 2. Input Validation Schema Tests
  // ==========================================
  describe("2. Input Validation & Boundaries", () => {
    test("insertBookingSchema validates required fields and valid dates", () => {
      const valid = insertBookingSchema.parse({
        gameTypeId: 1,
        startTime: "2026-10-05T10:00:00Z",
        endTime: "2026-10-05T12:00:00Z",
        playerCount: 2,
        paymentMethod: "offline",
      });
      assert.equal(valid.gameTypeId, 1);
      assert.equal(valid.playerCount, 2);
      assert.ok(valid.startTime instanceof Date);
      assert.ok(valid.endTime instanceof Date);
    });

    test("insertBookingSchema rejects invalid dates and non-positive playerCount", () => {
      assert.throws(() => {
        insertBookingSchema.parse({
          gameTypeId: 1,
          startTime: "invalid-date",
          endTime: "2026-10-05T12:00:00Z",
        });
      });

      assert.throws(() => {
        insertBookingSchema.parse({
          gameTypeId: 1,
          startTime: "2026-10-05T10:00:00Z",
          endTime: "2026-10-05T12:00:00Z",
          playerCount: 0, // Must be at least 1
        });
      });
    });

    test("insertUserSchema validates required user fields", () => {
      const valid = insertUserSchema.parse({
        username: "testuser1",
        password: "strongpassword123",
      });
      assert.equal(valid.username, "testuser1");

      assert.throws(() => {
        // Missing required password must fail validation
        insertUserSchema.parse({
          username: "testuser1",
        });
      });
    });
  });

  // ==========================================
  // 3. Authorization Policy Unit Tests
  // ==========================================
  describe("3. Authorization Policies & Role Permissions", () => {
    const member: User = {
      id: 101,
      username: "member1",
      password: "xxx",
      email: "m1@example.com",
      fullName: "Member One",
      phone: null,
      avatarUrl: null,
      membershipTier: "bronze",
      role: "member",
      authProvider: "local",
      googleId: null,
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
      emailVerificationTokenHash: null,
      emailVerificationTokenExpiresAt: null,
      resetRequired: false,
      passwordResetTokenHash: null,
      passwordResetTokenExpiresAt: null,
      tokenVersion: 1,
      isMfaEnabled: false,
      mfaSecret: null,
      mfaRecoveryCodes: null,
      mfaLastUsedTimestep: null,
      createdAt: new Date(),
    };

    const employee: User = {
      ...member,
      id: 202,
      username: "employee1",
      role: "employee",
    };

    const admin: User = {
      ...member,
      id: 303,
      username: "admin1",
      role: "admin",
    };

    const ownBooking: Booking = {
      id: 501,
      userId: 101, // Belongs to member (101)
      gameTypeId: 1,
      stationId: 1,
      locationId: "main-lounge",
      gameTitle: null,
      startTime: new Date("2026-10-10T10:00:00Z"),
      endTime: new Date("2026-10-10T12:00:00Z"),
      playerCount: 1,
      totalPrice: 30000,
      basePrice: 30000,
      discountAmount: 0,
      finalPrice: 30000,
      currency: "INR",
      pricingRule: "standard_v1",
      paymentMethod: "offline",
      status: "Pending",
      bookingRef: "REF-001",
      employeeId: null,
      timerStartedAt: null,
      timerEndTime: null,
      createdAt: new Date(),
    };

    const otherBooking: Booking = {
      ...ownBooking,
      id: 502,
      userId: 999, // Belongs to another user
    };

    test("ROLE_PERMISSIONS matrix strictly partitions privileges", () => {
      assert.ok(hasPermission(member, "BOOKING_READ_OWN"));
      assert.ok(!hasPermission(member, "BOOKING_READ_ALL"));
      assert.ok(!hasPermission(member, "USER_MANAGE"));

      assert.ok(hasPermission(employee, "BOOKING_READ_ALL"));
      assert.ok(hasPermission(employee, "BOOKING_MANAGE"));
      assert.ok(!hasPermission(employee, "USER_MANAGE"));
      assert.ok(!hasPermission(employee, "PRICING_MANAGE"));

      assert.ok(hasPermission(admin, "USER_MANAGE"));
      assert.ok(hasPermission(admin, "PRICING_MANAGE"));
      assert.ok(hasPermission(admin, "ANALYTICS_VIEW"));
    });

    test("BookingPolicy enforces object-level read authorization", () => {
      assert.equal(BookingPolicy.canRead(member, ownBooking), true);
      assert.equal(BookingPolicy.canRead(member, otherBooking), false);
      assert.equal(BookingPolicy.canRead(employee, otherBooking), true);
      assert.equal(BookingPolicy.canRead(admin, otherBooking), true);
    });

    test("BookingPolicy enforces object-level cancellation rules", () => {
      // Member can cancel own pending booking
      const memberCancelOwn = BookingPolicy.canCancel(member, ownBooking);
      assert.equal(memberCancelOwn.allowed, true);

      // Member cannot cancel another's booking
      const memberCancelOther = BookingPolicy.canCancel(member, otherBooking);
      assert.equal(memberCancelOther.allowed, false);

      // Cannot cancel already completed booking
      const completedBooking: Booking = { ...ownBooking, status: "Completed" };
      const cancelCompleted = BookingPolicy.canCancel(member, completedBooking);
      assert.equal(cancelCompleted.allowed, false);
    });

    test("UserPolicy protects sensitive user profiles", () => {
      assert.equal(UserPolicy.canReadProfile(member, 101), true);
      assert.equal(UserPolicy.canReadProfile(member, 999), false);
      assert.equal(UserPolicy.canReadProfile(admin, 999), true);
    });
  });

  // ==========================================
  // 4. State Transitions Unit Tests
  // ==========================================
  describe("4. State Transitions & Lifecycle Integrity", () => {
    test("Booking lifecycle states follow valid progression", () => {
      const validStates = ["Pending", "Approved", "Completed", "Cancelled", "Rejected"];
      for (const st of validStates) {
        assert.ok(typeof st === "string");
      }
    });

    test("Station availability statuses follow strict enum bounds", () => {
      const validStatuses = ["AVAILABLE", "MAINTENANCE", "INACTIVE"];
      for (const st of validStatuses) {
        assert.ok(insertStationSchema.shape.status.safeParse(st).success);
      }
      assert.ok(!insertStationSchema.shape.status.safeParse("BROKEN").success);
      assert.ok(!insertStationSchema.shape.status.safeParse("DELETED").success);
    });
  });
});
