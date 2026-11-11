// W4 knockout app PR B, batch B1 review I1: the FED (setup-timed) knockout roster. A knockout fed from a league's cut by a seed
// proposal draws its field at the proposal's Confirm; completion reads who was drawn from that confirm
// (`bracketRosterAndSeeds` -> `confirmedDraw`). Real Postgres, through the usecases the buttons call.
//
// Rulebook rows (rulebook-W4-knockout.md), never read back from the code under test:
//  - X-FR-1 (RB4-R1): every drawn entrant is ranked once; one who never held a seat in the stage and was never drawn into it
//    (withdrew from the league, never qualified) is not ranked in it.
//  - RB4-S4 / RB4-R1: a drawn qualifier who withdrew and never held a seat ranks LAST in the stage.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { fixtureRow, playBadminton, post, rowsOf, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { completeStage, computeSeedProposal, confirmSeedProposal, createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

function sportFor(): string {
  const m = builtinModules.find((x) => x.entrantModel?.defaultKind === "team");
  if (m === undefined) throw new Error("premise: the engine declares no team sport");
  return m.key;
}
const SPORTS = ["badminton", sportFor()] as const;

async function win(auth: AuthCtx, sport: string, row: FixtureRow, winner: string): Promise<void> {
  if (sport === "badminton") {
    await playBadminton(auth, row.id, winner === row.home_entrant_id);
    return;
  }
  await post(auth, row.id, "core.start");
  await post(auth, row.id, "football.goal", { by: winner });
  await post(auth, row.id, "football.period", { phase: "HT" });
  await post(auth, row.id, "football.period", { phase: "FT" });
  const r = await fixtureRow(row.id);
  if (r.status !== "decided") throw new Error(`rig: ${r.ext_key} did not decide (${r.status})`);
}

interface Fed {
  auth: AuthCtx;
  sport: string;
  divisionId: string;
  leagueId: string;
  stageId: string;
  /** Entrant id by name (E1 = registration seed 1 = best). */
  byName: Map<string, string>;
  proposalId: string;
}

/** A league of `total` entrants (the better registration seed wins every line, so E1..En is the table's order), then a
 *  setup-timed knockout of the top `qualified`. `beforeLeague` runs after Start, before any league line is played. */
async function fedKnockout(
  sport: string,
  opts: { template: "league_ko" | "group_stepladder"; total: number; qualified: number; beforeLeague?: (f: Fed) => Promise<void>; beforeConfirm?: (f: Fed) => Promise<void> },
): Promise<Fed & { confirmed: boolean }> {
  const m = builtinModules.find((x) => x.key === sport)!;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `B1fed ${sport} ${randomUUID().slice(0, 6)}`, visibility: "private", branding: {} });
  const variant = Object.keys(m.variants)[0]!;
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 8), sport_key: sport, variant_key: variant, config: m.variants[variant] as Record<string, unknown> });
  const kind = m.entrantModel?.defaultKind ?? "individual";
  const entrants = await createEntrants(auth, division.id, Array.from({ length: opts.total }, (_, i) => ({ kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })) as never);
  expect(effectiveEntrantModel(m.entrantModel ?? null, null).kinds.length, "premise: the sport has entrant kinds").toBeGreaterThan(0);
  const body = buildTemplateStages(opts.template, { qualified: opts.qualified, swissRounds: 3, poolCount: 2, legs: 1 }).map((s, i) => ({ ...s, seq: i + 1 }));
  expect(body.map((s) => [s.kind, s.progression !== null]), `premise: ${opts.template} is a league then a fed ${opts.template === "league_ko" ? "knockout" : "stepladder"}`).toEqual([["league", false], [opts.template === "league_ko" ? "knockout" : "stepladder", true]]);
  const [league, ko] = await createStages(auth, division.id, body as never);
  await generateStageFixtures(auth, league!.id);
  await generateStageFixtures(auth, ko!.id);
  await startDivision(auth, division.id);
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  const seedOf = new Map(entrants.map((e) => [e.id, e.seed ?? 99]));
  const f: Fed = { auth, sport, divisionId: division.id, leagueId: league!.id, stageId: ko!.id, byName, proposalId: "" };
  await opts.beforeLeague?.(f);
  for (const r of await rowsOf(league!.id)) {
    if (r.status !== "scheduled" || r.home_entrant_id === null || r.away_entrant_id === null) continue;
    await win(auth, sport, r, seedOf.get(r.home_entrant_id)! < seedOf.get(r.away_entrant_id)! ? r.home_entrant_id : r.away_entrant_id);
  }
  await completeStage(auth, league!.id);
  const proposal = await computeSeedProposal(auth, ko!.id);
  expect(proposal.computed.ties, "premise: no tie").toEqual([]);
  f.proposalId = proposal.id;
  await opts.beforeConfirm?.(f);
  await confirmSeedProposal(auth, ko!.id, { proposalId: proposal.id });
  return { ...f, confirmed: true };
}

