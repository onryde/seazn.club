// W4 app B, Task 9 (X-TP-1, X-TP-2, X-TP-6, X-TP-7): "Third place: Shared / Play-off match", the server half, on a real
// database through the usecases the PATCH, Generate, Withdraw and Complete call. Expected values come from the ENGINE: the
// lines a bracket draws are `engineBracketRows` (its own generator), the rank places are the rulebook's (1st, 2nd, then the two
// semi-final losers 4th and 4th when nobody plays the third-place match: X-TP-7).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { HttpError } from "@/lib/errors";
import { engineBracketRows } from "@/lib/__tests__/engine-bracket-rows";
import { KNOCKOUT_REFUSALS } from "@/lib/knockout-refusals";
import { CreateStage } from "@/server/api-v1/schemas";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, playBadminton, rowsOf } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { callFixtureToCourt } from "../match-day-call";
import { startDivision } from "../schedule";
import { completeStage, createStages, generateStageFixtures, getStandings, patchKnockoutStage } from "../stages";
import { createCourt, createVenue } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { writeEntrantPatch } from "../entrants";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { confirmSeedProposal } from "../stages";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// A set sport and a chess one (the brief: chess and badminton). Variants are the engine's declared ones.
const SPORTS = [
  { key: "badminton", variant: declaredVariant("badminton", "bwf") },
  { key: "boardgame", variant: declaredVariant("boardgame", "classical") },
] as const;

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  ids: string[];
}

/** A division of `n` seeded entrants and one root knockout stage; `generate: false` leaves the stage with no lines. */
async function rig(sport: (typeof SPORTS)[number], n: number, opts: { thirdPlace?: boolean; generate?: boolean } = {}): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "T9 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: sport.key, variant_key: sport.variant, config: {} });
  const made = await createEntrants(
    auth,
    div.id,
    Array.from({ length: n }, (_, i) => ({ kind: "individual", display_name: `E${i + 1}`, seed: i + 1, members: [] })) as never,
  );
  const [stage] = await createStages(auth, div.id, { seq: 1, kind: "knockout", name: "KO", config: opts.thirdPlace ? { thirdPlace: true } : {}, progression: null });
  if (opts.generate !== false) await generateStageFixtures(auth, stage!.id);
  return { auth, divisionId: div.id, stageId: stage!.id, ids: made.map((e) => e.id) };
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    expect(e, "a named refusal, never a 500").toBeInstanceOf(HttpError);
    return e as HttpError;
  }
  throw new Error("expected a refusal, none was raised");
}

const configOf = async (stageId: string) => (await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`)[0]!.config;
const lineKeys = async (stageId: string) => (await rowsOf(stageId)).map((r) => r.ext_key).sort();
const bronzeOf = async (stageId: string) => (await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} and third_place`);

/** The ranks the stage's stored placement holds, by entrant. */
async function ranksOf(auth: AuthCtx, stageId: string): Promise<Map<string, number>> {
  const snap = await getStandings(auth, stageId);
  const rows = snap.rows as { entrantId: string; rank: number }[];
  expect(rows.length, "anti-vacuity: the snapshot has rows").toBeGreaterThan(0);
  return new Map(rows.map((r) => [r.entrantId, r.rank]));
}

