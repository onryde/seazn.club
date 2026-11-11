// X-TP-3 (C8, ruling 270): a finished knockout with no third-place match ranks its two semi-final losers LEVEL, 3rd
// (1, 2, 3, 3, 5, 6, 7, 8). One Shared 8-draw and one Play-off 8-draw are completed through the real doors, then EVERY server
// reader of a bracket's places is asked, through its own exported function, who holds which rank:
//   R1 getStandings (`/api/v1/stages/{id}/standings`)      R2 publicStandings (`/api/v1/public/.../standings`)
//   R3 buildDivisionDocModel "standings" (PDF/XLSX)        R4 StandingsTable (the division page's table markup)
//   R5 sourceOfficials (rank sourcing)                     R6 computeSeedProposal (progression: rank_range 1-4 cut)
// The ranks asserted come from the engine's own `places` on `stage_completed` (what `completeBracketStage` computed) and from
// the rulebook's reading of the bracket (the two semi-final losers share 3rd), never from a reader.
// Sports: badminton - the places are sport-blind; the sport sweep of completion is w4-knockout-b1.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingsRow } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { playBadminton, rowsOf, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { StandingsTable } from "@/components/public-site/standings-table";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { buildDivisionDocModel } from "@/server/usecases/exports";
import { sourceOfficials } from "@/server/usecases/officials";
import { publicStandings } from "@/server/usecases/public";
import { startDivision } from "@/server/usecases/schedule";
import { completeStage, computeSeedProposal, createStages, generateStageFixtures, getStandings } from "@/server/usecases/stages";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { t } from "@/lib/i18n-runtime";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Place = { entrantId: string; rank: number };
type Done = { type: string; finalRanks: string[]; places: Place[] };

async function playOut(auth: AuthCtx, stageId: string): Promise<void> {
  for (let guard = 0; guard < 30; guard++) {
    const next = (await rowsOf(stageId)).find((r) => r.status === "scheduled" && r.home_entrant_id !== null && r.away_entrant_id !== null);
    if (next === undefined) return;
    await playBadminton(auth, next.id, true);
  }
  throw new Error("rig: the bracket did not finish in 30 lines");
}

/** The two semi-final losers, read off the played fixtures (the rulebook's reading of who shares 3rd). */
async function semiFinalLosers(stageId: string): Promise<string[]> {
  const rows: FixtureRow[] = await rowsOf(stageId);
  const nonThird = rows.filter((r) => r.ext_key !== null && !r.ext_key.endsWith("-3p"));
  const last = Math.max(...nonThird.map((r) => r.round_no));
  const semis = nonThird.filter((r) => r.round_no === last - 1);
  expect(semis.length, "premise: an 8-draw has two semi-finals").toBe(2);
  return semis.map((s) => (s.outcome?.winner === s.home_entrant_id ? s.away_entrant_id! : s.home_entrant_id!)).sort();
}

interface Scene {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  places: Place[];
  losers: string[];
}
async function finished(thirdPlace: boolean): Promise<Scene> {
  const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 8, ...(thirdPlace ? { stageConfig: { thirdPlace: true } } : {}) });
  await playOut(s.auth, s.stageId);
  const done = await completeStage(s.auth, s.stageId);
  expect(done.completed, "rig: the bracket completed").toBe(true);
  const ev = done.events.find((e) => e.type === "stage_completed") as unknown as Done;
  return { auth: s.auth, divisionId: s.divisionId, stageId: s.stageId, places: ev.places, losers: await semiFinalLosers(s.stageId) };
}
const ranksSorted = (places: readonly Place[]) => places.map((p) => p.rank).sort((a, b) => a - b);

const checked: string[] = [];
const READERS = ["getStandings", "publicStandings", "exports", "StandingsTable", "sourceOfficials", "computeSeedProposal"];

