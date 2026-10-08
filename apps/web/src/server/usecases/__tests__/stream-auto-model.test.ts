// Capture QR v2 PR-2 T7 (spec §7.2 / §7.3; W7, A4, A12, A15, A16; plan FP8, FP12, FP13, Review Focus 2–4) — AUTOMATIC START AND
// STOP as a MODEL (TEST-STRATEGY rule 10), fast-check's `fc.commands`. One fixture per run, ONE paired phone, the REAL use-cases
// (`postBeat` → step 6 → `maybeAutoStart` → `startBroadcast`; `createSession`; `stopSession` with the A12 stamp;
// `tickSession` / `currentSession` / `tickOpenSessions` → the automatic stop; `saveStreamSettings`; `streamPhone`, the organiser
// read) on the FAKE drivers and the rig's tickable clock. The fixture's status moves by the SAME writes the product makes
// (`update fixtures set status`), through V430's `fixtures_track_finished` trigger (FP8).
//
// The model is the spec's rows (§7.2 `autoStartDue`, §7.3 `autoStopDue`, W7, A12, A15, A16), written out HERE as named
// conjuncts — never imported from `domain/auto-stream.ts`, which is the code under test. The declared conjunct lists are
// compared by NAME only, so a conjunct added to the domain that this model does not judge fails the file. Each command predicts
// its outcome from the model, runs the real call, and compares: the sessions it created, the ones it ended and WHY, every
// column of the settings row, the fixture, the pairing, the beat's `autoAllowed` and the organiser read. After EVERY step
// the invariants are read from the database (the model is the oracle for the prediction; the invariants do not trust it).
//
// Invariants (checked on the rows after every step):
//   1. at most one automatic session per fixture, ever (the once-per-match claim);
//   2. never an automatic start after an organiser Stop of a non-terminal session (A12) — judged against the instant the MODEL
//      did the Stop, not against the stamp the code wrote;
//   3. never an automatic start after any session of this fixture received ingest (A16);
//   4. a session created at or after the result's CURRENT `finished_at` is never auto-stopped (A15). THE SCORE-CORRECTION EDGE —
//      owner ruling 2026-10-08 (relayed by the controller): ACCEPTED as the spec's literal §7.3 predicate, so it is NOT forbidden
//      here: after a revert and a re-finish, a broadcast created BETWEEN the two finishes reads `created_at < new finished_at`
//      and IS auto-stopped once the new 180 s are over. Pinned by the scene "the score-correction edge" (counter
//      `autoStopOfBroadcastBornBetweenTwoFinishes`, required like every other);
//   5. a reverted result cancels a pending automatic stop, and a re-finish restarts the 180 s: an auto-stopped session ended with
//      a result standing and ≥ AUTO_STOP_AFTER_RESULT_SECONDS after that result's `finished_at`;
//   6. an automatic stop fires only when the predicate holds, and by the next tick once it does (no tick, no end);
//   7. an automatic start is retried no more often than AUTO_START_RETRY_SECONDS, and a refusal never stamps `auto_started_at`;
//   8. the switch never changes `target_chosen` / `target_id` — nor does an automatic start, a Stop stamp, or any step but
//      the organiser's own Go live (the destination pick). Witnessed both ways: a switch that CREATES the row (nothing chosen
//      may become chosen) and a switch beside a pick (a choice may not be cleared).
// The invariants run FIRST on every step, from the rows alone (each new session's `created_at` already on the rig clock), and
// only then is the model's prediction compared — so a defect an invariant can see is named by that invariant. Each invariant's
// witness counters are printed on the report's `invariants:` line, and every one must be non-zero.
// Plus: `autoAllowed` on every beat answer equals the switch; the organiser read (`auto`) agrees with the rows; no error is
// reported to Sentry by any step (step 6 swallows an auto-start throw, so only a spy sees it).
//
// Two clocks (Review Focus 4). `finished_at` and a session's `created_at` are DATABASE stamps; the 180 s delay and every other
// timer is the rig's `now`. The model puts both on the RIG clock — `finished_at` is set explicitly after the status write
// (FP8, as capture-model's `finish`), and each created session's `created_at` is set to the rig instant it was created at — so
// "created before the result" has an exact answer, ties included (the SQL is strictly before: a session created in the
// result's own millisecond is not auto-stopped). Every command that can create a session ticks the clock 1 ms first, so two
// sessions never share an instant.
//
// What the tick can end, besides the automatic stop, and how the model treats it: the warming timeout (WARMING_TIMEOUT_MINUTES
// from creation, certain) and ask 10 (a never-ingested session whose phone is silent: the cadence is the server's, so the model
// only knows the NECESSARY condition — silence ≥ PHONE_SILENT_FLOOR_SECONDS — and accepts the end then, never otherwise).
// Ingest, once on, stays connected (no W19), and the arriving beat is never silent (so a beat's own tick never ends a session
// by ask 10). The reason a session ended is always checked against the set the model allows.
//
// ONE SPORT, on purpose (rule 6): the predicates read the fixture's status and nothing about the sport (stream-auto.test.ts and
// stream-auto-stop.test.ts each run a cricket case).
//
// Anti-vacuity: every command and every outcome is counted over the DRAWN runs, and a zero fails — including, for each declared
// conjunct of both predicates, the number of steps where it was the ONLY one failing (the witness that falsifying that conjunct
// alone is what withheld the start or stop). `phone_present` cannot fail on a beat (the arriving beat is present) and is the one
// named exemption. The seed comes from CAPTURE_AUTO_MODEL_SEED (default fixed) and is written, with the tally, to
// CAPTURE_AUTO_MODEL_REPORT (default: the OS tmpdir), into the test's title, and to stdout (pass or fail: a failing property's
// report is printed before fast-check's own error, which names the seed and the path again). CAPTURE_AUTO_MODEL_SHRINK=0 reports the first
// failing sequence unshrunk (a mutation sweep needs the kill, not the minimal case). CAPTURE_AUTO_MODEL_TRACE=<file> writes one line
// per settled step (the command, the rig clock, the model's sessions) for reading a counterexample.
//
// Edges: a plain `advance` plus a beat's 1 ms pre-tick overshoots every boundary by a millisecond, so `advanceToRetryEdge` parks the
// clock to make the NEXT step land exactly ON (0) or one millisecond BEFORE (-1) the retry spacing; the stop delay's edge is
// reached by `advance(DELAY_MS)` straight after the result (ticks do not pre-tick). The pinned scenes at the foot run each rare
// ordering ALONE in a declared world and require the counters only that ordering can move.
//
// What a sequential model cannot separate: a conjunct the claim's SQL repeats (once-per-match, retry spacing, the switch, not-blocked)
// is guarded twice, so removing ONE copy changes nothing observable here — the pair is what the model kills. The claim's atomicity
// under concurrency is stream-auto.test.ts's ("the claim re-checks, atomically"), not this file's. Measured (T7 mutation sweep,
// 2026-10-08): the claim made UNCONDITIONAL leaves this file green — no row differs, because the verdict re-guards every sequential
// step and admission's `active_session` keeps one open session under the double beat (whose step 2 serialises on the code row, so
// it never races the facts read); stream-auto.test.ts's "the claim is what makes it atomic" and "the claim re-checks" kill it.
// A mutant that TIGHTENS one copy (the verdict's `>=` made `>`) is seen here; one that loosens a single copy is not.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import fc from "fast-check";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import { CaptureBeat, CaptureBeatAnswer } from "@/server/api-v1/capture-schemas";
import { rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import {
  AUTO_START_RETRY_SECONDS, AUTO_STOP_AFTER_RESULT_SECONDS, CODE_GRACE_AFTER_FINISH_MINUTES, PHONE_SILENT_FLOOR_SECONDS,
  WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { AUTO_START_CONJUNCTS, AUTO_STOP_CONJUNCTS } from "@/server/relay/domain/auto-stream";
import { postBeat } from "../capture-phone";
import { saveStreamSettings } from "../stream-codes";
import { creditBalance, grantCredits } from "../stream-credits";
import { streamPhone } from "../stream-phone";
import { createSession, currentSession, stopSession, tickOpenSessions, tickSession } from "../stream-sessions";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.AUTH_SECRET = "stream-auto-model-test-secret";
}
beforeAll(baseEnv);
beforeEach(() => { baseEnv(); sentry.captureError.mockClear(); });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const SEC = 1000;
const MIN = 60 * SEC;
const RUNS = Number(process.env.CAPTURE_AUTO_MODEL_RUNS ?? 200);
const SEED = Number(process.env.CAPTURE_AUTO_MODEL_SEED ?? 20261008);
const MAX_COMMANDS = 40;
/** CAPTURE_AUTO_MODEL_TRACE=<file>: one line per settled step (the command, the rig clock since the run began, the model's sessions). */
const TRACE = process.env.CAPTURE_AUTO_MODEL_TRACE ?? null;
const REPORT = process.env.CAPTURE_AUTO_MODEL_REPORT ?? `${tmpdir()}/stream-auto-model-report.txt`;

// The spec's figures, from the declarations (never typed here).
const RETRY_MS = AUTO_START_RETRY_SECONDS * SEC;
const DELAY_MS = AUTO_STOP_AFTER_RESULT_SECONDS * SEC;
const FLOOR_MS = PHONE_SILENT_FLOOR_SECONDS * SEC;
const WARMING_MS = WARMING_TIMEOUT_MINUTES * MIN;
const GRACE_MS = CODE_GRACE_AFTER_FINISH_MINUTES * MIN;
/** A read that must be CLAIMED, not coalesced (PR-1's ingest-read coalescing: the previous claim is at least this old). The
 *  brief's "CONNECT_MS + POLL_NEAR_SECONDS" figure is what the fake's connect delay needs; this fake is scripted (`setState`),
 *  so only the coalescing window matters: twice the poll interval clears it. */
const FRESH_READ_MS = 2 * STREAM_POLL_MS;
/** C2 ends a finished fixture's code GRACE after the finish (nothing open): a run stays inside three quarters of it, so no
 *  step meets an expired code (guarded again at every step). */
const RUN_BUDGET_MS = (GRACE_MS * 3) / 4;

type Mode = "automatic" | "operator";
/** How a session ended, as the model names it. */
type EndKey = "auto_stopped" | "timeout" | "phone_lost" | "stopped";

// ---------------------------------------------------------------------------------------------------------------------
// The model — the spec's rows, as facts
// ---------------------------------------------------------------------------------------------------------------------

type S = {
  sid: string;
  /** The rig instant it was created at (its `created_at` is set to it). */
  createdAt: number;
  startedBy: "automatic" | "organiser";
  live: boolean;
  /** The rig instant of its first ingest. */
  ingestAt: number | null;
  open: boolean;
  end: { key: EndKey; at: number } | null;
  /** A result had been recorded at or before its creation (some finish, reverted or not): only a re-finish can make it predate
   *  the CURRENT result, so an automatic stop of it is the owner-accepted score-correction edge. */
  bornAfterAResult: boolean;
};

type Model = {
  status: "scheduled" | "in_play" | "decided";
  /** `fixtures.finished_at` on the rig clock; null while no result stands. */
  finishedAt: number | null;
  autoOn: boolean;
  /** Credits are 0 (every start is refused `no_credit`) or ≥ 10 (never exhausted in a run: ≤ 4 paid lives). */
  funded: boolean;
  /** A settings row exists (the switch, the pre-pick, the Stop stamp or a Go live made it). */
  row: boolean;
  /** The organiser has chosen a destination (`target_chosen`) — the setup's pick, or a Go live (§6.6 pre-pick). */
  picked: boolean;
  pairing: { storedMode: Mode; lastBeatAt: number } | null;
  startedAt: number | null;
  autoSid: string | null;
  /** The instant of the FIRST organiser Stop of a non-terminal session (A12; the first stamp wins). */
  blockedAt: number | null;
  attemptedAt: number | null;
  refusal: "no_credit" | null;
  sessions: S[];
  t0: number;
  now: () => number;
  /** For the revert/re-finish witnesses: the `finished_at` a reverted result had while a stop was pending. */
  revertedPendingFinish: number | null;
  /** The previous finish's instant while a re-finish is within ITS 180 s but past the previous one's. */
  prevFinish: number | null;
  /** The latest finish ever recorded (a revert does not clear it). */
  lastFinish: number | null;
};

const openOf = (m: Readonly<Model>): S | null => m.sessions.find((s) => s.open) ?? null;
const elapsed = (m: Readonly<Model>) => m.now() - m.t0;

type Cj = { name: string; holds: boolean };
/** §7.2 `autoStartDue`, one row per conjunct, in the spec's order. */
function startVector(m: Readonly<Model>, mode: Mode, now: number): Cj[] {
  return [
    { name: "switch_on", holds: m.autoOn },
    { name: "phone_automatic", holds: mode === "automatic" },
    { name: "phone_present", holds: true },   // the arriving beat IS the phone's: it cannot be silent (the one exemption)
    { name: "in_play", holds: m.status === "in_play" },
    { name: "no_open_session", holds: openOf(m) === null },
    { name: "not_yet_started", holds: m.startedAt === null },
    { name: "not_blocked", holds: m.blockedAt === null },
    { name: "no_broadcast_ran", holds: !m.sessions.some((s) => s.ingestAt !== null) },
    { name: "retry_spacing", holds: m.attemptedAt === null || now - m.attemptedAt >= RETRY_MS },
  ];
}
/** §7.3 `autoStopDue(session)`. The two conjuncts that read the result hold while there is none, so `fixture_finished` is the one
 *  that says a result must stand (the same convention as the domain's table: each conjunct fails for one reason). */
function stopVector(m: Readonly<Model>, s: S, now: number): Cj[] {
  const f = m.finishedAt;
  return [
    { name: "switch_on", holds: m.autoOn },
    { name: "phone_automatic", holds: m.pairing?.storedMode === "automatic" },
    { name: "fixture_finished", holds: f !== null },
    { name: "delay_elapsed", holds: f === null || now >= f + DELAY_MS },
    { name: "session_predates_result", holds: f === null || s.createdAt < f },
  ];
}
const allHold = (v: Cj[]) => v.every((c) => c.holds);
/** The single failing conjunct, when exactly one fails. */
const soleBlocker = (v: Cj[]): string | null => { const f = v.filter((c) => !c.holds); return f.length === 1 ? f[0]!.name : null; };

// ---------------------------------------------------------------------------------------------------------------------
// The tally
// ---------------------------------------------------------------------------------------------------------------------

const COUNT_KEYS = [
  // §7.2 — the outcomes
  "autoStartsFired", "autoStartsRefused", "retriesFired", "startAtLatePairing", "startOnTheBeatThatTickedTheStopped",
  // §7.2 retry spacing, at its edge: a retry ONE millisecond early is withheld, one exactly at the spacing fires
  "retryWithheldOneMsEarly", "retryFiredAtTheEdge",
  // §7.2 — each conjunct the only one failing (phone_present is the exemption)
  "startSole:switch_on", "startSole:phone_automatic", "startSole:in_play", "startSole:no_open_session", "startSole:not_yet_started",
  "startSole:not_blocked", "startSole:no_broadcast_ran", "startSole:retry_spacing",
  // §7.3 — the outcomes
  "autoStopsFired", "autoStopsOfHandStartedBroadcast", "autoStopsOfAutoStartedBroadcast", "autoStopsAtTheBoundary",
  // §7.3 — each conjunct the only one failing
  "stopSole:switch_on", "stopSole:phone_automatic", "stopSole:fixture_finished", "stopSole:delay_elapsed", "stopSole:session_predates_result",
  // the revert / re-finish and the tie witnesses
  "stopCancelledByRevert", "stopRestartedByRefinish", "postResultBroadcastLeftAlone", "createdInTheResultsMillisecondLeftAlone",
  // the score-correction edge (owner ruling 2026-10-08: accepted): a broadcast born after an earlier result, auto-stopped after a re-finish
  "autoStopOfBroadcastBornBetweenTwoFinishes",
  // invariant 8, both ways: the switch creating the row (nothing chosen) and the switch beside a pick (a choice)
  "switchCreatesTheRow", "switchBesideAPick",
  // the other ends the model accepts, and the Stop
  "warmingTimeouts", "phoneLostEnds", "organiserStopsStamped", "organiserStopsRepeated", "organiserStopsOfAutoStarted",
  // the organiser read: a stored refusal that every OTHER conjunct would still serve, withheld because a Stop blocked the start
  "storedRefusalHiddenAfterStop",
  // the inputs
  "modeFlips", "twoBeatRaces", "switchOns", "switchOffs", "manualGoLives", "manualRefusals", "ingests", "pickedRuns",
  "organiserReadChecks", "answersChecked",
] as const;
type CountKey = (typeof COUNT_KEYS)[number];
const ACTIONS = [
  "beat", "doubleBeat", "matchStart", "finish", "revert", "toggleAuto", "manualGoLive", "organiserStop", "advance", "tick", "ingestOn",
  "grantCredits", "advanceToRetryEdge", "sceneRefusalHiddenByStop", "sceneRefusalRetry", "sceneStopBlocksStart", "sceneIngestBlocksStart", "scenePostResult", "sceneRevertRefinish",
  "sceneTie", "sceneStopNeedsBoth", "sceneOnce", "sceneTimeout", "sceneTickThenStart", "sceneManualRefusal", "sceneAutoStartThenStop",
  "sceneOrganiserStopsAuto", "sceneScoreCorrection",
] as const;
type Action = (typeof ACTIONS)[number];

/** Each invariant's witnesses: the counters that move only when that invariant's check had something to bite on (a second start
 *  withheld, a start withheld by the Stop, a stop that fired, a broadcast left alone…). An invariant evaluated only on steps where
 *  it holds trivially proves nothing; these are printed per invariant and every one must be non-zero. */
const INVARIANT_WITNESSES: Readonly<Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, readonly CountKey[]>> = {
  1: ["autoStartsFired", "startSole:not_yet_started"],
  2: ["startSole:not_blocked", "organiserStopsOfAutoStarted", "storedRefusalHiddenAfterStop"],
  3: ["startSole:no_broadcast_ran"],
  4: ["postResultBroadcastLeftAlone", "createdInTheResultsMillisecondLeftAlone", "autoStopOfBroadcastBornBetweenTwoFinishes"],
  5: ["stopCancelledByRevert", "stopRestartedByRefinish", "stopSole:fixture_finished"],
  6: ["autoStopsFired", "autoStopsAtTheBoundary", "stopSole:delay_elapsed", "stopSole:switch_on", "stopSole:phone_automatic"],
  7: ["autoStartsRefused", "retriesFired", "retryWithheldOneMsEarly", "retryFiredAtTheEdge", "startSole:retry_spacing"],
  8: ["switchCreatesTheRow", "switchBesideAPick", "manualGoLives"],
};

class Tally {
  readonly counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Record<CountKey, number>;
  readonly actions = new Map<Action, number>(ACTIONS.map((a) => [a, 0]));
  steps = 0;
  invariantChecks = 0;
  runs = 0;
  count(k: CountKey) { this.counts[k]++; }
  action(a: Action) { this.actions.set(a, this.actions.get(a)! + 1); }
  report(): string {
    return `seed=${SEED} runs=${this.runs} steps=${this.steps} invariantChecks=${this.invariantChecks}\n`
      + `invariants: ${Object.entries(INVARIANT_WITNESSES).map(([n, ks]) => `${n}[${ks.map((k) => `${k}=${this.counts[k]}`).join(",")}]`).join(" ")}\n`
      + `counts: ${COUNT_KEYS.map((k) => `${k}=${this.counts[k]}`).join(" ")}\n`
      + `actions: ${ACTIONS.map((a) => `${a}=${this.actions.get(a)}`).join(" ")}\n`;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The database as each step sees it
// ---------------------------------------------------------------------------------------------------------------------

type SessRow = {
  id: string; state: string; start_cause: string; created_at: Date; first_ingest_at: Date | null; ended_at: Date | null;
  end_reason: string | null; fail_reason: string | null; target_id: string; warming_at: Date | null;
};
type SetRow = {
  auto_stream: boolean; auto_started_at: Date | null; auto_start_session_id: string | null; auto_start_blocked_at: Date | null;
  auto_start_attempted_at: Date | null; auto_start_refusal: string | null; target_chosen: boolean; target_id: string | null;
};
type Snap = {
  sessions: SessRow[];
  settings: SetRow | null;
  fixture: { status: string; finished_at: Date | null };
  pairing: { mode: string | null; last_beat_at: Date } | null;
};

type Real = {
  /** The command running (for the trace). */
  label: string;
  r: CaptureRig;
  phone: string;
  tally: Tally;
  /** The last settled snapshot — the next step's "before". */
  prev: Snap;
  /** What `r.target` is: the only destination, never archived in this model. */
  targetId: string;
};

async function snapshot(x: Real): Promise<Snap> {
  const fx = x.r.fixtureId;
  const sessions = await sql<SessRow[]>`
    select id, state, start_cause, created_at, first_ingest_at, ended_at, end_reason, fail_reason, target_id, warming_at
      from fixture_stream_sessions where fixture_id = ${fx} order by created_at, id`;
  const [settings] = await sql<SetRow[]>`
    select auto_stream, auto_started_at, auto_start_session_id, auto_start_blocked_at, auto_start_attempted_at, auto_start_refusal,
           target_chosen, target_id
      from fixture_stream_settings where fixture_id = ${fx}`;
  const [fixture] = await sql<{ status: string; finished_at: Date | null }[]>`select status, finished_at from fixtures where id = ${fx}`;
  const [pairing] = await sql<{ mode: string | null; last_beat_at: Date }[]>`
    select p.mode, p.last_beat_at
      from fixture_stream_codes c join fixture_stream_pairings p on p.code_id = c.id and p.slot = 0 and p.ended_at is null
     where c.fixture_id = ${fx} and c.ended_at is null`;
  return { sessions, settings: settings ?? null, fixture: fixture!, pairing: pairing ?? null };
}

const ACTIVE = ["requested", "provisioning", "warming", "live", "ending"];
const isOpenRow = (s: SessRow) => ACTIVE.includes(s.state);
const endKeyOf = (s: SessRow): EndKey | `unmodelled:${string}` => {
  if (s.state === "failed" && s.fail_reason === "no_inbound_timeout") return "timeout";
  if (s.state === "completed" && (s.end_reason === "auto_stopped" || s.end_reason === "phone_lost" || s.end_reason === "stopped")) return s.end_reason === "auto_stopped" ? "auto_stopped" : s.end_reason === "phone_lost" ? "phone_lost" : "stopped";
  return `unmodelled:${s.state}/${s.end_reason}/${s.fail_reason}`;
};
const ms = (d: Date | null) => (d === null ? null : d.getTime());

// ---------------------------------------------------------------------------------------------------------------------
// One step: predict (the command), run the real calls, then settle — compare, move the model, check the invariants
// ---------------------------------------------------------------------------------------------------------------------

type Plan = { allowed: ReadonlySet<EndKey>; must: boolean };
type Info = {
  /** The rig clock at the end of the step (the instant every tick of the step judged at). */
  now: number;
  /** A session this step must have created, and who started it. */
  created: "automatic" | "organiser" | null;
  /** For each session the step may end: the reasons allowed, and whether an end is owed. A session absent from the map must stay open. */
  closes: Map<string, Plan>;
  /** The step is the organiser's Go live (the only step allowed to move the destination pick). */
  movesPick: boolean;
  /** Sessions whose first ingest this step's tick must have recorded, at `now`. Every other session keeps its first ingest. */
  goesLive: Set<string>;
  /** The beat answers parsed in this step. */
  answers: ReturnType<typeof CaptureBeatAnswer.parse>[];
};
const newInfo = (x: Real): Info => ({ now: x.r.now().getTime(), created: null, closes: new Map(), movesPick: false, goesLive: new Set(), answers: [] });

/** What a tick of session `s` at `now` does, from the spec: the ingest is observed FIRST (I1: a warming session whose input is
 *  connected goes live even past its timeout), then the warming timeout (certain), then ask 10 (possible only when the phone is
 *  silent and no ingest), then the automatic stop. `becomesLive`: this tick reads the input connected. */
function tickPlan(m: Readonly<Model>, s: S, now: number, o: { beatTick: boolean; becomesLive: boolean }, x: Real): Plan {
  const t = x.tally;
  if (!s.live && !o.becomesLive && now - s.createdAt >= WARMING_MS) return { allowed: new Set<EndKey>(["timeout"]), must: true };
  const live = s.live || o.becomesLive;
  const askPossible = !live && !o.beatTick && m.pairing !== null && now - m.pairing.lastBeatAt >= FLOOR_MS;
  const v = stopVector(m, s, now);
  const due = allHold(v);
  if (!askPossible) {
    const sole = soleBlocker(v);
    if (sole !== null) t.count(`stopSole:${sole}` as CountKey);
  }
  const allowed = new Set<EndKey>();
  if (due) allowed.add("auto_stopped");
  if (askPossible) allowed.add("phone_lost");
  return { allowed, must: due };
}

async function settle(m: Model, x: Real, info: Info): Promise<void> {
  const t = x.tally;
  let post = await snapshot(x);
  const pre = x.prev;
  const now = info.now;

  // ----- Sessions: created, ended (and why), still open ------------------------------------------------------------------
  const before = new Map(pre.sessions.map((s) => [s.id, s]));
  const fresh = post.sessions.filter((s) => !before.has(s.id));
  // Put every new session's DATABASE stamp on the rig clock (the header's two clocks) before anything judges or ticks it — an
  // unpredicted one too, so the invariants below can name it. Every session a step creates is created at the step's instant.
  for (const s of fresh) await sql`update fixture_stream_sessions set created_at = ${new Date(now)} where id = ${s.id}`;
  if (fresh.length > 0) post = await snapshot(x);   // the order of the rows is by the stamp just moved

  // ----- The invariants FIRST, from the rows alone (they do not trust the model's prediction) ------------------------------
  checkInvariants(m, x, pre, post, info);

  expect(fresh.length, `the step created ${info.created === null ? "no session" : `one ${info.created} session`}`).toBe(info.created === null ? 0 : 1);
  if (info.created !== null) {
    const s = post.sessions.find((r) => r.id === fresh[0]!.id)!;
    expect(s.start_cause, "the new session's cause").toBe(info.created);
    expect(s.target_id, "the new session streams to the fixture's destination").toBe(x.targetId);
    // The model's timeout clock is the creation instant: an assumption made a guard (the domain's anchor is `warming_at`).
    expect(ms(s.warming_at), "PREMISE: a new session enters warming at the instant it is created").toBe(now);
    m.sessions.push({
      sid: s.id, createdAt: now, startedBy: info.created, live: false, ingestAt: null, open: true, end: null,
      bornAfterAResult: m.lastFinish !== null && m.lastFinish <= now,
    });
    if (info.created === "automatic") { m.autoSid = s.id; m.startedAt = now; }
  }
  expect(post.sessions.map((s) => s.id), "one row per session the model admitted").toEqual(m.sessions.map((s) => s.sid));
  for (const ms_ of m.sessions) {
    const row = post.sessions.find((s) => s.id === ms_.sid)!;
    // First ingest: recorded by the tick that read the input connected, at that tick's instant — and never moved afterwards.
    const wantIngest = info.goesLive.has(ms_.sid) ? now : ms_.ingestAt;
    expect(ms(row.first_ingest_at), `${ms_.sid}'s first ingest`).toBe(wantIngest);
    ms_.ingestAt = wantIngest;
    ms_.live = wantIngest !== null;
    if (!ms_.open) continue;
    const plan = info.closes.get(ms_.sid);
    if (isOpenRow(row)) {
      expect(row.state, `${ms_.sid} is open in a settled state`).not.toBe("ending");
      expect(plan?.must ?? false, `${ms_.sid} is still open but a tick owed its end (allowed: ${[...(plan?.allowed ?? [])].join(",")})`).toBe(false);
      continue;
    }
    const key = endKeyOf(row);
    expect(key.startsWith("unmodelled"), `${ms_.sid} ended by a rule the model does not know: ${key}`).toBe(false);
    expect(plan !== undefined && plan.allowed.has(key as EndKey), `${ms_.sid} ended ${key}; the spec allows ${plan ? [...plan.allowed].join(",") || "(none)" : "no end at all"} in this step`).toBe(true);
    ms_.open = false;
    ms_.end = { key: key as EndKey, at: ms(row.ended_at) ?? now };
    if (key === "auto_stopped") {
      t.count("autoStopsFired");
      t.count(ms_.startedBy === "organiser" ? "autoStopsOfHandStartedBroadcast" : "autoStopsOfAutoStartedBroadcast");
      if (m.finishedAt !== null && now === m.finishedAt + DELAY_MS) t.count("autoStopsAtTheBoundary");
      if (ms_.bornAfterAResult) t.count("autoStopOfBroadcastBornBetweenTwoFinishes");
    }
    if (key === "timeout") t.count("warmingTimeouts");
    if (key === "phone_lost") t.count("phoneLostEnds");
  }
  // A session the step did not name stays exactly as it was (no end for a step that ticks nothing).
  for (const s of post.sessions) {
    const was = before.get(s.id);
    if (was && !isOpenRow(was)) expect([s.state, s.end_reason, s.fail_reason], `${s.id} was terminal and stays so`).toEqual([was.state, was.end_reason, was.fail_reason]);
  }

  // ----- The rest of the rows against the model -----------------------------------------------------------------------------
  expect([post.fixture.status, ms(post.fixture.finished_at)], "the fixture's status and finished_at").toEqual([m.status, m.finishedAt]);
  const st = post.settings;
  expect(st !== null, "a settings row exists iff the model made one (the switch, a pick or the Stop stamp)").toBe(m.row);
  expect({
    auto: st?.auto_stream ?? false, startedAt: ms(st?.auto_started_at ?? null), sid: st?.auto_start_session_id ?? null,
    blockedAt: ms(st?.auto_start_blocked_at ?? null), attemptedAt: ms(st?.auto_start_attempted_at ?? null), refusal: st?.auto_start_refusal ?? null,
    chosen: st?.target_chosen ?? false,
  }, "the settings row, column by column").toEqual({
    auto: m.autoOn, startedAt: m.startedAt, sid: m.autoSid, blockedAt: m.blockedAt, attemptedAt: m.attemptedAt, refusal: m.refusal, chosen: m.picked,
  });
  expect(post.pairing === null ? null : { mode: post.pairing.mode, beat: ms(post.pairing.last_beat_at) }, "the pairing's stored mode and last beat")
    .toEqual(m.pairing === null ? null : { mode: m.pairing.storedMode, beat: m.pairing.lastBeatAt });

  // The organiser read agrees with the rows (the T6 seam).
  await checkOrganiserRead(m, x);

  expect(sentry.captureError.mock.calls.map((c) => String((c[0] as Error)?.message ?? c[0])), "no step reported an error (step 6 swallows an auto-start throw)").toEqual([]);
  expect(elapsed(m), "PREMISE: the run stays inside C2's grace after a finish").toBeLessThan(GRACE_MS);
  x.prev = post;
  t.steps++;
  if (TRACE !== null) {
    appendFileSync(TRACE, `${x.label} t+${(now - m.t0) / 1000}s ${JSON.stringify(m.sessions.map((s) => ({ sid: s.sid.slice(0, 4), by: s.startedBy, c: (s.createdAt - m.t0) / 1000, db: post.sessions.find((r) => r.id === s.sid)!.state + "/" + String(post.sessions.find((r) => r.id === s.sid)!.warming_at === null ? null : (post.sessions.find((r) => r.id === s.sid)!.warming_at!.getTime() - m.t0) / 1000), ing: s.ingestAt === null ? null : (s.ingestAt - m.t0) / 1000, open: s.open, end: s.end?.key ?? null })))} fin=${m.finishedAt === null ? null : (m.finishedAt - m.t0) / 1000} on=${m.autoOn} mode=${m.pairing?.storedMode ?? null} st=${m.status}\n`);
  }
}

function checkInvariants(m: Readonly<Model>, x: Real, pre: Snap, post: Snap, info: Info): void {
  const t = x.tally;
  const autos = post.sessions.filter((s) => s.start_cause === "automatic");
  // 1. once per match
  expect(autos.length, "1: at most one automatic session per fixture, ever").toBeLessThanOrEqual(1);
  // 7 (second half): a refusal never stamps auto_started_at; a stamped start names a session that exists and is automatic.
  const st = post.settings;
  if (st?.auto_started_at != null) {
    expect(autos.map((s) => s.id), "7: auto_started_at names the one automatic session").toEqual([st.auto_start_session_id]);
    expect(st.auto_start_refusal, "7: a started match holds no refusal").toBeNull();
  } else {
    expect(autos.length, "7: no auto_started_at, no automatic session (a refusal never stamps it)").toBe(0);
  }
  for (const a of autos) {
    // 2. never after an organiser Stop (judged against the model's own instant)
    if (m.blockedAt !== null) expect(a.created_at.getTime(), `2: ${a.id} created before the organiser Stop at ${m.blockedAt}`).toBeLessThan(m.blockedAt);
    // 3. never after a session that received ingest
    for (const o of post.sessions) {
      if (o.id === a.id || o.first_ingest_at === null) continue;
      expect(o.first_ingest_at.getTime(), `3: ${a.id} was created after ${o.id} received ingest`).toBeGreaterThanOrEqual(a.created_at.getTime());
    }
  }
  // 4 + 5 + 6 on every session this step ended as auto_stopped.
  const was = new Map(pre.sessions.map((s) => [s.id, s]));
  for (const s of post.sessions) {
    const w = was.get(s.id);
    if (!w || !isOpenRow(w) || isOpenRow(s) || s.end_reason !== "auto_stopped") continue;
    const f = post.fixture.finished_at;
    expect(f, "5: an auto stop needs a result standing (a reverted result cancels it)").not.toBeNull();
    expect(s.created_at.getTime(), "4: a session created at or after the CURRENT finished_at is never auto-stopped").toBeLessThan(f!.getTime());
    expect(info.now - f!.getTime(), "5/6: the stop is not before finished_at + AUTO_STOP_AFTER_RESULT_SECONDS").toBeGreaterThanOrEqual(DELAY_MS);
    expect(ms(s.ended_at), "6: the stop is written at the tick that judged it").toBe(info.now);
  }
  // 7 (first half): an attempt is at least AUTO_START_RETRY_SECONDS after the previous one.
  const a0 = ms(pre.settings?.auto_start_attempted_at ?? null);
  const a1 = ms(post.settings?.auto_start_attempted_at ?? null);
  if (a0 !== null && a1 !== a0) expect(a1! - a0, "7: retried sooner than AUTO_START_RETRY_SECONDS").toBeGreaterThanOrEqual(RETRY_MS);
  // 8. the destination pick moves only with the organiser's own Go live
  if (!info.movesPick) {
    expect(
      { chosen: post.settings?.target_chosen ?? false, target: post.settings?.target_id ?? null },
      "8: only the organiser's Go live moves target_chosen / target_id (the switch, an auto start and the Stop stamp never do)",
    ).toEqual({ chosen: pre.settings?.target_chosen ?? false, target: pre.settings?.target_id ?? null });
  }
  t.invariantChecks++;
}

/** The organiser read (`streamPhone`, T6): the switch, the start instant, the block, and a refusal served only while a start
 *  could still fire. Neutralised on purpose in the read, and here: the retry spacing and the phone's presence. */
async function checkOrganiserRead(m: Readonly<Model>, x: Real): Promise<void> {
  const read = await streamPhone(x.r.auth, x.r.fixtureId, x.r.deps);
  if (!m.row) { expect(read.auto, "no settings row, no `auto`").toBeNull(); }
  else {
    // The stored code is served while `autoStartVerdict` could still pass (retry spacing and presence neutralised on purpose).
    const restHold = m.refusal !== null && m.autoOn && m.pairing?.storedMode === "automatic" && m.status === "in_play" && openOf(m) === null
      && m.startedAt === null && !m.sessions.some((s) => s.ingestAt !== null);
    const could = restHold && m.blockedAt === null;
    if (restHold && m.blockedAt !== null) x.tally.count("storedRefusalHiddenAfterStop");
    expect(read.auto, "the organiser read").toEqual({
      enabled: m.autoOn,
      startedAt: m.startedAt === null ? null : new Date(m.startedAt).toISOString(),
      blocked: m.blockedAt !== null,
      refusal: could ? m.refusal : null,
      refusalAt: could && m.attemptedAt !== null ? new Date(m.attemptedAt).toISOString() : null,
    });
  }
  x.tally.count("organiserReadChecks");
}

async function step(m: Model, x: Real, body: (info: Info) => Promise<void>): Promise<Info> {
  const info = newInfo(x);
  await body(info);
  info.now = x.r.now().getTime();
  await settle(m, x, info);
  return info;
}

// ---------------------------------------------------------------------------------------------------------------------
// The primitives — each a real call, its spec prediction, and the model's move
// ---------------------------------------------------------------------------------------------------------------------

function beatBody(x: Real, over: Record<string, unknown>) {
  return CaptureBeat.parse({
    code: x.r.code, slot: 0, phone: x.phone, claim: null, device: null, sid: null, at: x.r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "stream-auto-model/1", ...over,
  });
}
function sidBeatFields(s: S | null, names: boolean): Record<string, unknown> {
  if (s === null || !names) return {};
  return s.live ? { sid: s.sid, state: "publishing", transport: "srt" } : { sid: s.sid, state: "connecting" };
}

/** The beat (§6.3.2) — and the whole of auto start (§7.2): predicted from the spec's conjuncts after the beat's own tick. */
async function beat(m: Model, x: Real, mode: Mode, names: boolean, copies: 1 | 2): Promise<void> {
  const t = x.tally;
  await step(m, x, async (info) => {
    x.r.tick(1);
    const now = x.r.now().getTime();
    info.now = now;
    const claim = m.pairing === null;
    const open = openOf(m);
    const namedOpen = names && open !== null ? open : null;
    // The beat is stored first (its mode and instant), THEN its tick judges the named session (FP13: the stop reads the stored mode).
    if (m.pairing !== null && m.pairing.storedMode !== mode) t.count("modeFlips");
    m.pairing = { storedMode: mode, lastBeatAt: now };
    // A beat's own tick is certain (the beat is not silent): the model applies the end before it judges the start, because the
    // session is no longer open when step 6 runs. settle() closes it from the rows and checks the reason.
    let ended = false;
    if (namedOpen !== null) {
      const plan = tickPlan(m, namedOpen, now, { beatTick: true, becomesLive: false }, x);
      info.closes.set(namedOpen.sid, plan);
      ended = plan.must;
      if (ended) namedOpen.open = false;
    }
    // §7.2: judged on the model after the tick. The phone's presence cannot fail on its own beat.
    const v = startVector(m, mode, now);
    const due = allHold(v);
    const sole = soleBlocker(v);
    if (sole !== null && sole !== "phone_present") t.count(`startSole:${sole}` as CountKey);
    const sinceAttempt = m.attemptedAt === null ? null : now - m.attemptedAt;
    if (sinceAttempt === RETRY_MS - 1 && sole === "retry_spacing") t.count("retryWithheldOneMsEarly");
    if (due) {
      if (m.attemptedAt !== null) t.count("retriesFired");
      if (sinceAttempt === RETRY_MS) t.count("retryFiredAtTheEdge");
      if (claim) t.count("startAtLatePairing");
      if (ended) t.count("startOnTheBeatThatTickedTheStopped");
      m.attemptedAt = now;
      if (m.funded) {
        info.created = "automatic";
        m.refusal = null;
        t.count("autoStartsFired");
      } else {
        m.refusal = "no_credit";
        t.count("autoStartsRefused");
      }
    }
    if (ended) namedOpen!.open = true;

    const body_ = beatBody(x, { claim: claim ? "new" : null, device: claim ? { model: "stream-auto-model-phone" } : null, mode, ...sidBeatFields(namedOpen, names) });
    const calls = copies === 2 ? [postBeat(x.r.code, x.r.tok, body_, x.r.deps, x.r.now()), postBeat(x.r.code, x.r.tok, body_, x.r.deps, x.r.now())]
      : [postBeat(x.r.code, x.r.tok, body_, x.r.deps, x.r.now())];
    if (copies === 2) t.count("twoBeatRaces");
    const answers = await Promise.all(calls);
    for (const a of answers) {
      const parsed = CaptureBeatAnswer.parse(a);
      info.answers.push(parsed);
      // The switch is the beat's `autoAllowed`, on every shape.
      expect((parsed as { autoAllowed?: boolean }).autoAllowed, "the beat's autoAllowed is the fixture's switch").toBe(m.autoOn);
      t.count("answersChecked");
    }
    if (info.created === "automatic" && !ended) {
      expect(answers.some((a) => (a as { state: string; startedBy?: string }).state === "go-live" && (a as { startedBy?: string }).startedBy === "automatic"),
        "the beat that starts the broadcast is answered go-live, startedBy automatic").toBe(true);
    }
    // A beat that NAMES the session its own tick just ended is told that one is over (the named session comes first); the
    // automatic broadcast it started is then announced to the NEXT beat.
    if (ended) expect(answers.map((a) => a.state), "a beat naming the session it just ended is answered over").toEqual(answers.map(() => "over"));
  });
}

function pairedAndPresent(m: Readonly<Model>): boolean {
  // Present = a beat within the silence FLOOR: the server's threshold is max(floor, cadence + slack) ≥ floor. Judged at the instant
  // the step will ACT — its own 1 ms pre-tick later — so a clock parked on the floor's last millisecond (advanceToRetryEdge) is not
  // mistaken for presence.
  return m.pairing !== null && m.now() + 1 - m.pairing.lastBeatAt < FLOOR_MS;
}

/** The organiser's Go live (W5): refused with no credit (T14), else a session started by the organiser, whose destination
 *  becomes the fixture's pre-pick (§6.6). Drawn only with a present phone and nothing open. */
async function manualGoLive(m: Model, x: Real): Promise<void> {
  const t = x.tally;
  await step(m, x, async (info) => {
    x.r.tick(1);
    info.now = x.r.now().getTime();
    let refusal: string | null = null;
    try {
      await createSession(x.r.auth, x.r.fixtureId, { mode: "passthrough", targetId: x.targetId }, x.r.deps);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      refusal = e.code ?? `${e.status}`;
    }
    if (!m.funded) {
      expect(refusal, "T14: no credit, no organiser Go live").toBe("no_credits");
      t.count("manualRefusals");
      return;
    }
    expect(refusal, "W5: a present phone with a credit is admitted").toBeNull();
    info.created = "organiser";
    info.movesPick = true;
    m.row = true;
    m.picked = true;
    t.count("manualGoLives");
  });
}

async function organiserStop(m: Model, x: Real, which: "open" | "ended"): Promise<void> {
  const t = x.tally;
  await step(m, x, async (info) => {
    x.r.tick(1);
    info.now = x.r.now().getTime();
    const open = openOf(m);
    if (which === "open") {
      const s = open!;
      info.closes.set(s.sid, { allowed: new Set<EndKey>(["stopped"]), must: true });
      await stopSession(x.r.auth, x.r.fixtureId, s.sid, x.r.deps);
      // A12 (R-3): a Stop of a NON-terminal session turns automatic start off for the match; the first stamp wins, and the
      // stamp creates the settings row when the switch was never touched (FP9).
      if (m.blockedAt === null) m.blockedAt = x.r.now().getTime();
      m.row = true;
      t.count("organiserStopsStamped");
      if (s.startedBy === "automatic") t.count("organiserStopsOfAutoStarted");
    } else {
      const latest = [...m.sessions].reverse().find((s) => !s.open)!;
      await stopSession(x.r.auth, x.r.fixtureId, latest.sid, x.r.deps);
      t.count("organiserStopsRepeated");
    }
  });
}

/** `how`: the three real callers of the tick besides a beat — the organiser's poll (`tickSession`, cause poll), the organiser's
 *  read (`currentSession`, which ticks) and the stream-tick job (`tickOpenSessions`, cause sweep). */
async function tick(m: Model, x: Real, how: "poll" | "read" | "sweep"): Promise<void> {
  await step(m, x, async (info) => {
    const open = openOf(m);
    const now = x.r.now().getTime();
    info.now = now;
    if (open !== null) {
      const plan = tickPlan(m, open, now, { beatTick: false, becomesLive: false }, x);
      info.closes.set(open.sid, plan);
      bookRevertWitnesses(m, open, now, x);
    }
    if (how === "poll") await tickSession(open!.sid, x.r.deps, "poll");
    else if (how === "read") await currentSession(x.r.auth, x.r.fixtureId, x.r.deps);
    else await tickOpenSessions(x.r.deps, { orgIds: [x.r.auth.orgId] });
  });
}

/** Scripts the open session's input connected and ticks it with a CLAIMED read: the session goes live (first ingest) — the ingest
 *  is observed before the warming timeout — and the same tick then judges the automatic stop. */
async function ingestOn(m: Model, x: Real): Promise<void> {
  const t = x.tally;
  await step(m, x, async (info) => {
    const open = openOf(m)!;
    const [input] = await sql<{ id: string }[]>`select ingest_input_id as id from fixture_stream_inputs where session_id = ${open.sid} order by slot limit 1`;
    x.r.ingest.setState(input!.id, "connected");
    x.r.tick(FRESH_READ_MS);
    const now = x.r.now().getTime();
    info.now = now;
    // Observed before any expiry (I1), so even a session past its warming timeout goes live: the phone WAS streaming.
    const plan = tickPlan(m, open, now, { beatTick: false, becomesLive: true }, x);
    info.closes.set(open.sid, plan);
    bookRevertWitnesses(m, open, now, x);
    info.goesLive.add(open.sid);
    t.count("ingests");
    await tickSession(open.sid, x.r.deps, "poll");
  });
}

/** The witnesses for A15 / the revert: whether the tick left alone a session that only the result's timing or position spared. */
function bookRevertWitnesses(m: Model, s: S, now: number, x: Real): void {
  const t = x.tally;
  // A reverted result cancelled a stop that was pending: the old finish's 180 s are over, nothing stands, the session survives.
  if (m.revertedPendingFinish !== null && m.finishedAt === null && m.autoOn && m.pairing?.storedMode === "automatic" && now >= m.revertedPendingFinish + DELAY_MS) {
    t.count("stopCancelledByRevert");
  }
  // A re-finish restarts the clock: the PREVIOUS finish's 180 s are over, the new one's are not, the session survives.
  if (m.prevFinish !== null && m.finishedAt !== null && m.autoOn && m.pairing?.storedMode === "automatic" && s.createdAt < m.finishedAt
    && now >= m.prevFinish + DELAY_MS && now < m.finishedAt + DELAY_MS) {
    t.count("stopRestartedByRefinish");
  }
  // A15: everything else holds and the session was created at or after the result.
  const f = m.finishedAt;
  if (f !== null && m.autoOn && m.pairing?.storedMode === "automatic" && now >= f + DELAY_MS && s.createdAt >= f) {
    t.count("postResultBroadcastLeftAlone");
    if (s.createdAt === f) t.count("createdInTheResultsMillisecondLeftAlone");
  }
}

async function advance(m: Model, x: Real, ms_: number): Promise<void> {
  await step(m, x, async () => { x.r.tick(ms_); });
}

async function matchStart(m: Model, x: Real): Promise<void> {
  await step(m, x, async () => {
    await sql`update fixtures set status = 'in_play' where id = ${x.r.fixtureId}`;
    m.status = "in_play";
  });
}

/** The result is recorded: the status write stamps `finished_at` (V430's trigger, the DATABASE clock), which is then put on the
 *  rig clock WITHOUT naming `status` (FP8: the trigger fires only on a status write). */
async function finish(m: Model, x: Real): Promise<void> {
  await step(m, x, async () => {
    await sql`update fixtures set status = 'decided' where id = ${x.r.fixtureId}`;
    const [f] = await sql<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${x.r.fixtureId}`;
    expect(f!.finished_at, "V430: a status write to a finished status stamps finished_at").not.toBeNull();
    await sql`update fixtures set finished_at = ${x.r.now()} where id = ${x.r.fixtureId}`;
    m.status = "decided";
    m.finishedAt = x.r.now().getTime();
    m.lastFinish = m.finishedAt;
  });
}

/** A score correction: the status goes back to in_play and the trigger clears `finished_at` (T32). */
async function revert(m: Model, x: Real): Promise<void> {
  await step(m, x, async () => {
    const was = m.finishedAt!;
    await sql`update fixtures set status = 'in_play' where id = ${x.r.fixtureId}`;
    const [f] = await sql<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${x.r.fixtureId}`;
    expect(f!.finished_at, "V430: reverting the status clears finished_at").toBeNull();
    const open = openOf(m);
    m.status = "in_play";
    m.finishedAt = null;
    m.prevFinish = was;
    // A stop is pending for an open session only if every other conjunct holds and the session predates the result.
    m.revertedPendingFinish = open !== null && m.autoOn && m.pairing?.storedMode === "automatic" && open.createdAt < was ? was : null;
  });
}

async function toggleAuto(m: Model, x: Real, on: boolean): Promise<void> {
  const t = x.tally;
  await step(m, x, async () => {
    // Invariant 8's witnesses: the switch CREATING the row (a mutant may make it read as chosen) and the switch beside a pick
    // (a mutant may clear it). Read from the rows before the call, not from the model.
    if (x.prev.settings === null) t.count("switchCreatesTheRow");
    else if (x.prev.settings.target_chosen) t.count("switchBesideAPick");
    const out = await saveStreamSettings(x.r.auth, x.r.fixtureId, { autoStream: on });
    expect(out.autoStream, "the PUT answers the switch it saved").toBe(on);
    m.autoOn = on;
    m.row = true;
    // {autoStream:false} clears the stored refusal (T3); neither direction touches started/blocked/attempted.
    if (!on) m.refusal = null;
    t.count(on ? "switchOns" : "switchOffs");
  });
}

async function grant(m: Model, x: Real): Promise<void> {
  await step(m, x, async () => {
    await grantCredits({ orgId: x.r.auth.orgId, delta: FUNDED_CREDITS, createdBy: await rigUser(), note: "stream-auto-model", idempotencyKey: randomUUID() });
    m.funded = true;
  });
}
const FUNDED_CREDITS = 10;

// ---------------------------------------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------------------------------------

class Cmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly label: string, readonly action: Action, private readonly ok: (m: Readonly<Model>) => boolean, private readonly go: (m: Model, x: Real) => Promise<void>) {}
  check(m: Readonly<Model>): boolean { return this.ok(m); }
  async run(m: Model, x: Real): Promise<void> { x.tally.action(this.action); x.label = this.label; await this.go(m, x); }
  toString(): string { return this.label; }
}

/** Runs each command whose precondition holds NOW (a scene is an INTENT: every part is a checked step, and one whose
 *  precondition fails is skipped, so a scene works from any state). */
async function seq(m: Model, x: Real, cmds: Cmd[]): Promise<void> {
  for (const c of cmds) if (c.check(m)) await c.run(m, x);
}

const within = (m: Readonly<Model>, add: number) => elapsed(m) + add <= RUN_BUDGET_MS;
const cmd = {
  beat: (mode: Mode, names = false) => new Cmd(`beat(${mode}${names ? ",names" : ""})`, "beat", () => true, (m, x) => beat(m, x, mode, names, 1)),
  doubleBeat: (mode: Mode, names = false) => new Cmd(`doubleBeat(${mode}${names ? ",names" : ""})`, "doubleBeat", (m) => m.pairing !== null, (m, x) => beat(m, x, mode, names, 2)),
  matchStart: () => new Cmd("matchStart", "matchStart", (m) => m.status === "scheduled", matchStart),
  finish: () => new Cmd("finish", "finish", (m) => m.status === "in_play", finish),
  revert: () => new Cmd("revert", "revert", (m) => m.finishedAt !== null, revert),
  toggleAuto: (on: boolean) => new Cmd(`toggleAuto(${on})`, "toggleAuto", () => true, (m, x) => toggleAuto(m, x, on)),
  manualGoLive: () => new Cmd("manualGoLive", "manualGoLive", (m) => pairedAndPresent(m) && openOf(m) === null, manualGoLive),
  organiserStop: (which: "open" | "ended") => new Cmd(`organiserStop(${which})`, "organiserStop",
    (m) => (which === "open" ? openOf(m) !== null : openOf(m) === null && m.sessions.length > 0), (m, x) => organiserStop(m, x, which)),
  advance: (ms_: number) => new Cmd(`advance(${ms_})`, "advance", (m) => within(m, ms_), (m, x) => advance(m, x, ms_)),
  /** Moves the rig clock so the NEXT step (a beat pre-ticks 1 ms) lands `offset` ms after the retry edge — the attempt's instant plus
   *  AUTO_START_RETRY_SECONDS: -1 is the last instant a retry is withheld, 0 the first it may fire. Without it no step ever lands ON
   *  the edge (a plain advance plus the pre-tick always overshoots by a millisecond), and a `>=` that became `>` goes unseen. */
  advanceToRetryEdge: (offset: -1 | 0) => {
    const gap = (m: Readonly<Model>) => m.attemptedAt! + RETRY_MS + offset - 1 - m.now();
    return new Cmd(`advanceToRetryEdge(${offset})`, "advanceToRetryEdge", (m) => m.attemptedAt !== null && gap(m) >= 0 && within(m, gap(m)), (m, x) => advance(m, x, gap(m)));
  },
  tick: (how: "poll" | "read" | "sweep") => new Cmd(`tick(${how})`, "tick", (m) => how === "sweep" || openOf(m) !== null, (m, x) => tick(m, x, how)),
  ingestOn: () => new Cmd("ingestOn", "ingestOn", (m) => openOf(m) !== null && !openOf(m)!.live, ingestOn),
  grant: () => new Cmd("grantCredits", "grantCredits", (m) => !m.funded, grant),

  // ----- scenes: the rare orderings, as intents ------------------------------------------------------------------------------
  // Every scene takes `g`: whether it first grants credit. A scene that does not, in a run that never funded, meets the
  // no-credit world (T14: the organiser's Go live is refused; §7.2: an automatic start is refused `no_credit`).
  /** §7.2 retry: each early conjunct alone, then a refusal, a beat inside the spacing (blocked), a beat exactly at the spacing
   *  (retried, refused again), credits, a beat after the spacing (fires, clears the refusal). */
  sceneRefusalRetry: (g = false) => new Cmd(`sceneRefusalRetry(${g})`, "sceneRefusalRetry", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.beat("operator"), cmd.matchStart(), cmd.beat("automatic"), cmd.toggleAuto(true), cmd.beat("operator"), cmd.beat("automatic"),
      cmd.advance(RETRY_MS - SEC), cmd.beat("automatic"), cmd.advanceToRetryEdge(-1), cmd.beat("automatic"), cmd.advanceToRetryEdge(0), cmd.beat("automatic"),
      cmd.advance(RETRY_MS), cmd.grant(), cmd.beat("automatic")]);
  }),
  /** The organiser read serves a stored refusal only while the start could still fire: an unfunded refusal, then credit and a hand
   *  broadcast the organiser Stops — blocked, so the read must no longer show `no_credit`. */
  sceneRefusalHiddenByStop: () => new Cmd("sceneRefusalHiddenByStop", "sceneRefusalHiddenByStop", () => true, async (m, x) => {
    await seq(m, x, [cmd.beat("operator"), cmd.matchStart(), cmd.toggleAuto(true), cmd.beat("automatic"), cmd.grant(), cmd.manualGoLive(), cmd.organiserStop("open")]);
  }),
  /** A12: a hand-started broadcast with an open session blocks the start (alone), is stopped before it had ingest, and then the
   *  Stop alone withholds the start. */
  sceneStopBlocksStart: (g = true) => new Cmd(`sceneStopBlocksStart(${g})`, "sceneStopBlocksStart", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.beat("operator"), cmd.manualGoLive(), cmd.toggleAuto(true), cmd.matchStart(), cmd.beat("automatic"),
      cmd.organiserStop("open"), cmd.beat("automatic"), cmd.organiserStop("ended")]);
  }),
  /** A16: a hand-started broadcast that had ingest, auto-stopped after the result, the result reverted — every other conjunct made
   *  true: the ingest alone withholds the start. */
  sceneIngestBlocksStart: (g = true) => new Cmd(`sceneIngestBlocksStart(${g})`, "sceneIngestBlocksStart", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.beat("operator"), cmd.manualGoLive(), cmd.ingestOn(), cmd.toggleAuto(true), cmd.beat("automatic"), cmd.matchStart(),
      cmd.finish(), cmd.advance(DELAY_MS), cmd.tick("sweep"), cmd.revert(), cmd.beat("automatic")]);
  }),
  /** A15: a broadcast created after the result is left alone past the delay, whatever starts it. */
  scenePostResult: (g = true) => new Cmd(`scenePostResult(${g})`, "scenePostResult", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.beat("operator"), cmd.matchStart(), cmd.finish(), cmd.toggleAuto(true), cmd.beat("automatic"), cmd.manualGoLive(),
      cmd.ingestOn(), cmd.advance(DELAY_MS), cmd.tick("poll"), cmd.organiserStop("open"), cmd.beat("automatic"), cmd.manualGoLive(), cmd.ingestOn(), cmd.revert(),
      cmd.matchStart(), cmd.finish(), cmd.advance(DELAY_MS), cmd.tick("read")]);
  }),
  /** A reverted result cancels a pending stop; a re-finish restarts the 180 s; the stop lands exactly at the new delay. */
  sceneRevertRefinish: (g = true) => new Cmd(`sceneRevertRefinish(${g})`, "sceneRevertRefinish", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.organiserStop("open"), cmd.revert(), cmd.beat("operator"), cmd.manualGoLive(), cmd.ingestOn(), cmd.toggleAuto(true),
      cmd.beat("automatic"), cmd.matchStart(), cmd.finish(), cmd.advance(100 * SEC), cmd.tick("poll"), cmd.revert(), cmd.advance(100 * SEC), cmd.tick("poll"),
      cmd.finish(), cmd.advance(DELAY_MS - SEC), cmd.tick("sweep"), cmd.advance(SEC), cmd.tick("poll")]);
  }),
  /** A15's strictness: a session created ONE millisecond before the result is stopped; one created IN the result's millisecond is not. */
  sceneTie: (g = true) => new Cmd(`sceneTie(${g})`, "sceneTie", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.organiserStop("open"), cmd.revert(), cmd.beat("operator"), cmd.matchStart(), cmd.manualGoLive(), cmd.advance(1), cmd.finish(),
      cmd.ingestOn(), cmd.toggleAuto(true), cmd.beat("automatic"), cmd.advance(DELAY_MS), cmd.tick("poll"), cmd.revert(), cmd.beat("automatic"), cmd.manualGoLive(),
      cmd.finish(), cmd.ingestOn(), cmd.advance(DELAY_MS), cmd.tick("poll")]);
  }),
  /** §7.3: with a result and the delay elapsed, the switch alone, then the phone's mode alone, withholds the stop; both on, it ends. */
  sceneStopNeedsBoth: (g = true) => new Cmd(`sceneStopNeedsBoth(${g})`, "sceneStopNeedsBoth", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.organiserStop("open"), cmd.revert(), cmd.toggleAuto(false), cmd.beat("operator"), cmd.manualGoLive(), cmd.ingestOn(),
      cmd.beat("automatic"), cmd.matchStart(), cmd.finish(), cmd.advance(DELAY_MS), cmd.tick("poll"), cmd.toggleAuto(true), cmd.beat("operator"), cmd.tick("poll"),
      cmd.beat("automatic"), cmd.tick("poll")]);
  }),
  /** Once per match (A16): the automatic broadcast ends without ingest (its phone went quiet: ask 10), every other conjunct holds,
   *  and the next beat starts nothing. */
  sceneOnce: (g = true) => new Cmd(`sceneOnce(${g})`, "sceneOnce", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.toggleAuto(true), cmd.matchStart(), cmd.beat("automatic"), cmd.advance(RETRY_MS), cmd.tick("sweep"), cmd.beat("automatic")]);
  }),
  /** The warming timeout is the tick's first rule (a tie with ask 10 goes to it); a hand broadcast that timed out lets a
   *  later automatic one start, and an automatic one that timed out lets nothing start again. */
  sceneTimeout: (g = true) => new Cmd(`sceneTimeout(${g})`, "sceneTimeout", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.beat("operator"), cmd.manualGoLive(), cmd.advance(WARMING_MS), cmd.tick("read"), cmd.toggleAuto(true), cmd.matchStart(),
      cmd.beat("automatic"), cmd.advance(WARMING_MS), cmd.beat("automatic", true)]);
  }),
  /** The beat's own tick ends a timed-out hand broadcast BEFORE step 6 judges the start, so the same beat starts the automatic one. */
  sceneTickThenStart: (g = true) => new Cmd(`sceneTickThenStart(${g})`, "sceneTickThenStart", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.beat("operator"), cmd.manualGoLive(), cmd.toggleAuto(true), cmd.matchStart(), cmd.advance(WARMING_MS), cmd.beat("automatic", true)]);
  }),
  /** T14: the organiser's Go live with no credit is refused (with credit it is admitted). */
  sceneManualRefusal: (g = false) => new Cmd(`sceneManualRefusal(${g})`, "sceneManualRefusal", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.beat("operator"), cmd.manualGoLive()]);
  }),
  /** The automatic broadcast is auto-stopped after the result like any other (A15 is about the START time, not the starter). */
  sceneAutoStartThenStop: (g = true) => new Cmd(`sceneAutoStartThenStop(${g})`, "sceneAutoStartThenStop", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.beat("operator"), cmd.toggleAuto(true), cmd.matchStart(), cmd.beat("automatic"), cmd.ingestOn(), cmd.finish(),
      cmd.advance(DELAY_MS), cmd.beat("automatic", true)]);
  }),
  /** The organiser may Stop the AUTOMATIC broadcast too (a Stop of a non-terminal session, A12): nothing restarts it. */
  sceneOrganiserStopsAuto: (g = true) => new Cmd(`sceneOrganiserStopsAuto(${g})`, "sceneOrganiserStopsAuto", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.beat("operator"), cmd.toggleAuto(true), cmd.matchStart(), cmd.beat("automatic"), cmd.organiserStop("open"), cmd.beat("automatic"),
      cmd.advance(RETRY_MS), cmd.beat("automatic")]);
  }),
  /** THE SCORE-CORRECTION EDGE (owner ruling 2026-10-08, relayed by the controller: accepted — §7.3's literal predicate). The
   *  organiser starts a broadcast AFTER the result: past the delay it is left alone (A15). The result is reverted and recorded
   *  again; the SAME broadcast now predates the CURRENT `finished_at`, so 180 s after the re-finish it IS auto-stopped. */
  sceneScoreCorrection: (g = true) => new Cmd(`sceneScoreCorrection(${g})`, "sceneScoreCorrection", () => true, async (m, x) => {
    await seq(m, x, [...(g ? [cmd.grant()] : []), cmd.organiserStop("open"), cmd.beat("operator"), cmd.matchStart(), cmd.revert(), cmd.finish(),
      cmd.manualGoLive(), cmd.ingestOn(), cmd.toggleAuto(true), cmd.beat("automatic"), cmd.advance(DELAY_MS), cmd.tick("poll"), cmd.revert(),
      cmd.finish(), cmd.advance(DELAY_MS), cmd.tick("poll")]);
  }),
};