describe.skipIf(!HAS_DB)("X-TP-6 the setting is editable until the stage starts, then read-only", () => {
  for (const sport of SPORTS) {
    it(`Shared -> Play-off -> Shared draws the engine's own lines each way, with one -3p line fed by the two semi-finals [${sport.key}]`, async () => {
      const r = await rig(sport, 4);
      const shared = engineBracketRows(4, false);
      const playoff = engineBracketRows(4, true);
      expect(await lineKeys(r.stageId), "rig: the Shared bracket is the engine's").toEqual(shared.map((x) => x.ext_key).sort());
      expect((await bronzeOf(r.stageId)).length, "Shared draws no third-place line").toBe(0);

      const first = await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "playoff" });
      expect(first).toEqual({ stage_id: r.stageId, thirdPlace: "playoff", regenerated: true });
      expect((await configOf(r.stageId)).thirdPlace).toBe(true);
      expect(await lineKeys(r.stageId), "the Play-off bracket is the engine's").toEqual(playoff.map((x) => x.ext_key).sort());
      const bronze = await bronzeOf(r.stageId);
      expect(bronze, "exactly one -3p line").toHaveLength(1);
      // fed by the two semi-finals: the engine's own homeFrom/awayFrom, read as the semis' loser edges
      const semis = (await rowsOf(r.stageId)).filter((x) => x.loser_to_fixture === bronze[0]!.id);
      expect(semis, "both semi-finals feed their losers to the third-place line").toHaveLength(2);
      const engineSemis = engineBracketRows(4, true).filter((x) => x.path === "H" || x.path === "A").map((x) => x.ext_key).sort();
      expect(semis.map((x) => x.ext_key).sort(), "the engine's semi-finals").toEqual(engineSemis);
      expect(semis.map((x) => x.loser_to_slot).sort(), "one into each seat").toEqual([1, 2]);

      const back = await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "shared" });
      expect(back).toEqual({ stage_id: r.stageId, thirdPlace: "shared", regenerated: true });
      expect(await lineKeys(r.stageId), "back to the Shared bracket").toEqual(shared.map((x) => x.ext_key).sort());
      expect((await rowsOf(r.stageId)).filter((x) => x.loser_to_fixture !== null), "no loser edge into a line that is gone").toHaveLength(0);
    }, 120_000);

    it(`a second identical PATCH is a no-op: same lines, nothing regenerated [${sport.key}]`, async () => {
      const r = await rig(sport, 4);
      await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "playoff" });
      const before = (await rowsOf(r.stageId)).map((x) => x.id).sort();
      const again = await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "playoff" });
      expect(again).toEqual({ stage_id: r.stageId, thirdPlace: "playoff", regenerated: false });
      expect((await rowsOf(r.stageId)).map((x) => x.id).sort(), "the very same rows").toEqual(before);
      const shared = await rig(sport, 4);
      expect((await patchKnockoutStage(shared.auth, shared.stageId, { thirdPlace: "shared" })).regenerated, "Shared on a Shared stage").toBe(false);
    }, 120_000);
  }

  it("empty case: a stage with no lines takes the setting and draws nothing; the first Generate then draws the third-place line", async () => {
    const r = await rig(SPORTS[0], 4, { generate: false });
    expect(await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "playoff" })).toEqual({ stage_id: r.stageId, thirdPlace: "playoff", regenerated: false });
    expect((await rowsOf(r.stageId)).length, "nothing drawn by the PATCH").toBe(0);
    await generateStageFixtures(r.auth, r.stageId);
    expect(await lineKeys(r.stageId)).toEqual(engineBracketRows(4, true).map((x) => x.ext_key).sort());
  });

  it("after a withdrawal before Start the PATCH redraws the field that is left", async () => {
    const r = await rig(SPORTS[0], 5);
    await writeEntrantPatch(r.auth, r.ids[4]!, { status: "withdrawn" });
    await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "playoff" });
    expect(await lineKeys(r.stageId), "four are left: the engine's four-entrant bracket with its third-place line").toEqual(engineBracketRows(4, true).map((x) => x.ext_key).sort());
  });

  it("it refuses by name once a line has a result (a played semi-final), writing nothing", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const semis = (await rowsOf(s.stageId)).filter((x) => x.home_entrant_id && x.away_entrant_id);
    await playBadminton(s.auth, semis[0]!.id, true);
    const before = await lineKeys(s.stageId);
    const err = await refusal(patchKnockoutStage(s.auth, s.stageId, { thirdPlace: "playoff" }));
    expect([err.status, err.code, err.message]).toEqual([409, "THIRD_PLACE_LOCKED", KNOCKOUT_REFUSALS.THIRD_PLACE_LOCKED.en]);
    expect(err.message).toBe("Third place can't change once play has started.");
    expect(await lineKeys(s.stageId), "no line written").toEqual(before);
    expect((await configOf(s.stageId)).thirdPlace, "config untouched").toBeUndefined();
    // the same value is refused too: read-only means read-only
    expect((await refusal(patchKnockoutStage(s.auth, s.stageId, { thirdPlace: "shared" }))).code).toBe("THIRD_PLACE_LOCKED");
  }, 120_000);

  it("it refuses by name after a Match Day call (X-LE-9's started), though nothing was scored", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const venue = await createVenue(s.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
    const court = await createCourt(s.auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    await sql`
      insert into schedule_settings (division_id, org_id, config)
      values (${s.divisionId}, ${s.auth.orgId}, ${sql.json({ courts: [court.id] } as never)})
      on conflict (division_id) do update set config = excluded.config`;
    const semi = (await rowsOf(s.stageId)).find((x) => x.home_entrant_id && x.away_entrant_id)!;
    await sql`update fixtures set scheduled_at = ${"2030-06-01T10:00:00.000Z"}, court_id = ${court.id}, venue_id = ${venue.id} where id = ${semi.id}`;
    await callFixtureToCourt(s.auth, semi.id, court.id);
    expect((await refusal(patchKnockoutStage(s.auth, s.stageId, { thirdPlace: "playoff" }))).code).toBe("THIRD_PLACE_LOCKED");
  }, 120_000);

  it("a started division whose stage has not started is still editable: the lines drawn at Start are redrawn", async () => {
    const r = await rig(SPORTS[0], 4);
    await startDivision(r.auth, r.divisionId);
    expect((await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "playoff" })).regenerated).toBe(true);
    expect(await lineKeys(r.stageId)).toEqual(engineBracketRows(4, true).map((x) => x.ext_key).sort());
  }, 120_000);

  it("a stage that is no knockout is refused by name (a league), and so is nothing at all: an unknown stage is 404", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "T9 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const div = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: declaredVariant("badminton", "bwf"), config: {} });
    const [league] = await createStages(auth, div.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    const err = await refusal(patchKnockoutStage(auth, league!.id, { thirdPlace: "playoff" }));
    expect([err.status, err.code]).toEqual([422, "STAGE_NOT_KNOCKOUT"]);
    expect((await configOf(league!.id)).thirdPlace, "nothing written").toBeUndefined();
    expect((await refusal(patchKnockoutStage(auth, randomUUID(), { thirdPlace: "playoff" }))).status).toBe(404);
  });
});

