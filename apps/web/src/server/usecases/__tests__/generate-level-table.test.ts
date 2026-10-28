// W2d PR B concern 2 (owner-approved 2026-10-27): a table stage's table exists from its first generate. Spec §5.7: "An
// empty table (zero counted fixtures) renders every rank as '–' and suppresses leader styling and qualification chips";
// anti-goal 3 (spec:117-118): "no row is shown or marked as first". Before this, a brand-new public division said "No
// standings yet" until a result landed or the organiser opened Standings (the lazy write in `getStandings`) — one state,
// two renderings, chosen by what the organiser clicked.
//
// Every case drives the REAL producer (`generateStageFixtures`, `scoreEvent`) and the REAL consumer (the public division
// read `getPublicDivision` → `public_standings_v`, and the public `StandingsTable` it renders). No snapshot is written by
// hand. The expected rank text is the spec's en dash, typed here from §5.7 — never `LEVEL_RANK`/`rankText`. Real
// Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

// `unstable_cache` has no incrementalCache outside a Next request: passthrough, so every public read is a fresh one.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import { sql, withTenant } from "@/lib/db";
import type { Dict } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages } from "@/server/api-v1/schemas";
import { StandingsTable } from "@/components/public-site/standings-table";
import { tableOrderOf } from "@/server/engine-db/table-rules";
import { getPublicDivision, type StandingsSnapshotRow } from "@/server/public-site/data";
import { assembleDigestStandings } from "@/server/usecases/org-posts";
import { buildDivisionSlides, buildPublicDivisionSlides, type Slide } from "@/server/slideshow-data";
import { startDivision } from "@/server/usecases/schedule";
import { completeStage, computeSeedProposal, confirmSeedProposal, generateStageFixtures, getStandings, REAL_TABLE_KINDS, unpairSwissRound } from "@/server/usecases/stages";
import { deleteEntrant } from "@/server/usecases/entrants";
import { createPerson } from "@/server/usecases/persons";
import { buildDivisionDocModel } from "@/server/usecases/exports";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { undoDivision } from "@/server/usecases/history";
import { TABLE_KINDS as SCORING_TABLE_KINDS } from "@/server/usecases/scoring";
import { StageKind } from "@/server/api-v1/schemas";
import { between, genericResult, tableScene, type TableScene } from "@/server/engine-db/__tests__/helpers/w2d-table-rig";
import { fixtureRow, playBadminton, post } from "@/server/engine-db/__tests__/helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** Spec §5.7, verbatim: a level row's rank prints an en dash (U+2013). Typed from the spec, not imported. */
const SPEC_LEVEL_RANK = "–";
const EN = en as unknown as Dict;

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

interface Scene extends TableScene {
  stageId: string;
  slugs: [string, string, string];
}

/** A division of `sport`, its stages created (not generated), and its competition made public (`tableScene` creates it
 *  private: `createCompetition` writes a public competition over the plan cap as private). */
async function scene(opts: Parameters<typeof tableScene>[0] & { stage?: number }): Promise<Scene> {
  const s = await tableScene(opts);
  const [row] = await sql<{ org: string; comp: string; div: string; comp_id: string }[]>`
    select o.slug as org, c.slug as comp, d.slug as div, c.id as comp_id
      from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id
     where d.id = ${s.divisionId}`;
  await sql`update competitions set visibility = 'public' where id = ${row!.comp_id}`;
  return { ...s, stageId: s.stageIds[opts.stage ?? 0]!, slugs: [row!.org, row!.comp, row!.div] };
}

interface Snapshot {
  pool_id: string | null;
  rows: StandingsSnapshotRow[];
  previous_rows: StandingsSnapshotRow[] | null;
  computed_through_seq: string;
  updated_at: string;
}
/** Every stored snapshot of a stage — written by the product, read here only. */
const snapshotsOf = (stageId: string) =>
  sql<Snapshot[]>`
    select pool_id, rows, previous_rows, computed_through_seq::text, to_json(updated_at) #>> '{}' as updated_at
      from standings_snapshots where stage_id = ${stageId} order by pool_id nulls first`;

/** The public division read's tables for one stage (what the public division page renders, and what decides whether it
 *  shows "No standings yet": `standings.length === 0`). */
async function publicTablesOf(s: Scene): Promise<{ stageKind: string; tables: { pool_id: string | null; rows: StandingsSnapshotRow[] }[]; html: string[] }> {
  const data = await getPublicDivision(...s.slugs);
  if (data === null) throw new Error("the public read found no division");
  const stage = data.stages.find((st) => st.id === s.stageId);
  if (stage === undefined) throw new Error("the public read has no such stage");
  const tables = data.standings.filter((t) => t.stage_id === s.stageId);
  const [sportRow] = await sql<{ sport_key: string }[]>`select sport_key from divisions where id = ${s.divisionId}`;
  const m = mod(sportRow!.sport_key);
  // The page's own render (`[divisionSlug]/page.tsx`): the stage's served rules, its order, the sport's metric specs.
  const html = tables.map((t) =>
    renderToStaticMarkup(
      createElement(StandingsTable, {
        rows: t.rows as never,
        metricSpecs: m.metrics as never,
        cascade: tableOrderOf(stage.table_rules),
        entrantNames: Object.fromEntries(s.entrants.map((id, i) => [id, `E${i + 1}`])),
        dict: EN,
        rules: stage.table_rules,
        locale: "en",
        tz: "UTC",
      }),
    ),
  );
  return { stageKind: stage.kind, tables: tables.map((t) => ({ pool_id: t.pool_id, rows: t.rows })), html };
}

/** The level-table promise, as a visitor sees it: every entrant, every row level, every rank the spec's dash, and no
 *  leader (the leader row's amber band and the gold medal chip, `standings-table.tsx`). */
function expectLevel(read: Awaited<ReturnType<typeof publicTablesOf>>, entrants: readonly string[], label: string) {
  expect(read.tables, `${label}: one public table for the stage (not "No standings yet")`).toHaveLength(1);
  const [t] = read.tables;
  expect([...t!.rows.map((r) => r.entrantId)].sort(), `${label}: every entrant has a row`).toEqual([...entrants].sort());
  expect(t!.rows.every((r) => r.level === true), `${label}: every row level`).toBe(true);
  const html = read.html[0]!;
  const dashes = html.match(new RegExp(`<span aria-hidden="true">${SPEC_LEVEL_RANK}</span>`, "g"))?.length ?? 0;
  expect(dashes, `${label}: every rank prints the spec's dash`).toBe(entrants.length);
  expect(html, `${label}: no leader row`).not.toContain("bg-amber-50");
  expect(html, `${label}: no gold medal`).not.toContain("bg-amber-300");
}

