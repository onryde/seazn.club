// A structural bye in a PROGRESSION-SEEDED bracket, read off real rows.
//
// The defect this file was written against (found by driving swiss_knockout
// Top 3 in a browser, fixed in the same commit): a `timing: "setup"`
// progression generates its bracket before anyone has qualified, so
// `generateProgressionSetupFixtures` writes EVERY line as
// `status: 'scheduled', outcome: null` — including the award line the engine
// marked `award` — and `confirmSeedProposal` then fills the slots through
// `fillSlot` without ever deciding it. The row an organiser ends up with is
// `home = <the top qualifier>, away = null, scheduled, outcome null`, which
// fails `isBye()` and therefore renders as an ordinary open match
// ("Ann vs TBD — awaiting draw") in the run sheet and the bracket panel, and
// cannot be played, so the stage can never complete either.
//
// EVERY progression-bearing template in the catalogue declares
// `timing: "setup"` (format-templates.ts), so this is not a Swiss Knockout
// concern — `league_ko` is what this file drives, precisely because it
// predates that format by months. Swiss Knockout's own N=3 shape carries the
// same assertion in `swiss-knockout-shape.test.ts`.
//
// The predicate asserted here is the UI's OWN `isBye` (lib/run-sheet-groups),
// not a hand-typed shape: `run-sheet-row.tsx` and `stages-panel.tsx` both gate
// their bye branch on it, so pinning anything else would leave the two free to
// disagree about what the fix produced.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { isBye, type RunSheetFixture } from "@/lib/run-sheet-groups";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { appendEvent } from "@/server/engine-db";
import { buildTemplateStages } from "@/components/v2/format-templates";
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

const KNOBS = { swissRounds: 5, poolCount: 2, legs: 1 };

interface Row {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: unknown;
  away_slot_label: unknown;
  status: string;
  outcome: unknown;
}

async function fixturesOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id,
           home_slot_label, away_slot_label, status, outcome
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
}

/** The exact subset `isBye` reads, lifted off the real row — so this asserts
 *  the persisted shape through the predicate the screens actually run. */
function asRunSheetFixture(r: Row): RunSheetFixture {
  return { ...r } as unknown as RunSheetFixture;
}

interface Rig {
  divisionId: string;
  leagueStageId: string;
  koStageId: string;
  nameOf: Map<string, string>;
}

/** A `league_ko` division built from the REAL catalogue draft for this Top N.
 *  `field` entrants named E1…En, seeded in order. */
async function seedLeagueKo(auth: AuthCtx, field: number, topN: number): Promise<Rig> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "League KO " + randomUUID().slice(0, 6),
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
    Array.from({ length: field }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );

  const drafts = buildTemplateStages("league_ko", { ...KNOBS, qualified: topN });
  expect(drafts.map((d) => d.kind)).toEqual(["league", "knockout"]);
  const created = [];
  for (const [i, d] of drafts.entries()) {
    // Through the REAL request schema rather than a cast — a malformed draft
    // throws here instead of quietly seeding a different stage.
    const input = CreateStage.parse({
      seq: i + 1,
      kind: d.kind,
      name: d.name,
      config: d.config,
      progression: d.progression,
    });
    const [stage] = await createStages(auth, division.id, input);
    created.push(stage!);
  }
  return {
    divisionId: division.id,
    leagueStageId: created[0]!.id,
    koStageId: created[1]!.id,
    nameOf: new Map(entrants.map((e) => [e.id, e.display_name])),
  };
}

/** Play the whole league: the LOWER-numbered entrant always wins 2-0, so the
 *  final table is strict on points alone (En has n-1 losses) and the
 *  qualification order is E1 > E2 > … with no tiebreaker in play. */
async function playLeagueOut(auth: AuthCtx, rig: Rig): Promise<void> {
  for (const f of await fixturesOf(rig.leagueStageId)) {
    const home = rig.nameOf.get(f.home_entrant_id!)!;
    const away = rig.nameOf.get(f.away_entrant_id!)!;
    const homeWins = Number(home.slice(1)) < Number(away.slice(1));
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {}, recordedBy: null });
    for (const game of [1, 2]) {
      await appendEvent(auth.orgId, f.id, game, {
        type: "badminton.game.summary",
        payload: homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 },
        recordedBy: null,
      });
    }
  }
}

async function runToBracket(auth: AuthCtx, rig: Rig): Promise<Row[]> {
  await generateStageFixtures(auth, rig.koStageId); // day-one TBD bracket
  await playLeagueOut(auth, rig);
  const done = await completeStage(auth, rig.leagueStageId);
  expect(done.completed, "the league did not complete").toBe(true);
  expect(done.seed_proposal, "no seed proposal for the finals bracket").toBeTruthy();
  await confirmSeedProposal(auth, rig.koStageId, { proposalId: done.seed_proposal!.id });
  return fixturesOf(rig.koStageId);
}

/** Every line that is structurally a bye: one entrant, no opponent, and no
 *  feeder that could ever bring one. Derived from the SEAT, never from the
 *  status or outcome columns the fix writes — asserting those against a set
 *  selected BY them would be a tautology. */