describe.skipIf(!HAS_DB)("X-TP-1 third place is not offered below 4", () => {
  for (const sport of SPORTS) {
    it(`a play-off PATCH at 3 entrants is KO_THIRD_PLACE_TOO_FEW naming the count; Shared still works [${sport.key}]`, async () => {
      const r = await rig(sport, 3);
      const err = await refusal(patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "playoff" }));
      expect([err.status, err.code, err.message]).toEqual([422, "KO_THIRD_PLACE_TOO_FEW", "A third-place match needs at least 4 entrants. Use Shared third place instead."]);
      expect(err.extra).toMatchObject({ entrants: 3 });
      expect((await configOf(r.stageId)).thirdPlace, "rolled back").toBeUndefined();
      expect(await lineKeys(r.stageId), "no line written").toEqual(engineBracketRows(3, false).map((x) => x.ext_key).sort());
      expect((await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "shared" })).regenerated).toBe(false);
    }, 120_000);
  }

  it("empty case first: nobody (0) and one entrant also refuse the play-off, by the same code", async () => {
    for (const n of [0, 1, 2]) {
      const r = await rig(SPORTS[0], n, { generate: false });
      const err = await refusal(patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "playoff" }));
      expect([err.code, (err.extra as { entrants?: number }).entrants], `n=${n}`).toEqual(["KO_THIRD_PLACE_TOO_FEW", n]);
    }
  });

  it("the n=3 Shared stage ranks its single semi-final loser 3rd alone (RB4-E5, the Rank places table)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 3 });
    const rows = await rowsOf(s.stageId);
    const semi = rows.find((x) => x.home_entrant_id && x.away_entrant_id && x.round_no === 1)!;
    const done = await playBadminton(s.auth, semi.id, true);
    const final = (await rowsOf(s.stageId)).find((x) => x.round_no === 2)!;
    expect(final.home_entrant_id && final.away_entrant_id, "rig: the final is seated").toBeTruthy();
    const f = await playBadminton(s.auth, final.id, true);
    expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
    const ranks = await ranksOf(s.auth, s.stageId);
    const out = (done.outcome as { winner: string; loser: string });
    const fin = (f.outcome as { winner: string; loser: string });
    expect(ranks.get(fin.winner)).toBe(1);
    expect(ranks.get(fin.loser)).toBe(2);
    const third = [...ranks.entries()].filter(([, rank]) => rank === 3).map(([id]) => id);
    expect(third, "one entrant alone on 3rd").toHaveLength(1);
    expect([out.winner, out.loser].includes(third[0]!), "the semi-final's own entrant").toBe(true);
    expect(ranks.size, "three entrants ranked").toBe(3);
  }, 120_000);

  for (const sport of SPORTS) {
    it(`a play-off stage that shrinks to 3 refuses by name at Generate and offers Shared; Shared then generates [${sport.key}]`, async () => {
      // Review Focus 3: never a 500.
      const r = await rig(sport, 4, { thirdPlace: true });
      expect((await bronzeOf(r.stageId)).length, "rig: drawn with its third-place line at 4").toBe(1);
      await writeEntrantPatch(r.auth, r.ids[3]!, { status: "withdrawn" });
      const err = await refusal(generateStageFixtures(r.auth, r.stageId));
      expect([err.status, err.code]).toEqual([422, "KO_THIRD_PLACE_TOO_FEW"]);
      expect(err.extra).toMatchObject({ entrants: 3 });
      // the offered way out: Shared, one tap, then Generate succeeds (the PATCH redraws the three that are left)
      const patched = await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "shared" });
      expect(patched.thirdPlace).toBe("shared");
      await generateStageFixtures(r.auth, r.stageId);
      expect(await lineKeys(r.stageId), "the engine's three-entrant Shared bracket").toEqual(engineBracketRows(3, false).map((x) => x.ext_key).sort());
    }, 120_000);
  }
});

