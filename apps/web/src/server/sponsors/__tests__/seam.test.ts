// R4 sponsors on stream, S15 — THE WHOLE CHAIN, driven for real (AGENTS.md class 1, spec 2026-10-27 §7 "Seam, driven for
// real"; the S15 brief's Step 1 and the controller's 2026-11-01 addendum: plan → airing → click → overview → report).
//
// One cricket match, one composed session, two ticked sponsors on Busy. Nothing below hand-builds a plan, a break, a moment
// list, a wire line, an airing row, a click row or a figure. What IS the test's own: the page's clock, and the queue hook's
// React shell, replayed by hand below from use-moment-queue's dispatch rules:
//
//   the organiser's writes  createSponsor + patchSponsor (the tick, R12's org row) + putStreamSettings (Busy)
//   the scorer's writes     appendEvent: six legal balls (Law 17.1: an over is six) — the engine's own `opensAt` opens the
//                           break in the fold's replay
//   the plan                loadOverlayLiveData at the relay door (the composed page's) and the public door (OBS's): the
//                           REAL loader, so S5 writes the assignment and mints the card's short code
//   the page                `stageIncoming` (lib/overlay-incoming.ts) — the very function overlay-stage.tsx composes its
//                           list with — over the loader's payload; the REAL momentQueueReducer, dispatched the way
//                           `use-moment-queue` does (sync + enqueue only when `incomingKey` changes, one tick per deadline,
//                           a re-poll between ticks); and the REAL `sponsorQueueLines` over each committed state — the lines
//                           the compositor host prints
//   the compositor          SC1's conversion (the line's name is `kind`, its JSON the rest), wrapped as a `RelayHeartbeat`
//                           body and parsed by the route's own schema, handed to the REAL `heartbeat` usecase
//   proof of play           the `sponsor_airings` row, read back
//   the viewer              the card's printed short link (`sponsorShortLinkText`), typed into the REAL `/s/[key]` handler;
//                           the `sponsor_clicks` row, read back
//   the organiser's numbers S13's `sponsorOverview` and S14's `sponsorReport`, over the rows above
//
// EXPECTATIONS ARE DECLARATIONS, never a typed table (TEST-STRATEGY rule 2): the break's size is the cricket module's
// `naturalBreaks` (over_end); its style and hold are `SPONSOR_STYLE_BY_SIZE[size]`; the first card is the heavier tier by
// `SPONSOR_TIER_WEIGHTS` (P7: smooth weighted round robin picks the highest weight first); the card airs after BOTH beats
// of the end-of-over card (spec §3.4: the score moment at the same event goes first), so its start is timed by
// `END_OF_OVER_HOLD_MS` and `OVERLAY_MOMENT_FOLD_MS`; time on screen is the card's hold plus its fold out (the end line is
// written once the card has left `out`). The cooldown is `SPONSOR_COOLDOWN_MS`, the gap between the two breaks is read off
// the breaks the loader handed the planner.
//
// THE SEQUENCE (TEST-STRATEGY rule 1): the empty case first (cards served, no airing, no line), then the over, a re-poll
// mid-showing (writes nothing twice, logs nothing twice), the start and end beats, then a SECOND over inside the cooldown
// (a real break, no second card, no second line, no second row), then the click and the figures.
//
// ONE SPORT, on purpose: the chain past the planner reads no sport (S8 joins on the moment id, S10 on the code, S13/S14 on
// the rows). The other sports' breaks reach this same planner through S5's and S12's seams (hockey, volleyball).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
// The loader's sponsor entry, passed through untouched: read only to see the BREAKS the fold handed the planner (the
// cooldown premise — a second card missing for want of a break would pass the cooldown check vacuously).
vi.mock("@/server/sponsors/assign", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/sponsors/assign")>();
  return { ...actual, loadFixtureSponsorPlan: vi.fn(actual.loadFixtureSponsorPlan) };
});
// The /s/ route's click write is `deferred()` tail work; held here and run on `flush()`, so "the row landed" is a fact and
// not a race (the S10 route test's convention).
const tail = vi.hoisted(() => ({ tasks: [] as Array<() => unknown> }));
vi.mock("@/lib/deferred", () => ({
  deferred: (fn: () => unknown) => {
    tail.tasks.push(fn);
  },
}));

