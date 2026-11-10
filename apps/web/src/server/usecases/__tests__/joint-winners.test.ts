// W4 app B, B5a Task 12 (X-CH-4, X-CH-6; Q4): "Declare joint winners" on an unplayed final, and its Undo. Real Postgres,
// through the usecases the buttons call, then the public reads a spectator sees (C31: the seam is proven only when the
// division page, the hub, the OG card and the stage_completed event all name the same two winners).
//
// Expected values come from the rulebook rows (X-CH-4: places [1,1,3,3]; X-CH-6: where it is offered), never from the
// code under test.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import { CreateStage } from "@/server/api-v1/schemas";
import type { AuthCtx } from "@/server/api-v1/auth";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, heldFootball, playBadminton, post, rowsOf } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { divisionTitle } from "@/server/public-site/champion";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import { CompetitionHubDoc } from "@/server/public-site/competition-hub-schema";
import { getPublicDivision } from "@/server/public-site/data";
import { standingsCardModel } from "@/server/og/model";
import { bracketTitle } from "@seazn/engine/competition";
import { jointWinnersOffered } from "@/lib/joint-winners";
import { loadBracketFixtures } from "../stages/carry-over";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant, writeEntrantPatch } from "../entrants";
import { declareJointWinners, undoJointWinners } from "../joint-winners";
import { startDivision } from "../schedule";
import { completeStage, createStages, generateStageFixtures, getSeedProposal, getStandings } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { confirmResolvingTies } from "./_confirm-with-ties";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const BADMINTON = { sport: "badminton", variant: declaredVariant("badminton", "bwf") } as const;
const FOOTBALL_HELD = { sport: "football", variant: declaredVariant("football", "11-a-side"), stageRules: {} } as const;

interface Row {
  status: string;
  outcome: unknown;
  joint_winners_at: Date | null;
}
const jointRow = async (id: string): Promise<Row> =>
  (await sql<Row[]>`select status, outcome, joint_winners_at from fixtures where id = ${id}`)[0]!;
const stageStatus = async (id: string) => (await sql<{ status: string }[]>`select status from stages where id = ${id}`)[0]!.status;
const snapshots = async (stageId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from standings_snapshots where stage_id = ${stageId}`)[0]!.n;
const ledger = async (divisionId: string) =>
  (await sql<{ type: string; payload: Record<string, unknown> }[]>`select type, payload from division_events where division_id = ${divisionId} order by seq`);

async function finalOf(stageId: string) {
  const finals = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} and is_final and not third_place`;
  expect(finals, "rig: exactly one deciding final").toHaveLength(1);
  return fixtureRow(finals[0]!.id);
}

/** The ranks the stage's stored placement holds. */
async function ranks(auth: AuthCtx, stageId: string): Promise<number[]> {
  const snap = await getStandings(auth, stageId);
  const rows = snap.rows as { entrantId: string; rank: number }[];
  expect(rows.length, "anti-vacuity: the snapshot has rows").toBeGreaterThan(0);
  return rows.map((r) => r.rank).sort((a, b) => a - b);
}

/** A 4-entrant badminton knockout with both semis decided: the final is seated and unplayed. */
async function finalSeated() {
  const s = await seedBracket({ ...BADMINTON, stageKind: "knockout", entrants: 4 });
  const semis = (await rowsOf(s.stageId)).filter((r) => r.home_entrant_id && r.away_entrant_id);
  expect(semis, "rig: two seated semis").toHaveLength(2);
  for (const sf of semis) await playBadminton(s.auth, sf.id, true);
  const final = await finalOf(s.stageId);
  expect([final.home_entrant_id, final.away_entrant_id].every((x) => x !== null), "rig: both finalists seated").toBe(true);
  expect(final.status, "rig: the final is unplayed").toBe("scheduled");
  return { ...s, final };
}