// ── Results per sport family ─────────────────────────────────────────────────────────────────────────────────────────

interface Family {
  sport: string;
  variant: string;
  /** `x` beats `y`; returns the id of the event whose void un-decides the match. */
  win(auth: AuthCtx, stageId: string, x: string, y: string): Promise<string>;
}
const lastEventOf = async (fixtureId: string) =>
  (await sql<{ id: string }[]>`select id from score_events where fixture_id = ${fixtureId} order by seq desc limit 1`)[0]!.id;

const FAMILIES: readonly Family[] = [
  {
    sport: "generic",
    variant: "score",
    win: async (auth, stageId, x, y) => {
      await genericResult(auth, stageId, x, y, 1, 0);
      return lastEventOf((await between(stageId, x, y)).id); // the generic.result itself
    },
  },
  {
    // set-based: a straight-games BWF win; voiding the second game puts the match back in play
    sport: "badminton",
    variant: "bwf",
    win: async (auth, stageId, x, y) => {
      const f = await between(stageId, x, y);
      await playBadminton(auth, f.id, f.home === x);
      return lastEventOf(f.id);
    },
  },
  {
    // period sport: a regulation goal, then the periods to FT; voiding FT puts the match back in the third period
    sport: "icehockey",
    variant: "iihf",
    win: async (auth, stageId, x, y) => {
      const f = await between(stageId, x, y);
      for (const [type, payload] of [
        ["core.start", {}],
        ["icehockey.goal", { by: x }],
        ["icehockey.period.advance", { to: "P2" }],
        ["icehockey.period.advance", { to: "P3" }],
        ["icehockey.period.advance", { to: "FT" }],
      ] as const) {
        await post(auth, f.id, type, payload);
      }
      const r = await fixtureRow(f.id);
      if (r.status !== "decided" || r.outcome?.winner !== x) throw new Error(`rig: ice hockey did not decide for x (${r.status})`);
      return lastEventOf(f.id);
    },
  },
];

