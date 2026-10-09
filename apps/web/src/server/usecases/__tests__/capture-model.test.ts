// Capture QR v2 §11.1.4 (T10) — the capture surface as a MODEL (TEST-STRATEGY rule 10), with fast-check's `fc.commands`.
// Two phones (A and B), one fixture per run, the REAL use-cases (postBeat, postStart, getCode, createSession,
// stopSession, tickSession, tickOpenSessions, reissueStreamCode, ensureStreamCode via the rig, removeStreamTarget,
// createStreamTarget, saveStreamSettings, recordPurchase, and the fixture's status write through V430's trigger) on the
// FAKE drivers and an injected clock. The fake ingest never connects on its own (connectAfterMs outlasts any run): video
// arrives only when the model says so, through FakeIngest.setState (A26, FP8), which also scripts `unknown` (M-3).
//
// The model is the brief's — { current, open: {sid, live, holder}, stopRecords } — plus what the phones themselves know
// (the code each last scanned, the stop each last delivered), W23's counter and window, the org's balance, the fixture's
// finish (C2) and the destinations (T36). Each command predicts its answer FROM THE SPEC (§5.5's T1–T8 rows, C1/C1b/C2–C5,
// T12–T15, T20/T21, T23/T24/T24a, T28, T33/T34, T36, W5, W23, §6.7.1's admission order), runs the real call, compares,
// and moves the model. A session the TICK ends (ask 10, W19, the warming timeout, max duration) is the one thing the model
// does not predict step by step — it cannot, without re-implementing the clocks under test — so such an end is accepted
// only when invariant 10 (and its siblings) proves it was owed at that instant; and M-4 proves the converse for W19: an
// end owed at a tick, on a read the tick claimed, is made at that tick.
//
// After EVERY primitive step twelve invariants are checked against the database (§11.1.4's ten; #11 is W23's, #12 money):
//   1. at most one current pairing per code and slot;          2. at most one open session per fixture;
//   3. `cred` is served only to the open session's phone;      4. a live slot changes phone only through T4, its
//      conjunction true;                                        5. no stop closes a sid other than the one named;
//   6. a code never answers 401 to its open session's phone;   7. at most one consume per session, and only with video;
//   8. go-live ⇒ no ingest yet, live ⇒ ingest — on the beat's and the descriptor's ANSWERS (I-3) and on the rows;
//   9. a stop from a phone that is not current never ends a sid the current phone holds (T24a);
//  10. phone_lost only when owed (T25a / ask 10), and never on an `unknown` read (m-3);
//  11. the fixture's consume rows equal W23's count from the rule text (T6b's rule);
//  12. the org's balance equals the rule text's: the month's allowance + bought − paid lives (T14, W23's waiver, T28).
// #7 as the spec words it ("at most one consume per fixture per 24 h") is superseded by W23 — a 4th restart inside the
// window pays — so #7 is checked per session here and the per-window rule is #11.
//
// Anti-vacuity: every action and every outcome is counted over the DRAWN runs (there are no examples in the property),
// and a zero fails. The counters the brief names, plus paidRestarts and the fix round's (go-live/live answers, no-credit
// refusals, free restarts at zero, owed W19 ends made), must each be > 0. The seed comes from CAPTURE_MODEL_SEED (default
// fixed) and is written, with the tally, to CAPTURE_MODEL_REPORT (default: the OS tmpdir).
//
// ONE SPORT, on purpose (rule 6): nothing on this surface reads the sport (capture-start.test.ts pins the cricket row).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import fc from "fast-check";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureBeatAnswer, CaptureStartOk } from "@/server/api-v1/capture-schemas";
import {
  CODE_GRACE_AFTER_FINISH_MINUTES, CREDIT_REUSE_HOURS, DEAD_PHONE_TAKEOVER_SECONDS, FREE_RESTARTS_PER_WINDOW,
  PHONE_LOST_LIVE_MINUTES, PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS, WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { OPEN_SESSION_MAX_POLL_SECONDS } from "@/server/relay/domain/poll-seconds";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { getCode, postBeat, postStart } from "../capture-phone";
import { reissueStreamCode, saveStreamSettings } from "../stream-codes";
import { creditBalance, ensureMonthlyStreamGrant, recordPurchase, streamMonthlyRate } from "../stream-credits";
import { createSession, stopSession, tickOpenSessions, tickSession } from "../stream-sessions";
import { createStreamTarget, removeStreamTarget } from "../stream-targets";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.AUTH_SECRET = "capture-model-test-secret";
});
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
/** The brief's default was 60. At 60 the rarest outcomes (ask 10 on a warming session, a resume refused T6, a GET with no
 *  cred) drew 0–3 per seed across five probe seeds — reachable, but a zero on some seed is a coin toss. 200 runs of up to
 *  50 commands cost about a minute on a local database and put every outcome well clear of zero. */
const RUNS = Number(process.env.CAPTURE_MODEL_RUNS ?? 200);
const SEED = Number(process.env.CAPTURE_MODEL_SEED ?? 20261004);
const MAX_COMMANDS = 50;
/** The property's budget is DERIVED (AGENTS.md class 20): a run of 200 measured ~20 ms a step and ~25 steps a run on a
 *  local database; 100 ms for every command a run may draw leaves 5× headroom on the worst case and moves with RUNS. */
const STEP_BUDGET_MS = 100;
const REPORT = process.env.CAPTURE_MODEL_REPORT ?? `${tmpdir()}/capture-model-report.txt`;
/** The fake never connects on its own: only `ingestConnect` (FakeIngest.setState) brings video. Its clock rule connects an
 *  UNSCRIPTED input once this has passed since creation, so it must outlast the longest run: 50 draws of the 25 h step. */
const NEVER_MS = 400 * 24 * 60 * MIN;
const ACTIVE = ACTIVE_STATES as readonly string[];
/** §6.8.5 / §6.5: the spec's two windows, from its constants. */
const LOST_MS = PHONE_LOST_LIVE_MINUTES * MIN;
const DEAD_MS = DEAD_PHONE_TAKEOVER_SECONDS * SEC;
/** §6.9: silent at max(floor, cadence + slack). */
const silentMs = (cadenceSeconds: number) => Math.max(PHONE_SILENT_FLOOR_SECONDS, cadenceSeconds + PHONE_SILENT_SLACK_SECONDS) * SEC;
/** A fresh poll read needs the claim window AND the coalesced sample's age bound behind it (B0: 2 × STREAM_POLL_MS). */
const FRESH_READ_MS = 2 * STREAM_POLL_MS;
/** C2 (§5.1): a finished fixture's code expires this long after the finish, when no session is open. */
const GRACE_MS = CODE_GRACE_AFTER_FINISH_MINUTES * MIN;
/** §5.2 / W23: the reuse window, from its anchor consume. */
const REUSE_MS = CREDIT_REUSE_HOURS * 60 * MIN;
/** windowEdge: Go live this far (halved) inside the window's end, the video this far later — past it. */
const EDGE_MS = MIN;

type P = "A" | "B";
const PHONES: readonly P[] = ["A", "B"];
const other = (p: P): P => (p === "A" ? "B" : "A");

/** The brief's model, plus what each phone knows. */
type Model = {
  /** The phone holding the ACTIVE code's current pairing (slot 0). */
  current: P | null;
  /** The fixture's open session: its sid, whether it has video (first ingest), the phone holding it (its pairing's,
   *  while that pairing stands), the code index that pairing is on, and the code index active when it was created. */
  open: { sid: string; live: boolean; holder: P | null; pairIdx: number; bornIdx: number; startedBy: "organiser" | "operator"; target: number } | null;
  /** A phone's Stop not yet delivered (A8: a Stop before the first frame sends no beat; the record rides the next call). */
  stopRecords: Map<P, string>;
  /** The stop each phone last delivered (a retry re-sends it). */
  delivered: Map<P, string>;
  /** The code index each phone last scanned (a claim is a scan; a 401 makes it forget). */
  scanned: Map<P, number>;
  /** How many codes have been issued; the active one is `codes - 1`. */
  codes: number;
  sessions: { sid: string; video: boolean }[];
  /** W23 (§6.7.4), from the rule text: the first live pays and anchors; then three counted restarts are free and the
   *  fourth pays and re-anchors. The window is §5.2's: CREDIT_REUSE_HOURS from the anchor consume's ledger row (its
   *  `created_at`, the DATABASE clock — read back from the row the model predicted, since no model can know it first). A
   *  video after the window closed pays and re-anchors (M-1). */
  w23: { anchorAt: number | null; counted: number; paid: number };
  /** The org's match credits, from the rule text: the plan's monthly allowance plus the drawn pack, −1 per paid live, +delta
   *  per purchase; a free restart costs nothing (T14 / W23's balance waiver). */
  balance: number;
  /** C2 (§5.1): when the fixture finished (the injected clock), null while it is not finished (C5 clears it). */
  finishedAt: number | null;
  /** C2's write: the ACTIVE code has been found expired and ENDED. It stays ended (C5); only a reissue mints past it. */
  expired: boolean;
  /** The destination the organiser names (§6.7.3's pre-pick, an index into Real.targets), and the archived ones (T36). */
  pick: number;
  archived: Set<number>;
  /** The injected clock (the rig's), for the commands' preconditions. */
  now: () => number;
};

const COUNT_KEYS = [
  "takeovers", "lateStopsDelivered", "lateStopsIgnoredHeld", "credsServed", "phoneLostLive", "phoneLostWarming",
  "consumes", "refusedClaims", "oneCurrent", "oneOpen", "paidRestarts",
  // I-3: #8 on the answers it names. I-2: T14's gate and W23's balance waiver. M-4: an owed W19 end made at the tick.
  "goLiveAnswers", "liveAnswers", "noCreditRefusals", "freeAtZero", "owedLostMade",
  // m-b: a Go live on a code past its grace whose phone is PRESENT — the case the lookup admitted before it evaluated C2.
  "codeEndedPresent",
] as const;
type CountKey = (typeof COUNT_KEYS)[number];
const ACTIONS = [
  "claimNew", "claimResume", "beat", "get", "phoneStop", "localStop", "goLive", "restart", "operatorStart",
  "ingestConnect", "ingestDrop", "advance", "gone", "tick", "cronTick", "orgStop", "reissue", "rescan", "lateStopRace",
  "lateStopOwn", "deadTakeover", "oldCodeCall",
  // I-2: §11.1.4's four, the repick that keeps a run going after an archive, and T28's window edge. M-3: the unknown word.
  "finish", "revertResult", "archiveDestination", "buyCredit", "repick", "windowEdge", "ingestUnknown",
  // m-c (B7 re-review): the rare outcomes' own intents.
  "warmingLost", "staleStop", "archivedRestart", "noCreditStart",
] as const;
type Action = (typeof ACTIONS)[number];
/** Every outcome the model can name. Each must be reached by the drawn runs. */
const OUTCOMES = [
  "claimNew:T1-accept", "claimNew:T1-rescan", "claimNew:T2-takeover", "claimNew:T3-taken", "claimNew:T4-takeover",
  "claimResume:T5-accept", "claimResume:T6-replaced", "claimResume:401",
  "beat:T8", "beat:T7-replaced", "beat:401", "beat:c1b-served",
  "lateStop:applied-current", "lateStop:ignored-held", "lateStop:stale",
  "get:cred", "get:no-cred", "get:401",
  "phoneStop:T21", "goLive:200", "goLive:phone_not_paired", "goLive:phone_not_responding", "goLive:refused-open",
  "start:200", "start:already_live", "start:replaced", "start:401",
  "video:first-paid", "video:free-restart", "video:paid-restart",
  "end:phone_lost-live", "end:phone_lost-warming", "end:no_inbound_timeout", "orgStop:stopped", "rescan:I-2",
  // I-2 — C2/T33/T34/C4/C5, T36, T14/T28, and M-1's closed window.
  "beat:T34-deferred", "beat:T33-401", "reissue:200", "reissue:422", "revert:active", "revert:expired-stays",
  "archive:archived", "archive:held-refused", "start:no_destination", "goLive:target_not_found",
  "goLive:no_credits", "start:no_credit", "buy:applied", "video:window-closed-paid", "video:T28-no_credits",
  // m-b: C2 evaluated at W5's lookup.
  "goLive:code-ended",
] as const;
type Outcome = (typeof OUTCOMES)[number] | "end:max_duration";

