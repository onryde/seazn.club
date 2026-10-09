// Fix round 1, M7 — `loadMatchCentre` names a side still waiting on a match by
// that match's round (`publicRoundNamer`, N1), which costs a read of the
// stage's rows and a load of the public dictionary. A fixture whose two
// entrants are both set has no side to name — and that is every live and
// finished match, the fixtures the poll endpoint serves most — so it must pay
// for neither. A fixture with ANY side still waiting must keep its names.
//
// Driven through the real `loadMatchCentre` over a real generated knockout; the
// only instrumentation is a recording wrapper around the real `sql` (every
// tagged-template query text it is handed) and a counting passthrough around
// the real `getDictionary`. The ctx is built here because the one production
// builder (`loadFixtureMatchCentreCtx`, `usecases/public.ts`) is private.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

const dictionaryLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const getDictionary = ((...args: Parameters<typeof actual.getDictionary>) => {
    dictionaryLoads.count += 1;
    return actual.getDictionary(...args);
  }) as typeof actual.getDictionary;
  return { ...actual, getDictionary };
});

// W2a Task 6 — a passthrough spy on the real resolver, for the bracket-overlay case at the end of this file.
vi.mock("@/server/engine-db/fixture-cfg", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db/fixture-cfg")>();
  return { ...real, resolveFixtureCfg: vi.fn(real.resolveFixtureCfg) };
});

import { sql } from "@/lib/db";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { insertLegacyEvents, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel } from "@/lib/slot-label";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import type { PublicFixture } from "../data";
import { loadMatchCentre, type MatchCentreLoadCtx } from "../match-centre-load";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** A public, English, generated knockout over `names` (seeded in order), with
 *  its stage's rows as `public_fixtures_v` serves them and the ctx the
 *  production builder would hand `loadMatchCentre` for them. */
