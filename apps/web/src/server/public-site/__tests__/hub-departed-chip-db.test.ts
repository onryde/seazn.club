// W5 app PR A, Task 20 (X-SF-1 <- RB5-T10; ST-G20): the competition hub's table marks a leaver - driven through the REAL producer and
// the REAL consumer. The producer is the organiser's own door (`withdrawEntrantCascade`, the in-match disqualification's status write,
// Reinstate through `patchEntrant`); the consumer is `loadCompetitionHub` (the document the hub page serves) parsed by the wire schema
// and painted by `StandingsTableView`. A fixture on both ends would prove the fixture: this file never writes a `statuses` map by hand.
//
// Sequence (TEST-STRATEGY: a state transition, its reverse, its second call, the empty case): nobody left -> no chip anywhere; withdraw
// -> exactly her row wears `withdrawn`; the same withdrawal again changes nothing; Reinstate -> the chip is gone; disqualify -> exactly
// her row wears `disqualified` and NOT `withdrawn`; Reinstate again -> gone. Expected statuses are the engine's own vocabulary
// (`withdrawn` / `disqualified`) and the words are the en dictionary's owner-visible ones, typed here.
//
// differential: today (b6f93160a8) `buildTableView` takes no status and no hub row ever carries one - every "wears" assertion is red.
//
// Sports: EVERY builtin sport (the registry, not a list typed here) for the league table - the chip is sport-blind by design, and the
// sweep is what says so; badminton alone for the two-pool group (pool tables are sport-blind too, one sport carries the pool shape).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants, patchEntrant } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { StandingsTableView } from "@/components/public-site/standings-table-view";
import { CompetitionHubDoc, type TableViewT } from "../competition-hub-schema";
import { loadCompetitionHub } from "../competition-hub";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Kind = "individual" | "pair" | "team";
const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;
const SPORTS = builtinModules.map((m) => m.key);

interface Rig {
  auth: AuthCtx;
  orgSlug: string;
  compSlug: string;
  ids: string[];
  stageId: string;
}

