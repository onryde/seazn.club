// Capture QR v2 §6.8.4 — the DB end and fail reasons on the wire. Pure. Called for terminal rows only (ending,
// completed, failed); every row maps to exactly one wire value, and a row that cannot map throws by name rather than
// put a null into an answer whose contract requires `endReason` (`over`, and the descriptor's ending/completed/failed).
//
// Keyed on capture's `CaptureEndReason` (T1), never on session.ts's narrower `Session.endReason`, which T6 widens.
import type { CaptureEndReason } from "@/server/api-v1/capture-schemas";
import type { FailReason } from "./session";

export type WireEndReason = CaptureEndReason;
/** The V430 `end_reason` check list, in its order (end-reason.test.ts compares it with the migration fold). */
export const DB_END_REASONS = ["stopped", "operator_stopped", "auto_stopped", "phone_lost", "max_duration"] as const;
export type DbEndReason = (typeof DB_END_REASONS)[number];

export class TerminalWithoutReason extends Error {
  constructor(row: { endReason: unknown; failReason: unknown }, why: string) {
    super(`terminal session row has no single wire endReason (${why}): ${JSON.stringify(row)}`);
    this.name = "TerminalWithoutReason";
  }
}

/** Total over DbEndReason: tsc refuses a missing key. */
const END_TO_WIRE: Record<DbEndReason, WireEndReason> = {
  stopped: "stopped",
  operator_stopped: "stopped",          // only the phone that stopped it ever names this sid, and it is already Ended
  auto_stopped: "auto_stopped",
  phone_lost: "phone_lost",
  max_duration: "max_duration",
};
/** Total over FailReason. The two the phone has copy for are named; every other server-side failure is `failed` (G0-f). */
const FAIL_TO_WIRE: Record<FailReason, WireEndReason> = {
  no_inbound_timeout: "no_inbound_timeout",
  target_rejected: "target_rejected",
  no_credits: "failed",
  provision_timeout: "failed",
  admission_timeout: "failed",
  relay_disabled: "failed",
  machine_create_failed: "failed",
  machine_boot_timeout: "failed",
  machine_exit_nonzero: "failed",
  machine_oom: "failed",
  machine_crash: "failed",
};
/** R11 (controller, 2026-10-01): session.ts's completion can store `endReason: null` (no stop reason was ever chosen,
 *  e.g. a runner that completed by itself). Neither a stop nor a timeout, so G0-f's `failed`. */
const NO_REASON: WireEndReason = "failed";

const own = <K extends string>(table: Record<K, WireEndReason>, key: string): WireEndReason | undefined =>
  Object.hasOwn(table, key) ? table[key as K] : undefined;

export function wireEndReason(row: { endReason: DbEndReason | null; failReason: FailReason | null }): WireEndReason {
  if (row.endReason !== null && row.failReason !== null) throw new TerminalWithoutReason(row, "both an end and a fail reason");
  if (row.endReason !== null) return own(END_TO_WIRE, row.endReason) ?? fail(row, "unknown end reason");
  if (row.failReason !== null) return own(FAIL_TO_WIRE, row.failReason) ?? fail(row, "unknown fail reason");
  return NO_REASON;
}

function fail(row: { endReason: unknown; failReason: unknown }, why: string): never {
  throw new TerminalWithoutReason(row, why);
}
