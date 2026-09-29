export type PriceModel = "flat" | "per_player";

export interface GameTypeForPricing {
  name: string;
  hourlyPrice: number;
  priceModel: PriceModel | string;
}

export function calculateBookingPrice(gameType: GameTypeForPricing, durationHours: number, playerCount: number): number {
  const basePrice = gameType.hourlyPrice;
  let finalPrice = basePrice;

  if (gameType.priceModel === "per_player") {
    // Specific overrides for non-linear per-player rates
    if (gameType.name === "PS5" || gameType.name === "XBOX") {
      // Base is 120. 2P is 180 (1.5x), 4P is 250 (2.08x)
      if (playerCount === 2) finalPrice = Math.round((basePrice * 180) / 120);
      else if (playerCount >= 4) finalPrice = Math.round((basePrice * 250) / 120);
      else finalPrice = basePrice * playerCount;
    } else if (gameType.name === "PS4") {
      // Base is 70. 2P is 120 (1.7x), 4P is 150 (2.1x)
      if (playerCount === 2) finalPrice = Math.round((basePrice * 120) / 70);
      else if (playerCount >= 4) finalPrice = Math.round((basePrice * 150) / 70);
      else finalPrice = basePrice * playerCount;
    } else {
      finalPrice = basePrice * playerCount;
    }
  } else {
    // Flat price models (PC, VR, etc)
    finalPrice = basePrice;
    if (gameType.name === "PC Gaming") {
      // ₹80 for 1h, ₹140 for 2h (70/h), ₹200 for 3h (66.6/h)
      if (durationHours >= 3) finalPrice = Math.round((basePrice * 66.66) / 80);
      else if (durationHours >= 2) finalPrice = Math.round((basePrice * 70) / 80);
    }
  }

  return Math.ceil(finalPrice * durationHours);
}