describe.skipIf(!HAS_DB)("X-TP-7 a third-place play-off with players out", () => {
  async function bronzeRig() {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    expect(semis, "rig: two semi-finals").toHaveLength(2);
    for (const sf of semis) await playBadminton(s.auth, sf.id, true);
    const [bronze] = await bronzeOf(s.stageId);
    const b = await fixtureRow(bronze!.id);
    expect([b.home_entrant_id, b.away_entrant_id].every((x) => x !== null), "rig: both bronze seats filled").toBe(true);
    return { s, b };
  }

  it("with both out, 3rd is vacant and both rank 4th: 1, 2, 4, 4", async () => {
    // differential: today the -3p waits for settle (X-DW-3's hold), nothing is written and the stage never completes.
    const { s, b } = await bronzeRig();
    await writeEntrantPatch(s.auth, b.home_entrant_id!, { status: "withdrawn" }); // the bare flip: no cascade
    await withdrawEntrantCascade(s.auth, b.away_entrant_id!); // the cascade: the second departure is the trigger
    const after = await fixtureRow(b.id);
    expect(after.outcome, "a departure double walkover, as a bye is written").toEqual({ kind: "double_walkover" });
    const final = (await rowsOf(s.stageId)).find((r) => r.round_no === 2 && r.id !== b.id)!;
    await playBadminton(s.auth, final.id, true);
    expect((await completeStage(s.auth, s.stageId)).completed, "the stage completes with the bronze match settled").toBe(true);
    const ranks = await ranksOf(s.auth, s.stageId);
    const fin = (await fixtureRow(final.id)).outcome as { winner: string; loser: string };
    expect([ranks.get(fin.winner), ranks.get(fin.loser)]).toEqual([1, 2]);
    expect([ranks.get(b.home_entrant_id!), ranks.get(b.away_entrant_id!)], "both bronze players rank 4th").toEqual([4, 4]);
    expect([...ranks.values()].sort(), "1, 2, 4, 4").toEqual([1, 2, 4, 4]);
  }, 180_000);

  it("with one side out the other side is walked over (a walkover, not vacant)", async () => {
    const { s, b } = await bronzeRig();
    await withdrawEntrantCascade(s.auth, b.home_entrant_id!);
    const after = await fixtureRow(b.id);
    expect(after.status).toBe("forfeited");
    expect(after.outcome).toMatchObject({ kind: "award", winner: b.away_entrant_id, loser: b.home_entrant_id, reason: "withdrew" });
  }, 120_000);
});

