// R4 sponsors on stream, S8 — proof of play (spec 2026-10-27 §3.6): the compositor's heartbeat carries the overlay page's
// `seazn:sponsor:start|end` lines as `airings`, and web records them in sponsor_airings, closing what is still open when
// the session ends.
//
// THE SEAM, driven for real (AGENTS.md class 1): the planner's own assignment (S4 `planSponsors`, persisted the way S5
// will), the page's own moment and line builders (S6 `sponsorMoments`, S7 `sponsorQueueLines` / `carouselStep` +
// `carouselLines`), SC1's conversion (the line's name is `kind`, its JSON the rest — `itemOf`), the route's own parser and
// the REAL `heartbeat` usecase; then the row is read back. Every item in this file is built through the page's
// `sponsorLine`, so no test hand-types the wire on both ends.
//
// The transitions (TEST-STRATEGY rule 1) and where each is pinned:
//   start → row; end → closed, cut_short as sent ......... "the seam"
//   a re-sent start / end (a lost 2xx) .................... "re-sent"
//   a second start naming ANOTHER card .................... "first row wins"
//   empty: [] and no key .................................. "empty"
//   end with no start (its start dropped by the 64 cap) ... "end before start"
//   end earlier than its start ............................. "end before start"
//   skew: 10 min ± 1 s, exactly 10 min, both directions .... "the clock"
//   session end with an open airing ........................ "session end"
//   a start after the session ended ........................ "session end"
//   sponsor deleted before its start lands ................. "Review Focus 4"
//   operator vs rotation (R5) .............................. "R5"
//   another org's sponsor / assignment / fixture ........... "ownership"
//   a superseded Machine, a beat after the final ........... "the beat's own guards"
//   R14: neither beat store keeps the list ................. "R14"
//   a failing airing write never costs the beat ............ "isolation"
// TWO SPORTS: cricket (break cards: `over_end`, `innings_break`, the kinds engine 1.1.0 declares — S1/S2 report) and
// generic (no natural breaks: its sponsors air on the scene carousel). The rest is single-sport on purpose: ingestion reads
// no sport, only the moment id the page logged.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

// The two writers, passed through untouched — one test makes each fail ONCE, to prove a proof-of-play failure never
// costs the stream its beat or its end (the sampleBeat isolation rule).
vi.mock("@/server/sponsors/airings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/sponsors/airings")>();
  return { ...actual, recordAirings: vi.fn(actual.recordAirings), closeOpenAirings: vi.fn(actual.closeOpenAirings) };
});