class Tally {
  readonly counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Record<CountKey, number>;
  readonly actions = new Map<Action, number>(ACTIONS.map((a) => [a, 0]));
  readonly outcomes = new Map<Outcome, number>(OUTCOMES.map((o) => [o, 0]));
  steps = 0;
  invariantChecks = 0;
  rowsCompared = 0;
  runs = 0;
  count(k: CountKey) { this.counts[k]++; }
  action(a: Action) { this.actions.set(a, this.actions.get(a)! + 1); }
  outcome(o: Outcome) { this.outcomes.set(o, (this.outcomes.get(o) ?? 0) + 1); }
  report(): string {
    return `seed=${SEED} runs=${this.runs} steps=${this.steps} invariantChecks=${this.invariantChecks} rowsCompared=${this.rowsCompared}\n`
      + `counts: ${COUNT_KEYS.map((k) => `${k}=${this.counts[k]}`).join(" ")}\n`
      + `actions: ${ACTIONS.map((a) => `${a}=${this.actions.get(a)}`).join(" ")}\n`
      + `outcomes: ${[...this.outcomes].map(([o, n]) => `${o}=${n}`).join(" ")}\n`;
  }
}

type Real = {
  r: CaptureRig;
  phones: Record<P, string>;
  codes: { code: string; tok: string }[];
  /** What the model scripted on each input (unscripted = disconnected, the fake never connects by itself). */
  scripted: Map<string, "connected" | "disconnected" | "unknown">;
  /** The org's destinations, in the order the model made them (Model.pick indexes this). */
  targets: string[];
  /** The fixture's status before `finish`, which `revertResult` restores. */
  priorStatus: string | null;
  everConnected: Set<string>;
  tally: Tally;
};

// ---------------------------------------------------------------------------------------------------------------------
// The database as each step sees it
// ---------------------------------------------------------------------------------------------------------------------

type SRow = {
  id: string; state: string; first_ingest_at: Date | null; created_at: Date; warming_at: Date | null; started_at: Date | null;
  phone_beat_at: Date | null; end_reason: string | null; fail_reason: string | null; max_duration_minutes: number;
  pairing_id: string | null; holder: string | null; holder_code: string | null; holder_beat_at: Date | null;
  input_id: string | null; last_connected_at: Date | null; consumes: number;
  /** The poll's claim stamp (a read inside STREAM_POLL_MS of it is coalesced), and the latest poll sample's word and time —
   *  what a coalesced read serves (M-2, M-3). */
  ingest_polled_at: Date | null; sample_word: string | null; sample_at: Date | null;
};
type Snap = { sessions: SRow[]; current: { phone: string; last_beat_at: Date; answered_poll_seconds: number } | null };

async function snapshot(x: Real): Promise<Snap> {
  const sessions = await sql<SRow[]>`
    select s.id, s.state, s.first_ingest_at, s.created_at, s.warming_at, s.started_at, s.phone_beat_at, s.end_reason,
           s.fail_reason, s.max_duration_minutes, s.pairing_id,
           p.phone as holder, k.code as holder_code, p.last_beat_at as holder_beat_at,
           (select i.ingest_input_id from fixture_stream_inputs i where i.session_id = s.id order by i.slot limit 1) as input_id,
           (select max(x.sampled_at) from fixture_stream_samples x
             where x.session_id = s.id and x.source = 'poll' and x.ingest_state = 'connected') as last_connected_at,
           (select count(*)::int from org_stream_credits c where c.org_id = s.org_id and c.session_id = s.id and c.reason = 'consume') as consumes,
           s.ingest_polled_at,
           (select x.ingest_state from fixture_stream_samples x where x.session_id = s.id and x.source = 'poll' order by x.sampled_at desc limit 1) as sample_word,
           (select max(x.sampled_at) from fixture_stream_samples x where x.session_id = s.id and x.source = 'poll') as sample_at
      from fixture_stream_sessions s
      left join fixture_stream_pairings p on p.id = s.pairing_id and p.ended_at is null
      left join fixture_stream_codes k on k.id = p.code_id
     where s.fixture_id = ${x.r.fixtureId}
     order by s.created_at, s.id`;
  const [current] = await sql<{ phone: string; last_beat_at: Date; answered_poll_seconds: number }[]>`
    select p.phone, p.last_beat_at, p.answered_poll_seconds
      from fixture_stream_codes c join fixture_stream_pairings p on p.code_id = c.id and p.slot = 0 and p.ended_at is null
     where c.fixture_id = ${x.r.fixtureId} and c.ended_at is null`;
  return { sessions, current: current ?? null };
}
const phoneOf = (x: Real, id: string | null): P | null => (id === null ? null : PHONES.find((p) => x.phones[p] === id) ?? null);

/** M-3 / m-3: the only word that may end a live slot (W19) or hand it over (T4) is `disconnected` — never `unknown`. A fresh
 *  read is the script's word (a read the tick CLAIMED) or a poll sample young enough to be served coalesced; true when
 *  either could have said it. */
function couldReadDisconnected(x: Real, s: SRow, now: number): boolean {
  if ((x.scripted.get(s.input_id ?? "") ?? "disconnected") === "disconnected") return true;
  return s.sample_word === "disconnected" && s.sample_at !== null && now - s.sample_at.getTime() < FRESH_READ_MS;
}
/** M-2 / M-4: a tick at `now` CLAIMS its read — nothing coalesces it — so the word it reads is the script's. */
const claimsRead = (s: SRow, now: number) => s.ingest_polled_at === null || now - s.ingest_polled_at.getTime() >= STREAM_POLL_MS;
/** M-4: W19 (§6.8.5) is OWED at `now` and the tick will read the word that proves it: a live session with a phone (C-1),
 *  no beat and no connected sample for PHONE_LOST_LIVE_MINUTES, the script `disconnected`, and the read claimed. */
function w19Owed(x: Real, s: SRow, now: number): boolean {
  return s.state === "live" && s.first_ingest_at !== null && s.pairing_id !== null
    && now - (s.phone_beat_at ?? s.first_ingest_at).getTime() >= LOST_MS
    && now - (s.last_connected_at ?? s.first_ingest_at).getTime() >= LOST_MS
    && (x.scripted.get(s.input_id ?? "") ?? "disconnected") === "disconnected" && claimsRead(s, now);
}
/** C2 (§5.1), from the rule text: the ACTIVE code at `now`. `due` is C2's evaluation finding it expired (finished GRACE
 *  ago or more, no session open): the call that finds it writes the end, and is refused. */
function activeStatus(m: Readonly<Model>, now: number): "active" | "finishing" | "due" | "expired" {
  if (m.expired) return "expired";
  if (m.finishedAt === null) return "active";
  return m.open === null && now - m.finishedAt >= GRACE_MS ? "due" : "finishing";
}
/** W23 (§6.7.4), from the rule text: free while the anchor's window is open and fewer than three restarts have counted. */
function restartOf(m: Readonly<Model>, now: number): { windowOpen: boolean; free: boolean } {
  const windowOpen = m.w23.anchorAt !== null && now - m.w23.anchorAt < REUSE_MS;
  return { windowOpen, free: windowOpen && m.w23.counted < FREE_RESTARTS_PER_WINDOW };
}

// ---------------------------------------------------------------------------------------------------------------------
// One primitive step: run it, reconcile the tick's ends, compare the model with the database, check the invariants
// ---------------------------------------------------------------------------------------------------------------------

type CallKind = "claimNew" | "claimResume" | "beat" | "get" | "start";
type StepInfo = {
  named: Set<string>;                         // sids this step names to stop (#5)
  predictedEnds: Map<string, string>;         // sid → the end_reason the spec predicts for it
  created: string | null;                     // a session this step opened (#8)
  calls: { phone: P; viaIdx: number; kind: CallKind; status: number; holderPre: boolean; pairIdxPre: number | null }[];
  claimNewBy: P | null;                       // #4: the only legal way a live slot changes phone
  ignoredHeld: string | null;                 // #9
  answers: { sid: string; state: string; via: "beat" | "get" }[];   // #8 (I-3): the answers that name a session
  owedLost: string[];                         // M-4: sids W19 owes an end at this tick
  now: Date;
};

async function step(m: Model, x: Real, body: (info: StepInfo, pre: Snap) => Promise<void>): Promise<void> {
  const pre = await snapshot(x);
  const info: StepInfo = { named: new Set(), predictedEnds: new Map(), created: null, calls: [], claimNewBy: null, ignoredHeld: null, answers: [], owedLost: [], now: x.r.now() };
  await body(info, pre);
  info.now = x.r.now();
  const post = await snapshot(x);
  await reconcile(m, x, info, pre, post);
  x.tally.steps++;
}

