// W2c Task 7, owner P-7 "A" (2026-10-13), rule X-AB-5: "An abandoned match in a Swiss stage holds the next round until
// the organiser settles it." Before this, an abandoned board stranded the stage: the next round refused (STAGE_NOT_READY,
// `abandoned` is not a decided status) and the settle that would unblock it was refused too (SETTLE_NOT_APPLICABLE
// not_bracket: the server allowed a settle in a bracket only). Now the board is named in the refusal and the organiser's
// settle decides it. Real Postgres (callers skip without DATABASE_URL); expected values come from the rule row, the
// engine's own declarations (builtinModules, DRAW_KINDS, SETTLE_METHODS) and the DB's own stored outcome - never from the
// code under test.
import { afterAll, describe, expect, it } from "vitest";
import { DRAW_KINDS, settledMethod } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { scoreEvent } from "@/server/usecases/scoring";
import { generateStageFixtures } from "@/server/usecases/stages";
import { seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Row = { id: string; status: string; outcome: { kind: string; method?: string; winner?: string } | null; home: string | null; away: string | null; round_no: number; seq_in_round: number };
const rowsOf = (stageId: string) =>
  sql<Row[]>`select id, status, outcome, home_entrant_id as home, away_entrant_id as away, round_no, seq_in_round
             from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const rowOf = async (id: string) => (await sql<Row[]>`select id, status, outcome, home_entrant_id as home, away_entrant_id as away, round_no, seq_in_round from fixtures where id = ${id}`)[0]!;
const seq = async (id: string) => (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: Parameters<typeof scoreEvent>[0], id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await seq(id), type, payload } as never);
type Refusal = { code: string; message: string; data: { stageId: string; abandoned?: { fixtureId: string; round: number; board: number }[] } };
/** What pressing "generate" on the stage is refused with, or null when it generated. */
const refusalOf = (auth: Parameters<typeof scoreEvent>[0], stageId: string) =>
  generateStageFixtures(auth, stageId).then(
    () => null,
    (e: unknown) => e as Refusal,
  );
/** Round-2 boards with both seats filled: zero until the next round is generated. */
const seatedRound2 = async (stageId: string) => (await rowsOf(stageId)).filter((r) => r.round_no === 2 && r.home !== null && r.away !== null).length;

const boardgameVariant = Object.keys(builtinModules.find((x) => x.key === "boardgame")!.variants)[0]!;

/** A four-entrant, two-round Swiss stage in `sport`: round 1 has two boards. Board A is walked over (a decided board, so
 *  exactly one board is in question); board B is started and then abandoned. */
async function swissWithAbandonedBoard(sport: string) {
  const m = builtinModules.find((x) => x.key === sport)!;
  const s = await seedBracket({ sport, variant: Object.keys(m.variants)[0]!, stageKind: "swiss", entrants: 4, stageConfig: { rounds: 2 } });
  const round1 = (await rowsOf(s.stageId)).filter((r) => r.round_no === 1 && r.home !== null && r.away !== null);
  expect(round1.length, `${sport}: rig - round 1 must have two seated boards`).toBe(2);
  const [a, b] = round1 as [Row, Row];
  await post(s.auth, a.id, "core.forfeit", { by: a.home, reason: "walkover" });
  expect((await rowOf(a.id)).status, `${sport}: rig - board A is decided by a walkover`).toBe("forfeited");
  await post(s.auth, b.id, "core.start");
  await post(s.auth, b.id, "core.abandon", { reason: "weather" });
  return { ...s, a, b, after: await rowOf(b.id) };
}

describe.skipIf(!HAS_DB)("X-AB-5 an abandoned board holds the next Swiss round until the organiser settles it", () => {
  it("X-AB-5 chess (the reported case): round 1 with one board abandoned - the next round refuses and names that board; the settle decides it; the next round generates", async () => {
    const t = await swissWithAbandonedBoard("boardgame");
    expect([t.after.status, t.after.outcome], "an abandoned chess game is nobody's result").toEqual(["abandoned", null]);
    // The refusal names the abandoned board - not a bare "undecided fixtures".
    const refusal = await refusalOf(t.auth, t.stageId);
    expect(refusal, "the next round must be refused").not.toBeNull();
    expect(refusal!.code).toBe("STAGE_NOT_READY");
    expect(refusal!.data.stageId).toBe(t.stageId);
    expect(refusal!.data.abandoned).toEqual([{ fixtureId: t.b.id, round: 1, board: t.b.seq_in_round }]);
    expect(refusal!.message).toContain(`round 1 board ${t.b.seq_in_round}`);
    expect(await seatedRound2(t.stageId), "the refused press seated nobody").toBe(0);
    // The organiser's settle decides the board...
    await post(t.auth, t.b.id, "core.settle", { winner: t.b.home, method: "organiser" });
    const settled = await rowOf(t.b.id);
    expect([settled.status, settled.outcome]).toEqual(["decided", { kind: "win", winner: t.b.home, loser: t.b.away, method: settledMethod("organiser") }]);
    // ...and the next round now generates.
    await generateStageFixtures(t.auth, t.stageId);
    expect(await seatedRound2(t.stageId), "round 2 is seated").toBeGreaterThan(0);
  }, 120_000);

  it("X-AB-5 a board merely in play holds the round as before and is not named; once abandoned it is named (chess, the sequence)", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: boardgameVariant, stageKind: "swiss", entrants: 4, stageConfig: { rounds: 2 } });
    const [a, b] = (await rowsOf(s.stageId)).filter((r) => r.round_no === 1 && r.home !== null && r.away !== null) as [Row, Row];
    await post(s.auth, a.id, "core.forfeit", { by: a.home, reason: "walkover" });
    await post(s.auth, b.id, "core.start");
    expect((await rowOf(b.id)).status, "rig: board B is in play").toBe("in_play");
    const inPlay = await refusalOf(s.auth, s.stageId);
    expect(inPlay, "an undecided board holds the round").not.toBeNull();
    // Exactly the refusal it always was: no abandoned list, the old words.
    expect([inPlay!.code, inPlay!.message, inPlay!.data]).toEqual(["STAGE_NOT_READY", "current swiss round has undecided fixtures", { stageId: s.stageId }]);
    await post(s.auth, b.id, "core.abandon", { reason: "weather" });
    const abandoned = await refusalOf(s.auth, s.stageId);
    expect(abandoned!.data.abandoned, "now it is named").toEqual([{ fixtureId: b.id, round: 1, board: b.seq_in_round }]);
    expect(abandoned!.message).toContain(`round 1 board ${b.seq_in_round}`);
  }, 120_000);

  it("X-AB-5 two abandoned boards are both named, in board order, whichever was abandoned first (chess, 6 entrants)", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: boardgameVariant, stageKind: "swiss", entrants: 6, stageConfig: { rounds: 2 } });
    const boards = (await rowsOf(s.stageId)).filter((r) => r.round_no === 1 && r.home !== null && r.away !== null);
    expect(boards.length, "rig: round 1 has three boards").toBe(3);
    const [first, middle, last] = boards as [Row, Row, Row];
    await post(s.auth, middle.id, "core.forfeit", { by: middle.home, reason: "walkover" });
    for (const board of [last, first]) {
      await post(s.auth, board.id, "core.start");
      await post(s.auth, board.id, "core.abandon", { reason: "weather" });
    }
    const refusal = await refusalOf(s.auth, s.stageId);
    expect(refusal!.data.abandoned!.map((x) => x.fixtureId), "ascending board order, not abandon order").toEqual([first.id, last.id]);
    expect(refusal!.message).toContain(`round 1 board ${first.seq_in_round}, round 1 board ${last.seq_in_round}`);
    // Settling one still leaves the other holding the round, and now only it is named.
    await post(s.auth, last.id, "core.settle", { winner: last.home, method: "organiser" });
    const one = await refusalOf(s.auth, s.stageId);
    expect(one!.data.abandoned).toEqual([{ fixtureId: first.id, round: 1, board: first.seq_in_round }]);
    await post(s.auth, first.id, "core.settle", { winner: first.home, method: "organiser" });
    expect(await refusalOf(s.auth, s.stageId), "both settled - the round generates").toBeNull();
  }, 120_000);

  it("X-AB-5 every sport: an abandoned board with no result holds the round and is named, settles, and unblocks it; a sport whose abandon already records a result never held it (counted)", async () => {
    let held = 0;
    let resultAtAbandon = 0;
    for (const m of builtinModules) {
      const t = await swissWithAbandonedBoard(m.key);
      if (t.after.outcome === null) {
        // The engine left nobody decided: the status is the stuck-and-visible `abandoned`, and the round waits.
        expect(t.after.status, `${m.key} abandoned`).toBe("abandoned");
        await expect(generateStageFixtures(t.auth, t.stageId), `${m.key}: the next round must wait`).rejects.toMatchObject({
          code: "STAGE_NOT_READY",
          data: { abandoned: [{ fixtureId: t.b.id }] },
        });
        expect(await seatedRound2(t.stageId), `${m.key}: nothing seated by the refusal`).toBe(0);
        // Sequence: settle, take the settle back (the board is abandoned again and the round waits again), settle again.
        await post(t.auth, t.b.id, "core.settle", { winner: t.b.away, method: "lot" });
        expect((await rowOf(t.b.id)).status, `${m.key} settled`).toBe("decided");
        await expect(post(t.auth, t.b.id, "core.settle", { winner: t.b.home, method: "organiser" }), `${m.key}: a second settle`).rejects.toMatchObject({
          code: "SETTLE_NOT_APPLICABLE",
        });
        const [settle] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${t.b.id} and type = 'core.settle'`;
        await post(t.auth, t.b.id, "core.void", { event_id: settle!.id });
        expect((await rowOf(t.b.id)).status, `${m.key} settle voided`).toBe("abandoned");
        await expect(generateStageFixtures(t.auth, t.stageId), `${m.key}: waits again after the void`).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
        await post(t.auth, t.b.id, "core.settle", { winner: t.b.away, method: "lot" });
        await generateStageFixtures(t.auth, t.stageId);
        expect(await seatedRound2(t.stageId), `${m.key}: round 2 seated after the settle`).toBeGreaterThan(0);
        held++;
      } else {
        // The abandon recorded a result (a shared-points no result in a draw kind): decided, the round never waited, and a
        // settle is still refused - it would turn a recorded result into a win.
        expect(t.after.status, `${m.key} abandoned with a result`).toBe("decided");
        await expect(post(t.auth, t.b.id, "core.settle", { winner: t.b.home, method: "organiser" }), `${m.key}: settle over a result`).rejects.toMatchObject({
          code: "SETTLE_NOT_APPLICABLE",
          data: { reason: "not_bracket" },
        });
        await generateStageFixtures(t.auth, t.stageId);
        expect(await seatedRound2(t.stageId), `${m.key}: round 2 seated`).toBeGreaterThan(0);
        resultAtAbandon++;
      }
    }
    const counted = `${held} held, ${resultAtAbandon} recorded a result, of ${builtinModules.length} sports`;
    expect(held, counted).toBeGreaterThan(0);
    expect(resultAtAbandon, counted).toBeGreaterThan(0); // both halves are reached, not one
    expect(held + resultAtAbandon, counted).toBe(builtinModules.length);
  }, 600_000);

  it("X-AB-5 no regression: in every table kind an abandoned board with no result is settleable, while a recorded draw is still refused (not_bracket)", async () => {
    let checked = 0;
    for (const kind of DRAW_KINDS) {
      const s = await seedBracket({
        sport: "generic",
        variant: "score",
        stageKind: kind,
        entrants: kind === "americano" ? 8 : 4,
        ...(kind === "swiss" ? { stageConfig: { rounds: 3 } } : {}),
        ...(kind === "americano" ? { stageConfig: { mode: "americano", courtCount: 2, rounds: 3 } } : {}),
      });
      const [abandoned, drawn] = [s.fixtureIds[0]!, s.fixtureIds[1]!];
      const a = await rowOf(abandoned);
      const d = await rowOf(drawn);
      await post(s.auth, abandoned, "core.start");
      await post(s.auth, abandoned, "core.abandon", { reason: "rain" });
      expect((await rowOf(abandoned)).status, `${kind} abandoned`).toBe("abandoned");
      await post(s.auth, abandoned, "core.settle", { winner: a.home, method: "organiser" });
      expect((await rowOf(abandoned)).outcome, `${kind} settled`).toMatchObject({ kind: "win", winner: a.home, method: settledMethod("organiser") });
      // The negative pair: nothing abandoned (no events, then in play, then an abandon that was voided) is not settleable,
      // and a recorded draw in the same stage is a result the table credits, and stays refused.
      const refused = (when: string) =>
        expect(post(s.auth, drawn, "core.settle", { winner: d.home, method: "organiser" }), `${kind} ${when}`).rejects.toMatchObject({
          code: "SETTLE_NOT_APPLICABLE",
          data: { reason: "not_bracket" },
        });
      await refused("nothing recorded");
      await post(s.auth, drawn, "core.start");
      await refused("in play");
      await post(s.auth, drawn, "core.abandon", { reason: "rain" });
      const [abandon] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${drawn} and type = 'core.abandon'`;
      await post(s.auth, drawn, "core.void", { event_id: abandon!.id });
      await refused("abandon voided");
      await post(s.auth, drawn, "generic.result", { p1Score: 1, p2Score: 1 });
      await expect(post(s.auth, drawn, "core.settle", { winner: d.home, method: "organiser" }), `${kind} draw`).rejects.toMatchObject({
        code: "SETTLE_NOT_APPLICABLE",
        data: { reason: "not_bracket" },
      });
      expect((await rowOf(drawn)).outcome, `${kind} draw stays`).toEqual({ kind: "draw" });
      checked++;
    }
    expect(checked).toBe(DRAW_KINDS.size);
    expect(checked).toBeGreaterThan(0);
  }, 300_000);
});
