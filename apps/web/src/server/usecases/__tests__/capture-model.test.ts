// Capture QR v2 §11.1.4 (T10) — the capture surface as a MODEL (TEST-STRATEGY rule 10), with fast-check's `fc.commands`.
// Two phones (A and B), one fixture per run, the REAL use-cases (postBeat, postStart, getCode, createSession,
// stopSession, tickSession, tickOpenSessions, reissueStreamCode, ensureStreamCode via the rig) on the FAKE drivers and an
// injected clock. The fake ingest never connects on its own (connectAfterMs is a day): video arrives only when the model
// says so, through FakeIngest.setState (A26, FP8).
//
// The model is the brief's — { current, open: {sid, live, holder}, stopRecords } — plus what the phones themselves know
// (the code each last scanned, the stop each last delivered) and W23's counter. Each command predicts its answer FROM THE
// SPEC (§5.5's T1–T8 rows, C1/C1b/C3, T12/T13/T15, T20/T21, T23/T24/T24a, W5, W23), runs the real call, compares, and
// moves the model. A session the TICK ends (ask 10, W19, the warming timeout, max duration) is the one thing the model
// does not predict step by step — it cannot, without re-implementing the clocks under test — so such an end is accepted
// only when invariant 10 (and its siblings) proves it was owed at that instant.
//
// After EVERY primitive step the eleven invariants are checked against the database (§11.1.4's ten; #11 is W23's):
//   1. at most one current pairing per code and slot;          2. at most one open session per fixture;
//   3. `cred` is served only to the open session's phone;      4. a live slot changes phone only through T4, its
//      conjunction true;                                        5. no stop closes a sid other than the one named;
//   6. a code never answers 401 to its open session's phone;   7. at most one consume per session, and only with video;
//   8. go-live ⇒ no ingest yet, live ⇒ ingest;                 9. a stop from a phone that is not current never ends a
//      sid the current phone holds (T24a);                     10. phone_lost only when owed (T25a / ask 10);
//   11. the fixture's consume rows equal W23's count from the rule text (T6b's rule).
// #7 as the spec words it ("at most one consume per fixture per 24 h") is superseded by W23 — a 4th restart inside the
// window pays — so #7 is checked per session here and the per-window rule is #11.
//
// Anti-vacuity: every action and every outcome is counted over the DRAWN runs (there are no examples in the property),
// and a zero fails. The ten counters the brief names, plus paidRestarts, must each be > 0. The seed comes from
// CAPTURE_MODEL_SEED (default fixed) and is written, with the tally, to CAPTURE_MODEL_REPORT (default: the OS tmpdir).
//
// ONE SPORT, on purpose (rule 6): nothing on this surface reads the sport (capture-start.test.ts pins the cricket row).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import fc from "fast-check";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureBeatAnswer, CaptureStartOk } from "@/server/api-v1/capture-schemas";
import {
  DEAD_PHONE_TAKEOVER_SECONDS, FREE_RESTARTS_PER_WINDOW, PHONE_LOST_LIVE_MINUTES, PHONE_SILENT_FLOOR_SECONDS,
  PHONE_SILENT_SLACK_SECONDS, WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { OPEN_SESSION_MAX_POLL_SECONDS } from "@/server/relay/domain/poll-seconds";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { getCode, postBeat, postStart } from "../capture-phone";
import { reissueStreamCode, saveStreamSettings } from "../stream-codes";
import { createSession, stopSession, tickOpenSessions, tickSession } from "../stream-sessions";
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
/** The fake never connects on its own: only `ingestConnect` (FakeIngest.setState) brings video. */
const NEVER_MS = 24 * 60 * MIN;
const ACTIVE = ACTIVE_STATES as readonly string[];
/** §6.8.5 / §6.5: the spec's two windows, from its constants. */
const LOST_MS = PHONE_LOST_LIVE_MINUTES * MIN;
const DEAD_MS = DEAD_PHONE_TAKEOVER_SECONDS * SEC;
/** §6.9: silent at max(floor, cadence + slack). */
const silentMs = (cadenceSeconds: number) => Math.max(PHONE_SILENT_FLOOR_SECONDS, cadenceSeconds + PHONE_SILENT_SLACK_SECONDS) * SEC;
/** A fresh poll read needs the claim window AND the coalesced sample's age bound behind it (B0: 2 × STREAM_POLL_MS). */
const FRESH_READ_MS = 2 * STREAM_POLL_MS;

type P = "A" | "B";
const PHONES: readonly P[] = ["A", "B"];
const other = (p: P): P => (p === "A" ? "B" : "A");

/** The brief's model, plus what each phone knows. */
type Model = {
  /** The phone holding the ACTIVE code's current pairing (slot 0). */
  current: P | null;
  /** The fixture's open session: its sid, whether it has video (first ingest), the phone holding it (its pairing's,
   *  while that pairing stands), the code index that pairing is on, and the code index active when it was created. */
  open: { sid: string; live: boolean; holder: P | null; pairIdx: number; bornIdx: number; startedBy: "organiser" | "operator" } | null;
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
   *  fourth pays and re-anchors. */
  w23: { anchored: boolean; counted: number; paid: number };
};

const COUNT_KEYS = [
  "takeovers", "lateStopsDelivered", "lateStopsIgnoredHeld", "credsServed", "phoneLostLive", "phoneLostWarming",
  "consumes", "refusedClaims", "oneCurrent", "oneOpen", "paidRestarts",
] as const;
type CountKey = (typeof COUNT_KEYS)[number];
const ACTIONS = [
  "claimNew", "claimResume", "beat", "get", "phoneStop", "localStop", "goLive", "restart", "operatorStart",
  "ingestConnect", "ingestDrop", "advance", "gone", "tick", "cronTick", "orgStop", "reissue", "rescan", "lateStopRace",
  "lateStopOwn", "deadTakeover", "oldCodeCall",
] as const;
type Action = (typeof ACTIONS)[number];
/** Every outcome the model can name. Each must be reached by the drawn runs. */
const OUTCOMES = [
  "claimNew:T1-accept", "claimNew:T1-rescan", "claimNew:T2-takeover", "claimNew:T3-taken", "claimNew:T4-takeover",
  "claimResume:T5-accept", "claimResume:T6-replaced", "claimResume:401",
  "beat:T8", "beat:T7-replaced", "beat:401", "beat:c1b-served",
  "lateStop:applied-current", "lateStop:ignored-held", "lateStop:stale",
  "get:cred", "get:no-cred", "get:401",
  "phoneStop:T21", "goLive:200", "goLive:phone_not_paired", "goLive:refused-open",
  "start:200", "start:already_live", "start:replaced", "start:401",
  "video:first-paid", "video:free-restart", "video:paid-restart",
  "end:phone_lost-live", "end:phone_lost-warming", "end:no_inbound_timeout", "orgStop:stopped", "rescan:I-2",
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
  scripted: Map<string, "connected" | "disconnected">;
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
           (select count(*)::int from org_stream_credits c where c.org_id = s.org_id and c.session_id = s.id and c.reason = 'consume') as consumes
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
  now: Date;
};

async function step(m: Model, x: Real, body: (info: StepInfo, pre: Snap) => Promise<void>): Promise<void> {
  const pre = await snapshot(x);
  const info: StepInfo = { named: new Set(), predictedEnds: new Map(), created: null, calls: [], claimNewBy: null, ignoredHeld: null, now: x.r.now() };
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
    expect([beatAge >= LOST_MS, videoAge >= LOST_MS, x.scripted.get(s.input_id ?? "") !== "connected"], `#10: ${s.id} ended phone_lost live with beat ${beatAge} ms, video ${videoAge} ms`).toEqual([true, true, true]);
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
      expect(s.end_reason, `the spec's end for ${s.id}`).toBe(predicted);
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
      x.scripted.get(was.input_id ?? "") !== "connected",
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

  // #9 (T24a): the held sid is not ended by the stop that named it.
  if (info.ignoredHeld !== null) {
    expect(post.sessions.find((s) => s.id === info.ignoredHeld)?.end_reason, "#9: a non-current phone's stop ended the current phone's broadcast").not.toBe("operator_stopped");
  }

  // #11 (W23): the consume rows are the rule text's count.
  const consumes = post.sessions.reduce((n, s) => n + s.consumes, 0);
  const consumedBefore = pre.sessions.reduce((n, s) => n + s.consumes, 0);
  if (consumes > consumedBefore) t.count("consumes");
  expect(consumes, "#11: the fixture's consume rows are W23's count").toBe(m.w23.paid);

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

/** C1/C1b/C3 (§6.3): whether code `idx` serves phone p a call of this kind. A claim and a start: the active code only. A
 *  beat or a GET: also an ended code, to the open session's phone, when the session was created before that code ended. */
function served(m: Model, p: P, idx: number, kind: CallKind): boolean {
  if (idx === m.codes - 1) return true;
  if (kind === "claimNew" || kind === "start") return false;
  return m.open !== null && m.open.holder === p && idx >= m.open.bornIdx;
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
    const isServed = served(m, p, viaIdx, callKind);
    if (kind === "new" && pre.current !== null && phoneOf(x, pre.current.phone) !== p) t.count("oneCurrent");
    const got = await outcomeOf(postBeat(c.code, c.tok, beatBody(x, c.code, x.phones[p], {
      claim: kind, sid, stopped: X, device: kind === "new" ? { model: `model-${p}` } : null,
      state: o.ended ? "ended" : sid !== null ? "connecting" : "paired", ...(o.ended ? { endReason: "operator-stopped" } : {}),
    }), x.r.deps, x.r.now()));
    info.calls.push({ phone: p, viaIdx, kind: callKind, status: statusOf(got), holderPre: holdsOpen, pairIdxPre: m.open?.pairIdx ?? null });
    if (!isServed) {
      forget(m, p, got, `C1/C3: ${name} through an ended code`);
      t.outcome(kind === "resume" ? "claimResume:401" : "beat:401");
      if (kind !== null) t.count("refusedClaims");
      return;
    }
    expect("ok" in got, `${name} is served: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
    const answer = CaptureBeatAnswer.parse((got as { ok: unknown }).ok);
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
    const deadPre = open !== null && preSession !== null && preSession.holder_beat_at !== null
      && x.r.now().getTime() - preSession.holder_beat_at.getTime() >= DEAD_MS
      && x.scripted.get(preSession.input_id ?? "") !== "connected"
      && x.r.now().getTime() - (preSession.last_connected_at ?? preSession.first_ingest_at ?? x.r.now()).getTime() >= DEAD_MS;

    type Row = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8";
    let row: Row;
    if (kind === "new") {
      if (H === null || H === p) row = "T1";
      else if (open?.live) row = answer.state === "taken" ? "T3" : "T4";
      else row = "T2";
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
    const isServed = served(m, p, idx, "get");
    const holdsOpen = m.open !== null && m.open.holder === p;
    const got = await outcomeOf(getCode(c.code, c.tok, { slot: 0, phone: x.phones[p] }, x.r.deps, x.r.now()));
    info.calls.push({ phone: p, viaIdx: idx, kind: "get", status: statusOf(got), holderPre: holdsOpen, pairIdxPre: m.open?.pairIdx ?? null });
    if (!isServed) { forget(m, p, got, "C1/C3: a GET through an ended code"); x.tally.outcome("get:401"); return; }
    expect("ok" in got, `GET is served: ${"refused" in got ? got.refused.code : ""}`).toBe(true);
    const d = (got as { ok: Record<string, unknown> }).ok;
    const state = m.open === null ? null : pre.sessions.find((s) => s.id === m.open!.sid)!.state;
    const owed = holdsOpen && (state === "warming" || state === "live" || state === "ending");
    expect("cred" in d, `#3: cred to ${p} (${owed ? "the open session's phone" : "not the open session's phone"})`).toBe(owed);
    if (owed) { x.tally.count("credsServed"); x.tally.outcome("get:cred"); } else x.tally.outcome("get:no-cred");
  });
}

/** W5 (§6.6): the organiser's Go live — admitted only on a PRESENT current phone of the active code. */
async function goLive(m: Model, x: Real): Promise<"200" | "refused"> {
  let result: "200" | "refused" = "refused";
  await step(m, x, async (info, pre) => {
    const t = x.tally;
    let refusal: string | null = null;
    let sid: string | null = null;
    try {
      sid = (await createSession(x.r.auth, x.r.fixtureId, { mode: "passthrough", targetId: x.r.target.id }, x.r.deps)).sessionId;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      refusal = e.code ?? `${e.status}`;
    }
    if (m.open !== null) {
      // Admission reconciles the open session first, so an end that was already owed (the lazy expiry) is written here
      // and the reconcile below proves it owed; a session still open refuses the Go live.
      const [still] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${m.open.sid}`;
      if (ACTIVE.includes(still!.state)) {
        expect(["active_session", "phone_not_paired"], "#2: Go live over an open session is refused").toContain(refusal);
        t.count("oneOpen");
        t.outcome("goLive:refused-open");
        return;
      }
      m.open = null;
    }
    const cur = pre.current;
    const present = cur !== null && x.r.now().getTime() - cur.last_beat_at.getTime() < silentMs(cur.answered_poll_seconds);
    if (!present) {
      expect(refusal, "W5: no present phone on the active code").toBe("phone_not_paired");
      t.outcome("goLive:phone_not_paired");
      return;
    }
    expect(refusal, "W5: a present phone is admitted").toBeNull();
    m.open = { sid: sid!, live: false, holder: m.current, pairIdx: m.codes - 1, bornIdx: m.codes - 1, startedBy: "organiser" };
    m.sessions.push({ sid: sid!, video: false });
    info.created = sid;
    result = "200";
    t.outcome("goLive:200");
  });
  return result;
}

/** T12 → T13 → T15 (§6.3.4): the phone's own start, through the code it last scanned. */
async function operatorStart(m: Model, x: Real, p: P): Promise<void> {
  await step(m, x, async (info) => {
    const t = x.tally;
    const idx = m.scanned.get(p)!;
    const c = x.codes[idx]!;
    const holdsOpen = m.open !== null && m.open.holder === p;
    const got = await outcomeOf(postStart(c.code, c.tok, { phone: x.phones[p] }, x.r.deps, x.r.now()));
    info.calls.push({ phone: p, viaIdx: idx, kind: "start", status: statusOf(got), holderPre: holdsOpen, pairIdxPre: m.open?.pairIdx ?? null });
    if (!served(m, p, idx, "start")) { forget(m, p, got, "C3: a start through an ended code"); t.outcome("start:401"); return; }
    const H = m.open?.holder ?? m.current;
    const refused = "refused" in got ? [got.refused.status, got.refused.code, got.refused.extras] : null;
    if (H !== p) {
      expect(refused, "T12: not the slot's phone").toEqual([409, "replaced", undefined]);
      t.outcome("start:replaced");
    } else if (m.open !== null) {
      expect(refused, "T13: names the running session and who started it").toEqual([409, "already_live", { sid: m.open.sid, startedBy: m.open.startedBy }]);
      t.count("oneOpen");
      t.outcome("start:already_live");
    } else {
      expect(refused, "T15").toBeNull();
      const ok = CaptureStartOk.parse((got as { ok: unknown }).ok);
      m.open = { sid: ok.sid, live: false, holder: p, pairIdx: idx, bornIdx: idx, startedBy: "operator" };
      m.sessions.push({ sid: ok.sid, video: false });
      info.created = ok.sid;
      t.outcome("start:200");
    }
  });
}

/** The phone's video reaches the ingest (FakeIngest.setState), and a fresh poll reads it: the session has video. */
async function ingestConnect(m: Model, x: Real): Promise<void> {
  await step(m, x, async (_info, pre) => {
    const sid = m.open!.sid;
    const input = pre.sessions.find((s) => s.id === sid)!.input_id!;
    x.r.ingest.setState(input, "connected");
    x.scripted.set(input, "connected");
    x.everConnected.add(input);
    x.r.tick(FRESH_READ_MS);
    await tickSession(sid, x.r.deps, "poll");
    const [row] = await sql<{ state: string; first_ingest_at: Date | null }[]>`select state, first_ingest_at from fixture_stream_sessions where id = ${sid}`;
    if (!ACTIVE.includes(row!.state)) return;   // the tick's expiry came first: the reconcile proves it owed
    expect(row!.first_ingest_at, "a fresh connected read records first ingest").not.toBeNull();
    const s = m.sessions.find((v) => v.sid === sid)!;
    m.open!.live = true;
    if (s.video) return;
    s.video = true;
    // W23 from the rule text: the first live pays and anchors; three counted restarts are free; the fourth pays.
    const w = m.w23;
    if (!w.anchored) { w.anchored = true; w.paid++; w.counted = 0; x.tally.outcome("video:first-paid"); }
    else if (w.counted >= FREE_RESTARTS_PER_WINDOW) { w.paid++; w.counted = 0; x.tally.count("paidRestarts"); x.tally.outcome("video:paid-restart"); }
    else { w.counted++; x.tally.outcome("video:free-restart"); }
  });
}

async function ingestDrop(m: Model, x: Real): Promise<void> {
  await step(m, x, async (_info, pre) => {
    const input = pre.sessions.find((s) => s.id === m.open!.sid)!.input_id!;
    x.r.ingest.setState(input, "disconnected");
    x.scripted.set(input, "disconnected");
  });
}

const advance = (m: Model, x: Real, ms: number) => step(m, x, async () => { x.r.tick(ms); });
const tick = (m: Model, x: Real) => step(m, x, async () => { await tickSession(m.open!.sid, x.r.deps, "poll"); });
const cronTick = (m: Model, x: Real) => step(m, x, async () => { await tickOpenSessions(x.r.deps, { orgIds: [x.r.auth.orgId] }); });

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

/** T30/C-2: a new code; the old one ends; no pairing moves, and the open session keeps its phone. */
async function reissue(m: Model, x: Real): Promise<void> {
  await step(m, x, async () => {
    const shown = await reissueStreamCode(x.r.auth, x.r.fixtureId);
    x.codes.push({ code: shown.qr.code, tok: shown.qr.tok });
    m.codes++;
    m.current = null;
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
  /** A8: before the first frame, a Stop sends nothing and is kept. */
  localStop: () => new Cmd("localStop", "localStop",
    (m) => { const h = holderOpen(m); return h !== null && !m.open!.live && !m.stopRecords.has(h); }, localStop),
  goLive: () => new Cmd("goLive", "goLive", () => true, async (m, x) => { await goLive(m, x); }),
  /** The organiser's Go live after an end (W23's restart), as an INTENT: stop what is open, make sure the active code has a
   *  present phone, Go live — and, `video`, let the phone's video arrive. Each part is its own checked step. */
  restart: (who: P, video: boolean, by: "organiser" | "operator" = "organiser") => new Cmd(`restart(${who}${video ? ",video" : ""},${by})`, "restart", () => true, async (m, x) => {
    if (m.open !== null) await orgStop(m, x);
    if (by === "operator") {
      // The phone's own start (T15): it must hold the active code's slot and carry no undelivered Stop.
      if (m.current !== who || m.stopRecords.has(who)) await phoneCall(m, x, who, "new");
      await operatorStart(m, x, who);
      expect(m.open?.startedBy, "restart: the current phone's own start is admitted").toBe("operator");
    } else {
      if (m.current === null) await phoneCall(m, x, who, "new");
      else {
        const cur = (await snapshot(x)).current!;
        if (x.r.now().getTime() - cur.last_beat_at.getTime() >= silentMs(cur.answered_poll_seconds)) await phoneCall(m, x, m.current, null);
      }
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
  /** I-2 as an INTENT: the organiser revokes the QR under a running session (unless already reissued since its phone
   *  paired) and the session's phone scans the new one. */
  rescan: () => new Cmd("rescan", "rescan", (m) => holderOpen(m) !== null && !m.stopRecords.has(m.open!.holder!), async (m, x) => {
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
  lateStopRace: () => new Cmd("lateStopRace", "lateStopRace",
    (m) => {
      const h = holderOpen(m);
      return h !== null && !m.open!.live && m.scanned.has(h) && (!m.stopRecords.has(h) || m.stopRecords.get(h) === m.open!.sid);
    },
    async (m, x) => {
      const h = m.open!.holder!;
      if (!m.stopRecords.has(h)) await localStop(m, x);
      await phoneCall(m, x, other(h), "new");
      if (m.scanned.has(h)) await phoneCall(m, x, h, null);
    }),
  /** T23 as an INTENT, the race's positive pair: the phone that stopped before its first frame is still the slot's
   *  phone when its record arrives — so its Stop applies. */
  lateStopOwn: () => new Cmd("lateStopOwn", "lateStopOwn",
    (m) => {
      const h = holderOpen(m);
      return h !== null && !m.open!.live && m.scanned.has(h) && (!m.stopRecords.has(h) || m.stopRecords.get(h) === m.open!.sid);
    },
    async (m, x) => {
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
  deadTakeover: () => new Cmd("deadTakeover", "deadTakeover",
    (m) => holderOpen(m) !== null && m.open!.live,
    async (m, x) => {
      const h = m.open!.holder!;
      await ingestDrop(m, x);
      await advance(m, x, 2 * MIN);
      await phoneCall(m, x, other(h), "new");
    }),
};

const sel = fc.constantFrom<Sel>("A", "B", "holder", "other");
const phone = fc.constantFrom<P>("A", "B");
/** A phone that lost the answer to its stop re-sends it: rarely. */
const resend = fc.oneof({ arbitrary: fc.constant(false), weight: 4 }, { arbitrary: fc.constant(true), weight: 1 });
/** Weighted by repetition (fc.commands draws its arbitraries uniformly). */
const ALL: fc.Arbitrary<Cmd>[] = [
  ...Array.from({ length: 3 }, () => fc.tuple(sel, resend).map(([s, r]) => cmd.claimNew(s, r))),
  ...Array.from({ length: 2 }, () => fc.tuple(sel, resend).map(([s, r]) => cmd.claimResume(s, r))),
  ...Array.from({ length: 3 }, () => sel.map(cmd.beat)),
  ...Array.from({ length: 2 }, () => sel.map(cmd.get)),
  fc.constant(null).map(cmd.phoneStop),
  ...Array.from({ length: 3 }, () => fc.constant(null).map(cmd.localStop)),
  ...Array.from({ length: 2 }, () => fc.constant(null).map(cmd.goLive)),
  ...Array.from({ length: 3 }, () => fc.tuple(
    phone, fc.oneof({ arbitrary: fc.constant(true), weight: 2 }, { arbitrary: fc.constant(false), weight: 1 }),
    fc.oneof({ arbitrary: fc.constant("organiser" as const), weight: 2 }, { arbitrary: fc.constant("operator" as const), weight: 1 }),
  ).map(([p, v, by]) => cmd.restart(p, v, by))),
  ...Array.from({ length: 2 }, () => sel.map(cmd.operatorStart)),
  fc.constant(null).map(cmd.ingestConnect),
  ...Array.from({ length: 2 }, () => fc.constant(null).map(cmd.ingestDrop)),
  ...Array.from({ length: 3 }, () => fc.constantFrom(5 * SEC, 35 * SEC, 2 * MIN, 16 * MIN).map(cmd.advance)),
  ...Array.from({ length: 3 }, () => fc.constantFrom(2 * MIN, 16 * MIN).map(cmd.gone)),
  ...Array.from({ length: 2 }, () => fc.constant(null).map(cmd.tick)),
  fc.constant(null).map(cmd.cronTick),
  fc.constant(null).map(cmd.orgStop),
  fc.constant(null).map(cmd.reissue),
  fc.constant(null).map(cmd.rescan),
  ...Array.from({ length: 2 }, () => fc.constant(null).map(cmd.lateStopRace)),
  fc.constant(null).map(cmd.lateStopOwn),
  ...Array.from({ length: 3 }, () => fc.constantFrom<"beat" | "get" | "start" | "resume">("beat", "get", "start", "resume").map(cmd.oldCodeCall)),
  fc.constant(null).map(cmd.deadTakeover),
];
/** W23 needs FIVE sessions with video in one run for a paid restart, which a free-form run reaches only sometimes (the
 *  T6b review's m-1): one run in three draws from this mix, the same commands with restarts-with-video weighted up. */
const RESTART_HEAVY: fc.Arbitrary<Cmd>[] = [...ALL, ...Array.from({ length: 10 }, () => phone.map((p) => cmd.restart(p, true)))];
const COMMANDS = fc.oneof(
  { arbitrary: fc.commands(ALL, { maxCommands: MAX_COMMANDS, size: "max" }), weight: 2 },
  { arbitrary: fc.commands(RESTART_HEAVY, { maxCommands: MAX_COMMANDS, size: "max" }), weight: 1 },
);

async function freshReal(tally: Tally): Promise<{ model: Model; real: Real }> {
  const r = await captureRig({ credits: 40, connectAfterMs: NEVER_MS });
  await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
  const real: Real = {
    r, phones: { A: phoneId("a"), B: phoneId("b") }, codes: [{ code: r.code, tok: r.tok }],
    scripted: new Map(), everConnected: new Set(), tally,
  };
  const model: Model = {
    current: null, open: null, stopRecords: new Map(), delivered: new Map(), scanned: new Map(), codes: 1, sessions: [],
    w23: { anchored: false, counted: 0, paid: 0 },
  };
  return { model, real };
}

describe.skipIf(!HAS_DB)("capture model (§11.1.4, rule 10): two phones, the real use-cases, eleven invariants after every step", () => {
  it("capture model: eleven invariants hold over every generated sequence; every action, outcome and counter is reached by DRAWN runs", async () => {
    const tally = new Tally();
    await fc.assert(
      fc.asyncProperty(COMMANDS, async (cmds) => {
        tally.runs++;
        const setup = await freshReal(tally);
        await fc.asyncModelRun(() => setup, cmds);
      }),
      { numRuns: RUNS, seed: SEED, verbose: 1 },
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
    const setup = await freshReal(tally);
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
    const setup = await freshReal(tally);
    await fc.asyncModelRun(() => setup, [cmd.restart("A", false), cmd.advance(16 * MIN), cmd.rescan()]);
    expect([tally.outcomes.get("claimNew:T1-rescan"), tally.outcomes.get("end:no_inbound_timeout")]).toEqual([1, 1]);
    expect(setup.model.open).toBeNull();
  });

  it("pinned, its positive pair: with no B, A re-pairs carrying stopped: X and X ends operator_stopped", async () => {
    const tally = new Tally();
    const setup = await freshReal(tally);
    const { model: m } = setup;
    await fc.asyncModelRun(() => setup, [cmd.claimNew("A"), cmd.goLive(), cmd.localStop(), cmd.claimNew("A")]);
    expect([tally.outcomes.get("claimNew:T1-accept"), tally.outcomes.get("lateStop:applied-current"), tally.counts.lateStopsDelivered]).toEqual([2, 1, 1]);
    const [x0] = await sql<{ state: string; end_reason: string | null }[]>`select state, end_reason from fixture_stream_sessions where id = ${m.sessions[0]!.sid}`;
    expect(x0).toEqual({ state: "completed", end_reason: "operator_stopped" });
    expect(m.open).toBeNull();
    expect(tally.invariantChecks).toBe(4);
  });
});
