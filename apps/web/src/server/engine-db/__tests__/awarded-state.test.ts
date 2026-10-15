// R116-2 (W2b Task 16; owner ruling 116, T13 X-WO-1): ruling 116's walkover is recorded with NO event, so
// `awardedMatchState` writes the score beside it. "Like any other walkover": every sport, every cfg it declares, either
// seat withdrawn, its summary and decision must be exactly what the engine's fold of an ORDINARY withdrawal walkover
// gives the same fixture — a `core.forfeit{reason: "withdrew"}` before play, the event the withdrawal cascade records.
// The oracle is the engine folding a real stream, never `awardedMatchState` itself. The sweep is pure; the reset's clear
// needs real rows (skipped without DATABASE_URL).
import { afterAll, describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, summaryOf, type MatchOutcome } from "@seazn/engine/core";
import { resolvePositions, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { football } from "@seazn/engine/sports/football";
import { declaredCfgs, defaultLineupPair, forEachSport, makeEnvelope } from "@seazn/engine/testkit";
import { sql, withTenant } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { awardedMatchState, clearAwardedMatchState, writeAwardedMatchState } from "../awarded-state";
import { seedBracket } from "./helpers/seed-bracket";
import { omit } from "@/lib/omit";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe("R116-2: an award no event recorded shows what any withdrawal walkover shows", () => {
  it("every sport, every declared cfg, either seat: the summary and the decision are the ordinary walkover's fold", () => {
    let checked = 0;
    let credited = 0;
    const sports = new Set<string>();
    const uncredited = new Set<string>();
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const lineups = defaultLineupPair(resolvePositions(m, cfg as never));
        for (const by of ["home", "away"] as const) {
          const loser = lineups[by].entrantId;
          const winner = lineups[by === "home" ? "away" : "home"].entrantId;
          const what = `${m.key}/${name}: ${by} withdrew`;
          const walked = foldMatchWithStoppage(m, cfg as never, lineups, [
            makeEnvelope(1, { type: "core.forfeit", payload: { by: loser, reason: "withdrew" } }),
          ]);
          const outcome = outcomeOf(m, walked);
          expect(outcome, `${what}: premise, the ordinary walkover's decision`).toEqual({ kind: "award", winner, loser, reason: "withdrew" });
          const want = summaryOf(m, walked);
          const env = makeEnvelope(1, { type: "core.forfeit", payload: {} });
          const got = awardedMatchState(m, cfg, lineups, outcome as MatchOutcome, { fixtureId: env.fixtureId, recordedAt: env.recordedAt });
          expect(got.summary, `${what}: the summary`).toEqual(want);
          expect(got.state, `${what}: the state, in every detail`).toEqual(walked.state);
          // A walkover that credits a scoreline shows a non-zero line for the winner — so the sweep is not comparing two
          // empty summaries. Those that credit none are named below.
          if (want.perSide.some((p) => p.entrantId === winner && /[1-9]/.test(p.line))) credited++;
          else uncredited.add(m.key);
          sports.add(m.key);
          checked++;
        }
      }
    });
    expect(sports.size, "every builtin sport").toBe(builtinModules.length);
    expect(checked, "every declared cfg, both seats").toBeGreaterThanOrEqual(2 * builtinModules.length);
    expect(credited, "walkovers that credit a scoreline").toBeGreaterThan(checked / 2);
    // Appendix A: cricket's walkover is a scorecard result with no runs credited, generic's a W/O marker — every other
    // sport credits its walkover a score.
    expect([...uncredited].sort(), "the sports whose walkover credits no scoreline").toEqual(["cricket", "generic"]);
  });

  // single-sport: football — the three refusals are about the outcome handed in, before and after the module folds it.
  const cfg = football.configSchema.parse({});
  const lineups = defaultLineupPair(resolvePositions(football, cfg));
  const at = { fixtureId: "fx-r1162", recordedAt: "2026-10-12T00:00:00.000Z" };
  const H = lineups.home.entrantId;
  const A = lineups.away.entrantId;
  const fb = football as AnySportModule;

  it("refuses anything but an award: a win is decided by play, which no empty ledger holds", () => {
    const win = { kind: "win", winner: H, loser: A, method: "regulation" } as MatchOutcome;
    expect(() => awardedMatchState(fb, cfg, lineups, win, at)).toThrow(/a "win" is no award/);
  });

  it("refuses a bye: nobody lost to the advancing side, so there is no score to credit", () => {
    const bye = { kind: "award", winner: H, loser: null, reason: "bye" } as MatchOutcome;
    expect(() => awardedMatchState(fb, cfg, lineups, bye, at)).toThrow(/a bye credits no score/);
  });

  it("refuses an award the engine would not decide from these sides: the score would describe another result", () => {
    // The award names a winner who is neither side; the walkover over H folds to A's win.
    const foreign = { kind: "award", winner: "Z", loser: H, reason: "withdrew" } as MatchOutcome;
    expect(() => awardedMatchState(fb, cfg, lineups, foreign, at)).toThrow(/not the stored/);
    // …and the true award over the same sides is shown (the guard's positive pair).
    const award = { kind: "award", winner: A, loser: H, reason: "withdrew" } as MatchOutcome;
    expect(awardedMatchState(fb, cfg, lineups, award, at).summary.perSide).toHaveLength(2);
  });
});

