// Capture QR v2 §5.2, §5.5 (T1–T8), §6.5 (A14's clock) and §6.9 (present / silent / not responding). Pure: no I/O,
// `now` passed in. Thresholds that tunable() may shorten (§6.15) are REQUIRED trailing parameters with no default, so
// tsc forces every use-case call site to pass `tunable(…)` and this file never reads the environment.
import { NOT_RESPONDING_BEATS, PHONE_SILENT_SLACK_SECONDS } from "../config";
import type { SlotState } from "./slot";

export type ClaimInput = { kind: "new" | "resume" | null; caller: string; current: { phone: string } | null; slot: SlotState };
export type ClaimOutcome = { result: "accept" | "takeover" | "taken" | "replaced" | "none"; row: "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8" };

/** §5.5, first row that applies wins. T1 before T3/T4: the current phone re-claiming is process death, not a takeover. */
const CLAIM_ROWS: readonly { row: ClaimOutcome["row"]; when: (i: ClaimInput) => boolean; result: ClaimOutcome["result"] }[] = [
  { row: "T1", when: (i) => i.kind === "new" && (i.current === null || i.current.phone === i.caller), result: "accept" },
  { row: "T3", when: (i) => i.kind === "new" && i.slot === "live", result: "taken" },
  { row: "T4", when: (i) => i.kind === "new" && i.slot === "live_dead", result: "takeover" },
  { row: "T2", when: (i) => i.kind === "new", result: "takeover" },
  { row: "T5", when: (i) => i.kind === "resume" && (i.current === null || i.current.phone === i.caller), result: "accept" },
  { row: "T6", when: (i) => i.kind === "resume", result: "replaced" },
  { row: "T8", when: (i) => i.kind === null && i.current?.phone === i.caller, result: "none" },
  { row: "T7", when: () => true, result: "replaced" },
];

export function decideClaim(i: ClaimInput): ClaimOutcome {
  const hit = CLAIM_ROWS.find((r) => r.when(i))!;   // the last row always matches; pairing.test.ts reaches it
  return { result: hit.result, row: hit.row };
}

const since = (at: Date, now: Date): number => now.getTime() - at.getTime();

/** The cadence the server answered (`answered_poll_seconds`, DB-bounded 5..300). Anything that is not a positive
 *  finite number would make every phone silent at once, so it is refused by name instead. */
function cadenceMs(answeredPoll: number): number {
  if (!Number.isFinite(answeredPoll) || answeredPoll <= 0) {
    throw new RangeError(`answeredPoll must be a positive number of seconds, got ${answeredPoll}`);
  }
  return answeredPoll * 1000;
}

/** §6.9: `now − last_beat_at ≥ max(floor, answered_poll_seconds + slack)`. */
export function isSilent(lastBeatAt: Date, answeredPoll: number, now: Date, floorSeconds: number): boolean {
  const threshold = Math.max(floorSeconds * 1000, cadenceMs(answeredPoll) + PHONE_SILENT_SLACK_SECONDS * 1000);
  return since(lastBeatAt, now) >= threshold;
}

/** §6.9: current, and not silent. What gates Go live (T10). */
export function isPresent(i: { current: boolean; lastBeatAt: Date; answeredPoll: number }, now: Date, floorSeconds: number): boolean {
  return i.current && !isSilent(i.lastBeatAt, i.answeredPoll, now, floorSeconds);
}

/** §6.9 (W8): held (an open session) and no beat for NOT_RESPONDING_BEATS answered cadences. */
export function isNotResponding(i: { held: boolean; lastBeatAt: Date; answeredPoll: number }, now: Date): boolean {
  const threshold = NOT_RESPONDING_BEATS * cadenceMs(i.answeredPoll);
  return i.held && since(i.lastBeatAt, now) >= threshold;
}

/** A14 / T4 (§6.5), its three conjuncts:
 *   1. no beat from the current phone for the window;
 *   2. a FRESH Cloudflare read says the input is not connected (the dead phone is not still pushing video);
 *   3. no poll sample has read it connected for the window — measured from first ingest when none ever has
 *      (§6.8.5's "or first_ingest_at, if none"). */
export function deadForTakeover(
  i: { lastBeatAt: Date; freshReadConnected: boolean; lastConnectedAt: Date | null; liveSince: Date },
  now: Date,
  windowSeconds: number,
): boolean {
  const windowMs = windowSeconds * 1000;
  return since(i.lastBeatAt, now) >= windowMs
    && !i.freshReadConnected
    && since(i.lastConnectedAt ?? i.liveSince, now) >= windowMs;
}