describe.skipIf(!HAS_DB)("W2d concern 2 — a table stage's level table exists from its first generate (spec §5.7, anti-goal 3)", () => {
  it("a round-robin league of 4, generated, no result: the public read serves every entrant level, no row first, no leader — and the snapshot is the generate's", async () => {
    // single-sport: generic is the base case; every sport is swept in the next test
    const s = await scene({ entrants: 4 });
    expect(await snapshotsOf(s.stageId), "premise: nothing is stored before the generate").toEqual([]);
    const out = await generateStageFixtures(s.auth, s.stageId);
    expect(out.created, "premise: a round robin of 4 is 6 fixtures").toBe(6);
    // Read BEFORE the start: `startDivision` re-runs the generate, so a read after it could not tell which one wrote.
    const stored = await snapshotsOf(s.stageId);
    expect(stored.map((x) => [x.pool_id, x.rows.length]), "the generate wrote one table (the stage's, pool null)").toEqual([[null, 4]]);
    expect(stored[0]!.previous_rows, "a first snapshot has no history to roll").toBeNull();
    expectLevel(await publicTablesOf(s), s.entrants, "after the generate");
    // The organiser's Start does not change it: the same level table.
    await startDivision(s.auth, s.divisionId);
    expectLevel(await publicTablesOf(s), s.entrants, "after the start");
  });

  it("every sport's league: the generate alone puts a level table of all 3 entrants on the public read (registry sweep, counted)", async () => {
    let checked = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0];
      if (variant === undefined) throw new Error(`premise: ${m.key} declares a variant`);
      const s = await scene({ sport: m.key, variant, entrants: 3 });
      await generateStageFixtures(s.auth, s.stageId);
      expectLevel(await publicTablesOf(s), s.entrants, `${m.key}/${variant}`);
      checked++;
    }
    expect(checked, "every registered sport was swept").toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("(a) generating twice: the second creates nothing, writes nothing — the snapshot is byte-for-byte the first's", async () => {
    // single-sport: the idempotent second press is sport-agnostic (a created count of 0)
    const s = await scene({ entrants: 4 });
    await generateStageFixtures(s.auth, s.stageId);
    const first = await snapshotsOf(s.stageId);
    expect(first, "premise: the first generate stored a table").toHaveLength(1);
    const again = await generateStageFixtures(s.auth, s.stageId);
    expect(again.created, "the second generate creates no fixture").toBe(0);
    expect(await snapshotsOf(s.stageId), "no extra write: same rows, same watermark, same updated_at").toEqual(first);
  });

  for (const fam of FAMILIES) {
    it(`(b, c) ${fam.sport}: generate → level; one result → the table moves (a leader); void it → level again`, async () => {
      // the brief's three families: generic, set-based (badminton) and a period sport (ice hockey)
      const s = await scene({ sport: fam.sport, variant: fam.variant, entrants: 3 });
      await generateStageFixtures(s.auth, s.stageId);
      expectLevel(await publicTablesOf(s), s.entrants, `${fam.sport} after the generate`);
      await startDivision(s.auth, s.divisionId);
      const [x, y] = s.entrants as [string, string, string];
      // The lowest seed beats the top seed: the leader is not the seed order's first row.
      const z = s.entrants[2]!;
      const voidable = await fam.win(s.auth, s.stageId, z, x);
      const moved = await publicTablesOf(s);
      expect(moved.tables, "one table").toHaveLength(1);
      const rows = moved.tables[0]!.rows;
      expect(rows.some((r) => r.level === true), `${fam.sport}: a counted result — nobody is level`).toBe(false);
      const row = (id: string) => rows.find((r) => r.entrantId === id)!;
      expect([row(z).rank, row(z).played, row(z).won], `${fam.sport}: the winner leads, one played, one won`).toEqual([1, 1, 1]);
      expect([row(x).played, row(x).lost], `${fam.sport}: the loser played and lost`).toEqual([1, 1]);
      expect(row(z).points, `${fam.sport}: the winner out-points the loser`).toBeGreaterThan(row(x).points);
      expect(row(y).played, `${fam.sport}: the third has not played`).toBe(0);
      expect(moved.html[0], `${fam.sport}: the leader row is drawn now`).toContain("bg-amber-50");
      expect(moved.html[0], `${fam.sport}: and the gold medal (the pair of expectLevel's "no gold medal")`).toContain("bg-amber-300");
      // (c) void the decisive event: the match is back in play and the table is level again.
      await post(s.auth, (await between(s.stageId, z, x)).id, "core.void", { event_id: voidable });
      expect((await fixtureRow((await between(s.stageId, z, x)).id)).status, `${fam.sport}: premise: the void un-decided it`).not.toBe("decided");
      expectLevel(await publicTablesOf(s), s.entrants, `${fam.sport} after the void`);
    });
  }

  it("a knockout (no table): generate writes no snapshot, and the public read serves the bracket's fixtures and no table", async () => {
    // single-sport: the table predicate is the stage kind's, not the sport's
    const s = await scene({ entrants: 4, stages: { seq: 1, kind: "knockout", name: "Cup", config: {} } });
    const out = await generateStageFixtures(s.auth, s.stageId);
    expect(out.created, "premise: the bracket was generated").toBeGreaterThan(0);
    expect(await snapshotsOf(s.stageId), "a bracket has no table: nothing stored").toEqual([]);
    const read = await publicTablesOf(s);
    expect(read.stageKind).toBe("knockout");
    expect(read.tables, "no table served for a bracket").toEqual([]);
    const data = (await getPublicDivision(...s.slugs))!;
    expect(data.fixtures.filter((f) => f.stage_id === s.stageId).length, "the bracket's fixtures are served").toBe(out.created);
  });

  it("a Swiss mint seats nobody: no table (no empty one) until Pair next seats round 1 — then the level table of all 4", async () => {
    // single-sport: the Swiss shell mint is the stage kind's (sport-agnostic)
    const s = await scene({ entrants: 4, stages: { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } } });
    const mint = await generateStageFixtures(s.auth, s.stageId);
    expect(mint.created, "premise: the first press mints the shells").toBeGreaterThan(0);
    const seated = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${s.stageId} and (home_entrant_id is not null or away_entrant_id is not null)`;
    expect(seated[0]!.n, "premise: the shells seat nobody").toBe(0);
    expect(await snapshotsOf(s.stageId), "an empty fold is no table: nothing stored").toEqual([]);
    expect((await publicTablesOf(s)).tables, "and nothing served").toEqual([]);
    const pair = await generateStageFixtures(s.auth, s.stageId);
    expect(pair.created, "premise: Pair next seated round 1").toBeGreaterThan(0);
    expectLevel(await publicTablesOf(s), s.entrants, "swiss after Pair next");
  });

  it("a group stage: one pool gives a level table of every entrant; two pools write no EMPTY table (the fold's pool membership comes from results)", async () => {
    // single-sport: pools are the stage kind's (sport-agnostic)
    const one = await scene({ entrants: 4, stages: { seq: 1, kind: "group", name: "Group", config: { pools: { count: 1 } } } });
    await generateStageFixtures(one.auth, one.stageId);
    expectLevel(await publicTablesOf(one), one.entrants, "one pool");
    const two = await scene({ entrants: 8, stages: { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } } });
    const out = await generateStageFixtures(two.auth, two.stageId);
    expect(out.created, "premise: both pools were generated").toBe(12);
    const stored = await snapshotsOf(two.stageId);
    expect(stored.filter((x) => x.rows.length === 0), "no empty pool table is stored").toEqual([]);
    // Nothing is served: every pool folds empty before a result (engine `entrantsOfPool` takes pool membership from
    // resulted fixtures) — parked as concern-2 finding 2 (owner follow-up), so "No standings yet" until a pool result.
    expect((await publicTablesOf(two)).tables, "a pooled stage serves no table before a result (finding 2, parked)").toEqual([]);
  });

  it("RULING — a `timing: setup` progression's placeholder fixtures name no entrant, so they produce no table (not a table of placeholders)", async () => {
    // single-sport: the placeholders are the progression's (sport-agnostic)
    const s = await scene({
      entrants: 4,
      stage: 1,
      stages: [
        { seq: 1, kind: "league", name: "League", config: {} },
        {
          seq: 2,
          kind: "league",
          name: "Final Pool",
          config: {},
          progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }], placement: "rank_order", timing: "setup" },
        },
      ] as CreateStages,
    });
    const out = await generateStageFixtures(s.auth, s.stageId);
    expect(out.created, "premise: the placeholder round robin of 3 was generated").toBe(3);
    const named = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${s.stageId} and (home_entrant_id is not null or away_entrant_id is not null)`;
    expect(named[0]!.n, "premise: every placeholder names nobody").toBe(0);
    expect(await snapshotsOf(s.stageId), "no table of placeholders is stored").toEqual([]);
    expect((await publicTablesOf(s)).tables, "nor served").toEqual([]);
    // The positive pair: the SOURCE stage, generated, is a real table — level, all 4.
    const source = { ...s, stageId: s.stageIds[0]! };
    await generateStageFixtures(s.auth, source.stageId);
    expectLevel(await publicTablesOf(source), s.entrants, "the source league");
    expect(await snapshotsOf(s.stageId), "and the placeholder stage still has none").toEqual([]);
  });

  it("the digest after the first result names no climber: a level table has no places to climb from — a second result's climb is named", async () => {
    // single-sport: the climber line is the digest's (sport-agnostic)
    const s = await scene({ entrants: 4 });
    await generateStageFixtures(s.auth, s.stageId);
    await startDivision(s.auth, s.divisionId);
    const [e1, e2, , e4] = s.entrants as [string, string, string, string];
    const digest = () => withTenant(s.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: s.stageId, division_name: "Open" }]));
    // The bottom seed beats the top seed. The level table it replaces ranked E4 4th by seed — not a place.
    await genericResult(s.auth, s.stageId, e4, e1, 1, 0);
    const [snap] = await snapshotsOf(s.stageId);
    expect(snap!.previous_rows?.every((r) => r.level === true), "premise: the first result rolled the generate's level table into history").toBe(true);
    const [first] = await digest();
    expect(first?.top3[0]?.name, "premise: the digest has a section, E4 first").toBe("E4");
    expect(first?.climber, "no climb out of a level table").toBeUndefined();
    // The positive pair: E1 then beats E2 5-0 — out of a ranked table, E1 climbs to first.
    await genericResult(s.auth, s.stageId, e1, e2, 5, 0);
    const [second] = await digest();
    expect(second?.climber?.entrantName, "a climb between two ranked tables is named").toBe("E1");
    expect(second?.climber?.to).toBe(1);
  });
});