import { sql, statementCount, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { RelayAiring, RelayHeartbeat } from "@/server/api-v1/schemas";
import { SIGNAL_SPONSOR_END, SIGNAL_SPONSOR_START, sponsorLine, sponsorQueueLines } from "@/lib/overlay-compositor";
import { sponsorMoments } from "@/lib/overlay-moments";
import {
  SCENE_CAROUSEL_MS, SPONSOR_STYLE_BY_SIZE, planSponsors, sponsorMomentId,
  type BreakOpened, type OperatorLogEntry, type SponsorAssignment, type SponsorCard,
} from "@/lib/sponsor-plan";
import { CAROUSEL_INITIAL, CAROUSEL_STYLE, carouselLines, carouselStep } from "@/components/overlay/sponsor-card";
import { SPONSOR_CAROUSEL_SCENES } from "@/components/overlay/overlay-scenes";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { pairPresentPhone, streamRig } from "@/server/relay/__tests__/_session-rig";
import { POST as beatRoute } from "@/app/api/internal/relay/sessions/[sid]/heartbeat/route";
import { captureRig, type CaptureRig } from "@/server/usecases/__tests__/_capture-rig";
import { createSession, currentSession, heartbeat, stopSession } from "@/server/usecases/stream-sessions";
import { deleteSponsor } from "@/server/usecases/sponsors";
import { AIRING_CLOCK_SKEW_MS, AIRING_HOLD_MS, closeOpenAirings, recordAirings, sponsorIdOfCard } from "../airings";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "RELAY_DRIVERS", "RELAY_IMAGE"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "sponsor-airings-test-secret";
  // A composed start is refused 503 composed_unavailable while RELAY_IMAGE is unset; the fake runner needs no real image.
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:sponsor-airings-test";
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterEach(() => setRelayDriversForTest(null));
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const SEC = 1000;
const MIN = 60 * SEC;
const NEVER = 3_600_000;
/** S1/S2 (engine 1.1.0, task-S1S2-report.md): cricket's two declared kinds and their sizes (Law 17.1, Law 11). */
const OVER_END = { kind: "over_end", size: "minor" } as const;
const INNINGS_BREAK = { kind: "innings_break", size: "major" } as const;
/** Review Focus 5's realistic sponsor name: 43 characters. */
const LONG_NAME = "Harbourside Building Supplies and Timber Co";

// ---------------------------------------------------------------------------------------------------------------
// The wire, as the page and the compositor make it.
// ---------------------------------------------------------------------------------------------------------------
/** SC1's conversion (spec §3.6.2, brief P6): the line's name is `kind`, its JSON the rest — parsed by the contract twin. */
function itemOf(line: string): RelayAiring {
  const space = line.indexOf(" ");
  const signal = line.slice(0, space);
  if (signal !== SIGNAL_SPONSOR_START && signal !== SIGNAL_SPONSOR_END) throw new Error(`not a sponsor line: ${line}`);
  return RelayAiring.parse({ kind: signal === SIGNAL_SPONSOR_START ? "start" : "end", ...(JSON.parse(line.slice(space + 1)) as object) });
}
const startItem = (b: { momentId: string; cardId: string; style?: string; source?: "rotation" | "scene"; breakKind?: string | null; at: Date }) =>
  itemOf(sponsorLine("start", { momentId: b.momentId, cardId: b.cardId, style: b.style ?? "lower_third", source: b.source ?? "rotation",
    breakKind: b.breakKind === undefined ? OVER_END.kind : b.breakKind, at: b.at.toISOString() }));
const endItem = (b: { momentId: string; at: Date; cutShort?: boolean }) =>
  itemOf(sponsorLine("end", { momentId: b.momentId, at: b.at.toISOString(), cutShort: b.cutShort ?? false }));

// ---------------------------------------------------------------------------------------------------------------
// Rigs.
// ---------------------------------------------------------------------------------------------------------------
async function sponsorRow(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into sponsors (org_id, name, on_stream) values (${orgId}, ${name}, true) returning id`;
  return row!.id;
}
/** The MVP card source (spec §3.3) reads `sponsors`: one card per sponsor, its id the sponsor's (`sponsorIdOfCard`). */
const cardOf = (sponsorId: string, name: string): SponsorCard =>
  ({ id: sponsorId, sponsorId, name, logoUrl: null, tier: "partner", onStream: true });

/** The planner's assignments for these breaks, persisted the way S5 will (`insert … on conflict do nothing`), and the plan
 *  it served. Busy: every break gets a card, so the expected set is the breaks themselves (spec §3.2's dial). */
async function assignBreaks(o: {
  orgId: string; fixtureId: string; cards: SponsorCard[]; breaks: BreakOpened[]; now: number; operatorLog?: OperatorLogEntry[];
  /** A previous poll's assignments (frozen), and the org's next free position after them. */
  assigned?: SponsorAssignment[];
}) {
  const assigned = o.assigned ?? [];
  const { plan, newAssignments } = planSponsors({
    breaks: o.breaks, windowSeqs: o.breaks.map((b) => b.seq), settings: { enabled: true, frequency: "busy" }, cards: o.cards,
    assignedCards: [], assigned, operatorLog: o.operatorLog ?? [], nextPosition: assigned.length, now: o.now, complete: true,
  });
  expect(newAssignments.length, "premise: the planner assigned every new break").toBe(o.breaks.length - assigned.length);
  for (const a of newAssignments) await persistAssignment(o.orgId, o.fixtureId, a);
  return { plan, assignments: newAssignments };
}
function persistAssignment(orgId: string, fixtureId: string, a: SponsorAssignment) {
  return sql`
    insert into sponsor_assignments (fixture_id, moment_id, org_id, seq, sponsor_id, sponsor_name, position, source, break_kind, style, hold_ms, operator_choice_at)
    values (${fixtureId}, ${a.momentId}, ${orgId}, ${a.seq}, ${a.sponsorId}, ${a.sponsorName}, ${a.position}, ${a.source}, ${a.breakKind},
            ${a.style}, ${a.holdMs}, ${a.operatorChoiceAt})
    on conflict do nothing`;
}

type AiringRow = {
  org_id: string; sponsor_id: string | null; sponsor_name: string; fixture_id: string | null; session_id: string | null; moment_id: string;
  source: string; break_kind: string | null; style: string; started_at: Date; ended_at: Date | null; cut_short: boolean; skipped: boolean;
  ended_estimated: boolean;
};
const airingsOf = (sessionId: string) => sql<AiringRow[]>`
  select org_id, sponsor_id, sponsor_name, fixture_id, session_id, moment_id, source, break_kind, style, started_at, ended_at, cut_short,
         skipped, ended_estimated
    from sponsor_airings where session_id = ${sessionId} order by started_at, moment_id`;

/** A COMPOSED session (the only mode that composes a page, D10) started through the real organiser path. */
async function composedRig(sport: "cricket" | "generic" = "cricket") {
  const r = await captureRig({ credits: 1, connectAfterMs: NEVER, sport });
  await pairPresentPhone(r.fixtureId, { phone: `phone-a-${randomUUID()}`, at: r.now() });
  const { sessionId } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
  const jobToken = r.runner.created[0]!.jobToken;
  const self = {
    r, S: sessionId, jobToken,
    /** The Machine's beat through the usecase, parsed first by the twin the route parses with. */
    beat: (body: Record<string, unknown>) => heartbeat(sessionId, jobToken, RelayHeartbeat.parse(body), r.deps),
    /** The same through the REAL route: bearer, body parse, envelope. */
    async routeBeat(body: Record<string, unknown>): Promise<Response> {
      return beatRoute(new Request(`http://app.test/api/internal/relay/sessions/${sessionId}/heartbeat`, {
        method: "POST", headers: { authorization: `Bearer ${jobToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ sid: sessionId }) });
    },
    sponsor: (name: string) => sponsorRow(r.auth.orgId, name),
  };
  return self;
}
const breakAt = (r: CaptureRig, seq: number, decl: { kind: string; size: "minor" | "major" }): BreakOpened => ({ seq, ...decl, at: r.now().toISOString() });

/** A session row for the writer's own tests (no Machine): `streamRig`'s, live. */
async function plainSession() {
  const rig = await streamRig();
  const fixtureId = rig.fixtureIds[0]!;
  const sessionId = await rig.session(fixtureId, "live");
  return { orgId: rig.orgId, fixtureId, sessionId, s: { sessionId, orgId: rig.orgId, fixtureId } };
}
const record = (s: { sessionId: string; orgId: string; fixtureId: string | null }, items: RelayAiring[], now: Date) =>
  sql.begin((tx: Tx) => recordAirings(tx, s, items, now)) as Promise<Awaited<ReturnType<typeof recordAirings>>>;

describe.skipIf(!HAS_DB)("S8: the heartbeat's airings become sponsor_airings rows", () => {
  it("the seam (cricket): the planner's over-end card → the page's queue lines → SC1's items → the REAL heartbeat route → ONE row naming the assignment's sponsor, source, kind and style; the end on the next beat closes it with cut_short as sent", async () => {
    const c = await composedRig("cricket");
    const sponsorId = await c.sponsor(LONG_NAME);
    const brk = breakAt(c.r, 12, OVER_END);
    const { plan, assignments } = await assignBreaks({ orgId: c.r.auth.orgId, fixtureId: c.r.fixtureId, cards: [cardOf(sponsorId, LONG_NAME)], breaks: [brk], now: c.r.now().getTime() });
    const [moment] = sponsorMoments(plan);
    expect(moment, "premise: the plan airs the break").toBeDefined();
    const startedAt = c.r.now();
    const on = sponsorQueueLines(null, { current: moment!, phase: "hold", cutShort: [] }, startedAt.toISOString());
    expect(on.lines, "the page logs one start").toHaveLength(1);
    const res = await c.routeBeat({ state: "playing", airings: on.lines.map(itemOf) });
    expect(res.status).toBe(200);
    const want = { org_id: c.r.auth.orgId, sponsor_id: sponsorId, sponsor_name: LONG_NAME, fixture_id: c.r.fixtureId, session_id: c.S,
      moment_id: sponsorMomentId(brk.seq, OVER_END.kind), source: assignments[0]!.source, break_kind: OVER_END.kind,
      style: SPONSOR_STYLE_BY_SIZE.minor.style, started_at: startedAt, ended_at: null, cut_short: false, skipped: false, ended_estimated: false };
    expect(await airingsOf(c.S)).toEqual([want]);
    expect(want.source, "the planner's rotation card").toBe("rotation");
    // A score moment cuts it 3 s in: the page's end line, then the next beat.
    c.r.tick(3 * SEC);
    const endedAt = c.r.now();
    const off = sponsorQueueLines(on.onAir, { current: null, phase: "in", cutShort: [sponsorMomentId(brk.seq, OVER_END.kind)] }, endedAt.toISOString());
    expect(off.lines, "the page logs one end").toHaveLength(1);
    expect(itemOf(off.lines[0]!)).toMatchObject({ kind: "end", cutShort: true });
    c.r.tick(2 * SEC);
    expect((await c.routeBeat({ state: "playing", airings: off.lines.map(itemOf) })).status).toBe(200);
    expect(await airingsOf(c.S)).toEqual([{ ...want, ended_at: endedAt, cut_short: true }]);
  });

  it("the seam (generic — no natural breaks, so its sponsors air on the scene carousel): the carousel's own lines → one row naming the CARD's sponsor, source `scene`, break_kind null, the carousel's style; its end closes it", async () => {
    const c = await composedRig("generic");
    const sponsorId = await c.sponsor("Riverside Physio");
    const scene = SPONSOR_CAROUSEL_SCENES[0]!;
    const t0 = c.r.now().getTime();
    const showing = carouselStep(CAROUSEL_INITIAL, { now: t0, order: [sponsorId], yielding: false, scene });
    const on = carouselLines(null, showing, new Date(t0).toISOString());
    expect(on.lines).toHaveLength(1);
    await c.beat({ state: "playing", airings: on.lines.map(itemOf) });
    const want = { org_id: c.r.auth.orgId, sponsor_id: sponsorId, sponsor_name: "Riverside Physio", fixture_id: c.r.fixtureId, session_id: c.S,
      moment_id: showing.showing!.momentId, source: "scene", break_kind: null, style: CAROUSEL_STYLE, started_at: new Date(t0), ended_at: null,
      cut_short: false, skipped: false, ended_estimated: false };
    expect(await airingsOf(c.S)).toEqual([want]);
    // The showing runs its 10 s out; the next carousel step ends it whole.
    c.r.tick(10 * SEC);
    const t1 = c.r.now().getTime();
    const next = carouselStep(showing, { now: t1, order: [sponsorId], yielding: true, scene });
    const off = carouselLines(on.onAir, next, new Date(t1).toISOString());
    expect(off.lines.map(itemOf)).toEqual([expect.objectContaining({ kind: "end", cutShort: false })]);
    await c.beat({ state: "playing", airings: off.lines.map(itemOf) });
    expect(await airingsOf(c.S)).toEqual([{ ...want, ended_at: new Date(t1) }]);
  });

  it("re-sent (a lost 2xx): the same start, then the same start and end, then the end again — one row, the first start's values, the first end's; counts say written once", async () => {
    const p = await plainSession();
    const sponsorId = await sponsorRow(p.orgId, "Acme");
    const t0 = new Date();
    const moment = sponsorMomentId(4, OVER_END.kind);
    await persistAssignment(p.orgId, p.fixtureId, { momentId: moment, seq: 4, sponsorId, sponsorName: "Acme", position: 0, source: "rotation", breakKind: OVER_END.kind, style: "lower_third", holdMs: 8000, operatorChoiceAt: null });
    const start = startItem({ momentId: moment, cardId: sponsorId, at: t0 });
    const end = endItem({ momentId: moment, at: new Date(t0.getTime() + 8 * SEC) });
    expect(await record(p.s, [start], t0)).toMatchObject({ written: 1, refused: 0 });
    expect(await record(p.s, [start], t0), "the same start again: nothing new, nothing refused").toMatchObject({ written: 0, refused: 0 });
    expect(await record(p.s, [start, end], t0)).toMatchObject({ written: 1, refused: 0 });
    expect(await record(p.s, [start, end], t0), "both again").toMatchObject({ written: 0, refused: 0 });
    const later = endItem({ momentId: moment, at: new Date(t0.getTime() + 9 * SEC), cutShort: true });
    expect(await record(p.s, [later], t0), "another end for an ended airing changes nothing").toMatchObject({ written: 0, refused: 0 });
    const rows = await airingsOf(p.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ started_at: t0, ended_at: new Date(t0.getTime() + 8 * SEC), cut_short: false });
  });

  it("first row wins: a second start for a scene moment naming ANOTHER card (a page reload inside the 10 s bucket) keeps the first card and is counted refused; the same card again is a re-send", async () => {
    const p = await plainSession();
    const first = await sponsorRow(p.orgId, "First Card Ltd");
    const second = await sponsorRow(p.orgId, "Second Card Ltd");
    const t0 = new Date();
    const moment = `scene:${SPONSOR_CAROUSEL_SCENES[0]!}:${Math.floor(t0.getTime() / 10_000)}`;
    const scene = (cardId: string) => startItem({ momentId: moment, cardId, style: CAROUSEL_STYLE, source: "scene", breakKind: null, at: t0 });
    expect(await record(p.s, [scene(first)], t0)).toMatchObject({ written: 1, refused: 0 });
    expect(await record(p.s, [scene(second)], t0)).toMatchObject({ written: 0, refused: 1, why: ["another_card"] });
    expect(await record(p.s, [scene(first)], t0)).toMatchObject({ written: 0, refused: 0 });
    expect(await airingsOf(p.sessionId)).toEqual([expect.objectContaining({ sponsor_id: first, sponsor_name: "First Card Ltd" })]);
  });

  it("empty: `airings: []`, null and an absent key write nothing and answer as before; recordAirings([]) counts nothing and issues no statement", async () => {
    const c = await composedRig("cricket");
    let beats = 0;
    for (const body of [{ state: "playing" }, { state: "playing", airings: [] }, { state: "playing", airings: null }]) {
      expect(await c.beat(body), JSON.stringify(body)).toMatchObject({ desiredState: "live" });
      beats++;
    }
    expect(beats).toBe(3);
    expect(await airingsOf(c.S)).toEqual([]);
    const p = await plainSession();
    const spent = await sql.begin(async (tx: Tx) => {
      const before = statementCount();
      expect(await recordAirings(tx, p.s, [], new Date())).toEqual({ written: 0, refused: 0, why: [] });
      return statementCount() - before;
    });
    expect(spent, "an empty list reads nothing").toBe(0);
  });

  it("end before start: an end whose start never landed (dropped by the compositor's 64-item cap) is refused and counted; an end EARLIER than its start is refused and leaves the airing open", async () => {
    const p = await plainSession();
    const sponsorId = await sponsorRow(p.orgId, "Acme");
    const t0 = new Date();
    expect(await record(p.s, [endItem({ momentId: sponsorMomentId(9, OVER_END.kind), at: t0 })], t0)).toEqual({ written: 0, refused: 1, why: ["no_start"] });
    expect(await airingsOf(p.sessionId), "no row from an end alone").toEqual([]);
    const moment = sponsorMomentId(10, OVER_END.kind);
    await persistAssignment(p.orgId, p.fixtureId, { momentId: moment, seq: 10, sponsorId, sponsorName: "Acme", position: 0, source: "rotation", breakKind: OVER_END.kind, style: "lower_third", holdMs: 8000, operatorChoiceAt: null });
    expect(await record(p.s, [startItem({ momentId: moment, cardId: sponsorId, at: t0 })], t0)).toMatchObject({ written: 1 });
    const early = endItem({ momentId: moment, at: new Date(t0.getTime() - SEC) });
    expect(await record(p.s, [early], t0)).toEqual({ written: 0, refused: 1, why: ["end_before_start"] });
    expect(await airingsOf(p.sessionId)).toEqual([expect.objectContaining({ moment_id: moment, ended_at: null })]);
    // The positive pair: the same end at the start's instant closes it (a zero-length showing is a showing).
    expect(await record(p.s, [endItem({ momentId: moment, at: t0 })], t0)).toEqual({ written: 1, refused: 0, why: [] });
  });

  it(`the clock: an item ${AIRING_CLOCK_SKEW_MS / MIN} min + 1 s off the server's time is refused and counted; ${AIRING_CLOCK_SKEW_MS / MIN} min − 1 s and exactly ${AIRING_CLOCK_SKEW_MS / MIN} min are written — behind and ahead, starts and ends (counted)`, async () => {
    expect(AIRING_CLOCK_SKEW_MS, "spec §3.6.4: 10 min").toBe(10 * MIN);
    const p = await plainSession();
    const sponsorId = await sponsorRow(p.orgId, "Acme");
    const now = new Date();
    const cases: [label: string, offsetMs: number, written: boolean][] = [];
    for (const [side, sign] of [["behind", -1], ["ahead", 1]] as const) {
      cases.push([`${side} by the bound + 1 s`, sign * (AIRING_CLOCK_SKEW_MS + SEC), false]);
      cases.push([`${side} by the bound − 1 s`, sign * (AIRING_CLOCK_SKEW_MS - SEC), true]);
      cases.push([`${side} by exactly the bound`, sign * AIRING_CLOCK_SKEW_MS, true]);
    }
    let seq = 100, checked = 0;
    const assigned = async (): Promise<string> => {
      const moment = sponsorMomentId(++seq, OVER_END.kind);
      await persistAssignment(p.orgId, p.fixtureId, { momentId: moment, seq, sponsorId, sponsorName: "Acme", position: seq, source: "rotation", breakKind: OVER_END.kind, style: "lower_third", holdMs: 8000, operatorChoiceAt: null });
      return moment;
    };
    const verdict = (written: boolean) => (written ? { written: 1, refused: 0, why: [] } : { written: 0, refused: 1, why: ["clock_skew"] });
    for (const [label, offsetMs, written] of cases) {
      // A start at the offset.
      const s1 = await assigned();
      expect(await record(p.s, [startItem({ momentId: s1, cardId: sponsorId, at: new Date(now.getTime() + offsetMs) })], now), `start ${label}`).toEqual(verdict(written));
      // An end at the offset, its start at the earliest in-bound instant (so the end is never before its start).
      const e1 = await assigned();
      expect(await record(p.s, [startItem({ momentId: e1, cardId: sponsorId, at: new Date(now.getTime() - AIRING_CLOCK_SKEW_MS) })], now)).toEqual(verdict(true));
      expect(await record(p.s, [endItem({ momentId: e1, at: new Date(now.getTime() + offsetMs) })], now), `end ${label}`).toEqual(verdict(written));
      checked++;
    }
    console.log(`clock cases checked: ${checked} (x2: a start and an end each)`);
    expect(checked).toBe(6);
    const rows = await airingsOf(p.sessionId);
    expect(rows, "4 in-bound starts + 6 ends' starts").toHaveLength(10);
    expect(rows.filter((r) => r.ended_at !== null), "4 in-bound ends").toHaveLength(4);
  });

  it("session end (cricket): an airing still open when the final beat ends the session — its start far before the end — closes at its start + the banner hold, NOT stretched to the last beat, flagged ended_estimated and cut_short; one already ended is untouched; a start after the end is a 410 and writes nothing", async () => {
    const c = await composedRig("cricket");
    const a = await c.sponsor("Open At The End");
    const b = await c.sponsor("Closed In Time");
    const cards = [cardOf(a, "Open At The End"), cardOf(b, "Closed In Time")];
    // Two polls, as S5 assigns them: the innings break's card, then an over end past the 90 s cooldown (spec §3.2).
    const brkA = breakAt(c.r, 30, INNINGS_BREAK);
    const first = await assignBreaks({ orgId: c.r.auth.orgId, fixtureId: c.r.fixtureId, cards, breaks: [brkA], now: c.r.now().getTime() });
    c.r.tick(100 * SEC);
    const brkB = breakAt(c.r, 31, OVER_END);
    const second = await assignBreaks({ orgId: c.r.auth.orgId, fixtureId: c.r.fixtureId, cards, breaks: [brkA, brkB], now: c.r.now().getTime(), assigned: first.assignments });
    const moments = [...sponsorMoments(first.plan), ...sponsorMoments(second.plan).filter((m) => m.seq === brkB.seq)];
    expect(moments.map((m) => m.seq), "premise: one moment per break").toEqual([brkA.seq, brkB.seq]);
    const t0 = c.r.now();
    const items = moments.flatMap((m) => sponsorQueueLines(null, { current: m, phase: "hold", cutShort: [] }, t0.toISOString()).lines.map(itemOf));
    expect(items, "premise: two starts").toHaveLength(2);
    const idB = sponsorMomentId(brkB.seq, OVER_END.kind);
    await c.beat({ state: "playing", airings: items });
    c.r.tick(8 * SEC);
    await c.beat({ state: "playing", airings: [endItem({ momentId: idB, at: c.r.now() })] });
    // The page crashed with the innings card up: no end ever comes. Beats run on for 30 s more (6 × 5 s).
    let beats = 0;
    for (; beats < 6; beats++) { c.r.tick(5 * SEC); await c.beat({ state: "playing" }); }
    c.r.tick(5 * SEC);
    const lastBeat = c.r.now();
    await c.beat({ state: "stopped", exitReason: "ended" });
    const [s] = await sql<{ state: string; heartbeat_at: Date }[]>`select state, heartbeat_at from fixture_stream_sessions where id = ${c.S}`;
    expect(s, "premise: the final beat ended the session").toMatchObject({ state: "completed", heartbeat_at: lastBeat });
    const rows = await airingsOf(c.S);
    const byMoment = new Map(rows.map((r) => [r.moment_id, r]));
    const capped = new Date(t0.getTime() + SPONSOR_STYLE_BY_SIZE.major.holdMs);
    expect(capped.getTime(), "premise: the hold runs out well before the session ends (the cap is witnessed)").toBeLessThan(lastBeat.getTime() - 10 * SEC);
    expect(byMoment.get(sponsorMomentId(brkA.seq, INNINGS_BREAK.kind)), "the open one").toMatchObject({ ended_at: capped, ended_estimated: true, cut_short: true, style: SPONSOR_STYLE_BY_SIZE.major.style });
    expect(byMoment.get(idB), "the closed one").toMatchObject({ ended_at: new Date(t0.getTime() + 8 * SEC), ended_estimated: false, cut_short: false });
    expect(rows).toHaveLength(2);
    // The session is over: a late start is refused with the session, and no row appears.
    const late = startItem({ momentId: sponsorMomentId(40, OVER_END.kind), cardId: a, at: c.r.now() });
    await expect(c.beat({ state: "playing", airings: [late] })).rejects.toBeInstanceOf(HttpError);
    await expect(c.beat({ state: "playing", airings: [late] })).rejects.toMatchObject({ status: 410, code: "SESSION_ENDED" });
    expect(await airingsOf(c.S)).toHaveLength(2);
  });

  it("session end WITHOUT a final beat (the organiser's Stop; the Machine flushes and is gone): an open airing closes at the LAST BEAT RECEIVED, not at the moment the session ended — the page was last seen alive then", async () => {
    const c = await composedRig("generic");
    const sponsorId = await c.sponsor("Riverside Physio");
    const t0 = c.r.now();
    const scene = startItem({ momentId: `scene:${SPONSOR_CAROUSEL_SCENES[0]!}:1`, cardId: sponsorId, style: CAROUSEL_STYLE, source: "scene", breakKind: null, at: t0 });
    await c.beat({ state: "playing", airings: [scene] });
    c.r.tick(2 * SEC);
    const lastBeat = c.r.now();
    await c.beat({ state: "playing" });
    // No more beats. 5 s later the organiser stops; the Machine is observed gone a second after that.
    c.r.tick(5 * SEC);
    await stopSession(c.r.auth, c.r.fixtureId, c.S, c.r.deps);
    c.r.tick(SEC);
    const endedAt = c.r.now();
    expect((await currentSession(c.r.auth, c.r.fixtureId, c.r.deps))!.state, "premise: the session ended without a final beat").toBe("completed");
    expect(endedAt.getTime(), "premise: the session ended BEFORE the scene hold ran out (so only the anchor decides)").toBeLessThan(t0.getTime() + SCENE_CAROUSEL_MS);
    expect(await airingsOf(c.S)).toEqual([expect.objectContaining({ ended_at: lastBeat, ended_estimated: true, cut_short: true })]);
  });

  it("closeOpenAirings: only this session's OPEN rows; each ends at the EARLIER of the session end and its start + its slot's hold (scene carousel, lower third, banner — the S6/S7 declarations), never before its own start; cut_short; returns how many it closed (0 for none)", async () => {
    expect(AIRING_HOLD_MS, "the declarations the page holds by").toEqual({ scene: SCENE_CAROUSEL_MS, lower_third: SPONSOR_STYLE_BY_SIZE.minor.holdMs, banner: SPONSOR_STYLE_BY_SIZE.major.holdMs });
    const p = await plainSession();
    const other = await plainSession();
    const sponsorId = await sponsorRow(p.orgId, "Acme");
    const otherSponsor = await sponsorRow(other.orgId, "Other Org Sponsor");
    const end = new Date();
    const ago = (ms: number) => new Date(end.getTime() - ms);
    const scene = (s: typeof p.s, cardId: string, n: number, at: Date) =>
      record(s, [startItem({ momentId: `scene:starting:${n}`, cardId, style: CAROUSEL_STYLE, source: "scene", breakKind: null, at })], end);
    const breakCard = async (seq: number, size: "minor" | "major", at: Date) => {
      const look = SPONSOR_STYLE_BY_SIZE[size];
      const kind = size === "minor" ? OVER_END.kind : INNINGS_BREAK.kind;
      const momentId = sponsorMomentId(seq, kind);
      await persistAssignment(p.orgId, p.fixtureId, { momentId, seq, sponsorId, sponsorName: "Acme", position: seq, source: "rotation", breakKind: kind, style: look.style, holdMs: look.holdMs, operatorChoiceAt: null });
      expect(await record(p.s, [startItem({ momentId, cardId: sponsorId, style: look.style, breakKind: kind, at })], end)).toMatchObject({ written: 1 });
      return momentId;
    };
    const FAR = 5 * MIN;
    // [moment, start, the end it must get] — every slot started far before the end (capped at the hold), the shortest hold
    // started a beat before the end (the session end comes first), and one started AFTER the end the caller names.
    const cases: [string, Date, Date][] = [];
    await scene(p.s, sponsorId, 1, ago(FAR));
    cases.push(["scene:starting:1", ago(FAR), new Date(ago(FAR).getTime() + SCENE_CAROUSEL_MS)]);
    const minor = await breakCard(10, "minor", ago(FAR));
    cases.push([minor, ago(FAR), new Date(ago(FAR).getTime() + SPONSOR_STYLE_BY_SIZE.minor.holdMs)]);
    const major = await breakCard(11, "major", ago(FAR));
    cases.push([major, ago(FAR), new Date(ago(FAR).getTime() + SPONSOR_STYLE_BY_SIZE.major.holdMs)]);
    const late = await breakCard(12, "major", ago(2 * SEC));
    cases.push([late, ago(2 * SEC), end]);
    await scene(p.s, sponsorId, 2, new Date(end.getTime() + 20 * SEC));
    cases.push(["scene:starting:2", new Date(end.getTime() + 20 * SEC), new Date(end.getTime() + 20 * SEC)]);
    await scene(other.s, otherSponsor, 3, ago(FAR));
    expect(await sql.begin((tx: Tx) => closeOpenAirings(tx, p.sessionId, end))).toBe(cases.length);
    const got = new Map((await airingsOf(p.sessionId)).map((r) => [r.moment_id, r]));
    let checked = 0;
    for (const [moment, startedAt, endedAt] of cases) {
      expect(got.get(moment), moment).toMatchObject({ started_at: startedAt, ended_at: endedAt, ended_estimated: true, cut_short: true });
      checked++;
    }
    console.log(`closeOpenAirings cases checked: ${checked}`);
    expect(checked).toBe(5);
    expect(await airingsOf(other.sessionId), "another session's open airing is untouched").toEqual([expect.objectContaining({ ended_at: null, ended_estimated: false, cut_short: false })]);
    expect(await sql.begin((tx: Tx) => closeOpenAirings(tx, p.sessionId, end)), "a second close finds none").toBe(0);
  });

  it("Review Focus 4: a sponsor deleted before its start line lands still writes the row — sponsor_id null, sponsor_name from the assignment's snapshot", async () => {
    const c = await composedRig("cricket");
    const sponsorId = await c.sponsor(LONG_NAME);
    const brk = breakAt(c.r, 7, OVER_END);
    const { plan } = await assignBreaks({ orgId: c.r.auth.orgId, fixtureId: c.r.fixtureId, cards: [cardOf(sponsorId, LONG_NAME)], breaks: [brk], now: c.r.now().getTime() });
    const lines = sponsorQueueLines(null, { current: sponsorMoments(plan)[0]!, phase: "hold", cutShort: [] }, c.r.now().toISOString()).lines;
    await deleteSponsor(c.r.auth, sponsorId);   // the organiser's own delete (withTenant); the FK nulls the assignment's sponsor
    const [a] = await sql<{ sponsor_id: string | null; sponsor_name: string }[]>`select sponsor_id, sponsor_name from sponsor_assignments where fixture_id = ${c.r.fixtureId}`;
    expect(a, "premise: the assignment survived with its snapshot").toEqual({ sponsor_id: null, sponsor_name: LONG_NAME });
    await c.beat({ state: "playing", airings: lines.map(itemOf) });
    expect(await airingsOf(c.S)).toEqual([expect.objectContaining({ sponsor_id: null, sponsor_name: LONG_NAME, source: "rotation", break_kind: OVER_END.kind })]);
  });

  it("R5: a Play-next card is recorded `operator` from its assignment, though the page sends `rotation` for every break card", async () => {
    const c = await composedRig("cricket");
    const sponsorId = await c.sponsor("Chosen By The Operator");
    const brk = breakAt(c.r, 15, OVER_END);
    const log: OperatorLogEntry[] = [{ at: new Date(c.r.now().getTime() - SEC).toISOString(), field: "next_sponsor_id", value: sponsorId }];
    const { plan, assignments } = await assignBreaks({ orgId: c.r.auth.orgId, fixtureId: c.r.fixtureId, cards: [cardOf(sponsorId, "Chosen By The Operator")], breaks: [brk], now: c.r.now().getTime(), operatorLog: log });
    expect(assignments[0]!.source, "premise: the planner made an operator assignment").toBe("operator");
    const items = sponsorQueueLines(null, { current: sponsorMoments(plan)[0]!, phase: "hold", cutShort: [] }, c.r.now().toISOString()).lines.map(itemOf);
    expect(items[0], "premise: the page says rotation").toMatchObject({ kind: "start", source: "rotation" });
    await c.beat({ state: "playing", airings: items });
    expect(await airingsOf(c.S)).toEqual([expect.objectContaining({ sponsor_id: sponsorId, source: "operator" })]);
  });

  it("ownership: another org's sponsor as a scene card, a corrupt assignment row naming another org, a non-uuid card id and a moment with no assignment are each refused by name; the session's own fixture of another org refuses every item", async () => {
    const p = await plainSession();
    const other = await plainSession();
    const foreignSponsor = await sponsorRow(other.orgId, "Not Yours Ltd");
    const t0 = new Date();
    const sceneOf = (cardId: string, n: number) => startItem({ momentId: `scene:starting:${n}`, cardId, style: CAROUSEL_STYLE, source: "scene", breakKind: null, at: t0 });
    expect(await record(p.s, [sceneOf(foreignSponsor, 1)], t0), "another org's sponsor").toEqual({ written: 0, refused: 1, why: ["unknown_card"] });
    expect(await record(p.s, [sceneOf("gallery-card-gold", 2)], t0), "not a sponsor id at all").toEqual({ written: 0, refused: 1, why: ["unknown_card"] });
    // A row the DB lets in (no composite FK): this fixture's moment, owned by another org.
    const moment = sponsorMomentId(3, OVER_END.kind);
    await persistAssignment(other.orgId, p.fixtureId, { momentId: moment, seq: 3, sponsorId: foreignSponsor, sponsorName: "Not Yours Ltd", position: 0, source: "rotation", breakKind: OVER_END.kind, style: "lower_third", holdMs: 8000, operatorChoiceAt: null });
    expect(await record(p.s, [startItem({ momentId: moment, cardId: foreignSponsor, at: t0 })], t0), "another org's assignment").toEqual({ written: 0, refused: 1, why: ["no_assignment"] });
    expect(await record(p.s, [startItem({ momentId: sponsorMomentId(4, OVER_END.kind), cardId: foreignSponsor, at: t0 })], t0), "no assignment at all").toEqual({ written: 0, refused: 1, why: ["no_assignment"] });
    expect(await airingsOf(p.sessionId)).toEqual([]);
    // The positive pair on the same session: its own sponsor as a scene card is written.
    const own = await sponsorRow(p.orgId, "Yours Ltd");
    expect(await record(p.s, [sceneOf(own, 5)], t0)).toEqual({ written: 1, refused: 0, why: [] });
    // A caller naming another org's fixture for this org: nothing is written at all, every item counted.
    const crossed = { ...p.s, fixtureId: other.fixtureId };
    expect(await record(crossed, [sceneOf(own, 6), sceneOf(own, 7)], t0)).toEqual({ written: 0, refused: 2, why: ["foreign_fixture", "foreign_fixture"] });
    expect((await airingsOf(p.sessionId)).map((r) => r.moment_id)).toEqual(["scene:starting:5"]);
    expect(sponsorIdOfCard(own)).toBe(own);
    expect(sponsorIdOfCard("gallery-card-gold")).toBeNull();
  });

  it("the beat's own guards: a SUPERSEDED Machine's airings are not recorded (a sample only); a beat received after this attempt's final still records its airings (they predate the final)", async () => {
    const c = await composedRig("cricket");
    const sponsorId = await c.sponsor("Acme");
    const t0 = c.r.now();
    const scene = (n: number) => startItem({ momentId: `scene:starting:${n}`, cardId: sponsorId, style: CAROUSEL_STYLE, source: "scene", breakKind: null, at: t0 });
    await c.beat({ state: "playing" });
    // A final that leaves the session running (record-only, R2003: `signalled`), then a late periodic beat.
    await c.beat({ state: "stopped", exitReason: "signalled" });
    expect(await c.beat({ state: "playing", airings: [scene(1)] })).toMatchObject({ desiredState: "live" });
    expect((await airingsOf(c.S)).map((r) => r.moment_id), "the post-final beat's item").toEqual(["scene:starting:1"]);
    // A retry moved the attempt on: the original Machine's token is now a superseded one's.
    await sql`update fixture_stream_sessions set runner_attempts = runner_attempts + 1 where id = ${c.S}`;
    expect(await c.beat({ state: "playing", airings: [scene(2)] }), "premise: the superseded Machine is told to drain").toEqual({ desiredState: "ending" });
    expect((await airingsOf(c.S)).map((r) => r.moment_id)).toEqual(["scene:starting:1"]);
  });

  it("R14: neither beat store keeps the list — last_heartbeat and the sample's raw carry every other field, airingsDropped included, and no `airings`", async () => {
    const c = await composedRig("cricket");
    const sponsorId = await c.sponsor("Acme");
    const item = startItem({ momentId: "scene:starting:1", cardId: sponsorId, style: CAROUSEL_STYLE, source: "scene", breakKind: null, at: c.r.now() });
    await c.beat({ state: "playing", programmePhase: "live", airingsDropped: 2, airings: [item] });
    expect(await airingsOf(c.S), "premise: the item was recorded").toHaveLength(1);
    const [s] = await sql<{ last_heartbeat: Record<string, unknown> }[]>`select last_heartbeat from fixture_stream_sessions where id = ${c.S}`;
    expect(s!.last_heartbeat).toEqual({ state: "playing", programmePhase: "live", airingsDropped: 2 });
    const [sample] = await sql<{ raw: Record<string, unknown> }[]>`
      select raw from fixture_stream_samples where session_id = ${c.S} and source = 'heartbeat' order by sampled_at desc limit 1`;
    expect(sample!.raw).toEqual({ state: "playing", programmePhase: "live", airingsDropped: 2 });
  });

  it("SC1 addendum: `airingsDropped` arrives ALONE on every beat once above 0 (a process total, reset by a restart) — a beat with only `airingsDropped: 3` is accepted and stored in both beat stores, and records nothing", async () => {
    const c = await composedRig("cricket");
    expect(await c.routeBeat({ state: "playing", airingsDropped: 3 }).then((r) => r.status)).toBe(200);
    const [s] = await sql<{ last_heartbeat: Record<string, unknown> }[]>`select last_heartbeat from fixture_stream_sessions where id = ${c.S}`;
    expect(s!.last_heartbeat).toEqual({ state: "playing", airingsDropped: 3 });
    const [sample] = await sql<{ raw: Record<string, unknown> }[]>`
      select raw from fixture_stream_samples where session_id = ${c.S} and source = 'heartbeat' order by sampled_at desc limit 1`;
    expect(sample!.raw).toEqual({ state: "playing", airingsDropped: 3 });
    expect(await airingsOf(c.S)).toEqual([]);
    // A restarted compositor reports a smaller total: stored as sent (an upper bound per process, never a running max).
    c.r.tick(5 * SEC);
    await c.beat({ state: "playing", airingsDropped: 1 });
    const [s2] = await sql<{ last_heartbeat: Record<string, unknown> }[]>`select last_heartbeat from fixture_stream_sessions where id = ${c.S}`;
    expect(s2!.last_heartbeat).toEqual({ state: "playing", airingsDropped: 1 });
  });

  it("isolation: an airing write that FAILS in the database never costs the beat (stored, answered) — and the next beat's items still land; a failing close never stops the session ending", async () => {
    const c = await composedRig("cricket");
    const sponsorId = await c.sponsor("Acme");
    const scene = (n: number) => startItem({ momentId: `scene:starting:${n}`, cardId: sponsorId, style: CAROUSEL_STYLE, source: "scene", breakKind: null, at: c.r.now() });
    // A real SQL failure on the beat's own transaction: without a savepoint the beat's next statement would be refused
    // ("current transaction is aborted") and the Machine's beat would 500 until the session went stale.
    vi.mocked(recordAirings).mockImplementationOnce(async (tx) => { await tx`select 1 / 0`; return { written: 0, refused: 0, why: [] }; });
    expect(await c.beat({ state: "playing", programmePhase: "live", airings: [scene(1)] })).toMatchObject({ desiredState: "live" });
    const [s] = await sql<{ last_heartbeat: Record<string, unknown> }[]>`select last_heartbeat from fixture_stream_sessions where id = ${c.S}`;
    expect(s!.last_heartbeat, "the beat was stored").toEqual({ state: "playing", programmePhase: "live" });
    expect(await airingsOf(c.S)).toEqual([]);
    c.r.tick(5 * SEC);
    await c.beat({ state: "playing", airings: [scene(2)] });
    expect((await airingsOf(c.S)).map((r) => r.moment_id)).toEqual(["scene:starting:2"]);
    const closes = vi.mocked(closeOpenAirings).mock.calls.length;
    vi.mocked(closeOpenAirings).mockImplementationOnce(async (tx) => { await tx`select 1 / 0`; return 0; });
    await c.beat({ state: "stopped", exitReason: "ended" });
    const [after] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${c.S}`;
    expect(after!.state, "the session still ended").toBe("completed");
    expect(vi.mocked(closeOpenAirings).mock.calls.length - closes, "the close was attempted once").toBe(1);
    expect(await airingsOf(c.S), "the failed close left the airing open (it was not silently done)").toEqual([expect.objectContaining({ ended_at: null, ended_estimated: false })]);
  });
});
