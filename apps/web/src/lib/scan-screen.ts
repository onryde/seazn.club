// Scorer sheets §4.5 — what the scan page shows. Client-safe (no server imports):
// `device-score-pad.tsx` is a client island and reads this directly.
import type { MessageKey } from "@/lib/messages";

/** Why a device link's screen is View-only: a final scoreboard, no controls.
 *  `carried_forward` is reached live (a refused write, `transport.ts`'s
 *  CHROME_TERMINAL_CODES); the scan page chooses the others at load. */
export type ViewOnlyReason = "carried_forward" | "finalized" | "cancelled" | "no_opponent";

export const VIEW_ONLY_COPY: Readonly<Record<ViewOnlyReason, MessageKey>> = {
  carried_forward: "device.scan.viewOnly.carried",
  finalized: "device.scan.viewOnly.finalized",
  cancelled: "device.scan.viewOnly.cancelled",
  no_opponent: "device.scan.viewOnly.noOpponent",
};

export type ScanScreen =
  | { screen: "view_only"; reason: ViewOnlyReason }
  | { screen: "waiting" }
  | { screen: "confirm" }
  | { screen: "pad" };

export interface ScanInput {
  status: string;
  homeKnown: boolean;
  awayKnown: boolean;
  /** `resultCarriedForward` — already false for anything not settled. */
  carriedForward: boolean;
}

/** One table, read top to bottom. Terminal states outrank everything; a TBD
 *  side waits only while the fixture is still to be played. */
export function scanScreen(i: ScanInput): ScanScreen {
  if (i.status === "finalized") return { screen: "view_only", reason: "finalized" };
  if (i.status === "cancelled") return { screen: "view_only", reason: "cancelled" };
  if (i.carriedForward) return { screen: "view_only", reason: "carried_forward" };
  if (!i.homeKnown || !i.awayKnown) {
    return i.status === "scheduled" ? { screen: "waiting" } : { screen: "view_only", reason: "no_opponent" };
  }
  if (i.status === "scheduled") return { screen: "confirm" };
  return { screen: "pad" };
}

const DEAD_KEY: Readonly<Record<string, MessageKey>> = {
  LINK_REVOKED: "device.dead.revoked",
  LINK_EXPIRED: "device.dead.expired",
};

/** The resolver's codes → copy. The resolver's own messages are English and
 *  never reach a screen (P12). */
export function deadLinkKey(code: string | null): MessageKey {
  return code !== null && Object.hasOwn(DEAD_KEY, code) ? DEAD_KEY[code]! : "device.dead.invalid";
}

/** "Wed 23 Sep, 22:30" in the fixture's venue tz. */
export function fixtureTimeLabel(iso: string | null, tz: string, intlLocale: string): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat(intlLocale, {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