/** #10 and its siblings: an end the TICK made must have been owed at the instant it was written. */
async function checkTickEnd(x: Real, s: SRow, now: Date): Promise<Outcome> {
  const t = now.getTime();
  if (s.end_reason === "phone_lost" && s.first_ingest_at !== null) {
    // W19 / T25a: no beat AND no connected sample for PHONE_LOST_LIVE_MINUTES (from first ingest when none), and the
    // input not connected.
    const beatAge = t - (s.phone_beat_at ?? s.first_ingest_at).getTime();
    const videoAge = t - (s.last_connected_at ?? s.first_ingest_at).getTime();
    // M-3: the read W19 judged said `disconnected` — an `unknown` (m-3) or a connected input never ends it.
    expect([beatAge >= LOST_MS, videoAge >= LOST_MS, couldReadDisconnected(x, s, t)], `#10: ${s.id} ended phone_lost live with beat ${beatAge} ms, video ${videoAge} ms, script ${x.scripted.get(s.input_id ?? "")}, sample ${s.sample_word}`).toEqual([true, true, true]);
    x.tally.count("phoneLostLive");
    return "end:phone_lost-live";
  }
  if (s.end_reason === "phone_lost") {
    // Ask 10 (§6.8.3): no video yet, and the session's phone silent (§6.9) — or its pairing gone.
    const [p] = await sql<{ last_beat_at: Date; answered_poll_seconds: number; ended_at: Date | null }[]>`
      select last_beat_at, answered_poll_seconds, ended_at from fixture_stream_pairings where id = ${s.pairing_id}`;
    expect(p, `#10: ${s.id} ended phone_lost (ask 10) with a phone`).toBeDefined();
    if (p!.ended_at === null) {
      const heard = p!.last_beat_at.getTime() > s.created_at.getTime();
      const cadence = heard ? Math.min(p!.answered_poll_seconds, OPEN_SESSION_MAX_POLL_SECONDS) : p!.answered_poll_seconds;
      const silence = t - p!.last_beat_at.getTime();
      expect(silence, `#10 (ask 10): ${s.id} ended phone_lost after ${silence} ms of silence, cadence ${cadence} s`).toBeGreaterThanOrEqual(silentMs(cadence));
    }
    x.tally.count("phoneLostWarming");
    return "end:phone_lost-warming";
  }
  if (s.state === "failed" && s.fail_reason === "no_inbound_timeout") {
    const anchor = (s.warming_at ?? s.created_at).getTime();
    expect(t - anchor, `${s.id} failed no_inbound_timeout before WARMING_TIMEOUT_MINUTES`).toBeGreaterThanOrEqual(WARMING_TIMEOUT_MINUTES * MIN);
    return "end:no_inbound_timeout";
  }
  if (s.end_reason === "max_duration") {
    const from = (s.started_at ?? s.created_at).getTime();
    expect(t - from, `${s.id} ended max_duration early`).toBeGreaterThanOrEqual(s.max_duration_minutes * MIN);
    return "end:max_duration";
  }
  throw new Error(`#5/#10: ${s.id} ended ${s.state}/${s.end_reason}/${s.fail_reason} by no rule the model accepts`);
}

async function reconcile(m: Model, x: Real, info: StepInfo, pre: Snap, post: Snap): Promise<void> {
  const before = new Map(pre.sessions.map((s) => [s.id, s]));
  const t = x.tally;

  // Sessions that closed in this step: predicted (a named stop) or the tick's (owed, #10).
  for (const s of post.sessions) {
    const was = before.get(s.id);
    if (!was || !ACTIVE.includes(was.state) || ACTIVE.includes(s.state)) continue;
    const predicted = info.predictedEnds.get(s.id);
    if (predicted !== undefined) {
      if (predicted.startsWith("fail:")) expect([s.state, s.fail_reason], `the spec's failure for ${s.id}`).toEqual(["failed", predicted.slice(5)]);
      else expect(s.end_reason, `the spec's end for ${s.id}`).toBe(predicted);
    } else {
      expect(["stopped", "operator_stopped"], `#5: ${s.id} was stopped (${s.end_reason}) by a step that did not name it`).not.toContain(s.end_reason);
      t.outcome(await checkTickEnd(x, s, info.now));
      if (m.open?.sid === s.id) m.open = null;
    }
    // #5: a stop closes only the sid it names.
    if (s.end_reason === "stopped" || s.end_reason === "operator_stopped") expect(info.named.has(s.id), `#5: ${s.id} closed by a stop naming another sid`).toBe(true);
  }
  for (const sid of info.predictedEnds.keys()) {
    expect(ACTIVE.includes(post.sessions.find((s) => s.id === sid)?.state ?? "missing"), `the spec ends ${sid} in this step`).toBe(false);
  }

  // #2, and the model's open session is the database's.
  const open = post.sessions.filter((s) => ACTIVE.includes(s.state));
  expect(open.length, "#2: at most one open session per fixture").toBeLessThanOrEqual(1);
  expect(open.map((s) => s.id), "the model's open session").toEqual(m.open ? [m.open.sid] : []);
  if (m.open) {
    const o = open[0]!;
    expect([phoneOf(x, o.holder), o.holder_code], "the open session's phone and its code are the model's")
      .toEqual([m.open.holder, m.open.holder === null ? null : x.codes[m.open.pairIdx]!.code]);
    expect(o.first_ingest_at !== null, "the open session's video is the model's").toBe(m.open.live);
  }
  expect(post.sessions.map((s) => s.id), "one session row per start the model admitted").toEqual(m.sessions.map((s) => s.sid));
  expect(phoneOf(x, post.current?.phone ?? null), "the active code's current phone is the model's").toBe(m.current);
  t.rowsCompared += post.sessions.length + (post.current ? 1 : 0);

  // #1: one current pairing per code and slot.
  const doubled = await sql<{ code_id: string }[]>`
    select p.code_id from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
     where c.fixture_id = ${x.r.fixtureId} and p.ended_at is null group by p.code_id, p.slot having count(*) > 1`;
  expect(doubled, "#1: at most one current pairing per code and slot").toEqual([]);

  // #3 is checked by `get` itself (the answer is the evidence). #6: the open session's phone, calling through the code its
  // pairing is on, is never answered 401.
  for (const c of info.calls) {
    if (c.holderPre && c.viaIdx === c.pairIdxPre && c.kind !== "claimNew" && c.kind !== "start") {
      expect(c.status, `#6: ${c.kind} by the open session's phone through its own code`).not.toBe(401);
    }
  }

  // #4: a LIVE slot changes phone only through T4, with all three conjuncts true at the claim.
  for (const s of post.sessions) {
    const was = before.get(s.id);
    if (!was || was.first_ingest_at === null || !ACTIVE.includes(was.state) || was.holder === null || s.holder === null || s.holder === was.holder) continue;
    expect(phoneOf(x, s.holder), `#4: ${s.id}'s live slot moved to a phone that did not claim it`).toBe(info.claimNewBy);
    const n = info.now.getTime();
    expect([
      n - was.holder_beat_at!.getTime() >= DEAD_MS,
      couldReadDisconnected(x, s, n),   // the claim's fresh read is recorded on the post row (M-3: never `unknown`)
      n - (was.last_connected_at ?? was.first_ingest_at).getTime() >= DEAD_MS,
    ], `#4: ${s.id}'s live slot changed phone without T4's conjunction`).toEqual([true, true, true]);
  }

  // #7 and #8.
  for (const s of post.sessions) {
    expect(s.consumes, `#7: one consume per session (${s.id})`).toBeLessThanOrEqual(1);
    if (s.consumes > 0) expect(s.first_ingest_at, `#7: a consume only with video (${s.id})`).not.toBeNull();
    if (s.state === "live") expect(s.first_ingest_at, `#8: live ⇒ ingest (${s.id})`).not.toBeNull();
    if (s.first_ingest_at !== null) expect(x.everConnected.has(s.input_id ?? ""), `#8: ${s.id} has ingest the fake never sent`).toBe(true);
  }
  if (info.created !== null) {
    expect(post.sessions.find((s) => s.id === info.created)?.first_ingest_at, "#8: go-live ⇒ no ingest yet").toBeNull();
  }
  // #8 on the ANSWERS it names (I-3): a beat's `go-live S` and a descriptor's `warming` ⇒ S has no ingest yet; a `live S`
  // (beat or descriptor) ⇒ S has ingest. Each answer is read against the rows as the step left them, which is what the
  // answer was built from (§6.3.3 step 6).
  for (const a of info.answers) {
    const row = post.sessions.find((s) => s.id === a.sid);
    expect(row, `#8: the ${a.via} answer ${a.state} names a session of this fixture`).toBeDefined();
    if (a.state === "go-live" || a.state === "warming") {
      expect(row!.first_ingest_at, `#8: a ${a.via} answering ${a.state} ${a.sid} ⇒ no ingest yet`).toBeNull();
      if (a.state === "go-live") t.count("goLiveAnswers");
    } else if (a.state === "live") {
      expect(row!.first_ingest_at, `#8: a ${a.via} answering live ${a.sid} ⇒ ingest`).not.toBeNull();
      t.count("liveAnswers");
    }
  }
  // M-4 (§6.8.5 "when it fires"): an end W19 owed at this tick, on a read the tick claimed, was MADE at this tick.
  for (const sid of info.owedLost) {
    expect(ACTIVE.includes(post.sessions.find((s) => s.id === sid)?.state ?? "missing"), `M-4: W19 was owed for ${sid} at this tick and it is still open`).toBe(false);
    t.count("owedLostMade");
  }

  // #9 (T24a): the held sid is not ended by the stop that named it.
  if (info.ignoredHeld !== null) {
    expect(post.sessions.find((s) => s.id === info.ignoredHeld)?.end_reason, "#9: a non-current phone's stop ended the current phone's broadcast").not.toBe("operator_stopped");
  }

  // #11 (W23): the consume rows are the rule text's count.
  const consumes = post.sessions.reduce((n, s) => n + s.consumes, 0);
  const consumedBefore = pre.sessions.reduce((n, s) => n + s.consumes, 0);
  if (consumes > consumedBefore) t.count("consumes");
  expect(consumes, "#11: the fixture's consume rows are W23's count").toBe(m.w23.paid);
  // #12 (I-2, money): the org's balance is the rule text's — allowance + pack − paid lives + purchases.
  expect(await creditBalance(sql, x.r.auth.orgId), "#12: the org's match credits are the rule text's").toBe(m.balance);

  t.invariantChecks++;
}

// ---------------------------------------------------------------------------------------------------------------------
// The primitives — each a real call, its spec prediction, and the model's move
// ---------------------------------------------------------------------------------------------------------------------

type Got<T> = { ok: T } | { refused: CaptureRefusalError };
async function outcomeOf<T>(p: Promise<T>): Promise<Got<T>> {
  try {
    return { ok: await p };
  } catch (e) {
    if (e instanceof CaptureRefusalError) return { refused: e };
    throw e;
  }
}
const statusOf = (g: Got<unknown>) => ("refused" in g ? g.refused.status : 200);

function beatBody(x: Real, code: string, phone: string, over: Record<string, unknown>) {
  return CaptureBeat.parse({
    code, slot: 0, phone, claim: null, device: null, sid: null, at: x.r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-model/1", ...over,
  });
}

/** C1/C1b/C3 (§6.3): whether code `idx` serves phone p a call of this kind at `now`. The ACTIVE code serves everything
 *  while it is active or finishing (C1a; T34: an open session defers C2's expiry). Once C2 ends it (due or expired) it is an
 *  ENDED code — and C1b, which would serve the open session's phone, never applies: C2 ends a code only with no session
 *  open, and nothing opens on an ended code (W5 and T15 both need its current phone). A reissued code: a beat or a GET from
 *  the open session's phone, when the session was created before that code ended. */
function served(m: Model, p: P, idx: number, kind: CallKind, now: number): boolean {
  if (idx === m.codes - 1) {
    const st = activeStatus(m, now);
    if (st === "active" || st === "finishing") return true;
    expect(m.open, "C2 ends the active code only with no session open, and none can open on an ended code").toBeNull();
    return false;
  }
  if (kind === "claimNew" || kind === "start") return false;
  return m.open !== null && m.open.holder === p && idx >= m.open.bornIdx;
}

/** C2's write at a call that finds the active code due: it ENDS (expired), so the active code has no current phone. */
function expireIfDue(m: Model, idx: number, now: number): boolean {
  if (idx !== m.codes - 1) return false;
  const st = activeStatus(m, now);
  if (st === "due") { m.expired = true; m.current = null; }
  return st === "due" || st === "expired";
}

