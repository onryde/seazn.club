// W5 app PR B Task 1 (X-PO-1 <- RB5-P1; ST-G5, PO-1 close; plan Review Focus 5): a drawn group's pools are listed on every
// public surface BEFORE any result - the division page, the embed's standings widget, the competition hub, the kiosk's /present
// slides and the share card - each pool a LEVEL table (every rank the level dash, no leader).
//
// differential: today (6fbd5a3af2) a pool's members are the entrants of its results (engine stage.ts `entrantsOfPool`), so at
// Start every pool folds empty and the generate's refold skips it: the division page and the embed show "No standings yet", the
// hub has no table, /present no standings slide, and the share card its "Fixtures & standings" fallback line.
//
// Driven through the REAL producer (Start, the fold, the snapshot write) and each surface's REAL read; the expected members are
// the rulebook's seeded snake typed here (doc 05 §1: 6 seeds into 2 pools deal A = 1, 4, 5 and B = 2, 3, 6), never the fold's.
//
// single-sport (badminton): who is listed is the fold's seating, which no sport field reaches; the registry sweep of the fold is
// pooled-membership.test.ts's first DB test.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
const captured: { tree: ReactElement | null } = { tree: null };
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(tree: unknown) {
      captured.tree = tree as ReactElement;
    }
  },
}));
vi.mock("@/server/og/poster-image", () => ({ posterImageDataUrl: vi.fn(async () => null) }));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => undefined) }));

import { randomUUID } from "node:crypto";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isLevelTable, type StandingsRow } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import { sql } from "@/lib/db";
import type { Dict } from "@/lib/i18n-constants";
import { StandingsTable } from "@/components/public-site/standings-table";
import { tableOrderOf } from "@/server/engine-db/table-rules";
import { CompetitionHubDoc } from "@/server/public-site/competition-hub-schema";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import { getPublicDivision } from "@/server/public-site/data";
import { buildPublicDivisionSlides, type Slide } from "@/server/slideshow-data";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages } from "@/server/usecases/stages";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import EmbedWidgetPage from "@/app/embed/divisions/[id]/[widget]/page";
import DivisionOg from "@/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/opengraph-image";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** Spec §5.7, verbatim: a level row's rank prints an en dash (U+2013). Typed from the spec, not imported. */
const SPEC_LEVEL_RANK = "–";
const EN = en as unknown as Dict;
/** doc 05 §1's seeded snake, 6 seeds into 2 pools, by name. */
const POOL_A = ["P1", "P4", "P5"];
const POOL_B = ["P2", "P3", "P6"];

interface Scene {
  divisionId: string;
  stageId: string;
  slugs: [string, string, string];
  name: Map<string, string>;
}

/** Six badminton singles seeded 1..6 in a public competition, one group stage of two pools, Started, nobody played. */
async function startedGroup(): Promise<Scene> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 B T1 pools " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Groups", slug: "groups-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 6 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: 2 } }, progression: null });
  await startDivision(auth, division.id);
  const [row] = await sql<{ org: string; comp: string; vis: string }[]>`
    select o.slug as org, c.slug as comp, c.visibility as vis from competitions c join organizations o on o.id = c.org_id where c.id = ${comp.id}`;
  expect(row!.vis, "premise: the competition is public (a Pro org)").toBe("public");
  const [{ played }] = await sql<{ played: number }[]>`select count(*)::int as played from fixtures where stage_id = ${stage!.id} and outcome is not null`;
  expect(played, "premise: nobody has played").toBe(0);
  return { divisionId: division.id, stageId: stage!.id, slugs: [row!.org, row!.comp, division.slug], name: new Map(made.map((e) => [e.id, e.display_name])) };
}

const sortedNames = (s: Scene, ids: readonly string[]) => ids.map((id) => s.name.get(id) ?? `?${id}`).sort();
const levelDashes = (html: string) => html.match(new RegExp(`<span aria-hidden="true">${SPEC_LEVEL_RANK}</span>`, "g"))?.length ?? 0;

function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