// ── Fix round 1 (review concern-2: I1, I2, I3, m1, m3) ───────────────────────────────────────────────────────────────

/** `x` beats `y` for every pair where `x` is the LOWER seed: the finishing order is the reverse of the seed order, so the
 *  real table never coincides with a level one (a level table orders by seed). */
async function reverseSeedRound(s: Scene, stageId: string): Promise<void> {
  for (let i = 0; i < s.entrants.length; i++)
    for (let j = i + 1; j < s.entrants.length; j++) await genericResult(s.auth, stageId, s.entrants[j]!, s.entrants[i]!, 1, 0);
}

/** A league "Phase 1" of 4 and a league "Final Pool" taking its ranks 1-3 with `timing`; the scene's stage is the pool. */
const twoStage = (timing: "setup" | "on_complete") =>
  scene({
    entrants: 4,
    stage: 1,
    stages: [
      { seq: 1, kind: "league", name: "Phase 1", config: {} },
      {
        seq: 2,
        kind: "league",
        name: "Final Pool",
        config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }], placement: "rank_order", timing },
      },
    ] as CreateStages,
  });

/** The organiser standings export's table: `#` and the name of every row (engine `buildStandings`: `#`, Team, …). */
async function exportedStandings(s: Scene): Promise<{ place: unknown; name: unknown; played: unknown }[]> {
  const doc = await buildDivisionDocModel(s.auth, s.divisionId, "standings", { printedAt: "2026-10-27T09:00:00.000Z" });
  const table = doc.sections[0]?.table;
  if (table === undefined) throw new Error("the standings export has no table");
  return table.rows.map((r) => ({ place: r[0], name: r[1], played: r[2] }));
}

