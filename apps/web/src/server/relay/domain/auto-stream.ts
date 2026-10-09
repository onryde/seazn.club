// Capture QR v2 PR-2 (spec §7.2 auto start, §7.3 auto stop; W7, A4, A12, A15, A16). Pure: no I/O, `now` passed in. The
// seconds that tunable() may shorten (§6.15) are REQUIRED trailing parameters with no default, so this file never reads the
// environment. tsc only forces a NUMBER there, not `tunable(…)`: the call sites (T4 auto start, T5 auto stop) must pass
// `tunable("AUTO_START_RETRY_SECONDS", …)` / `tunable("AUTO_STOP_AFTER_RESULT_SECONDS", …)`, and T4 and T5 own the source
// guard that proves they do (a literal or the bare default there would silently ignore the walkthrough's override).
//
// Each predicate is a strategy TABLE: one `{ name, holds }` per conjunct of the spec's `autoStartDue` / `autoStopDue`, so a
// verdict names every conjunct that failed (a log line, a panel reason) and a test can falsify each one alone. A conjunct
// judges ONE fact; a conjunct that reads a fact another conjunct also guards would let each cover for the other.

/** §7.2: the codes a refused auto start stores in `auto_start_refusal`. V431's CHECK list is compared with this by
 *  v431-migration.test.ts. */
export const AUTO_START_REFUSALS = ["no_destination", "no_credit", "not_entitled", "destination_in_use", "unavailable"] as const;
export type AutoStartRefusal = (typeof AUTO_START_REFUSALS)[number];

/** The phone's own switch (capture A4): `automatic` is the only value that lets the server start or stop for it. */
export type PhoneMode = "automatic" | "operator";

export type AutoStartFacts = {
  /** The fixture's `auto_stream` (false when it has no settings row). */
  autoStream: boolean;
  /** The arriving beat's `mode`; null when there is no phone beat to read. */
  phoneMode: PhoneMode | null;
  /** §6.9 present: current and not silent. */
  phonePresent: boolean;
  fixtureStatus: string;
  /** Any non-terminal session of this fixture. */
  openSession: boolean;
  autoStartedAt: Date | null;
  autoStartBlockedAt: Date | null;
  /** "before any broadcast has run" (A16): some session of this fixture EVER received ingest. */
  anySessionHadIngest: boolean;
  autoStartAttemptedAt: Date | null;
};

type StartConjunct = { name: string; holds: (f: AutoStartFacts, now: Date, retrySeconds: number) => boolean };

/** §7.2's `autoStartDue`, one row per line, in the spec's order. */
export const AUTO_START_CONJUNCTS: readonly StartConjunct[] = [
  { name: "switch_on", holds: (f) => f.autoStream },
  { name: "phone_automatic", holds: (f) => f.phoneMode === "automatic" },
  { name: "phone_present", holds: (f) => f.phonePresent },
  { name: "in_play", holds: (f) => f.fixtureStatus === "in_play" },
  { name: "no_open_session", holds: (f) => !f.openSession },
  { name: "not_yet_started", holds: (f) => f.autoStartedAt === null },
  { name: "not_blocked", holds: (f) => f.autoStartBlockedAt === null },
  { name: "no_broadcast_ran", holds: (f) => !f.anySessionHadIngest },
  { name: "retry_spacing", holds: (f, now, secs) => f.autoStartAttemptedAt === null || now.getTime() - f.autoStartAttemptedAt.getTime() >= secs * 1000 },
];

/** Due when every conjunct holds; `failed` names each one that does not, in table order (not just the first). */
export function autoStartVerdict(f: AutoStartFacts, now: Date, retrySeconds: number): { due: boolean; failed: string[] } {
  const failed = AUTO_START_CONJUNCTS.filter((c) => !c.holds(f, now, retrySeconds)).map((c) => c.name);
  return { due: failed.length === 0, failed };
}

/**
 * Final review I-1 (owner, 2026-10-08, option A): the LATCHES — the conjuncts of `autoStartDue` that, once failed, stay
 * failed for the rest of the match, so a switch left ON will not start it. The panel says which, under the switch.
 *  - `stopped`: an organiser Stop or Cancel (A12, `not_blocked`);
 *  - `already_streamed`: some session of this fixture received video (A16, `no_broadcast_ran`);
 *  - `already_started`: the automatic start has run (once per match, `not_yet_started`).
 * PRECEDENCE is the row order: when several hold, the FIRST names the reason — stopped > already_streamed >
 * already_started. The organiser's own act explains itself best; and an automatic start that received video is a stream
 * that ran, the broader fact. Each row names its conjunct, and `autoWontStart` reads the VERDICT's failures — the
 * predicate is the conjunct's own `holds`, never a copy. Every other conjunct (the switch, the phone, the status, an open
 * session, the retry spacing) can still change during the match, so none of them is a latch.
 */
