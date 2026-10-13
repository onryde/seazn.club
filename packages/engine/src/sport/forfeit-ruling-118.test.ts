// W2b ruling 118 (2026-10-12, owner "A"; amends Appendix A X-RS-1, X-RT-1, X-PS-2 for chess): in chess, Start means
// play has begun. Seazn records no chess moves, so under rulings 113 and 115 a game in progress always read "nothing
// played": no retirement could be recorded, a forfeit during the game scored as a walkover, and the game counted in
// neither player's stats. The rule, chess only: after `core.start`, a retirement or a disqualification is a game
// played — it carries the result and both players' stats count it (X-PS-2). A no-show is still a walkover (chess
// admits one after the Start through its wider `walkoverPhases`, FIDE 6.7.1). Every other sport keeps rulings 113–115.
//
// "Chess" is read from the module's own declaration (`startIsPlay`), never a sport-key literal, and every expectation
// is the ruling's text: after the Start every reason is recordable (walkover by the wide phases, retired and
// disqualified by ruling 118, withdrew in any phase); a retirement or disqualification is a game for both players,
// W/L as decided; a walkover is no game. None is read back from the guard or the fold. Each sweep counts what it
// checked; zero checked is a failure.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, forfeitAdmission, outcomeOf, playRecorded, type EventEnvelope } from "../core/events.ts";
import { FORFEIT_REASONS, type LineupPair } from "../core/types.ts";
import { aggregatePlayerStats, playedInStats, type PlayerStatRow, type PlayerStatsFoldCtx } from "../stats/stats.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import type { AnySportModule } from "./module.ts";

const H = "H";
const A = "A";
type Step = { type: string; payload: unknown };
const seqd = (steps: readonly Step[]): EventEnvelope[] => steps.map((s, i) => makeEnvelope(i + 1, { type: s.type, payload: s.payload }));
const START: Step = { type: "core.start", payload: {} };
const forfeit = (by: string, reason: string): Step => ({ type: "core.forfeit", payload: { by, reason } });
const fold = (m: AnySportModule, cfg: unknown, l: LineupPair, steps: readonly Step[]) => foldMatchWithStoppage(m as never, cfg as never, l, seqd(steps));
const refusalOf = (f: () => unknown): EngineError | null => {
  try {
    f();
    return null;
  } catch (e) {
    if (EngineError.is(e)) return e;
    throw e;
  }
};

/** The modules whose Start is play — ruling 118's "chess", from each module's own declaration. */
const startIsPlay = (m: AnySportModule): boolean => m.startIsPlay === true;

/** A chess pairing card before the Start names each side's player (the "games" appearance reads it, W4). */
function pairing(l: LineupPair): Step {
  return { type: "boardgame.pairing", payload: { white: H, homePerson: l.home.slots[0]!.personId, awayPerson: l.away.slots[0]!.personId } };
}

function rowsOf(m: AnySportModule, cfg: unknown, l: LineupPair, events: readonly EventEnvelope[]): PlayerStatRow[] {
  const persons: Record<string, string[]> = { [H]: l.home.slots.map((s) => s.personId), [A]: l.away.slots.map((s) => s.personId) };
  const ctx: PlayerStatsFoldCtx = { entrants: [{ id: H, kind: "individual" }, { id: A, kind: "individual" }], personsOf: (id) => persons[id] ?? [], cfg };
  return aggregatePlayerStats(events, m.playerStats!, l, ctx);
}
const statOf = (rows: PlayerStatRow[], person: string, key: string): number => rows.find((r) => r.personId === person)?.stats[key] ?? 0;

/** Every chess scene: each module declaring `startIsPlay`, each of its declared cfgs, each side at fault. */
function chessScenes(): { m: AnySportModule; name: string; cfg: unknown; l: LineupPair; by: string; other: string }[] {
  const out: { m: AnySportModule; name: string; cfg: unknown; l: LineupPair; by: string; other: string }[] = [];
  for (const m of builtinModules) {
    if (!startIsPlay(m)) continue;
    const l = defaultLineupPair(m.positions);
    for (const { name, cfg } of declaredCfgs(m as never)) {
      out.push({ m, name, cfg, l, by: A, other: H }, { m, name, cfg, l, by: H, other: A });
    }
  }
  return out;
}

