// R4 sponsors on stream, S5 — the overlay answer's `sponsorPlan`, driven through the REAL loader (`loadOverlayLiveData`)
// over a REAL ledger (`appendEvent`), and on to proof of play. The seam the whole programme rests on (AGENTS.md class 1):
//
//   real events → the fold's replay (natural breaks, opened by the sport's own `opensAt`) → `loadSponsorPlan` (S4's
//   planner, the assignment rows) → the answer's `sponsorPlan` → the page's own moment and line builders (S6
//   `sponsorMoments`, S7 `sponsorQueueLines` / the carousel's `carouselStep` + `carouselLines`) → SC1's conversion →
//   S8's `recordAirings` → one sponsor_airings row naming the sponsor.
//
// Nothing below hand-builds a plan, a break or a wire line. Expectations: the FIH laws as hockey declares them (an
// interval after Q1 and Q3, half-time after Q2, a break before a shoot-out — major, S1/S2's ruling), §3.2's dial, and
// P7's smooth weighted round robin over D9's weights (title 3, gold 2: T, G, T, G, T).
//
// `unstable_cache` is stubbed passthrough (no incremental cache outside the Next runtime — the route test's reason); the
// fold, the replay, the planner and every write run for real against Postgres.
//
// Sequence (TEST-STRATEGY rule 1): a first poll writes, a second (the other door) serves the frozen rows; a REAL void
// undoes a break and its unaired assignment goes, while the aired one stays; a fixture with no events serves the
// carousel's cards and no airings; sponsors off serves null. Two sports: hockey (the shoot-out break) and volleyball (a
// timeout, a minor, on Busy).
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { sql, type Tx } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import { RelayAiring } from "@/server/api-v1/schemas";
import { SIGNAL_SPONSOR_END, SIGNAL_SPONSOR_START, sponsorQueueLines } from "@/lib/overlay-compositor";
import { sponsorMoments } from "@/lib/overlay-moments";
import { SPONSOR_STYLE_BY_SIZE, sponsorMomentId, type SponsorFrequency, type SponsorPlan } from "@/lib/sponsor-plan";
import { SPONSOR_SHORT_CODE_PATTERN } from "@/lib/sponsor-short-code";
import { CAROUSEL_INITIAL, CAROUSEL_STYLE, carouselLines, carouselOrder, carouselStep } from "@/components/overlay/sponsor-card";
import { SPONSOR_CAROUSEL_SCENES } from "@/components/overlay/overlay-scenes";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { appendEvent } from "@/server/engine-db/append-event";
import { rigTarget, rigUser } from "@/server/relay/__tests__/_session-rig";
import { recordAirings } from "@/server/sponsors/airings";
import { log } from "@/server/logger";
import { loadOverlayLiveData } from "../load";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The size hockey declares for a kind — read off the module. */
const hockeySize = (kind: string) => {
  const k = builtinModules.find((m) => m.key === "hockey")?.naturalBreaks?.kinds.find((d) => d.kind === kind);
  if (k === undefined) throw new Error(`hockey declares no "${kind}"`);
  return k.size;
};

