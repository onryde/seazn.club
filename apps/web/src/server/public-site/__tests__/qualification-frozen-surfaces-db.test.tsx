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
import type { StandingsRow } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { embedDivisionData } from "@/server/embed-data";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { listStageQualificationMeta } from "@/server/usecases/stage-qualification";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures, getSeedProposal, getStandings } from "@/server/usecases/stages";
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

/** A public generic league of four into Finals (top 2; on_complete unless `timing` says otherwise), Started. A `setup` Finals
 *  is generated day-one (TBD seats), as a template's is, so the confirm has seats to fill. */
async function league(timing: "on_complete" | "setup" = "on_complete"): Promise<Rig> {
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
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing },
    },
  ] as never);
  if (timing === "setup") await generateStageFixtures(auth, finals!.id);
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

// W5 B3 fix (review I-1; controller ruling 1): a cut-line tie waiting on the organiser's pick shows no final verdict.
// Every shipped template's knockout is `timing: "setup"` (lib/format-templates.ts), so the organiser confirms the seats - and a
// class the engine could split only by the lot is a proposal tie the confirm refuses until it is answered (SEEDING_TIE_UNRESOLVED),
// which the answer may resolve AGAINST the lot. The scene, played through scoreEvent: Ann beats everyone 3-1; Ben and Cat draw
// 2-2 and each beat Dan 3-1 - level on points, difference, scored and head-to-head (generic's declared order, then the lot).
// Expected values: the engine's own flags on the stored table (`tieUnbroken`, `tieBreak.with`, its lot order) and the cut (2).
const TIE_SCORES: Record<string, readonly [number, number]> = {
  "Ann,Ben": [3, 1], "Ann,Cat": [3, 1], "Ann,Dan": [3, 1], "Ben,Cat": [2, 2], "Ben,Dan": [3, 1], "Cat,Dan": [3, 1],
};