const modeArb = fc.oneof({ arbitrary: fc.constant("automatic" as Mode), weight: 2 }, { arbitrary: fc.constant("operator" as Mode), weight: 1 });
/** The clock's steps: inside and exactly at the retry spacing, inside and exactly at the stop delay, and the warming timeout. */
const stepArb = fc.oneof(
  { arbitrary: fc.constantFrom(5 * SEC, 30 * SEC), weight: 4 },
  { arbitrary: fc.constantFrom(RETRY_MS - SEC, RETRY_MS), weight: 3 },
  { arbitrary: fc.constantFrom(DELAY_MS - SEC, DELAY_MS), weight: 3 },
  { arbitrary: fc.constant(WARMING_MS), weight: 1 },
);
const rep = <T,>(n: number, mk: () => fc.Arbitrary<T>): fc.Arbitrary<T>[] => Array.from({ length: n }, mk);
const ALL: fc.Arbitrary<Cmd>[] = [
  ...rep(5, () => fc.tuple(modeArb, fc.boolean()).map(([md, nm]) => cmd.beat(md, nm))),
  fc.tuple(modeArb, fc.boolean()).map(([md, nm]) => cmd.doubleBeat(md, nm)),
  ...rep(2, () => fc.constant(null).map(cmd.matchStart)),
  ...rep(2, () => fc.constant(null).map(cmd.finish)),
  ...rep(2, () => fc.constant(null).map(cmd.revert)),
  ...rep(2, () => fc.constant(true).map(cmd.toggleAuto)),
  fc.constant(false).map(cmd.toggleAuto),
  ...rep(2, () => fc.constant(null).map(cmd.manualGoLive)),
  ...rep(2, () => fc.constant("open" as const).map(cmd.organiserStop)),
  fc.constant("ended" as const).map(cmd.organiserStop),
  ...rep(4, () => stepArb.map(cmd.advance)),
  ...rep(3, () => fc.constantFrom<"poll" | "read" | "sweep">("poll", "read", "sweep").map(cmd.tick)),
  ...rep(2, () => fc.constant(null).map(cmd.ingestOn)),
  fc.constant(null).map(cmd.grant),
  ...rep(2, () => fc.constantFrom<-1 | 0>(-1, 0).map(cmd.advanceToRetryEdge)),
  ...rep(3, () => fc.boolean().map(cmd.sceneRefusalRetry)),
  ...rep(2, () => fc.boolean().map(cmd.sceneManualRefusal)),
  fc.boolean().map(cmd.sceneStopBlocksStart),
  fc.boolean().map(cmd.sceneIngestBlocksStart),
  fc.boolean().map(cmd.scenePostResult),
  fc.boolean().map(cmd.sceneRevertRefinish),
  fc.boolean().map(cmd.sceneTie),
  ...rep(2, () => fc.boolean().map(cmd.sceneStopNeedsBoth)),
  fc.boolean().map(cmd.sceneOnce),
  fc.boolean().map(cmd.sceneTimeout),
  fc.boolean().map(cmd.sceneTickThenStart),
  fc.boolean().map(cmd.sceneAutoStartThenStop),
  fc.boolean().map(cmd.sceneOrganiserStopsAuto),
  fc.constant(null).map(cmd.sceneRefusalHiddenByStop),
  fc.boolean().map(cmd.sceneScoreCorrection),
];
const COMMANDS = fc.commands(ALL, { maxCommands: MAX_COMMANDS, size: "max" });