describe.runIf(HAS_DB)("X-TP-3 every server reader reads two 3rds on a Shared 8-draw (1, 2, 3, 3, 5, 6, 7, 8)", () => {
  let shared: Scene;
  let playoff: Scene;
  it("the engine's own places are the oracle: rank 3 twice, no 4 (Shared); 3 and 4 (Play-off)", async () => {
    shared = await finished(false);
    playoff = await finished(true);
    expect(ranksSorted(shared.places), "ruling 270").toEqual([1, 2, 3, 3, 5, 6, 7, 8]);
    expect(ranksSorted(playoff.places)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shared.places.filter((p) => p.rank === 3).map((p) => p.entrantId).sort(), "the two 3rds are the semi-final losers").toEqual(shared.losers);
  }, 480_000);

  it("R1 getStandings: the stored snapshot's ranks pass through, duplicates visible, never renumbered", async () => {
    const out = await getStandings(shared.auth, shared.stageId);
    const rows = out.rows as StandingsRow[];
    expect(rows.length).toBe(8);
    for (const p of shared.places) expect(rows.find((r) => r.entrantId === p.entrantId)?.rank, p.entrantId).toBe(p.rank);
    expect(rows.filter((r) => r.rank === 3).length).toBe(2);
    expect(rows.some((r) => r.rank === 4)).toBe(false);
    const po = (await getStandings(playoff.auth, playoff.stageId)).rows as StandingsRow[];
    expect(po.map((r) => r.rank).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    checked.push("getStandings");
  });

  it("R2 publicStandings: the public API serves the same ranks", async () => {
    const [meta] = await sql<{ o: string; c: string; d: string; cid: string }[]>`
      select o.slug as o, c.slug as c, d.slug as d, c.id as cid
        from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id where d.id = ${shared.divisionId}`;
    await sql`update competitions set visibility = 'public' where id = ${meta!.cid}`;
    const doc = (await publicStandings(meta!.o, meta!.c, meta!.d)) as { standings: { stage_id: string; rows: StandingsRow[] }[] };
    const snap = doc.standings.find((s) => s.stage_id === shared.stageId);
    expect(snap, "the bracket's snapshot is public").toBeDefined();
    for (const p of shared.places) expect(snap!.rows.find((r) => r.entrantId === p.entrantId)?.rank, p.entrantId).toBe(p.rank);
    expect(snap!.rows.filter((r) => r.rank === 3).length).toBe(2);
    checked.push("publicStandings");
  });

  it("R3 the standings export marks the shared place (dictionary words) on exactly the two semi-final losers", async () => {
    const model = await buildDivisionDocModel(shared.auth, shared.divisionId, "standings", { printedAt: "2030-01-01T00:00:00.000Z" });
    const rows = model.sections.flatMap((s) => s.table?.rows ?? []);
    expect(rows.length, "anti-vacuity: eight rows exported").toBe(8);
    const shared3 = t(en as Dict, "table.sharedRank", { rank: 3 });
    expect(shared3, "premise: the dictionary's template carries the rank").toContain("3");
    expect(rows.map((r) => String(r[0])).sort()).toEqual(["1", "2", shared3, shared3, "5", "6", "7", "8"].sort());
    checked.push("exports");
  });

  it("R4 the division page's table markup wears the shared chip on the two 3rds only", async () => {
    const rows = (await getStandings(shared.auth, shared.stageId)).rows as StandingsRow[];
    const names = Object.fromEntries(rows.map((r) => [r.entrantId, r.entrantId]));
    const html = renderToStaticMarkup(createElement(StandingsTable, { rows, metricSpecs: [], cascade: [], entrantNames: names, dict: en as Dict, stageKind: "knockout" }));
    const chips = [...html.matchAll(/data-testid="standings-shared-place-([0-9a-f-]+)"/g)].map((m) => m[1]).sort();
    expect(chips).toEqual(shared.losers);
    checked.push("StandingsTable");
  });

  it("R5 sourceOfficials: rank 1 resolves from a COMPLETE stage (V210 status), rank 3 names the share instead of picking one", async () => {
    const out = await sourceOfficials(shared.auth, shared.stageId, { sources: [{ kind: "rank", fromStage: shared.stageId, take: [{ rank: 1 }, { rank: 3 }, { rank: 5 }] }] });
    const champion = shared.places.find((p) => p.rank === 1)!.entrantId;
    const fifth = shared.places.find((p) => p.rank === 5)!.entrantId;
    expect(out.resolved.map((r) => r.entrant_id).sort(), "rank 1 and rank 5 resolve; neither shared 3rd is picked").toEqual([champion, fifth].sort());
    expect(out.pending.length).toBe(1);
    expect(out.pending[0]).toMatchObject({ code: "shared_rank", rank: 3, holders: 2 });
    // Play-off: 3rd is held once and resolves.
    const po = await sourceOfficials(playoff.auth, playoff.stageId, { sources: [{ kind: "rank", fromStage: playoff.stageId, take: [{ rank: 3 }] }] });
    expect(po.resolved.map((r) => r.entrant_id)).toEqual([playoff.places.find((p) => p.rank === 3)!.entrantId]);
    checked.push("sourceOfficials");
  });
});

async function progressionRig(qualified: number) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "TP3 " + Math.random().toString(36).slice(2, 8), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + Math.random().toString(36).slice(2, 8), sport_key: "badminton", variant_key: "bwf", config: {} });
  await createEntrants(auth, division.id, Array.from({ length: 8 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  const ids: string[] = [];
  const drafts = buildTemplateStages("qualifying_main", { swissRounds: 5, poolCount: 2, legs: 1, qualified: 4 });
  // A knockout destination takes a whole round only (1, 2, 4, 8: app A's refusal), so a cut of 3 goes into a league.
  if (qualified !== 4) {
    drafts[1] = { ...drafts[1]!, kind: "league", name: "Finals league", config: {}, progression: { timing: "setup", placement: "rank_order", sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: qualified }] }] } as never };
  }
  for (const [i, d] of drafts.entries()) {
    const [stage] = await createStages(auth, division.id, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }));
    ids.push(stage!.id);
  }
  await startDivision(auth, division.id);
  await generateStageFixtures(auth, ids[1]!);
  await playOut(auth, ids[0]!);
  const done = await completeStage(auth, ids[0]!);
  expect(done.completed).toBe(true);
  const places = (done.events.find((e) => e.type === "stage_completed") as unknown as Done).places;
  expect(ranksSorted(places), "premise: the source is a Shared draw").toEqual([1, 2, 3, 3, 5, 6, 7, 8]);
  return { auth, ids, places, losers: await semiFinalLosers(ids[0]!) };
}

