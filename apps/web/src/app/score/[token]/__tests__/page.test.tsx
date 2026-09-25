// P9 pass 3c-3 site 3: the live scoring page (highest-traffic surface in the
// cutover debt ledger) SELECTed raw fixtures.venue/court_label directly —
// both frozen since pass 3a, so any fixture scheduled post-cutover showed a
// blank court to a scorer opening the pad. Now derives court_label/venue via
// courts/venues joined on court_id/venue_id (same pattern as usecases/me.ts).
// Real Postgres required; skipped without DATABASE_URL. No-jsdom tree walk —
// same convention as officials-fixture-locale.test.tsx / the
// server-component-page-test memory: an async server component returns an
// element TREE, so no renderToStaticMarkup is needed to read what it handed
// a named child.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomBytes as kekBytes } from "node:crypto";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { sql } from "@/lib/db";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants, getEntrant } from "@/server/usecases/entrants";
import { getFixtureState, getLineup, listEvents, loadFixturePadCfg, putLineup } from "@/server/usecases/fixtures";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { startDivision } from "@/server/usecases/schedule";
import { createDeviceLink, ensureDeviceLink } from "@/server/usecases/device-links";
import { seedCourts, seedOrg } from "@/server/usecases/__tests__/_seed";
import { decide, deviceFor, fixturesOf, seedStage } from "@/server/usecases/__tests__/_sheets-rig";
import { DeviceScorePad, type PadSideInfo } from "@/components/v2/device-score-pad";
import { buildScorerSheet } from "@/server/usecases/scorer-sheets";
import { entrantDisplayName } from "@/lib/entrant-name";
import { intlLocaleFor } from "@/lib/public-date-locale";
import { ScanWaiting } from "@/components/v2/scan-waiting";
import { DictProvider } from "@/components/i18n/dict-provider";
import { HtmlLang } from "@/components/i18n/html-lang";
import {
  boardRoundCodes,
  withRoundCodeRefs,
  type RoundCodeFixture,
  type SeatLabelFixture,
} from "@/components/v2/board/round-codes";
import { cardTitle, type BoardFixture } from "@/components/v2/board/types";
import { feedLabels, type FeedRow } from "@/lib/schedule-board";
import { resolveSlotLabel } from "@/lib/slot-label";
import { composeMatchRef } from "@/lib/match-ref";
import { t as tRuntime } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import ScorePadPage from "../page";

/** The viewer's dictionary as a lookup, the way the page renders with it. */
const lookupFor = (dict: Record<string, string>) => (key: string, vars?: Record<string, string | number>) =>
  tRuntime(dict, key as Parameters<typeof tRuntime>[1], vars);

/** OWNER RULING 2026-09-24: the scan screens name a match the way the schedule
 *  board does. The expected names come from the BOARD's own function over the
 *  stage's rows (never a typed "SF·1"), so a change to the board's codes moves
 *  these tests with it. */
async function boardNames(stageId: string, dict: Record<string, string>) {
  const lookup = lookupFor(dict);
  const rows = await sql<RoundCodeFixture[]>`
    select id, stage_id, round_no, seq_in_round, ext_key, lane, is_final, third_place, conditional
    from fixtures where stage_id = ${stageId}`;
  const stages = await sql<{ id: string; kind: string }[]>`select id, kind from stages where id = ${stageId}`;
  const codes = boardRoundCodes(rows, stages, lookup);
  const ref = (id: string) => {
    const row = rows.find((r) => r.id === id)!;
    const rc = codes.get(id);
    return composeMatchRef(row.round_no, rc?.refSeq ?? row.seq_in_round, lookup, rc?.code);
  };
  return {
    ref,
    code: (id: string) => codes.get(id)?.code,
    winnerOf: (id: string) => lookup("slot.winner_match", { ext: ref(id) }),
    /** The round as the board's legend names it ("Final"); undefined where
     *  the board codes no round (a league, Swiss). */
    label: (id: string) => codes.get(id)?.label,
    /** What the board prints for a round it does not code. */
    roundN: (id: string) => lookup("schedule.round", { n: rows.find((r) => r.id === id)!.round_no }),
  };
}

type PadFixture = { fixture: { match_ref: string; round_label: string } };

type WaitingProps = {
  home: string;
  away: string;
  matchRef: string;
  meta: string[];
  copy: { lead: string; vs: string; hint: string };
  waitingOn?: "sides" | "division_start";
};

// The page resolves the viewer's locale from the request (cookie, user,
// header); there is no request here. Hoisted so one test can switch it.
const locale = vi.hoisted(() => ({ value: "en" as "en" | "fr" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => locale.value }));

// The pad's own loads, passed through to the real ones and recorded, so a test
// can say which of them a screen paid for (review 2026-09-25: a waiting screen
// re-renders every POLL_MS, and must not load the pad to print two names).
vi.mock("@/server/usecases/fixtures", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/fixtures")>();
  return {
    ...real,
    loadFixturePadCfg: vi.fn(real.loadFixturePadCfg),
    getFixtureState: vi.fn(real.getFixtureState),
    listEvents: vi.fn(real.listEvents),
    getLineup: vi.fn(real.getLineup),
  };
});
vi.mock("@/server/usecases/entrants", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/entrants")>();
  return { ...real, getEntrant: vi.fn(real.getEntrant) };
});

// Every mint seals now (scorer sheets §4.1). A throwaway key of this file's own,
// never the developer's .env.local one: CI's unit job has no DEVICE_LINK_KEK at
// all. Never printed; restored in afterAll.
vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return find((node.props as { children?: ReactNode }).children, type);
}

/** A two-entrant league's one fixture, both sides known. STARTED by default —
 *  "scorable" is the point, and since the owner fix of 2026-09-24 an unstarted
 *  division's scan opens on "Not started yet", not the pad. `start: false`
 *  leaves it drawn but unstarted, the way a sheet printed early finds it. */