/** One run's world: a rig whose ledger holds exactly 0 or FUNDED_CREDITS (the plan's month is granted and spent first), the
 *  destination optionally pre-picked, nothing paired, nothing in play. */
async function freshReal(tally: Tally, o: { funded: boolean; picked: boolean }): Promise<{ model: Model; real: Real }> {
  const r = await captureRig({ credits: 0, connectAfterMs: 400 * 24 * 60 * MIN });
  await spendMonthlyStreamGrant(r.auth.orgId);
  if (o.funded) await grantCredits({ orgId: r.auth.orgId, delta: FUNDED_CREDITS, createdBy: await rigUser(), note: "stream-auto-model", idempotencyKey: randomUUID() });
  expect(await creditBalance(sql, r.auth.orgId), "the run starts from the balance it declares").toBe(o.funded ? FUNDED_CREDITS : 0);
  if (o.picked) { await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id }); tally.count("pickedRuns"); }
  const real: Real = { label: "setup", r, phone: phoneId("a"), tally, prev: undefined as unknown as Snap, targetId: r.target.id };
  real.prev = await snapshot(real);
  const model: Model = {
    status: "scheduled", finishedAt: null, autoOn: false, funded: o.funded, row: o.picked, picked: o.picked, pairing: null,
    startedAt: null, autoSid: null, blockedAt: null, attemptedAt: null, refusal: null, sessions: [], t0: r.now().getTime(), now: () => r.now().getTime(),
    revertedPendingFinish: null, prevFinish: null, lastFinish: null,
  };
  expect(real.prev.fixture.status, "PREMISE: the rig's fixture starts scheduled").toBe("scheduled");
  expect(real.prev.settings !== null, "PREMISE: the settings row is the pick's").toBe(o.picked);
  return { model, real };
}

