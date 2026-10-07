// Capture QR v2 PR-2 (spec §7.2 auto start, §7.3 auto stop; W7, A4, A12, A15, A16). Pure: no I/O, `now` passed in. The
// seconds that tunable() may shorten (§6.15) are REQUIRED trailing parameters with no default, so tsc forces every
// use-case call site to pass `tunable(…)` and this file never reads the environment.
//
// Each predicate is a strategy TABLE: one `{ name, holds }` per conjunct of the spec's `autoStartDue` / `autoStopDue`, so a
// verdict names every conjunct that failed (a log line, a panel reason) and a test can falsify each one alone. A conjunct
// judges ONE fact; a conjunct that reads a fact another conjunct also guards would let each cover for the other.

/** §7.2: the codes a refused auto start stores in `auto_start_refusal` (V431's CHECK list is derived from this by v431-migration.test.ts). */
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

export type AutoStopFacts = {
  autoStream: boolean;
  /** The session's phone's stored `mode` (lags the phone's Settings by at most one poll interval, FP13); null when it has none. */
  phoneMode: PhoneMode | null;
  /** The fixture's `finished_at` (V430's trigger stamps it from `status`); null while no result stands. */
  finishedAt: Date | null;
  /** The session's `created_at`. Both stamps are database clocks, so the comparison below is skew-free (Review Focus 4). */
  sessionCreatedAt: Date;
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
  { name: "session_predates_result", holds: (f) => f.finishedAt === null || f.sessionCreatedAt.getTime() < f.finishedAt.getTime() },
];

/** Due when every conjunct holds; `failed` names each one that does not, in table order. */
export function autoStopVerdict(f: AutoStopFacts, now: Date, delaySeconds: number): { due: boolean; failed: string[] } {
  const failed = AUTO_STOP_CONJUNCTS.filter((c) => !c.holds(f, now, delaySeconds)).map((c) => c.name);
  return { due: failed.length === 0, failed };
}
