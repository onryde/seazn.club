// Swiss Knockout — the composite driven end to end through real Postgres:
// create the swiss + knockout stages from the REAL template drafts, play the
// whole swiss out with real badminton scorelines through the real append
// path, complete it, confirm the seed proposal, and read the BRACKET back off
// the fixtures table.
//
// This file exists because the thing it proves cannot be seen from a builder
// test (AGENTS.md failure class 1). `format-templates.test.ts` proves the
// template emits `rankRange(1, N)`; only this proves that N becomes a real
// bracket, and that the three shapes the owner named are the shapes an
// organiser gets:
//
//   N=2 — ONE round, a single Final.
//   N=3 — bracket of 4 with one bye: the swiss winner sits out round 0 while
//         2nd plays 3rd, then meets that winner in the Final.
//   N=4 — TWO rounds (semi-finals, then Final). NOT three: there is no
//         quarter-final below a field of five. A fixture COUNT alone cannot
//         tell those apart usefully (3 vs 7), so the round count is asserted
//         directly, at the table.
//
// ─────────────────────────────────────────────────────────────────────────
// BLOCKER these cases have to route around — reported, not fixed here.
//
// A swiss stage that declares no `config.rounds` can NEVER complete, so the
// handoff into the finals half never fires at all:
//
//   isTableStageComplete (packages/engine/src/competition/stage.ts:118-120)
//     reads `stage.rounds ?? 0` and returns false when that is 0; and
//   toTableStage (server/engine-db/competition.ts:338) only sets `rounds`
//     when `config.rounds != null`.
//
// swissGen (stages.ts) derives the field's budget from swissRoundsForFieldSize
// and uses it to stop generating — but persists it nowhere, so the number is
// known to the generator and to nobody else. Proven, not inferred: with the
// template's own config the stage sits at 6/6 fixtures `decided` across all
// three rounds and `completeStage` returns `completed: false`; with
// `rounds: 3` added and nothing else changed, it completes, proposes and
// confirms. The blocker case at the bottom of this file pins that, and it
// applies to swiss_playoff (shipped earlier on this branch) identically —
// the two templates emit a byte-identical swiss draft, which that case also
// asserts, so the finding cannot be read as this format's alone.
//
// The shape cases below therefore set `rounds` on the swiss stage explicitly.
// That is a real, supported configuration — the Settings tab's rounds input
// writes exactly this key — so the half this task owns, the BRACKET, is
// proven against real rows rather than skipped. When the derived budget is
// made visible to the completion predicate, the blocker case must be
// INVERTED, not deleted, and `declareRounds` below dropped.
// ─────────────────────────────────────────────────────────────────────────
//
// The swiss half is 4 entrants over the field's own 3-round budget, i.e. a
// full round robin, scored so the LOWER-numbered entrant always wins. That
// makes the final table strict on POINTS alone — E1 3 wins, E2 2, E3 1, E4 0
// — with no tiebreaker involved, so the qualification order these assertions
// name is the one the cascade must produce, not one of several it might.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { appendEvent } from "@/server/engine-db";
import { buildTemplateStages } from "@/components/v2/format-templates";
import { swissRoundsForFieldSize } from "@/lib/swiss-rounds";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import {
  completeStage,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
} from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const FIELD = 4;
/** Read from the SAME table the generator reads rather than typed in here, so
 *  a band edit moves this test with it instead of leaving it asserting
 *  yesterday's number. 4 entrants lands in the `upTo: 8` band ⇒ 3. */
const SWISS_ROUNDS = swissRoundsForFieldSize(FIELD);

const KNOBS = { swissRounds: 5, poolCount: 2, legs: 1 };

interface FixtureRow {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  is_final: boolean;
}

