// Export every pool (owner-approved 2026-10-28): a group stage's organiser standings export printed ONE pool, with no
// heading. The export read every stored table of the division ordered by stage seq then `updated_at`, and kept the first
// real one — but a result refolds EVERY pool of its stage in one transaction (`recomputeStandings`), so a stage's pools
// tie on `updated_at` and the PDF printed whichever pool the database returned first. Its metric columns were the
// module's first four, hidden ledger metrics included ("Games as White", "Points won"): columns the public table never
// shows, with no dictionary key, so they printed in English in every locale.
//
// Every case drives the REAL producer (`generateStageFixtures`, `scoreEvent`) and the REAL consumers: the organiser export
// (`buildDivisionDocModel`) and the public division read (`getPublicDivision` → `public_standings_v`) with the public
// `StandingsTable` it renders. The expected order and labels come from the stage's STORED pools and the public
// dictionary; the expected metric columns from the public table's own render and its own selection (`tableColumns`) —
// never from the export code. Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

// `unstable_cache` has no incrementalCache outside a Next request: passthrough, so every public read is a fresh one.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocModel } from "@seazn/engine/exports";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import { sql } from "@/lib/db";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages } from "@/server/api-v1/schemas";
import { StandingsTable } from "@/components/public-site/standings-table";
import { tableOrderOf } from "@/server/engine-db/table-rules";
import { getPublicDivision, type StandingsSnapshotRow } from "@/server/public-site/data";
import { METRIC_HEADER_KEYS, tableColumns, tableLayoutFor } from "@/server/public-site/standings-view";
import { startDivision } from "@/server/usecases/schedule";
import { generateStageFixtures } from "@/server/usecases/stages";
import { buildDivisionDocModel } from "@/server/usecases/exports";
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

const DICTS = { en, es, fr, nl } as unknown as Record<"en" | "es" | "fr" | "nl", Dict>;
const EN = DICTS.en;
/** Spec §5.7, verbatim: a level row's rank prints an en dash (U+2013). Typed from the spec, not imported. */
const SPEC_LEVEL_RANK = "–";
const PRINTED_AT = "2026-10-28T09:00:00.000Z";
const GROUPS = "Groups";

/** A pool's public label, as every public surface captions a pool's table (`[divisionSlug]/page.tsx`, the hub, the
 *  console: "<stage> — <pool label>"), the pool label from the public dictionary's `table.poolLabel` and the STORED key. */
const caption = (stageName: string, key: string, dict: Dict = EN) => `${stageName} — ${String(dict["table.poolLabel"]).replace("{key}", key)}`;

interface Scene extends TableScene {
  stageId: string;
  slugs: [string, string, string];
  /** entrant id → its display name (the rig names them E1… in seed order). */
  name: (id: string) => string;
}

/** A division of `sport`, its stages created (not generated), made public (the rig creates it private) so the public
 *  read serves it. */
async function scene(opts: Parameters<typeof tableScene>[0]): Promise<Scene> {
  const s = await tableScene(opts);
  const [row] = await sql<{ org: string; comp: string; div: string; comp_id: string }[]>`
    select o.slug as org, c.slug as comp, d.slug as div, c.id as comp_id
      from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id
     where d.id = ${s.divisionId}`;
  await sql`update competitions set visibility = 'public' where id = ${row!.comp_id}`;
  const names = new Map(s.entrants.map((id, i) => [id, `E${i + 1}`]));
  return { ...s, stageId: s.stageIds[0]!, slugs: [row!.org, row!.comp, row!.div], name: (id) => names.get(id) ?? id };
}

const groupStage = (pools: number) => ({ seq: 1, kind: "group" as const, name: GROUPS, config: { pools: { count: pools } } });