describe.skipIf(!HAS_DB)("C20 a flip re-validates the cuts that read this stage's third place (both directions)", () => {
  const cut = (from: number, to: number) => ({ sources: [{ stage: "previous", take: [{ kind: "rankRange", from, to }] }], placement: "rank_order", timing: "setup" });
  async function cutRig(source: Record<string, unknown>, from: number, to: number) {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "T9 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const div = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: declaredVariant("badminton", "bwf"), config: {} });
    await createEntrants(auth, div.id, Array.from({ length: 16 }, (_, i) => ({ kind: "individual", display_name: `E${i + 1}`, seed: i + 1, members: [] })) as never);
    const [src] = await createStages(auth, div.id, { seq: 1, kind: "knockout", name: "Source", config: source, progression: null });
    await createStages(auth, div.id, CreateStage.parse({ seq: 2, kind: "knockout", name: "Main", config: {}, progression: cut(from, to) }));
    return { auth, sourceId: src!.id };
  }

  it("Play-off -> Shared is refused when a cut of 1-3 would stop being a whole round, and nothing is written", async () => {
    const r = await cutRig({ thirdPlace: true }, 1, 3); // whole only with the play-off (RB4-Q2)
    const err = await refusal(patchKnockoutStage(r.auth, r.sourceId, { thirdPlace: "shared" }));
    expect([err.status, err.code]).toEqual([422, "KO_CUT_NOT_WHOLE_ROUND"]);
    expect(err.extra).toMatchObject({ from: 1, to: 3, width: 3 });
    expect((await configOf(r.sourceId)).thirdPlace, "still a play-off").toBe(true);
  }, 120_000);

  it("Play-off -> Shared is allowed when the cut is whole either way (1-4)", async () => {
    const r = await cutRig({ thirdPlace: true }, 1, 4);
    expect((await patchKnockoutStage(r.auth, r.sourceId, { thirdPlace: "shared" })).thirdPlace).toBe("shared");
    expect((await configOf(r.sourceId)).thirdPlace).toBe(false);
  }, 120_000);

  it("Shared -> Play-off is allowed and keeps a whole cut whole (1-4); a cut whole under Shared stays whole under the play-off", async () => {
    const r = await cutRig({}, 1, 4);
    expect((await patchKnockoutStage(r.auth, r.sourceId, { thirdPlace: "playoff" })).thirdPlace).toBe("playoff");
    expect((await configOf(r.sourceId)).thirdPlace).toBe(true);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("a fed knockout (a setup progression) redraws its placeholder lines for the new setting", () => {
  it("the Main stage fed by a league: Play-off adds the -3p line fed by its semi-finals, Shared takes it away", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "T9 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const div = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: declaredVariant("badminton", "bwf"), config: {} });
    await createEntrants(auth, div.id, Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `E${i + 1}`, seed: i + 1, members: [] })) as never);
    await createStages(auth, div.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    const [main] = await createStages(auth, div.id, CreateStage.parse({ seq: 2, kind: "knockout", name: "Main", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" } }));
    await generateStageFixtures(auth, main!.id);
    expect(await lineKeys(main!.id), "rig: four qualifiers, Shared").toEqual(engineBracketRows(4, false).map((x) => x.ext_key).sort());
    expect((await patchKnockoutStage(auth, main!.id, { thirdPlace: "playoff" })).regenerated).toBe(true);
    expect(await lineKeys(main!.id)).toEqual(engineBracketRows(4, true).map((x) => x.ext_key).sort());
    const bronze = await bronzeOf(main!.id);
    expect(bronze).toHaveLength(1);
    expect((await rowsOf(main!.id)).filter((x) => x.loser_to_fixture === bronze[0]!.id)).toHaveLength(2);
    expect((await patchKnockoutStage(auth, main!.id, { thirdPlace: "shared" })).regenerated).toBe(true);
    expect(await lineKeys(main!.id)).toEqual(engineBracketRows(4, false).map((x) => x.ext_key).sort());
  }, 180_000);
});

// I-1 (B4 fix round 1; X-TP-6, PO ruling): a fed knockout whose lines are SEATED (the league finished, the proposal confirmed) but
// whose first match has not started is still editable. THIRD_PLACE_LOCKED fires only once a match in the stage has started.
describe.skipIf(!HAS_DB)("I-1 a SEATED fed knockout stays editable until a match in it starts", () => {
  async function seatedMain() {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "I1 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const div = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    await createEntrants(auth, div.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `E${i + 1}`, seed: i + 1, members: [] })) as never);
    const stages = await createStages(auth, div.id, [
      { seq: 1, kind: "league", name: "League", config: {}, progression: null },
      CreateStage.parse({ seq: 2, kind: "knockout", name: "Main", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" } }),
    ] as never);
    const leagueId = stages.find((x) => x.kind === "league")!.id;
    const mainId = stages.find((x) => x.kind === "knockout")!.id;
    await generateStageFixtures(auth, mainId);
    await generateStageFixtures(auth, leagueId);
    for (const f of await rowsOf(leagueId)) {
      await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
      await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    }
    await completeStage(auth, leagueId);
    const [proposal] = await sql<{ id: string }[]>`select id from stage_seed_proposals where stage_id = ${mainId} and status = 'draft'`;
    await confirmSeedProposal(auth, mainId, { proposalId: proposal!.id });
    const rows = await rowsOf(mainId);
    expect(rows.filter((r) => r.home_entrant_id !== null || r.away_entrant_id !== null).length, "rig: the lines are SEATED").toBeGreaterThan(0);
    return { auth, mainId };
  }

  it("seated and unplayed: Play-off adds exactly one -3p line fed by both semi-finals, Shared takes it away; the seats stay", async () => {
    const { auth, mainId } = await seatedMain();
    const seatsBefore = (await rowsOf(mainId)).map((r) => [r.id, r.home_entrant_id, r.away_entrant_id]);
    const on = await patchKnockoutStage(auth, mainId, { thirdPlace: "playoff" });
    expect(on.thirdPlace).toBe("playoff");
    expect(await lineKeys(mainId), "the engine's Play-off bracket").toEqual(engineBracketRows(4, true).map((x) => x.ext_key).sort());
    const bronze = await bronzeOf(mainId);
    expect(bronze, "exactly one -3p line").toHaveLength(1);
    expect((await rowsOf(mainId)).filter((x) => x.loser_to_fixture === bronze[0]!.id), "fed by both semi-finals").toHaveLength(2);
    const seatsAfter = (await rowsOf(mainId)).filter((r) => r.id !== bronze[0]!.id).map((r) => [r.id, r.home_entrant_id, r.away_entrant_id]);
    expect(seatsAfter, "the confirmed draw is untouched").toEqual(seatsBefore);
    const off = await patchKnockoutStage(auth, mainId, { thirdPlace: "shared" });
    expect(off.thirdPlace).toBe("shared");
    expect(await lineKeys(mainId), "back to the Shared bracket").toEqual(engineBracketRows(4, false).map((x) => x.ext_key).sort());
    expect((await rowsOf(mainId)).filter((x) => x.loser_to_fixture !== null), "no loser edge into a line that is gone").toHaveLength(0);
    expect((await rowsOf(mainId)).map((r) => [r.id, r.home_entrant_id, r.away_entrant_id]), "the draw is still the same").toEqual(seatsBefore);
  }, 240_000);

  it("once a match in the stage has started the same PATCH is THIRD_PLACE_LOCKED, writing nothing", async () => {
    const { auth, mainId } = await seatedMain();
    const semi = (await rowsOf(mainId)).find((r) => r.round_no === 1 && r.home_entrant_id && r.away_entrant_id)!;
    await appendEvent(auth.orgId, semi.id, 0, { type: "core.start", payload: {} });
    const before = await lineKeys(mainId);
    const err = await refusal(patchKnockoutStage(auth, mainId, { thirdPlace: "playoff" }));
    expect([err.status, err.code]).toEqual([409, "THIRD_PLACE_LOCKED"]);
    expect(await lineKeys(mainId)).toEqual(before);
    expect((await configOf(mainId)).thirdPlace, "config untouched").not.toBe(true);
  }, 240_000);
});