async function fixturesOf(stageId: string): Promise<FixtureRow[]> {
  return sql<FixtureRow[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, is_final
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
}

interface Rig {
  divisionId: string;
  swissStageId: string;
  koStageId: string;
  nameOf: Map<string, string>;
}

/** A badminton division whose stages are the REAL Swiss Knockout template
 *  drafts for this Top N — not a hand-typed copy of them. If the catalogue
 *  entry ever stops emitting a swiss + a knockout, or stops threading the
 *  knob, these cases go red rather than quietly proving a shape the picker no
 *  longer builds. `declareRounds` is the blocker work-around documented at
 *  the top of this file, and is the ONLY deviation from the shipped drafts. */
async function seedSwissKnockout(
  auth: AuthCtx,
  topN: number,
  declareRounds: boolean,
): Promise<Rig> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss Knockout " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open singles",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: FIELD }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );

  const drafts = buildTemplateStages("swiss_knockout", { ...KNOBS, qualified: topN });
  expect(drafts.map((d) => d.kind)).toEqual(["swiss", "knockout"]);
  const created = [];
  for (const [i, d] of drafts.entries()) {
    // Through the REAL request schema rather than a cast: StageDraft's `kind`
    // is a plain string and its TakeRule is readonly, so handing a draft
    // straight to createStages does not typecheck — and a cast would also
    // skip the one check worth having here, that what the picker builds is
    // what the API accepts. A malformed draft throws here instead of
    // silently seeding a different stage.
    const input = CreateStage.parse({
      seq: i + 1,
      kind: d.kind,
      name: d.name,
      config:
        declareRounds && d.kind === "swiss" ? { ...d.config, rounds: SWISS_ROUNDS } : d.config,
      progression: d.progression,
    });
    const [stage] = await createStages(auth, division.id, input);
    created.push(stage!);
  }

  return {
    divisionId: division.id,
    swissStageId: created[0]!.id,
    koStageId: created[1]!.id,
    nameOf: new Map(entrants.map((e) => [e.id, e.display_name])),
  };
}

/** Decide every real pairing of a swiss round: the LOWER-numbered entrant
 *  wins 2-0, whichever board it is on. Returns how many it played. */
async function playSwissRound(
  auth: AuthCtx,
  stageId: string,
  roundNo: number,
  nameOf: Map<string, string>,
): Promise<number> {
  const rows = (await fixturesOf(stageId)).filter((f) => f.round_no === roundNo);
  let played = 0;
  for (const f of rows) {
    if (f.away_entrant_id === null) continue; // bye row — already awarded
    const home = nameOf.get(f.home_entrant_id!)!;
    const away = nameOf.get(f.away_entrant_id!)!;
    const homeWins = Number(home.slice(1)) < Number(away.slice(1));
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {}, recordedBy: null });
    for (const game of [1, 2]) {
      await appendEvent(auth.orgId, f.id, game, {
        type: "badminton.game.summary",
        payload: homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 },
        recordedBy: null,
      });
    }
    played += 1;
  }
  return played;
}

/** Generate + play the swiss until the generator stops issuing rounds. */
async function playSwissOut(auth: AuthCtx, rig: Rig): Promise<void> {
  await generateStageFixtures(auth, rig.koStageId); // day-one TBD bracket
  for (let round = 1; ; round++) {
    const played = await playSwissRound(auth, rig.swissStageId, round, rig.nameOf);
    if (played === 0) break;
    const more = await generateStageFixtures(auth, rig.swissStageId);
    if (more.created === 0) break;
  }
}

/** Complete the swiss and confirm the proposal into the bracket. */
async function runToBracket(auth: AuthCtx, rig: Rig): Promise<FixtureRow[]> {
  await playSwissOut(auth, rig);
  const done = await completeStage(auth, rig.swissStageId);
  expect(done.completed, "swiss stage did not complete").toBe(true);
  expect(done.seed_proposal, "no seed proposal for the knockout").toBeTruthy();
  await confirmSeedProposal(auth, rig.koStageId, { proposalId: done.seed_proposal!.id });
  return fixturesOf(rig.koStageId);
}