describe("ruling 118: in chess, Start means play has begun (X-RS-1, X-RT-1, X-PS-2 as amended)", () => {
  it("ruling 118: chess is read from a module declaration — exactly the board-game module declares startIsPlay", () => {
    expect(builtinModules.filter(startIsPlay).map((m) => m.key)).toEqual(["boardgame"]);
    expect(chessScenes().length, "chess scenes swept").toBeGreaterThan(2);
  });

  it("ruling 118's stats seam: every module declaring startIsPlay reads its forfeits through its OWN players'-stats `unplayed` — the shared fold asks playedInStats with the model alone, so a startIsPlay module without one would read its Start as nothing played", () => {
    // The assumption as a guard (TEST-STRATEGY): the shared fold holds only the model (`playedInStats(active, {
    // playerStats: model })`), whose default reading has no `startIsPlay` and so reads a bare Start as nothing played.
    // Chess passes itself (`statsUnplayed(events, boardgame, isGameResult)`); a future startIsPlay module must too, or
    // its DQ after the Start reads unplayed. Ruling 120's abandon half: sport/player-stats-ruling-120.test.ts.
    let checked = 0;
    for (const m of builtinModules.filter(startIsPlay)) {
      expect(typeof m.playerStats?.unplayed, `${m.key}: declares its own players'-stats unplayed`).toBe("function");
      const l = defaultLineupPair(m.positions);
      const dq = seqd([pairing(l), START, forfeit(A, "disqualified")]);
      expect(m.playerStats!.unplayed!(dq), `${m.key}: its unplayed reads the Start as play`).toBe(false);
      checked++;
    }
    expect(checked).toBe(1);
  });

  it("X-RS-1 + X-RT-1 (ruling 118): after a bare Start chess admits a retirement — the retiree loses, reason retired, and the console's admission offers every reason — every chess cfg, either side", () => {
    let checked = 0;
    for (const { m, name, cfg, l, by, other } of chessScenes()) {
      const label = `${m.key}/${name} retired by ${by}`;
      const prefix = [pairing(l), START];
      expect(playRecorded(seqd(prefix), m), `${label}: the Start is play`).toBe(true);
      const admission = forfeitAdmission(m as never, fold(m, cfg, l, prefix).state, { playRecorded: playRecorded(seqd(prefix), m) });
      expect(admission.reasons, `${label}: after the Start every reason is recordable`).toEqual([...FORFEIT_REASONS]);
      const f = fold(m, cfg, l, [...prefix, forfeit(by, "retired")]);
      expect(outcomeOf(m as never, f as never), label).toEqual({ kind: "award", winner: other, loser: by, reason: "retired" });
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });

  it("X-PS-2 (ruling 118): a retirement or a disqualification after a bare Start is a game both players played, W/L as decided — every chess cfg, either side", () => {
    let checked = 0;
    for (const { m, name, cfg, l, by, other } of chessScenes()) {
      const offender = (by === H ? l.home : l.away).slots[0]!.personId;
      const winner = (other === H ? l.home : l.away).slots[0]!.personId;
      for (const reason of ["retired", "disqualified"] as const) {
        const label = `${m.key}/${name} ${reason} by ${by}`;
        const steps = [pairing(l), START, forfeit(by, reason)];
        expect(() => fold(m, cfg, l, steps), `${label}: admitted`).not.toThrow();
        const events = seqd(steps);
        expect(playedInStats(events, m), `${label}: a game played (X-PS-2)`).toBe(true);
        const rows = rowsOf(m, cfg, l, events);
        for (const p of [offender, winner]) expect(statOf(rows, p, "games"), `${label}: ${p}'s games`).toBe(1);
        expect(statOf(rows, winner, "wins"), `${label}: the winner's win`).toBe(1);
        expect(statOf(rows, offender, "losses"), `${label}: the offender's loss`).toBe(1);
        expect(statOf(rows, offender, "wins") + statOf(rows, winner, "losses"), `${label}: no other result`).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("X-PS-1 + BG-WO-2 (ruling 118: a no-show is still a walkover): a walkover after the Start, or with no Start at all, is no game for either player — every chess cfg, either side", () => {
    let checked = 0;
    for (const { m, name, cfg, l, by, other } of chessScenes()) {
      const persons = [l.home.slots[0]!.personId, l.away.slots[0]!.personId];
      for (const [what, steps] of [
        ["after the Start", [pairing(l), START, forfeit(by, "walkover")]],
        ["with no Start", [pairing(l), forfeit(by, "walkover")]],
      ] as const) {
        const label = `${m.key}/${name} walkover by ${by} ${what}`;
        expect(outcomeOf(m as never, fold(m, cfg, l, steps) as never), label).toEqual({ kind: "award", winner: other, loser: by, reason: "walkover" });
        const events = seqd(steps);
        expect(playedInStats(events, m), `${label}: no game (X-PS-1)`).toBe(false);
        const rows = rowsOf(m, cfg, l, events);
        for (const p of persons) for (const key of ["games", "wins", "losses", "draws"]) expect(statOf(rows, p, key), `${label}: ${p} ${key}`).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("X-RS-1 (ruling 118 leaves it): before the Start a chess disqualification and a retirement are refused, as before — every chess cfg", () => {
    let checked = 0;
    for (const { m, name, cfg, l, by } of chessScenes()) {
      for (const reason of ["retired", "disqualified"] as const) {
        const e = refusalOf(() => fold(m, cfg, l, [pairing(l), forfeit(by, reason)]));
        expect(e?.code, `${m.key}/${name} ${reason} before the Start`).toBe("FORFEIT_REASON_WRONG_PHASE");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("X-RS-1 + X-RT-1 (rulings 113–115 stand elsewhere): [start, retired] is still refused in every other sport, and a bare Start is still nothing played — every declared cfg, either side", () => {
    let refused = 0;
    const others = new Set<string>();
    forEachSport(({ module: m }) => {
      if (startIsPlay(m)) return;
      others.add(m.key);
      const l = defaultLineupPair(m.positions);
      expect(playRecorded(seqd([START]), m), `${m.key}: a bare Start is not play`).toBe(false);
      for (const { name, cfg } of declaredCfgs(m as never)) {
        for (const by of [H, A]) {
          const e = refusalOf(() => fold(m, cfg, l, [START, forfeit(by, "retired")]));
          expect(e?.code, `${m.key}/${name} retired by ${by} after a bare Start`).toBe("FORFEIT_REASON_WRONG_PHASE");
          refused++;
        }
      }
    });
    expect(others.size, "every other sport").toBe(builtinModules.length - 1);
    expect(refused).toBeGreaterThan(2 * others.size - 1);
  });

  it("ruling 118 leaves both chess streams folding: the Start immediately before the game's result, and a no-show walkover with no Start — every chess cfg", () => {
    let checked = 0;
    for (const { m, name, cfg, l } of chessScenes()) {
      // The decisive game, as the board-game tests record it (boardgame.test.ts "decisive game").
      const result: Step = { type: "boardgame.result", payload: { winner: H, method: "checkmate" } };
      const played = fold(m, cfg, l, [START, result]);
      expect(outcomeOf(m as never, played as never), `${m.key}/${name}: start then ${result.type} decides`).toMatchObject({ kind: "win", winner: H, loser: A });
      const noShow = fold(m, cfg, l, [forfeit(A, "walkover")]);
      expect(outcomeOf(m as never, noShow as never), `${m.key}/${name}: the no-show`).toEqual({ kind: "award", winner: H, loser: A, reason: "walkover" });
      checked++;
    }
    expect(checked).toBeGreaterThan(1);
  });
});