describe.skipIf(!HAS_DB)("W2d concern 2 fix round 1 — the stored table follows the roster, the export, and the seeding", () => {
  it("I1: generate, then delete an entrant (division in setup): the public table drops it — no raw id, no deleted entrant, the 3 left level", async () => {
    // single-sport: the roster delete is the division's (sport-agnostic)
    const s = await scene({ entrants: 4 });
    await generateStageFixtures(s.auth, s.stageId);
    const victim = s.entrants[3]!;
    await deleteEntrant(s.auth, victim);
    const left = s.entrants.slice(0, 3);
    const read = await publicTablesOf(s);
    expectLevel(read, left, "after the delete");
    const data = (await getPublicDivision(...s.slugs))!;
    const known = new Set(data.entrants.map((e) => e.id));
    const served = read.tables.flatMap((t) => t.rows.map((r) => r.entrantId));
    expect(served.filter((id) => !known.has(id)), "every served row names an entrant the public read knows (no raw id)").toEqual([]);
    expect(read.html.join(""), "the deleted entrant's id is printed nowhere").not.toContain(victim);
  });

  it("I1 sequence: delete, then start and record a result — the table moves, still without the deleted entrant", async () => {
    // single-sport: the roster delete is the division's (sport-agnostic)
    const s = await scene({ entrants: 4 });
    await generateStageFixtures(s.auth, s.stageId);
    const [e1, , e3, victim] = s.entrants as [string, string, string, string];
    await deleteEntrant(s.auth, victim);
    await startDivision(s.auth, s.divisionId);
    await genericResult(s.auth, s.stageId, e3, e1, 1, 0);
    const read = await publicTablesOf(s);
    expect(read.tables, "one table").toHaveLength(1);
    const rows = read.tables[0]!.rows;
    expect(rows.map((r) => r.entrantId).sort(), "the 3 left, nobody else").toEqual(s.entrants.slice(0, 3).sort());
    expect(rows.find((r) => r.rank === 1)?.entrantId, "the winner leads").toBe(e3);
  });

  it("I1: a seated Swiss round, then an entrant deleted — the round goes back to its shells and its stored table goes with it", async () => {
    // single-sport: the Swiss unseat-on-delete is the stage kind's (sport-agnostic)
    const s = await scene({ entrants: 4, stages: { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } } });
    await generateStageFixtures(s.auth, s.stageId);
    await generateStageFixtures(s.auth, s.stageId);
    expectLevel(await publicTablesOf(s), s.entrants, "premise: Pair next seated round 1");
    await deleteEntrant(s.auth, s.entrants[3]!);
    const seated = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${s.stageId} and (home_entrant_id is not null or away_entrant_id is not null)`;
    expect(seated[0]!.n, "premise: the delete put the round back onto its shells").toBe(0);
    expect(await snapshotsOf(s.stageId), "a fold that seats nobody leaves no stored table (not the stale 4)").toEqual([]);
    expect((await publicTablesOf(s)).tables, "and nothing served — the mint's own state").toEqual([]);
  });

  it("I1: generate, undo, then delete an entrant — the undo's stale level table does not survive the delete", async () => {
    // single-sport: undo and the roster delete are the division's (sport-agnostic)
    const s = await scene({ entrants: 4 });
    await generateStageFixtures(s.auth, s.stageId);
    await undoDivision(s.auth, s.divisionId);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${s.stageId}`;
    expect(n, "premise: the undo took the fixtures back").toBe(0);
    expect((await snapshotsOf(s.stageId)).length, "premise: the undo left the generate's table (finding 1, parked)").toBe(1);
    await deleteEntrant(s.auth, s.entrants[3]!);
    expect(await snapshotsOf(s.stageId), "the delete's refold of a fold with no row drops the stored table").toEqual([]);
  });

  it("m5: Unpair of Swiss round 1 puts the shells back — the stored table goes with it (the mint's state, not a header-only table)", async () => {
    // single-sport: Unpair is the stage kind's (sport-agnostic)
    const s = await scene({ entrants: 4, stages: { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } } });
    await generateStageFixtures(s.auth, s.stageId);
    await generateStageFixtures(s.auth, s.stageId);
    expectLevel(await publicTablesOf(s), s.entrants, "premise: Pair next seated round 1");
    const out = await unpairSwissRound(s.auth, s.stageId);
    expect([out.round, out.cleared > 0], "premise: round 1 was unpaired").toEqual([1, true]);
    expect(await snapshotsOf(s.stageId), "no stored table — not a table of no rows").toEqual([]);
    expect((await publicTablesOf(s)).tables, "and nothing served").toEqual([]);
    // The positive pair: Pair next again seats round 1, and the level table is back.
    await generateStageFixtures(s.auth, s.stageId);
    expectLevel(await publicTablesOf(s), s.entrants, "after Pair next again");
  });

  it("I2: the organiser export marks nobody first on a level table — a fresh league's export is 'no standings yet', a result's is ranked", async () => {
    // single-sport: the export reads the stored table (sport-agnostic)
    const s = await scene({ entrants: 4 });
    await generateStageFixtures(s.auth, s.stageId);
    expect((await snapshotsOf(s.stageId))[0]?.rows.every((r) => r.level === true), "premise: the generate stored a level table").toBe(true);
    await expect(exportedStandings(s), "a level table is no standings to print (anti-goal 3: no row is marked first)").rejects.toMatchObject({ status: 404, code: "STANDINGS_NOT_AVAILABLE" });
    // The positive pair: one counted result, and the export prints places — the winner first, not seed 1.
    await startDivision(s.auth, s.divisionId);
    await genericResult(s.auth, s.stageId, s.entrants[3]!, s.entrants[0]!, 1, 0);
    const rows = await exportedStandings(s);
    expect(rows[0], "the winner (seed 4) is #1").toMatchObject({ place: 1, name: "E4", played: 1 });
    expect(rows.length).toBe(4);
  });

  it("I2: a finished stage's table is not displaced by the next stage's level table in the export", async () => {
    // single-sport: the export's stage pick is the division's (sport-agnostic)
    const s = await twoStage("on_complete");
    const phase1 = s.stageIds[0]!;
    await generateStageFixtures(s.auth, phase1);
    await startDivision(s.auth, s.divisionId);
    await reverseSeedRound(s, phase1);
    await completeStage(s.auth, phase1);
    await generateStageFixtures(s.auth, s.stageId);
    const pool = await snapshotsOf(s.stageId);
    expect(pool.length === 1 && pool[0]!.rows.length === 3 && pool[0]!.rows.every((r) => r.level === true), "premise: the pool's level table of 3 is stored").toBe(true);
    // Phase 1's real order: the lower seed won every match — E4 3 wins, E3 2, E2 1, E1 0.
    expect(await exportedStandings(s), "the export prints Phase 1's final table, not the pool's seed list").toEqual([
      { place: 1, name: "E4", played: 3 },
      { place: 2, name: "E3", played: 3 },
      { place: 3, name: "E2", played: 3 },
      { place: 4, name: "E1", played: 3 },
    ]);
  });

  it("I3: the seeding fills a `timing: setup` table stage — the confirm writes the qualifiers' level table to the public read", async () => {
    // single-sport: the seed proposal is the progression's (sport-agnostic)
    const s = await twoStage("setup");
    const phase1 = s.stageIds[0]!;
    await generateStageFixtures(s.auth, s.stageId);
    await generateStageFixtures(s.auth, phase1);
    await startDivision(s.auth, s.divisionId);
    await reverseSeedRound(s, phase1);
    await completeStage(s.auth, phase1);
    expect(await snapshotsOf(s.stageId), "premise: the placeholders stored no table (the RULING)").toEqual([]);
    const proposal = await computeSeedProposal(s.auth, s.stageId);
    await confirmSeedProposal(s.auth, s.stageId, { proposalId: proposal.id });
    // Phase 1's top three (the lower seed won every match): E4, E3, E2.
    const [, e2, e3, e4] = s.entrants as [string, string, string, string];
    expectLevel(await publicTablesOf(s), [e4, e3, e2], "the seeded pool after the confirm");
  });

  it("n1: an EMPTY stored table is nothing to export either — a minted Swiss whose Standings the organiser opened", async () => {
    // single-sport: the export reads the stored table (sport-agnostic)
    const s = await scene({ entrants: 4, stages: { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } } });
    await generateStageFixtures(s.auth, s.stageId);
    await getStandings(s.auth, s.stageId);
    const stored = await snapshotsOf(s.stageId);
    expect(stored.map((t) => t.rows.length), "premise: the organiser's read stored a table of no rows").toEqual([0]);
    await expect(exportedStandings(s), "a table of no rows is no standings to print").rejects.toMatchObject({ status: 404, code: "STANDINGS_NOT_AVAILABLE" });
  });

  it("n1: a later 2-pool group's empty tables (its Standings opened) do not displace the finished stage's table in the export", async () => {
    // single-sport: the export's stage pick is the division's (sport-agnostic)
    const s = await scene({
      entrants: 8,
      stage: 1,
      stages: [
        { seq: 1, kind: "league", name: "Phase 1", config: {} },
        {
          seq: 2,
          kind: "group",
          name: "Groups",
          config: { pools: { count: 2 } },
          progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 8 }] }], placement: "rank_order", timing: "on_complete" },
        },
      ] as CreateStages,
    });
    const phase1 = s.stageIds[0]!;
    await generateStageFixtures(s.auth, phase1);
    await startDivision(s.auth, s.divisionId);
    await reverseSeedRound(s, phase1);
    await completeStage(s.auth, phase1);
    await generateStageFixtures(s.auth, s.stageId);
    await getStandings(s.auth, s.stageId);
    const pools = await snapshotsOf(s.stageId);
    expect(pools.map((t) => t.rows.length), "premise: the groups' read stored two tables of no rows").toEqual([0, 0]);
    // Phase 1's real order: the lower seed won every match — E8 7 wins down to E1 0.
    expect(await exportedStandings(s), "the export prints Phase 1's final table, not an empty one").toEqual(
      [8, 7, 6, 5, 4, 3, 2, 1].map((n, i) => ({ place: i + 1, name: `E${n}`, played: 7 })),
    );
  });

  it("m1: every stage kind outside the table kinds — the generate stores no table (registry sweep over StageKind, counted)", async () => {
    // The spec's table kinds (§5.7: a bracket has no table; scoring folds no other kind on a result): league, group, swiss.
    const tableKinds = ["league", "group", "swiss"];
    const CONFIG: Record<string, Record<string, unknown>> = { americano: { mode: "americano", courtCount: 1, rounds: 1 }, ladder: { challengeRange: 2 } };
    // Not a witness: a ladder's fixtures come from individual challenges (`issueChallenge`), so its generate creates 0
    // and never reaches the refold gate. Pinned as a premise below, so a ladder that starts generating reds here.
    const WITNESSLESS = new Set(["ladder"]);
    let checked = 0;
    for (const kind of StageKind.options.filter((k) => !tableKinds.includes(k))) {
      const s = await scene({ entrants: 4, stages: { seq: 1, kind, name: kind, config: CONFIG[kind] ?? {} } as CreateStages });
      // americano pairs the PERSONS behind the individual entrants (stages.ts americanoGen): give each one.
      if (kind === "americano")
        for (const [i, id] of s.entrants.entries()) {
          const person = await createPerson(s.auth, { full_name: `P${i + 1}`, consent: {}, dob: null, gender: null, external_ref: null });
          await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${id}, ${person.id}, ${s.auth.orgId})`;
        }
      const out = await generateStageFixtures(s.auth, s.stageId);
      expect(await snapshotsOf(s.stageId), `${kind}: no table stored`).toEqual([]);
      if (WITNESSLESS.has(kind)) {
        expect(out.created, `premise: ${kind}'s generate creates nothing (so it is no witness)`).toBe(0);
        continue;
      }
      expect(out.created, `premise: ${kind} generated fixtures (so the refold gate was reached)`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked, "every non-table kind StageKind declares that generates fixtures").toBe(StageKind.options.length - tableKinds.length - WITNESSLESS.size);
    expect(checked).toBeGreaterThan(0);
  });

  it("m3: the generate's table kinds are the ones scoring refolds on a result", () => {
    expect([...REAL_TABLE_KINDS].sort()).toEqual([...SCORING_TABLE_KINDS].sort());
  });
});