describe.skipIf(!HAS_DB)("W4 B5a T12: declare joint winners (X-CH-4, X-CH-6)", () => {
  it("X-CH-4 declare on a scheduled final: the stage completes with places [1,1,3,3], the title is joint", async () => {
    const r = await finalSeated();
    const out = await declareJointWinners(r.auth, r.final.id);
    expect(out).toEqual({ fixture_id: r.final.id, stage_completed: true });
    const row = await jointRow(r.final.id);
    expect([row.status, row.outcome, row.joint_winners_at !== null]).toEqual(["decided", null, true]);
    expect(await stageStatus(r.stageId)).toBe("complete");
    // Rank places (X-CH-4 then the shared 3rd, X-TP-3): both finalists 1st, the semi losers level 3rd.
    expect(await ranks(r.auth, r.stageId)).toEqual([1, 1, 3, 3]);
    const types = (await ledger(r.divisionId)).map((e) => e.type);
    expect(types).toContain("joint_winners_declared");
    expect(types).toContain("stage_completed");
    // Nothing scored: the final holds no event.
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${r.final.id}`;
    expect(n).toBe(0);
  });

  it("X-CH-4 Undo: the final is scheduled again, the stage active, the snapshot gone, the title null; a second Undo is refused", async () => {
    const r = await finalSeated();
    await declareJointWinners(r.auth, r.final.id);
    expect(await snapshots(r.stageId), "premise: a snapshot was written").toBeGreaterThan(0);
    const out = await undoJointWinners(r.auth, r.final.id);
    expect(out).toEqual({ fixture_id: r.final.id, status: "scheduled" });
    const row = await jointRow(r.final.id);
    expect([row.status, row.outcome, row.joint_winners_at]).toEqual(["scheduled", null, null]);
    expect(await stageStatus(r.stageId)).toBe("active");
    expect(await snapshots(r.stageId)).toBe(0);
    await expect(undoJointWinners(r.auth, r.final.id)).rejects.toMatchObject({ code: "JOINT_WINNERS_NOT_DECLARED" });
    // The final plays on after the Undo: a real result crowns a champion.
    await playBadminton(r.auth, r.final.id, true);
    expect((await completeStage(r.auth, r.stageId)).completed || (await stageStatus(r.stageId)) === "complete").toBe(true);
    expect(await stageStatus(r.stageId)).toBe("complete");
    expect(await ranks(r.auth, r.stageId)).toEqual([1, 2, 3, 3]);
  });

  it("sequence: declare -> undo -> declare reads the SECOND ledger row; an unrelated Reinstate changes nothing", async () => {
    const r = await finalSeated();
    await declareJointWinners(r.auth, r.final.id);
    await undoJointWinners(r.auth, r.final.id);
    await declareJointWinners(r.auth, r.final.id);
    expect((await ledger(r.divisionId)).filter((e) => e.type === "joint_winners_declared")).toHaveLength(2);
    expect((await jointRow(r.final.id)).joint_winners_at).not.toBeNull();
    // An unrelated entrant (a semi loser) withdrawn then reinstated: the joint title stands, the snapshot is unchanged.
    const outsider = (await rowsOf(r.stageId)).find((x) => x.id !== r.final.id && x.home_entrant_id)!.away_entrant_id!;
    const before = await ranks(r.auth, r.stageId);
    await writeEntrantPatch(r.auth, outsider, { status: "withdrawn" });
    await patchEntrant(r.auth, outsider, { status: "confirmed" });
    expect(await ranks(r.auth, r.stageId)).toEqual(before);
    expect((await jointRow(r.final.id)).joint_winners_at, "the title stands").not.toBeNull();
    // Undo then reads the newest row and still restores scheduled.
    expect((await undoJointWinners(r.auth, r.final.id)).status).toBe("scheduled");
  });

  it("a withdrawal AFTER the declaration leaves the joint title standing", async () => {
    const r = await finalSeated();
    await declareJointWinners(r.auth, r.final.id);
    await withdrawEntrantCascade(r.auth, r.final.home_entrant_id!);
    const row = await jointRow(r.final.id);
    expect([row.status, row.outcome, row.joint_winners_at !== null], "no walkover rewrites a decided final").toEqual(["decided", null, true]);
    expect(await ranks(r.auth, r.stageId)).toEqual([1, 1, 3, 3]);
  });

  it("X-CH-6 offered on an abandoned final (settle still accepted before the declaration) and Undo restores it abandoned", async () => {
    const r = await finalSeated();
    await post(r.auth, r.final.id, "core.start");
    await post(r.auth, r.final.id, "core.abandon", { reason: "rain" });
    const held = await fixtureRow(r.final.id);
    expect([held.status, held.outcome], "premise: abandoned, decided nobody").toEqual(["abandoned", null]);
    expect(jointWinnersOffered({ ...held, is_final: true, third_place: false, joint_winners_at: null })).toBe(true);
    await declareJointWinners(r.auth, r.final.id);
    expect((await jointRow(r.final.id)).status).toBe("decided");
    const out = await undoJointWinners(r.auth, r.final.id);
    expect(out.status).toBe("abandoned");
    expect((await jointRow(r.final.id)).status, "the STORED status is restored, not just reported").toBe("abandoned");
    // The settle stays offered after the Undo (X-CH-5).
    await post(r.auth, r.final.id, "core.settle", { winner: held.home_entrant_id, method: "organiser" });
    expect((await fixtureRow(r.final.id)).outcome).toMatchObject({ winner: held.home_entrant_id });
  });

  it("X-CH-6 a held (needs_decision) final: declare rules it joint, Undo restores needs_decision with its draw outcome (football)", async () => {
    // single-sport: football reaches a held bracket line by play (0-0 FT, X-BR-2); badminton cannot be held.
    const s = await seedBracket({ ...FOOTBALL_HELD, stageKind: "knockout", entrants: 2 });
    const final = await finalOf(s.stageId);
    const held = await heldFootball(s.auth, final.id);
    await declareJointWinners(s.auth, final.id);
    const row = await jointRow(final.id);
    expect([row.status, row.outcome]).toEqual(["decided", null]);
    expect(await ranks(s.auth, s.stageId)).toEqual([1, 1]);
    const out = await undoJointWinners(s.auth, final.id);
    expect(out.status).toBe("needs_decision");
    const back = await jointRow(final.id);
    expect([back.status, back.outcome, back.joint_winners_at]).toEqual(["needs_decision", held.outcome, null]);
  });

  it("not offered: a semi-final, a third-place match, a decided final, a final already declared (each by its code)", async () => {
    const s = await seedBracket({ ...BADMINTON, stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    const rows = await sql<{ id: string; is_final: boolean; third_place: boolean; home_entrant_id: string | null }[]>`
      select id, is_final, third_place, home_entrant_id from fixtures where stage_id = ${s.stageId} order by round_no, seq_in_round`;
    const semi = rows.find((x) => !x.is_final && !x.third_place && x.home_entrant_id)!;
    const third = rows.find((x) => x.third_place)!;
    const final = rows.find((x) => x.is_final && !x.third_place)!;
    await expect(declareJointWinners(s.auth, semi.id), "a semi-final").rejects.toMatchObject({ code: "JOINT_WINNERS_NOT_A_FINAL" });
    await expect(declareJointWinners(s.auth, third.id), "a third-place match").rejects.toMatchObject({ code: "JOINT_WINNERS_NOT_A_FINAL" });
    // A TBD seat: the final before the semis are played.
    expect((await fixtureRow(final.id)).home_entrant_id, "premise: the final's seat is TBD").toBeNull();
    await expect(declareJointWinners(s.auth, final.id), "a TBD seat").rejects.toMatchObject({ code: "JOINT_WINNERS_NOT_A_FINAL" });
    // Nothing was written by any refusal.
    for (const x of [semi, third, final]) expect((await jointRow(x.id)).joint_winners_at).toBeNull();
    // A decided final.
    for (const sf of rows.filter((x) => !x.is_final && !x.third_place && x.home_entrant_id)) await playBadminton(s.auth, sf.id, true);
    await playBadminton(s.auth, final.id, true);
    await expect(declareJointWinners(s.auth, final.id), "a decided final").rejects.toMatchObject({ code: "JOINT_WINNERS_FINAL_DECIDED" });
    expect((await jointRow(final.id)).joint_winners_at).toBeNull();
    // anti-vacuity: the predicate itself says no to each non-final and yes to an open one.
    expect(jointWinnersOffered({ is_final: false, third_place: false, status: "scheduled", home_entrant_id: "a", away_entrant_id: "b", joint_winners_at: null })).toBe(false);
    expect(jointWinnersOffered({ is_final: true, third_place: true, status: "scheduled", home_entrant_id: "a", away_entrant_id: "b", joint_winners_at: null })).toBe(false);
    expect(jointWinnersOffered({ is_final: true, third_place: false, status: "scheduled", home_entrant_id: "a", away_entrant_id: null, joint_winners_at: null })).toBe(false);
    expect(jointWinnersOffered({ is_final: true, third_place: false, status: "decided", home_entrant_id: "a", away_entrant_id: "b", joint_winners_at: null })).toBe(false);
    expect(jointWinnersOffered({ is_final: true, third_place: false, status: "scheduled", home_entrant_id: "a", away_entrant_id: "b", joint_winners_at: "2030-01-01" })).toBe(false);
    expect(jointWinnersOffered({ is_final: true, third_place: false, status: "scheduled", home_entrant_id: "a", away_entrant_id: "b", joint_winners_at: null })).toBe(true);
  });

  it("a declared final refuses a second declaration (FINAL_DECIDED); a third-place match left unplayed keeps the stage open", async () => {
    const s = await seedBracket({ ...BADMINTON, stageKind: "knockout", entrants: 4, stageConfig: { thirdPlace: true } });
    for (const sf of (await rowsOf(s.stageId)).filter((x) => x.home_entrant_id && x.away_entrant_id)) await playBadminton(s.auth, sf.id, true);
    const final = await finalOf(s.stageId);
    const out = await declareJointWinners(s.auth, final.id);
    expect(out.stage_completed, "the third-place match is still owed a result").toBe(false);
    expect(await stageStatus(s.stageId)).toBe("active");
    await expect(declareJointWinners(s.auth, final.id)).rejects.toMatchObject({ code: "JOINT_WINNERS_FINAL_DECIDED" });
    // Undo on an active stage (nothing completed) restores the final without touching the stage.
    expect((await undoJointWinners(s.auth, final.id)).status).toBe("scheduled");
    expect(await stageStatus(s.stageId)).toBe("active");
  });

  it("D-G1: a final that decided nobody WITHOUT a joint ruling still refuses an unbeaten entrant; WITH it, both rank 1st", async () => {
    // Differential on the same rig: the joint ruling is what lets the stage rank two unbeaten finalists.
    const r = await finalSeated();
    await declareJointWinners(r.auth, r.final.id);
    expect(await stageStatus(r.stageId), "with the ruling the stage completes").toBe("complete");
    expect((await ranks(r.auth, r.stageId)).slice(0, 2)).toEqual([1, 1]);
    // Without it: a decided final with no winner and no ruling is refused by the guard (never a snapshot with a champion last).
    const q = await finalSeated();
    await sql`update fixtures set status = 'decided', outcome = null where id = ${q.final.id}`;
    await expect(completeStage(q.auth, q.stageId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await snapshots(q.stageId)).toBe(0);
  });

  it("C7: ruling joint then Undo leaves every public read answering (standings, division page, hub)", async () => {
    const r = await finalSeated();
    const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div from divisions d
        join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id where d.id = ${r.divisionId}`;
    await sql`update competitions set visibility = 'public' where id = ${r.competitionId}`;
    await declareJointWinners(r.auth, r.final.id);
    await undoJointWinners(r.auth, r.final.id);
    const data = await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div);
    expect(data, "the public division reads").not.toBeNull();
    expect(divisionTitle(data!.stages, data!.fixtures, data!.standings)).toBeNull();
    const hub = await loadCompetitionHub(slugs!.org, slugs!.comp, new Date(), { uncached: true });
    expect(hub, "the hub reads").not.toBeNull();
    expect(CompetitionHubDoc.safeParse(hub).success).toBe(true);
    expect(hub!.knockouts.every((k) => k.championFixtureId === null && k.title === null)).toBe(true);
    expect(hub!.knockouts.length, "anti-vacuity: the hub carries the bracket").toBeGreaterThan(0);
  });

  // I-3: after a declaration NO event may land on the final; the refusal is NAMED (409), never a bare 23514 / 500.
  it("I-3 a score event, a pad Undo and a settle on a final ruled joint are each refused FINAL_JOINT_WINNERS_DECLARED, nothing written", async () => {
    const r = await finalSeated();
    // In play (X-CH-6 offers it): the pad may be live when the organiser rules.
    await post(r.auth, r.final.id, "core.start");
    const [start] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${r.final.id} and type = 'core.start'`;
    await declareJointWinners(r.auth, r.final.id);
    const eventsBefore = (await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${r.final.id}`)[0]!.n;
    const refused = { code: "FINAL_JOINT_WINNERS_DECLARED", status: 409 };
    await expect(post(r.auth, r.final.id, "badminton.game.summary", { home: 21, away: 10 }), "a scorer's tap").rejects.toMatchObject(refused);
    await expect(post(r.auth, r.final.id, "core.void", { event_id: start!.id }), "a pad Undo").rejects.toMatchObject(refused);
    await expect(post(r.auth, r.final.id, "core.settle", { winner: r.final.home_entrant_id, method: "organiser" }), "a settle").rejects.toMatchObject(refused);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${r.final.id}`)[0]!.n, "nothing written").toBe(eventsBefore);
    const row = await jointRow(r.final.id);
    expect([row.status, row.outcome, row.joint_winners_at !== null], "the declaration stands").toEqual(["decided", null, true]);
    // After the Undo the final takes events again (the refusal is the declaration's, not a lock).
    await undoJointWinners(r.auth, r.final.id);
    await post(r.auth, r.final.id, "badminton.game.summary", { home: 21, away: 10 });
  });

  it("m-1 a decided semi-final is refused NOT_A_FINAL (the structure is asked before the result)", async () => {
    const s = await seedBracket({ ...BADMINTON, stageKind: "knockout", entrants: 4 });
    const semi = (await rowsOf(s.stageId)).find((x) => x.home_entrant_id && x.away_entrant_id)!;
    await playBadminton(s.auth, semi.id, true);
    await expect(declareJointWinners(s.auth, semi.id)).rejects.toMatchObject({ code: "JOINT_WINNERS_NOT_A_FINAL" });
  });

  it("m-3 both finalists out (a bare flip leaves the final open): the ruling is refused JOINT_WINNERS_FINALISTS_OUT; one out is still ruled", async () => {
    const r = await finalSeated();
    await writeEntrantPatch(r.auth, r.final.home_entrant_id!, { status: "withdrawn" });
    await writeEntrantPatch(r.auth, r.final.away_entrant_id!, { status: "withdrawn" });
    expect((await fixtureRow(r.final.id)).status, "premise: the bare flips left the final open").toBe("scheduled");
    await expect(declareJointWinners(r.auth, r.final.id)).rejects.toMatchObject({ code: "JOINT_WINNERS_FINALISTS_OUT" });
    expect((await jointRow(r.final.id)).joint_winners_at).toBeNull();
    await patchEntrant(r.auth, r.final.home_entrant_id!, { status: "confirmed" });
    // The pair is no longer both out: the ruling goes through (the positive pair).
    expect((await fixtureRow(r.final.id)).status).not.toBe("decided");
  });

  it("m-4 Undo while a finalist has withdrawn since the declaration is refused by name; after the Reinstate it restores", async () => {
    const r = await finalSeated();
    await declareJointWinners(r.auth, r.final.id);
    await withdrawEntrantCascade(r.auth, r.final.home_entrant_id!);
    await expect(undoJointWinners(r.auth, r.final.id)).rejects.toMatchObject({ code: "JOINT_WINNERS_UNDO_FINALIST_OUT" });
    expect((await jointRow(r.final.id)).joint_winners_at, "the joint title stands").not.toBeNull();
    await patchEntrant(r.auth, r.final.home_entrant_id!, { status: "confirmed" });
    expect((await undoJointWinners(r.auth, r.final.id)).status).toBe("scheduled");
  });

  // I-5: the carry-over reader (`loadBracketFixtures`) maps a joint final the way `toBracketFixture` does, and the ENGINE
  // reads it as the joint title through that mapping.
  it("I-5 loadBracketFixtures maps a joint final to the engine's jointWinners row; bracketTitle reads it joint", async () => {
    const r = await finalSeated();
    await declareJointWinners(r.auth, r.final.id);
    const rows = await sql.begin((tx) => loadBracketFixtures(tx as never, r.stageId));
    const mapped = rows.find((b) => b.id === r.final.id)!;
    expect([mapped.status, mapped.isFinal, mapped.jointWinners, mapped.winner, mapped.loser]).toEqual(["decided", true, true, undefined, undefined]);
    expect(bracketTitle(rows), "the engine crowns both seats through the carry-over mapping").toEqual({
      kind: "joint",
      winners: [r.final.home_entrant_id, r.final.away_entrant_id],
    });
    // Differential: every other row of the stage is mapped as before (no jointWinners on a played semi).
    expect(rows.filter((b) => b.jointWinners === true)).toHaveLength(1);
    await undoJointWinners(r.auth, r.final.id);
    const after = await sql.begin((tx) => loadBracketFixtures(tx as never, r.stageId));
    expect(after.some((b) => b.jointWinners === true), "Undo clears the mapping").toBe(false);
  });

  it("m-6 C7: getStandings (the provisional bracketRanks path) answers after Undo, and a joint ruled beside a withdrawn semi-loser reads on every public surface", async () => {
    const r = await finalSeated();
    const semiLoser = ((await rowsOf(r.stageId)).find((x) => x.id !== r.final.id && x.outcome)!.outcome as { loser: string }).loser;
    await declareJointWinners(r.auth, r.final.id);
    await undoJointWinners(r.auth, r.final.id);
    await expect(getStandings(r.auth, r.stageId), "the provisional ranks read after the Undo").resolves.toBeDefined();
    await writeEntrantPatch(r.auth, semiLoser, { status: "withdrawn" });
    await declareJointWinners(r.auth, r.final.id);
    const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div from divisions d
        join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id where d.id = ${r.divisionId}`;
    await sql`update competitions set visibility = 'public' where id = ${r.competitionId}`;
    expect(await ranks(r.auth, r.stageId)).toEqual([1, 1, 3, 3]);
    const data = await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div);
    expect(divisionTitle(data!.stages, data!.fixtures, data!.standings)).toMatchObject({ kind: "joint" });
    const hub = await loadCompetitionHub(slugs!.org, slugs!.comp, new Date(), { uncached: true });
    expect(CompetitionHubDoc.safeParse(hub).success).toBe(true);
  });
});