function byeLines(bracket: Row[]): Row[] {
  const firstRound = Math.min(...bracket.map((f) => f.round_no));
  return bracket.filter(
    (f) =>
      f.round_no === firstRound &&
      (f.home_entrant_id === null) !== (f.away_entrant_id === null),
  );
}

describe.runIf(HAS_DB)("a progression-seeded bracket's byes are decided, not left open", () => {
  it("league_ko Top 3 — the league winner's bye reads as a BYE, not an open match", async () => {
    const { auth } = await seedOrg();
    const rig = await seedLeagueKo(auth, 4, 3);
    await startDivision(auth, rig.divisionId);
    const bracket = await runToBracket(auth, rig);

    // Bracket of 4 from 3 qualifiers: two round-0 lines and a Final.
    expect(bracket).toHaveLength(3);
    const byes = byeLines(bracket);
    expect(byes, "a Top 3 bracket holds exactly one bye line").toHaveLength(1);
    const bye = byes[0]!;
    expect(rig.nameOf.get(bye.home_entrant_id!), "the bye belongs to the league winner").toBe("E1");

    // THE DEFECT. Before the fix every one of these read
    // `scheduled` / `null` / `false`, so the run sheet and the bracket panel
    // rendered "E1 vs TBD — awaiting draw" on a match nobody can ever play.
    expect(bye.status, "a bye is settled at generation, never playable").toBe("forfeited");
    expect(bye.outcome).toEqual({ kind: "award", winner: bye.home_entrant_id });
    expect(isBye(asRunSheetFixture(bye)), "the screens' own predicate must say bye").toBe(true);

    // The REAL match beside it must not have been swept up by the same fix.
    const real = bracket.filter((f) => f.round_no === bye.round_no && f.id !== bye.id);
    expect(real).toHaveLength(1);
    expect(real[0]!.status).toBe("scheduled");
    expect(real[0]!.outcome).toBeNull();
    expect(isBye(asRunSheetFixture(real[0]!))).toBe(false);

    // And the Final — one seat taken by the bye entrant, one still open — is
    // an ordinary waiting fixture, not a bye.
    const final = bracket.find((f) => f.round_no > bye.round_no)!;
    expect(isBye(asRunSheetFixture(final)), "a half-filled Final is not a bye").toBe(false);
  });

  it("league_ko Top 5 — BOTH of an 8-slot bracket's spare lines decide, not just the first", async () => {
    // One sample is not a parity sweep (AGENTS.md failure class 7): a fix that
    // decides only the first award line passes the Top 3 case above.
    // 5 qualifiers pad to 8, so seeds 1, 2 and 3 take the three spare lines.
    const { auth } = await seedOrg();
    const rig = await seedLeagueKo(auth, 5, 5);
    await startDivision(auth, rig.divisionId);
    const bracket = await runToBracket(auth, rig);

    const byes = byeLines(bracket);
    expect(byes, "8 slots minus 5 qualifiers is three spare lines").toHaveLength(3);
    expect(byes.map((b) => rig.nameOf.get(b.home_entrant_id!)).sort()).toEqual(["E1", "E2", "E3"]);
    for (const bye of byes) {
      expect(bye.status, `bye for ${rig.nameOf.get(bye.home_entrant_id!)}`).toBe("forfeited");
      expect(bye.outcome).toEqual({ kind: "award", winner: bye.home_entrant_id });
      expect(isBye(asRunSheetFixture(bye))).toBe(true);
    }
  });

  it("before anyone qualifies, the bye line's phantom side already says Bye, never TBD", async () => {
    // The day-one half of the same defect, and what makes the fix findable
    // from the row: `generateProgressionSetupFixtures` left the empty side of
    // an award line with a NULL slot label, so `resolveSlotLabel` fell through
    // to a generic TBD — telling an organiser to wait for an opponent who is
    // not coming. The plain (non-progression) path has written
    // `bracket.slot.bye` there since the P5 review; this is that same store,
    // on the seeded path, and it is also the marker the confirm reads.
    const { auth } = await seedOrg();
    const rig = await seedLeagueKo(auth, 4, 3);
    await startDivision(auth, rig.divisionId);
    await generateStageFixtures(auth, rig.koStageId);

    const bracket = await fixturesOf(rig.koStageId);
    expect(bracket.every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(
      true,
    );
    const byeLine = bracket.filter(
      (f) => f.round_no === 1 && f.away_slot_label !== null,
    ).filter((f) => (f.away_slot_label as { key?: string }).key === "bracket.slot.bye");
    expect(byeLine, "exactly one day-one line is the bye").toHaveLength(1);
    expect(byeLine[0]!.away_slot_label).toEqual({ key: "bracket.slot.bye", params: {} });
    // Its own home side still names the seat that will fill it — the bye label
    // must not have overwritten the descriptor.
    expect((byeLine[0]!.home_slot_label as { seed?: number }).seed).toBe(1);
  });
});
