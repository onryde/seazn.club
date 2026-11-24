// Online Chess credits (spec 2026-11-23-online-chess-credits-design.md §8.1, §8.6): the size select's option rules, as data, for the
// organiser's screens (the Division rules strip and the builder). Pure and client-safe: it imports only the price leaf, so every number
// it shows - the rounds each size includes, what each costs - is the leaf's, never typed here.
//
// It mirrors the SERVER's refusal order (`refusalFor`, server/usecases/online-package/quote.ts: frozen, below_held, plan,
// rounds_above_max, rounds) one size at a time, so a size the save would refuse is greyed with the reason the server would give, and a
// size the server takes is never greyed. A test sweeps every (held, rounds, plan cap) cell against `refusalFor` itself.
import { ONLINE_SIZES, includedRounds, packagePrice, sizeAllowedByPlan, type OnlineSize } from "@/lib/online-chess-package";

/** Why a size cannot be picked: below the places already held, above the plan's entrant cap (P17), or too few included rounds. The
 *  server's `frozen` is the whole select's, never one size's. */
export type OnlineSizeDisabled = "held" | "plan" | "rounds";

export interface OnlineSizeOption {
  size: OnlineSize;
  /** The Swiss rounds this size includes (P1). */
  rounds: number;
  /** What this size costs, with or without the Fair-play camera: the leaf's price. */
  price: number;
  disabled: OnlineSizeDisabled | null;
  /** On a PAID row: this size's price less what the row's own size and camera state cost. > 0 to pay, < 0 to get back, 0 the row's own
   *  size. Null on an unpaid row (the price is the whole of it). */
  diff: number | null;
}

export interface OnlineSizeFacts {
  /** The plan's `entrants.per_division.max`; null is no cap. */
  planCap: number | null;
  /** Places held (entrants and sign-ups that take one). */
  held: number;
  /** The Swiss rounds the division's stages declare (P15). */
  rounds: number;
  /** Whether the division is priced with the Fair-play camera (P9). */
  cameras: boolean;
  /** The PAID package's size and whether its camera price was paid; null on an unpaid row. */
  paid: { size: OnlineSize; camerasPaid: boolean } | null;
}

/** The five sizes as the select lists them. A paid row prices every size with the camera when its cameras are paid (P19: a paid camera is
 *  never lowered), as the server's quote does. */
export function onlineSizeOptions(a: OnlineSizeFacts): OnlineSizeOption[] {
  const cameras = a.cameras || a.paid?.camerasPaid === true;
  const paidPrice = a.paid === null ? null : packagePrice(a.paid.size, a.paid.camerasPaid);
  return ONLINE_SIZES.map((size): OnlineSizeOption => {
    const price = packagePrice(size, cameras);
    const disabled: OnlineSizeDisabled | null =
      size < a.held ? "held" : !sizeAllowedByPlan(size, a.planCap) ? "plan" : a.rounds > includedRounds(size) ? "rounds" : null;
    return { size, rounds: includedRounds(size), price, disabled, diff: paidPrice === null ? null : price - paidPrice };
  });
}

/** The size an unpicked select opens on: the smallest that holds the places held and includes the rounds (P14, widened to the rounds
 *  so a default never asks for a size the stage door would refuse). Null when none does: more than 256 places, or more rounds than 256
 *  includes. The plan is not asked: an over-plan default is the save's own 402, which opens the upgrade gate. */
export function onlineSizeDefault(a: { held: number; rounds: number }): OnlineSize | null {
  return ONLINE_SIZES.find((s) => s >= a.held && includedRounds(s) >= a.rounds) ?? null;
}

/** The Swiss rounds a set of stages declares (P15; the same rule as the server's `countedRounds`): the sum of `config.rounds` over the
 *  Swiss stages. A Swiss stage with no usable round count counts 0 - it is never read as 1. Knockout, play-off and ladder count nothing. */
export function swissRoundsOf(stages: readonly { kind: string; config?: Record<string, unknown> | null }[]): number {
  let total = 0;
  for (const s of stages) {
    const rounds = s.config?.rounds;
    if (s.kind === "swiss" && typeof rounds === "number" && Number.isInteger(rounds) && rounds >= 1) total += rounds;
  }
  return total;
}
