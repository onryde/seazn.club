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

/** The size the select SHOWS: the locked package's own (a paid or frozen one never moves from here), else the organiser's pick while
 *  it is still open (not below the places held, not over the plan, not short of the rounds), else the default for the places and
 *  rounds (`onlineSizeDefault`: the size follows them until a pick is made, and a pick they have since closed is dropped). Null when
 *  no size holds the places and rounds - nothing is chosen for the organiser. */
export function onlineSizeChoice(a: OnlineSizeFacts & { picked: OnlineSize | null; locked: OnlineSize | null }): OnlineSize | null {
  if (a.locked !== null) return a.locked;
  const open = onlineSizeOptions(a).find((o) => o.size === a.picked && o.disabled === null);
  return open?.size ?? onlineSizeDefault({ held: a.held, rounds: a.rounds });
}

/** What a division save says it did to the registration capacity (PATCH /divisions `online.capacityLoweredTo`, spec §7.4 item 2): the
 *  size the capacity was lowered to, or null when it lowered none or the answer has no such field. */
export function capacityLoweredOf(saved: unknown): number | null {
  const lowered = (saved as { online?: { capacityLoweredTo?: unknown } | null } | null | undefined)?.online?.capacityLoweredTo;
  return typeof lowered === "number" && Number.isInteger(lowered) && lowered > 0 ? lowered : null;
}

/** A paid, unfrozen package that switching Online play off REFUNDS (spec §7.3, §7.4 item 4; the review's gap): the size it was bought at and
 *  what was paid for it (the leaf's price: its camera price too when the camera was paid). Null for every other case - an unpaid package
 *  is deleted without money moving, a frozen one is left as it is (the server's call, P7), and a division that was not online or stays
 *  online has nothing to refund. The refund can forfeit included credits of an earlier month (P6), so the strip asks first. */
export function switchOffRefundOf(a: {
  storedOnline: boolean;
  onlinePlay: "off" | "lichess";
  stored: { size: OnlineSize; paid: { size: OnlineSize; camerasPaid: boolean } | null; frozen: boolean } | null;
}): { size: OnlineSize; price: number } | null {
  if (!a.storedOnline || a.onlinePlay !== "off" || a.stored === null || a.stored.paid === null || a.stored.frozen) return null;
  return { size: a.stored.paid.size, price: packagePrice(a.stored.paid.size, a.stored.paid.camerasPaid) };
}

/** Whether switching Online play OFF on this division stops a running event (spec 8.7; owner ruling): the package is stored, online, FROZEN (round 1
 *  has opened), and the pick is "off". The server leaves a frozen package as it is and refunds nothing (all-zero refund, P7), so the strip says so before
 *  it saves. An unpaid, paid-and-unfrozen, never-online or stays-online division is not this: the first deletes, the second refunds
 *  (`switchOffRefundOf`), the others change nothing. */
export function switchOffFrozenOf(a: {
  storedOnline: boolean;
  onlinePlay: "off" | "lichess";
  stored: { size: OnlineSize; paid: { size: OnlineSize; camerasPaid: boolean } | null; frozen: boolean } | null;
}): boolean {
  return a.storedOnline && a.onlinePlay === "off" && a.stored !== null && a.stored.frozen;
}

/** What a division save says its switch-off refund did (PATCH /divisions `online.refunded`, `{ pack, monthly, forfeited }`): the credits
 *  returned (bought plus this month's included) and the included credits of an earlier month that were not (P6). Null when the answer has
 *  no such field, a malformed one, or nothing moved (an unpaid or frozen switch-off answers all zeros). */
export function refundedOf(saved: unknown): { returned: number; forfeited: number } | null {
  const refunded = (saved as { online?: { refunded?: unknown } | null } | null | undefined)?.online?.refunded as
    | { pack?: unknown; monthly?: unknown; forfeited?: unknown }
    | null
    | undefined;
  if (refunded === null || typeof refunded !== "object") return null;
  const { pack, monthly, forfeited } = refunded;
  const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (!whole(pack) || !whole(monthly) || !whole(forfeited)) return null;
  const returned = pack + monthly;
  return returned === 0 && forfeited === 0 ? null : { returned, forfeited };
}
