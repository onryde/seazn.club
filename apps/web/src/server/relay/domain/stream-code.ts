// Capture QR v2 §5.1 — the stream code's machine. Pure: no I/O, `now` passed in (domain-purity.test.ts).
//
//             ensure / first mint
//    (none) ───────────────────────▶ ACTIVE ──── reissue ──▶ ENDED(reissued)   (C3: still serves its open
//                                      │                                        session's phone, get + beat)
//                                      │ fixture finished
//                                      ▼
//                               ACTIVE·FINISHING ── result reverted (C5) ──▶ ACTIVE
//                                      │ now ≥ finished_at + grace AND no open session (C2)
//                                      ▼
//                                ENDED(expired)
import { CAPTURE_CODE_RE } from "@/server/api-v1/capture-schemas";
import { CAPTURE_RECORD_TAIL_HOURS } from "../config";

/** Trims, lower-cases and tests the published code shape (Crockford base-32, 12 characters). null = not a code. */
export function normaliseCode(raw: string): string | null {
  const code = raw.trim().toLowerCase();
  return CAPTURE_CODE_RE.test(code) ? code : null;
}

export type CodeView = { endedAt: Date | null; finishedAt: Date | null };
/** `expiry_due` is C2's evaluation finding the code expired: the caller writes `ended_at`, `end_cause = 'expired'`
 *  and wipes the sealed tok. It is never stored. */
export type CodeStatus = "active" | "finishing" | "ended" | "expiry_due";
/** `record` is the operator's Send record (spec 2026-10-12 §4): it serves wherever a `get` would, from ANY phone (R4),
 *  plus the 24 h tail C1(c). */
export type CodeCall = "get" | "beat" | "claim" | "start" | "record";

type StatusInput = { v: CodeView; now: Date; hasOpenSession: boolean; graceMs: number };
const STATUS_ROWS: readonly { when: (i: StatusInput) => boolean; status: CodeStatus }[] = [
  { when: (i) => i.v.endedAt !== null, status: "ended" },
  { when: (i) => i.v.finishedAt === null, status: "active" },                                              // C5
  { when: (i) => !i.hasOpenSession && i.now.getTime() - i.v.finishedAt!.getTime() >= i.graceMs, status: "expiry_due" }, // C2
  { when: () => true, status: "finishing" },                                                                // an open session defers
];

/** C2: expiry is evaluated, never scheduled. `graceMinutes` is REQUIRED (no default): the use-case passes
 *  `tunable("CODE_GRACE_AFTER_FINISH_MINUTES", CODE_GRACE_AFTER_FINISH_MINUTES)` (§6.15), and tsc refuses a call site
 *  that forgets. */
export function codeStatus(v: CodeView, now: Date, hasOpenSession: boolean, graceMinutes: number): CodeStatus {
  const i = { v, now, hasOpenSession, graceMs: graceMinutes * 60_000 };
  return STATUS_ROWS.find((r) => r.when(i))!.status;   // the last row always matches
}

/** C1(c)'s clock for a `record` call: the request's `now` and the tail's anchor (`recordTailAnchor`; null = no tail). */
export type RecordTail = { now: Date; anchor: Date | null };
type ServesInput = { status: CodeStatus; callerIsOpenSessionPhone: boolean; sessionCreatedBeforeEnd: boolean; call: CodeCall; tail?: RecordTail };
/** C1b / C3: an ended code serves its open session's phone only for these — never a new claim, never a start. */
const C1B_CALLS: readonly CodeCall[] = ["get", "beat"];
const TAIL_MS = CAPTURE_RECORD_TAIL_HOURS * 3_600_000;
const inTail = (t: RecordTail): boolean => t.anchor !== null && t.now.getTime() - t.anchor.getTime() <= TAIL_MS;
const SERVES_ROWS: readonly { when: (i: ServesInput) => boolean; serves: boolean }[] = [
  { when: (i) => i.status === "active" || i.status === "finishing", serves: true },                         // C1(a)
  { when: (i) => i.status === "ended" && i.callerIsOpenSessionPhone && i.sessionCreatedBeforeEnd && C1B_CALLS.includes(i.call), serves: true }, // C1(b)
  // Spec 2026-10-12 §4 (P11, Q1): C1(b) for a record drops the phone condition (R4), and C1(c) adds the 24 h tail.
  { when: (i) => i.status === "ended" && i.call === "record" && i.sessionCreatedBeforeEnd, serves: true },   // C1(b), record
  { when: (i) => i.status === "ended" && i.call === "record" && inTail(i.tail!), serves: true },             // C1(c)
  { when: () => true, serves: false },                                                                      // 401 code_ended
];

/** C1: whether a code whose tok verified answers this call. Anything false is `401 code_ended`. A `record` call must
 *  carry its tail: without one C1(c) could not be judged, so it is a named refusal rather than a silent `false`. */
export function codeServes(i: ServesInput): boolean {
  if (i.call === "record" && i.tail === undefined) throw new RangeError("codeServes: a record call needs its tail (C1(c))");
  return SERVES_ROWS.find((r) => r.when(i))!.serves;
}

/**
 * C1(c)'s anchor (spec 2026-10-12 §4): the LATER of
 *  - the code's own end: `ended_at` for a reissue; for an expiry, `finished_at` plus the grace — NOT the lazily written
 *    `ended_at`, which can land long after the code stopped serving (a reverted result, C5, leaves no finished_at, so
 *    the expiry falls back to its ended_at);
 *  - the end of the last session of the fixture that was open when the code ended (created before `ended_at`), which
 *    C1(a) or C1(b) served. A session still open has no end: C1(b) serves it, not the tail.
 * null for a code that has not ended. `graceMinutes` is the use-case's `tunable(…)`, passed in.
 */
export function recordTailAnchor(i: {
  endCause: "reissued" | "expired" | null; endedAt: Date | null; finishedAt: Date | null; graceMinutes: number;
  sessions: readonly { createdAt: Date; endedAt: Date | null }[];
}): Date | null {
  if (i.endedAt === null) return null;
  const endedAt = i.endedAt.getTime();
  const codeEnd = i.endCause === "expired" && i.finishedAt !== null ? i.finishedAt.getTime() + i.graceMinutes * 60_000 : endedAt;
  const sessionEnds = i.sessions
    .filter((s) => s.createdAt.getTime() < endedAt && s.endedAt !== null)
    .map((s) => s.endedAt!.getTime());
  return new Date(Math.max(codeEnd, ...sessionEnds));
}