import { sql } from "@/lib/db";
import { cricket } from "@seazn/engine/sports/cricket";
import { RelayAiring, RelayHeartbeat } from "@/server/api-v1/schemas";
import { SIGNAL_SPONSOR_END, SIGNAL_SPONSOR_START, sponsorQueueLines } from "@/lib/overlay-compositor";
import { maxSeq, momentsFor, type OverlayMoment } from "@/lib/overlay-moments";
import { END_OF_OVER_HOLD_MS, closedOverBaselineOf } from "@/lib/overlay-end-of-over";
import { incomingKey, stageIncoming } from "@/lib/overlay-incoming";
import {
  SPONSOR_COOLDOWN_MS, SPONSOR_STYLE_BY_SIZE, sponsorMomentId, type BreakOpened, type SponsorPlan,
} from "@/lib/sponsor-plan";
import { SPONSOR_TIER_WEIGHTS } from "@/lib/sponsor-tiers";
import { SPONSOR_SHORT_CODE_PATTERN } from "@/lib/sponsor-short-code";
import { sponsorLinkHost, sponsorShortLinkText } from "@/lib/sponsor-clicks";
import { isoDay } from "@/lib/sponsor-report";
import { INITIAL, momentQueueReducer, type MomentQueueState, type QueueAction } from "@/components/overlay/moment-queue";
import { OVERLAY_MOMENT_FOLD_MS, OVERLAY_MOMENT_HOLD_MS } from "@/components/overlay/moment-timing";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import { appendEvent } from "@/server/engine-db/append-event";
import { loadOverlayLiveData } from "@/server/overlay/load";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { pairPresentPhone } from "@/server/relay/__tests__/_session-rig";
import { override, phoneId } from "@/server/usecases/__tests__/_capture-rig";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { putLineup } from "@/server/usecases/fixtures";
import { startDivision } from "@/server/usecases/schedule";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { ensureStreamCode } from "@/server/usecases/stream-codes";
import { grantCredits } from "@/server/usecases/stream-credits";
import { createSession, heartbeat, type SessionDeps } from "@/server/usecases/stream-sessions";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { createSponsor, patchSponsor } from "@/server/usecases/sponsors";
import { GET as sponsorLinkRoute } from "@/app/s/[key]/route";
import { loadFixtureSponsorPlan } from "../assign";
import { putStreamSettings } from "../stream-settings";
import { createReportLink, sponsorOverview, sponsorReport } from "../report";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "RELAY_DRIVERS", "RELAY_IMAGE"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "sponsor-seam-test-secret";
  // A composed start is refused 503 composed_unavailable while RELAY_IMAGE is unset; the fake runner needs no real image.
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:sponsor-seam-test";
}
beforeAll(baseEnv);
beforeEach(() => {
  baseEnv();
  tail.tasks.length = 0;
});
afterEach(() => setRelayDriversForTest(null));
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const NEVER = 3_600_000;
/** Recording storage is one account-wide pool (the capture rig's ROOMY reasoning): roomy, so no start reads 503. */
const ROOMY_STORAGE_MINUTES = 100_000_000;
/** Review Focus 5's realistic sponsor name: 43 characters — the longest line the compositor's 512-byte reader takes. */
const LONG_NAME = "Harbourside Building Supplies and Timber Co";
/** Law 17.1: an over is six legal balls. */
const BALLS_PER_OVER = 6;

/** The size cricket DECLARES for a kind (engine 1.1.0), read off the module. */
function cricketSize(kind: string): "minor" | "major" {
  const k = cricket.naturalBreaks?.kinds.find((d) => d.kind === kind);
  if (k === undefined) throw new Error(`cricket declares no "${kind}"`);
  return k.size;
}

/** Runs every queued tail write to completion — and rethrows, unlike the real `deferred()`. */
async function flush(): Promise<number> {
  const held = tail.tasks.splice(0);
  for (const fn of held) await fn();
  return held.length;
}

/** SC1's conversion (spec §3.6.2, brief P6): the line's name is `kind`, its JSON the rest — parsed by the contract twin. */
function itemOf(line: string): RelayAiring {
  const space = line.indexOf(" ");
  const signal = line.slice(0, space);
  if (signal !== SIGNAL_SPONSOR_START && signal !== SIGNAL_SPONSOR_END) throw new Error(`not a sponsor line: ${line}`);
  return RelayAiring.parse({ kind: signal === SIGNAL_SPONSOR_START ? "start" : "end", ...(JSON.parse(line.slice(space + 1)) as object) });
}