describe.skipIf(!HAS_DB)("R116-2: a reset award takes its score with it, and only its own", () => {
  const rowOf = async (id: string) => (await sql<{ n: number }[]>`select count(*)::int as n from match_states where fixture_id = ${id}`)[0]!.n;
  const fullRow = async (id: string) =>
    (await sql<{ last_seq: number; state: unknown; summary: unknown; updated_at: Date }[]>`
      select last_seq, state, summary, updated_at from match_states where fixture_id = ${id}`)[0] ?? null;
  /** A seated tie of `s` stored as an award to its home side, its away side the loser, as the award's writer finds it. */
  const awardTo = async (id: string) => {
    const [f] = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
      select home_entrant_id, away_entrant_id from fixtures where id = ${id}`;
    const award = { kind: "award", winner: f!.home_entrant_id, loser: f!.away_entrant_id, reason: "withdrew" };
    await sql`update fixtures set status = 'forfeited', outcome = ${sql.json(award)} where id = ${id}`;
  };

  it("the award's ledger-less row goes; a fold of recorded events stays", async () => {
    // single-sport: boardgame — the clear reads the ledger, not the sport.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 4 });
    const [awarded, played] = s.fixtureIds as [string, string];
    // `awarded`: ruling 116's shape — her (away) seat empty, the award naming her, its score written beside it.
    const [f] = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
      select home_entrant_id, away_entrant_id from fixtures where id = ${awarded}`;
    const award = { kind: "award", winner: f!.home_entrant_id, loser: f!.away_entrant_id, reason: "withdrew" };
    await sql`update fixtures set away_entrant_id = null, status = 'forfeited', outcome = ${sql.json(award)} where id = ${awarded}`;
    await withTenant(s.auth.orgId, (tx) => writeAwardedMatchState(tx, awarded));
    // A second write over the row is a broken assumption (a reset that kept it), refused by name — never an overwrite.
    const [before] = await sql<{ summary: unknown }[]>`select summary from match_states where fixture_id = ${awarded}`;
    await expect(withTenant(s.auth.orgId, (tx) => writeAwardedMatchState(tx, awarded))).rejects.toThrow(/already holds a match state/);
    expect((await sql<{ summary: unknown }[]>`select summary from match_states where fixture_id = ${awarded}`)[0], "untouched").toEqual(before);
    // `played`: a recorded event, so its row is the fold of a ledger.
    await appendEvent(s.auth.orgId, played, 0, { type: "core.start", payload: {} });
    expect([await rowOf(awarded), await rowOf(played)], "premise: both carry a row").toEqual([1, 1]);
    const playedRow = await fullRow(played);
    await withTenant(s.auth.orgId, async (tx) => {
      await clearAwardedMatchState(tx, played);
      await clearAwardedMatchState(tx, awarded);
    });
    expect(await rowOf(played), "a fold of recorded events is the ledger's, and stays").toBe(1);
    expect(await fullRow(played), "untouched: a fold of play is never rewritten by a reset (Loop R M-17)").toEqual(playedRow);
    expect(await rowOf(awarded), "the award's own row goes").toBe(0);
    // A second clear finds nothing and refuses nothing (an idempotent reset).
    await withTenant(s.auth.orgId, (tx) => clearAwardedMatchState(tx, awarded));
    expect(await rowOf(awarded)).toBe(0);
  });

  // Loop R M-17 — single-sport: boardgame; the guard reads the fixture row, not the sport.
  it("Loop R M-17: a tie holding no award is refused by name — there is no score to write beside nothing", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 4 });
    const id = s.fixtureIds[0]!;
    await expect(withTenant(s.auth.orgId, (tx) => writeAwardedMatchState(tx, id))).rejects.toThrow(/is no award over a side that holds no seat/);
    expect(await rowOf(id), "nothing written").toBe(0);
    // The positive pair: the same tie, awarded, is written.
    await awardTo(id);
    await withTenant(s.auth.orgId, (tx) => writeAwardedMatchState(tx, id));
    expect(await rowOf(id)).toBe(1);
  });

  // Loop R M-17 — single-sport: boardgame; the writer and the clear read the ledger, not the sport (the every-sport
  // sweep of the sequence is withdrawn-winner-walkover.test.ts "Loop R M-17").
  it("Loop R M-17: over a recorded event no void took back, the award is refused by name; once the void takes it back, the award writes at the ledger's tip", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 4 });
    const id = s.fixtureIds[0]!;
    const start = await appendEvent(s.auth.orgId, id, 0, { type: "core.start", payload: {} });
    await awardTo(id);
    const before = await fullRow(id);
    await expect(withTenant(s.auth.orgId, (tx) => writeAwardedMatchState(tx, id))).rejects.toThrow(/1 recorded event\(s\) no void took back/);
    expect(await fullRow(id), "play is never overwritten").toEqual(before);
    // The positive pair: Undo takes the Start back (the status follows the fold, so the award is re-stored after it).
    await sql`update fixtures set status = 'in_play', outcome = null where id = ${id}`;
    await appendEvent(s.auth.orgId, id, start.seq, { type: "core.void", payload: {}, voids: start.event.id });
    await awardTo(id);
    await withTenant(s.auth.orgId, (tx) => writeAwardedMatchState(tx, id));
    expect((await fullRow(id))?.last_seq, "at the ledger's tip").toBe(2);
  });

  it("Loop R M-17: a reset over a ledger every void took back refuses a row that does not name the two sides it was folded over", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 4 });
    const id = s.fixtureIds[0]!;
    const start = await appendEvent(s.auth.orgId, id, 0, { type: "core.start", payload: {} });
    await appendEvent(s.auth.orgId, id, start.seq, { type: "core.void", payload: {}, voids: start.event.id });
    const takenBack = await fullRow(id);
    expect(takenBack?.last_seq, "premise: the take-back's row").toBe(2);
    await sql`update match_states set summary = jsonb_set(summary, '{perSide}', '[]'::jsonb) where fixture_id = ${id}`;
    await expect(withTenant(s.auth.orgId, (tx) => clearAwardedMatchState(tx, id))).rejects.toThrow(/names 0 side\(s\), not the two/);
    // The positive pair: the row as the take-back wrote it is put back as it was.
    await sql`update match_states set summary = ${sql.json(takenBack!.summary as never)} where fixture_id = ${id}`;
    await withTenant(s.auth.orgId, (tx) => clearAwardedMatchState(tx, id));
    const after = omit((await fullRow(id))!, "updated_at");
    const want = omit(takenBack!, "updated_at");
    expect(after, "the ledger's own fold over its own sides").toEqual(want);
  });
});