/** The organiser standings export's whole table — its columns and every row's cells (engine `buildStandings`). */
async function exportedTable(s: Scene): Promise<{ columns: string[]; rows: (string | number)[][] }> {
  const doc = await buildDivisionDocModel(s.auth, s.divisionId, "standings", { printedAt: "2026-10-28T09:00:00.000Z" });
  const table = doc.sections[0]?.table;
  if (table === undefined) throw new Error("the standings export has no table");
  return { columns: table.columns, rows: table.rows };
}

/** The export's `#` and `Pts` cells by entrant name, and the public table's place per name (the snapshot's `rank`). */
async function exportedPlacesAndPoints(s: Scene) {
  const { columns, rows } = await exportedTable(s);
  const pts = columns.indexOf("Pts");
  expect([columns[0], pts > 0], "premise: the export's first column is # and it has a Pts column").toEqual(["#", true]);
  const [publicTable] = (await publicTablesOf(s)).tables;
  if (publicTable === undefined) throw new Error("premise: the public read serves the stage's table");
  const nameOf = new Map(s.entrants.map((id, i) => [id, `E${i + 1}`]));
  return {
    points: Object.fromEntries(rows.map((r) => [r[1], r[pts]])),
    places: Object.fromEntries(rows.map((r) => [r[1], r[0]])),
    publicPlaces: Object.fromEntries(publicTable.rows.map((r) => [nameOf.get(r.entrantId), r.rank])),
    rows: rows.length,
  };
}

describe.skipIf(!HAS_DB)("W2d final review I3 — the organiser standings export prints points as the public table does (RB2B-17: every surface)", () => {
  // The expected cells come from FIDE's scoring (Laws of Chess, FIDE Handbook C.04: a win scores 1, a draw ½, a loss 0),
  // never from the code that prints them. Chess stores half-points (2/1/0), so a raw cell prints every score doubled.
  it("chess: a public 1½ exports as 1½ — after a win, then after two draws, every Pts cell in half-points; # is the public place", async () => {
    // single-sport: chess is the one sport whose table counts in half-points (`unit: "half"`); the whole-point case is below.
    const s = await scene({ sport: "boardgame", variant: "classical", entrants: 3 });
    const [e1, e2, e3] = s.entrants as [string, string, string];
    await generateStageFixtures(s.auth, s.stageId);
    await startDivision(s.auth, s.divisionId);
    const game = async (x: string, y: string, winner: string | null) => {
      const f = await between(s.stageId, x, y);
      await post(s.auth, f.id, "core.start");
      await post(s.auth, f.id, "boardgame.result", winner === null ? { winner: null, method: "agreement" } : { winner, method: "resign" });
      if ((await fixtureRow(f.id)).status !== "decided") throw new Error("rig: the game did not decide");
    };
    // E1 beats E2: E1 1, E2 0, E3 0 (not played yet). Stored 2/0/0, so a doubled cell prints "2".
    await game(e1, e2, e1);
    const first = await exportedPlacesAndPoints(s);
    expect(first.points, "after one win").toEqual({ E1: "1", E2: "0", E3: "0" });
    expect(first.places, "# is the public table's place, row for row").toEqual(first.publicPlaces);
    // E1 draws E3 and E2 draws E3: E1 1 + ½ = 1½, E3 ½ + ½ = 1, E2 0 + ½ = ½.
    await game(e1, e3, null);
    await game(e2, e3, null);
    const after = await exportedPlacesAndPoints(s);
    expect(after.points, "after the two draws").toEqual({ E1: "1½", E3: "1", E2: "½" });
    expect(after.places, "# is the public table's place, row for row").toEqual(after.publicPlaces);
    expect(after.places, "E1 first, E3 second, E2 third").toEqual({ E1: 1, E3: 2, E2: 3 });
    // The public page a visitor reads prints the same half-points.
    const html = (await publicTablesOf(s)).html[0]!;
    for (const text of ["1½", "½"]) expect(html, `the public table prints ${text}`).toContain(`>${text}<`);
  });

  it("a whole-point table keeps its stored points as NUMBER cells (generic: the spreadsheet column stays numeric, as before)", async () => {
    // single-sport: the whole-point half of the chess case above; generic is the rig's plain whole-point sport.
    const s = await scene({ entrants: 3 });
    await generateStageFixtures(s.auth, s.stageId);
    await startDivision(s.auth, s.divisionId);
    await genericResult(s.auth, s.stageId, s.entrants[0]!, s.entrants[1]!, 1, 0);
    const [stored] = await snapshotsOf(s.stageId);
    if (stored === undefined) throw new Error("premise: the result stored a table");
    const nameOf = new Map(s.entrants.map((id, i) => [id, `E${i + 1}`]));
    const got = await exportedPlacesAndPoints(s);
    let checked = 0;
    for (const r of stored.rows) {
      expect(got.points[nameOf.get(r.entrantId)!], `${nameOf.get(r.entrantId)}: the stored points, as a number`).toBe(r.points);
      checked++;
    }
    expect(checked, "rows checked").toBe(3);
    expect(got.points.E1, "premise: the winner scored").toBeGreaterThan(0);
    expect(got.places).toEqual(got.publicPlaces);
  });
});