async function rig(sport: string, n: number, stage: { kind: "league" | "group"; config: Record<string, unknown> }): Promise<Rig> {
  const m = moduleOf(sport);
  const kind = (m.entrantModel?.defaultKind ?? "individual") as Kind;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T20 " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
  const d = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "o-" + randomUUID().slice(0, 6),
    sport_key: sport,
    variant_key: Object.keys(m.variants)[0]!,
    config: {},
  });
  const es = await createEntrants(auth, d.id, Array.from({ length: n }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
  const [made] = await createStages(auth, d.id, { seq: 1, kind: stage.kind, name: "Table", config: stage.config, progression: null });
  await startDivision(auth, d.id);
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  return { auth, orgSlug: orgSlug!, compSlug: comp.slug, ids: es.map((e) => e.id), stageId: made!.id };
}

/** The hub document as the page serves it, parsed by the wire schema (a row key the schema does not know would be dropped here). */
async function tablesOf(r: Rig): Promise<TableViewT[]> {
  const raw = await loadCompetitionHub(r.orgSlug, r.compSlug, new Date(), { uncached: true });
  expect(raw, "the hub document loads").not.toBeNull();
  return CompetitionHubDoc.parse(raw).tables;
}

/** Every departed chip the page PAINTS, by table: `${status}:${entrantId}` for each chip element in the real component's markup. */
function paintedChips(tables: readonly TableViewT[]): string[][] {
  return tables.map((view) => {
    const html = renderToStaticMarkup(createElement(StandingsTableView, { view, dict: en as Dict, testid: "mh" }));
    return [...html.matchAll(/data-testid="mh-(withdrawn|disqualified)-([0-9a-f-]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  });
}
const WORDS = { withdrawn: "Withdrawn", disqualified: "Disqualified" } as const;

describe.runIf(HAS_DB)("X-SF-1: the hub marks the leaver (real producer, real consumer, every sport)", () => {
  it("premise: the registry is not empty (a sweep over nothing is a pass over nothing)", () => {
    expect(SPORTS.length).toBeGreaterThanOrEqual(10);
  });

  for (const sport of SPORTS) {
    it(`X-SF-1 ${sport}: withdraw -> chip; again -> unchanged; Reinstate -> gone; disqualify -> its own chip; Reinstate -> gone`, async () => {
      const r = await rig(sport, 4, { kind: "league", config: { legs: 1 } });
      const her = r.ids[1]!;

      // empty case: nobody has left - no chip on any row, and no row carries a status key
      let tables = await tablesOf(r);
      expect(tables, "premise: the league's one table").toHaveLength(1);
      expect(tables[0]!.rows.map((x) => x.entrantId).sort(), "premise: all four are listed").toEqual([...r.ids].sort());
      expect(tables[0]!.rows.some((x) => x.status !== undefined)).toBe(false);
      expect(paintedChips(tables)).toEqual([[]]);

      // withdraw -> exactly her row wears `withdrawn`
      await withdrawEntrantCascade(r.auth, her);
      tables = await tablesOf(r);
      expect(tables[0]!.rows.filter((x) => x.status !== undefined).map((x) => [x.entrantId, x.status])).toEqual([[her, "withdrawn"]]);
      expect(paintedChips(tables)).toEqual([[`withdrawn:${her}`]]);
      const html = renderToStaticMarkup(createElement(StandingsTableView, { view: tables[0]!, dict: en as Dict, testid: "mh" }));
      expect(html, "the chip's word is the page's").toMatch(new RegExp(`data-testid="mh-withdrawn-${her}"[^>]*>${WORDS.withdrawn}</span>`));

      // a second withdrawal of the same entrant is refused (B3 I-2: a departed entrant entering a door again changes nothing) - the chip stands
      await expect(withdrawEntrantCascade(r.auth, her)).rejects.toThrow(/already withdrawn/);
      expect(paintedChips(await tablesOf(r))).toEqual([[`withdrawn:${her}`]]);

      // Reinstate -> the chip is gone
      await patchEntrant(r.auth, her, { status: "confirmed" });
      tables = await tablesOf(r);
      expect(tables[0]!.rows.some((x) => x.status !== undefined), "after Reinstate no row carries a status").toBe(false);
      expect(paintedChips(tables)).toEqual([[]]);

      // disqualify -> its own chip, never the withdrawn one
      await withdrawEntrantCascade(r.auth, her, { as: "disqualified" });
      tables = await tablesOf(r);
      expect(paintedChips(tables)).toEqual([[`disqualified:${her}`]]);
      expect(tables[0]!.rows.find((x) => x.entrantId === her)!.status).toBe("disqualified");
      const dq = renderToStaticMarkup(createElement(StandingsTableView, { view: tables[0]!, dict: en as Dict, testid: "mh" }));
      expect(dq).toMatch(new RegExp(`data-testid="mh-disqualified-${her}"[^>]*>${WORDS.disqualified}</span>`));

      // and back again
      await patchEntrant(r.auth, her, { status: "confirmed" });
      expect(paintedChips(await tablesOf(r))).toEqual([[]]);
    }, 120_000);
  }

  it("X-SF-1 a two-pool group: the chip sits on her row in HER pool's table only, and the other pool prints none (badminton: pools are sport-blind)", async () => {
    const r = await rig("badminton", 8, { kind: "group", config: { legs: 1, pools: { count: 2 } } });
    const her = r.ids[0]!;
    // A pool's table has no rows until something in it is decided (the late-entry suite's own premise), so one line of each pool is
    // decided first: her pool's line is one of HERS (she wins it), the other pool's is any line. Pools are read from the stored fixtures.
    const lines = await sql<{ id: string; pool_id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, pool_id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} order by round_no, seq_in_round, id`;
    // She plays two of her pool's three lines (and wins them) before she leaves: under RB5-W3 that is past half, so her results STAND and
    // her row stays in the table; an expunge (under half) removes her row's results and, in a pool, her row with them.
    const hers = lines.filter((l) => l.home_entrant_id === her || l.away_entrant_id === her);
    expect(hers, "premise: three lines of hers in a pool of four").toHaveLength(3);
    const otherPool = lines.find((l) => l.pool_id !== hers[0]!.pool_id)!;
    expect(new Set(lines.map((l) => l.pool_id)).size, "premise: the stored fixtures sit in two pools").toBe(2);
    for (const l of hers.slice(0, 2)) await post(r.auth, l.id, "core.forfeit", { by: l.home_entrant_id === her ? l.away_entrant_id : l.home_entrant_id, reason: "walkover" });
    await post(r.auth, otherPool.id, "core.forfeit", { by: otherPool.home_entrant_id, reason: "walkover" });
    const before = await tablesOf(r);
    expect(before, "premise: one table per pool").toHaveLength(2);
    expect(paintedChips(before)).toEqual([[], []]);
    await withdrawEntrantCascade(r.auth, her);
    const tables = await tablesOf(r);
    const holder = tables.findIndex((v) => v.rows.some((x) => x.entrantId === her));
    expect(holder, "premise: she is listed in one pool's table").toBeGreaterThanOrEqual(0);
    const painted = paintedChips(tables);
    expect(painted[holder]).toEqual([`withdrawn:${her}`]);
    expect(painted.filter((_, i) => i !== holder)).toEqual([[]]);
    expect(painted.flat(), "exactly one chip on the whole hub").toHaveLength(1);
  }, 120_000);
});
