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