/** The model must judge every conjunct the domain declares, in the domain's order: a conjunct added there and not here fails. */
function declaredConjunctsAreJudged(): number {
  const m: Model = {
    status: "scheduled", finishedAt: null, autoOn: false, funded: false, row: false, picked: false, pairing: null, startedAt: null, autoSid: null,
    blockedAt: null, attemptedAt: null, refusal: null, sessions: [], t0: 0, now: () => 0, revertedPendingFinish: null, prevFinish: null,
    lastFinish: null,
  };
  const s: S = { sid: "x", createdAt: 0, startedBy: "organiser", live: false, ingestAt: null, open: true, end: null, bornAfterAResult: false };
  expect(startVector(m, "automatic", 0).map((c) => c.name), "the model judges every declared autoStartDue conjunct, in order").toEqual(AUTO_START_CONJUNCTS.map((c) => c.name));
  expect(stopVector(m, s, 0).map((c) => c.name), "the model judges every declared autoStopDue conjunct, in order").toEqual(AUTO_STOP_CONJUNCTS.map((c) => c.name));
  return AUTO_START_CONJUNCTS.length + AUTO_STOP_CONJUNCTS.length;
}

/** Every counter is required: each names a spec row or an ordering the model exists to witness (a run that cannot reach one is a
 *  generator defect, never a skipped row). */