// C31: the seam is inert until a REAL final ruled joint reaches every public reader through the real producer.
const C31_SPORTS = [
  { sport: "badminton", kind: "individual" as const, variant: BADMINTON.variant },
  // I-4: a team sport - team entrants, `entrantKind: "team"` on the card, a different decider vocabulary.
  { sport: "football", kind: "team" as const, variant: declaredVariant("football", "11-a-side") },
];

/** A decided line for `winner` in the sport's own vocabulary (badminton straight games; football a 1-0). */
async function playWinner(auth: AuthCtx, sport: string, f: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }, winner: string): Promise<void> {
  if (sport === "badminton") {
    await playBadminton(auth, f.id, winner === f.home_entrant_id);
    return;
  }
  await post(auth, f.id, "core.start");
  await post(auth, f.id, "football.goal", { by: winner });
  await post(auth, f.id, "football.period", { phase: "HT" });
  await post(auth, f.id, "football.period", { phase: "FT" });
  const r = await fixtureRow(f.id);
  if (r.status !== "decided") throw new Error(`rig: football line did not decide (${r.status})`);
}

describe.skipIf(!HAS_DB)("W4 B5a T12 C31: a ruled joint final reaches the division page, the hub, the OG card and the event", () => {
  async function leagueKo(pick: (typeof C31_SPORTS)[number]) {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 T12 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: pick.sport,
      variant_key: pick.variant,
      config: {},
    });
    const made = await createEntrants(
      auth,
      division.id,
      Array.from({ length: 4 }, (_, i) => ({ kind: pick.kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
    );
    const drafts = buildTemplateStages("league_ko", { swissRounds: 5, poolCount: 2, legs: 1, qualified: 4 });
    const ids: string[] = [];
    for (const [i, d] of drafts.entries()) {
      const [stage] = await createStages(auth, division.id, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }));
      ids.push(stage!.id);
    }
    await startDivision(auth, division.id);
    await generateStageFixtures(auth, ids[1]!);
    // Play the league (the lower number wins), complete it, confirm the seeding.
    const num = (id: string) => Number(made.find((m) => m.id === id)!.display_name.slice(1));
    for (let guard = 0; guard < 20; guard++) {
      const open = (await rowsOf(ids[0]!)).filter((f) => f.home_entrant_id && f.away_entrant_id && f.status === "scheduled");
      if (open.length === 0) break;
      for (const f of open) await playWinner(auth, pick.sport, f, num(f.home_entrant_id!) < num(f.away_entrant_id!) ? f.home_entrant_id! : f.away_entrant_id!);
    }
    expect((await completeStage(auth, ids[0]!)).completed, "rig: the league completed").toBe(true);
    const p = await getSeedProposal(auth, ids[1]!);
    expect(p?.status, "rig: a draft proposal").toBe("draft");
    await confirmResolvingTies(auth, ids[1]!, p!.id);
    for (let guard = 0; guard < 6; guard++) {
      const open = (await rowsOf(ids[1]!)).filter((f) => f.home_entrant_id && f.away_entrant_id && f.status === "scheduled");
      const semis = open.filter((f) => f.winner_to_fixture !== null);
      if (semis.length === 0) break;
      for (const f of semis) await playWinner(auth, pick.sport, f, num(f.home_entrant_id!) < num(f.away_entrant_id!) ? f.home_entrant_id! : f.away_entrant_id!);
    }
    return { auth, comp, division, stageIds: [ids[0]!, ids[1]!] as const, names: new Map(made.map((m) => [m.id, m.display_name])) };
  }

  for (const pick of C31_SPORTS) it(`C31 acceptance (${pick.sport}): every public reader names BOTH winners; negatives refuse`, async () => {
    const r = await leagueKo(pick);
    const final = await finalOf(r.stageIds[1]);
    expect(final.status, "rig: the final is seated and unplayed").toBe("scheduled");
    const [a, b] = [final.home_entrant_id!, final.away_entrant_id!];
    const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div from divisions d
        join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id where d.id = ${r.division.id}`;
    await sql`update competitions set visibility = 'public' where id = ${r.comp.id}`;

    await declareJointWinners(r.auth, final.id);

    // 1. the division page: the final carries joint_winners_at, the title is joint [home, away].
    const data = await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div);
    expect(data).not.toBeNull();
    const pf = data!.fixtures.find((f) => f.id === final.id)!;
    expect(typeof pf.joint_winners_at, "an ISO string crosses the wire, never a Date").toBe("string");
    const title = divisionTitle(data!.stages, data!.fixtures, data!.standings);
    expect(title).toMatchObject({ kind: "joint" });
    expect(title && title.kind === "joint" ? [...title.winners].sort() : []).toEqual([a, b].sort());

    // 2. the hub: the title, the champion fixture, the schema, both table rows flagged.
    const hub = await loadCompetitionHub(slugs!.org, slugs!.comp, new Date(), { uncached: true });
    expect(hub).not.toBeNull();
    expect(CompetitionHubDoc.safeParse(hub).success, "the hub document parses").toBe(true);
    const ko = hub!.knockouts.find((k) => k.championFixtureId === final.id);
    expect(ko, "the hub's bracket is titled by the final").toBeTruthy();
    expect(ko!.title).toMatchObject({ kind: "joint" });
    const flagged = hub!.tables.flatMap((t) => t.rows).filter((row) => row.champion).map((row) => row.entrantId);
    expect(flagged.sort(), "both table rows are champion-flagged").toEqual([a, b].sort());

    // 3. the OG card names both, joint.
    const names = Object.fromEntries(r.names);
    const card = standingsCardModel({
      orgName: "o", competitionName: "c", divisionName: "d", logo: null, branding: [], youth: false, entrantKind: pick.kind, rules: null,
      rows: [], names, title,
    });
    expect(card.champion).toMatchObject({ joint: true });
    expect(card.champion!.name).toContain(names[a]!);
    expect(card.champion!.name).toContain(names[b]!);

    // 4. the stage_completed event's title equals the public title.
    const ev = (await ledger(r.division.id)).filter((e) => e.type === "stage_completed").at(-1)!;
    const evTitle = (ev.payload as { title?: { kind: string; winners?: string[] } }).title;
    expect(evTitle?.kind).toBe("joint");
    expect([...(evTitle?.winners ?? [])].sort()).toEqual([a, b].sort());

    // negatives: a joint final cannot be re-ruled; Undo then a real winner crowns a champion.
    await expect(declareJointWinners(r.auth, final.id)).rejects.toMatchObject({ code: "JOINT_WINNERS_FINAL_DECIDED" });
    await undoJointWinners(r.auth, final.id);
    await playWinner(r.auth, pick.sport, final, a);
    const after = await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div);
    expect(divisionTitle(after!.stages, after!.fixtures, after!.standings)).toMatchObject({ kind: "champion", champion: a });
    await expect(declareJointWinners(r.auth, final.id), "a final with a winner named").rejects.toMatchObject({ code: "JOINT_WINNERS_FINAL_DECIDED" });
  }, 300_000);
});
