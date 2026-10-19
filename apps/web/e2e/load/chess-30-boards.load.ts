/**
 * T17B fix 2, D22 — thirty chess boards, sixty players, one platform: the load test.
 *
 * WHAT IT ANSWERS. When a club opens a round of 30 online boards at once — 60 players checking in, creating games,
 * playing ~20 plies each and resigning — how many calls leave the platform for each vendor in any five minutes
 * (RealtimeKit's limit is 1,200 per account per five minutes; our own ceiling is 900, video/budget.ts), how many
 * Lichess challenges are created (500 per ten minutes per IP, coordinator's brief), how long do the room's reads and
 * the players' moves take at p50/p95, how many database connections are open at the peak (prod budget: 60), and how
 * long does a sweep pass take while all of it is going on.
 *
 * WHAT IT DRIVES. The real server (a production build, started as docs/runbooks/e2e-local.md says) over HTTP, as the
 * players' browsers would: each player claims the seat on their personal link, joins their own (fixture) meeting when told (D16: a meeting per player)
 * to, re-asks on the room's own back-off (1, 2, 4, 8 s), polls
 * the room every 3 s while the game is live (use-room.ts LIVE_POLL_MS - the polling fallback, i.e. no realtime push:
 * the worst case for reads), and moves when it is their turn after a think. Both vendors are the repo's own fixture
 * servers (Lichess :4321, RealtimeKit :4322), started here, which record every call with its time. Players are Node
 * fetches rather than browsers: sixty Chromiums would measure the machine, not the server.
 *
 * WHAT IT DOES NOT. It is not a browser test (no camera, no board), it models no spectators and no organiser, and it
 * knows nothing of the SDK's own traffic to RealtimeKit (the browser's, unmetered; only the REST calls our server makes
 * leave through the budget).
 *
 * TWO MODES. METERED (LOAD_METERED=1, the default): the server runs with REALTIMEKIT_METER_ANY_BASE=1, so the call
 * budget (video/budget.ts, burst 300 + 2/s) acts on the fixture host as it does on Cloudflare's, and the run shows what a
 * deferral costs a player: the seat answers `camera_starting`, the screen re-asks on its back-off, and past its bounds a
 * player presses Check in again. UNMETERED (LOAD_METERED=0, a server without the flag): nothing is deferred and the run
 * measures DEMAND - the RealtimeKit calls a round would make if the budget were not there - and replays the recorded
 * call times through the bucket (`budgetReplay`) to say how many it would have refused.
 *
 * RUN IT (never part of the default projects - this file is not a *.spec.ts, and the main config's testMatch does
 * not see it). From apps/web, against a FRESH DB (leftover meetings from an earlier run are swept into this one's
 * numbers) and a PRODUCTION build whose server carries the fixture variables (LICHESS_BASE_URL=http://127.0.0.1:4321,
 * REALTIMEKIT_BASE_URL=http://127.0.0.1:4322, REALTIMEKIT_METER_ANY_BASE=1 for the metered mode, ONLINE_CHESS_ALWAYS=1,
 * CRON_SECRET, AUTH_SECRET, LICHESS_TOKEN_KEK - the same set the walkthrough needs):
 *
 *   PLAYWRIGHT_BASE=http://localhost:3391 E2E_PROD_TARGET=1 DATABASE_URL=... DATABASE_SSL=disable \
 *   AUTH_SECRET=... CRON_SECRET=... LICHESS_TOKEN_KEK=... \
 *   npx playwright test -c playwright.load.config.ts
 *
 * D21-fix-3: LOAD_POLICY_MIX ("required:30" by default; "required:10,optional:10,off:10" seeds one division per policy) puts
 * the three camera policies in one run; the report's `byPolicy` says per policy what the boards and players saw - games, stranded
 * boards, wrong refusals, and for an OPTIONAL seat the budget left without a token (the seat says so: `cameraRetry`) how long
 * until its tile, asked for on the room's own schedule (the camera route, not a seat call). Every claim carries the held
 * participant id, as the room's does.
 *
 * Knobs (all optional): LOAD_BOARDS (30), LOAD_PLIES (20, even), LOAD_ARRIVAL_SPREAD_S (60: the players arrive
 * uniformly over this; with LOAD_ARRIVE_AT_DEADLINE=1, uniformly over the LAST this-many seconds before the board's deadline), LOAD_THINK_MIN_S / LOAD_THINK_MAX_S (1.5 / 4), LOAD_SWEEP_EVERY_S (40), LOAD_SWEEP_FIRST_S (30, or the cadence if shorter: where the first pass falls), LOAD_SEED (1),
 * LOAD_CAMERA_LAG_MIN_S / LOAD_CAMERA_LAG_MAX_S (1 / 3: the camera's report arrives that long after the join; 0 / 0
 * reports it at the join), LOAD_METERED (1), LOAD_REPORTS_FINAL (1: a left peer's report finalises, as RealtimeKit's
 * does ~70 s after; 0 = never, which makes every sweep pass re-read every unsettled meeting), LOAD_EVIDENCE_WAIT_S (420)
 * and LOAD_EVIDENCE_SWEEP_EVERY_S (20: after the last result the run keeps sweeping until every meeting is ended and its
 * camera evidence settled - the sweep reads it at least two minutes after a room ends), LOAD_SERVER_LOG (the server's
 * stdout file, to count the seat deferrals it logged), LOAD_DUMP_CALLS=1 (every recorded vendor call with its time, next
 * to the report), LOAD_REPORT (test-results/load/chess-30-boards.json). The report is written even when an assertion fails.
 *
 * READING THE NUMBERS. "The busiest five minutes" is the busiest stretch the run had - when the run is shorter than five
 * minutes that is the whole run, and the report says so (`runSeconds`). The assertions are the invariants (every board got
 * a game and a result, every player a seat, no 5xx, no wrong refusal, calls under the ceiling when metered, connections
 * under the budget, every meeting ended and its evidence settled); the latency bounds are generous smoke guards for a stall
 * a player would see, not service-level objectives. The database connection peak counts the runner's own connections too.
 *
 * THE CAPACITY SCENARIOS (spec §5.6.8, the check-in line and the staggered batches). Each is ONE run against a FRESH database, a
 * production build and a METERED fixture host, with the cron at its production cadence (LOAD_SWEEP_EVERY_S=300). The round is opened by the
 * real organiser path, then its stamp is moved by SQL (time only): LOAD_OPENED_AGO_S puts the open that many seconds in the past, and
 * LOAD_STAGGERED=0 stores a one-batch round (every board shares a deadline, which B-end's model needs). Required rounds stagger by
 * themselves (10 boards a batch, one gap apart), so every board waits for its batch exactly as the card tells the player.
 *
 * Every leg is one invocation of the command above with these variables added (LOAD_REPORT and LOAD_SERVER_LOG as in the knobs; LOAD_SWEEP_EVERY_S=300 on
 * all of them). The scenario name is a LABEL and a bar selector: `B`, `B-honest` and every name starting `B-slow` are the burst runs (the
 * cost bars of spec §5.6.8 apply); the other names are only labels. Which further bars a burst run owes is by the SHAPE of its run
 * (line-load.ts barsOf, pinned in line-load.test.ts): the ORDER bars (admission pairs >= 1, 0 unexcused inversions, positions looked at >= 1,
 * 0 unexcused rises) belong to the legs where the line forms with two or more stays waiting - `B-honest` and `B-slow-*` - because zero
 * pairs is a failure and B has none. `B` owes NO held-stays bar: its demand sits a few tokens from the bucket's supply, so whether a stay is
 * held is run to run (5 of 6 runs) - its held count and lowest gate level are only RECORDED. The DRY bars (a stay held, and the gate saw a
 * bucket level under LINE_COMPLETING_LEVEL) belong to `B-dry`, whose arrival spread is derived so the bucket is short of tokens by construction.
 * Every strict leg owes 0 never created / 0 late / 0 beyond the stranded bound. Each is run once, on a fresh database:
 *
 *   A           LOAD_SCENARIO=A LOAD_BOARDS=30 LOAD_ARRIVAL_SPREAD_S=20 LOAD_OPENED_AGO_S=0
 *               (all 60 on the page before the batches open; the harness's own 1-3 s cameras; strict)
 *   A-slow      as A, plus LOAD_SCENARIO=A-slow LOAD_CAMERA_LAG_MIN_S=10 LOAD_CAMERA_LAG_MAX_S=10 LOAD_STRICT=0
 *               (RECORDS whether the batch size or the gap must move; the code's constants are not touched by a run)
 *   B           LOAD_SCENARIO=B LOAD_BOARDS=30 LOAD_ARRIVAL_SPREAD_S=60 LOAD_OPENED_AGO_S=250 LOAD_CAMERA_LAG_MIN_S=0 LOAD_CAMERA_LAG_MAX_S=0
 *               (instant cameras: the bucket's figures alone; the bucket runs dry once and the line holds ONE stay, so there are no pairs)
 *   B-dry       LOAD_SCENARIO=B-dry LOAD_BOARDS=30 LOAD_OPENED_AGO_S=250 LOAD_CAMERA_LAG_MIN_S=0 LOAD_CAMERA_LAG_MAX_S=0 - and NO LOAD_ARRIVAL_SPREAD_S: B's shape
 *               with the spread derived (line-load.ts dryArrivalSpreadS, refused if set by hand); owes the dry bars
 *   B-honest    as B with LOAD_SCENARIO=B-honest and the harness's 1-3 s cameras (LOAD_CAMERA_LAG_MIN_S=1 LOAD_CAMERA_LAG_MAX_S=3):
 *               a stay then costs ~10-12 calls and the line forms, which instant cameras do not make it do - it owns the order bars
 *   B-slow      as B with LOAD_SCENARIO=B-slow-W LOAD_CAMERA_LAG_MIN_S=W LOAD_CAMERA_LAG_MAX_S=W, run at W = 5 (the sum model does not
 *               discriminate there, and the report says so) and W = 10 (it does)
 *   B-end       LOAD_SCENARIO=B-end LOAD_BOARDS=30 LOAD_ARRIVAL_SPREAD_S=60 LOAD_OPENED_AGO_S=500 LOAD_STAGGERED=0 LOAD_ARRIVE_AT_DEADLINE=1
 *               LOAD_STRICT=0 LOAD_CAMERA_LAG_MIN_S=0 LOAD_CAMERA_LAG_MAX_S=0 (60 players in the last 60 s before the deadline; RECORDED)
 *   B-end slow  as B-end with LOAD_SCENARIO=B-end-slow-10 LOAD_CAMERA_LAG_MIN_S=10 LOAD_CAMERA_LAG_MAX_S=10 (the spec's walkover count)
 *   regress     LOAD_SCENARIO=regress LOAD_BOARDS=20 LOAD_OPENED_AGO_S=0 (two batches of 10: the line must stay inert - 0 rows with
 *               queued_at or admitted_at; the run is the old 20-board load A with the batches in front of it)
 *   mixed       LOAD_SCENARIO=mixed LOAD_BOARDS=30 LOAD_POLICY_MIX=required:10,optional:10,off:10 LOAD_ARRIVAL_SPREAD_S=60 LOAD_OPENED_AGO_S=0
 *               (no off or optional player has a held or admitted row)
 *
 * What a player does is the room's own: read the room; while the batch is shut, wait for its `opensAt` plus a jitter (use-room.ts); claim;
 * a `queued` answer is repeated on the answer's own `pollMs` (clamped at the floor, as linePollDelayMs does); a 429 is a WRONG REFUSAL
 * (the room's own schedule must never meet the limiter); `window_closed` after the cap ends the attempt (a walkover the line may have caused).
 * The harness reads the check-in line's ledger every 500 ms - the table is the product's, read as a measuring instrument, never written -
 * and keeps each stay's timeline, because a restarted stay overwrites its row. Every vendor call is attributed to a player's own meeting
 * (the fixture server traces a session or a peer report back to its meeting) so a stay's realized spend is the fixture's count, never the
 * code's own account. The arithmetic is e2e/load/line-load.ts, proved on hand-counted cases in line-load.test.ts.
 *
 * THE OLD DEFAULT RUN (30 Required boards, a 60 s arrival, a round opened a moment ago) is scenario A with a wider arrival: the first batch
 * is open at once, the other two open one gap apart, and the report says what the line did. The runs that stay expected green are
 * `regress` (about 605 calls, 0 deferrals, 0 held rows) and `mixed` (D16's load C, 366 calls).
 */