const REQUIRED_COUNTS: readonly CountKey[] = COUNT_KEYS;
/** Wall-clock budget per generated run (measured at ~0.6 s on a quiet machine: eight times that), plus the setup. */
const PER_RUN_BUDGET_MS = 5_000;

describe.skipIf(!HAS_DB)("automatic start and stop (§7.2 / §7.3, rule 10): one phone, the real use-cases, eight invariants after every step", () => {
  it(`model: the invariants hold over every generated sequence; every action and counter is reached by DRAWN runs (seed ${SEED}, ${RUNS} runs)`, async () => {
    expect(declaredConjunctsAreJudged(), "9 start + 5 stop conjuncts").toBe(14);
    const tally = new Tally();
    console.log(`[stream-auto-model] property: seed=${SEED} runs=${RUNS} maxCommands=${MAX_COMMANDS} report=${REPORT}`);
    try {
      await fc.assert(
        fc.asyncProperty(fc.record({ funded: fc.boolean(), picked: fc.boolean() }), COMMANDS, async (setup, cmds) => {
          tally.runs++;
          const world = await freshReal(tally, setup);
          await fc.asyncModelRun(() => world, cmds);
        }),
        { numRuns: RUNS, seed: SEED, verbose: 1, endOnFailure: process.env.CAPTURE_AUTO_MODEL_SHRINK === "0" },
      );
    } catch (err) {
      // The seed and the tally so far, visibly, before fast-check's own error (which names the seed and the path again).
      console.log(`[stream-auto-model] FAILED seed=${SEED}\n${tally.report()}`);
      throw err;
    }
    const report = tally.report();
    appendFileSync(REPORT, report);
    console.log(`[stream-auto-model] PASSED ${report}`);
    const zeroCounts = REQUIRED_COUNTS.filter((k) => tally.counts[k] === 0);
    const zeroActions = ACTIONS.filter((a) => tally.actions.get(a) === 0);
    expect(zeroCounts, `counters no drawn run reached — ${report}`).toEqual([]);
    expect(zeroActions, `actions no drawn run took — ${report}`).toEqual([]);
    const silent = Object.entries(INVARIANT_WITNESSES).filter(([, ks]) => ks.some((k) => tally.counts[k] === 0)).map(([n]) => n);
    expect(silent, `invariants whose check never had anything to bite on — ${report}`).toEqual([]);
    expect(tally.runs).toBe(RUNS);
    expect(tally.invariantChecks).toBe(tally.steps);
    expect(tally.steps).toBeGreaterThan(RUNS);
  }, RUNS * PER_RUN_BUDGET_MS + 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// The scenes, pinned: each rare ordering run ALONE in a declared world, with the counters only it can move
// ---------------------------------------------------------------------------------------------------------------------

/** A scene is deterministic, so the property's luck is not what proves it: each row names the world it runs in and the counters
 *  the SPEC says it reaches (a sole blocker of §7.2 / §7.3, a refusal, an end), and the model's invariants run after every step of
 *  it exactly as they do in the property. Zero reached is a failure — a scene that stopped reaching its row is an inert one. */
const PINNED: readonly { scene: string; make: () => Cmd; world: { funded: boolean; picked: boolean }; reaches: readonly CountKey[] }[] = [
  { scene: "refusal then retry (unfunded)", make: () => cmd.sceneRefusalRetry(false), world: { funded: false, picked: true },
    reaches: ["startSole:switch_on", "startSole:phone_automatic", "startSole:retry_spacing", "autoStartsRefused", "retriesFired", "autoStartsFired", "retryWithheldOneMsEarly", "retryFiredAtTheEdge"] },
  { scene: "an open hand broadcast, then the organiser's Stop", make: () => cmd.sceneStopBlocksStart(true), world: { funded: false, picked: true },
    reaches: ["startSole:no_open_session", "startSole:not_blocked", "organiserStopsStamped", "organiserStopsRepeated"] },
  { scene: "ingest ran, then the result is reverted", make: () => cmd.sceneIngestBlocksStart(true), world: { funded: false, picked: true },
    reaches: ["startSole:no_broadcast_ran", "autoStopsFired", "autoStopsOfHandStartedBroadcast"] },
  { scene: "a broadcast created after the result", make: () => cmd.scenePostResult(true), world: { funded: false, picked: true }, reaches: ["postResultBroadcastLeftAlone"] },
  { scene: "revert then re-finish", make: () => cmd.sceneRevertRefinish(true), world: { funded: false, picked: true },
    reaches: ["stopCancelledByRevert", "stopRestartedByRefinish", "autoStopsFired", "autoStopsAtTheBoundary"] },
  { scene: "a session created in the result's millisecond", make: () => cmd.sceneTie(true), world: { funded: false, picked: true },
    reaches: ["createdInTheResultsMillisecondLeftAlone", "autoStopsFired"] },
  { scene: "the stop needs the switch AND the phone's mode", make: () => cmd.sceneStopNeedsBoth(true), world: { funded: false, picked: true },
    reaches: ["stopSole:switch_on", "stopSole:phone_automatic", "autoStopsFired"] },
  { scene: "once per match: the automatic broadcast ended, nothing starts again", make: () => cmd.sceneOnce(true), world: { funded: false, picked: true },
    reaches: ["autoStartsFired", "startSole:not_yet_started"] },
  // The empty case of the settings row: no pick, the switch CREATES the row (invariant 8 — it must still read as unchosen) and the
  // automatic start streams to the org's default destination.
  { scene: "once per match, with no settings row before the switch", make: () => cmd.sceneOnce(true), world: { funded: false, picked: false },
    reaches: ["switchCreatesTheRow", "autoStartsFired", "startSole:not_yet_started"] },
  { scene: "the warming timeout", make: () => cmd.sceneTimeout(true), world: { funded: false, picked: true }, reaches: ["warmingTimeouts", "autoStartsFired"] },
  { scene: "the beat's own tick ends the old broadcast, then starts the new one", make: () => cmd.sceneTickThenStart(true), world: { funded: false, picked: true },
    reaches: ["startOnTheBeatThatTickedTheStopped", "autoStartsFired", "warmingTimeouts"] },
  { scene: "Go live with no credit is refused", make: () => cmd.sceneManualRefusal(false), world: { funded: false, picked: true }, reaches: ["manualRefusals"] },
  { scene: "Go live with credit is admitted", make: () => cmd.sceneManualRefusal(true), world: { funded: false, picked: true }, reaches: ["manualGoLives"] },
  { scene: "an automatic broadcast is auto-stopped after the result", make: () => cmd.sceneAutoStartThenStop(true), world: { funded: false, picked: true },
    reaches: ["autoStartsFired", "autoStopsOfAutoStartedBroadcast"] },
  { scene: "a stored refusal is hidden once a Stop blocks the start", make: () => cmd.sceneRefusalHiddenByStop(), world: { funded: false, picked: true },
    reaches: ["storedRefusalHiddenAfterStop", "organiserStopsStamped", "autoStartsRefused"] },
  { scene: "the organiser stops the automatic broadcast", make: () => cmd.sceneOrganiserStopsAuto(true), world: { funded: false, picked: true },
    reaches: ["organiserStopsOfAutoStarted", "autoStartsFired"] },   // not_yet_started AND not_blocked both fail here: neither is the SOLE blocker
  // Owner ruling 2026-10-08 (relayed by the controller): accepted. Left alone under the first result, auto-stopped under the second.
  { scene: "the score-correction edge: a broadcast born after the first result is auto-stopped after the re-finish", make: () => cmd.sceneScoreCorrection(true),
    world: { funded: false, picked: false }, reaches: ["postResultBroadcastLeftAlone", "autoStopOfBroadcastBornBetweenTwoFinishes", "autoStopsOfHandStartedBroadcast", "switchBesideAPick"] },
];

describe.skipIf(!HAS_DB)("automatic start and stop: the pinned scenes", () => {
  it("the table pins every scene the property draws", () => {
    const pinned = new Set(PINNED.map((p) => p.make().action));
    const scenes = ACTIONS.filter((a) => a.startsWith("scene"));
    expect(scenes.length, "anti-vacuity: the scenes there are").toBeGreaterThan(10);
    expect(scenes.filter((a) => !pinned.has(a)), "a scene the property draws and no pinned row runs alone").toEqual([]);
  });

  it.each(PINNED.map((p) => [p.scene, p] as const))("%s", async (_name, p) => {
    const tally = new Tally();
    const world = await freshReal(tally, p.world);
    await fc.asyncModelRun(() => world, [p.make()]);
    console.log(`[stream-auto-model] scene "${p.scene}": steps=${tally.steps} invariantChecks=${tally.invariantChecks} reached ${p.reaches.map((k) => `${k}=${tally.counts[k]}`).join(" ")}`);
    expect(tally.steps, "the scene ran steps").toBeGreaterThan(0);
    expect(tally.invariantChecks, "an invariant check after every step").toBe(tally.steps);
    expect(p.reaches.length, "the row names what the scene reaches").toBeGreaterThan(0);
    expect(p.reaches.filter((k) => tally.counts[k] === 0), `counters the scene did not reach — ${tally.report()}`).toEqual([]);
  }, 60_000);
});
