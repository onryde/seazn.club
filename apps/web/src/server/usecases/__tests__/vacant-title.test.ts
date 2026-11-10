// W4 app B, B5a Task 11 (X-CH-3; WD-CASC's vacant half): both finalists out -> the title is vacant automatically, nobody
// ranks 1st and both finalists rank 2nd; a Reinstate of a finalist reverses it (the one place ruling 271's "wait on the
// desk" yields: the finalist's seat was never taken, so nothing is placed). Real Postgres, through the usecases the
// buttons call (Withdraw, the PATCH, Complete) and the public read.
//
// How a final gets two departed finalists: a withdrawal after Start is a WALKOVER to the other finalist (X-CH-2) and
// settles the final, so the vacant title is reached by the bare status flip (ruling 111's self-withdrawal, which
// cascades nothing) of one finalist and the cascade of the other - the same order the W2b suite drives (X-WD-4).
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, playBadminton, post, rowsOf, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { divisionTitle } from "@/server/public-site/champion";
import { getPublicDivision } from "@/server/public-site/data";
import { patchEntrant, writeEntrantPatch } from "../entrants";
import { completeStage, getStandings } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// The sport registry rows a two-entrant final can be seeded for without play (the final is the draw). Football's held
// rig switches the extra time and penalties off (stageRules {}), as the W2b suite does.
const SPORTS = [
  { sport: "badminton", variant: declaredVariant("badminton", "bwf"), extra: {} },
  { sport: "football", variant: declaredVariant("football", "11-a-side"), extra: { stageRules: {} } },
  { sport: "boardgame", variant: declaredVariant("boardgame", "classical"), extra: {} },
] as const;

const activeEvents = async (fixtureId: string) =>
  (
    await sql<{ n: number }[]>`
      select count(*)::int as n from score_events e where e.fixture_id = ${fixtureId} and e.type <> 'core.void'
        and not exists (select 1 from score_events v where v.voids_event_id = e.id)`
  )[0]!.n;