// ---------------------------------------------------------------------------------------------------------------------
// The rig: a Pro org (tiers allowed, so the D9 weights are in play), a PUBLIC cricket competition (OBS's door reads the
// public view), a started T20 with two players a side in each lineup, and a COMPOSED session (D10: proof of play comes
// from composed streams only) started through the organiser's real path on fake drivers and a tickable clock.
// ---------------------------------------------------------------------------------------------------------------------
async function cricketComposedRig() {
  const { auth } = await seedOrg("pro");
  await override(auth.orgId, "streaming.overlay", true);
  await override(auth.orgId, "streaming.relay", true);
  const suffix = randomUUID().slice(0, 6);
  const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: `Seam Cup ${suffix}`, visibility: "public", branding: {} });
  const division = await createDivision(auth, competition.id, { name: "T20", sport_key: "cricket", variant_key: "t20", config: {} } as never);
  const members = (label: string) =>
    Array.from({ length: 2 }, (_, i) => ({
      new_person: { full_name: `${label}${i + 1} ${suffix}`, dob: null, gender: null },
      squad_number: null, default_position_key: null, is_captain: false, roles: [] as string[],
    }));
  await createEntrants(auth, division.id, [
    { kind: "team", display_name: "Harbour XI", seed: 1, members: members("H") },
    { kind: "team", display_name: "Ridge XI", seed: 2, members: members("R") },
  ] as never);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} } as never);
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const fx = fixtures[0]! as { id: string; home_entrant_id: string; away_entrant_id: string };
  const roster = await sql<{ entrant_id: string; person_id: string }[]>`
    select entrant_id, person_id from entrant_members where entrant_id in ${sql([fx.home_entrant_id, fx.away_entrant_id])} order by person_id`;
  const side = (entrantId: string) => roster.filter((r) => r.entrant_id === entrantId).map((r) => r.person_id);
  for (const entrantId of [fx.home_entrant_id, fx.away_entrant_id]) {
    await putLineup(auth, fx.id, entrantId, { slots: side(entrantId).map((person_id) => ({ person_id, slot: "starting" as const, roles: [] as string[] })) } as never);
  }
  await startDivision(auth, division.id);

  // The stream: a credit, a destination, the code, a present phone, then the organiser's Go live (composed).
  await grantCredits({ orgId: auth.orgId, delta: 1, createdBy: auth.userId!, note: "S15 seam", idempotencyKey: randomUUID() });
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Club", streamKey: `yt-${randomUUID()}` });
  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: NEVER });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test" };
  await ensureStreamCode(auth, fx.id);
  await pairPresentPhone(fx.id, { phone: phoneId("s15"), at: new Date(now) });
  const { sessionId } = await createSession(auth, fx.id, { mode: "composed", targetId: target.id }, deps);
  const jobToken = runner.created[0]!.jobToken;

  let tip = 0;
  return {
    auth, orgId: auth.orgId, competitionId: competition.id, fixtureId: fx.id, sessionId,
    home: side(fx.home_entrant_id), away: side(fx.away_entrant_id),
    now: () => now,
    tick: (ms: number) => { now += ms; },
    /** `voids`: the id of the event a `core.void` takes back (the scorer's undo). */
    async append(type: string, payload: unknown, voids?: string) {
      const r = await appendEvent(auth.orgId, fx.id, tip, { type, payload, ...(voids === undefined ? {} : { voids }) });
      tip = r.seq;
      return r;
    },
    /** The Machine's beat: the body parsed by the twin the route parses with, then the REAL usecase. */
    beat: (body: Record<string, unknown>) => heartbeat(sessionId, jobToken, RelayHeartbeat.parse(body), deps),
  };
}
type Rig = Awaited<ReturnType<typeof cricketComposedRig>>;

/** One over of dot balls by the home pair off one away bowler. Dot balls never cross the batters, and they change ends
 *  at the end of each over (Law 17.1), so the striker alternates by over; a bowler never bowls two overs running. */
async function bowlOver(r: Rig, over: number) {
  let last: Awaited<ReturnType<Rig["append"]>> | null = null;
  for (let ballInOver = 1; ballInOver <= BALLS_PER_OVER; ballInOver++) {
    last = await r.append("cricket.ball", {
      over, ballInOver, striker: r.home[over % 2], nonStriker: r.home[(over + 1) % 2], bowler: r.away[over % 2], runs: { bat: 0 },
    });
  }
  return last!;
}

// ---------------------------------------------------------------------------------------------------------------------
// The page, as the compositor host runs it: the stage's `incoming` and the queue hook's dispatches, on the rig's clock.
// ---------------------------------------------------------------------------------------------------------------------
const msg = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

/** The stage's OWN composition (`stageIncoming`, lib/overlay-incoming.ts — the function overlay-stage.tsx calls) over the
 *  loader's payload, with the inputs a composed page in the `live` phase has: no scene, so no match card; no URL delay;
 *  the mount's tip and closed over. `msg` answers keys (copy is not under test here). */
function incomingFor(data: OverlayLiveData, mount: { tip: number; closed: ReturnType<typeof closedOverBaselineOf> }): readonly OverlayMoment[] {
  return stageIncoming({
    sportKey: "cricket",
    recent: data.recent,
    lastClosedOver: data.lastClosedOver,
    cricketToss: data.cricketToss,
    scoringStarted: data.scoringStarted === true,
    sponsorPlan: data.sponsorPlan ?? null,
    momentBaseline: mount.tip,
    closedOverBaseline: mount.closed,
    msg,
    sideShorts: ["HAR", "RID"],
    sideNames: ["Harbour XI", "Ridge XI"],
    showMatchCard: false,
    awaitingDelay: false,
  });
}

/** `use-moment-queue.ts`, minus React: a poll whose moment ids changed (`incomingKey`, the hook's own key) dispatches
 *  `sync` then `enqueue` (one commit) and a poll with the same ids dispatches NOTHING; each timer is one `tick`; every
 *  committed state goes through `sponsorQueueLines` — the lines the compositor host prints. The first poll always
 *  dispatches (the hook's effect runs on mount). */