describe.skipIf(!HAS_DB)("X-PO-1 every surface lists a pool before any result", () => {
  it("the division page: two level pool tables, each its snake seats, every rank the level dash, no leader", async () => {
    const s = await startedGroup();
    const data = (await getPublicDivision(...s.slugs))!;
    const tables = data.standings.filter((t) => t.stage_id === s.stageId);
    expect(tables, "two pool tables (not 'No standings yet')").toHaveLength(2);
    expect(tables.map((t) => sortedNames(s, t.rows.map((r) => r.entrantId))).sort(), "each pool lists its snake seats").toEqual([POOL_A, POOL_B]);
    const stage = data.stages.find((x) => x.id === s.stageId)!;
    const m = builtinModules.find((x) => x.key === "badminton")!;
    let checked = 0;
    for (const t of tables) {
      expect(isLevelTable(t.rows as unknown as StandingsRow[]), "level (the engine's own test)").toBe(true);
      const html = renderToStaticMarkup(
        createElement(StandingsTable, {
          rows: t.rows as never,
          metricSpecs: m.metrics as never,
          cascade: tableOrderOf(stage.table_rules),
          entrantNames: Object.fromEntries(s.name),
          dict: EN,
          rules: stage.table_rules,
          locale: "en",
          tz: "UTC",
        }),
      );
      expect(levelDashes(html), "every rank prints the spec's dash").toBe(3);
      expect(html, "no leader row").not.toContain("bg-amber-50");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the embed's standings widget builds one StandingsTable per pool, before any result (Review Focus 5)", async () => {
    const s = await startedGroup();
    const root = await EmbedWidgetPage({ params: Promise.resolve({ id: s.divisionId, widget: "standings" }) });
    const tables = elements(root).filter((el) => el.type === StandingsTable);
    expect(tables, "one table per pool").toHaveLength(2);
    const listed = tables.map((t) => sortedNames(s, (t.props as { rows: { entrantId: string }[] }).rows.map((r) => r.entrantId))).sort();
    expect(listed, "each pool lists its snake seats").toEqual([POOL_A, POOL_B]);
    for (const t of tables) expect(levelDashes(renderToStaticMarkup(t)), "the embed prints the level dash").toBe(3);
  });

  it("the hub lists both pools, every row unranked (level) and no champion", async () => {
    const s = await startedGroup();
    const doc = CompetitionHubDoc.parse(await loadCompetitionHub(s.slugs[0], s.slugs[1], new Date(), { uncached: true }));
    const tables = doc.tables.filter((t) => t.divisionId === s.divisionId);
    expect(tables, "two pool tables").toHaveLength(2);
    expect(tables.map((t) => t.rows.map((r) => r.name).sort()).sort(), "each pool lists its snake seats").toEqual([POOL_A, POOL_B]);
    const rows = tables.flatMap((t) => t.rows);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.rank === null && !r.champion), "level: no place, no champion").toBe(true);
  });

  it("/present: one standings slide per pool, level, each its snake seats", async () => {
    const s = await startedGroup();
    const data = (await getPublicDivision(...s.slugs))!;
    const slides = (await buildPublicDivisionSlides({ ...data, orgLocale: "en" })).filter((x): x is Extract<Slide, { kind: "standings" }> => x.kind === "standings");
    expect(slides, "two standings slides").toHaveLength(2);
    expect(slides.every((x) => x.level), "each slide is level").toBe(true);
    expect(slides.map((x) => x.rows.map((r) => r.name).sort()).sort()).toEqual([POOL_A, POOL_B]);
  });

  it("the share card prints the first pool's table, not its fallback line", async () => {
    const s = await startedGroup();
    captured.tree = null;
    await DivisionOg({ params: Promise.resolve({ orgSlug: s.slugs[0], competitionSlug: s.slugs[1], divisionSlug: s.slugs[2] }) });
    expect(captured.tree, "premise: the card rendered").not.toBeNull();
    const html = renderToStaticMarkup(captured.tree!);
    const fallback = (en as Record<string, string>)["og.standings.empty"]!.replace("{brand}", "seazn.club");
    expect(html, "not the fallback line").not.toContain(fallback);
    // The first table in the read's stage-then-pool order is one pool: its three seats, and none of the other's.
    const pool = [POOL_A, POOL_B].find((p) => html.includes(`>${p[0]}<`)) ?? [];
    expect(pool, "one pool's seats are on the card").toHaveLength(3);
    for (const name of pool) expect(html).toContain(`>${name}<`);
    const other = pool === POOL_A ? POOL_B : POOL_A;
    for (const name of other) expect(html).not.toContain(`>${name}<`);
  });
});
