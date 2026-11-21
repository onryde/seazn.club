// W5 app PR B Task 6 (X-QS-1, X-QS-2; ST-G17): a finished league keeps its cut, frozen, on EVERY surface that draws a cut - driven
// through the real producer and the real readers, nothing forged:
//   real league, real scores (scoreEvent) to the last line -> the organiser's Complete (`completeStage`; auto-progress is off by
//   default) runs the on_complete progression, which seeds Finals (`seedNextStage` writes its `config.qualified`) -> V538's
//   `stage_qualification_meta` publishes who went through -> each reader:
//     * the division page / org page (getPublicDivision -> divisionQualification -> StandingsTable),
//     * the embed's standings widget (embed-data.ts, its own select of public_stages_v),
//     * the hub document (loadCompetitionHub, `uncached`),
//     * the organiser console's meta (listStageQualificationMeta: `q.*`).
// /present, the share card and the export draw no cut at all (no reader of the meta: false premise of the brief, Task 6 report).
//
// Expected values: the league read by hand (the higher seed wins every match, so Ann and Ben are the top two of four) and
// R24 pick 17 A's words, typed.
//
// single-sport (generic): which entrants went through is sport-blind once the table is final; the frozen builder is swept
// per sport in qualification-view.test.ts.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => undefined) }));

import { randomUUID } from "node:crypto";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "@/lib/db";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";
import { StandingsTable } from "@/components/public-site/standings-table";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { loadCompetitionHub } from "../competition-hub";
import { getPublicDivision } from "../data";
import { divisionQualification, qualificationFixtures } from "../division-qualification";
import { builtinModules } from "@seazn/engine/sports";
import { embedDivisionData } from "@/server/embed-data";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { listStageQualificationMeta } from "@/server/usecases/stage-qualification";
import { completeStage, createStages, generateStageFixtures } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
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
/** R24 pick 17 A. */
const QUALIFIED = "Qualified";

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  finalsId: string;
  slugs: [string, string, string];
  id: Record<string, string>;
}

