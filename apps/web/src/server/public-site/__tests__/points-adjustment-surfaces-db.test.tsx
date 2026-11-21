// W5 app PR B, Task 7 (X-ADJ-4 "the footnote shows on every surface"; R24 pick 15 A): one real adjustment (`adjustPoints`, the route's
// usecase) on a public league, then every surface that prints the table reads it through its OWN chain: the embed (the real page,
// rendered), the hub (`loadCompetitionHub`, uncached), and the division page's chain (`loadPointsAdjustments` → `adjustmentNotesFor`
// → StandingsTable) that the live and org page files run - pinned, with the embed's, below. Then the Undo: every surface loses the line.
// False premise recorded: /present, the export and the share card print no table footnote of any kind (not PR A's either); they are
// routed to the hand-over (task-7-report.md), so the count here is the surfaces that carry the footnote slot.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => undefined) }));

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingsRow } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { adjustmentNotesFor } from "@/lib/points-adjustment-note";
import { StandingsTable } from "@/components/public-site/standings-table";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { loadCompetitionHub } from "../competition-hub";
import { loadPointsAdjustments } from "../points-adjustments";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { completeStage, createStages, generateStageFixtures } from "@/server/usecases/stages";
import { adjustPoints, undoPointsAdjustment } from "@/server/usecases/points-adjustments";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import EmbedWidgetPage from "@/app/embed/divisions/[id]/[widget]/page";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const NAMES = ["Ann", "Ben", "Cat", "Dan"];
const LINE = "Ben: −3 points, fielded an ineligible player,";

/** The page's words, tags dropped: the lead is bold (`<strong>Ben:</strong> −3 points…`). */
const text = (html: string) => html.replace(/<[^>]+>/g, "");

function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  elements((node.props as { children?: unknown }).children, out);
  return out;
}