/** A refused 401: the phone forgets the code. */
function forget(m: Model, p: P, got: Got<unknown>, label: string) {
  expect("refused" in got && got.refused.status === 401 && got.refused.code === "code_ended", label).toBe(true);
  m.scanned.delete(p);
}

/**
 * Every beat-shaped call (§6.3.2): a claim (`new` through the active code, `resume` through the code the phone last
 * scanned) or a plain beat, carrying the phone's undelivered Stop (or, `resend`, the last one it delivered), or the
 * session's phone's own `ended` (T21).
 */
async function phoneCall(m: Model, x: Real, p: P, kind: "new" | "resume" | null, o: { resend?: boolean; ended?: boolean } = {}): Promise<void> {
  await step(m, x, async (info, pre) => {
    const t = x.tally;
    const active = m.codes - 1;
    const viaIdx = kind === "new" ? active : m.scanned.get(p)!;
    const c = x.codes[viaIdx]!;
    const X = m.stopRecords.get(p) ?? (o.resend ? m.delivered.get(p) ?? null : null);
    const holdsOpen = m.open !== null && m.open.holder === p;
    const sid = o.ended ? m.open!.sid : X === null && holdsOpen ? m.open!.sid : null;
    const callKind: CallKind = kind === "new" ? "claimNew" : kind === "resume" ? "claimResume" : "beat";
    const name = kind === "new" ? "claimNew" : kind === "resume" ? "claimResume" : "beat";
    const now = x.r.now().getTime();
    const isServed = served(m, p, viaIdx, callKind, now);
    // T34: the code is past its grace with a session open — expiry deferred, the call answered as before.
    const deferred = isServed && viaIdx === active && activeStatus(m, now) === "finishing" && now - m.finishedAt! >= GRACE_MS;
    if (kind === "new" && pre.current !== null && phoneOf(x, pre.current.phone) !== p) t.count("oneCurrent");
    const got = await outcomeOf(postBeat(c.code, c.tok, beatBody(x, c.code, x.phones[p], {
      claim: kind, sid, stopped: X, device: kind === "new" ? { model: `model-${p}` } : null,
      state: o.ended ? "ended" : sid !== null ? "connecting" : "paired", ...(o.ended ? { endReason: "operator-stopped" } : {}),
    }), x.r.deps, x.r.now()));
    info.calls.push({ phone: p, viaIdx, kind: callKind, status: statusOf(got), holderPre: holdsOpen, pairIdxPre: m.open?.pairIdx ?? null });
    if (!isServed) {
      if (expireIfDue(m, viaIdx, now)) t.outcome("beat:T33-401");   // T33: finish + grace, nothing open
      forget(m, p, got, `C1/C3: ${name} through an ended code`);
      t.outcome(kind === "resume" ? "claimResume:401" : "beat:401");
      if (kind !== null) t.count("refusedClaims");
      return;
    }
    expect("ok" in got, `${name} is served: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
    const answer = CaptureBeatAnswer.parse((got as { ok: unknown }).ok);
    if (answer.state === "go-live" || answer.state === "live") info.answers.push({ sid: answer.sid, state: answer.state, via: "beat" });
    if (deferred) t.outcome("beat:T34-deferred");
    if (kind === "new") m.scanned.set(p, viaIdx);
    if (viaIdx !== active) t.outcome("beat:c1b-served");

    // T4's read runs BEFORE the claim is decided, so a session it ended (W19) is not the slot's any more.
    let open = m.open;
    if (kind === "new" && open !== null && open.live && open.holder !== null && open.holder !== p) {
      const [now] = await sql<{ state: string; end_reason: string | null }[]>`select state, end_reason from fixture_stream_sessions where id = ${open.sid}`;
      if (!ACTIVE.includes(now!.state) && now!.end_reason !== "operator_stopped") open = null;
    }
    // §5.5's holder: the open session's phone while its pairing stands, else the current pairing on the caller's code.
    const H: P | null = open?.holder ?? (viaIdx === active ? m.current : null);
    const preSession = open === null ? null : pre.sessions.find((s) => s.id === open!.sid)!;
    const deadClocks = open !== null && preSession !== null && preSession.holder_beat_at !== null
      && now - preSession.holder_beat_at.getTime() >= DEAD_MS
      && now - (preSession.last_connected_at ?? preSession.first_ingest_at ?? x.r.now()).getTime() >= DEAD_MS;
    const deadPre = deadClocks && couldReadDisconnected(x, preSession!, now);
    // M-2: the claim's read is CLAIMED (nothing coalesces it), so it reads the script — and the script says
    // `disconnected`: all three conjuncts are known true before the call, and T4 is OWED, not merely allowed.
    const deadOwed = deadClocks && (x.scripted.get(preSession!.input_id ?? "") ?? "disconnected") === "disconnected" && claimsRead(preSession!, now);

    type Row = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8";
    let row: Row;
    if (kind === "new") {
      if (H === null || H === p) row = "T1";
      else if (open?.live) {
        if (deadOwed) expect(answer.state, "M-2: T4 is owed — the live slot's phone is dead on a claimed read (A14)").not.toBe("taken");
        // Otherwise a coalesced sample decides the second conjunct, and the answer says which it decided.
        row = answer.state === "taken" ? "T3" : "T4";
      } else row = "T2";
      if (row === "T4") expect(deadPre, "T4: a live slot is taken over only when its phone is dead (A14)").toBe(true);
    } else if (kind === "resume") row = H === null || H === p ? "T5" : "T6";
    else row = H === p ? "T8" : "T7";
    const refusedRow = row === "T3" ? "taken" : row === "T6" || row === "T7" ? "replaced" : null;
    if (refusedRow !== null) expect(answer.state, `${row}`).toBe(refusedRow);
    else expect(["taken", "replaced"], `${row}: the caller holds the slot`).not.toContain(answer.state);
    if (refusedRow !== null && kind !== null) t.count("refusedClaims");

    // The model's move.
    const callerCurrent = row === "T1" || row === "T2" || row === "T4" || row === "T5" || row === "T8";
    if (row === "T1" || row === "T5") {
      let moved = false;
      if (H === null) {
        if (viaIdx === active) m.current = p;
      } else if (open !== null && open.holder === p && open.pairIdx !== viaIdx) {
        // I-2: the session's phone re-seated onto the code it scanned, session and all.
        open.pairIdx = viaIdx;
        if (viaIdx === active) m.current = p;
        moved = true;
      }
      t.outcome(kind === "resume" ? "claimResume:T5-accept" : moved ? "claimNew:T1-rescan" : "claimNew:T1-accept");
    } else if (row === "T2" || row === "T4") {
      m.current = p;
      if (open !== null && open.holder === H) { open.holder = p; open.pairIdx = viaIdx; }
      info.claimNewBy = p;
      t.count("takeovers");
      t.outcome(row === "T2" ? "claimNew:T2-takeover" : "claimNew:T4-takeover");
    } else {
      t.outcome(row === "T3" ? "claimNew:T3-taken" : row === "T6" ? "claimResume:T6-replaced" : row === "T7" ? "beat:T7-replaced" : "beat:T8");
    }

    // The stop the call carried (T23 / T24 / T24a, §6.8.2): judged AFTER the claim.
    if (X !== null) {
      m.stopRecords.delete(p);
      m.delivered.set(p, X);
      t.count("lateStopsDelivered");
      if (open !== null && open.sid === X) {
        if (callerCurrent) {
          info.named.add(X);
          info.predictedEnds.set(X, "operator_stopped");
          m.open = null;
          t.outcome("lateStop:applied-current");
        } else {
          info.ignoredHeld = X;
          t.count("lateStopsIgnoredHeld");
          t.outcome("lateStop:ignored-held");
        }
      } else t.outcome("lateStop:stale");
    }

    // T21: the session's phone's own Stop ends the broadcast AND its pairing.
    if (o.ended) {
      expect(row, "T21 is the session's phone").toBe("T8");
      info.named.add(open!.sid);
      info.predictedEnds.set(open!.sid, "operator_stopped");
      if (open!.pairIdx === active) m.current = null;
      m.open = null;
      t.outcome("phoneStop:T21");
    }
  });
}

/** §6.3.1: the descriptor. #3: `cred` only to the open session's phone, while the session is warming, live or ending. */
async function get(m: Model, x: Real, p: P): Promise<void> {
  await step(m, x, async (info, pre) => {
    const idx = m.scanned.get(p)!;
    const c = x.codes[idx]!;
    const now = x.r.now().getTime();
    const isServed = served(m, p, idx, "get", now);
    const holdsOpen = m.open !== null && m.open.holder === p;
    const got = await outcomeOf(getCode(c.code, c.tok, { slot: 0, phone: x.phones[p] }, x.r.deps, x.r.now()));
    info.calls.push({ phone: p, viaIdx: idx, kind: "get", status: statusOf(got), holderPre: holdsOpen, pairIdxPre: m.open?.pairIdx ?? null });
    if (!isServed) { expireIfDue(m, idx, now); forget(m, p, got, "C1/C3: a GET through an ended code"); x.tally.outcome("get:401"); return; }
    expect("ok" in got, `GET is served: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
    const d = (got as { ok: Record<string, unknown> }).ok;
    if ((d.state === "live" || d.state === "warming") && typeof d.sid === "string") info.answers.push({ sid: d.sid, state: d.state, via: "get" });
    const state = m.open === null ? null : pre.sessions.find((s) => s.id === m.open!.sid)!.state;
    const owed = holdsOpen && (state === "warming" || state === "live" || state === "ending");
    expect("cred" in d, `#3: cred to ${p} (${owed ? "the open session's phone" : "not the open session's phone"})`).toBe(owed);
    if (owed) { x.tally.count("credsServed"); x.tally.outcome("get:cred"); } else x.tally.outcome("get:no-cred");
  });
}

/** W5 (§6.6): the organiser's Go live on the destination the organiser names — admitted only on a PRESENT current phone of
 *  the active code (no current phone: phone_not_paired; a current one gone silent: phone_not_responding, owner ruling
 *  2026-10-09), then §6.7.1's order: the balance gate (waived for a free restart, W23), then the destination (T36). */
async function goLive(m: Model, x: Real): Promise<"200" | "refused"> {
  let result: "200" | "refused" = "refused";
  await step(m, x, async (info, pre) => {
    const t = x.tally;
    let refusal: string | null = null;
    let sid: string | null = null;
    // C2 at W5's lookup (B7 re-review m-b): Go live evaluates the active code BEFORE any open session's lazy expiry, so an
    // open session (even one about to end) defers it — activeStatus reads m.open. Found due, it is refused below.
    const due = activeStatus(m, x.r.now().getTime()) === "due";
    try {
      sid = (await createSession(x.r.auth, x.r.fixtureId, { mode: "passthrough", targetId: x.targets[m.pick]! }, x.r.deps)).sessionId;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      refusal = e.code ?? `${e.status}`;
    }
    if (m.open !== null) {
      // Admission reconciles the open session first, so an end that was already owed (the lazy expiry) is written here
      // and the reconcile below proves it owed; a session still open refuses the Go live.
      const [still] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${m.open.sid}`;
      if (ACTIVE.includes(still!.state)) {
        // active_session outranks BOTH W5 answers (F-A5: admit's order, and the early W5 probe is admit itself), so the open
        // session is the only answer here — never phone_not_paired, never phone_not_responding.
        expect(refusal, "#2: Go live over an open session is refused").toBe("active_session");
        t.count("oneOpen");
        t.outcome("goLive:refused-open");
        return;
      }
      m.open = null;
    }
    const cur = pre.current;
    const present = cur !== null && x.r.now().getTime() - cur.last_beat_at.getTime() < silentMs(cur.answered_poll_seconds);
    if (due) {
      // §6.12 "Code ended: no Go live": the lookup writes the expiry (C2's first evaluation), so the code has no phone.
      expireIfDue(m, m.codes - 1, x.r.now().getTime());
      expect(refusal, "C2 at W5's lookup: a code past its grace answers no Go live").toBe("phone_not_paired");
      if (present) t.count("codeEndedPresent");
      t.outcome("goLive:code-ended");
      return;
    }
    if (cur === null) {
      expect(refusal, "W5: no current phone on the active code").toBe("phone_not_paired");
      t.outcome("goLive:phone_not_paired");
      return;
    }
    if (!present) {
      // Owner ruling 2026-10-09 (Option 1): a CURRENT phone gone silent is told apart from no phone at all.
      expect(refusal, "W5: the active code's current phone is silent (§6.9)").toBe("phone_not_responding");
      t.outcome("goLive:phone_not_responding");
      return;
    }
    const { free } = restartOf(m, x.r.now().getTime());
    if (m.balance < 1 && !free) {
      expect(refusal, "T14: no credit and not a free restart").toBe("no_credits");
      t.count("noCreditRefusals");
      t.outcome("goLive:no_credits");
      return;
    }
    if (m.archived.has(m.pick)) {
      // admit's target_not_found carries no code: the 404 itself.
      expect(refusal, "T36: the named destination is archived").toBe("404");
      t.outcome("goLive:target_not_found");
      return;
    }
    expect(refusal, "W5: a present phone is admitted").toBeNull();
    if (m.balance < 1) t.count("freeAtZero");   // W23's balance waiver: a free restart at an empty balance
    m.open = { sid: sid!, live: false, holder: m.current, pairIdx: m.codes - 1, bornIdx: m.codes - 1, startedBy: "organiser", target: m.pick };
    m.sessions.push({ sid: sid!, video: false });
    info.created = sid;
    result = "200";
    t.outcome("goLive:200");
  });
  return result;
}

/** T12 → T13 → T15 (§6.3.4): the phone's own start, through the code it last scanned, on the saved pre-pick. After T12
 *  and T13: no usable pre-pick → 409 no_destination (T36), then §6.7.1's balance gate → 402 no_credit (T14). */
async function operatorStart(m: Model, x: Real, p: P): Promise<void> {
  await step(m, x, async (info) => {
    const t = x.tally;
    const idx = m.scanned.get(p)!;
    const c = x.codes[idx]!;
    const now = x.r.now().getTime();
    const holdsOpen = m.open !== null && m.open.holder === p;
    const got = await outcomeOf(postStart(c.code, c.tok, { phone: x.phones[p] }, x.r.deps, x.r.now()));
    info.calls.push({ phone: p, viaIdx: idx, kind: "start", status: statusOf(got), holderPre: holdsOpen, pairIdxPre: m.open?.pairIdx ?? null });
    if (!served(m, p, idx, "start", now)) { expireIfDue(m, idx, now); forget(m, p, got, "C3: a start through an ended code"); t.outcome("start:401"); return; }
    const H = m.open?.holder ?? m.current;
    const refused = "refused" in got ? [got.refused.status, got.refused.code, got.refused.extras] : null;
    if (H !== p) {
      expect(refused, "T12: not the slot's phone").toEqual([409, "replaced", undefined]);
      t.outcome("start:replaced");
    } else if (m.open !== null) {
      expect(refused, "T13: names the running session and who started it").toEqual([409, "already_live", { sid: m.open.sid, startedBy: m.open.startedBy }]);
      t.count("oneOpen");
      t.outcome("start:already_live");
    } else if (m.archived.has(m.pick)) {
      expect(refused, "T36: the pre-pick is archived, so it reads as none").toEqual([409, "no_destination", undefined]);
      t.outcome("start:no_destination");
    } else if (m.balance < 1 && !restartOf(m, now).free) {
      expect(refused, "T14: no credit and not a free restart").toEqual([402, "no_credit", undefined]);
      t.count("noCreditRefusals");
      t.outcome("start:no_credit");
    } else {
      expect(refused, "T15").toBeNull();
      if (m.balance < 1) t.count("freeAtZero");
      const ok = CaptureStartOk.parse((got as { ok: unknown }).ok);
      m.open = { sid: ok.sid, live: false, holder: p, pairIdx: idx, bornIdx: idx, startedBy: "operator", target: m.pick };
      m.sessions.push({ sid: ok.sid, video: false });
      info.created = ok.sid;
      t.outcome("start:200");
    }
  });
}

/** The phone's video reaches the ingest (FakeIngest.setState), and a fresh poll reads it: the session has video. The FIRST
 *  video of a session is where money moves (W23 / T14 / T28), predicted from the rule text at the instant of the live. */
async function ingestConnect(m: Model, x: Real): Promise<void> {
  await step(m, x, async (info, pre) => {
    const t = x.tally;
    const sid = m.open!.sid;
    const input = pre.sessions.find((s) => s.id === sid)!.input_id!;
    x.r.ingest.setState(input, "connected");
    x.scripted.set(input, "connected");
    x.everConnected.add(input);
    x.r.tick(FRESH_READ_MS);
    await tickSession(sid, x.r.deps, "poll");
    const [row] = await sql<{ state: string; first_ingest_at: Date | null; fail_reason: string | null }[]>`
      select state, first_ingest_at, fail_reason from fixture_stream_sessions where id = ${sid}`;
    const s = m.sessions.find((v) => v.sid === sid)!;
    const now = x.r.now().getTime();
    const { windowOpen, free } = restartOf(m, now);
    const owed = !s.video && !free;               // this live must pay a credit
    if (row!.state === "failed" && row!.fail_reason === "no_credits") {
      // T28: admitted (free, or on a credit since spent), and at the live the restart is no longer free and the balance is
      // empty. The poll wrote first ingest before the credit was decided, so the session reached video (§6.7.4 counts it).
      expect([owed, m.balance < 1], "T28: failed(no_credits) only when the live owes a credit and none is held").toEqual([true, true]);
      info.predictedEnds.set(sid, "fail:no_credits");
      m.open = null;
      s.video = true;
      if (windowOpen) m.w23.counted++;
      t.outcome("video:T28-no_credits");
      return;
    }
    if (!ACTIVE.includes(row!.state)) return;   // the tick's expiry came first: the reconcile proves it owed
    expect(row!.first_ingest_at, "a fresh connected read records first ingest").not.toBeNull();
    expect(owed && m.balance < 1, "T28: a live owed a credit with none held went live").toBe(false);
    m.open!.live = true;
    if (s.video) return;
    s.video = true;
    // W23 from the rule text: the first live pays and anchors; three counted restarts are free; the fourth pays and
    // re-anchors; a live after the window closed pays and re-anchors (M-1).
    const w = m.w23;
    if (free) { w.counted++; t.outcome("video:free-restart"); return; }
    const kind = w.anchorAt === null ? "video:first-paid" : windowOpen ? "video:paid-restart" : "video:window-closed-paid";
    w.paid++;
    w.counted = 0;
    m.balance--;
    // The new anchor is this consume ROW's created_at (the database clock), read back from the row the model predicted.
    const [anchor] = await sql<{ created_at: Date }[]>`
      select created_at from org_stream_credits where session_id = ${sid} and reason = 'consume'`;
    expect(anchor, "the paid live wrote its consume row").toBeDefined();
    w.anchorAt = anchor!.created_at.getTime();
    if (kind === "video:paid-restart") t.count("paidRestarts");
    t.outcome(kind);
  });
}

async function ingestDrop(m: Model, x: Real): Promise<void> {
  await step(m, x, async (_info, pre) => {
    const input = pre.sessions.find((s) => s.id === m.open!.sid)!.input_id!;
    x.r.ingest.setState(input, "disconnected");
    x.scripted.set(input, "disconnected");
  });
}

/** M-3: Cloudflare answers `unknown` for the session's input (a read blip). Nothing may end or hand over on it (m-3). */
async function ingestUnknown(m: Model, x: Real): Promise<void> {
  await step(m, x, async (_info, pre) => {
    const input = pre.sessions.find((s) => s.id === m.open!.sid)!.input_id!;
    x.r.ingest.setState(input, "unknown");
    x.scripted.set(input, "unknown");
  });
}

const advance = (m: Model, x: Real, ms: number) => step(m, x, async () => { x.r.tick(ms); });
/** M-4: the tick is told which sessions W19 owes an end NOW, and the reconcile proves each was ended at this tick. */
const owedAt = (x: Real, info: StepInfo, pre: Snap) => {
  for (const s of pre.sessions) if (w19Owed(x, s, x.r.now().getTime())) info.owedLost.push(s.id);
};
const tick = (m: Model, x: Real) => step(m, x, async (info, pre) => { owedAt(x, info, pre); await tickSession(m.open!.sid, x.r.deps, "poll"); });
const cronTick = (m: Model, x: Real) => step(m, x, async (info, pre) => { owedAt(x, info, pre); await tickOpenSessions(x.r.deps, { orgIds: [x.r.auth.orgId] }); });

/** T20 (M-7): the organiser's Stop — the named session ends `stopped`; no pairing moves. */
async function orgStop(m: Model, x: Real): Promise<void> {
  await step(m, x, async (info) => {
    const sid = m.open!.sid;
    info.named.add(sid);
    info.predictedEnds.set(sid, "stopped");
    await stopSession(x.r.auth, x.r.fixtureId, sid, x.r.deps);
    m.open = null;
    x.tally.outcome("orgStop:stopped");
  });
}

/** T30/C-2: a new code; the old one ends; no pairing moves, and the open session keeps its phone. C4: refused on a
 *  finished fixture. After C5 the expired code stays ended, and this mints past it. */
async function reissue(m: Model, x: Real): Promise<void> {
  await step(m, x, async () => {
    const got = await reissueStreamCode(x.r.auth, x.r.fixtureId).then((shown) => ({ shown }), (e: unknown) => ({ e }));
    if (m.finishedAt !== null) {
      expect("e" in got && got.e instanceof HttpError && [got.e.status, got.e.code], "C4: no mint on a finished fixture").toEqual([422, "fixture_finished"]);
      x.tally.outcome("reissue:422");
      return;
    }
    if ("e" in got) throw got.e;
    x.codes.push({ code: got.shown.qr.code, tok: got.shown.qr.tok });
    m.codes++;
    m.current = null;
    m.expired = false;
    x.tally.outcome("reissue:200");
  });
}

/** The result is recorded: the fixture's status moves to a finished one and V430's trigger stamps `finished_at` (the
 *  producer every writer goes through; stream-codes.test.ts's `finish`). The stamp is the DATABASE clock, so it is then
 *  moved to the injected clock WITHOUT naming `status` (the trigger fires only on a status write). */
async function finish(m: Model, x: Real): Promise<void> {
  await step(m, x, async () => {
    const [f] = await sql<{ status: string }[]>`select status from fixtures where id = ${x.r.fixtureId}`;
    x.priorStatus = f!.status;
    await sql`update fixtures set status = 'cancelled' where id = ${x.r.fixtureId}`;
    const [stamped] = await sql<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${x.r.fixtureId}`;
    expect(stamped!.finished_at, "V430: a status write to a finished status stamps finished_at").not.toBeNull();
    await sql`update fixtures set finished_at = ${x.r.now()} where id = ${x.r.fixtureId}`;
    m.finishedAt = x.r.now().getTime();
  });
}

/** C5: the result is reverted — the prior status restored, and the trigger clears `finished_at`. A code not yet ended is
 *  plain ACTIVE again; one C2 already ended stays ended. */
async function revertResult(m: Model, x: Real): Promise<void> {
  await step(m, x, async () => {
    await sql`update fixtures set status = ${x.priorStatus!} where id = ${x.r.fixtureId}`;
    const [f] = await sql<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${x.r.fixtureId}`;
    expect(f!.finished_at, "V430: reverting the status clears finished_at (C5)").toBeNull();
    m.finishedAt = null;
    x.tally.outcome(m.expired ? "revert:expired-stays" : "revert:active");
  });
}

/** D2 / T36: Remove the pre-picked destination in Directory — an archive, refused while a session holds it. */
async function archiveDestination(m: Model, x: Real): Promise<void> {
  await step(m, x, async () => {
    const held = m.open !== null && m.open.target === m.pick;
    const got = await removeStreamTarget(x.r.auth, x.r.auth.orgId, x.targets[m.pick]!).then(() => null, (e: unknown) => e);
    if (held) {
      expect(got instanceof HttpError && [got.status, got.code], "D2: a destination a session holds is not removed").toEqual([409, "TARGET_IN_USE"]);
      x.tally.outcome("archive:held-refused");
      return;
    }
    expect(got, "D2: an unheld destination is archived").toBeNull();
    m.archived.add(m.pick);
    x.tally.outcome("archive:archived");
  });
}

/** The organiser adds a destination and picks it (§6.7.3's picker writes the pre-pick on change). */
async function repick(m: Model, x: Real): Promise<void> {
  await step(m, x, async () => {
    const saved = await createStreamTarget(x.r.auth, x.r.auth.orgId, { kind: "youtube", label: `Club ${x.targets.length + 1}`, streamKey: `yt-${randomUUID()}` });
    await saveStreamSettings(x.r.auth, x.r.fixtureId, { targetId: saved.id });
    x.targets.push(saved.id);
    m.pick = x.targets.length - 1;
  });
}

/** A Stripe purchase lands: the webhook's ledger writer, with its own event id. */
async function buyCredit(m: Model, x: Real, delta: number): Promise<void> {
  await step(m, x, async () => {
    const r = await recordPurchase({ orgId: x.r.auth.orgId, delta, stripeEventId: `evt_capture_model_${randomUUID()}` });
    expect(r.applied, "a new event id is applied").toBe(true);
    m.balance += delta;
    x.tally.outcome("buy:applied");
  });
}

/** A8: the session's phone stops before its first frame — no beat; it keeps the stop record. */
const localStop = (m: Model, x: Real) => step(m, x, async () => { m.stopRecords.set(m.open!.holder!, m.open!.sid); });

// ---------------------------------------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------------------------------------

type Sel = P | "holder" | "other";
/** "holder": the phone holding the slot (the open session's, else the active code's current); "other": the one that does not. */
function pick(m: Readonly<Model>, sel: Sel): P | null {
  if (sel === "A" || sel === "B") return sel;
  const h = m.open?.holder ?? m.current;
  if (sel === "holder") return h;
  return h === null ? "B" : other(h);
}

class Cmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly label: string, readonly action: Action, private readonly ok: (m: Readonly<Model>) => boolean, private readonly go: (m: Model, x: Real) => Promise<void>) {}
  check(m: Readonly<Model>): boolean { return this.ok(m); }
  async run(m: Model, x: Real): Promise<void> { x.tally.action(this.action); await this.go(m, x); }
  toString(): string { return this.label; }
}

const holderOpen = (m: Readonly<Model>) => (m.open !== null && m.open.holder !== null ? m.open.holder : null);
/** A live broadcast with a phone holding it (A14's state). */
const liveHeld = (m: Readonly<Model>) => holderOpen(m) !== null && m.open!.live;
/** A restart can be made: the fixture is not finished and its code not expired. */
const canRestart = (m: Readonly<Model>) => m.finishedAt === null && !m.expired;
/** localStop's state: an open session before its first frame whose phone holds no Stop yet. */
const stoppable = (m: Readonly<Model>) => { const h = holderOpen(m); return h !== null && !m.open!.live && !m.stopRecords.has(h); };
/** The late-stop intents' state: an open session before its first frame, its phone scanned, holding no Stop for another. */
const preFrame = (m: Readonly<Model>) => {
  const h = holderOpen(m);
  return h !== null && !m.open!.live && m.scanned.has(h) && (!m.stopRecords.has(h) || m.stopRecords.get(h) === m.open!.sid);
};
/** m-c (B7 re-review): the late-stop family reached by its OWN draws, not only when a run happens to be in that state —
 *  with no such session, `who`'s restart with no video makes one (each part a checked step). False when none results. */
async function openPreFrame(m: Model, x: Real, who: P): Promise<boolean> {
  if (!preFrame(m) && canRestart(m)) await cmd.restart(who, false).run(m, x);
  return preFrame(m);
}
const cmd = {
  claimNew: (sel: Sel, resend = false) => new Cmd(`claimNew(${sel}${resend ? ",resend" : ""})`, "claimNew",
    (m) => pick(m, sel) !== null, (m, x) => phoneCall(m, x, pick(m, sel)!, "new", { resend })),
  claimResume: (sel: Sel, resend = false) => new Cmd(`claimResume(${sel}${resend ? ",resend" : ""})`, "claimResume",
    (m) => { const p = pick(m, sel); return p !== null && m.scanned.has(p); }, (m, x) => phoneCall(m, x, pick(m, sel)!, "resume", { resend })),
  beat: (sel: Sel) => new Cmd(`beat(${sel})`, "beat",
    (m) => { const p = pick(m, sel); return p !== null && m.scanned.has(p); }, (m, x) => phoneCall(m, x, pick(m, sel)!, null)),
  get: (sel: Sel) => new Cmd(`get(${sel})`, "get",
    (m) => { const p = pick(m, sel); return p !== null && m.scanned.has(p); }, (m, x) => get(m, x, pick(m, sel)!)),
  /** T21: after the first frame the operator's Stop is an `ended` beat naming the sid. */
  phoneStop: () => new Cmd("phoneStop", "phoneStop",
    (m) => { const h = holderOpen(m); return h !== null && m.open!.live && !m.stopRecords.has(h) && m.scanned.get(h) === m.open!.pairIdx; },
    (m, x) => phoneCall(m, x, m.open!.holder!, null, { ended: true })),
  /** A8: before the first frame, a Stop sends nothing and is kept. m-c: with no such session, `who`'s restart makes one. */
  localStop: (who: P = "A") => new Cmd(`localStop(${who})`, "localStop",
    (m) => stoppable(m) || canRestart(m), async (m, x) => {
      if (!stoppable(m)) await cmd.restart(who, false).run(m, x);
      if (stoppable(m)) await localStop(m, x);
    }),
  goLive: () => new Cmd("goLive", "goLive", () => true, async (m, x) => { await goLive(m, x); }),
  /** The organiser's Go live after an end (W23's restart), as an INTENT: stop what is open, make sure the active code has a
   *  present phone, Go live — and, `video`, let the phone's video arrive. Each part is its own checked step. */
  /** `fix`: the organiser clears what would refuse the restart first — buys a credit when it is not free and none is held
   *  (T14), picks a destination when the pick is archived (T36). Without it the start meets that gate, as predicted. */
  restart: (who: P, video: boolean, by: "organiser" | "operator" = "organiser", fix = true) => new Cmd(`restart(${who}${video ? ",video" : ""},${by}${fix ? "" : ",nofix"})`, "restart",
    (m) => m.finishedAt === null && !m.expired, async (m, x) => {
    if (m.open !== null) await orgStop(m, x);
    if (by === "operator") {
      // The phone's own start (T15): it must hold the active code's slot and carry no undelivered Stop.
      if (m.current !== who || m.stopRecords.has(who)) await phoneCall(m, x, who, "new");
    } else if (m.current === null) await phoneCall(m, x, who, "new");
    else {
      const cur = (await snapshot(x)).current!;
      if (x.r.now().getTime() - cur.last_beat_at.getTime() >= silentMs(cur.answered_poll_seconds)) await phoneCall(m, x, m.current, null);
    }
    const blocked = m.archived.has(m.pick) || (m.balance < 1 && !restartOf(m, m.now()).free);
    if (blocked && !fix) {
      if (by === "operator") await operatorStart(m, x, who);
      else await goLive(m, x);
      expect(m.open, "restart: a start the gates refuse opens nothing").toBeNull();
      return;
    }
    if (m.archived.has(m.pick)) await repick(m, x);
    if (m.balance < 1 && !restartOf(m, m.now()).free) await buyCredit(m, x, 1);
    if (by === "operator") {
      await operatorStart(m, x, who);
      expect(m.open?.startedBy, "restart: the current phone's own start is admitted").toBe("operator");
    } else {
      expect(await goLive(m, x), "restart: a present phone, nothing open — Go live is admitted").toBe("200");
    }
    if (video) await ingestConnect(m, x);
  }),
  operatorStart: (sel: Sel) => new Cmd(`operatorStart(${sel})`, "operatorStart",
    (m) => { const p = pick(m, sel); return p !== null && m.scanned.has(p) && !m.stopRecords.has(p); }, (m, x) => operatorStart(m, x, pick(m, sel)!)),
  ingestConnect: () => new Cmd("ingestConnect", "ingestConnect", (m) => m.open !== null, ingestConnect),
  ingestDrop: () => new Cmd("ingestDrop", "ingestDrop", (m) => m.open !== null, ingestDrop),
  advance: (ms: number) => new Cmd(`advance(${ms / SEC}s)`, "advance", () => true, (m, x) => advance(m, x, ms)),
  /** §11.1.4's `silence`, as an INTENT: the phone and its video both go away (the input drops), the clock runs on — 2 min
   *  (past ask 10's silence and A14's 60 s, inside W19's 15) or 16 min (past W19 and the warming timeout) — and the
   *  stream-tick job runs. Three checked steps; which end, if any, is owed is #10's to prove. */
  gone: (ms: number) => new Cmd(`gone(${ms / SEC}s)`, "gone", (m) => m.open !== null, async (m, x) => {
    await ingestDrop(m, x);
    await advance(m, x, ms);
    await cronTick(m, x);
  }),
  tick: () => new Cmd("tick", "tick", (m) => m.open !== null, tick),
  cronTick: () => new Cmd("cronTick", "cronTick", () => true, cronTick),
  orgStop: () => new Cmd("orgStop", "orgStop", (m) => m.open !== null, orgStop),
  reissue: () => new Cmd("reissue", "reissue", () => true, reissue),
  /** M-3 as an INTENT, `gone`'s twin: Cloudflare's read blips to `unknown` and — `ms` — the clock runs on past W19's
   *  window and the stream-tick job runs. On a live session W19 must NOT fire on that read (m-3); #10 proves it. */
  ingestUnknown: (ms: number) => new Cmd(`ingestUnknown(${ms / SEC}s)`, "ingestUnknown", (m) => m.open !== null, async (m, x) => {
    await ingestUnknown(m, x);
    if (ms === 0) return;
    await advance(m, x, ms);
    await cronTick(m, x);
  }),
  /** I-2: the result is recorded — and, `beat`, the clock runs past C2's grace and the slot's phone beats; or, `goLive`
   *  (m-b), the stream is stopped, the phone beats just INSIDE the grace (still served) and the organiser presses Go live
   *  just past it, before anything wrote the expiry. An INTENT of checked steps; each answer is its step's prediction. */
  finish: (then: "none" | "beat" | "goLive") => new Cmd(`finish(${then})`, "finish", (m) => m.finishedAt === null, async (m, x) => {
    await finish(m, x);
    if (then === "none") return;
    if (then === "beat") {
      await advance(m, x, GRACE_MS + MIN);
      // The slot's phone then beats: T34 when a session is still open (expiry deferred), T33 when none is (401).
      const p = m.open?.holder ?? m.current;
      if (p !== null && m.scanned.has(p)) await phoneCall(m, x, p, null);
      return;
    }
    if (m.open !== null) await orgStop(m, x);
    await advance(m, x, GRACE_MS - 15 * SEC);
    const p = m.current;
    if (p !== null && m.scanned.has(p)) await phoneCall(m, x, p, null);
    await advance(m, x, 30 * SEC);
    await goLive(m, x);
  }),
  revertResult: () => new Cmd("revertResult", "revertResult", (m) => m.finishedAt !== null, revertResult),
  archiveDestination: () => new Cmd("archiveDestination", "archiveDestination", (m) => !m.archived.has(m.pick), archiveDestination),
  repick: () => new Cmd("repick", "repick", (m) => m.archived.has(m.pick), repick),
  buyCredit: (delta: number) => new Cmd(`buyCredit(${delta})`, "buyCredit", () => true, (m, x) => buyCredit(m, x, delta)),
  /** T28 as an INTENT (§6.7.4 × §5.2): a free restart admitted just inside the reuse window, its video arriving just after
   *  the window closed. At the live it is no longer free: it pays — or, with nothing held, fails no_credits. Each part is
   *  its own checked step; ingestConnect predicts which. */
  /** m-c (B7 re-review): `broke` is drawn only at an empty balance, where the live MUST fail no_credits — that leg was the
   *  rarer one, reached only when a free-form draw happened to find the balance spent. */
  windowEdge: (broke: boolean) => new Cmd(`windowEdge${broke ? "(broke)" : ""}`, "windowEdge",
    (m) => (!broke || m.balance < 1) && m.finishedAt === null && !m.expired && restartOf(m, m.now()).free && m.now() < m.w23.anchorAt! + REUSE_MS - EDGE_MS,
    async (m, x) => {
      if (m.open !== null) await orgStop(m, x);
      if (m.archived.has(m.pick)) await repick(m, x);
      await advance(m, x, m.w23.anchorAt! + REUSE_MS - EDGE_MS / 2 - m.now());
      if (m.current === null) await phoneCall(m, x, "A", "new");
      else await phoneCall(m, x, m.current, null);
      expect(await goLive(m, x), "windowEdge: a present phone and a free restart — Go live is admitted").toBe("200");
      await advance(m, x, EDGE_MS);
      await ingestConnect(m, x);
    }),
  /** I-2 as an INTENT: the organiser revokes the QR under a running session (unless already reissued since its phone
   *  paired) and the session's phone scans the new one. */
  rescan: () => new Cmd("rescan", "rescan", (m) => holderOpen(m) !== null && !m.stopRecords.has(m.open!.holder!) && m.finishedAt === null && !m.expired, async (m, x) => {
    const h = m.open!.holder!;
    if (m.open!.pairIdx === m.codes - 1) await reissue(m, x);
    const before = x.tally.outcomes.get("claimNew:T1-rescan")!;
    await phoneCall(m, x, h, "new");
    // The claim names the sid, so it also TICKS the session (§6.11): an end that was already owed (the warming timeout
    // after a long silence) is written right after the re-seat. The re-seat itself was predicted and checked either way.
    expect(x.tally.outcomes.get("claimNew:T1-rescan"), "rescan: the session's phone is re-seated on the new code (I-2)").toBe(before + 1);
    if (m.open !== null) expect([m.open.holder, m.open.pairIdx], "rescan: the open session follows its phone").toEqual([h, m.codes - 1]);
    x.tally.outcome("rescan:I-2");
  }),
  /** §11.1.4's race as an INTENT (T24a): the phone that stopped before its first frame still holds the slot; the OTHER
   *  phone claims it first (T2 — not live), and only then does the stopped phone's next beat carry its record. Two
   *  checked steps; what each answers is phoneCall's prediction, never this command's. */
  lateStopRace: (who: P = "A") => new Cmd(`lateStopRace(${who})`, "lateStopRace",
    (m) => preFrame(m) || canRestart(m),
    async (m, x) => {
      if (!(await openPreFrame(m, x, who))) return;
      const h = m.open!.holder!;
      if (!m.stopRecords.has(h)) await localStop(m, x);
      await phoneCall(m, x, other(h), "new");
      if (m.scanned.has(h)) await phoneCall(m, x, h, null);
    }),
  /** T23 as an INTENT, the race's positive pair: the phone that stopped before its first frame is still the slot's
   *  phone when its record arrives — so its Stop applies. */
  lateStopOwn: (who: P = "A") => new Cmd(`lateStopOwn(${who})`, "lateStopOwn",
    (m) => preFrame(m) || canRestart(m),
    async (m, x) => {
      if (!(await openPreFrame(m, x, who))) return;
      const h = m.open!.holder!;
      if (!m.stopRecords.has(h)) await localStop(m, x);
      await phoneCall(m, x, h, null);
    }),
  /** C1/C1b/C3 as an INTENT: a phone that has not rescanned since a reissue calls through the code it last scanned —
   *  reissuing first when no phone is on an old code. The open session's phone is served a beat and a GET there (C1b)
   *  and refused a start (C3); any other phone is refused 401 and forgets the code. */
  oldCodeCall: (kind: "beat" | "get" | "start" | "resume") => new Cmd(`oldCodeCall(${kind})`, "oldCodeCall",
    (m) => m.scanned.size > 0,
    async (m, x) => {
      const onOld = () => PHONES.filter((p) => m.scanned.has(p) && m.scanned.get(p)! < m.codes - 1);
      if (onOld().length === 0) await reissue(m, x);
      const ps = onOld();
      if (ps.length === 0) return;
      const p = ps.find((q) => q !== m.open?.holder) ?? ps[0]!;
      if (kind === "start") { if (!m.stopRecords.has(p)) await operatorStart(m, x, p); }
      else if (kind === "get") await get(m, x, p);
      else await phoneCall(m, x, p, kind === "resume" ? "resume" : null);
    }),
  /** A14 / T4 as an INTENT: a LIVE broadcast's phone and video go quiet for 2 min (past DEAD_PHONE_TAKEOVER_SECONDS,
   *  inside W19's 15), and the other phone claims. Three checked steps; T4's answer is phoneCall's prediction. */
  deadTakeover: (who: P) => new Cmd(`deadTakeover(${who})`, "deadTakeover",
    (m) => liveHeld(m) || canRestart(m),
    async (m, x) => {
      // m-c (B7 re-review): with no live broadcast, `who`'s restart with video makes one first (each part checked).
      if (!liveHeld(m) && canRestart(m)) await cmd.restart(who, true).run(m, x);
      if (!liveHeld(m)) return;
      const h = m.open!.holder!;
      await ingestDrop(m, x);
      await advance(m, x, 2 * MIN);
      await phoneCall(m, x, other(h), "new");
    }),
  /** m-c (B7 re-review): a warming silence as an INTENT — the organiser's restart with no video, then the phone and its
   *  video go away before any video arrived: `gone(2 min)` (past ask 10's silence for every cadence, inside the warming
   *  timeout) or `gone(16 min)` (past both; the tick expires first). Which end is owed is #10's to prove. */
  warmingLost: (who: P, ms: number) => new Cmd(`warmingLost(${who},${ms / SEC}s)`, "warmingLost", canRestart, async (m, x) => {
    await cmd.restart(who, false).run(m, x);
    if (m.open !== null && !m.open.live) await cmd.gone(ms).run(m, x);
  }),
  /** m-c: the stale late stop as an INTENT — the phone that stopped before its first frame keeps its record, the organiser
   *  stops the session first, and only then does the phone's next beat carry the record, naming a session no longer open. */
  staleStop: (who: P = "A") => new Cmd(`staleStop(${who})`, "staleStop",
    (m) => preFrame(m) || canRestart(m),
    async (m, x) => {
      if (!(await openPreFrame(m, x, who))) return;
      const h = m.open!.holder!;
      if (!m.stopRecords.has(h)) await localStop(m, x);
      await orgStop(m, x);
      if (m.scanned.has(h)) await phoneCall(m, x, h, null);
    }),
  /** m-c: T36 as an INTENT — the organiser archives the picked destination once nothing holds it, and a restart meets
   *  T36's gate without clearing it: the phone's own start answers no_destination, the Go live 404. */
  archivedRestart: (who: P, by: "organiser" | "operator") => new Cmd(`archivedRestart(${who},${by})`, "archivedRestart",
    (m) => m.finishedAt === null && !m.expired, async (m, x) => {
      if (m.open !== null) await orgStop(m, x);
      if (!m.archived.has(m.pick)) await archiveDestination(m, x);
      await cmd.restart(who, false, by, false).run(m, x);
    }),
  /** m-c: T14 as an INTENT — with nothing held and no free restart, the phone's own start meets the balance gate without
   *  a credit bought first: 402 no_credit. Drawn only in that state; the restart's own prediction checks the answer. */
  noCreditStart: (who: P) => new Cmd(`noCreditStart(${who})`, "noCreditStart",
    (m) => canRestart(m) && m.balance < 1 && !restartOf(m, m.now()).free && !m.archived.has(m.pick),
    (m, x) => cmd.restart(who, false, "operator", false).run(m, x)),
};

const sel = fc.constantFrom<Sel>("A", "B", "holder", "other");
const phone = fc.constantFrom<P>("A", "B");
/** A phone that lost the answer to its stop re-sends it: rarely. */
const resend = fc.oneof({ arbitrary: fc.constant(false), weight: 4 }, { arbitrary: fc.constant(true), weight: 1 });
/** Who starts a restart: mostly the organiser's Go live, sometimes the phone's own start (T15). */
const starter = fc.oneof({ arbitrary: fc.constant("organiser" as const), weight: 2 }, { arbitrary: fc.constant("operator" as const), weight: 1 });
/** A blocked restart is cleared first — mostly; otherwise the start meets T14's or T36's gate. */
const fix = fc.oneof({ arbitrary: fc.constant(true), weight: 2 }, { arbitrary: fc.constant(false), weight: 1 });
/** The clock's steps: inside the silences (5 s, 35 s), past ask 10 and A14 (2 min), past W19 and the warming timeout
 *  (16 min), past C2's grace (2 h + 1 min), and past the reuse window (25 h, M-1). */
const step$ = fc.oneof(
  { arbitrary: fc.constantFrom(5 * SEC, 35 * SEC, 2 * MIN, 16 * MIN), weight: 8 },
  { arbitrary: fc.constant(GRACE_MS + MIN), weight: 1 },
  { arbitrary: fc.constant(REUSE_MS + 60 * MIN), weight: 1 },
);
/** Weighted by repetition (fc.commands draws its arbitraries uniformly). */
const ALL: fc.Arbitrary<Cmd>[] = [
  ...Array.from({ length: 3 }, () => fc.tuple(sel, resend).map(([s, r]) => cmd.claimNew(s, r))),
  ...Array.from({ length: 2 }, () => fc.tuple(sel, resend).map(([s, r]) => cmd.claimResume(s, r))),
  ...Array.from({ length: 3 }, () => sel.map(cmd.beat)),
  ...Array.from({ length: 2 }, () => sel.map(cmd.get)),
  fc.constant(null).map(cmd.phoneStop),
  ...Array.from({ length: 3 }, () => phone.map(cmd.localStop)),
  ...Array.from({ length: 2 }, () => fc.constant(null).map(cmd.goLive)),
  ...Array.from({ length: 3 }, () => fc.tuple(
    phone, fc.oneof({ arbitrary: fc.constant(true), weight: 2 }, { arbitrary: fc.constant(false), weight: 1 }),
    starter,
    fix,
  ).map(([p, v, by, f]) => cmd.restart(p, v, by, f))),
  ...Array.from({ length: 2 }, () => sel.map(cmd.operatorStart)),
  fc.constant(null).map(cmd.ingestConnect),
  ...Array.from({ length: 2 }, () => fc.constant(null).map(cmd.ingestDrop)),
  ...Array.from({ length: 3 }, () => step$.map(cmd.advance)),
  ...Array.from({ length: 3 }, () => fc.constantFrom(2 * MIN, 16 * MIN).map(cmd.gone)),
  ...Array.from({ length: 2 }, () => fc.constant(null).map(cmd.tick)),
  fc.constant(null).map(cmd.cronTick),
  fc.constant(null).map(cmd.orgStop),
  fc.constant(null).map(cmd.reissue),
  fc.constant(null).map(cmd.rescan),
  ...Array.from({ length: 2 }, () => phone.map(cmd.lateStopRace)),
  phone.map(cmd.lateStopOwn),
  ...Array.from({ length: 3 }, () => fc.constantFrom<"beat" | "get" | "start" | "resume">("beat", "get", "start", "resume").map(cmd.oldCodeCall)),
  phone.map(cmd.deadTakeover),
  // I-2 and M-3.
  fc.constantFrom<"none" | "beat" | "goLive">("none", "beat", "beat", "goLive").map(cmd.finish),
  ...Array.from({ length: 2 }, () => fc.constant(null).map(cmd.revertResult)),
  fc.constant(null).map(cmd.archiveDestination),
  ...Array.from({ length: 2 }, () => fc.constant(null).map(cmd.repick)),   // m-c: diluted by the intents below
  fc.constantFrom(1, 2).map(cmd.buyCredit),
  ...Array.from({ length: 2 }, () => fc.constant(false).map(cmd.windowEdge)),
  ...Array.from({ length: 2 }, () => fc.constant(true).map(cmd.windowEdge)),
  ...Array.from({ length: 2 }, () => fc.constantFrom(0, 16 * MIN).map(cmd.ingestUnknown)),
  // m-c (B7 re-review): the rare outcomes' own intents, so a fresh seed reaches each well clear of zero.
  ...Array.from({ length: 2 }, () => fc.tuple(phone, fc.constantFrom(2 * MIN, 16 * MIN)).map(([p, ms]) => cmd.warmingLost(p, ms))),
  phone.map(cmd.staleStop),
  fc.tuple(phone, starter).map(([p, by]) => cmd.archivedRestart(p, by)),
  ...Array.from({ length: 2 }, () => phone.map(cmd.noCreditStart)),
];
/** W23 needs FIVE sessions with video in one run for a paid restart, which a free-form run reaches only sometimes (the
 *  T6b review's m-1): one run in three draws from this mix, the same commands with restarts-with-video weighted up. */
const RESTART_HEAVY: fc.Arbitrary<Cmd>[] = [...ALL, ...Array.from({ length: 10 }, () => fc.tuple(phone, starter, fix).map(([p, b, f]) => cmd.restart(p, true, b, f)))];
const COMMANDS = fc.oneof(
  { arbitrary: fc.commands(ALL, { maxCommands: MAX_COMMANDS, size: "max" }), weight: 2 },
  { arbitrary: fc.commands(RESTART_HEAVY, { maxCommands: MAX_COMMANDS, size: "max" }), weight: 1 },
);

/** One run's world. The rig's org has no subscription row, so it resolves to COMMUNITY (`_rig.ts` seedOrg's convention):
 *  the smallest monthly allowance (V426), so a ≤ 50-command run can spend down to nothing (I-2: 40 bought credits were
 *  never exhausted). `pack` bought credits (drawn 0–2) sit on top of the month's allowance, which is granted here — the
 *  grant every Go live ensures, made once up front so the model starts from a known balance. The allowance is the
 *  catalogue's declaration (`streamMonthlyRate`), never a number typed here; the guard below holds it small. */
async function freshReal(tally: Tally, pack: number): Promise<{ model: Model; real: Real }> {
  const r = await captureRig({ credits: pack, connectAfterMs: NEVER_MS });
  await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
  const allowance = await streamMonthlyRate(r.auth.orgId);
  expect(allowance, "community's monthly allowance is small enough to spend down in a run").toBeLessThanOrEqual(2);
  await ensureMonthlyStreamGrant(r.auth.orgId);
  const real: Real = {
    r, phones: { A: phoneId("a"), B: phoneId("b") }, codes: [{ code: r.code, tok: r.tok }],
    scripted: new Map(), everConnected: new Set(), tally, targets: [r.target.id], priorStatus: null,
  };
  const model: Model = {
    current: null, open: null, stopRecords: new Map(), delivered: new Map(), scanned: new Map(), codes: 1, sessions: [],
    w23: { anchorAt: null, counted: 0, paid: 0 }, balance: allowance + pack, finishedAt: null, expired: false,
    pick: 0, archived: new Set(), now: () => r.now().getTime(),
  };
  expect(await creditBalance(sql, r.auth.orgId), "the run starts from the allowance plus the pack").toBe(model.balance);
  return { model, real };
}

describe.skipIf(!HAS_DB)("capture model (§11.1.4, rule 10): two phones, the real use-cases, twelve invariants after every step", () => {
  it("capture model: twelve invariants hold over every generated sequence; every action, outcome and counter is reached by DRAWN runs", async () => {
    const tally = new Tally();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 }), COMMANDS, async (pack, cmds) => {
        tally.runs++;
        const setup = await freshReal(tally, pack);
        await fc.asyncModelRun(() => setup, cmds);
      }),
      // CAPTURE_MODEL_SHRINK=0 reports the first failing sequence unshrunk (a mutation sweep needs the kill, not the
      // minimal case); by default a failure is shrunk, as seed 55's was.
      { numRuns: RUNS, seed: SEED, verbose: 1, endOnFailure: process.env.CAPTURE_MODEL_SHRINK === "0" },
    );
    const report = tally.report();
    appendFileSync(REPORT, report);
    const zeroCounts = COUNT_KEYS.filter((k) => tally.counts[k] === 0);
    const zeroActions = ACTIONS.filter((a) => tally.actions.get(a) === 0);
    const zeroOutcomes = OUTCOMES.filter((o) => tally.outcomes.get(o) === 0);
    expect(zeroCounts, `counters no drawn run reached — ${report}`).toEqual([]);
    expect(zeroActions, `actions no drawn run took — ${report}`).toEqual([]);
    expect(zeroOutcomes, `outcomes no drawn run reached — ${report}`).toEqual([]);
    expect(tally.runs).toBe(RUNS);
    expect(tally.invariantChecks).toBe(tally.steps);
    expect(tally.steps).toBeGreaterThan(RUNS);
  }, RUNS * MAX_COMMANDS * STEP_BUDGET_MS);

  it("pinned: A's late stop must not end B's live broadcast — A's `new` with stopped: X is taken and A's `resume` with it replaced, X live under B both times", async () => {
    const tally = new Tally();
    const setup = await freshReal(tally, 2);
    const { model: m, real: x } = setup;
    await fc.asyncModelRun(() => setup, [
      cmd.claimNew("A"), cmd.goLive(), cmd.localStop(), cmd.claimNew("B"), cmd.ingestConnect(),
      cmd.claimNew("A"), cmd.claimResume("A", true),
    ]);
    expect([tally.outcomes.get("claimNew:T2-takeover"), tally.outcomes.get("video:first-paid"), tally.outcomes.get("claimNew:T3-taken"), tally.outcomes.get("claimResume:T6-replaced")]).toEqual([1, 1, 1, 1]);
    expect([tally.counts.lateStopsDelivered, tally.counts.lateStopsIgnoredHeld], "both answers count as delivered; both ignored as held").toEqual([2, 2]);
    const [x0] = await sql<{ state: string; end_reason: string | null }[]>`select state, end_reason from fixture_stream_sessions where id = ${m.sessions[0]!.sid}`;
    expect(x0, "X is still live, under B").toEqual({ state: "live", end_reason: null });
    expect(m.open?.holder).toBe("B");
    expect(x.tally.invariantChecks).toBe(7);
  });

  it("regression (seed 55, shrunk): a rescan whose claim names the sid re-seats the phone AND ticks the session — the warming timeout owed after 16 silent minutes is written then", async () => {
    const tally = new Tally();
    const setup = await freshReal(tally, 2);
    await fc.asyncModelRun(() => setup, [cmd.restart("A", false), cmd.advance(16 * MIN), cmd.rescan()]);
    expect([tally.outcomes.get("claimNew:T1-rescan"), tally.outcomes.get("end:no_inbound_timeout")]).toEqual([1, 1]);
    expect(setup.model.open).toBeNull();
  });

  it("pinned, its positive pair: with no B, A re-pairs carrying stopped: X and X ends operator_stopped", async () => {
    const tally = new Tally();
    const setup = await freshReal(tally, 2);
    const { model: m } = setup;
    await fc.asyncModelRun(() => setup, [cmd.claimNew("A"), cmd.goLive(), cmd.localStop(), cmd.claimNew("A")]);
    expect([tally.outcomes.get("claimNew:T1-accept"), tally.outcomes.get("lateStop:applied-current"), tally.counts.lateStopsDelivered]).toEqual([2, 1, 1]);
    const [x0] = await sql<{ state: string; end_reason: string | null }[]>`select state, end_reason from fixture_stream_sessions where id = ${m.sessions[0]!.sid}`;
    expect(x0).toEqual({ state: "completed", end_reason: "operator_stopped" });
    expect(m.open).toBeNull();
    expect(tally.invariantChecks).toBe(4);
  });
});
