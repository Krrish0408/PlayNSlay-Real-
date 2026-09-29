import { storage } from "./storage";
import { type GameType, type Station } from "@shared/schema";
import { calculateBookingPrice as calculateSharedFormula } from "@shared/pricing";

export interface CalculateBookingPriceOptions {
  stationId?: number | null;
  gameTypeId?: number | null;
  startTime: Date | string;
  endTime: Date | string;
  playerCount?: number | null;
  applicablePricingRules?: string[] | null;
}

export interface PriceSnapshot {
  basePrice: number;        // In cents (standard un-discounted rate)
  discountAmount: number;   // In cents (discount savings)
  finalPrice: number;       // In cents (authoritative billed amount)
  currency: string;         // 'INR'
  pricingRule: string;      // Rule/version identifier
  durationHours: number;    // Calculated duration in hours
  ratePerHour: number;      // Effective hourly rate in cents
  gameType: GameType;       // Verified game category
  station?: Station | null; // Verified station if assigned
}

/**
 * Server-Authoritative Booking Price Calculator
 *
 * Enforces strict validation of all parameters:
 * - Timestamps (positive duration, min/max bounds, no reversed intervals)
 * - Numeric ranges (playerCount >= 1, playerCount <= maxPlayers)
 * - Database configuration (rates loaded exclusively from trusted DB, never client)
 * - Station ownership (validates station belongs to the game category)
 *
 * Produces an immutable PriceSnapshot for historical billing integrity.
 */
export async function calculateBookingPrice(
  options: CalculateBookingPriceOptions
): Promise<PriceSnapshot> {
  // 1. Validate Timestamps
  if (!options.startTime || !options.endTime) {
    throw new Error("Both startTime and endTime are required for price calculation.");
  }

  const start = new Date(options.startTime);
  const end = new Date(options.endTime);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error("Invalid booking timestamps: startTime and endTime must be valid dates.");
  }

  if (end.getTime() <= start.getTime()) {
    throw new Error("Invalid duration: endTime must be strictly after startTime.");
  }

  const durationMs = end.getTime() - start.getTime();
  const durationHours = durationMs / (1000 * 60 * 60);

  // Validate duration bounds (15 mins minimum, 24 hours maximum)
  if (durationHours < 0.25) {
    throw new Error("Minimum booking duration is 15 minutes (0.25 hours).");
  }

  if (durationHours > 24) {
    throw new Error("Maximum booking duration is 24 hours.");
  }

  // 2. Validate Player Count (numeric ranges server-side)
  const rawPlayers = options.playerCount !== undefined && options.playerCount !== null
    ? options.playerCount
    : 1;

  if (typeof rawPlayers !== "number" || isNaN(rawPlayers) || !Number.isFinite(rawPlayers)) {
    throw new Error("Invalid player count: must be a valid number.");
  }

  const playerCount = Math.floor(rawPlayers);
  if (playerCount < 1) {
    throw new Error("Player count must be at least 1.");
  }

  // 3. Resolve and Validate Station Ownership & Category Configuration
  let station: Station | undefined;
  let gameTypeId = options.gameTypeId ? Number(options.gameTypeId) : undefined;

  if (options.stationId) {
    const sId = Number(options.stationId);
    station = await storage.getStation(sId);
    if (!station) {
      throw new Error(`Station with ID ${sId} does not exist.`);
    }

    if (station.status?.toUpperCase() !== "AVAILABLE") {
      throw new Error(`Station ${station.name} is currently ${station.status} and cannot be booked.`);
    }

    // Verify station ownership: station must belong to the requested category
    if (gameTypeId && station.gameTypeId !== gameTypeId) {
      throw new Error(`Station ${station.name} does not belong to the selected gaming category.`);
    }

    // If gameTypeId was not passed, use the station's verified category
    gameTypeId = station.gameTypeId;
  }

  if (!gameTypeId) {
    throw new Error("A valid gaming category (gameTypeId) is required.");
  }

  const gameType = await storage.getGameType(gameTypeId);
  if (!gameType) {
    throw new Error(`Gaming category with ID ${gameTypeId} does not exist.`);
  }

  if (!gameType.isActive) {
    throw new Error(`Gaming category '${gameType.name}' is currently inactive.`);
  }

  // Enforce player count against category capacity
  if (playerCount > gameType.maxPlayers) {
    throw new Error(
      `Player count (${playerCount}) exceeds maximum allowed (${gameType.maxPlayers}) for ${gameType.name}.`
    );
  }

  // 4. Calculate Server-Authoritative Pricing Snapshot
  // Standard base rate without promotional/tiered discounts
  const standardBaseHourly = gameType.priceModel === "per_player"
    ? gameType.hourlyPrice * playerCount
    : gameType.hourlyPrice;

  const standardBasePrice = Math.round(standardBaseHourly * durationHours);

  // Authoritative final price from formula
  const calculatedFinalPrice = calculateSharedFormula(gameType, durationHours, playerCount);

  // Compute discount and base prices
  const discountAmount = Math.max(0, standardBasePrice - calculatedFinalPrice);
  const finalPrice = Math.max(0, calculatedFinalPrice);
  const basePrice = Math.max(standardBasePrice, finalPrice);

  // Determine pricing rule identifier
  let pricingRule = "standard_v1";
  if (gameType.priceModel === "per_player") {
    pricingRule = "v1_tiered_player";
  } else if (discountAmount > 0) {
    pricingRule = "v1_duration_discount";
  }

  if (options.applicablePricingRules && options.applicablePricingRules.length > 0) {
    pricingRule += `+${options.applicablePricingRules.join(",")}`;
  }

  const ratePerHour = durationHours > 0 ? Math.round(finalPrice / durationHours) : gameType.hourlyPrice;

  return {
    basePrice,
    discountAmount,
    finalPrice,
    currency: "INR",
    pricingRule,
    durationHours,
    ratePerHour,
    gameType,
    station: station || null,
  };
}