async function seedKnockout(names: string[]) {
  const { auth } = await seedOrg("pro");
  await sql`update organizations set default_locale = 'en' where id = ${auth.orgId}`;
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "M7 Feeder Read Cup",
    visibility: "public", // public_fixtures_v filters on this
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    names.map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "Knockout", config: {} });
  await generateStageFixtures(auth, stage!.id);

  const [div] = await sql<{ sport_key: string; module_version: string }[]>`
    select sport_key, module_version from divisions where id = ${division.id}`;
  // The same columns `getPublicFixture` reads for the page's own call.
  const fixtures = await sql<PublicFixture[]>`
    select id, division_id, stage_id, pool_id, round_no, seq_in_round,
           home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
           scheduled_at, venue, court_label,
           status, outcome, summary, last_seq,
           lane, is_final, third_place, conditional, stream_url
    from public_fixtures_v where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  const ctx: MatchCentreLoadCtx = {
    orgTz: null,
    division: {
      sportKey: div!.sport_key,
      moduleVersion: div!.module_version,
      formatLabel: "score",
      tz: null,
      youth: false,
      playerNameDisplay: null,
    },
    locale: "en",
    hrefs: { division: "/d", competition: "/c", calendar: null },
    stage: { name: "Knockout", roundLabel: null },
    slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars),
  };
  return { fixtures, ctx };
}

/** The real `sql`, recording the text of every tagged-template query it runs. */
function recordingSql() {
  const texts: string[] = [];
  const traced = new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      const head = args[0];
      if (Array.isArray(head) && "raw" in head) texts.push(head.join("$").replace(/\s+/g, " "));
      return Reflect.apply(target, thisArg, args);
    },
  });
  return { traced, texts };
}

/** The stage-rows read the feeder names come from — nothing else in the loader
 *  reads `public_fixtures_v` by stage (the positive case below proves it runs). */
const isStageRead = (text: string) => /from public_fixtures_v v\b.*\bwhere v\.stage_id = \$/.test(text);

const names = (doc: { header: { sides: { name: string }[] } }) => doc.header.sides.map((s) => s.name);

describe.skipIf(!HAS_DB)("loadMatchCentre reads the stage only for a side still waiting (fix round 1, M7)", () => {
  it("a fixture whose two entrants are set reads neither the stage's rows nor the public dictionary; the final waiting on it still does, and names its feeders", async () => {
    const { fixtures, ctx } = await seedKnockout(["A", "B", "C", "D"]);
    const semis = fixtures.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    const final = fixtures.find((f) => f.home_entrant_id === null && f.away_entrant_id === null);
    // The premise, from the served rows: two filled semi-finals and a final waiting on both.
    expect(semis, JSON.stringify(fixtures)).toHaveLength(2);
    expect(final, JSON.stringify(fixtures)).toBeDefined();

    const filled = recordingSql();
    dictionaryLoads.count = 0;
    const semiDoc = await loadMatchCentre(filled.traced, semis[0]!, ctx);
    // The recorder saw the loader's queries at all (the event ledger), so the
    // absence below is not an empty recording.
    expect(filled.texts.some((text) => /from score_events where fixture_id/.test(text)), filled.texts.join("\n")).toBe(true);
    expect(filled.texts.filter(isStageRead), filled.texts.join("\n")).toEqual([]);
    expect(dictionaryLoads.count).toBe(0);
    // And the document is whole: both sides are the entrants, by name.
    expect(semiDoc.header.sides.map((s) => s.entrantId)).toEqual([semis[0]!.home_entrant_id, semis[0]!.away_entrant_id]);
    expect(names(semiDoc).every((name) => ["A", "B", "C", "D"].includes(name)), names(semiDoc).join(" | ")).toBe(true);

    // The positive pair: a fixture waiting on both sides still reads the stage
    // and the dictionary, once each, and names each side by its feeder's round.
    const waiting = recordingSql();
    dictionaryLoads.count = 0;
    const finalDoc = await loadMatchCentre(waiting.traced, final!, ctx);
    expect(waiting.texts.filter(isStageRead), waiting.texts.join("\n")).toHaveLength(1);
    expect(dictionaryLoads.count).toBe(1);
    expect([...names(finalDoc)].sort()).toEqual(["Winner of Semi-finals, match\u00a01", "Winner of Semi-finals, match\u00a02"]);
  });

  it("a fixture with ONE entrant set and one side still waiting names the waiting side by its feeder's round, not the board's R·code", async () => {
    // Three entrants in a four-draw: the top seed's semi-final is a bye, which
    // advances it into the final at once, so the final holds one entrant and
    // waits on the other semi-final.
    const { fixtures, ctx } = await seedKnockout(["A", "B", "C"]);
    const half = fixtures.find((f) => (f.home_entrant_id === null) !== (f.away_entrant_id === null) && f.round_no > 1);
    expect(half, JSON.stringify(fixtures)).toBeDefined();
    const waitingSide = half!.home_entrant_id === null ? 0 : 1;
    const label = (waitingSide === 0 ? half!.home_slot_label : half!.away_slot_label) as SlotLabel | null;
    expect(label?.key, JSON.stringify(half)).toBe("slot.winner_match");

    const recorded = recordingSql();
    const doc = await loadMatchCentre(recorded.traced, half!, ctx);

    expect(recorded.texts.filter(isStageRead), recorded.texts.join("\n")).toHaveLength(1);
    const waitingName = names(doc)[waitingSide]!;
    expect(waitingName).toMatch(/^Winner of Semi-finals(, match\u00a0\d+)?$/);
    expect(waitingName).not.toBe(resolveSlotLabel(label, ctx.slotLabelLookup, "schedule.tbd"));
    // The set side is its entrant.
    expect(["A", "B", "C"]).toContain(names(doc)[1 - waitingSide]);
  });
});

describe.skipIf(!HAS_DB)("bracket overlay reaches every resolveFixtureCfg caller (spec §5.4.1, W2a Task 6)", () => {
  it("match-centre-load.ts loadMatchCentre", async () => {
    // A boardgame knockout fixture with pre-V347 history (no snapshot), so the public read resolves LIVE cfg — the
    // one shape in which this site's overlay is observable.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
    await insertLegacyEvents(s.fixtureIds[0]!, [{ type: "core.start", payload: {} }]);
    const [fixture] = await sql<PublicFixture[]>`
      select id, division_id, stage_id, pool_id, round_no, seq_in_round,
             home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
             scheduled_at, venue, court_label,
             status, outcome, summary, last_seq,
             lane, is_final, third_place, conditional, stream_url
      from public_fixtures_v where id = ${s.fixtureIds[0]!}`;
    expect(fixture, "the public view serves the seeded fixture").toBeDefined();
    const [div] = await sql<{ module_version: string }[]>`select module_version from divisions where id = ${s.divisionId}`;
    const ctx: MatchCentreLoadCtx = {
      orgTz: null,
      division: { sportKey: "boardgame", moduleVersion: div!.module_version, formatLabel: "classical", tz: null, youth: false, playerNameDisplay: null },
      locale: "en",
      hrefs: { division: "/d", competition: "/c", calendar: null },
      stage: { name: "Knockout", roundLabel: null },
      slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars),
    };
    const spy = vi.mocked(resolveFixtureCfg);
    spy.mockClear();
    await loadMatchCentre(sql, fixture!, ctx);
    const calls = spy.mock.calls.map((c, i) => ({
      kind: (c[2] as { kind?: string } | null | undefined)?.kind ?? null,
      out: spy.mock.results[i]!.value as Record<string, unknown> | null,
    }));
    expect(calls.length, "the entry never called resolveFixtureCfg").toBeGreaterThan(0);
    expect(calls.some((c) => c.kind === "knockout" && c.out?.tiebreak === true), JSON.stringify(calls)).toBe(true);
  });
});