/** Every line of the table, scored per TIE_SCORES (the first-named side's score first); returns how many were played. */
async function playTied(r: Rig): Promise<number> {
  const nameOf = new Map(NAMES.map((n) => [r.id[n]!, n]));
  const rows = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} and status = 'scheduled' order by round_no, seq_in_round`;
  for (const f of rows) {
    const [h, a] = [nameOf.get(f.home_entrant_id)!, nameOf.get(f.away_entrant_id)!];
    const flipped = NAMES.indexOf(h) > NAMES.indexOf(a);
    const s = TIE_SCORES[flipped ? `${a},${h}` : `${h},${a}`]!;
    await scoreEvent(r.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.auth, f.id, { expected_seq: 1, type: "generic.result", payload: flipped ? { p1Score: s[1], p2Score: s[0] } : { p1Score: s[0], p2Score: s[1] } });
  }
  return rows.length;
}

/** The organiser's console chain: its meta read (`listStageQualificationMeta`) and its tenant read of the table (`getStandings`). */
async function orgTable(r: Rig) {
  const data = (await getPublicDivision(...r.slugs))!;
  const meta = (await listStageQualificationMeta(r.auth, [r.stageId])).get(r.stageId)!;
  const module_ = builtinModules.find((m) => m.key === data.division.sport_key);
  const snap = await getStandings(r.auth, r.stageId);
  const view = divisionQualification({
    module_,
    division: data.division,
    dict: en as Dict,
    locale: "en",
    fixtures: await qualificationFixtures(data.fixtures, module_, data.stages),
    entrantStatuses: Object.fromEntries(data.entrants.map((e) => [e.id, e.status])),
    entrantNames: Object.fromEntries(data.entrants.map((e) => [e.id, e.display_name])),
  })({ id: r.stageId, kind: "league", ...meta } as never, { pool_id: null, rows: snap.rows as never });
  return { meta, view };
}

/** Every surface's markers by name: the division page, the organiser console, the hub and the embed's rendered table. */
async function everySurface(r: Rig) {
  const page = byName(r, (await pageTable(r)).view?.rows ?? {});
  const org = byName(r, (await orgTable(r)).view?.rows ?? {});
  const doc = CompetitionHubDoc.parse(await loadCompetitionHub(r.slugs[0], r.slugs[1], new Date(), { uncached: true }));
  const hubTable = doc.tables.find((t) => t.divisionId === r.divisionId && t.qualification !== null);
  const hubLabel: Record<string, string> = { qualified: QUALIFIED, out: "Out" };
  const hub = Object.fromEntries(NAMES.map((n) => [n, hubLabel[hubTable?.rows.find((x) => x.name === n)?.qual?.status ?? ""] ?? "none"]));
  const root = await EmbedWidgetPage({ params: Promise.resolve({ id: r.divisionId, widget: "standings" }) });
  const html = renderToStaticMarkup(elements(root).find((el) => el.type === StandingsTable)!);
  const ranked = (await pageTable(r)).view;
  return { page, org, hub, html, ranked };
}

describe.skipIf(!HAS_DB)("I-1 a cut-line tie waiting on the organiser's pick shows no final verdict (W5 B3 fix; real producer, every reader)", () => {
  it("the lot put one of two level sides 2nd: neither reads a verdict until the pick is confirmed; then the pick's, the lot's loser through", async () => {
    const r = await league("setup");
    expect(await playTied(r)).toBe(6);

    // premise, the engine's flags on the stored table: Ben and Cat level on everything, the lot ordered them; Ann 1st, Dan 4th
    const snap = await getStandings(r.auth, r.stageId);
    const rowOf = (n: string) => (snap.rows as StandingsRow[]).find((x) => x.entrantId === r.id[n])!;
    for (const [n, other] of [["Ben", "Cat"], ["Cat", "Ben"]] as const) {
      expect(rowOf(n).tieUnbroken, `premise: ${n} is level with ${other} on every step`).toBe(true);
      expect(rowOf(n).tieBreak?.with, `premise: ${n}'s class`).toEqual([r.id[other]]);
      expect(rowOf(n).tieBreak?.key).toBe("lots");
    }
    expect([rowOf("Ann").rank, rowOf("Dan").rank, rowOf("Ann").tieUnbroken ?? false, rowOf("Dan").tieUnbroken ?? false]).toEqual([1, 4, false, false]);
    const lotWinner = rowOf("Ben").rank === 2 ? "Ben" : "Cat";
    const lotLoser = lotWinner === "Ben" ? "Cat" : "Ben";
    expect(rowOf(lotLoser).rank, "premise: the class holds 2nd and 3rd, across the cut of 2").toBe(3);

    // 1. every line played, not yet Completed: the tie straddles the cut - no verdict on Ben or Cat; Ann and Dan keep theirs
    const waiting = { Ann: QUALIFIED, Ben: "none", Cat: "none", Dan: "Out" };
    const before = await everySurface(r);
    expect(before.page, "division page, before Complete").toEqual(waiting);
    expect(before.org, "organiser console, before Complete").toEqual(waiting);
    expect(before.hub, "hub, before Complete").toEqual(waiting);
    expect(before.ranked!.table.label, "the line still stands at the cut").toBe("Top 2 went through to Finals");

    // 2. Complete (setup): a draft, its tie flagged - still nobody seated, still no verdict for the class
    await completeStage(r.auth, r.stageId);
    const draft = (await getSeedProposal(r.auth, r.finalsId))!;
    expect(draft.status).toBe("draft");
    expect(draft.computed.ties, "the proposal flags the tie").toHaveLength(1);
    expect([...draft.computed.ties[0]!.entrantIds].sort()).toEqual([r.id.Ben!, r.id.Cat!].sort());
    const drafted = await everySurface(r);
    expect((await orgTable(r)).meta.qualified ?? null, "the console: a draft is not who went through").toBeNull();
    expect(drafted.page, "division page, draft").toEqual(waiting);
    expect(drafted.org, "organiser console, draft").toEqual(waiting);
    expect(drafted.hub, "hub, draft").toEqual(waiting);
    for (const n of ["Ben", "Cat"]) {
      const rank = rowOf(n).rank!;
      expect(drafted.html, `embed: ${n}'s rank cell carries no verdict`).not.toMatch(new RegExp(`aria-label="Rank ${rank}, (Qualified|Out), show details"`));
    }
    expect(drafted.html).toContain(`aria-label="Rank 1, ${QUALIFIED}, show details"`);
    expect(drafted.html).toContain(`aria-label="Rank 4, Out, show details"`);

    // 3. the organiser picks AGAINST the lot and confirms: who went through is the pick's
    const tie = draft.computed.ties[0]!;
    await confirmSeedProposal(r.auth, r.finalsId, { proposalId: draft.id, tiePicks: [{ slots: tie.slots, order: [r.id[lotLoser]!, r.id[lotWinner]!] }] });
    const picked = { Ann: QUALIFIED, [lotLoser]: QUALIFIED, [lotWinner]: "Out", Dan: "Out" };
    const after = await everySurface(r);
    expect((await pageTable(r)).stage.qualified, "the public read: who went through").toEqual([r.id.Ann, r.id[lotLoser]]);
    expect((await orgTable(r)).meta.qualified, "the console: who went through").toEqual([r.id.Ann, r.id[lotLoser]]);
    expect(after.page, "division page, confirmed").toEqual(picked);
    expect(after.org, "organiser console, confirmed").toEqual(picked);
    expect(after.hub, "hub, confirmed").toEqual(picked);
    expect(after.html).toContain(`aria-label="Rank ${rowOf(lotLoser).rank}, ${QUALIFIED}, show details"`);
    expect(after.html).toContain(`aria-label="Rank ${rowOf(lotWinner).rank}, Out, show details"`);
  });

  it("the positive pair: the same tie wholly above the cut (Top 3) freezes at once - nothing waits on the pick", async () => {
    // Ben and Cat level at 2nd-3rd, the cut at 3: both go through whatever the pick, so every row keeps its verdict.
    const r = await league("setup");
    await sql`update stages set progression = jsonb_set(progression, '{sources,0,take,0,to}', '3'::jsonb) where id = ${r.finalsId}`;
    expect(await playTied(r)).toBe(6);
    const all = { Ann: QUALIFIED, Ben: QUALIFIED, Cat: QUALIFIED, Dan: "Out" };
    const s = await everySurface(r);
    expect(s.page).toEqual(all);
    expect(s.org).toEqual(all);
    expect(s.hub).toEqual(all);
  });
});