/** "E2 v E3", or "E1 v bye" for an award line. */
function pairOf(f: FixtureRow, nameOf: Map<string, string>): string {
  const home = f.home_entrant_id === null ? "TBD" : nameOf.get(f.home_entrant_id)!;
  const away = f.away_entrant_id === null ? "bye" : nameOf.get(f.away_entrant_id)!;
  return `${home} v ${away}`;
}

function roundsOf(bracket: FixtureRow[]): number[] {
  return [...new Set(bracket.map((f) => f.round_no))].sort((a, b) => a - b);
}

describe.runIf(HAS_DB)("swiss knockout — the bracket an organiser's Top N actually builds", () => {
  it("plays the swiss out to a strict E1 > E2 > E3 > E4, which every shape below reads as its seeding", async () => {
    // The premise the three shape cases rest on, asserted once on its own: a
    // full round robin won by the lower number every time is 3/2/1/0 wins, so
    // the qualification order is decided on POINTS with no tiebreaker. If it
    // ever tied, the shapes below would still pass while naming the wrong
    // entrants — so it is proven here rather than assumed there.
    const { auth } = await seedOrg();
    const rig = await seedSwissKnockout(auth, 4, true);
    await startDivision(auth, rig.divisionId);
    await playSwissOut(auth, rig);

    const swiss = await fixturesOf(rig.swissStageId);
    expect(roundsOf(swiss)).toEqual([1, 2, 3]);
    expect(swiss.filter((f) => f.status !== "decided"), "unsettled swiss fixtures").toEqual([]);
    // A 4-entrant swiss over 3 rounds is a full round robin: every pair meets
    // exactly once, so the table is settled by wins alone.
    expect(swiss.map((f) => pairOf(f, rig.nameOf)).sort()).toEqual([
      "E1 v E2",
      "E1 v E3",
      "E1 v E4",
      "E2 v E3",
      "E2 v E4",
      "E3 v E4",
    ]);
  });

  it("N=2 — a single Final, one round, no semi-final", async () => {
    const { auth } = await seedOrg();
    const rig = await seedSwissKnockout(auth, 2, true);
    await startDivision(auth, rig.divisionId);
    const bracket = await runToBracket(auth, rig);

    expect(roundsOf(bracket)).toHaveLength(1);
    expect(bracket).toHaveLength(1);
    expect(bracket[0]!.is_final).toBe(true);
    expect(pairOf(bracket[0]!, rig.nameOf)).toBe("E1 v E2");
  });

  it("N=3 — a bye for the swiss winner, a real 2nd-v-3rd semi, and the winner meets them in the Final", async () => {
    const { auth } = await seedOrg();
    const rig = await seedSwissKnockout(auth, 3, true);
    await startDivision(auth, rig.divisionId);
    const bracket = await runToBracket(auth, rig);

    // Bracket of 4 padded from 3: two round-0 lines and a Final — three rows,
    // but only TWO of them are matches anyone plays.
    const rounds = roundsOf(bracket);
    expect(rounds).toHaveLength(2);
    expect(bracket).toHaveLength(3);

    const first = bracket.filter((f) => f.round_no === rounds[0]);
    expect(first).toHaveLength(2);

    // One line is a BYE — one entrant, no opponent, nothing to play.
    const byes = first.filter((f) => f.away_entrant_id === null);
    expect(byes, "expected exactly one bye line").toHaveLength(1);
    expect(rig.nameOf.get(byes[0]!.home_entrant_id!), "the bye belongs to the swiss winner").toBe(
      "E1",
    );

    // The other is a REAL match, and it is 2nd against 3rd — not 1st against
    // anyone. Byeing the wrong end of the table is the shape this refuses.
    const real = first.filter((f) => f.away_entrant_id !== null);
    expect(real).toHaveLength(1);
    expect(
      [
        rig.nameOf.get(real[0]!.home_entrant_id!),
        rig.nameOf.get(real[0]!.away_entrant_id!),
      ].sort(),
    ).toEqual(["E2", "E3"]);

    // And the Final ALREADY holds the bye entrant, waiting on that winner —
    // the half that makes a bye a real progression rather than a dead row.
    const final = bracket.find((f) => f.round_no === rounds[1])!;
    expect(final.is_final).toBe(true);
    const seated = [final.home_entrant_id, final.away_entrant_id];
    expect(seated.filter((x) => x !== null).map((x) => rig.nameOf.get(x!))).toEqual(["E1"]);
    expect(seated.filter((x) => x === null), "the 2nd/3rd winner's slot stays open").toHaveLength(1);
  });

  it("N=4 — exactly TWO rounds, semi-finals then Final; no quarter-final", async () => {
    const { auth } = await seedOrg();
    const rig = await seedSwissKnockout(auth, 4, true);
    await startDivision(auth, rig.divisionId);
    const bracket = await runToBracket(auth, rig);

    // The differential this case exists for: quarters + semis + final over an
    // 8-slot bracket would be 7 fixtures across 3 rounds. Both numbers are
    // asserted, so neither a stray extra round nor a coincidental fixture
    // count can hide the other.
    const rounds = roundsOf(bracket);
    expect(rounds, "a Top 4 is semis + final, never quarters too").toHaveLength(2);
    expect(bracket).toHaveLength(3);

    const semis = bracket.filter((f) => f.round_no === rounds[0]);
    expect(semis).toHaveLength(2);
    // Nobody byes at a power-of-two field: every qualifier has an opponent.
    expect(semis.every((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)).toBe(true);
    // Standard fold — seedPositions(4) = [1,4,3,2] ⇒ 1v4 and 3v2, so the
    // swiss's top two cannot meet before the Final.
    expect(semis.map((f) => pairOf(f, rig.nameOf)).sort()).toEqual(["E1 v E4", "E3 v E2"]);

    const final = bracket.find((f) => f.round_no === rounds[1])!;
    expect(final.is_final).toBe(true);
    expect(final.home_entrant_id).toBeNull();
    expect(final.away_entrant_id).toBeNull();
  });

  // ── The blocker, pinned ──────────────────────────────────────────────────
  // This asserts a DEFECT as the current behaviour, deliberately and under a
  // title that says so, because it is the one thing standing between both
  // swiss composites and a finished tournament. When the derived budget is
  // made visible to the completion predicate, INVERT this case (and drop
  // seedSwissKnockout's `declareRounds` argument) — do not delete it.
  it("DEFECT: a swiss stage with no declared rounds never completes, so the finals half is never seeded", async () => {
    const { auth } = await seedOrg();
    const rig = await seedSwissKnockout(auth, 4, false); // the SHIPPED drafts
    await startDivision(auth, rig.divisionId);
    await playSwissOut(auth, rig);

    // The generator stopped at the field's own budget, and every fixture it
    // issued is settled — there is nothing left for anyone to play.
    const swiss = await fixturesOf(rig.swissStageId);
    expect(roundsOf(swiss)).toEqual([1, 2, 3]);
    expect(swiss.filter((f) => f.status !== "decided")).toEqual([]);

    // And yet:
    const done = await completeStage(auth, rig.swissStageId);
    expect(done.completed, "if this is now true, invert this case").toBe(false);
    expect(done.seed_proposal ?? null).toBeNull();

    // The bracket stays fully TBD — day-one placeholders and nobody in them.
    const bracket = await fixturesOf(rig.koStageId);
    expect(bracket.length).toBeGreaterThan(0);
    expect(bracket.every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(
      true,
    );

    // …and this is NOT a Swiss Knockout defect. swiss_playoff, shipped
    // earlier on this branch, emits a byte-identical swiss draft, so it
    // stalls at exactly the same point. Asserted here rather than paid for
    // with a second DB run: the draft IS the whole cause.
    const mine = buildTemplateStages("swiss_knockout", { ...KNOBS, qualified: 4 })[0]!;
    const sibling = buildTemplateStages("swiss_playoff", { ...KNOBS, qualified: 4 })[0]!;
    expect(sibling.config).toEqual(mine.config);
    expect(mine.config).not.toHaveProperty("rounds");
  });
});