function composedPage(clock: () => number, advance: (ms: number) => void) {
  const foldMs = OVERLAY_MOMENT_FOLD_MS;
  const holdMs = OVERLAY_MOMENT_HOLD_MS;
  let state: MomentQueueState = INITIAL;
  let onAir: string | null = null;
  let lastKey: string | null = null;
  const lines: { at: number; line: string }[] = [];
  const phases: { at: number; id: string; phase: string }[] = [];
  const dispatch = (a: QueueAction) => { state = momentQueueReducer(state, a); };
  const commit = () => {
    const step = sponsorQueueLines(onAir, { current: state.current, phase: state.phase, cutShort: state.cutShort }, new Date(clock()).toISOString());
    onAir = step.onAir;
    for (const line of step.lines) lines.push({ at: clock(), line });
    if (state.current !== null) phases.push({ at: clock(), id: `${state.current.seq}:${state.current.kind}`, phase: state.phase });
  };
  return {
    lines, phases,
    get state() { return state; },
    /** Returns whether the poll dispatched (its key changed). */
    poll(incoming: readonly OverlayMoment[]): boolean {
      const key = incomingKey(incoming);
      if (key === lastKey) return false;
      lastKey = key;
      const now = clock();
      dispatch({ type: "sync", live: incoming, now, foldMs, holdMs });
      if (incoming.length > 0) dispatch({ type: "enqueue", moments: incoming, now, foldMs, holdMs });
      commit();
      return true;
    },
    /** Fire the armed timer once: the clock moves to its deadline, then one tick. Returns false when nothing is armed. */
    fire(): boolean {
      if (state.deadline === null) return false;
      advance(Math.max(0, state.deadline - clock()));
      dispatch({ type: "tick", now: clock(), foldMs, holdMs });
      commit();
      return true;
    },
  };
}

const airingRows = (sessionId: string) => sql<{
  sponsor_id: string | null; sponsor_name: string; fixture_id: string | null; moment_id: string; source: string; break_kind: string | null;
  style: string; started_at: Date; ended_at: Date | null; cut_short: boolean; ended_estimated: boolean;
}[]>`
  select sponsor_id, sponsor_name, fixture_id, moment_id, source, break_kind, style, started_at, ended_at, cut_short, ended_estimated
    from sponsor_airings where session_id = ${sessionId} order by started_at, moment_id`;
const assignmentRows = (fixtureId: string) => sql<{ moment_id: string; sponsor_id: string | null; style: string; hold_ms: number; break_kind: string; position: number | null }[]>`
  select moment_id, sponsor_id, style, hold_ms, break_kind, position from sponsor_assignments where fixture_id = ${fixtureId} order by seq`;
const clickRows = (sponsorId: string) => sql<{ fixture_id: string | null; source: string }[]>`
  select fixture_id, source from sponsor_clicks where sponsor_id = ${sponsorId} order by at`;

/** The breaks the loader handed the planner on its LAST call (the fold's replay: the engine's own `opensAt`). */
function breaksLastPlanned(): readonly BreakOpened[] {
  const calls = vi.mocked(loadFixtureSponsorPlan).mock.calls;
  expect(calls.length, "premise: the loader planned at all").toBeGreaterThan(0);
  return calls.at(-1)![0].breaks;
}

