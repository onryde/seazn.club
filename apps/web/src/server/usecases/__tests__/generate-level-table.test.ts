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
import { startDivision } from "@/server/usecases/schedule";
import { completeStage, computeSeedProposal, confirmSeedProposal, generateStageFixtures, REAL_TABLE_KINDS, unpairSwissRound } from "@/server/usecases/stages";
import { deleteEntrant } from "@/server/usecases/entrants";
import { createPerson } from "@/server/usecases/persons";
import { buildDivisionDocModel } from "@/server/usecases/exports";
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
    await expect(exportedStandings(s), "a level table is no standings to print (anti-goal 3: no row is marked first)").rejects.toMatchObject({ status: 404 });
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

  it("m1: every stage kind outside the table kinds — the generate stores no table (registry sweep over StageKind, counted)", async () => {
    // The spec's table kinds (§5.7: a bracket has no table; scoring folds no other kind on a result): league, group, swiss.
    const tableKinds = ["league", "group", "swiss"];
    const CONFIG: Record<string, Record<string, unknown>> = { americano: { mode: "americano", courtCount: 1, rounds: 1 }, ladder: { challengeRange: 2 } };
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
      if (kind !== "ladder") expect(out.created, `premise: ${kind} generated fixtures`).toBeGreaterThan(0);
      expect(await snapshotsOf(s.stageId), `${kind}: no table stored`).toEqual([]);
      checked++;
    }
    expect(checked, "every non-table kind StageKind declares").toBe(StageKind.options.length - tableKinds.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("m3: the generate's table kinds are the ones scoring refolds on a result", () => {
    expect([...REAL_TABLE_KINDS].sort()).toEqual([...SCORING_TABLE_KINDS].sort());
  });
});