// ── W2d follow-up (final review m3, m8): the export and the kiosk split IIHF's results as the public table does ─────────

/** One ice hockey game under IIHF rules through the real write path, `winner` beating `loser` in regulation (a goal),
 *  in overtime (0-0 at full time, then a goal) or in the shoot-out (0-0 after overtime, then the winner scores every
 *  attempt and the loser misses, home shooting first). Throws unless the fixture decided for `winner` that way. */
async function hockeyGame(s: Scene, winner: string, loser: string, decidedIn: "regulation" | "ot" | "so"): Promise<void> {
  const f = await between(s.stageId, winner, loser);
  await post(s.auth, f.id, "core.start");
  if (decidedIn === "regulation") await post(s.auth, f.id, "icehockey.goal", { by: winner });
  for (const to of ["P2", "P3", "FT"]) await post(s.auth, f.id, "icehockey.period.advance", { to });
  if (decidedIn === "ot") await post(s.auth, f.id, "icehockey.goal", { by: winner });
  if (decidedIn === "so") {
    await post(s.auth, f.id, "icehockey.period.advance", { to: "FT" });
    for (let i = 0; i < 20 && (await fixtureRow(f.id)).status !== "decided"; i++) {
      const by = i % 2 === 0 ? f.home : f.away;
      await post(s.auth, f.id, "icehockey.shootout.attempt", { by, scored: by === winner });
    }
  }
  const METHOD = { regulation: "regulation", ot: "extra_time", so: "shootout" } as const;
  const r = await fixtureRow(f.id);
  expect([r.status, r.outcome], `rig: ${decidedIn} win`).toEqual(["decided", expect.objectContaining({ kind: "win", winner, method: METHOD[decidedIn] })]);
}

/** The organiser board's and the public kiosk's standings slide for the scene's stage. */
async function boardSlides(s: Scene): Promise<{ organiser: StandingsSlide; kiosk: StandingsSlide }> {
  const pick = (slides: Slide[], who: string): StandingsSlide => {
    const slide = slides.find((x): x is StandingsSlide => x.kind === "standings");
    if (slide === undefined) throw new Error(`premise: the ${who} board has a standings slide`);
    return slide;
  };
  const data = await getPublicDivision(...s.slugs);
  if (data === null) throw new Error("premise: the public read serves the division");
  return {
    organiser: pick(await buildDivisionSlides(s.auth, s.divisionId, "Open"), "organiser"),
    kiosk: pick(await buildPublicDivisionSlides({ ...data, orgLocale: "en" }), "public kiosk"),
  };
}
type StandingsSlide = Extract<Slide, { kind: "standings" }>;

/** A slide's result cells by entrant name, keyed by its column keys. */
const slideCells = (slide: StandingsSlide) =>
  Object.fromEntries(slide.rows.map((r) => [r.name, Object.fromEntries(slide.columns.map((c, i) => [c.key, r.results[i]]))]));

