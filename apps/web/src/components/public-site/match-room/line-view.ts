// The check-in line card's words (spec §6.1 (2), §5.7.9): pure, so the rounding rule is tested without a DOM.
import type { SeatAnswer } from "./room-api";
import type { LineWire } from "./room-snapshot";

/** The estimate is shown rounded UP to the next 5 s: a player told "about 30 seconds" never waits for 25 that were rounded down. */
export const ETA_STEP_S = 5;
/** Above this many seconds the estimate is shown in minutes ("about 2 minutes"). */
export const ETA_MINUTES_ABOVE_S = 90;

export type EtaPhrase = { unit: "seconds" | "minutes"; count: number };

/** What the card says about the wait: whole seconds in 5 s steps up to ETA_MINUTES_ABOVE_S, whole minutes (rounded up) past it.
 *  Never less than one step: "about 0 seconds" is not a thing a person can wait for. A bad number reads as the smallest step. */
export function etaPhrase(etaS: number): EtaPhrase {
  const s = Number.isFinite(etaS) ? Math.max(0, etaS) : 0;
  if (s > ETA_MINUTES_ABOVE_S) return { unit: "minutes", count: Math.ceil(s / 60) };
  return { unit: "seconds", count: Math.max(ETA_STEP_S, Math.ceil(s / ETA_STEP_S) * ETA_STEP_S) };
}

/** The line the card shows, or null: a seat answer of `queued` carries it. The reducer keeps the answer, the card reads this. */
export function lineOf(seat: SeatAnswer | null): LineWire | null {
  return seat !== null && !seat.seated && seat.reason === "queued" && "line" in seat ? seat.line : null;
}