async function finalOf(stageId: string): Promise<FixtureRow> {
  const finals = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} and is_final and not third_place`;
  expect(finals, "rig: exactly one deciding final").toHaveLength(1);
  return fixtureRow(finals[0]!.id);
}

/** The ranks the stage's stored placement holds, by entrant. */
async function ranksOf(auth: Parameters<typeof getStandings>[0], stageId: string): Promise<Map<string, number>> {
  const snap = await getStandings(auth, stageId);
  const rows = snap.rows as { entrantId: string; rank: number }[];
  expect(rows.length, "anti-vacuity: the snapshot has rows").toBeGreaterThan(0);
  return new Map(rows.map((r) => [r.entrantId, r.rank]));
}

/** Out by the bare flip (no cascade), then out by the cascade: the second departure is the trigger. */
async function bothOut(
  s: { auth: Parameters<typeof getStandings>[0] },
  first: string,
  second: string,
  secondAs: "withdrawn" | "disqualified" = "withdrawn",
): Promise<void> {
  await writeEntrantPatch(s.auth, first, { status: "withdrawn" });
  await withdrawEntrantCascade(s.auth, second, { as: secondAs });
}

describe.skipIf(!HAS_DB)("W4 B5a T11: both finalists out leaves the title vacant (X-CH-3)", () => {
  for (const sp of SPORTS) {
    it(`X-CH-3 both finalists withdraw: the final is a departure double walkover, both rank 2nd, nobody 1st (${sp.sport})`, async () => {
      // differential: today the final waits for settle (X-WD-4), nothing is written and Complete answers not finished.
      const s = await seedBracket({ sport: sp.sport, variant: sp.variant, stageKind: "knockout", entrants: 2, ...sp.extra });
      const final = await finalOf(s.stageId);
      const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
      await bothOut(s, a, b);
      const after = await fixtureRow(final.id);
      expect([after.status, after.outcome, after.home_entrant_id, after.away_entrant_id]).toEqual(["forfeited", { kind: "double_walkover" }, a, b]);
      expect(await activeEvents(final.id), "no event, as a bye is written").toBe(0);
      const done = await completeStage(s.auth, s.stageId);
      expect(done.completed, "no settle is asked: the stage completes").toBe(true);
      const ranks = await ranksOf(s.auth, s.stageId);
      // Rank places (X-CH-3, X-FR-1): both finalists 2nd, 1st vacant.
      expect([...ranks.values()].sort(), "nobody 1st, both 2nd").toEqual([2, 2]);
      expect(ranks.get(a)).toBe(2);
      expect(ranks.get(b)).toBe(2);
    });
  }

  it("X-CH-3 four entrants: the semi-final losers share 3rd behind the vacant title; the public title reads vacant", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    expect(semis, "rig: two seated semis").toHaveLength(2);
    for (const sf of semis) await playBadminton(s.auth, sf.id, true);
    const final = await finalOf(s.stageId);
    expect([final.home_entrant_id, final.away_entrant_id].every((x) => x !== null), "rig: both finalists seated").toBe(true);
    await bothOut(s, final.home_entrant_id!, final.away_entrant_id!);
    expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
    const ranks = await ranksOf(s.auth, s.stageId);
    // Rank places table: [2, 2, 3, 3] (X-CH-3 then the shared 3rd, X-TP-3).
    expect([...ranks.values()].sort()).toEqual([2, 2, 3, 3]);
    // The public read: the stage's final is a double walkover, so divisionTitle is vacant.
    const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div from divisions d
        join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id where d.id = ${s.divisionId}`;
    await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
    const data = await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div);
    expect(data, "the public division reads").not.toBeNull();
    expect(divisionTitle(data!.stages, data!.fixtures, data!.standings)).toMatchObject({ kind: "vacant" });
  });

  it("X-CH-3 a disqualification counts as out", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    await bothOut(s, final.home_entrant_id!, final.away_entrant_id!, "disqualified");
    expect((await fixtureRow(final.id)).outcome).toEqual({ kind: "double_walkover" });
  });

  it("X-CH-2 a single withdrawal is still a walkover to the other finalist (the second departure is the trigger)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    await withdrawEntrantCascade(s.auth, final.home_entrant_id!);
    const after = await fixtureRow(final.id);
    expect([after.status, after.outcome]).toEqual([
      "forfeited",
      { kind: "award", winner: final.away_entrant_id, loser: final.home_entrant_id, reason: "withdrew" },
    ]);
  });

  it("empty case: a final with one seat TBD and the seated finalist withdrawing stays X-WD-3's dead-seat walkover, never vacant", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    await playBadminton(s.auth, semis[0]!.id, true);
    const seated = (await fixtureRow(semis[0]!.id)).outcome as { winner: string };
    await withdrawEntrantCascade(s.auth, seated.winner);
    const final = await finalOf(s.stageId);
    expect(final.outcome?.kind, "no double walkover with a seat still TBD").not.toBe("double_walkover");
    expect(final.status).toBe("scheduled");
  });

  it("X-CH-3 only the deciding final goes vacant: a third-place match with both sides out stays open", async () => {
    const s = await seedBracket({
      sport: "badminton",
      variant: declaredVariant("badminton", "bwf"),
      stageKind: "knockout",
      entrants: 4,
      stageConfig: { thirdPlace: true },
    });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    for (const sf of semis) await playBadminton(s.auth, sf.id, true);
    const [bronze] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s.stageId} and third_place`;
    expect(bronze, "rig: a third-place match").toBeDefined();
    const b = await fixtureRow(bronze!.id);
    expect([b.home_entrant_id, b.away_entrant_id].every((x) => x !== null), "rig: both bronze seats filled").toBe(true);
    await bothOut(s, b.home_entrant_id!, b.away_entrant_id!);
    const after = await fixtureRow(b.id);
    expect([after.status, after.outcome], "the bronze match is Task 9's, not this task's").toEqual(["scheduled", null]);
  });

  it("X-CH-3 reinstating one finalist reverses it: a walkover to them, champion; reinstating the other re-opens the final", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await bothOut(s, a, b);
    expect((await fixtureRow(final.id)).outcome).toEqual({ kind: "double_walkover" });
    // The Reinstate door (ruling 271 sends every other knockout arrival to the desk flag; the final's seat was never taken).
    await patchEntrant(s.auth, a, { status: "confirmed" });
    const one = await fixtureRow(final.id);
    expect([one.status, one.outcome]).toEqual(["forfeited", { kind: "award", winner: a, loser: b, reason: "withdrew" }]);
    expect(await activeEvents(final.id)).toBe(0);
    const flagged = await sql<{ n: number }[]>`select count(*)::int as n from entrants where id = ${a} and knockout_waiting_stage_id is not null`;
    expect(flagged[0]!.n, "nothing is placed and nobody waits").toBe(0);
    expect((await completeStage(s.auth, s.stageId)).completed).toBe(true);
    expect((await ranksOf(s.auth, s.stageId)).get(a), "the reinstated finalist is champion").toBe(1);
    // the stage had completed with the walkover standing: reinstating the second re-opens the final AND the stage
    await patchEntrant(s.auth, b, { status: "confirmed" });
    const both = await fixtureRow(final.id);
    expect([both.status, both.outcome]).toEqual(["scheduled", null]);
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${s.stageId}`;
    expect(st!.status, "a completed stage whose final is open again is active").toBe("active");
    // Sequence: vacant -> reinstate -> vacant again (both out again by the same doors)
    await bothOut(s, a, b);
    expect((await fixtureRow(final.id)).outcome).toEqual({ kind: "double_walkover" });
  });

  it("X-CH-3 a reversal after the stage completed re-ranks its snapshot", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await bothOut(s, a, b);
    await completeStage(s.auth, s.stageId);
    expect([...(await ranksOf(s.auth, s.stageId)).values()]).toEqual([2, 2]);
    await patchEntrant(s.auth, a, { status: "confirmed" });
    const ranks = await ranksOf(s.auth, s.stageId);
    expect([ranks.get(a), ranks.get(b)], "re-ranked in the same transaction").toEqual([1, 2]);
    const [st] = await sql<{ status: string }[]>`select status from stages where id = ${s.stageId}`;
    expect(st!.status, "the stage stays complete").toBe("complete");
  });

  it("X-CH-3 a Reinstate of a NON-finalist is untouched by the revival (null) and still waits (app A, ruling 271)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 4 });
    const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
    await playBadminton(s.auth, semis[0]!.id, true);
    const loser = (await fixtureRow(semis[0]!.id)).outcome as { loser: string };
    await writeEntrantPatch(s.auth, loser.loser, { status: "withdrawn" });
    const before = await sql`select id, status, outcome from fixtures where stage_id = ${s.stageId} order by id`;
    await patchEntrant(s.auth, loser.loser, { status: "confirmed" });
    const after = await sql`select id, status, outcome from fixtures where stage_id = ${s.stageId} order by id`;
    expect(after, "no fixture moved").toEqual(before);
  });

  it("X-CH-3 the console's recorded double walkover on a final is still refused (X-DW-3 holds for a recorded one)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    await expect(post(s.auth, final.id, "core.forfeit", { by: "both", reason: "walkover" })).rejects.toBeDefined();
    expect((await fixtureRow(final.id)).status).toBe("scheduled");
  });

  it("X-CH-3 a reversal after the stage SEEDED another is refused by name (VACANT_TITLE_ALREADY_SEEDED)", async () => {
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    await bothOut(s, a, b);
    await completeStage(s.auth, s.stageId);
    // A later stage whose draw this stage's ranks filled: a confirmed seed proposal on it.
    const [next] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name, status, config)
      select division_id, org_id, 2, 'knockout', 'Next', 'pending', '{}'::jsonb from stages where id = ${s.stageId} returning id`;
    await sql`insert into stage_seed_proposals (org_id, stage_id, computed, status, confirmed_at)
              select org_id, ${next!.id}, '{}'::jsonb, 'confirmed', now() from stages where id = ${s.stageId}`;
    await expect(patchEntrant(s.auth, a, { status: "confirmed" })).rejects.toMatchObject({ status: 409, code: "VACANT_TITLE_ALREADY_SEEDED" });
    const [still] = await sql<{ status: string }[]>`select status from entrants where id = ${a}`;
    expect(still!.status, "the refusal rolled the Reinstate back").toBe("withdrawn");
    expect((await fixtureRow(final.id)).outcome).toEqual({ kind: "double_walkover" });
  });
});