/** The stage's stored pools in the generator's order — it creates the i-th pool as key "A", "B", … (`stages.ts`). */
const poolsOf = (stageId: string) => sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${stageId} order by key`;

/** The first seated fixture of a pool: its home and away entrant. */
async function pairOf(poolId: string): Promise<[string, string]> {
  const [f] = await sql<{ home: string; away: string }[]>`
    select home_entrant_id as home, away_entrant_id as away from fixtures
     where pool_id = ${poolId} and home_entrant_id is not null and away_entrant_id is not null
     order by round_no, seq_in_round limit 1`;
  if (f === undefined) throw new Error(`rig: pool ${poolId} has no seated fixture`);
  return [f.home, f.away];
}

/** Every stored table of a stage — written by the product, read here only. */
const snapshotsOf = (stageId: string) =>
  sql<{ pool_id: string | null; rows: StandingsSnapshotRow[]; updated_at: string }[]>`
    select pool_id, rows, to_json(updated_at) #>> '{}' as updated_at from standings_snapshots where stage_id = ${stageId}`;

const exportOf = (s: Scene): Promise<DocModel> => buildDivisionDocModel(s.auth, s.divisionId, "standings", { printedAt: PRINTED_AT });

/** One printed section: its heading, and each row's `#` and name. */
const printed = (doc: DocModel) =>
  doc.sections.map((sec) => {
    if (sec.table === undefined) throw new Error("premise: every standings section is a table");
    return { heading: sec.heading ?? null, rows: sec.table.rows.map((r) => [r[0], r[1]]) };
  });

/** The public division read's tables for the scene's stage, by pool id. */
async function publicTables(s: Scene) {
  const data = await getPublicDivision(...s.slugs);
  if (data === null) throw new Error("the public read found no division");
  const stage = data.stages.find((st) => st.id === s.stageId);
  if (stage === undefined) throw new Error("the public read has no such stage");
  return { stage, tables: data.standings.filter((x) => x.stage_id === s.stageId) };
}