describe.skipIf(!HAS_DB)("X-ADJ-4 the footnote shows on every surface (real producer, real readers)", () => {
  it("embed, hub and the division page's chain each print the line; after Undo none does", async () => {
    const { auth } = await seedOrg("pro");
    const suffix = randomUUID().slice(0, 8);
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `ADJ ${suffix}`, visibility: "private", branding: {} });
    await sql`update competitions set visibility = 'public' where id = ${comp.id}`;
    const divSlug = `open-${suffix}`;
    const div = await createDivision(auth, comp.id, { name: "Open", slug: divSlug, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    const ents = await createEntrants(auth, div.id, NAMES.map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
    const id = Object.fromEntries(ents.map((e, i) => [NAMES[i]!, e.id]));
    const [stage] = await createStages(auth, div.id, { seq: 1, kind: "league", name: "Table", config: {}, progression: null });
    await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, div.id);
    const [line] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stage!.id} and home_entrant_id is not null order by round_no, seq_in_round limit 1`;
    await scoreEvent(auth, line!.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, line!.id, { expected_seq: 1, type: "generic.result", payload: { p1Score: 3, p2Score: 1 } });
    const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;

    const { adjustment } = await adjustPoints(auth, stage!.id, { entrant_id: id.Ben!, delta: -3, reason: "fielded an ineligible player" });

    const surfaces = async (): Promise<Record<string, boolean>> => {
      const root = await EmbedWidgetPage({ params: Promise.resolve({ id: div.id, widget: "standings" }) });
      const tables = elements(root).filter((el) => el.type === StandingsTable);
      expect(tables, "the embed draws one table").toHaveLength(1);
      const embed = text(renderToStaticMarkup(tables[0]!)).includes(LINE);
      const doc = CompetitionHubDoc.parse(await loadCompetitionHub(orgSlug, comp.slug, new Date(), { uncached: true }));
      const hubTables = doc.tables.filter((t) => t.divisionId === div.id);
      expect(hubTables, "the hub draws one table").toHaveLength(1);
      const hub = (hubTables[0]!.adjustmentNotes ?? []).some((n) => `${n.lead} ${n.body}`.startsWith(LINE));
      const [snap] = await sql<{ rows: StandingsRow[] }[]>`select rows from standings_snapshots where stage_id = ${stage!.id} and pool_id is null`;
      const names = Object.fromEntries(ents.map((e) => [e.id, e.display_name]));
      const notes = adjustmentNotesFor(stage!.id, snap!.rows.map((r) => r.entrantId), await loadPointsAdjustments(div.id), names);
      const page = text(renderToStaticMarkup(
        createElement(StandingsTable, { rows: snap!.rows, metricSpecs: [], cascade: ["points"], entrantNames: names, dict: en as Dict, adjustmentNotes: notes }),
      )).includes(LINE);
      return { embed, hub, page };
    };
    const on = await surfaces();
    expect(on, JSON.stringify(on)).toEqual({ embed: true, hub: true, page: true });
    expect(Object.values(on).filter(Boolean), "surfaces printing the line").toHaveLength(3);

    await undoPointsAdjustment(auth, stage!.id, adjustment.seq);
    const off = await surfaces();
    expect(off).toEqual({ embed: false, hub: false, page: false });
  });

  it("B3 ruling 3: a table carried into the next stage names the adjustment it carries, on the page's chain and the hub", async () => {
    const { auth } = await seedOrg("pro");
    const suffix = randomUUID().slice(0, 8);
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `ADJC ${suffix}`, visibility: "private", branding: {} });
    await sql`update competitions set visibility = 'public' where id = ${comp.id}`;
    const div = await createDivision(auth, comp.id, { name: "Open", slug: `open-${suffix}`, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    const ents = await createEntrants(auth, div.id, NAMES.map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
    const id = Object.fromEntries(ents.map((e, i) => [NAMES[i]!, e.id]));
    const nameOf = Object.fromEntries(ents.map((e) => [e.id, e.display_name]));
    const [first, second] = await createStages(auth, div.id, [
      { seq: 1, kind: "league", name: "Table", config: {} },
      {
        seq: 2,
        kind: "league",
        name: "Super pool",
        config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "on_complete", carry: "points" },
      },
    ] as never);
    await generateStageFixtures(auth, first!.id);
    await startDivision(auth, div.id);
    const lines = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${first!.id} and home_entrant_id is not null and away_entrant_id is not null`;
    for (const l of lines) {
      const home = nameOf[l.home_entrant_id]! < nameOf[l.away_entrant_id]!;
      await scoreEvent(auth, l.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(auth, l.id, { expected_seq: 1, type: "generic.result", payload: home ? { p1Score: 3, p2Score: 1 } : { p1Score: 1, p2Score: 3 } });
    }
    expect(lines, "premise: every line of four").toHaveLength(6);
    await adjustPoints(auth, first!.id, { entrant_id: id.Ben!, delta: -3, reason: "fielded an ineligible player" });
    await completeStage(auth, first!.id);
    const [dest] = await sql<{ config: { carry_deltas?: { entrantId: string; points: number }[] } }[]>`select config from stages where id = ${second!.id}`;
    const carried = dest!.config.carry_deltas ?? [];
    expect(carried.map((d) => d.entrantId).sort(), "premise: all four carried").toEqual(Object.values(id).sort());

    const CARRIED = "Ben: −3 points carried from Table, fielded an ineligible player,";
    const records = await loadPointsAdjustments(div.id);
    const destNotes = adjustmentNotesFor(second!.id, carried.map((d) => d.entrantId), records, nameOf);
    const page = (notes: typeof destNotes) =>
      text(renderToStaticMarkup(createElement(StandingsTable, { rows: [], metricSpecs: [], cascade: ["points"], entrantNames: nameOf, dict: en as Dict, adjustmentNotes: notes })));
    expect(page(destNotes), "the carried table names it").toContain(CARRIED);
    const sourceNotes = adjustmentNotesFor(first!.id, Object.values(id), records, nameOf);
    expect(page(sourceNotes), "the source table keeps its own line").toContain(LINE);
    expect(page(sourceNotes)).not.toContain("carried from");
    // the hub draws a table once it has one: the destination's fixtures generated, its table folds from the carried openings
    await generateStageFixtures(auth, second!.id);
    const doc = CompetitionHubDoc.parse(await loadCompetitionHub((await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`)[0]!.slug, comp.slug, new Date(), { uncached: true }));
    const hub = doc.tables.filter((t) => t.divisionId === div.id).map((t) => (t.adjustmentNotes ?? []).map((n) => `${n.lead} ${n.body}`));
    expect(hub, "the hub draws both tables").toHaveLength(2);
    expect(hub.flat().filter((x) => x.startsWith(CARRIED)), "the hub names it under the carried table").toHaveLength(1);
    expect(hub.flat().filter((x) => x.startsWith(LINE)), "and keeps the source's own line").toHaveLength(1);
    expect(hub.every((notes) => notes.length === 1), "one line per table").toBe(true);
  });

  it("the three page files that print a table (the live page, the org page, the embed) each run that chain", () => {
    const files = [
      "src/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx",
      "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx",
      "src/app/embed/divisions/[id]/[widget]/page.tsx",
    ];
    let wired = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("await loadPointsAdjustments(division.id)");
      expect(src, f).toMatch(/adjustmentNotes=\{adjustmentNotesFor\(stage\.id, \(snap\.rows as StandingsRow\[\]\)\.map\(\(r\) => r\.entrantId\), pointsAdjustments, entrantNames\)\}/);
      wired++;
    }
    expect(wired).toBe(files.length);
  });
});