/** A public generic league of four into Finals (top 2, on_complete), Started. */
async function league(): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `QF ${suffix}`, visibility: "private", branding: {} });
  await sql`update competitions set visibility = 'public' where id = ${comp.id}`;
  const divSlug = `open-${suffix}`;
  const div = await createDivision(auth, comp.id, { name: "Open", slug: divSlug, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  const entrants = await createEntrants(auth, div.id, NAMES.map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
  const [table, finals] = await createStages(auth, div.id, [
    { seq: 1, kind: "league", name: "Table", config: {} },
    {
      seq: 2,
      kind: "knockout",
      name: "Finals",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "on_complete" },
    },
  ] as never);
  await generateStageFixtures(auth, table!.id);
  await startDivision(auth, div.id);
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  return { auth, divisionId: div.id, stageId: table!.id, finalsId: finals!.id, slugs: [orgSlug, comp.slug, divSlug], id: Object.fromEntries(entrants.map((e, i) => [NAMES[i]!, e.id])) };
}

/** Every seated, unplayed board of the table, the higher seed winning; returns how many were played. */
async function playAll(r: Rig, limit = Infinity): Promise<number> {
  const order = NAMES.map((n) => r.id[n]!);
  const rows = await sql<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} and status = 'scheduled' order by round_no, seq_in_round`;
  let played = 0;
  for (const f of rows) {
    if (!f.home_entrant_id || !f.away_entrant_id || played >= limit) continue;
    const homeWins = order.indexOf(f.home_entrant_id) < order.indexOf(f.away_entrant_id);
    await scoreEvent(r.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.auth, f.id, { expected_seq: 1, type: "generic.result", payload: homeWins ? { p1Score: 3, p2Score: 1 } : { p1Score: 1, p2Score: 3 } });
    played++;
  }
  return played;
}

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

/** The division page's own chain: the public read, the played facts, `divisionQualification`, rendered by StandingsTable. */
async function pageTable(r: Rig) {
  const data = (await getPublicDivision(...r.slugs))!;
  const stage = data.stages.find((s) => s.id === r.stageId)!;
  const module_ = builtinModules.find((m) => m.key === data.division.sport_key);
  const view = divisionQualification({
    module_,
    division: data.division,
    dict: en as Dict,
    locale: "en",
    fixtures: await qualificationFixtures(data.fixtures, module_, data.stages),
    entrantStatuses: Object.fromEntries(data.entrants.map((e) => [e.id, e.status])),
    entrantNames: Object.fromEntries(data.entrants.map((e) => [e.id, e.display_name])),
  })(stage, data.standings.find((s) => s.stage_id === r.stageId && s.pool_id === null)!);
  return { stage, view };
}

const byName = (r: Rig, rows: Record<string, { label: string } | undefined>) => Object.fromEntries(NAMES.map((n) => [n, rows[r.id[n]!]?.label ?? "none"]));

describe.skipIf(!HAS_DB)("X-QS-1 a finished league keeps its cut on every surface (real producer, real readers)", () => {
  it("the empty case, then the sequence: live race while a line is open, frozen once the last is played", async () => {
    const r = await league();
    expect((await pageTable(r)).view, "nothing played: no status").toBeNull();
    expect(await playAll(r, 5)).toBe(5);
    const live = (await pageTable(r)).view!;
    expect(live, "one line open: the live race").not.toBeNull();
    expect(Object.values(live.rows).map((x) => x.label)).not.toContain(QUALIFIED);
    expect(live.table.legend.open).toBe("Still open");
    expect(await playAll(r)).toBe(1);

    // every line played, not yet Completed: nobody is seated, so the markers freeze from the final table's own order
    const before = await pageTable(r);
    expect(before.stage.qualified, "nobody seated yet").toBeNull();
    expect(byName(r, before.view!.rows)).toEqual({ Ann: QUALIFIED, Ben: QUALIFIED, Cat: "Out", Dan: "Out" });

    // the producer: Complete seeds Finals on_complete; V538 publishes who went through, in its stored order
    await completeStage(r.auth, r.stageId);
    const { stage, view } = await pageTable(r);
    expect(stage.qualified, "the public read carries who went through").toEqual([r.id.Ann, r.id.Ben]);
    expect(stage.qualify_best_nth).toBe(false);
    expect(view, "the finished table keeps a view").not.toBeNull();
    expect(byName(r, view!.rows)).toEqual({ Ann: QUALIFIED, Ben: QUALIFIED, Cat: "Out", Dan: "Out" });
    expect(view!.table.label).toBe("Top 2 went through to Finals");
    expect(view!.table.legend.open).toBeNull();
  });

  it("the embed, the hub and the console each read the same frozen cut", async () => {
    const r = await league();
    expect(await playAll(r)).toBe(6);
    await completeStage(r.auth, r.stageId);

    // embed: its own select of public_stages_v carries the columns...
    const embed = await embedDivisionData(r.divisionId);
    if (!embed.ok) throw new Error(`the embed refused a public division: ${embed.reason}`);
    const eStage = embed.data.stages.find((s) => s.id === r.stageId)!;
    expect(eStage.qualified).toEqual([r.id.Ann, r.id.Ben]);
    // ...and the standings widget hands its StandingsTable the frozen view
    const root = await EmbedWidgetPage({ params: Promise.resolve({ id: r.divisionId, widget: "standings" }) });
    const tables = elements(root).filter((el) => el.type === StandingsTable);
    expect(tables, "one table").toHaveLength(1);
    const html = renderToStaticMarkup(tables[0]!);
    expect(html).toContain("Top 2 went through to Finals");
    expect(html).toContain(`aria-label="Rank 1, ${QUALIFIED}, show details"`);
    expect(html).not.toContain("Still open");

    // hub
    const doc = CompetitionHubDoc.parse(await loadCompetitionHub(r.slugs[0], r.slugs[1], new Date(), { uncached: true }));
    const hub = doc.tables.filter((t) => t.divisionId === r.divisionId && t.qualification !== null);
    expect(hub, "the finished table keeps its cut in the hub").toHaveLength(1);
    expect(hub[0]!.qualification!.label).toBe("Top 2 went through to Finals");
    expect(hub[0]!.qualification!.legend.open).toBeNull();
    const hubRows = hub[0]!.rows.map((x) => [x.name, x.qual?.status ?? null]);
    expect(hubRows).toHaveLength(4);
    expect(hubRows).toEqual([["Ann", "qualified"], ["Ben", "qualified"], ["Cat", "out"], ["Dan", "out"]]);

    // console
    const meta = (await listStageQualificationMeta(r.auth, [r.stageId])).get(r.stageId) as { qualified?: unknown; qualify_best_nth?: boolean };
    expect(meta.qualified).toEqual([r.id.Ann, r.id.Ben]);
    expect(meta.qualify_best_nth).toBe(false);
  });

  it("X-QS-2 after the table is final, a qualifier withdraws: no marker on her row; Ann still reads Qualified", async () => {
    const r = await league();
    expect(await playAll(r)).toBe(6);
    await completeStage(r.auth, r.stageId);
    // the real withdrawal cascade (nothing left to play: no line to void or award)
    await withdrawEntrantCascade(r.auth, r.id.Ben!);
    const [{ status }] = await sql<{ status: string }[]>`select status from entrants where id = ${r.id.Ben!}`;
    expect(status, "premise: Ben left the field").toBe("withdrawn");
    const { view } = await pageTable(r);
    const m = byName(r, view!.rows);
    expect(Object.keys(m)).toHaveLength(4);
    expect(m.Ben, "the departed has no marker").toBe("none");
    expect(m.Ann).toBe(QUALIFIED);
  });
});