import { test, expect } from "@playwright/test";
import { Chess } from "chess.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import postgres from "postgres";
import { matchRoomPathBySql, resultEventCountSql, forfeitEventCountSql } from "../helpers";
import { seedOnlineRound, type RoundBoard, type RoundPlayer } from "../match-room-kit";
import { startLichessFixtureServer, type LichessFixtureServer } from "../lichess-fixture-server";
import { startRealtimeKitFixtureServer, type RealtimeKitFixtureServer } from "../realtimekit-fixture-server";
import { CLIENT_POLL, CLIENT_SEAT, LOAD_LIMITS, callsPerWindow, cameraRetryWaitMs, groupCalls, normalisePath, percentile, replayBucket, slidingWindowMax } from "./load-stats";
import { positionRises, completionReorders, type PositionSample } from "./line-checks";
import {
  LINE_LOAD,
  admissionPace,
  barsOf,
  boardTimes,
  classifyCreates,
  classifyInversions,
  DRY_MARGIN_CALLS,
  drainOf,
  dryArrivalSpreadS,
  etaStats,
  warningStats,
  gateLevels,
  heldStays,
  judgeCosts,
  nettingOwed,
  peakPerSecond,
  poolOf,
  slowBound,
  stayCosts,
  type BoardTimes,
  type LineSample,
  type StayCostInput,
  type StayInLine,
  type VendorCall,
} from "./line-load";

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name}=${raw} is not a number`);
  return n;
};

const BOARDS = num("LOAD_BOARDS", 30);
const PLIES = num("LOAD_PLIES", 20);
/** Which capacity scenario this run is (a label in the report; the knobs below are what make it one). */
const SCENARIO = process.env.LOAD_SCENARIO ?? "default";
/** B-dry's arrival spread is DERIVED, never typed (line-load.ts dryArrivalSpreadS): demand exceeds what the call budget supplies by DRY_MARGIN_CALLS.
 *  The players are the required boards' two seats each (the default mix), at the instant-camera cost measured for B. Setting the spread or the mix
 *  by hand on this leg would make the derivation a lie, so either is refused; a spread that does not exist (a run too small to run dry) is refused too. */
const DRY_DERIVATION = (() => {
  if (SCENARIO !== "B-dry") return null;
  for (const name of ["LOAD_ARRIVAL_SPREAD_S", "LOAD_POLICY_MIX"]) {
    if (process.env[name] !== undefined && process.env[name] !== "") throw new Error(`B-dry derives its own arrival spread: ${name} must not be set`);
  }
  const input = { players: BOARDS * 2, perPlayerCalls: LINE_LOAD.instantCallsPerPlayer, burst: LOAD_LIMITS.rtkBurst, refillPerS: LOAD_LIMITS.rtkRefillPerS, marginCalls: DRY_MARGIN_CALLS };
  const spreadS = dryArrivalSpreadS(input);
  if (spreadS === null) throw new Error(`B-dry: ${BOARDS} boards cannot run the bucket dry (demand is not above burst + margin): no spread exists`);
  return { ...input, spreadS };
})();
const ARRIVAL_SPREAD_S: number = DRY_DERIVATION ? DRY_DERIVATION.spreadS : num("LOAD_ARRIVAL_SPREAD_S", 60);
const THINK_MIN_S = num("LOAD_THINK_MIN_S", 1.5);
const THINK_MAX_S = num("LOAD_THINK_MAX_S", 4);
const SWEEP_EVERY_S = num("LOAD_SWEEP_EVERY_S", 40);
/** When the FIRST sweep pass falls, seconds after the round starts. A cron's phase against a round is arbitrary; at the
 *  production cadence (300) set this to where in the five minutes the round happened to open (default: 30 s, or the cadence
 *  if shorter). */
const SWEEP_FIRST_S = num("LOAD_SWEEP_FIRST_S", Math.min(SWEEP_EVERY_S, 30));
/** How long a board's players wait for their game after both are seated before it counts as never made: the room's own
 *  create is seconds; a stranded board waits for a sweep pass, so past one full cadence. */
const GAME_WAIT_MS = Math.max(120, SWEEP_EVERY_S + 90) * 1_000;
const SEED = num("LOAD_SEED", 1);
/** After a player joins the meeting, how long until the camera's report is in (seconds, uniform between the two). 0,0
 *  joins with the camera already reported. The measured honest camera: ~1.4 s. */
const CAMERA_LAG_S: [number, number] = [num("LOAD_CAMERA_LAG_MIN_S", 1), num("LOAD_CAMERA_LAG_MAX_S", 3)];
/** How long after the last result the run keeps sweeping for the camera evidence (the sweep reads it at least two
 *  minutes after a room ends - sweep.ts CAMERA_EVIDENCE_AFTER_MS), and how often it sweeps meanwhile. */
const EVIDENCE_WAIT_S = num("LOAD_EVIDENCE_WAIT_S", 420);
const EVIDENCE_SWEEP_EVERY_S = num("LOAD_EVIDENCE_SWEEP_EVERY_S", 20);
/** 1: a peer's report finalises once the peer has left (RealtimeKit's measured behaviour, ~70 s after), so the sweep's
 *  evidence read settles. 0: reports never finalise - the fixture's default, and the shape of a vendor that stops
 *  finalising: every sweep pass then re-reads every unsettled meeting (3 vendor calls each) until the 24 h give-up. */
const REPORTS_FINAL = num("LOAD_REPORTS_FINAL", 1) === 1;
const REPORT = process.env.LOAD_REPORT ?? "test-results/load/chess-30-boards.json";

/** Move every seeded round's open this many seconds into the PAST (SQL, time only), before any link is minted. Unset: the real open. */
const OPENED_AGO_S: number | null = process.env.LOAD_OPENED_AGO_S === undefined || process.env.LOAD_OPENED_AGO_S === "" ? null : num("LOAD_OPENED_AGO_S", 0);
/** Store the rounds as one batch (0) or as batches (1), whatever the camera policy decided at the open. Unset: as the open stored it. */
const STAGGERED_OVERRIDE: boolean | null = process.env.LOAD_STAGGERED === undefined || process.env.LOAD_STAGGERED === "" ? null : num("LOAD_STAGGERED", 1) === 1;
/** 1: the players arrive in the LAST `ARRIVAL_SPREAD_S` seconds before their board's deadline, placed on the wall clock (B-end). A relative
 *  offset would lose the seconds the seeding takes (the first run of B-end closed 8 doors on that skew alone). */
const ARRIVE_AT_DEADLINE = num("LOAD_ARRIVE_AT_DEADLINE", 0) === 1;
/** 1 (default): the pass bars are assertions. 0: the run RECORDS (A-slow and B-end report what the line did, whatever it was). */
const STRICT = num("LOAD_STRICT", 1) === 1;
/** The camera's warm-up for the B-slow bound: the lag both ends agree on (0 when the cameras report at the join or the lag is a range). */
const CAMERA_WARMUP_S = CAMERA_LAG_S[0] === CAMERA_LAG_S[1] ? CAMERA_LAG_S[1] : null;

/** The room's own cadence (use-room.ts LIVE_POLL_MS / IDLE_POLL_MS; room-snapshot.ts SEAT_RETRY_MS and the D21 ruling's
 *  back-off), as load-stats.ts copies it and load-stats.test.ts PINS it to the room - a copy typed here would be a number
 *  nothing checks. */
const LIVE_POLL_MS = CLIENT_POLL.liveMs;
const IDLE_POLL_MS = CLIENT_POLL.idleMs;
const BACKOFF_MS = CLIENT_SEAT.backoffMs;
/** The check-in screen's own limits (room-snapshot.ts), copied in load-stats.ts and pinned there to the room's: a seat
 *  refused for want of a camera is re-claimed SEAT_RETRIES times, SEAT_RETRY_MS apart, once the camera is up; a
 *  `camera_starting` answer is re-asked on BACKOFF_MS at most MAX_POLLS times. Past either the screen stops and offers the
 *  check-in button, which a player presses again after PRESS_MS (the time to read a card and tap) - and that press is
 *  what `represses` counts. */
const SEAT_RETRY_MS = CLIENT_SEAT.seatRetryMs;
const SEAT_RETRIES = CLIENT_SEAT.seatRetries;
const MAX_POLLS = CLIENT_SEAT.maxPolls;
const PRESS_MS: [number, number] = [3_000, 6_000];
/** Metered: the server runs with REALTIMEKIT_METER_ANY_BASE=1, so the call budget acts on the fixture host (a deferral
 *  is real and costs the player a wait). Unmetered: the fixture host is not metered and the run measures DEMAND. */
const METERED = num("LOAD_METERED", 1) === 1;
/** The server's stdout/stderr, when the run should count its deferral lines (video/budget deferrals at a seat). */
const SERVER_LOG = process.env.LOAD_SERVER_LOG ?? "";
/** The SDK joins a meeting in about 1.4 s (measured, T17B). */
const JOIN_MS: [number, number] = [1_000, 2_000];

/** D21-fix-3: the camera policies of the boards in the run - "required:30" (the default: all Required, the D22 run) or a
 *  mix, "required:10,optional:10,off:10". One division per policy (the policy is a division's), so one round is seeded
 *  for each; the counts must add up to LOAD_BOARDS. */
type Policy = "required" | "optional" | "off";
/** A seeded board with what the run needs to judge it: its camera policy, its rank in its round (the batch is the rank divided by the batch
 *  size) and, once the round's stamp is read back, the instants of its window. */
type LoadBoard = RoundBoard & { policy: Policy; rank: number; stageId: string; times: BoardTimes | null };
const POLICY_MIX: { policy: Policy; boards: number }[] = (process.env.LOAD_POLICY_MIX ?? `required:${BOARDS}`).split(",").map((part) => {
  const [policy, n] = part.trim().split(":");
  if (policy !== "required" && policy !== "optional" && policy !== "off") throw new Error(`LOAD_POLICY_MIX: unknown policy "${policy}"`);
  const boards = Number(n);
  if (!Number.isInteger(boards) || boards < 1) throw new Error(`LOAD_POLICY_MIX: "${part}" needs a positive whole number of boards`);
  return { policy, boards };
});
if (POLICY_MIX.reduce((a, m) => a + m.boards, 0) !== BOARDS) throw new Error(`LOAD_POLICY_MIX must add up to LOAD_BOARDS (${BOARDS})`);
if (new Set(POLICY_MIX.map((m) => m.policy)).size !== POLICY_MIX.length) throw new Error("LOAD_POLICY_MIX names a policy twice");

if (PLIES < 2 || PLIES % 2 !== 0) throw new Error(`LOAD_PLIES must be an even number of at least 2, got ${PLIES}`);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A small seeded generator (mulberry32) so a run's boards and think times repeat. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Sample = { label: string; ms: number; status: number; at: number };

/** What a `queued` answer carries (room-snapshot.ts LineWire), as the load run reads it. */
type LineWire = { position: number; etaS: number; pollMs: number; closesAt: string; mayTimeOut: boolean; left: "silent" | "camera" | null };
type Seat = {
  seated: boolean;
  reason?: string;
  line?: LineWire;
  participant?: { participantId: string; authToken: string } | null;
  /** D21-fix-3: an optional camera seated with no token because the call budget was spent - a token can still come. */
  cameraRetry?: boolean;
};
type Snapshot = {
  you: { colour: "white" | "black" };
  /** The board's phase and the instant its batch opens (room-snapshot.ts): what a waiting card reads. */
  phase?: "not_opened" | "before" | "open" | "closed";
  opensAt?: string | null;
  serverNow?: string;
  canAct: boolean;
  game: { moves: string[]; over: boolean } | null;
  result: unknown | null;
};

type Player = {
  info: RoundPlayer;
  board: LoadBoard;
  path: string; // /shared/.../play?t=...
  token: string;
  roomUrl: string;
  arriveAfterMs: number;
  claims: number;
  /** Claims answered `camera_required` AFTER the player had joined the meeting: a refusal the player has to press
   *  Check in again to get past (D21-fix I1's symptom when the camera report is late). */
  represses: number;
  participantId: string | null;
  seatedAt: number | null;
  /** Arrival to seated, ms: what a deferral costs a player. */
  checkInMs: number | null;
  snapshot: Snapshot | null;
  refusals: string[];
  policy: Policy;
  /** An optional seat the budget left with no token (the seat said so, `cameraRetry`), and when its tile came: seated to
   *  token, ms (null: not yet / never) - and how many times the player asked for it. */
  tokenless: boolean;
  tileMs: number | null;
  tileAsks: number;
  /** The side this player's entrant is on: their meeting is the board's `side` row in fixture_video_meetings. */
  side: "home" | "away";
  /** The harness's own first seat-claim request time (arrival, as the spec defines it), epoch ms. */
  firstClaimAt: number | null;
  /** Every seat claim: when it was sent and answered, what came back. */
  claimLog: { sentAt: number; recvAt: number; status: number; reason: string; line: LineWire | null }[];
  /** `window_closed` came back after the cap: the stay was out of time (a walkover the line may have caused). */
  closedAt: number | null;
  /** The seat claims made AFTER a verdict (a re-press, a re-claim past the retries): spend the reservation does not price. */
  unreserved: string[];
  /** The player saw the board's door shut (the batch-wait card) before it opened. */
  waitedForBatch: boolean;
  /** When the player joined the meeting with the token, and when their camera's report came on (the camera timeline of a stay). */
  joinedAt: number | null;
  cameraOnAt: number | null;
};

test("30 boards, 60 players: check in, create, ~20 plies, resign - the vendors' calls, the latencies, the connections, the sweep", async ({ request }) => {
  test.setTimeout(30 * 60_000);
  const baseURL = test.info().project.use.baseURL!;
  const random = rng(SEED);

  const lichess: LichessFixtureServer = await startLichessFixtureServer();
  const video: RealtimeKitFixtureServer = await startRealtimeKitFixtureServer();
  video.setReportsFinal(REPORTS_FINAL);
  const bucketKeyLike = `${video.url}|%`;
  const samples: Sample[] = [];
  const failures: string[] = [];
  const sweepPasses: { at: number; ms: number; skipped: boolean; report: Record<string, unknown> }[] = [];
  const dbSamples: { at: number; total: number; active: number; idleInTx: number }[] = [];
  const times: Record<string, number> = {};
  const seatAnswers: Record<string, number> = {};
  let stop = false;
  let monitorDone: Promise<void> = Promise.resolve();
  let ledgerDone: Promise<void> = Promise.resolve();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required (the seeding and the connection sampler read the same DB the server uses)");
  const monitor = postgres(dbUrl, {
    max: 1,
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
  });

  async function timed<T>(label: string, run: () => Promise<{ status: number; body: T }>): Promise<{ status: number; body: T }> {
    const at = Date.now();
    try {
      const out = await run();
      samples.push({ label, ms: Date.now() - at, status: out.status, at });
      return out;
    } catch (e) {
      samples.push({ label, ms: Date.now() - at, status: 0, at });
      throw e;
    }
  }

  async function http<T>(label: string, path: string, method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}) {
    return timed<T>(label, async () => {
      const res = await fetch(new URL(path, baseURL), {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed as T };
    });
  }

  try {
    // ----------------------------------------------------------------------------------------------- seeding
    const tag = Date.now().toString(36);
    const names = Array.from({ length: BOARDS * 2 }, (_, i) => `Load ${String(i + 1).padStart(2, "0")} ${tag}`);
    // One round (one division) per policy: the camera policy is the division's.
    const allBoards: LoadBoard[] = [];
    let used = 0;
    for (const mix of POLICY_MIX) {
      const part = await seedOnlineRound(request, names.slice(used * 2, (used + mix.boards) * 2), { camera: mix.policy, playable: true, stage: "swiss" });
      expect(part.boards.length, `anti-vacuity: the ${mix.policy} round paired every player`).toBe(mix.boards);
      // The boards come back in the round's own order (seq_in_round), so an index is a rank (round-open.ts boardRankSql).
      part.boards.forEach((b, rank) => allBoards.push({ ...b, policy: mix.policy, rank, stageId: part.stageId, times: null }));
      used += mix.boards;
    }
    const round = { boards: allBoards };
    expect(round.boards.length, "anti-vacuity: every board of every policy").toBe(BOARDS);
    // The round's stamp, moved by SQL where a scenario asks (TIME and the stored batch flag only: the open itself was the real path),
    // BEFORE any link is minted - a link carries the open's stamp. Then read back, so every board's window is the stored one.
    const stageIds = [...new Set(allBoards.map((b) => b.stageId))];
    if (OPENED_AGO_S !== null) {
      await monitor`update stage_round_opens set opened_at = ${new Date(Date.now() - OPENED_AGO_S * 1_000)} where stage_id in ${monitor(stageIds)}`;
    }
    if (STAGGERED_OVERRIDE !== null) {
      await monitor`update stage_round_opens set staggered = ${STAGGERED_OVERRIDE} where stage_id in ${monitor(stageIds)}`;
    }
    const stamps = await monitor<{ stage_id: string; opened_at: Date; staggered: boolean }[]>`
      select stage_id, opened_at, staggered from stage_round_opens where stage_id in ${monitor(stageIds)}`;
    expect(stamps.length, "anti-vacuity: every seeded round has an open stamp").toBe(stageIds.length);
    for (const b of allBoards) {
      const st = stamps.find((x) => x.stage_id === b.stageId)!;
      b.times = boardTimes(new Date(st.opened_at).getTime(), b.rank, st.staggered);
    }
    for (const b of round.boards) for (const p of [b.home, b.away]) lichess.registerToken(p.lichessToken!, p.lichessId);

    const players: Player[] = [];
    for (const board of round.boards) {
      for (const info of [board.home, board.away]) {
        const path = await matchRoomPathBySql(board.fixtureId, info.personId);
        const token = new URL(path, "http://x").searchParams.get("t")!;
        players.push({
          info,
          board,
          path,
          token,
          roomUrl: `/api/v1/fixtures/${board.fixtureId}/external-play/room?t=${encodeURIComponent(token)}`,
          arriveAfterMs: Math.round(random() * ARRIVAL_SPREAD_S * 1_000),
          claims: 0,
          represses: 0,
          participantId: null,
          seatedAt: null,
          checkInMs: null,
          snapshot: null,
          refusals: [],
          policy: board.policy,
          tokenless: false,
          tileMs: null,
          tileAsks: 0,
          side: info === board.home ? "home" : "away",
          firstClaimAt: null,
          claimLog: [],
          closedAt: null,
          unreserved: [],
          waitedForBatch: false,
          joinedAt: null,
          cameraOnAt: null,
        });
      }
    }
    expect(players.length, "anti-vacuity: sixty players").toBe(BOARDS * 2);

    // ---------------------------------------------------------------------------- monitors: connections, sweeps
    monitorDone = (async () => {
      while (!stop) {
        try {
          const [row] = await monitor<{ total: number; active: number; idle_in_tx: number }[]>`
            select count(*)::int as total,
                   count(*) filter (where state = 'active')::int as active,
                   count(*) filter (where state like 'idle in transaction%')::int as idle_in_tx
              from pg_stat_activity
             where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`;
          dbSamples.push({ at: Date.now(), total: row!.total, active: row!.active, idleInTx: row!.idle_in_tx });
        } catch (e) {
          failures.push(`connection sampler: ${(e as Error).message}`);
        }
        await sleep(250);
      }
    })();

    // ------------------------------------------------------------------------- the ledger, read as an instrument
    // The check-in line's table (fixture_seat_line) read every 500 ms with the bucket's level and the database's transaction counter. NEVER
    // written. A restarted stay overwrites its row, so each (fixture, person, first_claim_at) is its own STAY and its timeline is kept here.
    type StayTrack = {
      key: string;
      fixtureId: string;
      personId: string;
      firstClaimAt: number;
      queuedAt: number | null;
      admittedAt: number | null;
      servedAt: number | null;
      endedAt: number | null;
      /** `completing` at the first sample that showed the stay admitted, and at the last sample (a late flip is false then true). */
      completingAtAdmit: boolean | null;
      completingLast: boolean;
    };
    const stayTracks = new Map<string, StayTrack>();
    const lineSamples: LineSample[] = [];
    const xactSamples: { at: number; xacts: number }[] = [];
    const ledgerFixtureIds = round.boards.map((b) => b.fixtureId);
    const bucketKeyLikeForSampler = `${video.url}|%`;
    async function sampleLedger(): Promise<void> {
      const at = Date.now();
      const rows = await monitor<
        {
          fixture_id: string;
          person_id: string;
          first_claim_at: Date;
          queued_at: Date | null;
          admitted_at: Date | null;
          served_at: Date | null;
          ended_at: Date | null;
          completing: boolean;
          last_gate: "held" | "passed";
          last_seen_at: Date;
        }[]
      >`select fixture_id, person_id, first_claim_at, queued_at, admitted_at, served_at, ended_at, completing, last_gate, last_seen_at
          from fixture_seat_line where fixture_id in ${monitor(ledgerFixtureIds)}`;
      const [lvl] = await monitor<{ tokens: number | null }[]>`
        select least(${LOAD_LIMITS.rtkBurst}::float8, b.tokens + ${LOAD_LIMITS.rtkRefillPerS}::float8 * greatest(0, extract(epoch from (now() - b.refilled_at))::float8)) as tokens
          from realtimekit_call_budget b where b.key like ${bucketKeyLikeForSampler} limit 1`;
      const [xa] = await monitor<{ x: number }[]>`select (xact_commit + xact_rollback)::float8 as x from pg_stat_database where datname = current_database()`;
      if (xa) xactSamples.push({ at, xacts: Number(xa.x) });
      let inFlight = 0;
      let completing = 0;
      let waiting = 0;
      for (const r of rows) {
        const first = new Date(r.first_claim_at).getTime();
        const key = `${r.fixture_id}:${r.person_id}:${first}`;
        const t = stayTracks.get(key) ?? { key, fixtureId: r.fixture_id, personId: r.person_id, firstClaimAt: first, queuedAt: null, admittedAt: null, servedAt: null, endedAt: null, completingAtAdmit: null, completingLast: false };
        const ms = (d: Date | null) => (d === null ? null : new Date(d).getTime());
        t.queuedAt ??= ms(r.queued_at);
        t.admittedAt ??= ms(r.admitted_at);
        t.servedAt ??= ms(r.served_at);
        t.endedAt ??= ms(r.ended_at);
        if (r.admitted_at !== null && t.completingAtAdmit === null) t.completingAtAdmit = r.completing;
        t.completingLast = r.completing;
        stayTracks.set(key, t);
        // Live: not served or ended, and not lapsed (a held stay silent for the abandon window, a passed one for the release grace).
        const silentFor = at - new Date(r.last_seen_at).getTime();
        const lapsed =
          silentFor > (r.last_gate === "held" ? LINE_LOAD.abandonAfterMs : LINE_LOAD.releaseGraceMs) ||
          (r.admitted_at !== null && at - new Date(r.admitted_at).getTime() >= LINE_LOAD.admitHoldMs);
        const over = r.served_at !== null || r.ended_at !== null || lapsed;
        if (over) continue;
        if (r.admitted_at !== null) {
          inFlight += 1;
          if (r.completing) completing += 1;
        } else if (r.queued_at !== null) waiting += 1;
      }
      if (lvl && lvl.tokens !== null) lineSamples.push({ at, tokens: Number(lvl.tokens), inFlight, completing, waiting });
    }
    ledgerDone = (async () => {
      while (!stop) {
        try {
          await sampleLedger();
        } catch (e) {
          failures.push(`ledger sampler: ${(e as Error).message}`);
        }
        await sleep(500);
      }
    })();

    async function sweepOnce(): Promise<{ skipped: boolean }> {
      const at = Date.now();
      const res = await http<{ data?: { skipped: boolean } & Record<string, unknown> }>(
        "sweep",
        "/api/cron/external-play",
        "POST",
        undefined,
        { "x-cron-secret": process.env.CRON_SECRET ?? "" },
      );
      const data = res.body.data;
      if (res.status !== 200 || !data) {
        failures.push(`sweep answered ${res.status}`);
        return { skipped: false };
      }
      sweepPasses.push({ at, ms: Date.now() - at, skipped: data.skipped === true, report: data });
      return { skipped: data.skipped === true };
    }

    // The call budget's bucket for the fixture host starts FULL for this run (a leftover from an earlier run is another
    // run's spending), so the first minute is the burst and the rest is the refill.
    await monitor`delete from realtimekit_call_budget where key like ${bucketKeyLike}`;
    const serverLogLinesAtStart = SERVER_LOG && existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, "utf8").split("\n").length : 0;

    // ------------------------------------------------------------------------------------------------ players
    const startedAt = Date.now();
    times.start = startedAt;

    async function pollRoom(p: Player, until: () => boolean): Promise<void> {
      while (!until()) {
        const live = p.snapshot?.game != null && !p.snapshot.game.over && p.snapshot.result == null;
        await sleep(live ? LIVE_POLL_MS : IDLE_POLL_MS);
        if (until()) return;
        const res = await http<{ data?: Snapshot }>("room read", p.roomUrl, "GET");
        if (res.status === 200 && res.body.data) p.snapshot = res.body.data;
        else failures.push(`room read answered ${res.status} (${p.info.name})`);
      }
    }

    /** D21-fix-3 (owner decision): an optional camera the budget left with no token asks again on the room's schedule
     *  (use-room.ts: 2/4/8/16 s, then every 30) for JUST the token - the camera route, no seat call - until it has one or its
     *  game is over. `tileMs` is what the wait cost the player. */
    const tileRuns: Promise<void>[] = [];
    function startTileRetry(p: Player): void {
      const over = () => stop || p.snapshot?.result != null;
      tileRuns.push(
        (async () => {
          for (let attempt = 0; !over(); attempt += 1) {
            await sleep(cameraRetryWaitMs(attempt));
            if (over()) return;
            p.tileAsks += 1;
            const res = await http<{ data?: { participant: { participantId: string } | null; retry: boolean } }>(
              "camera token",
              `/api/v1/fixtures/${p.board.fixtureId}/external-play/room/camera?t=${encodeURIComponent(p.token)}`,
              "POST",
            );
            const data = res.body.data;
            if (res.status !== 200 || !data) {
              failures.push(`camera token answered ${res.status} (${p.info.name})`);
              continue;
            }
            if (data.participant) {
              p.participantId = data.participant.participantId;
              p.tileMs = Date.now() - p.seatedAt!;
              return;
            }
            if (!data.retry) {
              failures.push(`${p.info.name}: the camera route said stop with no token`);
              return;
            }
          }
        })(),
      );
    }

    /** The page, as a player meets it before the door is open: read the room; while the board's batch is shut the card waits for the
     *  `opensAt` the room gave, on the SERVER's clock, plus a jitter (use-room.ts batchRereadDelayMs), and reads once more. Returns
     *  when the room says the door is not shut. */
    async function waitForDoor(p: Player): Promise<void> {
      for (let reads = 0; reads < 400; reads += 1) {
        const res = await http<{ data?: Snapshot }>("room read", p.roomUrl, "GET");
        const snap = res.status === 200 ? res.body.data : undefined;
        if (!snap) {
          failures.push(`room read answered ${res.status} (${p.info.name})`);
          await sleep(IDLE_POLL_MS);
          continue;
        }
        p.snapshot = snap;
        if (snap.phase !== "before" || !snap.opensAt) return;
        p.waitedForBatch = true;
        const skewMs = snap.serverNow ? Date.parse(snap.serverNow) - Date.now() : 0;
        const untilOpen = Math.max(0, Date.parse(snap.opensAt) - (Date.now() + skewMs));
        await sleep(untilOpen + random() * LINE_LOAD.batchRereadJitterMs);
      }
      failures.push(`${p.info.name}: the door never opened in 400 reads`);
    }

    /** The check-in screen as a player lives it (room-shell.tsx, use-room.ts): wait for the batch's door; claim; `queued` is repeated on the
     *  answer's own `pollMs` (never faster than the floor); a refusal for want of a camera, once the camera is up, is re-claimed SEAT_RETRIES
     *  times; `camera_starting` is re-asked on the back-off at most MAX_POLLS times; past either bound the screen offers the check-in button
     *  and the player presses it (`represses`), which resets both budgets. The two budgets are per participant and are NOT reset by the
     *  answer changing from one to the other. A 429 is a WRONG REFUSAL: the room's own schedule must never meet the limiter. */
    async function checkIn(p: Player): Promise<void> {
      await sleep(ARRIVE_AT_DEADLINE ? Math.max(0, p.board.times!.deadlineAt - ARRIVAL_SPREAD_S * 1_000 + p.arriveAfterMs - Date.now()) : p.arriveAfterMs);
      const began = Date.now();
      const giveUpAt = (p.board.times?.capAt ?? began + 60 * 60_000) + 120_000;
      await waitForDoor(p);
      let joined = false;
      let polls = 0;
      let retries = 0;
      for (let guard = 0; guard < 5_000 && Date.now() < giveUpAt; guard += 1) {
        // Like the real room (use-room.ts claim): the id of the participant whose token the browser holds goes with every claim.
        const sentAt = Date.now();
        if (p.firstClaimAt === null) p.firstClaimAt = sentAt;
        const res = await http<{ data?: { snapshot: Snapshot; seat: Seat | null } }>(
          "seat claim",
          p.roomUrl,
          "POST",
          p.participantId !== null ? { heldParticipantId: p.participantId } : undefined,
        );
        p.claims += 1;
        const recvAt = Date.now();
        const data = res.body.data;
        if (res.status === 429) {
          p.claimLog.push({ sentAt, recvAt, status: 429, reason: "429", line: null });
          p.refusals.push("429");
          seatAnswers["429"] = (seatAnswers["429"] ?? 0) + 1;
          failures.push(`wrong refusal: a 429 on the seat claim (${p.info.name})`);
          await sleep(SEAT_RETRY_MS);
          continue;
        }
        if (res.status !== 200 || !data) {
          p.claimLog.push({ sentAt, recvAt, status: res.status, reason: "error", line: null });
          failures.push(`seat claim answered ${res.status} (${p.info.name})`);
          await sleep(SEAT_RETRY_MS);
          continue;
        }
        p.snapshot = data.snapshot;
        const seat = data.seat;
        const answered = seat?.seated ? "seated" : (seat?.reason ?? "no seat answer");
        seatAnswers[answered] = (seatAnswers[answered] ?? 0) + 1;
        p.claimLog.push({ sentAt, recvAt, status: 200, reason: answered, line: seat?.line ?? null });
        if (seat?.seated) {
          p.seatedAt = Date.now();
          // From the FIRST CLAIM request (spec §5.6.8): a player waiting for their batch's door has not claimed yet.
          p.checkInMs = p.seatedAt - (p.firstClaimAt ?? began);
          if (seat.participant) p.participantId = seat.participant.participantId;
          if (seat.cameraRetry === true) {
            // D21-fix-3: only an OPTIONAL camera is ever told to ask again; the explicit field, never a null token alone.
            if (p.policy !== "optional" || seat.participant) failures.push(`${p.info.name}: a ${p.policy} seat carried cameraRetry${seat.participant ? " with a token" : ""}`);
            else {
              p.tokenless = true;
              startTileRetry(p);
            }
          } else if (p.policy === "off" && seat.participant) {
            failures.push(`${p.info.name}: a camera-off seat was handed a participant`);
          }
          return;
        }
        const reason = seat?.reason ?? "no seat answer";
        const press = async () => {
          // The screen has stopped asking: the player reads the card and presses Check in again.
          p.represses += 1;
          p.unreserved.push("re-press after the screen stopped asking");
          polls = 0;
          retries = 0;
          await sleep(PRESS_MS[0] + random() * (PRESS_MS[1] - PRESS_MS[0]));
        };
        if (reason === "queued" && seat?.line) {
          // The check-in line: the place, the estimate, the cadence. Repeated on the answer's own pollMs, floored (linePollDelayMs).
          if (seat.line.left !== null) p.unreserved.push(`a second stay (the first left: ${seat.line.left})`);
          await sleep(Math.max(seat.line.pollMs, LINE_LOAD.pollMinMs));
        } else if (reason === "checkin_not_open") {
          // The door was shut at the claim (a skew of a hair): the batch-wait card again, never a wrong refusal.
          await waitForDoor(p);
        } else if (reason === "window_closed") {
          // Past the board's cap, or the deadline with no protection: the stay ran out. A walkover the line may have caused.
          p.closedAt = Date.now();
          return;
        } else if (reason === "camera_required") {
          const part = seat?.participant;
          if (part && !joined) {
            p.participantId = part.participantId;
            await sleep(JOIN_MS[0] + random() * (JOIN_MS[1] - JOIN_MS[0]));
            p.joinedAt = Date.now();
            if (CAMERA_LAG_S[1] <= 0) {
              video.setLivePublisher(part.participantId, true);
              p.cameraOnAt = p.joinedAt;
            } else {
              // The peer is in the meeting, its camera's report not in yet: the seat reads `camera_starting` until it is
              // (measured ~1.4 s after the join). The REPORT arrives on the SAME peer (fixture.reportCamera), not as a
              // reload - a reload would be a second peer, and the sweep's evidence read would then see an empty first one.
              video.setLivePublisher(part.participantId, true, { camera: "pending" });
              const lagMs = (CAMERA_LAG_S[0] + random() * (CAMERA_LAG_S[1] - CAMERA_LAG_S[0])) * 1_000;
              const pid = part.participantId;
              setTimeout(() => {
                try {
                  video.reportCamera(pid, "on");
                  p.cameraOnAt = Date.now();
                } catch (e) {
                  if (!stop) failures.push(`camera report for ${p.info.name}: ${(e as Error).message}`);
                }
              }, lagMs);
            }
            joined = true;
          } else if (joined) {
            // A re-claim after the camera refusal, with the camera joined: the client's own net, 4 vendor calls the reservation does not price.
            p.unreserved.push("a re-claim after camera_required");
          }
          if (!joined) {
            await sleep(SEAT_RETRY_MS);
          } else if (retries < SEAT_RETRIES) {
            retries += 1;
            await sleep(SEAT_RETRY_MS);
          } else {
            await press();
          }
        } else if (reason === "camera_starting") {
          if (polls < MAX_POLLS) {
            await sleep(BACKOFF_MS[Math.min(polls + 1, BACKOFF_MS.length) - 1]!);
            polls += 1;
          } else {
            await press();
          }
        } else {
          p.refusals.push(reason);
          failures.push(`wrong refusal: ${reason} (${p.info.name})`);
          return;
        }
      }
      if (p.seatedAt === null && p.closedAt === null) failures.push(`${p.info.name} never got a seat or a closed door before ${new Date(giveUpAt).toISOString()}`);
    }

    /** The plies a board will play: random legal moves from a seeded generator, never ending the game early. */
    function planPlies(boardIndex: number): string[] {
      const r = rng(SEED * 1_000 + boardIndex);
      const chess = new Chess();
      const out: string[] = [];
      for (let i = 0; i < PLIES; i += 1) {
        const legal = chess.moves({ verbose: true });
        const safe = legal.filter((m) => {
          const probe = new Chess(chess.fen());
          probe.move(m);
          return !probe.isGameOver();
        });
        const pool = safe.length > 0 ? safe : legal;
        const m = pool[Math.floor(r() * pool.length)]!;
        chess.move(m);
        out.push(`${m.from}${m.to}${m.promotion ?? ""}`);
      }
      return out;
    }

    /** What the run knows of each board's life, by round index: the later of its two seats, the first instant its game was SEEN (the
     *  observer reads the room at least once a second from the second seat), and whether a player's door closed on them. */
    const boardStates = round.boards.map(() => ({ bothSeatedAt: null as number | null, gameSeenAt: null as number | null, walkover: false }));

    async function playBoard(boardIndex: number, home: Player, away: Player): Promise<void> {
      const plies = planPlies(boardIndex);
      let done = false;
      const state = boardStates[boardIndex]!;
      const pollers = [pollRoom(home, () => done), pollRoom(away, () => done)];
      await Promise.all([checkIn(home), checkIn(away)]);
      if (home.seatedAt !== null && away.seatedAt !== null) state.bothSeatedAt = Math.max(home.seatedAt, away.seatedAt);
      if (state.bothSeatedAt === null) {
        // A player's door closed on them (or never opened): no game can be made. Recorded as a walkover candidate, not played.
        state.walkover = true;
        if (STRICT) failures.push(`board ${boardIndex + 1}: a player was never seated (closed ${[home, away].filter((p) => p.closedAt !== null).length})`);
        done = true;
        await Promise.all(pollers);
        return;
      }
      // The observer: the game's first appearance on the board's room, read each second (spec §5.6.8, "late create"). Judged at the
      // EARLIER of the board's cap and two sweep cadences after the second seat, plus a little slack for the last read.
      const board = round.boards[boardIndex]!;
      const judgeBy = Math.min(board.times?.capAt ?? Infinity, state.bothSeatedAt + 2 * LINE_LOAD.sweepCadenceMs) + 5_000;
      while (Date.now() < judgeBy && state.gameSeenAt === null) {
        const res = await http<{ data?: Snapshot }>("observer read", home.roomUrl, "GET");
        if (res.status === 200 && res.body.data?.game) state.gameSeenAt = Date.now();
        else await sleep(1_000);
      }
      if (state.gameSeenAt === null) {
        if (STRICT) failures.push(`board ${boardIndex + 1}: no game by ${new Date(judgeBy).toISOString()}, after both seats`);
        done = true;
        await Promise.all(pollers);
        return;
      }
      // Colours as the room reports them, never assumed from home/away. The first read after the seat has them.
      const byColour = (c: "white" | "black") => [home, away].find((p) => p.snapshot?.you.colour === c);
      const gameStartedBy = Date.now() + GAME_WAIT_MS;
      while (Date.now() < gameStartedBy && !(home.snapshot?.game && away.snapshot?.game)) await sleep(250);
      const white = byColour("white");
      const black = byColour("black");
      if (!white || !black || !(home.snapshot?.game && away.snapshot?.game)) {
        failures.push(`board ${boardIndex + 1}: no game on both players' screens after the game existed`);
        done = true;
        await Promise.all(pollers);
        return;
      }
      times[`gameSeen.${boardIndex}`] = state.gameSeenAt;
      for (let ply = 0; ply < PLIES; ply += 1) {
        const mover = ply % 2 === 0 ? white : black;
        // Wait until THIS player's own last read shows the opponent's move (their 3 s poll is the only way they learn
        // it here), then think, then move.
        const noticeBy = Date.now() + 120_000;
        while (Date.now() < noticeBy && (mover.snapshot?.game?.moves.length ?? -1) < ply) await sleep(100);
        if ((mover.snapshot?.game?.moves.length ?? -1) < ply) {
          failures.push(`board ${boardIndex + 1}: ply ${ply + 1} - ${mover.info.name} never saw the opponent's move`);
          break;
        }
        await sleep((THINK_MIN_S + random() * (THINK_MAX_S - THINK_MIN_S)) * 1_000);
        const res = await http<{ data?: { ok: boolean; reconcile?: boolean; reason?: string } }>(
          "move",
          `/api/v1/fixtures/${mover.board.fixtureId}/external-play/room/act?t=${encodeURIComponent(mover.token)}`,
          "POST",
          { kind: "move", uci: plies[ply]! },
        );
        if (res.status !== 200 || res.body.data?.ok !== true) {
          failures.push(`board ${boardIndex + 1}: move ${ply + 1} ${plies[ply]} answered ${res.status} ${JSON.stringify(res.body.data)}`);
          break;
        }
        // The mover knows their own move at once (the client applies it optimistically); keep the local ledger honest.
        if (mover.snapshot?.game) mover.snapshot.game.moves = [...mover.snapshot.game.moves.slice(0, ply), plies[ply]!];
      }
      // The player to move resigns: the result is Lichess's, written once.
      const loser = PLIES % 2 === 0 ? white : black;
      const noticeBy = Date.now() + 120_000;
      while (Date.now() < noticeBy && (loser.snapshot?.game?.moves.length ?? -1) < PLIES) await sleep(100);
      await sleep((THINK_MIN_S + random() * (THINK_MAX_S - THINK_MIN_S)) * 1_000);
      const resign = await http<{ data?: { ok: boolean } }>(
        "resign",
        `/api/v1/fixtures/${loser.board.fixtureId}/external-play/room/act?t=${encodeURIComponent(loser.token)}`,
        "POST",
        { kind: "resign" },
      );
      if (resign.status !== 200 || resign.body.data?.ok !== true) {
        failures.push(`board ${boardIndex + 1}: resign answered ${resign.status} ${JSON.stringify(resign.body.data)}`);
      }
      // The room shows the result on the next read, for BOTH players.
      const resultBy = Date.now() + 60_000;
      while (Date.now() < resultBy && !(home.snapshot?.result && away.snapshot?.result)) await sleep(250);
      if (!(home.snapshot?.result && away.snapshot?.result)) failures.push(`board ${boardIndex + 1}: a player's room never showed the result`);
      times[`resultSeen.${boardIndex}`] = Date.now();
      done = true;
      await Promise.all(pollers);
    }

    // ----------------------------------------------------------------------------------------- the whole round
    const boardRuns = round.boards.map((b, i) => {
      const home = players.find((p) => p.board === b && p.info === b.home)!;
      const away = players.find((p) => p.board === b && p.info === b.away)!;
      return playBoard(i, home, away);
    });
    let allDone = false;
    const sweeper = (async () => {
      await sleep(SWEEP_FIRST_S * 1_000);
      let first = true;
      while (!allDone) {
        // The first tick fires six passes at once: single-flight (an advisory lock) means an overlapping one reports
        // `skipped` and does nothing. How many do is reported, not asserted - a fast pass can finish before the next arrives.
        if (first) {
          first = false;
          await Promise.all(Array.from({ length: 6 }, () => sweepOnce()));
        } else {
          await sweepOnce();
        }
        await sleep(SWEEP_EVERY_S * 1_000);
      }
    })();
    await Promise.all(boardRuns);
    await Promise.all(tileRuns);
    times.allResults = Date.now();
    allDone = true;
    await sweeper.catch(() => undefined);
    // After the round: sweep until every meeting is ended and its camera evidence settled. The evidence is read at least
    // two minutes after a room ends (sweep.ts CAMERA_EVIDENCE_AFTER_MS), so this is where the sweep's reads of the
    // vendor's session and peer reports - the part of the platform's RealtimeKit demand that is not a seat - show up.
    const fixtureIds = round.boards.map((b) => b.fixtureId);
    // Camera off makes no meeting; the camera evidence is read for REQUIRED boards only (sweep.ts job 5).
    // D16 (spec 5.6.1): a meeting per PLAYER, so a board with a camera has TWO rooms - home's and away's - and the ledger
    // counts rooms, not boards. The two is the spec's number, typed here; `boardsWithBothRooms` proves the rooms are one of
    // each side and not two of the same.
    const MEETINGS_PER_BOARD = 2;
    const meetingIds = round.boards.filter((b) => b.policy !== "off").map((b) => b.fixtureId);
    const requiredIds = round.boards.filter((b) => b.policy === "required").map((b) => b.fixtureId);
    const evidenceState = async () => {
      const [row] = await monitor<{ total: number; ended: number; settled: number; both: number }[]>`
        select count(*)::int as total,
               count(*) filter (where ended_at is not null)::int as ended,
               count(*) filter (where camera_evidence_at is not null and fixture_id = any(${monitor.array(requiredIds)}::uuid[]))::int as settled,
               (select count(*)::int from (
                  select fixture_id from fixture_video_meetings
                   where fixture_id = any(${monitor.array(meetingIds)}::uuid[])
                   group by fixture_id having count(distinct side) = 2) both_sides) as both
          from fixture_video_meetings
         where fixture_id = any(${monitor.array(meetingIds)}::uuid[])`;
      return row!;
    };
    const settleBy = Date.now() + EVIDENCE_WAIT_S * 1_000;
    let evidence = await evidenceState();
    let evidenceChecks = 0;
    while (Date.now() < settleBy) {
      const pass = await sweepOnce();
      evidence = await evidenceState();
      evidenceChecks += 1;
      if (!pass.skipped && evidence.ended === evidence.total && evidence.settled === requiredIds.length * MEETINGS_PER_BOARD) break;
      await sleep(EVIDENCE_SWEEP_EVERY_S * 1_000);
    }
    times.evidenceSettled = Date.now();
    await sleep(3_000);
    times.end = Date.now();
    stop = true;
    await monitorDone;
    await ledgerDone;

    // ----------------------------------------------------------------------------------------------- the numbers
    const runSeconds = (times.end! - startedAt) / 1_000;
    const lichessCalls = lichess.calls;
    const videoCalls = video.calls;
    const lichessCreates = lichessCalls.filter((c) => c.method === "POST" && normalisePath(c.path) === "/api/challenge/:id");
    const lichessWin = slidingWindowMax(lichessCalls.map((c) => c.at), LOAD_LIMITS.windowMs);
    const lichessCreateWin = slidingWindowMax(lichessCreates.map((c) => c.at), LOAD_LIMITS.lichessCreateWindowMs);
    const videoWin = slidingWindowMax(videoCalls.map((c) => c.at), LOAD_LIMITS.windowMs);
    const video60 = slidingWindowMax(videoCalls.map((c) => c.at), 60_000);
    const lichess60 = slidingWindowMax(lichessCalls.map((c) => c.at), 60_000);
    const lat = (label: string) => {
      const xs = samples.filter((s) => s.label === label).map((s) => s.ms);
      return xs.length === 0
        ? { n: 0 }
        : { n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: Math.max(...xs), non200: samples.filter((s) => s.label === label && s.status !== 200).length };
    };
    const phases = [
      ["check-in", startedAt, Math.max(...players.map((p) => p.seatedAt ?? 0))],
      ["play", Math.max(...players.map((p) => p.seatedAt ?? 0)), times.allResults!],
      ["wind-down", times.allResults!, times.end!],
    ] as const;
    const perPhase = Object.fromEntries(
      phases.map(([name, from, to]) => [
        name,
        {
          seconds: Math.round((to - from) / 100) / 10,
          lichess: lichessCalls.filter((c) => c.at >= from && c.at < to).length,
          realtimekit: videoCalls.filter((c) => c.at >= from && c.at < to).length,
        },
      ]),
    );
    const sweepRuns = sweepPasses.filter((s) => !s.skipped);
    const videoTimes = videoCalls.map((c) => c.at);
    const replay = replayBucket(videoTimes, { burst: LOAD_LIMITS.rtkBurst, refillPerS: LOAD_LIMITS.rtkRefillPerS });
    const [flagRow] = await monitor<{ n: number }[]>`
      select count(*)::int as n from fixture_play_flags where fixture_id = any(${monitor.array(fixtureIds)}::uuid[])`;
    const checkInSamples = players.map((p) => p.checkInMs).filter((x): x is number => x !== null);
    const [bucketRow] = await monitor<{ key: string; tokens: number }[]>`select key, tokens from realtimekit_call_budget where key like ${bucketKeyLike}`;
    let seatDeferrals: number | null = null;
    let optionalTileDeferrals: number | null = null;
    if (SERVER_LOG && existsSync(SERVER_LOG)) {
      const lines = readFileSync(SERVER_LOG, "utf8").split("\n").slice(serverLogLinesAtStart);
      seatDeferrals = lines.filter((l) => l.includes("the seat answered camera_starting, the player asks again")).length;
      optionalTileDeferrals = lines.filter((l) => l.includes("optional camera seated with no tile")).length;
    }
    const sweepDeferred = sweepRuns.reduce((n, s2) => n + (((s2.report as { deferred?: number }).deferred) ?? 0), 0);
    const sweepFixtureCalls = videoCalls.filter((c) => sweepRuns.some((s) => c.at >= s.at && c.at <= s.at + s.ms));
    const peakConnections = dbSamples.reduce((m, s) => Math.max(m, s.total), 0);
    const spread = (xs: number[]) => (xs.length === 0 ? null : { n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: Math.max(...xs) });
    // D21-fix-3: what each policy's boards and players saw. A board is STRANDED when its game was not on its players'
    // screens within 30 s of the second seat (the room's own create failed and only the sweep, on its cadence, makes it).
    const STRANDED_AFTER_MS = 30_000;
    const byPolicy = Object.fromEntries(
      POLICY_MIX.map(({ policy }) => {
        const mine = players.filter((p) => p.policy === policy);
        const boards = round.boards.map((b, i) => ({ b, i })).filter(({ b }) => b.policy === policy);
        const gameAfterSeats = boards.flatMap(({ b, i }) => {
          const seen = times[`gameSeen.${i}`];
          const seated = Math.max(...players.filter((p) => p.board === b).map((p) => p.seatedAt ?? 0));
          return seen === undefined ? [] : [seen - seated];
        });
        return [
          policy,
          {
            boards: boards.length,
            players: mine.length,
            gamesSeen: gameAfterSeats.length,
            boardsWithoutGame: boards.length - gameAfterSeats.length,
            stranded: gameAfterSeats.filter((ms) => ms > STRANDED_AFTER_MS).length,
            gameAfterBothSeatedMs: spread(gameAfterSeats),
            arrivalToSeatedMs: spread(mine.map((p) => p.checkInMs).filter((x): x is number => x !== null)),
            represses: mine.reduce((a, p) => a + p.represses, 0),
            wrongRefusals: mine.reduce((a, p) => a + p.refusals.length, 0),
            tokenlessOptionalSeats: mine.filter((p) => p.tokenless).length,
            tokenlessStillWithoutTile: mine.filter((p) => p.tokenless && p.tileMs === null).length,
            seatedToTileMs: spread(mine.flatMap((p) => (p.tileMs === null ? [] : [p.tileMs]))),
            tileAsks: mine.reduce((a, p) => a + p.tileAsks, 0),
          },
        ];
      }),
    );
    // ----------------------------------------------------------------------------------------------- capacity (spec §5.6.8)
    // Every number below is read off the ledger the product wrote (fixture_seat_line), the fixture host's own call log, and the clients'
    // answers - never off the code's own account of itself. The arithmetic is line-load.ts; line-load.test.ts proves it on hand counts.
    const meetingRows = await monitor<{ fixture_id: string; side: "home" | "away"; meeting_id: string }[]>`
      select fixture_id, side, meeting_id from fixture_video_meetings where fixture_id = any(${monitor.array(fixtureIds)}::uuid[])`;
    const meetingOf = (fixtureId: string, side: "home" | "away"): string | null =>
      meetingRows.find((m) => m.fixture_id === fixtureId && m.side === side)?.meeting_id ?? null;
    const vendorCalls: VendorCall[] = videoCalls.map((c) => ({ at: c.at, meetingId: c.meetingId, route: c.route }));
    const opponentOf = (p: Player): Player => players.find((q) => q.board === p.board && q !== p)!;

    // The boards: the instants of the windows, when the second seat landed, when the game was first SEEN.
    const boardCreates = round.boards.map((b, i) => ({ id: b.fixtureId, bothSeatedAt: boardStates[i]!.bothSeatedAt, gameSeenAt: boardStates[i]!.gameSeenAt, capAt: b.times!.capAt }));
    const creates = classifyCreates(boardCreates, times.end!);

    // The stays: each player's first stay is the one their first claim made; later stays of the same person are rejoiners.
    const allTracks = [...stayTracks.values()];
    const staysPerPerson = new Map<string, number>();
    for (const t of allTracks) staysPerPerson.set(`${t.fixtureId}:${t.personId}`, (staysPerPerson.get(`${t.fixtureId}:${t.personId}`) ?? 0) + 1);
    const firstStayOfPerson = new Map<string, number>();
    for (const t of allTracks) {
      const k = `${t.fixtureId}:${t.personId}`;
      firstStayOfPerson.set(k, Math.min(firstStayOfPerson.get(k) ?? Infinity, t.firstClaimAt));
    }
    const stayFacts: StayInLine[] = allTracks.map((t) => ({
      id: t.key,
      firstClaimAt: t.firstClaimAt,
      queuedAt: t.queuedAt,
      admittedAt: t.admittedAt,
      servedAt: t.servedAt,
      rejoiner: (staysPerPerson.get(`${t.fixtureId}:${t.personId}`) ?? 1) > 1,
    }));
    const inversions = classifyInversions(stayFacts, LINE_LOAD.arrivalJitterMs);
    const reorders = completionReorders(stayFacts);
    const claimedStays = new Set<string>();
    /** The ledger stay a player's FIRST claim made: the fixture's stay whose first_claim_at is nearest the claim's own instant (3 s). */
    const stayOf = (p: Player): StayTrack | undefined => {
      if (p.firstClaimAt === null) return undefined;
      const near = allTracks
        .filter((t) => t.fixtureId === p.board.fixtureId && !claimedStays.has(t.key) && Math.abs(t.firstClaimAt - p.firstClaimAt!) <= 3_000)
        .sort((a, b) => Math.abs(a.firstClaimAt - p.firstClaimAt!) - Math.abs(b.firstClaimAt - p.firstClaimAt!));
      const t = near[0];
      if (t) claimedStays.add(t.key);
      return t;
    };
    const stayOfPlayer = new Map<Player, StayTrack | undefined>(players.map((p) => [p, stayOf(p)]));

    // Positions shown: the number a player's card said, in order. A rise is excused only by an earlier arrival first held in between.
    const positionSamples: PositionSample[] = players.flatMap((p) => {
      const t = stayOfPlayer.get(p);
      return p.claimLog.flatMap((c) => (c.line ? [{ id: t?.key ?? p.info.name, sentAt: c.sentAt, at: c.recvAt, position: c.line.position }] : []));
    });
    const rises = positionRises(positionSamples, stayFacts);
    // The bars this scenario owes by the shape of its run (line-load.ts barsOf), and the one count B's own bar reads.
    const bars = barsOf(SCENARIO);
    const held = heldStays(stayFacts);

    // The spend: a required player's own meeting from the first claim to the seat, and the re-verify of the OPPONENT's camera after the
    // opponent was already served. Counted from the fixture host's log.
    const costInputs: StayCostInput[] = players
      .filter((p) => p.policy === "required" && p.seatedAt !== null && p.firstClaimAt !== null && meetingOf(p.board.fixtureId, p.side) !== null)
      .map((p) => {
        const opp = opponentOf(p);
        return {
          id: p.info.name,
          ownMeeting: meetingOf(p.board.fixtureId, p.side)!,
          opponentMeeting: meetingOf(p.board.fixtureId, opp.side),
          firstClaimAt: p.firstClaimAt!,
          seatedAt: p.seatedAt!,
          opponentSeatedAt: opp.seatedAt,
          unreserved: p.unreserved,
        };
      });
    const costs = stayCosts(vendorCalls, costInputs);
    const costVerdict = judgeCosts(costs, LINE_LOAD.reservation, LINE_LOAD.recheckCost);
    const overWithoutReason = costVerdict.over.filter((c) => c.unreserved.length === 0);
    const overRecheckWithoutReason = costVerdict.overRecheck.filter((c) => c.unreserved.length === 0);

    // The drained phase, the pace, the netting trigger, B-slow's bound.
    const drain = drainOf(lineSamples);
    const admittedAts = allTracks.flatMap((t) => (t.admittedAt === null ? [] : [t.admittedAt])).sort((a, b) => a - b);
    const pace = admissionPace(admittedAts, drain.drainedAt ?? Infinity);
    // D_run: the vendor calls from the run's first claim to its last game creation (teardown and evidence are outside it).
    const lastGameSeen = Math.max(0, ...boardStates.map((b) => b.gameSeenAt ?? 0));
    const firstClaim = Math.min(...players.map((p) => p.firstClaimAt ?? Infinity));
    const checkInCalls = vendorCalls.filter((c) => c.at >= firstClaim && c.at <= lastGameSeen).length;
    const requiredPlayers = players.filter((p) => p.policy === "required").length;
    const firstArrival = Math.min(...players.map((p) => p.firstClaimAt ?? Infinity));
    const lastSeat = Math.max(...players.map((p) => p.seatedAt ?? 0));
    const timeToLastSeatS = Number.isFinite(firstArrival) ? (lastSeat - firstArrival) / 1_000 : null;
    const bound =
      CAMERA_WARMUP_S !== null && requiredPlayers > 0
        ? slowBound({
            callsRun: checkInCalls,
            players: requiredPlayers,
            warmupS: CAMERA_WARMUP_S,
            maxInFlightDrained: drain.maxInFlightDrained,
            burst: LOAD_LIMITS.rtkBurst,
            refillPerS: LOAD_LIMITS.rtkRefillPerS,
            pollMs: LINE_LOAD.pollMs,
            maxBackoffMs: Math.max(...BACKOFF_MS),
          })
        : null;
    const perPlayerCalls = requiredPlayers > 0 ? checkInCalls / requiredPlayers : null;
    const netting = perPlayerCalls === null ? false : nettingOwed(pace.meanS, perPlayerCalls, LOAD_LIMITS.rtkRefillPerS);

    // The ETA a player was shown against the wait that happened (the ETA ends at ADMISSION and is a conservative estimate, §5.7.9).
    const etaItems = players.flatMap((p) => {
      const t = stayOfPlayer.get(p);
      const firstLine = p.claimLog.find((c) => c.line);
      if (!t || t.admittedAt === null || !firstLine?.line) return [];
      return [{ shownS: firstLine.line.etaS, actualS: Math.max(0, (t.admittedAt - firstLine.recvAt) / 1_000) }];
    });
    const eta = etaStats(etaItems);

    // Load on the platform: the busiest second of room reads and seat claims, and the database's transactions a second at the peak.
    const busiest = {
      roomReads: peakPerSecond(samples.filter((x) => x.label === "room read").map((x) => x.at)),
      seatClaims: peakPerSecond(samples.filter((x) => x.label === "seat claim").map((x) => x.at)),
    };
    let peakXactPerS = 0;
    for (let i = 1; i < xactSamples.length; i += 1) {
      const dt = (xactSamples[i]!.at - xactSamples[i - 1]!.at) / 1_000;
      if (dt >= 0.4) peakXactPerS = Math.max(peakXactPerS, (xactSamples[i]!.xacts - xactSamples[i - 1]!.xacts) / dt);
    }
    // The line's inertness: rows with a held or admitted stamp, and (for the mixed run) any such row on a board that is not Required.
    const lineRows = (
      await monitor<{ total: number; stamped: number }[]>`
        select count(*)::int as total, count(*) filter (where queued_at is not null or admitted_at is not null)::int as stamped
          from fixture_seat_line where fixture_id in ${monitor(fixtureIds)}`
    )[0]!;
    const offOrOptionalIds = round.boards.filter((b) => b.policy !== "required").map((b) => b.fixtureId);
    const stampedOffOrOptional =
      offOrOptionalIds.length === 0
        ? 0
        : (
            await monitor<{ n: number }[]>`
              select count(*)::int as n from fixture_seat_line
               where (queued_at is not null or admitted_at is not null) and fixture_id in ${monitor(offOrOptionalIds)}`
          )[0]!.n;
    // Walkovers: a board with a player never seated is a candidate; what the platform wrote for it (a forfeit/walkover event).
    const unseatedBoards = round.boards.filter((_, i) => boardStates[i]!.walkover);
    const walkoverEvents = await Promise.all(unseatedBoards.map((b) => forfeitEventCountSql(b.fixtureId)));
    const claimsBeforeOpen = players.reduce((n, p) => n + p.claimLog.filter((c) => c.reason === "checkin_not_open").length, 0);
    // Recorded beside the bars: the stay's admission-to-serve time, late flips of `completing`, the pool at every queued answer, the
    // gate lock's wait and busy refusals (from the server's log), and arrival-to-seated per batch.
    const servedAfterAdmitS = allTracks.flatMap((t) => (t.admittedAt !== null && t.servedAt !== null ? [(t.servedAt - t.admittedAt) / 1_000] : []));
    const lateFlips = allTracks.filter((t) => t.completingAtAdmit === false && t.completingLast).length;
    const orderedSamples = [...lineSamples].sort((a, b) => a.at - b.at);
    const poolAtQueued = players.flatMap((p) =>
      p.claimLog
        .filter((c) => c.line)
        .flatMap((c) => {
          const before = orderedSamples.filter((x) => x.at <= c.recvAt);
          const smp = before[before.length - 1];
          return smp ? [poolOf(smp)] : [];
        }),
    );
    let lockWaitsMs: number[] = [];
    let busyRefusals: number | null = null;
    let gateDecisions: Record<string, number> | null = null;
    let gateLevel: { decisions: number; min: number | null } | null = null;
    if (SERVER_LOG && existsSync(SERVER_LOG)) {
      const lines = readFileSync(SERVER_LOG, "utf8").split("\n").slice(serverLogLinesAtStart);
      const decisionLines = lines.filter((l) => l.includes("seat-line: gate decision"));
      lockWaitsMs = decisionLines.flatMap((l) => {
        const m = /lockWaitMs"?[:=]\s*(\d+)/.exec(l);
        return m ? [Number(m[1])] : [];
      });
      gateLevel = gateLevels(decisionLines);
      gateDecisions = {};
      for (const l of decisionLines) {
        const d = /decision"?[:=]\s*"?(\w+)/.exec(l)?.[1] ?? "unknown";
        gateDecisions[d] = (gateDecisions[d] ?? 0) + 1;
      }
      busyRefusals = lines.filter((l) => l.includes("seat-line: gate lock busy")).length;
    }
    const perBatch = [...new Set(round.boards.map((b) => b.times!.batch))].sort((a, b) => a - b).map((batch) => {
      const mine = players.filter((p) => p.board.times!.batch === batch);
      const idx = round.boards.map((b, i) => ({ b, i })).filter(({ b }) => b.times!.batch === batch).map(({ i }) => i);
      const after = idx.flatMap((i) => {
        const st = boardStates[i]!;
        return st.bothSeatedAt !== null && st.gameSeenAt !== null ? [st.gameSeenAt - st.bothSeatedAt] : [];
      });
      return {
        batch,
        boards: idx.length,
        arrivalToSeatedMs: spread(mine.map((p) => p.checkInMs).filter((x): x is number => x !== null)),
        bothSeatedToGameMs: spread(after),
      };
    });
    const capacity = {
      scenario: SCENARIO,
      strict: STRICT,
      openedAgoS: OPENED_AGO_S,
      staggeredOverride: STAGGERED_OVERRIDE,
      boardWindows: round.boards.map((b) => ({ rank: b.rank, ...b.times! })).filter((_, i) => i % 5 === 0),
      creates: { ...creates, afterSeatMs: spread(creates.afterSeatMs) },
      batchWait: { playersWhoWaitedForTheirBatch: players.filter((p) => p.waitedForBatch).length, claimsAnsweredCheckinNotOpen: claimsBeforeOpen },
      stays: { total: allTracks.length, withAdmission: admittedAts.length, rejoinerStays: stayFacts.filter((x) => x.rejoiner).length },
      order: { inversions, reorders, positionsLooked: rises.looked, rises: { excused: rises.excused.length, unexcused: rises.unexcused.length, excusedCauses: rises.excused.map((r) => r.cause), unexcusedRises: rises.unexcused.map((r) => ({ ...r, stay: stayFacts.find((x) => x.id === r.id) ?? null, neighbours: stayFacts.filter((x) => x.id !== r.id && x.queuedAt !== null && x.queuedAt > r.between[0] - 1_000 && x.queuedAt <= r.between[1] + 1_000).map((x) => ({ queuedAfterShownMs: x.queuedAt! - r.between[0], arrivedBeforeMineMs: (stayFacts.find((m) => m.id === r.id)?.firstClaimAt ?? 0) - x.firstClaimAt, rejoiner: x.rejoiner })) })) } },
      cost: {
        stays: costVerdict.stays,
        reservation: LINE_LOAD.reservation,
        recheckCost: LINE_LOAD.recheckCost,
        max: costVerdict.max,
        distribution: costVerdict.distribution,
        overReservation: costVerdict.over.map((c) => ({ id: c.id, own: c.own, unreserved: c.unreserved })),
        overRecheck: costVerdict.overRecheck.map((c) => ({ id: c.id, recheck: c.recheck, unreserved: c.unreserved })),
        withUnreservedClientSpend: costs.filter((c) => c.unreserved.length > 0).length,
      },
      drain: { drainedAtSecond: drain.drainedAt === null ? null : Math.round((drain.drainedAt - startedAt) / 100) / 10, maxInFlightDrained: drain.maxInFlightDrained, ledgerSamples: drain.samplesChecked },
      pace: { ...pace, checkInCalls, requiredPlayers, perPlayerCalls: perPlayerCalls === null ? null : Math.round(perPlayerCalls * 100) / 100 },
      nettingOwed: netting,
      timeToLastSeatS,
      bound: bound ? { ...bound, perPlayer: Math.round(bound.perPlayer * 100) / 100, lag: Math.round(bound.lag * 10) / 10, lagSpec: Math.round(bound.lagSpec * 10) / 10, bound: Math.round(bound.bound * 10) / 10, withinBound: timeToLastSeatS === null ? null : timeToLastSeatS <= bound.bound } : null,
      eta: { ...eta, items: etaItems.length, warnings: warningStats(players.map((p) => p.claimLog)) },
      busiestSecond: busiest,
      peakTransactionsPerSecond: Math.round(peakXactPerS * 10) / 10,
      line: { rows: lineRows.total, stamped: lineRows.stamped, stampedOnOffOrOptional: stampedOffOrOptional, heldStays: held, minGateLevel: gateLevel?.min ?? null, gateDecisionsWithLevel: gateLevel?.decisions ?? 0 },
      // What each bar family read, beside the family's own applicability - the report is written before the bars run, so a red leg still says what it saw.
      bars: {
        owed: bars,
        derivation: DRY_DERIVATION,
        read: {
          neverCreated: creates.neverCreated.length,
          lateCreates: creates.lateCreates.length,
          beyondStrandedBound: creates.beyondStrandedBound.length,
          heldStays: held,
          minGateLevel: gateLevel?.min ?? null,
          gateDecisionsWithLevel: gateLevel?.decisions ?? 0,
          admissionPairs: inversions.pairs,
          unexcusedInversions: inversions.unexcused.length,
          positionsLooked: rises.looked,
          unexcusedRises: rises.unexcused.length,
          staysCosted: costVerdict.stays,
          overReservation: overWithoutReason.length,
          overRecheck: overRecheckWithoutReason.length,
          busyRefusals: busyRefusals ?? 0,
        },
      },
      walkovers: { boardsWithAPlayerNeverSeated: unseatedBoards.length, withAForfeitEvent: walkoverEvents.filter((n) => n > 0).length },
      closedDoors: players.filter((p) => p.closedAt !== null).length,
      // A closed door told apart: a first claim made too late for ANY camera (seconds before the deadline) is the edge of the window, not the line.
      closedPlayers: players
        .filter((p) => p.closedAt !== null)
        .map((p) => ({
          claims: p.claims,
          firstClaimBeforeDeadlineS: p.firstClaimAt === null ? null : Math.round(((p.board.times!.deadlineAt - p.firstClaimAt) / 1_000) * 10) / 10,
          closedAfterDeadlineS: Math.round(((p.closedAt! - p.board.times!.deadlineAt) / 1_000) * 10) / 10,
          wasHeld: (stayOfPlayer.get(p)?.queuedAt ?? null) !== null,
        })),
      perBatch,
      servedAfterAdmitS: spread(servedAfterAdmitS),
      lateFlips,
      poolAtQueuedAnswers: { n: poolAtQueued.length, median: poolAtQueued.length === 0 ? null : percentile(poolAtQueued, 50) },
      gateLock: { decisions: gateDecisions, waitMs: lockWaitsMs.length === 0 ? null : { n: lockWaitsMs.length, p95: percentile(lockWaitsMs, 95), max: Math.max(...lockWaitsMs) }, busyRefusals },
    };
    const sweepMintRetries = sweepRuns.reduce((n, s2) => n + (((s2.report as { mintRetries?: number }).mintRetries) ?? 0), 0);
    const report = {
      config: { policyMix: POLICY_MIX, metered: METERED, boards: BOARDS, players: players.length, plies: PLIES, arrivalSpreadS: ARRIVAL_SPREAD_S, thinkS: [THINK_MIN_S, THINK_MAX_S], seed: SEED, cameraLagS: CAMERA_LAG_S, reportsFinal: REPORTS_FINAL, evidenceWaitS: EVIDENCE_WAIT_S },
      runSeconds,
      note: runSeconds < LOAD_LIMITS.windowMs / 1_000 ? "the run is shorter than five minutes: the busiest 5 minutes is the whole run" : "the run is longer than five minutes",
      lichess: {
        total: lichessCalls.length,
        creates: lichessCreates.length,
        busiestTenMinutesOfCreates: lichessCreateWin.max,
        busiestFiveMinutes: lichessWin.max,
        busiestMinute: lichess60.max,
        perEndpoint: groupCalls(lichessCalls),
        perFiveMinuteWindow: callsPerWindow(lichessCalls.map((c) => c.at), startedAt, LOAD_LIMITS.windowMs),
      },
      realtimekit: {
        total: videoCalls.length,
        ceiling: LOAD_LIMITS.rtkCeiling,
        vendorLimit: LOAD_LIMITS.rtkVendor,
        busiestFiveMinutes: videoWin.max,
        busiestMinute: video60.max,
        perEndpoint: groupCalls(videoCalls),
        perFiveMinuteWindow: callsPerWindow(videoCalls.map((c) => c.at), startedAt, LOAD_LIMITS.windowMs),
        perPlayerCheckIn: Math.round((perPhase["check-in"].realtimekit / players.length) * 10) / 10,
      },
      perPhase,
      // What the call budget (burst 300, 2/s) would have pushed back on, had the fixture host been metered. OPEN LOOP:
      // a refused call is not retried here, in the product it comes back after the back-off, so this is the demand the
      // bucket would have deferred - not a count of what the product deferred. `byPhase` splits it where the demand is.
      budgetReplay: {
        bucket: { burst: LOAD_LIMITS.rtkBurst, refillPerS: LOAD_LIMITS.rtkRefillPerS },
        granted: replay.granted,
        wouldDefer: replay.refused,
        firstDeferAtSecond: replay.refusedAt.length > 0 ? Math.round((replay.refusedAt[0]! - startedAt) / 100) / 10 : null,
        byPhase: Object.fromEntries(phases.map(([name, from, to]) => [name, replay.refusedAt.filter((t) => t >= from && t < to).length])),
      },
      evidence: {
        meetings: evidence.total,
        ended: evidence.ended,
        settled: evidence.settled,
        waitedSeconds: Math.round((times.evidenceSettled! - times.allResults!) / 100) / 10,
        sweepPassesToSettle: evidenceChecks,
        cameraFlagsWritten: flagRow!.n,
        realtimekitCallsInsideSweepPasses: sweepFixtureCalls.length,
        perEndpointInsideSweepPasses: groupCalls(sweepFixtureCalls),
      },
      byPolicy,
      sweepMintRetries,
      budget: {
        metered: METERED,
        seatDeferrals,
        optionalTileDeferrals,
        sweepDeferred,
        bucketTokensAtEnd: bucketRow ? Math.round(bucketRow.tokens * 10) / 10 : null,
      },
      checkIn: {
        playersSeated: checkInSamples.length,
        arrivalToSeatedMs: checkInSamples.length > 0 ? { p50: percentile(checkInSamples, 50), p95: percentile(checkInSamples, 95), max: Math.max(...checkInSamples) } : null,
        represses: { total: players.reduce((a, p) => a + p.represses, 0), max: Math.max(...players.map((p) => p.represses)), playersWhoPressed: players.filter((p) => p.represses > 0).length },
        startingAnswers: seatAnswers.camera_starting ?? 0,
        requiredAnswers: seatAnswers.camera_required ?? 0,
      },
      latencyMs: { "room read": lat("room read"), "seat claim": lat("seat claim"), move: lat("move"), resign: lat("resign"), sweep: lat("sweep") },
      seatAnswers,
      rtkHeadroom: {
        callsPerBoard: Math.round((videoCalls.length / BOARDS) * 10) / 10,
        boardsPerCeilingIn5Min: Math.floor(LOAD_LIMITS.rtkCeiling / (videoCalls.length / BOARDS)),
        boardsPerBurstOf300: Math.floor(300 / ((perPhase["check-in"].realtimekit + 0) / BOARDS)),
      },
      claimsPerPlayer: { min: Math.min(...players.map((p) => p.claims)), max: Math.max(...players.map((p) => p.claims)), total: players.reduce((a, p) => a + p.claims, 0) },
      database: { peakConnections, samples: dbSamples.length, prodBudget: LOAD_LIMITS.dbConnectionBudget, peakActive: dbSamples.reduce((m, s) => Math.max(m, s.active), 0), peakIdleInTx: dbSamples.reduce((m, s) => Math.max(m, s.idleInTx), 0) },
      sweep: {
        passes: sweepPasses.length,
        skippedByTheLock: sweepPasses.filter((s) => s.skipped).length,
        durationsMs: sweepRuns.map((s) => s.ms),
        callsDuringEachPass: sweepRuns.map((s) => ({
          lichess: lichessCalls.filter((c) => c.at >= s.at && c.at <= s.at + s.ms).length,
          realtimekit: videoCalls.filter((c) => c.at >= s.at && c.at <= s.at + s.ms).length,
        })),
        reports: sweepRuns.map((s) => s.report),
      },
      requests: { total: samples.length, non2xx: samples.filter((s) => s.status < 200 || s.status >= 300).length, byLabel: Object.fromEntries(["room read", "seat claim", "move", "resign", "sweep"].map((l) => [l, samples.filter((s) => s.label === l).length])) },
      capacity,
      failures,
    };
    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    // LOAD_DUMP_CALLS=1: every recorded vendor call with its time, for digging into a number the report only sums.
    if (process.env.LOAD_DUMP_CALLS === "1") {
      writeFileSync(REPORT.replace(/\.json$/, "") + "-calls.json", JSON.stringify({ startedAt, lichess: lichessCalls, realtimekit: videoCalls, sweepPasses: sweepPasses.map((p) => ({ at: p.at, ms: p.ms, skipped: p.skipped })) }));
    }
    console.log(`[D22 load] ${JSON.stringify({ ...report, lichess: { ...report.lichess, perFiveMinuteWindow: undefined }, realtimekit: { ...report.realtimekit, perFiveMinuteWindow: undefined } }, null, 1)}`);

    // ---------------------------------------------------------------------------------------------- invariants
    expect(failures, "nothing a player would have seen go wrong").toEqual([]);
    // A run that is not STRICT (A-slow, B-end) RECORDS what the line did: a board whose player was never seated has no game, no result and
    // no seat, and that is the answer being measured. Every board that DID get a game is held to the same standard as ever.
    const playedBoards = round.boards.filter((_, i) => boardStates[i]!.gameSeenAt !== null);
    const PLAYED = STRICT ? BOARDS : playedBoards.length;
    expect(PLAYED, "anti-vacuity: some board was played").toBeGreaterThan(0);
    expect(lichess.games().length, "a Lichess game per played board").toBe(PLAYED);
    expect(lichess.games().filter((g) => g.status === "resign").length, "every game ended by the resign").toBe(PLAYED);
    for (const b of playedBoards) {
      expect(await resultEventCountSql(b.fixtureId), `board ${b.fixtureId}: one result written`).toBe(1);
      expect(await forfeitEventCountSql(b.fixtureId), `board ${b.fixtureId}: a resign is never a forfeit`).toBe(0);
    }
    expect(samples.filter((s) => s.status >= 500 || s.status === 0).length, "no 5xx and no dropped request").toBe(0);
    expect(lichessCreates.length, "one challenge per played board").toBe(PLAYED);
    expect(lichessCreateWin.max, "Lichess creates in any ten minutes, under 500 per IP").toBeLessThan(LOAD_LIMITS.lichessCreatesPer10Min);
    expect(videoWin.windows, "anti-vacuity: RealtimeKit was called").toBeGreaterThan(players.filter((p) => p.policy !== "off").length);
    // Metered, the bucket is what keeps the calls that LEAVE the platform under the ceiling: this is the budget working.
    // Unmetered, the run measures demand and the ceiling is a finding (budgetReplay says what would have been deferred).
    if (METERED) expect(videoWin.max, "RealtimeKit calls made in any five minutes are under OUR ceiling (video/budget.ts)").toBeLessThanOrEqual(LOAD_LIMITS.rtkCeiling);
    expect(videoWin.max).toBeLessThan(LOAD_LIMITS.rtkVendor);
    if (STRICT) expect(checkInSamples.length, "every player got a seat").toBe(players.length);
    expect(checkInSamples.length, "anti-vacuity: some player got a seat").toBeGreaterThan(0);
    expect(dbSamples.length, "anti-vacuity: the connection sampler looked").toBeGreaterThan(10);
    expect(peakConnections, "database connections at the peak, under the production budget").toBeLessThan(LOAD_LIMITS.dbConnectionBudget);
    expect(sweepRuns.length, "anti-vacuity: at least one sweep pass ran to the end").toBeGreaterThan(0);
    if (STRICT) {
      expect(evidence.total, "anti-vacuity: every board with a camera has a meeting PER PLAYER (D16)").toBe(meetingIds.length * MEETINGS_PER_BOARD);
      expect(evidence.both, "and the two are one of each side").toBe(meetingIds.length);
      expect(evidence.ended, "teardown: every meeting ended").toBe(meetingIds.length * MEETINGS_PER_BOARD);
      if (REPORTS_FINAL) expect(evidence.settled, "the sweep read every REQUIRED board's camera evidence, both rooms").toBe(requiredIds.length * MEETINGS_PER_BOARD);
    } else {
      expect(evidence.total, "anti-vacuity: meetings exist").toBeGreaterThan(0);
    }
    // D21-fix-3: no board stranded, no wrong refusal, and every optional seat the budget left tokenless got its tile.
    for (const [policy, row] of Object.entries(byPolicy)) {
      if (STRICT) expect(row.boardsWithoutGame, `${policy}: every board got a game`).toBe(0);
      expect(row.wrongRefusals, `${policy}: no wrong refusal`).toBe(0);
      expect(row.tokenlessStillWithoutTile, `${policy}: every tokenless optional seat got its tile before its game ended`).toBe(0);
    }
    expect(flagRow!.n, "honest cameras: the evidence wrote no flag").toBe(0);
    expect(replay.granted + replay.refused, "anti-vacuity: the replay saw every RealtimeKit call").toBe(videoCalls.length);
    if (METERED) {
      expect(bucketRow, "metered: the budget made a bucket for the fixture host (the flag took effect in the server)").toBeDefined();
      expect(replay.refused, "metered: what LEFT the platform fits the bucket - the replay of the calls made refuses none").toBe(0);
    }
    for (const s of sweepRuns) {
      expect((s.report as { failures?: unknown[] }).failures ?? [], "a sweep pass under load fails nothing").toEqual([]);
      expect((s.report as { failed?: number }).failed, "and its counter agrees").toBe(0);
    }
    expect(percentile(samples.filter((s) => s.label === "room read").map((s) => s.ms), 95), "a room read does not stall (smoke guard, not an SLO)").toBeLessThan(3_000);
    expect(percentile(samples.filter((s) => s.label === "move").map((s) => s.ms), 95), "a move does not stall (smoke guard, not an SLO)").toBeLessThan(5_000);

    // ------------------------------------------------------------------------------------------ the capacity pass bars (§5.6.8)
    // Anti-vacuity first: a run that looked at nothing proves nothing.
    expect(creates.boards, "capacity: boards classified (zero is a failure)").toBe(BOARDS);
    expect(drain.samplesChecked, "capacity: the ledger sampler read the table (at least every 500 ms)").toBeGreaterThan(10);
    expect(stayTracks.size, "capacity: stays tracked").toBeGreaterThan(0);
    expect(requiredPlayers, "capacity: players on a Required board").toBeGreaterThan(0);
    expect(claimsBeforeOpen, "the batch-wait card holds the claim until the door is open: no seat claim met a shut door by more than a skew").toBeLessThanOrEqual(players.length);
    if (STRICT) {
      expect(creates.neverCreated, "never created: 0").toEqual([]);
      expect(creates.lateCreates, "late creates: 0").toEqual([]);
      expect(creates.beyondStrandedBound, "a late create beyond the stranded arm's bound: 0").toEqual([]);
      expect(creates.unresolved, "the run proved something about every board").toEqual([]);
      expect(creates.notBothSeated, "every board had both players seated").toBe(0);
    }
    // B, B-slow and B-honest (B with the 1-3 s cameras of D16: its 10 calls a stay drain the bucket, where instant cameras' 7 only just fit) are the burst runs;
    // which bars each owes is barsOf's (line-load.ts), by the shape of its run: the ORDER bars need a line with two or more stays waiting, so they belong
    // to the legs where it forms (B-honest, B-slow-*); B, whose instant cameras sit a few tokens from dry, owes none of these (its held count and lowest gate
    // level are RECORDED in the report); B-dry, short of tokens by derivation, owes the dry bars below.
    if (STRICT && bars.order) {
      expect(inversions.pairs, `capacity ${SCENARIO}: admission pairs checked (zero pairs is a failure)`).toBeGreaterThan(0);
      expect(inversions.unexcused, `capacity ${SCENARIO}: admission inversions: 0 (excuses counted apart in the report)`).toEqual([]);
      expect(rises.looked, `capacity ${SCENARIO}: positions looked at (zero is a failure)`).toBeGreaterThan(0);
      expect(rises.unexcused, `capacity ${SCENARIO}: unexcused position rises: 0`).toEqual([]);
    }
    if (STRICT && bars.dry) {
      expect(held, `capacity ${SCENARIO}: the dry bucket was met and a stay was held for it (held stays; zero would leave the late-create bar vacuous)`).toBeGreaterThan(0);
      expect(gateLevel?.decisions ?? 0, `capacity ${SCENARIO}: gate decisions that carried a bucket level (zero is a failure: the level bar below would read nothing)`).toBeGreaterThan(0);
      expect(gateLevel?.min ?? Number.POSITIVE_INFINITY, `capacity ${SCENARIO}: the gate saw the bucket below LINE_COMPLETING_LEVEL (${LINE_LOAD.completingLevel}) at least once`).toBeLessThan(LINE_LOAD.completingLevel);
    }
    if (STRICT && bars.cost) {
      expect(costVerdict.stays, "capacity B: stays costed (the 60 players: zero is a failure)").toBe(requiredPlayers);
      expect(overWithoutReason.map((c) => c.id), "capacity B: a stay above its reservation with no unreserved claim to explain it: 0").toEqual([]);
      expect(overRecheckWithoutReason.map((c) => c.id), "capacity B: a re-verify above LINE_RECHECK_COST with no unreserved claim to explain it: 0").toEqual([]);
      expect(busyRefusals ?? 0, "capacity B: gate lock busy refusals: expected 0").toBe(0);
    }
    if (STRICT && SCENARIO.startsWith("B-slow") && bound) {
      expect(timeToLastSeatS, "B-slow: the drain time was measured").not.toBeNull();
      expect(timeToLastSeatS!, `B-slow: first claim to last seat within the run's own bound (${bound.bound.toFixed(1)} s)`).toBeLessThanOrEqual(bound.bound);
      if (CAMERA_WARMUP_S! >= 10) {
        expect(bound.discriminates, "B-slow at 10 s: the sum model (n x warm-up) is above the bound, so the bound tells a window from a single head").toBe(true);
        expect(drain.maxInFlightDrained, "B-slow at 10 s: the budget kept at least two stays in flight over the drained phase").toBeGreaterThanOrEqual(2);
      }
    }
    if (SCENARIO === "regress" || SCENARIO === "mixed") {
      expect(lineRows.total, "regress: the line's table has rows (the stays were recorded; zero would mean the line never ran at all)").toBeGreaterThan(0);
      expect(lineRows.stamped, "regress: 0 rows with queued_at or admitted_at - the line stays inert when it is not needed").toBe(0);
      expect(stampedOffOrOptional, "no off or optional player has a held or admitted row").toBe(0);
      if (seatDeferrals !== null) expect(seatDeferrals, "regress: 0 deferrals").toBe(0);
      // The call count is the spec's own: 605 for twenty Required boards (D22), 366 for the mix (D16's load C). Within a tenth.
      const expectedCalls = SCENARIO === "regress" ? 605 : 366;
      expect(videoCalls.length, `regress: about ${expectedCalls} RealtimeKit calls`).toBeGreaterThan(expectedCalls * 0.9);
      expect(videoCalls.length, `regress: about ${expectedCalls} RealtimeKit calls`).toBeLessThan(expectedCalls * 1.1);
    }
  } finally {
    stop = true;
    await monitorDone.catch(() => undefined);
    await ledgerDone.catch(() => undefined);
    await monitor.end({ timeout: 5 }).catch(() => undefined);
    await lichess.close().catch(() => undefined);
    await video.close().catch(() => undefined);
  }
});