export const AUTO_START_LATCHES = [
  { wontStart: "stopped", conjunct: "not_blocked" },
  { wontStart: "already_streamed", conjunct: "no_broadcast_ran" },
  { wontStart: "already_started", conjunct: "not_yet_started" },
] as const;
export type AutoWontStart = (typeof AUTO_START_LATCHES)[number]["wontStart"];
export const AUTO_WONT_START = AUTO_START_LATCHES.map((l) => l.wontStart) as [AutoWontStart, ...AutoWontStart[]];

/** The latch that holds, by precedence, over a verdict's `failed` (from `autoStartVerdict` on the same facts); null when
 *  none does. */
export function autoWontStart(failed: readonly string[]): AutoWontStart | null {
  return AUTO_START_LATCHES.find((l) => failed.includes(l.conjunct))?.wontStart ?? null;
}

export type AutoStopFacts = {
  autoStream: boolean;
  /** The session's phone's stored `mode` (lags the phone's Settings by at most one poll interval, FP13); null when it has none. */
  phoneMode: PhoneMode | null;
  /** The fixture's `finished_at` (V430's trigger stamps it from `status`); null while no result stands. */
  finishedAt: Date | null;
  /** Whether the session's `created_at` is strictly before the fixture's `finished_at`. The CALLER computes it IN SQL
   *  (`s.created_at < f.finished_at`): both are database stamps at microsecond precision, and a JS `Date` truncates to the
   *  millisecond, so a session created in the result's own millisecond would compare equal here and flip the verdict
   *  (Review Focus 4). Read only while a result stands; `false` is the value to pass when there is none. */
  sessionPredatesResult: boolean;
};

type StopConjunct = { name: string; holds: (f: AutoStopFacts, now: Date, delaySeconds: number) => boolean };

/** §7.3's `autoStopDue(session)`. The two conjuncts that read the result HOLD while there is none (a null `finishedAt`):
 *  `fixture_finished` is the one that says a result must stand, so each conjunct fails for exactly one reason. */
export const AUTO_STOP_CONJUNCTS: readonly StopConjunct[] = [
  { name: "switch_on", holds: (f) => f.autoStream },
  { name: "phone_automatic", holds: (f) => f.phoneMode === "automatic" },
  { name: "fixture_finished", holds: (f) => f.finishedAt !== null },
  { name: "delay_elapsed", holds: (f, now, secs) => f.finishedAt === null || now.getTime() >= f.finishedAt.getTime() + secs * 1000 },
  // A15: a broadcast started AFTER the result is the organiser's deliberate post-match one and is never auto-stopped; strictly before.
  { name: "session_predates_result", holds: (f) => f.finishedAt === null || f.sessionPredatesResult },
];

/** B7 review M-3: whether §7.3 will ever stop THIS session — every conjunct of the table above except the two that wait for
 *  the result to stand and age (`fixture_finished`, `delay_elapsed`). The panel's live line ("stops about N minutes after
 *  the result") is a promise about the session on air, so it is shown only on this answer: never for A15's post-result
 *  broadcast, a switch turned off, or a phone in Operator. The same facts the tick judges, so the two cannot disagree. */
const WAITS_FOR_THE_RESULT: ReadonlySet<string> = new Set(["fixture_finished", "delay_elapsed"]);
export function autoStopApplies(f: AutoStopFacts): boolean {
  // The remaining conjuncts read neither the clock nor the delay; they are given neutral ones.
  return AUTO_STOP_CONJUNCTS.every((c) => WAITS_FOR_THE_RESULT.has(c.name) || c.holds(f, new Date(0), 0));
}

/** Due when every conjunct holds; `failed` names each one that does not, in table order. */
export function autoStopVerdict(f: AutoStopFacts, now: Date, delaySeconds: number): { due: boolean; failed: string[] } {
  const failed = AUTO_STOP_CONJUNCTS.filter((c) => !c.holds(f, now, delaySeconds)).map((c) => c.name);
  return { due: failed.length === 0, failed };
}