describe.skipIf(!HAS_DB)("S15: the sponsor chain, plan → airing → click → overview → report, on one composed cricket match", () => {
  it("Busy, two ticked sponsors: the over's break airs the heavier tier as a lower third AFTER the end-of-over card; one start and one end line; ONE airing row of hold + fold; a second over inside the cooldown airs nothing; the printed code's click is one stream row; the Overview and the report count exactly that", async () => {
    const r = await cricketComposedRig();
    // --- The organiser: two sponsors (created OFF the stream), each ticked; then the dial to Busy.
    const title = await createSponsor(r.auth, { name: LONG_NAME, url: "https://harbourside.example/", tier: "title", status: "active" } as never);
    const gold = await createSponsor(r.auth, { name: "Ridge Gold Physio", url: "https://ridge-gold.example/", tier: "gold", status: "active" } as never);
    expect([title.on_stream, gold.on_stream], "premise: a created sponsor starts off the stream").toEqual([false, false]);
    for (const s of [title, gold]) expect((await patchSponsor(r.auth, s.id, { on_stream: true } as never)).on_stream).toBe(true);
    await putStreamSettings(r.auth, r.orgId, { competitionId: null, enabled: true, frequency: "busy" });

    // The declarations every expectation below is read from.
    const size = cricketSize("over_end");
    const look = SPONSOR_STYLE_BY_SIZE[size];
    expect(SPONSOR_TIER_WEIGHTS.title, "premise (D9): the tiers are not tied, so P7's first pick is decided").not.toBe(SPONSOR_TIER_WEIGHTS.gold);
    const heavier = SPONSOR_TIER_WEIGHTS.title > SPONSOR_TIER_WEIGHTS.gold ? title : gold;
    const lighter = heavier === title ? gold : title;

    // --- EMPTY FIRST: the match is on, no ball bowled. Both doors serve the cards and no airing; the page logs nothing.
    await r.append("core.start", {});
    const mounted = await loadOverlayLiveData(r.fixtureId, { relay: true });
    expect(mounted.sponsorPlan?.airings, "no break yet: no airing").toEqual([]);
    expect(mounted.sponsorPlan?.cards.map((c) => c.sponsorId).sort(), "both ticked sponsors are the cards").toEqual([title.id, gold.id].sort());
    for (const c of mounted.sponsorPlan!.cards) expect(c.shortCode, "S5 mints every linkable card's code").toMatch(SPONSOR_SHORT_CODE_PATTERN);
    const mount = { tip: maxSeq(mounted.recent), closed: closedOverBaselineOf(mounted.lastClosedOver) };
    const page = composedPage(r.now, r.tick);
    page.poll(incomingFor(mounted, mount));
    while (page.fire());
    expect(page.lines, "nothing on air before the first break").toEqual([]);
    expect(await assignmentRows(r.fixtureId)).toEqual([]);

    // --- THE OVER: six legal balls. Its sixth opens the break (the engine's own opensAt, in the fold's replay).
    const sixth = await bowlOver(r, 0);
    const momentId = sponsorMomentId(sixth.seq, "over_end");
    const relay = await loadOverlayLiveData(r.fixtureId, { relay: true });
    const plan: NonNullable<SponsorPlan> = relay.sponsorPlan!;
    expect(breaksLastPlanned().map((b) => [b.seq, b.kind, b.size]), "the fold opened ONE break, the over's, at its sixth ball").toEqual([[sixth.seq, "over_end", size]]);
    expect(plan.airings, "the plan airs the over's break with the heavier tier, in the style and hold its size declares").toEqual([
      { momentId, seq: sixth.seq, cardId: heavier.id, style: look.style, holdMs: look.holdMs, breakKind: "over_end" },
    ]);
    const pub = await loadOverlayLiveData(r.fixtureId);
    expect(pub.sponsorPlan, "OBS's door serves the SAME plan (one moment stream, requirement 7)").toEqual(plan);
    expect(await assignmentRows(r.fixtureId), "S5's assignment, written once by the first door, frozen for the second").toEqual([
      { moment_id: momentId, sponsor_id: heavier.id, style: look.style, hold_ms: look.holdMs, break_kind: "over_end", position: 0 },
    ]);

    // --- THE PAGE: the poll lands; the queue airs the end-of-over card's two beats FIRST, then the sponsor card.
    const polledAt = r.now();
    const incoming = incomingFor(relay, mount);
    expect(incoming.filter((m) => m.graphic === "endOfOver"), "premise: the over's end-of-over card (two beats) is incoming").toHaveLength(2);
    expect(incoming.filter((m) => m.graphic === "sponsor"), "premise: one sponsor card is incoming").toHaveLength(1);
    expect(page.poll(incoming), "the poll that brings the break dispatches").toBe(true);
    let rePolls = 0;
    let rePollDispatches = 0;
    while (page.fire()) {
      // A poll lands between timers (the 2 s edge): the same window again. Same moment ids, so the hook dispatches
      // nothing (its `incomingKey`), and the loader writes nothing twice.
      if (page.poll(incomingFor(await loadOverlayLiveData(r.fixtureId, { relay: true }), mount))) rePollDispatches++;
      rePolls++;
    }
    expect(rePolls, "the page re-polled through the showing").toBeGreaterThan(0);
    expect(rePollDispatches, "a re-poll with the same moment ids dispatches nothing").toBe(0);
    expect(await assignmentRows(r.fixtureId), "a re-poll writes nothing twice").toHaveLength(1);
    // OBS opened AFTER the break (mounted at today's tip) composes no card for it: the stage's mount-tip filter, over
    // the real payload — the break is the page's past, never replayed.
    const lateMount = { tip: maxSeq(relay.recent), closed: closedOverBaselineOf(relay.lastClosedOver) };
    expect(lateMount.tip, "premise: the late page mounted at the break's own seq").toBe(sixth.seq);
    expect(incomingFor(relay, lateMount).filter((m) => m.graphic === "sponsor"), "a page mounted after the break replays no card").toEqual([]);
    const lineItems = page.lines.map((l) => itemOf(l.line));
    expect(lineItems.map((i) => i.kind), "exactly one start, then one end, however many polls").toEqual(["start", "end"]);
    const [start, end] = page.lines;
    const beatFold = OVERLAY_MOMENT_FOLD_MS * 2 + END_OF_OVER_HOLD_MS;
    expect(start!.at - polledAt, "the card's hold begins after BOTH end-of-over beats and its own fold in (spec §3.4)").toBe(2 * beatFold + OVERLAY_MOMENT_FOLD_MS);
    expect(end!.at - start!.at, "it holds its declared hold, then folds out").toBe(look.holdMs + OVERLAY_MOMENT_FOLD_MS);
    expect(lineItems[0]).toEqual({ kind: "start", momentId, cardId: heavier.id, style: look.style, source: "rotation", breakKind: "over_end", at: new Date(start!.at).toISOString() });
    expect(lineItems[1]).toEqual({ kind: "end", momentId, at: new Date(end!.at).toISOString(), cutShort: false });

    // --- THE COMPOSITOR: the start rides the next beat, the end the one after; the usecase answers each.
    const [startItem, endItem] = lineItems;
    expect(await r.beat({ state: "playing", airings: [startItem] })).toMatchObject({ desiredState: "live" });
    const open = await airingRows(r.sessionId);
    expect(open, "the start is ONE open airing naming the assignment's sponsor").toEqual([
      expect.objectContaining({ sponsor_id: heavier.id, moment_id: momentId, ended_at: null }),
    ]);
    expect(await r.beat({ state: "playing", airings: [endItem] })).toMatchObject({ desiredState: "live" });
    const rows = await airingRows(r.sessionId);
    expect(rows, "PROOF OF PLAY: one closed airing, every field from the declarations and the ledger").toEqual([{
      sponsor_id: heavier.id, sponsor_name: heavier.name, fixture_id: r.fixtureId, moment_id: momentId, source: "rotation",
      break_kind: "over_end", style: look.style, started_at: new Date(start!.at), ended_at: new Date(end!.at), cut_short: false,
      ended_estimated: false,
    }]);
    const shownMs = rows[0]!.ended_at!.getTime() - rows[0]!.started_at.getTime();
    expect(shownMs, "the row's time on screen is the card's hold plus its fold out").toBe(look.holdMs + OVERLAY_MOMENT_FOLD_MS);

    // --- A SECOND OVER, at once (well inside the cooldown): a real break, no second card.
    const twelfth = await bowlOver(r, 1);
    const again = await loadOverlayLiveData(r.fixtureId, { relay: true });
    const breaks = breaksLastPlanned();
    expect(breaks.map((b) => [b.seq, b.kind]), "premise: the fold opened BOTH overs' breaks").toEqual([[sixth.seq, "over_end"], [twelfth.seq, "over_end"]]);
    const gapMs = Date.parse(breaks[1]!.at) - Date.parse(breaks[0]!.at);
    expect(gapMs, "premise: the second break is inside the cooldown (event time)").toBeLessThan(SPONSOR_COOLDOWN_MS);
    expect(again.sponsorPlan!.airings.map((a) => a.momentId), "the cooldown: the second over's break gets no card").toEqual([momentId]);
    const linesBefore = page.lines.length;
    page.poll(incomingFor(again, mount));
    while (page.fire());
    expect(page.lines.length, "the page logs no line for it").toBe(linesBefore);
    expect(page.phases.some((p) => p.id === sponsorMomentId(twelfth.seq, "over_end")), "and never queues a card for it").toBe(false);
    expect(page.phases.some((p) => p.id.endsWith(":endOfOver") && p.phase === "hold" && p.at > end!.at), "premise: the page DID air the second over's end-of-over card").toBe(true);
    expect(await assignmentRows(r.fixtureId)).toHaveLength(1);
    expect(await airingRows(r.sessionId)).toHaveLength(1);

    // --- THE VIEWER: types the code the card prints into a browser — the REAL /s/ handler, then its tail write.
    const card = plan.cards.find((c) => c.id === heavier.id)!;
    const printed = sponsorShortLinkText(card.shortCode);
    expect(printed, "the card prints its short link").not.toBeNull();
    const path = printed!.slice(sponsorLinkHost().length);
    expect(path).toBe(`/s/${card.shortCode}`);
    // Other writers queue tail work too (the sponsor writes' cache busts, the ledger's): run it now, so the count below is
    // the route's alone.
    await flush();
    const res = await sponsorLinkRoute(
      new Request(`https://${sponsorLinkHost()}${path}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "x-forwarded-for": "203.0.113.15" } }),
      { params: Promise.resolve({ key: card.shortCode! }) },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location"), "the sponsor's own url").toBe("https://harbourside.example/");
    expect(await flush(), "one click write queued").toBe(1);
    expect(await clickRows(heavier.id), "ONE stream click on this match").toEqual([{ fixture_id: r.fixtureId, source: "stream" }]);
    expect(await clickRows(lighter.id), "nothing for the sponsor nobody tapped").toEqual([]);

    // --- THE ORGANISER'S NUMBERS: the Overview (this competition) and the sponsor's report link (today's dates).
    const now = new Date(Math.max(r.now(), Date.now()) + 1_000);
    const overview = await sponsorOverview(r.auth, r.orgId, { kind: "competition", competitionId: r.competitionId }, now);
    expect(overview.length, "premise: the Overview lists both sponsors").toBe(2);
    expect(overview.find((o) => o.sponsorId === heavier.id)).toMatchObject({ name: heavier.name, timesShown: 1, onScreenMs: shownMs, linkClicks: 1 });
    expect(overview.find((o) => o.sponsorId === lighter.id)).toMatchObject({ timesShown: 0, onScreenMs: 0, linkClicks: 0 });
    const day = 86_400_000;
    const link = await createReportLink(r.auth, r.orgId, {
      sponsorId: heavier.id, competitionId: null, from: isoDay(new Date(now.getTime() - day)), to: isoDay(new Date(now.getTime() + day)),
    });
    const token = link.url.split("/").at(-1)!;
    const report = await sponsorReport(token, now);
    expect(report, "the link opens a report").not.toBeNull();
    expect(report).toMatchObject({ sponsor: { name: heavier.name }, timesShown: 1, onScreenMs: shownMs, streamVisits: 1 });
    expect(report!.showings).toEqual([expect.objectContaining({
      startedAt: new Date(start!.at).toISOString(), onScreenMs: shownMs, breakKind: "over_end", source: "rotation",
      match: { home: "Harbour XI", away: "Ridge XI" }, frameUrl: null,
    })]);
  });

  it("a score cuts the card: a SIX landing while the over's card holds folds it out at once — the end line says cutShort, the row is cut_short and shorter than the hold, and the SIX is what airs next", async () => {
    const r = await cricketComposedRig();
    const only = await createSponsor(r.auth, { name: "Quay Fisheries", url: "https://quay.example/", tier: "gold", status: "active" } as never);
    await patchSponsor(r.auth, only.id, { on_stream: true } as never);
    await putStreamSettings(r.auth, r.orgId, { competitionId: null, enabled: true, frequency: "busy" });
    const look = SPONSOR_STYLE_BY_SIZE[cricketSize("over_end")];
    await r.append("core.start", {});
    const mounted = await loadOverlayLiveData(r.fixtureId, { relay: true });
    const mount = { tip: maxSeq(mounted.recent), closed: closedOverBaselineOf(mounted.lastClosedOver) };
    const page = composedPage(r.now, r.tick);
    page.poll(incomingFor(mounted, mount));

    const sixth = await bowlOver(r, 0);
    const momentId = sponsorMomentId(sixth.seq, "over_end");
    page.poll(incomingFor(await loadOverlayLiveData(r.fixtureId, { relay: true }), mount));
    // Run the end-of-over beats out until the CARD holds — the state a score has to cut.
    let fired = 0;
    while (!(page.state.current?.kind === "sponsor.over_end" && page.state.phase === "hold")) {
      expect(page.fire(), "premise: the over's card reaches its hold").toBe(true);
      expect(++fired, "premise: within the end-of-over card's beats").toBeLessThan(20);
    }
    const holdingFrom = r.now();
    // One second into the hold, the next ball goes for six (Law 19.8: over the boundary, six runs).
    r.tick(1_000);
    const six = await r.append("cricket.ball", { over: 1, ballInOver: 1, striker: r.home[1], nonStriker: r.home[0], bowler: r.away[1], runs: { bat: 6 }, boundary: 6 });
    const withSix = await loadOverlayLiveData(r.fixtureId, { relay: true });
    const sixMoments = momentsFor("cricket", withSix.recent ?? [], mount.tip, msg, ["HAR", "RID"]).filter((m) => m.seq === six.seq);
    expect(sixMoments.length, "premise: the six is a score moment the stage sends").toBeGreaterThan(0);
    page.poll(incomingFor(withSix, mount));
    expect(page.state.phase, "the card folds out on the poll that brings the six").toBe("out");
    expect(page.state.cutShort, "and is recorded cut short").toContain(momentId);
    while (page.fire()) {
      if (page.state.current?.seq === six.seq) break;
    }
    expect(page.state.current?.seq, "the six airs next").toBe(six.seq);

    const items = page.lines.map((l) => itemOf(l.line));
    expect(items.map((i) => [i.kind, i.momentId]), "one start and one end, for the card").toEqual([["start", momentId], ["end", momentId]]);
    expect(items[1]).toMatchObject({ kind: "end", cutShort: true });
    const [start, end] = page.lines;
    expect(end!.at - start!.at, "it left at the six plus its fold, not after its hold").toBe(holdingFrom + 1_000 + OVERLAY_MOMENT_FOLD_MS - start!.at);
    expect(end!.at - start!.at).toBeLessThan(look.holdMs);
    for (const item of items) await r.beat({ state: "playing", airings: [item] });
    const rows = await airingRows(r.sessionId);
    expect(rows, "ONE row, closed, cut short, naming the card's sponsor").toEqual([expect.objectContaining({
      sponsor_id: only.id, moment_id: momentId, started_at: new Date(start!.at), ended_at: new Date(end!.at), cut_short: true, ended_estimated: false,
    })]);
  });

  it("an undo takes the card off air: the sixth ball voided while the card holds ⇒ S5 deletes the unaired assignment, the page folds the card (its end line cutShort: true, ruling 2026-11-01), and the beats still make ONE row for the card's sponsor (S8's void-race fallback) that the report counts once", async () => {
    const r = await cricketComposedRig();
    // Final review S15: TWO ticked sponsors, so the void-race fallback has a wrong answer to give - "a sponsor of this org"
    // is not "the card's sponsor". The one the break does NOT pick is created FIRST, so a fallback that read the org's
    // first sponsor would name it.
    expect(SPONSOR_TIER_WEIGHTS.gold, "premise: the tiers are not tied, so P7's first pick is decided").not.toBe(SPONSOR_TIER_WEIGHTS.partner);
    const [heavyTier, lightTier] = SPONSOR_TIER_WEIGHTS.gold > SPONSOR_TIER_WEIGHTS.partner ? (["gold", "partner"] as const) : (["partner", "gold"] as const);
    const other = await createSponsor(r.auth, { name: "Quay Fisheries", url: "https://quay.example/", tier: lightTier, status: "active" } as never);
    const only = await createSponsor(r.auth, { name: "Kingsway Dairy", url: "https://kingsway.example/", tier: heavyTier, status: "active" } as never);
    for (const s of [other, only]) await patchSponsor(r.auth, s.id, { on_stream: true } as never);
    await putStreamSettings(r.auth, r.orgId, { competitionId: null, enabled: true, frequency: "busy" });
    const look = SPONSOR_STYLE_BY_SIZE[cricketSize("over_end")];
    await r.append("core.start", {});
    const mounted = await loadOverlayLiveData(r.fixtureId, { relay: true });
    const mount = { tip: maxSeq(mounted.recent), closed: closedOverBaselineOf(mounted.lastClosedOver) };
    const page = composedPage(r.now, r.tick);
    page.poll(incomingFor(mounted, mount));

    const sixth = await bowlOver(r, 0);
    const momentId = sponsorMomentId(sixth.seq, "over_end");
    page.poll(incomingFor(await loadOverlayLiveData(r.fixtureId, { relay: true }), mount));
    expect(await assignmentRows(r.fixtureId), "premise: S5 assigned the over's break").toEqual([expect.objectContaining({ moment_id: momentId, sponsor_id: only.id })]);
    let fired = 0;
    while (!(page.state.current?.kind === "sponsor.over_end" && page.state.phase === "hold")) {
      expect(page.fire(), "premise: the over's card reaches its hold").toBe(true);
      expect(++fired, "premise: within the end-of-over card's beats").toBeLessThan(20);
    }
    expect(page.lines.map((l) => itemOf(l.line).kind), "the card is on air: its start line is written").toEqual(["start"]);
    const startAt = page.lines[0]!.at;

    // One second into the hold, BEFORE the start line has ridden a beat, the scorer takes back the sixth ball: a REAL
    // void through the ledger. The break no longer exists.
    r.tick(1_000);
    await r.append("core.void", {}, sixth.event.id);
    const after = await loadOverlayLiveData(r.fixtureId, { relay: true });
    expect(after.sponsorPlan?.airings, "the plan no longer airs the undone break").toEqual([]);
    expect(await assignmentRows(r.fixtureId), "S5: the unaired assignment is deleted").toEqual([]);
    expect(page.poll(incomingFor(after, mount)), "the poll that carries the undo dispatches").toBe(true);
    expect(page.state.phase, "the card folds out on that poll").toBe("out");
    expect(page.state.cutShort, "and is recorded cut short (it left before its hold)").toContain(momentId);
    while (page.fire());

    const items = page.lines.map((l) => itemOf(l.line));
    expect(items.map((i) => [i.kind, i.momentId]), "one start, one end, for the card").toEqual([["start", momentId], ["end", momentId]]);
    expect(items[1], "RULING 2026-11-01: an undo-folded card reports cutShort: true").toMatchObject({ kind: "end", cutShort: true });
    const endAt = page.lines[1]!.at;
    expect(endAt - startAt, "it left at the undo's poll plus its fold, not after its hold").toBe(1_000 + OVERLAY_MOMENT_FOLD_MS);

    // The compositor beats both lines in. The assignment is gone, so S8 attributes the start to the card's own sponsor.
    for (const item of items) await r.beat({ state: "playing", airings: [item] });
    const rows = await airingRows(r.sessionId);
    expect(rows, "exactly ONE row, for the card's sponsor, cut short").toEqual([{
      sponsor_id: only.id, sponsor_name: only.name, fixture_id: r.fixtureId, moment_id: momentId, source: "rotation",
      break_kind: "over_end", style: look.style, started_at: new Date(startAt), ended_at: new Date(endAt), cut_short: true,
      ended_estimated: false,
    }]);
    const now = new Date(Math.max(r.now(), Date.now()) + 1_000);
    const day = 86_400_000;
    const link = await createReportLink(r.auth, r.orgId, {
      sponsorId: only.id, competitionId: null, from: isoDay(new Date(now.getTime() - day)), to: isoDay(new Date(now.getTime() + day)),
    });
    const report = await sponsorReport(link.url.split("/").at(-1)!, now);
    expect(report, "the report counts the showing once, at its real length").toMatchObject({ timesShown: 1, onScreenMs: endAt - startAt, streamVisits: 0 });
    expect(report!.showings).toHaveLength(1);
    // The other ticked sponsor was never on air: its report holds nothing.
    const otherLink = await createReportLink(r.auth, r.orgId, {
      sponsorId: other.id, competitionId: null, from: isoDay(new Date(now.getTime() - day)), to: isoDay(new Date(now.getTime() + day)),
    });
    expect(await sponsorReport(otherLink.url.split("/").at(-1)!, now), "the other ticked sponsor: never shown").toMatchObject({ timesShown: 0, onScreenMs: 0, showings: [] });
  });
});