async function seedScorableFixture({ start = true }: { start?: boolean } = {}): Promise<{
  auth: Awaited<ReturnType<typeof seedOrg>>["auth"];
  courtId: string;
  fixtureId: string;
  divisionId: string;
}> {
  const { auth } = await seedOrg("pro");
  const [courtId] = await seedCourts(auth.orgId, 1);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Score " + Math.random().toString(36).slice(2, 8),
    visibility: "public",
    branding: {},
  });
  const div = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    div.id,
    ["A", "B"].map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, div.id, { seq: 1, kind: "league", name: "L", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  if (start) await startDivision(auth, div.id);
  return { auth, courtId: courtId!, fixtureId: fixtures[0]!.id, divisionId: div.id };
}

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("ScorePadPage (P9 cutover)", () => {
  it("renders the court_id's live name, not a stale fixtures.court_label", async () => {
    const { auth, courtId, fixtureId } = await seedScorableFixture();
    await sql`
      update fixtures set court_label = 'Stale Court', court_id = ${courtId}
      where id = ${fixtureId}`;
    const link = await createDeviceLink(auth, fixtureId, null);

    const tree = await ScorePadPage({ params: Promise.resolve({ token: link.secret }) });
    const pad = find(tree, DeviceScorePad);
    expect(pad).not.toBeNull();
    const fixtureProp = (pad!.props as { fixture: { court_label: string | null; venue: string | null } }).fixture;
    expect(fixtureProp.court_label).toBe("Court 1");
    expect(fixtureProp.court_label).not.toBe("Stale Court");
  });

  it("archived court still renders its name, never blank", async () => {
    const { auth, courtId, fixtureId } = await seedScorableFixture();
    await sql`update fixtures set court_id = ${courtId} where id = ${fixtureId}`;
    await sql`update courts set archived_at = now() where id = ${courtId}`;
    const link = await createDeviceLink(auth, fixtureId, null);

    const tree = await ScorePadPage({ params: Promise.resolve({ token: link.secret }) });
    const pad = find(tree, DeviceScorePad);
    const fixtureProp = (pad!.props as { fixture: { court_label: string | null } }).fixture;
    expect(fixtureProp.court_label).toBe("Court 1");
  });

  it("no court assigned renders null, never a bare uuid or the fixture id", async () => {
    const { auth, fixtureId } = await seedScorableFixture();
    const link = await createDeviceLink(auth, fixtureId, null);

    const tree = await ScorePadPage({ params: Promise.resolve({ token: link.secret }) });
    const pad = find(tree, DeviceScorePad);
    const fixtureProp = (pad!.props as { fixture: { court_label: string | null } }).fixture;
    expect(fixtureProp.court_label).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("ScorePadPage screens (scorer sheets §4.5)", () => {
  it("TBD side → Waiting, naming each feeder and the match the way the board does, no pad", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const fixtures = await fixturesOf(stage.id);
    const final = fixtures.find((f) => f.round_no === 2)!;
    const semis = fixtures.filter((f) => f.round_no === 1);
    const board = await boardNames(stage.id, en);
    const { secret } = await ensureDeviceLink(auth, final.id);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    const waiting = find(tree, ScanWaiting);
    expect(waiting).not.toBeNull();
    expect(find(tree, DeviceScorePad)).toBeNull();
    const { home, away, matchRef, copy } = waiting!.props as WaitingProps;
    expect([home, away].sort(), "each seat names its own feeder, by the board's code").toEqual(
      semis.map((s) => board.winnerOf(s.id)).sort(),
    );
    expect(matchRef, "the match itself, by the board's code").toBe(board.ref(final.id));
    // The differential: the board codes a knockout, so the old "R2·1" is wrong.
    expect(matchRef).not.toMatch(/^R\d/);
    expect(home).not.toMatch(/R\d·/);
    expect(copy, "Waiting's own words, in the viewer's language").toEqual({
      lead: en["device.scan.waitingFor"],
      vs: en["schedule.vs"],
      hint: en["device.scan.waitingHint"],
    });
    expect((waiting!.props as WaitingProps).waitingOn, "a started division waits on its sides").toBe("sides");
  });

  // Owner fix 2026-09-24: a sheet printed before the organiser presses Start
  // opened on Confirm, and its Start was refused (generic WRONG_PHASE copy).
  // Real producers end to end: the division is drawn by the real generator and
  // started by the real `startDivision`; the page reads the status itself.
  it("an unstarted division → Not started yet, with its own words, the match's names and ref, and no pad — then the pad once started", async () => {
    const { auth, fixtureId, divisionId } = await seedScorableFixture({ start: false });
    const [{ stage_id: stageId }] = await sql<{ stage_id: string }[]>`select stage_id from fixtures where id = ${fixtureId}`;
    const board = await boardNames(stageId!, en);
    const { secret } = await ensureDeviceLink(auth, fixtureId);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    const waiting = find(tree, ScanWaiting);
    expect(waiting, "an unstarted division's scan is a waiting screen").not.toBeNull();
    expect(find(tree, DeviceScorePad), "…with no pad, so no Start to be refused").toBeNull();
    const { home, away, matchRef, copy, waitingOn } = waiting!.props as WaitingProps;
    expect(waitingOn, "…waiting on the division's start, not on a side").toBe("division_start");
    expect(copy).toEqual({
      lead: en["device.scan.notStarted.title"],
      vs: en["schedule.vs"],
      hint: en["device.scan.notStarted.body"],
    });
    expect([home, away].sort(), "the match's two sides, by name, as Waiting names a known side").toEqual(["A", "B"]);
    expect(matchRef).toBe(board.ref(fixtureId));
    // The same token after the organiser's start: the page reads the division's
    // status in its own render, so the next refresh is Confirm (the pad).
    await startDivision(auth, divisionId);
    const after = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    expect(find(after, ScanWaiting), "started: no waiting screen").toBeNull();
    const pad = find(after, DeviceScorePad);
    expect(pad, "started: the pad (Confirm) renders").not.toBeNull();
    expect((pad!.props as { initialViewOnly: string | null }).initialViewOnly).toBeNull();
  });

  it("Not started outranks Waiting: an unstarted knockout's TBD final waits on the start, naming its feeders by the board's codes", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Early " + Math.random().toString(36).slice(2, 8),
      visibility: "private",
      branding: {},
    });
    const div = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(
      auth,
      div.id,
      ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, div.id, { seq: 1, kind: "knockout", name: "Cup", config: {} });
    await generateStageFixtures(auth, stage!.id);
    const fixtures = await fixturesOf(stage!.id);
    const final = fixtures.find((f) => f.round_no === 2)!;
    expect(final.home_entrant_id, "precondition: the final's seats are TBD").toBeNull();
    const board = await boardNames(stage!.id, en);
    const waiting = find(
      await ScorePadPage({ params: Promise.resolve({ token: (await ensureDeviceLink(auth, final.id)).secret }) }),
      ScanWaiting,
    );
    expect(waiting).not.toBeNull();
    const { home, away, matchRef, waitingOn } = waiting!.props as WaitingProps;
    expect(waitingOn, "the division's start, not the seats").toBe("division_start");
    expect([home, away].sort()).toEqual(fixtures.filter((f) => f.round_no === 1).map((s) => board.winnerOf(s.id)).sort());
    expect(matchRef).toBe(board.ref(final.id));
  });

  it("a French viewer's Not started yet carries its own French strings, with NO dictionary provider, and says the page is French", async () => {
    locale.value = "fr";
    try {
      const { auth, fixtureId } = await seedScorableFixture({ start: false });
      const tree = await ScorePadPage({
        params: Promise.resolve({ token: (await ensureDeviceLink(auth, fixtureId)).secret }),
      });
      const waiting = find(tree, ScanWaiting);
      expect(waiting, "precondition: the not-started screen").not.toBeNull();
      expect(find(tree, DictProvider), "no dictionary rides on every refresh").toBeNull();
      expect((find(tree, HtmlLang)!.props as { lang?: string }).lang).toBe("fr");
      const { copy, waitingOn } = waiting!.props as WaitingProps;
      // The French words alone do not say WHICH wait this is: a page that
      // handed them to the sides' Waiting would still pass the copy pin.
      expect(waitingOn, "…the division's start, not the sides").toBe("division_start");
      expect(copy).toEqual({
        lead: fr["device.scan.notStarted.title"],
        vs: fr["schedule.vs"],
        hint: fr["device.scan.notStarted.body"],
      });
      expect(copy.hint, "French, not the English fallback").not.toBe(en["device.scan.notStarted.body"]);
    } finally {
      locale.value = "en";
    }
  });

  // Task 6 review I2: Waiting re-renders this page every POLL_MS. Inside a
  // DictProvider, every one of those refreshes re-sent the whole merged `ui`
  // dictionary (~385 KB raw) to say three sentences. The server hands Waiting
  // its few strings instead, and mounts no provider around it.
  it("a French viewer's Waiting carries its own French strings, with NO dictionary provider (review I2)", async () => {
    locale.value = "fr";
    try {
      const { auth } = await seedOrg("pro");
      const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
      const fixtures = await fixturesOf(stage.id);
      const final = fixtures.find((f) => f.round_no === 2)!;
      const board = await boardNames(stage.id, fr);
      const { secret } = await ensureDeviceLink(auth, final.id);
      const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
      const waiting = find(tree, ScanWaiting);
      expect(waiting, "precondition: Waiting").not.toBeNull();
      expect(find(tree, DictProvider), "no dictionary rides on every Waiting refresh").toBeNull();
      // The provider was also what told a screen reader the page is French. A
      // phone that scans a sheet rarely has the locale cookie the root
      // layout's fallback reads, so the page says it, authoritatively.
      const lang = find(tree, HtmlLang);
      expect(lang, "the page still names its language").not.toBeNull();
      expect((lang!.props as { lang?: string }).lang).toBe("fr");
      const { home, away, matchRef, copy } = waiting!.props as WaitingProps;
      expect(copy).toEqual({
        lead: fr["device.scan.waitingFor"],
        vs: fr["schedule.vs"],
        hint: fr["device.scan.waitingHint"],
      });
      expect(copy.lead, "French, not the English fallback").not.toBe(en["device.scan.waitingFor"]);
      expect([home, away].sort()).toEqual(
        fixtures.filter((f) => f.round_no === 1).map((s) => board.winnerOf(s.id)).sort(),
      );
      expect(matchRef).toBe(board.ref(final.id));
    } finally {
      locale.value = "en";
    }
  });

  // Review 2026-09-25: a phone scanned early sits on a waiting screen that
  // re-renders the page every POLL_MS, all morning. Each of those renders used
  // to pay for the pad's cfg, fold state, ledger, rosters and lineups, only to
  // print two names. The screen is picked from the fixture row first, and both
  // waiting screens return before any of it. The positive pair first, so a
  // spy that recorded nothing could not pass the negatives.
  it("the waiting screens load nothing only the pad needs; the pad loads all of it", async () => {
    const padLoaders = { loadFixturePadCfg, getFixtureState, listEvents, getLineup, getEntrant };
    const callsNow = () =>
      Object.fromEntries(Object.entries(padLoaders).map(([name, fn]) => [name, vi.mocked(fn).mock.calls.length]));
    const clear = () => Object.values(padLoaders).forEach((fn) => vi.mocked(fn).mockClear());
    const none = Object.fromEntries(Object.keys(padLoaders).map((name) => [name, 0]));

    // The pad (Confirm): every loader runs, both sides' roster and lineup.
    const started = await seedScorableFixture();
    const padToken = (await ensureDeviceLink(started.auth, started.fixtureId)).secret;
    clear();
    const padTree = await ScorePadPage({ params: Promise.resolve({ token: padToken }) });
    expect(find(padTree, DeviceScorePad), "precondition: the pad").not.toBeNull();
    expect(callsNow(), "the pad pays for its own loads").toEqual({
      loadFixturePadCfg: 1,
      getFixtureState: 1,
      listEvents: 1,
      getLineup: 2,
      getEntrant: 2,
    });

    // "Not started yet": both sides seated, so a pad-first page would load both.
    const early = await seedScorableFixture({ start: false });
    const earlyToken = (await ensureDeviceLink(early.auth, early.fixtureId)).secret;
    clear();
    const earlyTree = await ScorePadPage({ params: Promise.resolve({ token: earlyToken }) });
    const notStarted = find(earlyTree, ScanWaiting);
    expect((notStarted?.props as WaitingProps | undefined)?.waitingOn, "precondition: Not started yet").toBe(
      "division_start",
    );
    expect(callsNow(), "Not started yet loads none of the pad").toEqual(none);

    // Waiting with ONE side seated, so a pad-first page would load that side.
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const fixtures = await fixturesOf(stage.id);
    const sf1 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    const final = fixtures.find((f) => f.round_no === 2)!;
    await decide(await deviceFor(auth, sf1.id), sf1.id);
    const waitToken = (await ensureDeviceLink(auth, final.id)).secret;
    clear();
    const waitTree = await ScorePadPage({ params: Promise.resolve({ token: waitToken }) });
    const waiting = find(waitTree, ScanWaiting);
    expect((waiting?.props as WaitingProps | undefined)?.waitingOn, "precondition: Waiting on its sides").toBe(
      "sides",
    );
    const { home, away } = waiting!.props as WaitingProps;
    expect(
      [home, away].filter((s) => ["A", "B", "C", "D"].includes(s)),
      "…still naming its seated side, from the fixture row",
    ).toHaveLength(1);
    expect(callsNow(), "Waiting loads none of the pad").toEqual(none);
  });

  it("one side filled, the other still TBD → still Waiting, the known side by name", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const fixtures = await fixturesOf(stage.id);
    const sf1 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    const sf2 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 2)!;
    const final = fixtures.find((f) => f.round_no === 2)!;
    await decide(await deviceFor(auth, sf1.id), sf1.id);
    const board = await boardNames(stage.id, en);
    // Who the decide actually seated, read back — never assumed from the draw.
    const [seated] = await sql<{ home_entrant_id: string | null; away_entrant_id: string | null; home_name: string | null }[]>`
      select f.home_entrant_id, f.away_entrant_id, e.display_name as home_name
      from fixtures f left join entrants e on e.id = f.home_entrant_id
      where f.id = ${final.id}`;
    expect(seated!.home_entrant_id, "precondition: SF1's winner took the final's HOME seat").not.toBeNull();
    expect(seated!.away_entrant_id, "precondition: the AWAY seat is still TBD").toBeNull();
    const { secret } = await ensureDeviceLink(auth, final.id);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    const waiting = find(tree, ScanWaiting);
    expect(waiting, "one TBD side still waits").not.toBeNull();
    const { home, away } = waiting!.props as WaitingProps;
    // Each seat in ITS place: a swapped pair of names is exactly what a scorer
    // would notice, and a sorted or filtered comparison cannot.
    expect(home, "home is the entrant seated at home, by name").toBe(seated!.home_name);
    expect(away, "away is still its feeder, by the board's code").toBe(board.winnerOf(sf2.id));
  });

  it("carried forward → the pad renders View-only from its first paint", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const sf1 = (await fixturesOf(stage.id)).find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    const device = await deviceFor(auth, sf1.id);
    await decide(device, sf1.id);
    const { secret } = await ensureDeviceLink(auth, sf1.id);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    expect((find(tree, DeviceScorePad)!.props as { initialViewOnly: string | null }).initialViewOnly).toBe(
      "carried_forward",
    );
  });

  it("finalized → View-only 'finalized', even though nothing is carried", async () => {
    const { auth, fixtureId } = await seedScorableFixture();
    const link = await ensureDeviceLink(auth, fixtureId);
    await sql`update fixtures set status = 'finalized' where id = ${fixtureId}`;
    const tree = await ScorePadPage({ params: Promise.resolve({ token: link.secret }) });
    expect((find(tree, DeviceScorePad)!.props as { initialViewOnly: string | null }).initialViewOnly).toBe(
      "finalized",
    );
  });

  it("scheduled, both sides → the pad with no View-only, a match ref and an org-clock time", async () => {
    const { auth, fixtureId } = await seedScorableFixture();
    const [{ stage_id: leagueStage }] = await sql<{ stage_id: string }[]>`select stage_id from fixtures where id = ${fixtureId}`;
    await sql`update fixtures set scheduled_at = '2026-09-23T10:30:00Z' where id = ${fixtureId}`;
    // The ORG's zone, not UTC (final review M1, owner ruling: the org time zone
    // only, as the printed sheet): an org in Auckland moves 10:30Z to 22:30 on
    // the card. A division's own override may not move it — the M1 case below.
    await sql`update organizations set timezone = 'Pacific/Auckland' where id = ${auth.orgId}`;
    const { secret } = await ensureDeviceLink(auth, fixtureId);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    const p = find(tree, DeviceScorePad)!.props as {
      initialViewOnly: string | null;
      fixture: { match_ref: string | null; scheduled_label: string | null };
    };
    expect(p.initialViewOnly).toBeNull();
    // A league: the board codes no round, so it prints "R1·n" — and so does this.
    const leagueBoard = await boardNames(leagueStage!, en);
    expect(p.fixture.match_ref).toBe(leagueBoard.ref(fixtureId));
    expect(p.fixture.match_ref).toMatch(/^R1·\d+$/);
    // …and its scorebug keeps the round number, as the board does.
    expect(leagueBoard.label(fixtureId), "precondition: the board codes no league round").toBeUndefined();
    expect((p.fixture as { round_label?: string }).round_label).toBe(leagueBoard.roundN(fixtureId));
    expect(p.fixture.scheduled_label).toContain("22:30");
  });

  it("Confirm names a knockout match by the board's round code, never 'R1·1' (owner ruling 2026-09-24)", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const sf1 = (await fixturesOf(stage.id)).find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    const { secret } = await ensureDeviceLink(auth, sf1.id);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    const ref = (find(tree, DeviceScorePad)!.props as { fixture: { match_ref: string } }).fixture.match_ref;
    expect(ref).toBe((await boardNames(stage.id, en)).ref(sf1.id));
    expect(ref, "the differential: a semi is coded").not.toMatch(/^R\d/);
  });

  // Owner ruling (naming, #851/#854): the scorebug's round is the board's
  // round label, never "Round N" where the board names the round. Expected
  // values from the board's own `boardRoundCodes` labels, in each language.
  it("the scorebug names the round the way the board does — Final, Semi-finals — in the viewer's language", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const fixtures = await fixturesOf(stage.id);
    const sf1 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    const final = fixtures.find((f) => f.round_no === 2)!;
    // The final needs both sides to reach the pad: decide both semis.
    for (const s of fixtures.filter((f) => f.round_no === 1)) await decide(auth, s.id);
    const roundLabelOf = async (fixtureId: string) => {
      const tree = await ScorePadPage({ params: Promise.resolve({ token: (await ensureDeviceLink(auth, fixtureId)).secret }) });
      const pad = find(tree, DeviceScorePad);
      expect(pad, "precondition: the pad (Confirm or View-only) renders").not.toBeNull();
      return (pad!.props as PadFixture).fixture.round_label;
    };
    const enBoard = await boardNames(stage.id, en);
    for (const f of [sf1, final]) {
      expect(enBoard.label(f.id), "precondition: the board labels every knockout round").toBeDefined();
      const label = await roundLabelOf(f.id);
      expect(label).toBe(enBoard.label(f.id));
      expect(label, "the differential: never the round number the board does not print").not.toBe(enBoard.roundN(f.id));
    }
    locale.value = "fr";
    try {
      const frBoard = await boardNames(stage.id, fr);
      const frLabel = await roundLabelOf(final.id);
      expect(frLabel).toBe(frBoard.label(final.id));
      expect(frLabel, "French, not the English label").not.toBe(enBoard.label(final.id));
    } finally {
      locale.value = "en";
    }
  });

  // The page playoff is where the board's number is not the row's: the
  // Eliminator is the SECOND match of round 1 but the only Eliminator — "E·1"
  // on the board, where its seq_in_round would print "E·2". And Qualifier 2
  // waits on two different feeders by two different codes.
  it("a page playoff: Confirm prints the board's number, and Q2 waits on its feeders by their codes (owner ruling 2026-09-24)", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "page_playoff", ["A", "B", "C", "D"]);
    const fixtures = await fixturesOf(stage.id);
    const lookup = lookupFor(en);
    const board = await boardNames(stage.id, en);
    const elim = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 2)!;
    const q1 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    expect(elim.home_entrant_id, "precondition: the Eliminator is seated").not.toBeNull();

    const elimTree = await ScorePadPage({ params: Promise.resolve({ token: (await ensureDeviceLink(auth, elim.id)).secret }) });
    const elimRef = (find(elimTree, DeviceScorePad)!.props as { fixture: { match_ref: string } }).fixture.match_ref;
    expect(elimRef).toBe(board.ref(elim.id));
    expect(elimRef, "the differential: the board's number, not the row's").not.toBe(
      composeMatchRef(elim.round_no, elim.seq_in_round, lookup, board.code(elim.id)),
    );

    const q2 = fixtures.find((f) => f.round_no === 2)!;
    const waiting = find(
      await ScorePadPage({ params: Promise.resolve({ token: (await ensureDeviceLink(auth, q2.id)).secret }) }),
      ScanWaiting,
    );
    expect(waiting, "precondition: Q2 waits").not.toBeNull();
    const { home, away, matchRef } = waiting!.props as WaitingProps;
    expect(matchRef).toBe(board.ref(q2.id));
    const seats = [home, away];
    expect(seats, "Qualifier 2 waits on the Eliminator's winner, by the board's code").toContain(board.winnerOf(elim.id));
    expect(seats, "and on Qualifier 1's loser").toContain(lookup("slot.loser_match", { ext: board.ref(q1.id) }));
  });

  // Task 6 review round 2 (item 3): a seat fed from ANOTHER stage.
  // `wireCrossFeeds` (usecases/stages.ts) writes only the source row's link,
  // so the seat's name comes from the feed edge, and the board builds its feed
  // map from the whole division's rows. Waiting used to pass no feed map at
  // all, so it fell through to the seat's stored label while the board card
  // said "Winner of …". Real producer end to end: real stages, the real setup
  // generator, the real `wireCrossFeeds`; the only hand-set value is the
  // league's `cross_feeds` config (what the format gates would write), exactly
  // as division-fixtures-feed-edges.test.ts drives it.
  // Two source kinds: a league (uncoded — the feeder prints "R1·1") and a
  // knockout (coded in ITS OWN stage — "Loser of SF·1", which only a lookup
  // that codes the other stage's rows can produce). The knockout feeds its
  // semi's LOSER: the winner already has its own final to go to, and
  // `wireCrossFeeds` never overwrites a link.
  it.each([
    ["league", { legs: 1 }, "winner"],
    ["knockout", {}, "loser"],
  ] as const)("a seat fed from ANOTHER stage (%s) waits on the feeder the board names, not its stored label (review round 2)", async (sourceKind, sourceConfig, side) => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Cross " + Math.random().toString(36).slice(2, 8),
      visibility: "private",
      branding: {},
    });
    const div = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(
      auth,
      div.id,
      ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
    );
    const stages = await createStages(auth, div.id, [
      { seq: 1, kind: sourceKind, name: "Source", config: sourceConfig },
      {
        seq: 2,
        kind: "knockout",
        name: "Cup",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]);
    const league = stages.find((s) => s.seq === 1)!;
    const cup = stages.find((s) => s.seq === 2)!;
    await generateStageFixtures(auth, cup.id);
    await generateStageFixtures(auth, league.id);
    const [source] = await sql<{ id: string; ext_key: string }[]>`
      select id, ext_key from fixtures where stage_id = ${league.id} order by round_no, seq_in_round limit 1`;
    const [target] = await sql<{ id: string; ext_key: string }[]>`
      select id, ext_key from fixtures where stage_id = ${cup.id} order by round_no, seq_in_round limit 1`;
    await sql`
      update stages set config = config || ${sql.json({
        cross_feeds: [{ from_ext_key: source!.ext_key, side, to_stage_seq: 2, to_ext_key: target!.ext_key, slot: 2 }],
      } as never)}
      where id = ${league.id}`;
    // The second generate is the one that finds both ends and wires the edge
    // (`wireCrossFeeds` is re-entrant: "wired once both stages generated").
    await generateStageFixtures(auth, league.id);
    // Started, so the TBD seat is what the scan waits on: an unstarted
    // division opens on "Not started yet" instead (owner fix 2026-09-24).
    await startDivision(auth, div.id);

    // The board's own path, over the board's own selects (schedule/page.tsx's
    // feed rows, the board projection's code columns), for the whole division.
    const lookup = lookupFor(en);
    const feedRows = await sql<FeedRow[]>`
      select id, stage_id, round_no, seq_in_round, winner_to_fixture, winner_to_slot, loser_to_fixture, loser_to_slot
      from fixtures where division_id = ${div.id}`;
    const rows = await sql<(RoundCodeFixture & SeatLabelFixture & BoardFixture)[]>`
      select * from fixtures where division_id = ${div.id}`;
    const stageKinds = await sql<{ id: string; kind: string }[]>`select id, kind from stages where division_id = ${div.id}`;
    const feeds = withRoundCodeRefs(rows, feedLabels(feedRows), boardRoundCodes(rows, stageKinds, lookup));
    const row = rows.find((r) => r.id === target!.id)!;
    expect(row.away_entrant_id, "precondition: the cross-fed seat is empty").toBeNull();
    expect(feeds[row.id]?.away?.params.stage, "precondition: the board sees a CROSS-stage edge").toBe(league.id);
    const boardAway = resolveSlotLabel(feeds[row.id]!.away!, lookup, "schedule.tbd");
    const storedAway = resolveSlotLabel(row.away_slot_label ?? null, lookup, "schedule.tbd");
    expect(boardAway, "precondition: the feed and the stored label read differently").not.toBe(storedAway);

    const waiting = find(
      await ScorePadPage({ params: Promise.resolve({ token: (await ensureDeviceLink(auth, target!.id)).secret }) }),
      ScanWaiting,
    );
    expect(waiting, "precondition: the cross-fed match waits").not.toBeNull();
    const { home, away, waitingOn } = waiting!.props as WaitingProps;
    expect(waitingOn, "precondition: on its TBD seat, not on the division's start").toBe("sides");
    expect(away, "the seat names the feeder in the other stage, as the board card does").toBe(boardAway);
    expect(`${home} vs ${away}`, "…and the whole title is the board card's").toBe(cardTitle(row, {}, feeds, lookup));
  });

  it("a SCHEDULED semi whose final was hand-seated → Confirm, not View-only (the page's own status gate, A15)", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const sf2 = (await fixturesOf(stage.id)).find((f) => f.round_no === 1 && f.seq_in_round === 2)!;
    const column = sf2.winner_to_slot === 1 ? sql`home_entrant_id` : sql`away_entrant_id`;
    await sql`update fixtures set ${column} = (select home_entrant_id from fixtures where id = ${sf2.id}) where id = ${sf2.winner_to_fixture}`;
    const { secret } = await ensureDeviceLink(auth, sf2.id);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    expect((find(tree, DeviceScorePad)!.props as { initialViewOnly: string | null }).initialViewOnly).toBeNull();
  });

  it("a revoked link → localised dead screen, not the resolver's English", async () => {
    const { auth, fixtureId } = await seedScorableFixture();
    const link = await ensureDeviceLink(auth, fixtureId);
    await sql`update device_links set revoked_at = now() where id = ${link.row.id}`;
    const tree = await ScorePadPage({ params: Promise.resolve({ token: link.secret }) });
    const text = JSON.stringify(tree);
    expect(text).toContain("This scoring link was revoked.");
    expect(text).not.toContain("ask the organiser");
  });

  it("the dead screen speaks the viewer's language — French in, French out", async () => {
    const { auth, fixtureId } = await seedScorableFixture();
    const link = await ensureDeviceLink(auth, fixtureId);
    await sql`update device_links set revoked_at = now() where id = ${link.row.id}`;
    locale.value = "fr";
    try {
      const text = JSON.stringify(await ScorePadPage({ params: Promise.resolve({ token: link.secret }) }));
      expect(text).toContain(fr["device.dead.revoked"]);
      expect(text).toContain(fr["device.askFreshLink"]);
      expect(text).not.toContain("This scoring link was revoked.");
    } finally {
      locale.value = "en";
    }
  });

  it("an unknown token → the 'not valid' screen", async () => {
    const text = JSON.stringify(await ScorePadPage({ params: Promise.resolve({ token: "dl_nope" }) }));
    expect(text).toContain("This scoring link is not valid.");
  });

  // Found by the scan walkthrough (Task 6): the page's CLIENT screens — the
  // Confirm card, View-only, Waiting, the pad itself — read their copy through
  // `useMsg`, which outside a <DictProvider> falls back to English. The page
  // mounted none, so a French phone got French server lines around English
  // screens. The viewer's dictionary must reach both client islands.
  it("a French viewer's pad gets the French dictionary (Waiting gets its strings instead — see review I2)", async () => {
    locale.value = "fr";
    try {
      const { auth, fixtureId } = await seedScorableFixture();
      const { secret } = await ensureDeviceLink(auth, fixtureId);
      const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
      const provider = find(tree, DictProvider);
      expect(provider, "the pad's screens need the viewer's dictionary").not.toBeNull();
      const { dict, locale: given, children } = provider!.props as {
        dict: Record<string, string>;
        locale: string;
        children: ReactNode;
      };
      expect(given).toBe("fr");
      expect(dict["device.scan.confirmTitle"]).toBe(fr["device.scan.confirmTitle"]);
      expect(dict["device.scan.viewOnly.cancelled"]).toBe(fr["device.scan.viewOnly.cancelled"]);
      expect(find(children, DeviceScorePad), "the pad renders INSIDE the provider").not.toBeNull();
    } finally {
      locale.value = "en";
    }
  });

  it("an English viewer gets no provider: the English catalog already ships in the bundle", async () => {
    const { auth, fixtureId } = await seedScorableFixture();
    const { secret } = await ensureDeviceLink(auth, fixtureId);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    expect(find(tree, DeviceScorePad), "precondition: the pad renders").not.toBeNull();
    expect(find(tree, DictProvider), "no second copy of ui.json in every English scan's payload").toBeNull();
  });
});

