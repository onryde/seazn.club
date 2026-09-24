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
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { createDeviceLink, ensureDeviceLink } from "@/server/usecases/device-links";
import { seedCourts, seedOrg } from "@/server/usecases/__tests__/_seed";
import { decide, deviceFor, fixturesOf, seedStage } from "@/server/usecases/__tests__/_sheets-rig";
import { DeviceScorePad } from "@/components/v2/device-score-pad";
import { ScanWaiting } from "@/components/v2/scan-waiting";
import { DictProvider } from "@/components/i18n/dict-provider";
import { HtmlLang } from "@/components/i18n/html-lang";
import { boardRoundCodes, type RoundCodeFixture } from "@/components/v2/board/round-codes";
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
  };
}

type WaitingProps = {
  home: string;
  away: string;
  matchRef: string;
  meta: string[];
  copy: { waitingFor: string; vs: string; hint: string };
};

// The page resolves the viewer's locale from the request (cookie, user,
// header); there is no request here. Hoisted so one test can switch it.
const locale = vi.hoisted(() => ({ value: "en" as "en" | "fr" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => locale.value }));

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

async function seedScorableFixture(): Promise<{
  auth: Awaited<ReturnType<typeof seedOrg>>["auth"];
  courtId: string;
  fixtureId: string;
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
  return { auth, courtId: courtId!, fixtureId: fixtures[0]!.id };
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
      waitingFor: en["device.scan.waitingFor"],
      vs: en["schedule.vs"],
      hint: en["device.scan.waitingHint"],
    });
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
        waitingFor: fr["device.scan.waitingFor"],
        vs: fr["schedule.vs"],
        hint: fr["device.scan.waitingHint"],
      });
      expect(copy.waitingFor, "French, not the English fallback").not.toBe(en["device.scan.waitingFor"]);
      expect([home, away].sort()).toEqual(
        fixtures.filter((f) => f.round_no === 1).map((s) => board.winnerOf(s.id)).sort(),
      );
      expect(matchRef).toBe(board.ref(final.id));
    } finally {
      locale.value = "en";
    }
  });

  it("one side filled, the other still TBD → still Waiting, the known side by name", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const fixtures = await fixturesOf(stage.id);
    const sf1 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    const final = fixtures.find((f) => f.round_no === 2)!;
    await decide(await deviceFor(auth, sf1.id), sf1.id);
    const { secret } = await ensureDeviceLink(auth, final.id);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    const waiting = find(tree, ScanWaiting);
    expect(waiting, "one TBD side still waits").not.toBeNull();
    const { home, away } = waiting!.props as { home: string; away: string };
    const named = [home, away].filter((s) => !s.startsWith("Winner of"));
    expect(named, "the filled side reads as its entrant, not a slot label").toHaveLength(1);
    expect(["A", "B", "C", "D"]).toContain(named[0]);
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

  it("scheduled, both sides → the pad with no View-only, a match ref and a venue-tz time", async () => {
    const { auth, fixtureId } = await seedScorableFixture();
    const [{ stage_id: leagueStage }] = await sql<{ stage_id: string }[]>`select stage_id from fixtures where id = ${fixtureId}`;
    await sql`update fixtures set scheduled_at = '2026-09-23T10:30:00Z' where id = ${fixtureId}`;
    // The venue's zone, not UTC: a division override to Auckland moves 10:30Z
    // to 22:30 on the card.
    await sql`
      insert into schedule_settings (division_id, org_id, tz)
      select f.division_id, d.org_id, 'Pacific/Auckland'
      from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}
      on conflict (division_id) do update set tz = excluded.tz`;
    const { secret } = await ensureDeviceLink(auth, fixtureId);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    const p = find(tree, DeviceScorePad)!.props as {
      initialViewOnly: string | null;
      fixture: { match_ref: string | null; scheduled_label: string | null };
    };
    expect(p.initialViewOnly).toBeNull();
    // A league: the board codes no round, so it prints "R1·n" — and so does this.
    expect(p.fixture.match_ref).toBe((await boardNames(leagueStage!, en)).ref(fixtureId));
    expect(p.fixture.match_ref).toMatch(/^R1·\d+$/);
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