describe.runIf(HAS_DB)("X-TP-3 progression: a rank_range cut through a Shared 3rd is flagged, never a silent pick", () => {
  it("R6 computeSeedProposal: ranks 1-4 of a Shared 8-draw seat 1st, 2nd and BOTH 3rds, and the pair is a shared_place tie", async () => {
    const { auth, ids, places, losers } = await progressionRig(4);
    const proposal = await computeSeedProposal(auth, ids[1]!);
    const q = proposal.computed.qualifiers;
    expect(q.length, "anti-vacuity: four qualifiers").toBe(4);
    // C8: the qualifier's SOURCE reads the rank the entrant holds (3, 3), never the slot label (3rd, 4th).
    expect(q.map((x) => x.source.rank).sort(), "differential: today's slot label would read 1, 2, 3, 4").toEqual([1, 2, 3, 3]);
    expect(q.map((x) => x.entrantId).sort()).toEqual([places.find((p) => p.rank === 1)!.entrantId, places.find((p) => p.rank === 2)!.entrantId, ...losers].sort());
    const ties = proposal.computed.ties;
    expect(ties.length, "one tie: the shared 3rd").toBe(1);
    expect(ties[0]!.reason).toBe("shared_place");
    expect([...ties[0]!.entrantIds].sort()).toEqual(losers);
    checked.push("computeSeedProposal");
  }, 480_000);

  it("m8 a cut 1-3 - the one that would FORCE a pick between the two 3rds - cannot even be configured: app A refuses a non-whole-round cut from a knockout at stage creation, so no reachable cut straddles the shared place", async () => {
    await expect(progressionRig(3)).rejects.toMatchObject({ code: "KO_CUT_NOT_WHOLE_ROUND", status: 422 });
    // the whole-round cuts either side of it take BOTH 3rds or neither: 1-2 holds no 3rd, 1-4 (R6 above) holds both
  }, 480_000);
});

describe.runIf(HAS_DB)("X-TP-3 the sweep is counted", () => {
  it("every reader on the list was asked (a reader dropped from the sweep reds here)", () => {
    expect([...checked].sort()).toEqual([...READERS].sort());
  });
});