// Final review I1: the scorer holds a PRINTED card and checks the phone against
// it, so every scan screen must name a side exactly as that card does. The card
// is the real builder's output (`buildScorerSheet`), and the phone opens the
// token printed on it: the real producer and the real consumer, no fixture on
// either end. The entrants' stored snapshot names deliberately DIFFER from
// their one rostered person, which is the name the card prints.
describe.skipIf(!HAS_DB)("the scan agrees with its printed card: names (final review I1), time (M1)", () => {
  const DAY = "2026-09-23";
  const PRINTED = "2026-09-23T06:00:00.000Z";
  const ORIGIN = "http://localhost:3000";
  const PERSON: Record<string, string> = {
    "Stored A": "Asha Rao",
    "Stored B": "Bala Iyer",
    "Stored C": "Chen Wu",
    "Stored D": "Dev Nair",
  };
  const rostered = { members: (n: string) => [PERSON[n]!] };
  const schedule = (ids: string[]) =>
    sql`update fixtures set scheduled_at = ${`${DAY}T09:00:00Z`}::timestamptz where id = any(${ids})`;
  const cardFor = async (auth: Awaited<ReturnType<typeof seedOrg>>["auth"], competitionId: string, fixtureId: string) => {
    const sheet = await buildScorerSheet(auth, competitionId, DAY, ORIGIN, "en", { printedAt: PRINTED });
    const card = sheet.pages.flatMap((p) => p.rows).find((r) => r.fixtureId === fixtureId);
    expect(card, "precondition: the fixture is on the day's sheet").toBeDefined();
    return { ...card!, token: card!.url.split("/score/")[1]! };
  };

  it("Confirm and the pad header name each side exactly as its card prints it", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["Stored A", "Stored B"], {}, rostered);
    const [fixture] = await fixturesOf(stage.id);
    await schedule([fixture!.id]);
    const card = await cardFor(auth, competition.id, fixture!.id);
    expect([card.home, card.away].sort(), "precondition: the card prints each rostered person, not the snapshot").toEqual([
      "Asha Rao",
      "Bala Iyer",
    ]);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: card.token }) });
    const pad = find(tree, DeviceScorePad);
    expect(pad, "precondition: both sides seated, so the pad (Confirm)").not.toBeNull();
    const { home, away } = pad!.props as { home: PadSideInfo; away: PadSideInfo };
    // device-score-pad.tsx renders Confirm and the pad header through
    // `entrantDisplayName` over exactly these props.
    expect([entrantDisplayName(home), entrantDisplayName(away)], "each seat, in its place").toEqual([card.home, card.away]);
  });

  it("Waiting names its seated side exactly as the card prints it", async () => {
    const { auth } = await seedOrg("pro");
    const names = ["Stored A", "Stored B", "Stored C", "Stored D"];
    const { competition, stage } = await seedStage(auth, "knockout", names, {}, rostered);
    const fixtures = await fixturesOf(stage.id);
    const sf1 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    const final = fixtures.find((f) => f.round_no === 2)!;
    await decide(await deviceFor(auth, sf1.id), sf1.id);
    await schedule([final.id]);
    const card = await cardFor(auth, competition.id, final.id);
    expect([card.homeTbd, card.awayTbd], "precondition: SF1's winner seated at HOME, AWAY still TBD").toEqual([
      false,
      true,
    ]);
    expect(Object.values(PERSON), "precondition: the card prints the seated person").toContain(card.home);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: card.token }) });
    const waiting = find(tree, ScanWaiting);
    expect(waiting, "precondition: one TBD side still waits").not.toBeNull();
    const { home, away } = waiting!.props as WaitingProps;
    expect([home, away], "each seat, in its place").toEqual([card.home, card.away]);
  });

  // Fix batch 2, item 3: a pair's order is the fixture's SAVED LINEUP
  // (`pair_order`, the doubles serve order the pad and Confirm read), not its
  // roster order. A lineup that reverses the roster is the one case where the
  // two disagree: the card said "Ana / Ben" while Confirm said "Ben / Ana".
  // One fixture through all three screens: the final, with SF1's winner
  // seated, is Waiting; SF2 decided, it is Confirm. A lineup is PER FIXTURE:
  // the pair's reversed lineup is saved on SF1 first, so the final (no lineup
  // of its own yet) must still print and wait in roster order; then the
  // final gets its own reversed lineup.
  it("a pair whose saved lineup reverses its roster: the card, Waiting and Confirm all name it in LINEUP order", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "knockout", ["P1", "P2", "P3", "P4"], {}, {
      entrantKind: "pair",
      members: (n) => [`${n} Ana`, `${n} Ben`],
    });
    const fixtures = await fixturesOf(stage.id);
    const sf1 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    const sf2 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 2)!;
    // `decide` scores HOME 2–1, so SF1's home pair is the one the final seats.
    const seatedId = sf1.home_entrant_id!;
    const roster = await sql<{ person_id: string; full_name: string }[]>`
      select p.id as person_id, p.full_name from entrant_members em join persons p on p.id = em.person_id
      where em.entrant_id = ${seatedId} order by p.full_name`;
    const [ana, ben] = roster;
    expect([ana!.full_name, ben!.full_name], "precondition: the roster puts Ana first").toEqual([
      expect.stringMatching(/ Ana$/),
      expect.stringMatching(/ Ben$/),
    ]);
    const slot = (personId: string, pairOrder: number) => ({
      person_id: personId,
      slot: "starting" as const,
      position_key: null,
      order_no: pairOrder,
      roles: [],
      role: "player" as const,
      pair_order: pairOrder,
    });
    const reversed = { slots: [slot(ben!.person_id, 1), slot(ana!.person_id, 2)] };
    const rosterOrder = [ana!.full_name, ben!.full_name];
    const lineupOrder = [ben!.full_name, ana!.full_name];
    await putLineup(auth, sf1.id, seatedId, reversed);
    await decide(await deviceFor(auth, sf1.id), sf1.id);
    const [final] = (await fixturesOf(stage.id)).filter((f) => f.round_no === 2);
    expect(final!.home_entrant_id, "precondition: SF1's winner is seated at the final's HOME").toBe(seatedId);
    await schedule([final!.id]);

    // SF1's lineup is not the final's: nothing saved for the final yet.
    const before = await cardFor(auth, competition.id, final!.id);
    expect(before.home, "no lineup on THIS fixture: roster order").toBe(rosterOrder.join(" / "));
    const waitingBefore = find(await ScorePadPage({ params: Promise.resolve({ token: before.token }) }), ScanWaiting);
    expect(waitingBefore, "precondition: AWAY still TBD, so Waiting").not.toBeNull();
    expect((waitingBefore!.props as WaitingProps).home, "Waiting == the card, roster order").toBe(before.home);

    await putLineup(auth, final!.id, seatedId, reversed);
    const card = await cardFor(auth, competition.id, final!.id);
    expect(card.token, "precondition: the same printed link").toBe(before.token);
    expect(card.homeTbd, "precondition: HOME is seated on the card").toBe(false);
    expect(card.home, "the card names the pair in lineup order").toBe(lineupOrder.join(" / "));
    expect(card.homePair, "and prints its two lines in that order").toEqual(lineupOrder);

    const waitingTree = await ScorePadPage({ params: Promise.resolve({ token: card.token }) });
    const waiting = find(waitingTree, ScanWaiting);
    expect(waiting, "precondition: AWAY still TBD, so Waiting").not.toBeNull();
    expect((waiting!.props as WaitingProps).home, "Waiting == the card").toBe(card.home);

    await decide(await deviceFor(auth, sf2.id), sf2.id);
    const padTree = await ScorePadPage({ params: Promise.resolve({ token: card.token }) });
    const pad = find(padTree, DeviceScorePad);
    expect(pad, "precondition: both sides seated, so the pad (Confirm)").not.toBeNull();
    const { home } = pad!.props as { home: PadSideInfo };
    expect(entrantDisplayName(home), "Confirm == the card").toBe(card.home);
  });

  // Final review M1 (owner ruling: the ORG time zone only). The card prints the
  // match's time on the org clock; the scan printed it in the division's own
  // `schedule_settings.tz`, so a division whose zone differs from its org's put
  // two different times in the scorer's hands. The zones here split by a
  // non-whole hour (+5:30 against −7), so no coincidence can pass.
  it("the scan prints the match's time on the ORG clock, as its card does (review M1)", async () => {
    const ORG_TZ = "Asia/Kolkata";
    const DIVISION_TZ = "America/Los_Angeles";
    const { auth } = await seedOrg("pro");
    const { competition, division, stage } = await seedStage(auth, "league", ["Stored A", "Stored B"], {}, rostered);
    await sql`update organizations set timezone = ${ORG_TZ} where id = ${auth.orgId}`;
    await sql`insert into schedule_settings (division_id, tz, config) values (${division.id}, ${DIVISION_TZ}, '{}'::jsonb)`;
    const [fixture] = await fixturesOf(stage.id);
    await schedule([fixture!.id]);
    const card = await cardFor(auth, competition.id, fixture!.id);
    const clock = (timeZone: string) =>
      new Intl.DateTimeFormat(intlLocaleFor("en"), { timeZone, hour: "2-digit", minute: "2-digit" }).format(
        new Date(`${DAY}T09:00:00Z`),
      );
    expect(card.time, "precondition: the card is on the org clock").toBe(clock(ORG_TZ));
    expect(clock(DIVISION_TZ), "precondition: the two clocks disagree").not.toBe(clock(ORG_TZ));
    const tree = await ScorePadPage({ params: Promise.resolve({ token: card.token }) });
    const pad = find(tree, DeviceScorePad);
    expect(pad, "precondition: the pad (Confirm)").not.toBeNull();
    const label = (pad!.props as { fixture: { scheduled_label: string | null } }).fixture.scheduled_label;
    expect(label, "the card's time").toContain(card.time);
    expect(label, "never the division's own zone").not.toContain(clock(DIVISION_TZ));
  });
});