/** The public table's rows as it ranks them (`standings-table.tsx` sorts by rank): names, in order. */
const publicNames = (s: Scene, rows: readonly StandingsSnapshotRow[]) =>
  [...rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map((r) => s.name(r.entrantId));

// ── Results per sport family (the sequence's "another sport") ────────────────────────────────────────────────────────

interface Family {
  sport: string;
  variant: string;
  /** `x` beats `y`; returns the id of the event whose void un-decides the match. */
  win(auth: AuthCtx, stageId: string, x: string, y: string): Promise<string>;
}
const lastEventOf = async (fixtureId: string) =>
  (await sql<{ id: string }[]>`select id from score_events where fixture_id = ${fixtureId} order by seq desc limit 1`)[0]!.id;

const GENERIC: Family = {
  sport: "generic",
  variant: "score",
  win: async (auth, stageId, x, y) => {
    await genericResult(auth, stageId, x, y, 1, 0);
    return lastEventOf((await between(stageId, x, y)).id);
  },
};
const FAMILIES: readonly Family[] = [
  GENERIC,
  {
    // set-based: a straight-games BWF win
    sport: "badminton",
    variant: "bwf",
    win: async (auth, stageId, x, y) => {
      const f = await between(stageId, x, y);
      await playBadminton(auth, f.id, f.home === x);
      return lastEventOf(f.id);
    },
  },
  {
    // period sport, and the one table that counts decisions apart (IIHF's OTW/OTL): a regulation goal, then to FT
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

/** A generated, started group stage of `pools` pools of 4. */
async function pooled(fam: Family, pools: number, extra: CreateStages = []): Promise<Scene & { pools: { id: string; key: string }[] }> {
  const s = await scene({ sport: fam.sport, variant: fam.variant, entrants: pools * 4, stages: [groupStage(pools), ...(Array.isArray(extra) ? extra : [extra])] as CreateStages });
  for (const id of s.stageIds) await generateStageFixtures(s.auth, id);
  await startDivision(s.auth, s.divisionId);
  const stored = await poolsOf(s.stageId);
  expect(stored.map((p) => p.key), "premise: the generator stored one pool per group, keyed A, B, …").toEqual(["A", "B", "C"].slice(0, pools));
  return { ...s, pools: stored };
}

/** In each pool, its first fixture's AWAY entrant beats its home one (so the winner is never the first-seated row). */
async function onePerPool(fam: Family, s: Scene, pools: readonly { id: string; key: string }[]) {
  const played = new Map<string, { winner: string; loser: string; voidable: string }>();
  for (const p of pools) {
    const [home, away] = await pairOf(p.id);
    played.set(p.id, { winner: away, loser: home, voidable: await fam.win(s.auth, s.stageId, away, home) });
  }
  return played;
}

describe.skipIf(!HAS_DB)("export every pool — a group stage's standings export prints each group, in group order, headed", () => {
  for (const fam of FAMILIES) {
    it(`${fam.sport}: a 2-group stage, one result per group, the two tables tied on updated_at, then B newer and first in the export's own read — two sections, A then B, each headed, each its own rows`, async () => {
      // the brief's three families: generic, a set-based sport (badminton) and ice hockey
      const s = await pooled(fam, 2);
      const played = await onePerPool(fam, s, s.pools);
      const stored = await snapshotsOf(s.stageId);
      expect(stored.map((x) => x.rows.length).sort(), "premise: each group stored its own table of the two who played").toEqual([2, 2]);
      expect(new Set(stored.map((x) => x.updated_at)).size, "premise: one refold writes every pool, so the two tie on updated_at").toBe(1);
      // Review m1: a tie leaves the order to the database — a coin flip, which a lost sort could win. Make every order but
      // the key say B first. The export's own read (its SQL, no sort of its own) returns the stage's tables in some order;
      // the pool it returns first is relabelled B (the two pools swap key and name), and B's updated_at moves past A's. Only
      // the stage's own pool order (`byPoolOrder`: the key) then prints A first.
      const unsorted = async () =>
        (await sql<{ pool_id: string }[]>`
          select ss.pool_id from standings_snapshots ss join stages s on s.id = ss.stage_id
           where s.division_id = ${s.divisionId} order by s.seq desc`).map((x) => x.pool_id);
      const first = (await unsorted())[0]!;
      if (s.pools.find((p) => p.id === first)!.key === "A") {
        const [x, y] = [s.pools[0]!, s.pools[1]!];
        await sql`update pools set key = '_', name = '_' where id = ${x.id}`;
        await sql`update pools set key = 'A', name = 'A' where id = ${y.id}`;
        await sql`update pools set key = 'B', name = 'B' where id = ${x.id}`;
      }
      const pools = await poolsOf(s.stageId);
      const [pa, pb] = [pools[0]!, pools[1]!];
      await sql`update standings_snapshots set updated_at = now() + interval '1 hour' where stage_id = ${s.stageId} and pool_id = ${pb.id}`;
      const byTime = await sql<{ pool_id: string }[]>`select pool_id from standings_snapshots where stage_id = ${s.stageId} order by updated_at desc`;
      expect(byTime.map((x) => x.pool_id), "premise: updated_at says B first").toEqual([pb.id, pa.id]);
      expect(await unsorted(), "premise: the export's own read returns B first").toEqual([pb.id, pa.id]);

      const doc = await exportOf(s);
      // The engine's pool membership comes from resulted fixtures (`entrantsOfPool`), so each group's table is the pair
      // that played: its winner first, then its loser. The public read serves those same rows for each pool.
      const { tables } = await publicTables(s);
      expect(printed(doc), `${fam.sport}: every group, in the stored key order, headed by its public caption`).toEqual(
        pools.map((p) => {
          const { winner, loser } = played.get(p.id)!;
          return { heading: caption(GROUPS, p.key), rows: [[1, s.name(winner)], [2, s.name(loser)]] };
        }),
      );
      for (const p of pools) {
        const pub = tables.find((x) => x.pool_id === p.id);
        expect(pub, `premise: the public read serves group ${p.key}`).toBeDefined();
        const section = doc.sections[pools.indexOf(p)]!;
        expect(section.table!.rows.map((r) => r[1]), `group ${p.key}: the public table's rows, in its order`).toEqual(publicNames(s, pub!.rows));
      }
      // A second call prints the same document.
      expect(await exportOf(s), "a second export is the same model").toEqual(doc);
    });
  }

  it("(a) 3 groups, results recorded C, then A, then B — three sections, A, B, C, each headed, each its own pair", async () => {
    // single-sport: the pool order and headings are the stage's (sport-agnostic); every family runs the 2-group case above
    const s = await pooled(GENERIC, 3);
    const order = [s.pools[2]!, s.pools[0]!, s.pools[1]!];
    const played = await onePerPool(GENERIC, s, order);
    const doc = await exportOf(s);
    expect(printed(doc)).toEqual(
      s.pools.map((p) => ({ heading: caption(GROUPS, p.key), rows: [[1, s.name(played.get(p.id)!.winner)], [2, s.name(played.get(p.id)!.loser)]] })),
    );
  });

  it("(b) a result voided: its group's table is empty — the group still prints, headed, a header row and no rows, as the public page draws it; a level group prints its rows with no place", async () => {
    // single-sport: the void and the level table are the stage's (sport-agnostic); every family runs the 2-group case above
    const s = await pooled(GENERIC, 3);
    const played = await onePerPool(GENERIC, s, s.pools);
    const [a, b, c] = s.pools as [{ id: string; key: string }, { id: string; key: string }, { id: string; key: string }];
    // Void group B's only result: the match is back in play, and B's table holds no row.
    const voided = played.get(b.id)!;
    await post(s.auth, (await between(s.stageId, voided.winner, voided.loser)).id, "core.void", { event_id: voided.voidable });
    const stored = await snapshotsOf(s.stageId);
    expect(stored.find((x) => x.pool_id === b.id)?.rows, "premise: the refold stored group B's table with no row").toEqual([]);
    // The public page draws every stored table of the stage (`[divisionSlug]/page.tsx` maps them all): B's is served.
    const pub = await publicTables(s);
    expect(pub.tables.find((x) => x.pool_id === b.id)?.rows, "premise: the public read serves B's empty table").toEqual([]);

    const doc = await exportOf(s);
    const rowsOf = (p: { id: string }) => [[1, s.name(played.get(p.id)!.winner)], [2, s.name(played.get(p.id)!.loser)]];
    expect(printed(doc), "RULING: an empty group prints its heading and header row, never skipped").toEqual([
      { heading: caption(GROUPS, a.key), rows: rowsOf(a) },
      { heading: caption(GROUPS, b.key), rows: [] },
      { heading: caption(GROUPS, c.key), rows: rowsOf(c) },
    ]);
    expect(doc.sections[1]!.table!.columns.slice(0, 2), "B's header row is printed").toEqual(["#", t(EN, "table.team")]);
    // Review m3: B's header is the public table's over no rows (no metric any row carries) — with D, which a stage that can
    // draw prints from the first round (`fixedResultColumns`: the public table waits for the first draw), before L.
    const emptyPublic = publicHeader(renderPublic(pub.stage, [], s));
    const D = t(EN, "table.abbr.drawn");
    expect(emptyPublic, "premise: the public table shows no D before a draw").not.toContain(D);
    const lost = emptyPublic.indexOf(t(EN, "table.abbr.lost"));
    expect(doc.sections[1]!.table!.columns.slice(2), "B's header: the public table's, D before L").toEqual([...emptyPublic.slice(0, lost), D, ...emptyPublic.slice(lost)]);

    // The level guard. No product path stores a LEVEL table for one pool of a pooled stage today: pool membership comes
    // from resulted fixtures, so an unplayed pool, a voided result and a withdrawal's expunge all store `[]` (measured
    // 2026-10-28). The export must still never place a level row first (X-TB-6, anti-goal 3), so the state is written
    // here: B's four members, level, in seed order, as `rankStandings` marks a table with nothing counted.
    const members = await sql<{ id: string }[]>`
      select e.id from entrants e
       where e.id in (select home_entrant_id from fixtures where pool_id = ${b.id} union select away_entrant_id from fixtures where pool_id = ${b.id})
       order by e.seed`;
    expect(members.length, "premise: group B has four members").toBe(4);
    const level = members.map((m, i) => ({ entrantId: m.id, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank: i + 1, level: true }));
    await sql`update standings_snapshots set rows = ${sql.json(level)} where stage_id = ${s.stageId} and pool_id = ${b.id}`;
    const withLevel = printed(await exportOf(s));
    expect(withLevel[1], "RULING: a level group prints its rows, every place the spec's dash, in the table's order").toEqual({
      heading: caption(GROUPS, b.key),
      rows: members.map((m) => [SPEC_LEVEL_RANK, s.name(m.id)]),
    });
    // The positive pair: the real groups beside it keep their places.
    expect([withLevel[0], withLevel[2]], "A and C still print their places").toEqual([
      { heading: caption(GROUPS, a.key), rows: rowsOf(a) },
      { heading: caption(GROUPS, c.key), rows: rowsOf(c) },
    ]);
    // The public table draws the same: every rank of B's table the dash.
    const html = renderPublic(pub.stage, (await publicTables(s)).tables.find((x) => x.pool_id === b.id)!.rows, s);
    expect(html.match(new RegExp(`<span aria-hidden="true">${SPEC_LEVEL_RANK}</span>`, "g"))?.length, "the public table prints the dash on each of B's rows").toBe(4);
  });

  it("(c) a later knockout stage with no table: the group stage is still the one printed, every group", async () => {
    // single-sport: the stage pick is the division's (sport-agnostic)
    const s = await pooled(GENERIC, 2, {
      seq: 2,
      kind: "knockout",
      name: "Cup",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }], placement: "rank_order", timing: "setup" },
    } as unknown as CreateStages);
    const cup = s.stageIds[1]!;
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${cup}`;
    expect(n, "premise: the knockout's bracket was generated").toBeGreaterThan(0);
    const played = await onePerPool(GENERIC, s, s.pools);
    expect(await snapshotsOf(cup), "premise: the knockout stores no table").toEqual([]);
    expect(printed(await exportOf(s))).toEqual(
      s.pools.map((p) => ({ heading: caption(GROUPS, p.key), rows: [[1, s.name(played.get(p.id)!.winner)], [2, s.name(played.get(p.id)!.loser)]] })),
    );
  });

  it("(d) a league is unchanged: one section, no heading, every entrant ranked", async () => {
    // single-sport: the single-table shape is the stage kind's (sport-agnostic)
    const s = await scene({ entrants: 4 });
    await generateStageFixtures(s.auth, s.stageId);
    await startDivision(s.auth, s.divisionId);
    const [e1, , , e4] = s.entrants as [string, string, string, string];
    await genericResult(s.auth, s.stageId, e4, e1, 1, 0);
    const doc = await exportOf(s);
    const [only] = (await publicTables(s)).tables;
    expect(printed(doc), "one table, no heading, the public table's order").toEqual([
      { heading: null, rows: publicNames(s, only!.rows).map((name, i) => [i + 1, name]) },
    ]);
    expect(doc.sections[0]!.table!.rows[0]![1], "the winner (seed 4) is #1").toBe("E4");
  });
});

/** The public page's render of one table (`[divisionSlug]/page.tsx`): the stage's served rules and order, the sport's
 *  metric specs, the org's dictionary. */
function renderPublic(stage: Awaited<ReturnType<typeof publicTables>>["stage"], rows: readonly StandingsSnapshotRow[], s: Scene, metricSpecs?: unknown) {
  return renderToStaticMarkup(
    createElement(StandingsTable, {
      rows: rows as never,
      metricSpecs: (metricSpecs ?? []) as never,
      cascade: tableOrderOf(stage.table_rules),
      entrantNames: Object.fromEntries(s.entrants.map((id) => [id, s.name(id)])),
      dict: EN,
      rules: stage.table_rules,
      locale: "en",
      tz: "UTC",
    }),
  );
}

/** The letters over a rendered public table's columns, after `#` and Team, in order. */
function publicHeader(html: string): string[] {
  const head = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
  return [...head.matchAll(/<span aria-hidden="true">([^<]*)<\/span>/g)].map((m) => m[1]!);
}

/** A header row's sport-metric columns: after L (the last result column, in every layout) and before Pts. */
function metricSlice(columns: readonly string[], dict: Dict, from = 0): string[] {
  const lost = columns.indexOf(t(dict, "table.abbr.lost"), from);
  const points = columns.indexOf(t(dict, "table.abbr.points"), lost + 1);
  if (lost < 0 || points < 0) throw new Error(`premise: the header has L and Pts (${columns.join(" · ")})`);
  return columns.slice(lost + 1, points);
}

describe.skipIf(!HAS_DB)("export only the metrics the public table shows — every shipped sport, in all four locales", () => {
  it("each sport's exported metric columns are the public table's, in its order, each a dictionary key in en, es, fr and nl (registry sweep, counted)", async () => {
    let checked = 0;
    let differsFromFirstFour = 0;
    let headersChecked = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0];
      if (variant === undefined) throw new Error(`premise: ${m.key} declares a variant`);
      const s = await scene({ sport: m.key, variant, entrants: 2 });
      await generateStageFixtures(s.auth, s.stageId);
      await startDivision(s.auth, s.divisionId);
      // A walkover, the one result every sport takes the same way: its rows carry the sport's whole ledger (every
      // metric key the module declares, measured 2026-10-28), so what the public table shows is decided by the table.
      const [home, away] = s.entrants as [string, string];
      const f = await between(s.stageId, home, away);
      await post(s.auth, f.id, "core.forfeit", { by: f.away, reason: "walkover" });
      expect((await fixtureRow(f.id)).status, `${m.key}: premise: the walkover decided the fixture`).toBe("forfeited");

      const { stage, tables } = await publicTables(s);
      expect(tables, `${m.key}: premise: one public table`).toHaveLength(1);
      const rows = tables[0]!.rows;
      // Oracle 1, what a visitor sees: the public page's own render of this table, its letters between L and Pts.
      const seen = metricSlice(publicHeader(renderPublic(stage, rows, s, m.metrics)), EN);
      // Oracle 2, the public table's own selection (`tableColumns`, which both public tables call): its metric columns.
      const shown = tableColumns(m.metrics, tableOrderOf(stage.table_rules), rows as never, tableLayoutFor(stage.table_rules)).filter((c) => c.kind === "metric");
      const keysOf = (c: { key: string; label: string }) => {
        const keys = Object.hasOwn(METRIC_HEADER_KEYS, c.key) ? METRIC_HEADER_KEYS[c.key]![c.label] : undefined;
        if (keys === undefined) throw new Error(`${m.key}: ${c.key} / ${c.label} has no dictionary key`);
        return keys;
      };
      expect(shown.map((c) => t(EN, keysOf(c).abbr)), `${m.key}: premise: the two oracles agree`).toEqual(seen);
      if (shown.map((c) => c.key).join() !== m.metrics.slice(0, 4).map((x) => x.key).join()) differsFromFirstFour++;

      for (const locale of ["en", "es", "fr", "nl"] as const) {
        await sql`update organizations set default_locale = ${locale} where id = ${s.auth.orgId}`;
        const dict = DICTS[locale];
        const section = (await exportOf(s)).sections;
        expect(section, `${m.key} ${locale}: one table`).toHaveLength(1);
        const exported = metricSlice(section[0]!.table!.columns, dict, 2);
        // Every exported metric header is a dictionary key authored in this locale — never the module's English label.
        for (const c of shown) {
          const { abbr, title } = keysOf(c);
          expect([Object.hasOwn(dict, abbr), Object.hasOwn(dict, title)], `${m.key} ${locale}: ${c.key} is authored`).toEqual([true, true]);
          headersChecked++;
        }
        expect(exported, `${m.key} ${locale}: the export's metric columns are the public table's`).toEqual(shown.map((c) => t(dict, keysOf(c).abbr)));
        if (locale === "en") expect(exported, `${m.key}: and they are what the public page prints`).toEqual(seen);
      }
      checked++;
    }
    expect(checked, "every registered sport was swept").toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
    expect(headersChecked, "metric headers checked across the four locales").toBeGreaterThan(0);
    // The witness: the old rule (the module's first four metrics) prints a different set for at least one sport.
    expect(differsFromFirstFour, "sports where the public selection is not the first four metrics").toBeGreaterThan(0);
  });
});

// ── Export review I2 (2026-10-28): D only where the stage can draw ──────────────────────────────────────────────────
// The export printed D on every table (`fixedResultColumns`, #1057), the public table only once a row holds a draw — so a
// set sport's or an IIHF sheet carried a D column that can never be anything but 0 (RBG §3.4 line 343: "GP · W · OTW ·
// OTL · L"). The export now asks the stage's reachable outcomes (the engine's declaration) and the public table's own
// test (`tableHasDraw`). For every sport and table kind, as played (a walkover: the result every sport takes alike), and
// with a draw booked in the stored table (the state both readers see once one is played), the export's result columns are
// the public table's: D excluded where the stage cannot draw, included once a draw is on the table — and, the fixed shape,
// included from the first round where the stage can draw, where the public table waits for the first one.
type SweepKind = "league" | "group" | "swiss";
const SWEEP_KINDS: readonly SweepKind[] = ["league", "group", "swiss"];

/** A started table stage of `kind` with one walkover per table: a league or Swiss of 2, a group of 2 pools of 2. */
async function walkoverTable(m: (typeof builtinModules)[number], kind: SweepKind): Promise<Scene> {
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`premise: ${m.key} declares a variant`);
  const stages =
    kind === "league" ? undefined : kind === "group" ? groupStage(2) : { seq: 1, kind: "swiss" as const, name: "Swiss", config: { rounds: 1 } };
  const s = await scene({ sport: m.key, variant, entrants: kind === "group" ? 4 : 2, ...(stages === undefined ? {} : { stages: stages as CreateStages }) });
  if (kind === "swiss") {
    await startDivision(s.auth, s.divisionId);
    await generateStageFixtures(s.auth, s.stageId);
  } else {
    await generateStageFixtures(s.auth, s.stageId);
    await startDivision(s.auth, s.divisionId);
  }
  const fixtures = await sql<{ id: string; away: string }[]>`
    select id, away_entrant_id as away from fixtures
     where stage_id = ${s.stageId} and home_entrant_id is not null and away_entrant_id is not null`;
  expect(fixtures.length, `${m.key} ${kind}: premise: one seated fixture per table`).toBe(kind === "group" ? 2 : 1);
  for (const f of fixtures) {
    await post(s.auth, f.id, "core.forfeit", { by: f.away, reason: "walkover" });
    expect((await fixtureRow(f.id)).status, `${m.key} ${kind}: premise: the walkover decided the fixture`).toBe("forfeited");
  }
  return s;
}

/** A header's result columns: from its first (P) through L, the last result column in every layout. */
function resultSlice(columns: readonly string[], from = 0): string[] {
  const lost = columns.indexOf(t(EN, "table.abbr.lost"), from);
  if (lost < 0 || columns[from] !== t(EN, "table.abbr.played")) throw new Error(`premise: the header runs P … L (${columns.join(" · ")})`);
  return columns.slice(from, lost + 1);
}

describe.skipIf(!HAS_DB)("export review I2 — the export prints D exactly as the public table decides, every sport and table kind", () => {
  it("every shipped sport × league, group, Swiss: as played, D only where the stage can draw; with a draw on the table, the public table's columns verbatim (counted)", async () => {
    const D = t(EN, "table.abbr.drawn");
    let checked = 0;
    let dIncluded = 0;
    let dExcluded = 0;
    let fixedShapeAhead = 0;
    for (const m of builtinModules) {
      for (const kind of SWEEP_KINDS) {
        const s = await walkoverTable(m, kind);
        const { stage } = await publicTables(s);
        // The stage's own declaration, as the public read serves it: the outcomes it can reach.
        const canDraw = stage.table_rules?.reachable.includes("draw");
        if (canDraw === undefined) throw new Error(`${m.key} ${kind}: premise: the public read serves the stage's rules`);
        if (m.key === "badminton") expect(canDraw, `${m.key} ${kind}: a set match always has a winner`).toBe(false);
        if (m.key === "football") expect(canDraw, `${m.key} ${kind}: a league-format match can end level`).toBe(true);

        for (const state of ["as played", "a draw on the table"] as const) {
          if (state === "a draw on the table") {
            // Book the walkover pair drawn in the stored table — the state both readers read once a draw is played (or, on a
            // stage that cannot draw, the guard: a sheet never hides a booked draw).
            for (const snap of await snapshotsOf(s.stageId)) {
              const drawn = snap.rows.map((r) => (r.played > 0 ? { ...r, won: 0, drawn: 1, lost: 0 } : r));
              await sql`update standings_snapshots set rows = ${sql.json(drawn as never)} where stage_id = ${s.stageId} and pool_id is not distinct from ${snap.pool_id}`;
            }
          }
          const { tables } = await publicTables(s);
          const doc = await exportOf(s);
          expect(doc.sections, `${m.key} ${kind}: one section per stored table`).toHaveLength(tables.length);
          const pools = await poolsOf(s.stageId);
          for (const [i, section] of doc.sections.entries()) {
            const pub = kind === "group" ? tables.find((x) => x.pool_id === pools[i]!.id)! : tables[0]!;
            const seen = resultSlice(publicHeader(renderPublic(stage, pub.rows, s, m.metrics)));
            const exported = resultSlice(section.table!.columns, 2);
            const label = `${m.key} ${kind} ${state} (table ${i + 1})`;
            if (state === "as played" && canDraw) {
              // The fixed shape: D from the first round, where the public table waits for the first draw.
              expect(seen, `${label}: premise: the public table waits for a draw`).not.toContain(D);
              expect(exported, `${label}: the public table's columns, with D before L`).toEqual([...seen.slice(0, -1), D, seen.at(-1)!]);
              fixedShapeAhead++;
            } else {
              expect(exported, `${label}: the public table's result columns`).toEqual(seen);
            }
            if (exported.includes(D)) dIncluded++;
            else dExcluded++;
            checked++;
          }
        }
      }
    }
    // league + Swiss: one table each; group: two — per sport, per state
    expect(checked, "every sport × kind × state × table").toBe(builtinModules.length * 2 * (1 + 2 + 1));
    expect(checked).toBeGreaterThan(0);
    expect(dIncluded, "tables printing D").toBeGreaterThan(0);
    expect(dExcluded, "tables printing no D (a stage that cannot draw, as played)").toBeGreaterThan(0);
    expect(fixedShapeAhead, "draw-capable tables printing D before their first draw").toBeGreaterThan(0);
  }, 240_000);
});