describe.skipIf(!HAS_DB)("W2d follow-up (m3, m8) — the organiser export and the kiosk print IIHF's W · OTW · OTL · L (RBG §3.4)", () => {
  it("ice hockey: an OT win, a shoot-out win, an OT loss and a shoot-out loss — W and L are regulation only, OTW/OTL hold the rest, on the export and both boards", async () => {
    // single-sport: IIHF ice hockey is the one table that counts decisions apart (RBG:343-344); every sport's columns are
    // swept in standings-view-w2d.test.ts and the non-IIHF pair is below.
    const s = await scene({ sport: "icehockey", variant: "iihf", entrants: 6 });
    const [e1, e2, e3, e4, e5, e6] = s.entrants as [string, string, string, string, string, string];
    await generateStageFixtures(s.auth, s.stageId);
    await startDivision(s.auth, s.divisionId);
    await hockeyGame(s, e1, e2, "regulation");
    await hockeyGame(s, e1, e3, "ot");
    await hockeyGame(s, e1, e4, "so");
    await hockeyGame(s, e5, e1, "ot");
    await hockeyGame(s, e6, e1, "so");
    await hockeyGame(s, e3, e4, "regulation");
    // RBG §3.4, typed from the rulebook: a regulation win 3, an OT or GWS win 2, an OT or GWS loss 1, a regulation loss
    // 0; "OT and GWS decisions both land in OTW/OTL", so W and L count regulation only. P = W + OTW + OTL + L.
    //            P  W  OTW OTL D  L  Pts
    const WANT: Record<string, [number, number, number, number, number, number, number]> = {
      E1: [5, 1, 2, 2, 0, 0, 9],
      E2: [1, 0, 0, 0, 0, 1, 0],
      E3: [2, 1, 0, 1, 0, 0, 4],
      E4: [2, 0, 0, 1, 0, 1, 1],
      E5: [1, 0, 1, 0, 0, 0, 2],
      E6: [1, 0, 1, 0, 0, 0, 2],
    };
    const { columns, rows } = await exportedTable(s);
    expect(columns.slice(0, 8), "the export's header: #, Team, then the public table's result columns").toEqual(["#", "Team", "P", "W", "OTW", "OTL", "D", "L"]);
    const pts = columns.indexOf("Pts");
    let checked = 0;
    for (const row of rows) {
      const name = String(row[1]);
      expect([...row.slice(2, 8), row[pts]], `${name}'s export row`).toEqual(WANT[name]);
      checked++;
    }
    expect(checked, "every entrant's row").toBe(6);
    // The differential: a W folded with the overtime wins would print E1's 3, an L folded with the shoot-out losses E4's 2.
    expect(rows.find((r) => r[1] === "E1")![3], "E1's W is its one regulation win").toBe(1);
    // The public table prints the same split under the same letters (its own render).
    const html = (await publicTablesOf(s)).html[0]!;
    for (const letters of [en["table.abbr.otw"], en["table.abbr.otl"]]) expect(html, `the public table heads ${letters}`).toContain(`>${letters}<`);

    // The same table on the organiser board and on the public kiosk: the same split, the same points.
    const boards = await boardSlides(s);
    for (const [who, slide] of Object.entries(boards)) {
      expect(slide.columns.map((c) => c.key), `${who}: the result columns`).toEqual(["played", "won", "otw", "otl", "drawn", "lost"]);
      const cells = slideCells(slide);
      let rowsChecked = 0;
      for (const [name, want] of Object.entries(WANT)) {
        const [p, w, otw, otl, d, l, points] = want.map(String);
        expect(cells[name], `${who}: ${name}`).toEqual({ played: p, won: w, otw, otl, drawn: d, lost: l });
        expect(slide.rows.find((r) => r.name === name)!.points, `${who}: ${name}'s points`).toBe(points);
        rowsChecked++;
      }
      expect(rowsChecked, `${who}: rows checked`).toBe(6);
    }
  });

  it("football and badminton (a set sport) keep P · W · D · L on the export and both boards, each cell the stored count", async () => {
    // Two sports outside IIHF, one goal sport with draws and one set sport without: the shape and the counts as before.
    const cases = [
      {
        sport: "football",
        variant: "11-a-side",
        play: async (s: Scene, [a, b, c]: string[]) => {
          for (const [x, y, xGoals] of [[a!, b!, 1], [b!, c!, 0]] as const) {
            const f = await between(s.stageId, x, y);
            await post(s.auth, f.id, "core.start");
            for (let g = 0; g < xGoals; g++) await post(s.auth, f.id, "football.goal", { by: x });
            await post(s.auth, f.id, "football.period", { phase: "HT" });
            await post(s.auth, f.id, "football.period", { phase: "FT" });
            if ((await fixtureRow(f.id)).status !== "decided") throw new Error("rig: the football match did not decide");
          }
        },
        // E1 beat E2; E2 drew E3.
        want: { E1: [1, 1, 0, 0], E2: [2, 0, 1, 1], E3: [1, 0, 1, 0] },
      },
      {
        sport: "badminton",
        variant: "bwf",
        play: async (s: Scene, [a, b, c]: string[]) => {
          for (const [x, y] of [[a!, b!], [c!, a!]] as const) {
            const f = await between(s.stageId, x, y);
            await playBadminton(s.auth, f.id, f.home === x);
          }
        },
        // E1 beat E2; E3 beat E1.
        want: { E1: [2, 1, 0, 1], E2: [1, 0, 0, 1], E3: [1, 1, 0, 0] },
      },
    ];
    let checked = 0;
    for (const c of cases) {
      const s = await scene({ sport: c.sport, variant: c.variant, entrants: 3 });
      await generateStageFixtures(s.auth, s.stageId);
      await startDivision(s.auth, s.divisionId);
      await c.play(s, s.entrants);
      const { columns, rows } = await exportedTable(s);
      expect(columns.slice(0, 6), `${c.sport}: the export's header as it always was`).toEqual(["#", "Team", "P", "W", "D", "L"]);
      expect(columns, `${c.sport}: no split columns`).not.toContain("OTW");
      const [stored] = await snapshotsOf(s.stageId);
      const nameOf = new Map(s.entrants.map((id, i) => [id, `E${i + 1}`]));
      for (const r of stored!.rows) {
        const name = nameOf.get(r.entrantId)!;
        const cells = rows.find((x) => x[1] === name)!.slice(2, 6);
        expect(cells, `${c.sport} ${name}: the played counts`).toEqual(c.want[name as keyof typeof c.want]);
        expect(cells, `${c.sport} ${name}: the stored counts`).toEqual([r.played, r.won, r.drawn, r.lost]);
        checked++;
      }
      for (const [who, slide] of Object.entries(await boardSlides(s))) {
        expect(slide.columns.map((k) => k.key), `${c.sport} ${who}: the result columns`).toEqual(["played", "won", "drawn", "lost"]);
        expect(slide.columns.every((k) => k.compact), `${c.sport} ${who}: nothing folds`).toBe(true);
        for (const [name, want] of Object.entries(c.want)) {
          expect(slide.rows.find((r) => r.name === name)!.results, `${c.sport} ${who} ${name}`).toEqual(want.map(String));
          checked++;
        }
      }
    }
    expect(checked, "rows checked: 3 export + 6 board rows per sport").toBe(18);
  });

  it("review m3: every standings header prints in the org's language, through the public table's own dictionary keys (en, es, fr, nl)", async () => {
    // single-sport: IIHF ice hockey carries every kind of standings column at once (#, Team, the split result columns,
    // keyed metrics, a notation metric, Pts); the header set of every sport is the same lookup (`columnHeader`).
    const s = await scene({ sport: "icehockey", variant: "iihf", entrants: 2 });
    const [e1, e2] = s.entrants as [string, string];
    await generateStageFixtures(s.auth, s.stageId);
    await startDivision(s.auth, s.divisionId);
    await hockeyGame(s, e1, e2, "regulation");
    // The public table's keys, typed here (standings-view.ts STRUCTURAL_ABBR_KEYS / METRIC_HEADER_KEYS, standings-table-view's
    // `table.team`): ice hockey's table ledger is GF, GA, GD and PIM — PIM has no translation, it is the sport's notation
    // and prints as the module labels it in every locale, as on the public table. `#` is a glyph.
    const KEYS = ["table.team", "table.abbr.played", "table.abbr.won", "table.abbr.otw", "table.abbr.otl", "table.abbr.drawn",
      "table.abbr.lost", "table.abbr.gf", "table.abbr.ga", "table.abbr.gd"] as const;
    const headers: Record<string, string[]> = {};
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      await sql`update organizations set default_locale = ${locale} where id = ${s.auth.orgId}`;
      const { columns } = await exportedTable(s);
      const dict = await getDictionary(locale, "public");
      expect(columns, `${locale}: the export's header`).toEqual(["#", ...KEYS.map((k) => t(dict, k)), "PIM", t(dict, "table.abbr.points")]);
      headers[locale] = columns;
    }
    // The positive pair: the words do change with the locale (a lookup that ignored it would pass the four above only
    // if every dictionary spelled them alike).
    expect(headers.es, "es is not the English header").not.toEqual(headers.en);
    expect(headers.en!.slice(0, 2), "en: as it always read").toEqual(["#", "Team"]);
  });
});