interface Seeded {
  orgId: string;
  competitionId: string;
  divisionId: string;
  fixtureId: string;
  home: string;
  tip: number;
}
async function seedFixture(sportKey: "hockey" | "volleyball", variantKey: string): Promise<Seeded> {
  const { auth } = await seedOrg("pro");
  const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: "Sponsor Cup", visibility: "public", branding: {} });
  const division = await createDivision(auth, competition.id, { name: "Open", sport_key: sportKey, variant_key: variantKey, config: {} });
  await createEntrants(auth, division.id, ["Harbour", "Ridge"].map((name, i) => ({ kind: "team" as const, display_name: name, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const fx = fixtures[0]! as { id: string; home_entrant_id: string };
  return { orgId: auth.orgId, competitionId: competition.id, divisionId: division.id, fixtureId: fx.id, home: fx.home_entrant_id, tip: 0 };
}
async function append(s: Seeded, type: string, payload: unknown, voids?: string) {
  const r = await appendEvent(s.orgId, s.fixtureId, s.tip, { type, payload, ...(voids === undefined ? {} : { voids }) });
  s.tip = r.seq;
  return r;
}
async function sponsor(orgId: string, name: string, tier = "partner"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, url, tier, on_stream) values (${orgId}, ${name}, ${"https://example.com/" + encodeURIComponent(name)}, ${tier}, true)
    returning id`;
  return row!.id;
}
const rotationOn = (orgId: string, frequency: SponsorFrequency) => sql`
  insert into sponsor_stream_settings (org_id, enabled, frequency) values (${orgId}, true, ${frequency})`;

/** A live session row on the fixture (proof of play keys on it), seated the way `streamRig` seats one. */
async function liveSession(s: Seeded): Promise<string> {
  const targetId = await rigTarget(s.orgId);
  const createdBy = await rigUser();
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override)
    select f.id, ${s.orgId}, 'passthrough', 'live', ${targetId}, ${createdBy}, d.sport_key, d.competition_id, f.division_id, true
      from fixtures f join divisions d on d.id = f.division_id where f.id = ${s.fixtureId}
    returning id`;
  return row!.id;
}
/** SC1's conversion (spec §3.6.2): the line's name is `kind`, its JSON the rest — parsed by the contract twin. */
function itemOf(line: string): RelayAiring {
  const space = line.indexOf(" ");
  const signal = line.slice(0, space);
  if (signal !== SIGNAL_SPONSOR_START && signal !== SIGNAL_SPONSOR_END) throw new Error(`not a sponsor line: ${line}`);
  return RelayAiring.parse({ kind: signal === SIGNAL_SPONSOR_START ? "start" : "end", ...(JSON.parse(line.slice(space + 1)) as object) });
}
const airedBy = (plan: SponsorPlan | undefined) =>
  Object.fromEntries((plan?.airings ?? []).map((a) => [a.momentId, plan!.cards.find((c) => c.id === a.cardId)?.sponsorId ?? "?"]));
const rowsOf = (fixtureId: string) => sql<{ moment_id: string; sponsor_id: string | null; position: number | null; style: string }[]>`
  select moment_id, sponsor_id, position, style from sponsor_assignments where fixture_id = ${fixtureId} order by seq`;
const airingRowsOf = (sessionId: string) => sql<{ sponsor_id: string | null; moment_id: string; source: string; break_kind: string | null; style: string }[]>`
  select sponsor_id, moment_id, source, break_kind, style from sponsor_airings where session_id = ${sessionId} order by started_at, moment_id`;

describe.skipIf(!HAS_DB)("S5: the overlay answer's sponsorPlan, from a real ledger to proof of play", () => {
  it("hockey (FIH shoot-out), Light: four whistles → four break cards T, G, T, G; both doors serve the SAME plan; the page's own lines record ONE airing each for a break card and a carousel showing; a real void deletes the undone break's unaired assignment", async () => {
    const s = await seedFixture("hockey", "fih-shootout");
    await rotationOn(s.orgId, "light");
    const title = await sponsor(s.orgId, "Harbourside Building Supplies and Timber Co", "title");
    const gold = await sponsor(s.orgId, "Gold Co", "gold");
    await append(s, "core.start", {});
    const q2 = await append(s, "hockey.period.advance", { to: "Q2" });
    const q3 = await append(s, "hockey.period.advance", { to: "Q3" });
    const q4 = await append(s, "hockey.period.advance", { to: "Q4" });
    const ft = await append(s, "hockey.period.advance", { to: "FT" });

    const pub = await loadOverlayLiveData(s.fixtureId);
    const want = {
      [sponsorMomentId(q2.seq, "quarter_end")]: title,
      [sponsorMomentId(q3.seq, "half_time")]: gold,
      [sponsorMomentId(q4.seq, "quarter_end")]: title,
      [sponsorMomentId(ft.seq, "shootout_break")]: gold,
    };
    expect(airedBy(pub.sponsorPlan)).toEqual(want);
    for (const kind of ["quarter_end", "half_time", "shootout_break"]) expect(hockeySize(kind), `premise: ${kind} is a major`).toBe("major");
    for (const a of pub.sponsorPlan!.airings) expect([a.style, a.holdMs]).toEqual([SPONSOR_STYLE_BY_SIZE.major.style, SPONSOR_STYLE_BY_SIZE.major.holdMs]);
    expect((await rowsOf(s.fixtureId)).map((r) => r.position)).toEqual([0, 1, 2, 3]);
    // Every card: its id IS its sponsor's (S8), and a linkable sponsor carries its minted code (R7).
    for (const c of pub.sponsorPlan!.cards) {
      expect(c.id).toBe(c.sponsorId);
      expect(c.shortCode).toMatch(SPONSOR_SHORT_CODE_PATTERN);
    }

    // The other door (the composed page behind relayPageAccess): the same plan, from the frozen rows, nothing written.
    const relay = await loadOverlayLiveData(s.fixtureId, { relay: true });
    expect(relay.sponsorPlan).toEqual(pub.sponsorPlan);
    expect(await rowsOf(s.fixtureId)).toHaveLength(4);

    // Proof of play for a BREAK card: the Q4 interval's moment, through the page's queue lines, to S8's writer.
    const sessionId = await liveSession(s);
    const q4Id = sponsorMomentId(q4.seq, "quarter_end");
    const moment = sponsorMoments(relay.sponsorPlan ?? null).find((m) => `${m.seq}:${m.kind}` === `${q4.seq}:sponsor.quarter_end`);
    expect(moment, "premise: the page queues the Q4 interval's card").toBeDefined();
    const on = sponsorQueueLines(null, { current: moment!, phase: "hold", cutShort: [] }, new Date().toISOString());
    expect(on.lines).toHaveLength(1);
    const scope = { sessionId, orgId: s.orgId, fixtureId: s.fixtureId };
    const wrote = await sql.begin((tx: Tx) => recordAirings(tx, scope, on.lines.map(itemOf), new Date()));
    expect(wrote).toMatchObject({ written: 1, refused: 0 });

    // …and for a CAROUSEL showing: the ticked cards in the page's order, one 10 s showing, to the same writer.
    const ticked = carouselOrder(relay.sponsorPlan!.cards.filter((c) => c.onStream === true));
    expect(ticked.map((c) => c.sponsorId), "the carousel leads with the title").toEqual([title, gold]);
    const t0 = Date.now();
    const showing = carouselStep(CAROUSEL_INITIAL, { now: t0, order: ticked.map((c) => c.id), yielding: false, scene: SPONSOR_CAROUSEL_SCENES[0]! });
    const shown = carouselLines(null, showing, new Date(t0).toISOString());
    expect(shown.lines).toHaveLength(1);
    expect(await sql.begin((tx: Tx) => recordAirings(tx, scope, shown.lines.map(itemOf), new Date(t0)))).toMatchObject({ written: 1, refused: 0 });
    expect(await airingRowsOf(sessionId)).toEqual(expect.arrayContaining([
      { sponsor_id: title, moment_id: q4Id, source: "rotation", break_kind: "quarter_end", style: SPONSOR_STYLE_BY_SIZE.major.style },
      { sponsor_id: title, moment_id: showing.showing!.momentId, source: "scene", break_kind: null, style: CAROUSEL_STYLE },
    ]));
    expect(await airingRowsOf(sessionId)).toHaveLength(2);

    // The scorer takes back the full-time whistle — a REAL void. The shoot-out break is undone and never aired: its
    // assignment goes. The aired Q4 interval and the rest stay.
    await append(s, "core.void", {}, ft.event.id);
    const after = await loadOverlayLiveData(s.fixtureId);
    const kept = Object.fromEntries(Object.entries(want).filter(([id]) => id !== sponsorMomentId(ft.seq, "shootout_break")));
    expect(Object.keys(kept), "premise: one break removed").toHaveLength(3);
    expect(airedBy(after.sponsorPlan)).toEqual(kept);
    expect((await rowsOf(s.fixtureId)).map((r) => [r.moment_id, r.position])).toEqual([
      [sponsorMomentId(q2.seq, "quarter_end"), 0], [sponsorMomentId(q3.seq, "half_time"), 1], [q4Id, 2],
    ]);
    // Re-blowing full time opens a NEW shoot-out break (a new seq): the org's next position.
    const ft2 = await append(s, "hockey.period.advance", { to: "FT" });
    const again = await loadOverlayLiveData(s.fixtureId, { relay: true });
    expect(airedBy(again.sponsorPlan)[sponsorMomentId(ft2.seq, "shootout_break")]).toBeDefined();
    expect((await rowsOf(s.fixtureId)).at(-1)?.position, "positions are max + 1 over the rows that remain: the undone 3 is handed out again").toBe(3);
  });

  it("volleyball, Busy: sponsors off ⇒ null on both doors; on, before the first rally ⇒ the carousel's cards and no airings; a timeout (a minor) gets a card", async () => {
    const s = await seedFixture("volleyball", "indoor");
    const a = await sponsor(s.orgId, "Acme Physio");
    const off = await loadOverlayLiveData(s.fixtureId);
    expect(off).toHaveProperty("sponsorPlan", null);
    expect((await loadOverlayLiveData(s.fixtureId, { relay: true })).sponsorPlan).toBeNull();

    await rotationOn(s.orgId, "busy");
    const before = await loadOverlayLiveData(s.fixtureId);
    expect(before.lastSeq, "premise: no events yet").toBeNull();
    expect(before.sponsorPlan).toEqual({
      cards: [{ id: a, sponsorId: a, name: "Acme Physio", logoUrl: null, tier: "partner", onStream: true, shortCode: expect.stringMatching(SPONSOR_SHORT_CODE_PATTERN) }],
      airings: [],
    });
    expect((await loadOverlayLiveData(s.fixtureId, { relay: true })).sponsorPlan).toEqual(before.sponsorPlan);

    await append(s, "core.start", {});
    const timeout = await append(s, "volleyball.timeout", { by: s.home });
    const live = await loadOverlayLiveData(s.fixtureId, { relay: true });
    expect(airedBy(live.sponsorPlan)).toEqual({ [sponsorMomentId(timeout.seq, "timeout")]: a });
    expect(live.sponsorPlan!.airings[0]).toMatchObject({ style: SPONSOR_STYLE_BY_SIZE.minor.style, holdMs: SPONSOR_STYLE_BY_SIZE.minor.holdMs });
    expect((await loadOverlayLiveData(s.fixtureId)).sponsorPlan).toEqual(live.sponsorPlan);
    expect(await rowsOf(s.fixtureId)).toHaveLength(1);

    // The fold FAILS (an entrant deleted after scoring leaves the fixture unattributable: `loadFoldInputs` refuses it,
    // and the loader serves the row without its fold). No replay ran, so no break is proven gone (R3): the unaired
    // timeout card keeps its row, and the cards are still served.
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    try {
      await sql`update fixtures set away_entrant_id = null where id = ${s.fixtureId}`;
      const fellBack = await loadOverlayLiveData(s.fixtureId);
      expect(error, "premise: the fold really failed").toHaveBeenCalledWith(expect.anything(), expect.stringContaining("fold failed"));
      expect(fellBack.sponsorPlan).toEqual({ cards: live.sponsorPlan!.cards, airings: [] });
      expect(await rowsOf(s.fixtureId), "nothing deleted on an unproven absence").toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });
});
