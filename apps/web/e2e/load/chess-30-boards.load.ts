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
 * players' browsers would: each player claims the seat on their personal link, joins the (fixture) meeting when told
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
 * uniformly over this), LOAD_THINK_MIN_S / LOAD_THINK_MAX_S (1.5 / 4), LOAD_SWEEP_EVERY_S (40), LOAD_SWEEP_FIRST_S (30, or the cadence if shorter: where the first pass falls), LOAD_SEED (1),
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
 * THE DEFAULT RUN (30 Required boards, a 60 s arrival, metered) IS EXPECTED RED AT HEAD, and the red is the finding, not a
 * fault of the run or of the server. The platform's call budget (burst 300 + 2 a second) carries about 24 boards a minute
 * clean (D21-fix-3 report, runs B, C and E); 60 players asking inside a minute are more than it holds, so seats are deferred
 * (`camera_starting`), players re-ask and re-press, and every board DOES get its game - but 195-290 s after both players were
 * seated (seat p95 223-274 s against the 30 s target), past this run's own wait (GAME_WAIT_MS). So "every board got a game"
 * fails (3 boards in run B, 6 in run E), and with a long wait the replay assertion can fail by the ONE sub-token refusal at
 * the instant the bucket first empties (run C: a granularity artefact of the replay, 1 call of 1,237). The capacity answer is
 * the owner's (the reserved create lane, the all-or-nothing read and the client re-claim net, all proposals in the
 * D21-fix-3 report); do not "fix" this run by loosening an assertion or tuning the config. The runs that ARE expected green
 * are LOAD_BOARDS=20 (run A: 486 calls in the busiest five minutes, 0 deferrals, seat p95 7.9 s, 0 stranded) and the mixed
 * LOAD_POLICY_MIX=required:10,optional:10,off:10 (run D: 311 calls, 0 deferrals) - re-run those after a change to the seat
 * path, the budget, the sweep or the room's cadence, and compare with these numbers.
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

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name}=${raw} is not a number`);
  return n;
};

const BOARDS = num("LOAD_BOARDS", 30);
const PLIES = num("LOAD_PLIES", 20);
const ARRIVAL_SPREAD_S = num("LOAD_ARRIVAL_SPREAD_S", 60);
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

type Seat = {
  seated: boolean;
  reason?: string;
  participant?: { participantId: string; authToken: string } | null;
  /** D21-fix-3: an optional camera seated with no token because the call budget was spent - a token can still come. */
  cameraRetry?: boolean;
};
type Snapshot = {
  you: { colour: "white" | "black" };
  canAct: boolean;
  game: { moves: string[]; over: boolean } | null;
  result: unknown | null;
};

type Player = {
  info: RoundPlayer;
  board: RoundBoard;
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
    const allBoards: (RoundBoard & { policy: Policy })[] = [];
    let used = 0;
    for (const mix of POLICY_MIX) {
      const part = await seedOnlineRound(request, names.slice(used * 2, (used + mix.boards) * 2), { camera: mix.policy, playable: true, stage: "swiss" });
      expect(part.boards.length, `anti-vacuity: the ${mix.policy} round paired every player`).toBe(mix.boards);
      for (const b of part.boards) allBoards.push({ ...b, policy: mix.policy });
      used += mix.boards;
    }
    const round = { boards: allBoards };
    expect(round.boards.length, "anti-vacuity: every board of every policy").toBe(BOARDS);
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

    /** The check-in screen as a player lives it (room-shell.tsx): claim; a refusal for want of a camera, once the camera
     *  is up, is re-claimed SEAT_RETRIES times; `camera_starting` is re-asked on the back-off at most MAX_POLLS times;
     *  past either bound the screen offers the check-in button and the player presses it (`represses`), which resets
     *  both budgets. The two budgets are per participant and are NOT reset by the answer changing from one to the other. */
    async function checkIn(p: Player): Promise<void> {
      await sleep(p.arriveAfterMs);
      const began = Date.now();
      let joined = false;
      let polls = 0;
      let retries = 0;
      for (let guard = 0; guard < 300; guard += 1) {
        // Like the real room (use-room.ts claim): the id of the participant whose token the browser holds goes with every claim.
        const res = await http<{ data?: { snapshot: Snapshot; seat: Seat | null } }>(
          "seat claim",
          p.roomUrl,
          "POST",
          p.participantId !== null ? { heldParticipantId: p.participantId } : undefined,
        );
        p.claims += 1;
        const data = res.body.data;
        if (res.status !== 200 || !data) {
          failures.push(`seat claim answered ${res.status} (${p.info.name})`);
          await sleep(SEAT_RETRY_MS);
          continue;
        }
        p.snapshot = data.snapshot;
        const seat = data.seat;
        const answered = seat?.seated ? "seated" : (seat?.reason ?? "no seat answer");
        seatAnswers[answered] = (seatAnswers[answered] ?? 0) + 1;
        if (seat?.seated) {
          p.seatedAt = Date.now();
          p.checkInMs = p.seatedAt - began;
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
          polls = 0;
          retries = 0;
          await sleep(PRESS_MS[0] + random() * (PRESS_MS[1] - PRESS_MS[0]));
        };
        if (reason === "camera_required") {
          const part = seat?.participant;
          if (part && !joined) {
            p.participantId = part.participantId;
            await sleep(JOIN_MS[0] + random() * (JOIN_MS[1] - JOIN_MS[0]));
            if (CAMERA_LAG_S[1] <= 0) {
              video.setLivePublisher(part.participantId, true);
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
                } catch (e) {
                  if (!stop) failures.push(`camera report for ${p.info.name}: ${(e as Error).message}`);
                }
              }, lagMs);
            }
            joined = true;
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
          failures.push(`unexpected seat refusal ${reason} (${p.info.name})`);
          return;
        }
      }
      failures.push(`${p.info.name} never got a seat in 300 claims`);
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

    async function playBoard(boardIndex: number, home: Player, away: Player): Promise<void> {
      const plies = planPlies(boardIndex);
      let done = false;
      const pollers = [pollRoom(home, () => done), pollRoom(away, () => done)];
      await Promise.all([checkIn(home), checkIn(away)]);
      // Colours as the room reports them, never assumed from home/away. The first read after the seat has them.
      const byColour = (c: "white" | "black") => [home, away].find((p) => p.snapshot?.you.colour === c);
      const gameStartedBy = Date.now() + GAME_WAIT_MS;
      while (Date.now() < gameStartedBy && !(home.snapshot?.game && away.snapshot?.game)) await sleep(250);
      const white = byColour("white");
      const black = byColour("black");
      if (!white || !black || !(home.snapshot?.game && away.snapshot?.game)) {
        failures.push(`board ${boardIndex + 1}: no game after both seats`);
        done = true;
        await Promise.all(pollers);
        return;
      }
      times[`gameSeen.${boardIndex}`] = Date.now();
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
    const meetingIds = round.boards.filter((b) => b.policy !== "off").map((b) => b.fixtureId);
    const requiredIds = round.boards.filter((b) => b.policy === "required").map((b) => b.fixtureId);
    const evidenceState = async () => {
      const [row] = await monitor<{ total: number; ended: number; settled: number }[]>`
        select count(*)::int as total,
               count(*) filter (where ended_at is not null)::int as ended,
               count(*) filter (where camera_evidence_at is not null and fixture_id = any(${monitor.array(requiredIds)}::uuid[]))::int as settled
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
      if (!pass.skipped && evidence.ended === evidence.total && evidence.settled === requiredIds.length) break;
      await sleep(EVIDENCE_SWEEP_EVERY_S * 1_000);
    }
    times.evidenceSettled = Date.now();
    await sleep(3_000);
    times.end = Date.now();
    stop = true;
    await monitorDone;

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
    expect(lichess.games().length, "a Lichess game per board").toBe(BOARDS);
    expect(lichess.games().filter((g) => g.status === "resign").length, "every game ended by the resign").toBe(BOARDS);
    for (const b of round.boards) {
      expect(await resultEventCountSql(b.fixtureId), `board ${b.fixtureId}: one result written`).toBe(1);
      expect(await forfeitEventCountSql(b.fixtureId), `board ${b.fixtureId}: a resign is never a forfeit`).toBe(0);
    }
    expect(samples.filter((s) => s.status >= 500 || s.status === 0).length, "no 5xx and no dropped request").toBe(0);
    expect(lichessCreates.length, "one challenge per board").toBe(BOARDS);
    expect(lichessCreateWin.max, "Lichess creates in any ten minutes, under 500 per IP").toBeLessThan(LOAD_LIMITS.lichessCreatesPer10Min);
    expect(videoWin.windows, "anti-vacuity: RealtimeKit was called").toBeGreaterThan(players.filter((p) => p.policy !== "off").length);
    // Metered, the bucket is what keeps the calls that LEAVE the platform under the ceiling: this is the budget working.
    // Unmetered, the run measures demand and the ceiling is a finding (budgetReplay says what would have been deferred).
    if (METERED) expect(videoWin.max, "RealtimeKit calls made in any five minutes are under OUR ceiling (video/budget.ts)").toBeLessThanOrEqual(LOAD_LIMITS.rtkCeiling);
    expect(videoWin.max).toBeLessThan(LOAD_LIMITS.rtkVendor);
    expect(checkInSamples.length, "every player got a seat").toBe(players.length);
    expect(dbSamples.length, "anti-vacuity: the connection sampler looked").toBeGreaterThan(10);
    expect(peakConnections, "database connections at the peak, under the production budget").toBeLessThan(LOAD_LIMITS.dbConnectionBudget);
    expect(sweepRuns.length, "anti-vacuity: at least one sweep pass ran to the end").toBeGreaterThan(0);
    expect(evidence.total, "anti-vacuity: every board with a camera has a meeting").toBe(meetingIds.length);
    expect(evidence.ended, "teardown: every meeting ended").toBe(meetingIds.length);
    if (REPORTS_FINAL) expect(evidence.settled, "the sweep read every REQUIRED board's camera evidence").toBe(requiredIds.length);
    // D21-fix-3: no board stranded, no wrong refusal, and every optional seat the budget left tokenless got its tile.
    for (const [policy, row] of Object.entries(byPolicy)) {
      expect(row.boardsWithoutGame, `${policy}: every board got a game`).toBe(0);
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
  } finally {
    stop = true;
    await monitorDone.catch(() => undefined);
    await monitor.end({ timeout: 5 }).catch(() => undefined);
    await lichess.close().catch(() => undefined);
    await video.close().catch(() => undefined);
  }
});
