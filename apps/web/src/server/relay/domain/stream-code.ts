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
import { CODE_GRACE_AFTER_FINISH_MINUTES } from "../config";

/** Trims, lower-cases and tests the published code shape (Crockford base-32, 12 characters). null = not a code. */
export function normaliseCode(raw: string): string | null {
  const code = raw.trim().toLowerCase();
  return CAPTURE_CODE_RE.test(code) ? code : null;
}

export type CodeView = { endedAt: Date | null; finishedAt: Date | null };
/** `expiry_due` is C2's evaluation finding the code expired: the caller writes `ended_at`, `end_cause = 'expired'`
 *  and wipes the sealed tok. It is never stored. */
export type CodeStatus = "active" | "finishing" | "ended" | "expiry_due";
export type CodeCall = "get" | "beat" | "claim" | "start";

type StatusInput = { v: CodeView; now: Date; hasOpenSession: boolean; graceMs: number };
const STATUS_ROWS: readonly { when: (i: StatusInput) => boolean; status: CodeStatus }[] = [
  { when: (i) => i.v.endedAt !== null, status: "ended" },
  { when: (i) => i.v.finishedAt === null, status: "active" },                                              // C5
  { when: (i) => !i.hasOpenSession && i.now.getTime() - i.v.finishedAt!.getTime() >= i.graceMs, status: "expiry_due" }, // C2
  { when: () => true, status: "finishing" },                                                                // an open session defers
];

/** C2: expiry is evaluated, never scheduled. `graceMinutes` is a parameter so the use-case can pass
 *  `tunable("CODE_GRACE_AFTER_FINISH_MINUTES", …)` (§6.15). */
export function codeStatus(v: CodeView, now: Date, hasOpenSession: boolean, graceMinutes: number = CODE_GRACE_AFTER_FINISH_MINUTES): CodeStatus {
  const i = { v, now, hasOpenSession, graceMs: graceMinutes * 60_000 };
  return STATUS_ROWS.find((r) => r.when(i))!.status;   // the last row always matches
}

type ServesInput = { status: CodeStatus; callerIsOpenSessionPhone: boolean; sessionCreatedBeforeEnd: boolean; call: CodeCall };
/** C1b / C3: an ended code serves its open session's phone only for these — never a new claim, never a start. */
const C1B_CALLS: readonly CodeCall[] = ["get", "beat"];
const SERVES_ROWS: readonly { when: (i: ServesInput) => boolean; serves: boolean }[] = [
  { when: (i) => i.status === "active" || i.status === "finishing", serves: true },                         // C1(a)
  { when: (i) => i.status === "ended" && i.callerIsOpenSessionPhone && i.sessionCreatedBeforeEnd && C1B_CALLS.includes(i.call), serves: true }, // C1(b)
  { when: () => true, serves: false },                                                                      // 401 code_ended
];

/** C1: whether a code whose tok verified answers this call. Anything false is `401 code_ended`. */
export function codeServes(i: ServesInput): boolean {
  return SERVES_ROWS.find((r) => r.when(i))!.serves;
}