async function playOut(f: Fed): Promise<string[]> {
  for (;;) {
    const next = (await rowsOf(f.stageId)).find((r) => r.status === "scheduled" && r.home_entrant_id !== null && r.away_entrant_id !== null);
    if (next === undefined) break;
    await win(f.auth, f.sport, next, next.home_entrant_id!);
  }
  const done = await completeStage(f.auth, f.stageId);
  const ev = done.events.find((e) => e.type === "stage_completed") as unknown as { finalRanks: string[] } | undefined;
  if (ev === undefined) throw new Error("rig: no stage_completed event");
  return ev.finalRanks;
}

const KINDS = [["league_ko", "knockout"], ["group_stepladder", "stepladder"]] as const;
const nameOf = (f: Fed, id: string) => [...f.byName.entries()].find(([, v]) => v === id)![0];

describe.runIf(HAS_DB)("X-FR-1 on a FED bracket: a league entrant who withdrew before the draw is not in the bracket's ranks", () => {
  let swept = 0;
  for (const sport of SPORTS) {
    for (const [template, kind] of KINDS) {
      it(`${sport} ${kind}: E6 withdraws from the league, E5 finishes 5th: the top four are drawn and ranked, nobody else`, async () => {
        const f = await fedKnockout(sport, {
          template,
          total: 6,
          qualified: 4,
          beforeLeague: async (x) => {
            await withdrawEntrantCascade(x.auth, x.byName.get("E6")!);
          },
        });
        const ranks = await playOut(f);
        expect(ranks.length, "four drawn entrants, each ranked once").toBe(4);
        expect(new Set(ranks).size, "no entrant twice").toBe(4);
        expect(new Set(ranks.map((id) => nameOf(f, id))), "the league's top four: E5 never qualified, E6 withdrew before the draw").toEqual(new Set(["E1", "E2", "E3", "E4"]));
        swept++;
      }, 240_000);
    }
  }
  it("anti-vacuity: both bracket kinds in both sports", () => expect(swept).toBe(SPORTS.length * KINDS.length));
});

describe.runIf(HAS_DB)("M3: a seed_confirmed row written before PR B (no `entrants`) still names the draw, through its proposal row", () => {
  let swept = 0;
  for (const sport of SPORTS) {
    it(`${sport}: stepladder - seed 2 withdraws (never seated), the confirm event is the OLD shape: she still ranks 3rd (RB4-S4)`, async () => {
      const f = await fedKnockout(sport, { template: "group_stepladder", total: 4, qualified: 4 });
      const [ev] = await sql<{ payload: Record<string, unknown> }[]>`
        select payload from division_events where division_id = ${f.divisionId} and type = 'seed_confirmed' and payload->>'stage_id' = ${f.stageId}`;
      expect(Array.isArray(ev!.payload.entrants), "premise: the new confirm records the draw").toBe(true);
      expect(ev!.payload.proposal_id, "premise: and still names its proposal").toBe(f.proposalId);
      const e2 = f.byName.get("E2")!;
      await withdrawEntrantCascade(f.auth, e2);
      expect((await rowsOf(f.stageId)).some((r) => r.home_entrant_id === e2 || r.away_entrant_id === e2), "premise: seed 2's seat is dead, she sits on no line").toBe(false);
      // The OLD shape: the same payload less the field this PR added.
      await sql`update division_events set payload = payload - 'entrants' where division_id = ${f.divisionId} and type = 'seed_confirmed' and payload->>'stage_id' = ${f.stageId}`;
      // R1 (seed 3 v seed 4): the lower seed climbs; the final: seed 1 wins.
      const r1 = (await rowsOf(f.stageId)).find((r) => r.status === "scheduled" && r.home_entrant_id !== null && r.away_entrant_id !== null)!;
      await win(f.auth, sport, r1, f.byName.get("E4")!);
      const final = (await rowsOf(f.stageId)).find((r) => r.status === "scheduled" && r.home_entrant_id !== null && r.away_entrant_id !== null)!;
      await win(f.auth, sport, final, f.byName.get("E1")!);
      const ranks = await playOut(f);
      expect(ranks.map((id) => nameOf(f, id)), "champion, the final's loser, the withdrawn seed 2 (R2's loser), R1's loser").toEqual(["E1", "E4", "E2", "E3"]);
      swept++;
    }, 240_000);
  }
  it("anti-vacuity: both sports", () => expect(swept).toBe(SPORTS.length));
});
