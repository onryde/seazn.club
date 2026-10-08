// W2a Task 14 Step 1 (spec §5.6.1): the generator breadth the bracket-finish scenarios need — a level result held
// as needs_decision, an abandon at a real score, the organiser's settle, a chess tie-break, a carrom extra board.
// Every stream here is folded through the REAL engine (R15), and every expected value is read from the engine or
// from the rule rows (BG-KO-1, CA-KO-1, GN-KO-1, X-ST-1), never from the generator under test.
//
// Cfgs come from the harness's own resolver (variantKeys / resolveSportCfg: the preset merged under the overrides,
// parsed by the module's schema — how createDivision does it), not the engine's declaredCfgs: generic has no schema
// default, so a bare `parse({})` throws for it (preflight C7), and the resolver is the cfg the product folds under.
// Tests that fold core.settle / boardgame.tiebreak need loop D's engine (Tasks 4–5); until it is merged into this
// lane they are RED, by name — they are never satisfied by a stub.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, SETTLE_METHODS, foldMatchWithStoppage, isLevelOutcome, outcomeOf, type EventEnvelope } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { defaultLineupPair, forEachSport } from "@seazn/engine/testkit";
import type { AnySportModule } from "@seazn/engine/sport";
import { foldStream } from "../lib/fold.ts";
import { resolveSportCfg, stageCfg, variantKeys } from "../lib/sport-cfg.ts";
import { generateStream, levelReachable, matchesRequest, settleableOutcome } from "../lib/streams/index.ts";
import { carromGenerator } from "../lib/streams/carrom.ts";
import { genericGenerator } from "../lib/streams/generic.ts";
import { ALL_OUTCOMES, OutcomeUnreachable, START, outcomeLabel, type RequestedOutcome, type StreamEvent, type StreamRequest } from "../lib/streams/types.ts";

type Folded = ReturnType<typeof foldMatchWithStoppage>;

const envelopes = (events: readonly StreamEvent[]): EventEnvelope[] =>
  events.map((e, i) => ({ id: `e-${i + 1}`, fixtureId: "f", seq: i + 1, type: e.type, payload: e.payload, recordedAt: "2026-10-08T00:00:00Z", recordedBy: null }) as EventEnvelope);

interface Case { readonly key: string; readonly variant: string; readonly module: AnySportModule; readonly home: string; readonly away: string; readonly lineups: ReturnType<typeof defaultLineupPair> }

/** Every sport × every declared variant: the sweep unit. */
function cases(): Case[] {
  const out: Case[] = [];
  forEachSport(({ key, module }) => {
    const lineups = defaultLineupPair(module.positions);
    for (const variant of variantKeys(key)) out.push({ key, variant, module, home: lineups.home.entrantId, away: lineups.away.entrantId, lineups });
  });
  return out;
}

const request = (c: Case, cfg: unknown, stageKind: StreamRequest["stageKind"], outcome: RequestedOutcome): StreamRequest => ({ sportKey: c.key, cfg, stageKind, home: c.home, away: c.away, outcome });
const bracketCfg = (c: Case, overrides: Record<string, unknown> = {}): unknown => stageCfg(c.key, resolveSportCfg(c.key, c.variant, overrides), "knockout");
const fold = (c: Case, cfg: unknown, events: readonly StreamEvent[]): Folded => foldMatchWithStoppage(c.module, cfg as never, c.lineups, envelopes(events));
const outcomeAfter = (c: Case, cfg: unknown, events: readonly StreamEvent[]) => outcomeOf(c.module, fold(c, cfg, events));
const unreachable = (f: () => unknown): boolean => { try { f(); return false; } catch (e) { if (e instanceof OutcomeUnreachable) return true; throw e; } };

describe("W2a generator breadth (spec §5.6.1) — every stream folds through the REAL engine (R15)", () => {
  it("empty case first: the registries the sweeps iterate are not empty, and the sweep unit sees every sport", () => {
    expect(BRACKET_KINDS.size).toBeGreaterThan(0);
    expect(SETTLE_METHODS.length).toBeGreaterThan(0);
    expect(TIEBREAK_RUNGS.length).toBeGreaterThan(0);
    const all = cases();
    expect(new Set(all.map((c) => c.key)).size).toBe(11);
    expect(all.length).toBeGreaterThan(11); // more than one declared variant somewhere
  });

  it("every sport × variant × method: a bracket abandon at a real score, then settle, folds to a settled win", () => {
    let checked = 0;
    let withScore = 0; // sports whose win takes more than one event: the abandon must come after real play
    for (const c of cases()) {
      const cfg = bracketCfg(c);
      const win = generateStream(request(c, cfg, "knockout", { kind: "win", winner: "home" }));
      for (const method of SETTLE_METHODS) {
        const events = generateStream(request(c, cfg, "knockout", { kind: "settle", then: "away", method, after: "abandon" }));
        const where = `${c.key}/${c.variant} ${method}`;
        const abandonAt = events.findIndex((e) => e.type === "core.abandon");
        expect(abandonAt, where).toBeGreaterThanOrEqual(1); // at least core.start before it
        expect(events.at(-1)?.type, where).toBe("core.settle"); // the settle closes the stream
        expect(events.slice(0, abandonAt), where).toEqual(win.slice(0, abandonAt)); // the sport's own win stream, cut early
        if (win.length > 2) { // a win of more than START + its deciding event: something was played first
          expect(abandonAt, where).toBeGreaterThan(1);
          withScore++;
        }
        // Where it is cut is where the ENGINE says the win would have decided: undecided before, decided right after.
        expect(outcomeAfter(c, cfg, events.slice(0, abandonAt)), where).toBeNull();
        expect(outcomeAfter(c, cfg, win.slice(0, abandonAt + 1)), where).not.toBeNull();
        expect(outcomeAfter(c, cfg, events), where).toMatchObject({ kind: "win", winner: c.away, loser: c.home, method: `settled_${method}` });
        checked++;
      }
    }
    expect(checked).toBe(cases().length * SETTLE_METHODS.length);
    expect(withScore).toBeGreaterThan(0);
  });

  it("an abandon at score without a settle is the same cut stream, left abandoned; a plain abandon is unchanged", () => {
    let checked = 0;
    for (const c of cases()) {
      const cfg = bracketCfg(c);
      const atScore = generateStream(request(c, cfg, "knockout", { kind: "abandon", atScore: true }));
      expect(atScore.at(-1)?.type, c.key).toBe("core.abandon");
      expect(atScore.some((e) => e.type === "core.settle"), c.key).toBe(false);
      // The pre-W2a request: [START, core.abandon], byte for byte (committed plans replay it).
      expect(generateStream(request(c, cfg, "knockout", { kind: "abandon" })), c.key).toEqual([START, { type: "core.abandon", payload: { reason: "matrix: abandoned" } }]);
      checked++;
    }
    expect(checked).toBe(cases().length);
  });

  it("boardgame: a drawn bracket game followed by each rung, each side winning (ruling 82: the scorer records the winner)", () => {
    let checked = 0;
    for (const c of cases()) {
      if (c.key !== "boardgame") continue; // one-line reason: the tie-break is chess's (BG-KO-1)
      const cfg = bracketCfg(c);
      for (const rung of TIEBREAK_RUNGS) for (const winner of ["home", "away"] as const) {
        const events = generateStream(request(c, cfg, "knockout", { kind: "tiebreak", rung, winner }));
        const where = `${c.variant} ${rung} ${winner}`;
        // BG-KO-1: after the drawn game the match is NOT decided — it waits for the tie-break.
        expect(outcomeAfter(c, cfg, events.slice(0, -1)), where).toBeNull();
        const o = outcomeAfter(c, cfg, events);
        expect(o, where).toMatchObject({ kind: "win", winner: winner === "home" ? c.home : c.away, loser: winner === "home" ? c.away : c.home, method: `tiebreak_${rung}` });
        checked++;
      }
    }
    expect(checked).toBe(variantKeys("boardgame").length * TIEBREAK_RUNGS.length * 2);
    expect(checked).toBeGreaterThan(0);
  });

  it("boardgame, other sports: a tie-break needs the bracket overlay and a sport that has one (named refusals that reach them)", () => {
    const board = cases().find((c) => c.key === "boardgame")!;
    const bare = resolveSportCfg("boardgame", board.variant); // no overlay: a drawn game here is an ordinary draw
    expect((bare as { tiebreak?: boolean }).tiebreak).not.toBe(true);
    expect(unreachable(() => generateStream(request(board, bare, "knockout", { kind: "tiebreak", rung: "rapid", winner: "home" })))).toBe(true);
    let others = 0;
    for (const c of cases()) {
      if (c.key === "boardgame") continue;
      expect(unreachable(() => generateStream(request(c, bracketCfg(c), "knockout", { kind: "tiebreak", rung: "rapid", winner: "home" }))), `${c.key}/${c.variant}`).toBe(true);
      others++;
    }
    expect(others).toBe(cases().filter((c) => c.key !== "boardgame").length);
    expect(others).toBeGreaterThan(0);
  });

  it("carrom: a bracket win plays level games and the extra board — coins ≠ 9 (a value the old generator never emitted)", () => {
    let checked = 0;
    for (const c of cases()) {
      if (c.key !== "carrom") continue; // one-line reason: CA-KO-1 is carrom's
      for (const winner of ["home", "away"] as const) {
        // The division says tieBoard 'draw'; CA-KO-1: a bracket plays the extra board whatever it says.
        const division = resolveSportCfg(c.key, c.variant, { tieBoard: "draw" }) as { tieBoard: string };
        expect(division.tieBoard).toBe("draw");
        const cfg = stageCfg(c.key, division, "knockout") as { tieBoard: string };
        expect(cfg.tieBoard, c.variant).toBe("extra"); // the right answer differs from the division's constant
        const events = generateStream(request(c, cfg, "knockout", { kind: "win", winner }));
        const coins = events.filter((e) => e.type === "carrom.board.summary").map((e) => (e.payload as { opponentCoinsLeft: number }).opponentCoinsLeft);
        expect(coins.some((n) => n !== 9), c.variant).toBe(true);
        expect(coins.some((n) => n === 1), c.variant).toBe(true); // the extra board's single coin
        const f = fold(c, cfg, events);
        expect(outcomeOf(c.module, f), c.variant).toMatchObject({ kind: "win", winner: winner === "home" ? c.home : c.away });
        // Every game but the last was level after maxBoards and needed its extra board: none was drawn, none ended early.
        expect((f.state as { gamesDrawn: number }).gamesDrawn, c.variant).toBe(0);
        checked++;
      }
    }
    expect(checked).toBe(variantKeys("carrom").length * 2);
    expect(checked).toBeGreaterThan(0);
  });

  it("carrom: the same stream folds differently under the division's tieBoard 'draw' — so the overlay is what the generator is built for", () => {
    let checked = 0;
    for (const c of cases()) {
      if (c.key !== "carrom") continue; // one-line reason: CA-KO-1 is carrom's
      const division = resolveSportCfg(c.key, c.variant, { tieBoard: "draw" });
      const events = generateStream(request(c, stageCfg(c.key, division, "knockout"), "knockout", { kind: "win", winner: "home" }));
      const asDivision = fold(c, division, events); // the division's own rule: each level game is DRAWN
      expect((asDivision.state as { gamesDrawn: number }).gamesDrawn, c.variant).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(variantKeys("carrom").length);
  });

  it("carrom: a bracket win asked WITHOUT the overlay is refused by name (assumption is a guard), and a table stage keeps the straight nine-coin win", () => {
    let checked = 0;
    for (const c of cases()) {
      if (c.key !== "carrom") continue; // one-line reason: CA-KO-1 is carrom's
      const division = resolveSportCfg(c.key, c.variant, { tieBoard: "draw" });
      expect(unreachable(() => generateStream(request(c, division, "knockout", { kind: "win", winner: "home" }))), c.variant).toBe(true);
      const cfg = resolveSportCfg(c.key, c.variant);
      const table = generateStream(request(c, cfg, "league", { kind: "win", winner: "away" }));
      expect(table.filter((e) => e.type === "carrom.board.summary").every((e) => (e.payload as { opponentCoinsLeft: number }).opponentCoinsLeft === 9), c.variant).toBe(true);
      expect(outcomeAfter(c, cfg, table), c.variant).toMatchObject({ kind: "win", winner: c.away });
      checked++;
    }
    expect(checked).toBe(variantKeys("carrom").length);
  });

  it("carrom: tieBoard 'draw' in a table stage builds the drawn match (the old refusal is gone) and it folds to a draw", () => {
    let checked = 0;
    for (const c of cases()) {
      if (c.key !== "carrom") continue; // one-line reason: the drawn shape is carrom's tieBoard house rule
      const cfg = resolveSportCfg(c.key, c.variant, { tieBoard: "draw" });
      const events = generateStream(request(c, cfg, "league", { kind: "draw" }));
      expect(outcomeAfter(c, cfg, events), c.variant).toEqual({ kind: "draw" });
      checked++;
    }
    expect(checked).toBe(variantKeys("carrom").length);
  });

  it("level (spec §5.6.1): football, hockey, ice hockey and cricket fold a level bracket result (it will be held); no other sport can", () => {
    const LEVEL_SPORTS = new Set(["football", "hockey", "icehockey", "cricket"]); // spec §5.6.1 names these four
    let levelFolded = 0;
    let refused = 0;
    const reachedBySport = new Map<string, number>();
    for (const c of cases()) {
      const cfg = bracketCfg(c);
      const where = `${c.key}/${c.variant}`;
      if (!LEVEL_SPORTS.has(c.key)) {
        // setbased, tennis: no draw. carrom: the extra board. boardgame: the tie-break. generic: GN-KO-1.
        expect(unreachable(() => generateStream(request(c, cfg, "knockout", { kind: "level" }))), where).toBe(true);
        expect(levelReachable(c.key, cfg, "knockout"), where).toBe(false);
        refused++;
        continue;
      }
      if (!levelReachable(c.key, cfg, "knockout")) { refused++; continue; } // a cfg with a decider (shootout, super over) has no level
      const level = generateStream(request(c, cfg, "knockout", { kind: "level" }));
      const o = outcomeAfter(c, cfg, level);
      expect(o !== null && isLevelOutcome(o), `${where}: ${JSON.stringify(o)}`).toBe(true);
      // ... and the organiser's settle then wins it, by each method.
      for (const method of SETTLE_METHODS) {
        const settled = generateStream(request(c, cfg, "knockout", { kind: "settle", then: "home", method, after: "level" }));
        expect(settled.slice(0, -1), where).toEqual(level);
        expect(outcomeAfter(c, cfg, settled), `${where} ${method}`).toMatchObject({ kind: "win", winner: c.home, method: `settled_${method}` });
      }
      reachedBySport.set(c.key, (reachedBySport.get(c.key) ?? 0) + 1);
      levelFolded++;
    }
    expect(levelFolded).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    for (const k of LEVEL_SPORTS) expect(reachedBySport.get(k) ?? 0, `${k} has at least one variant that can end level`).toBeGreaterThan(0);
  });

  it("level follows the rules, not the sport: a cfg whose level full-time plays on (extra time, shootout, super over) has NO level result", () => {
    // Oracles from the rulebooks, not from the generator: football.ts resolveFullTime (:999-1024) plays level FT on
    // to extra time then a shootout; cricket decideTie (:935-946) opens a super over when it is on; a period sport
    // with overtime or a shootout is declared undrawable (period/kernel.ts supportsDraws).
    const rows: [string, string, Record<string, unknown>, boolean][] = [
      ["football", "11-a-side", {}, true],
      ["football", "11-a-side", { extraTime: { enabled: true, halfMinutes: 15 } }, false],
      ["football", "11-a-side", { shootout: true }, false],
      ["cricket", "t20", {}, true],
      ["cricket", "t20", { superOver: true }, false],
      ["cricket", "test", {}, true],
    ];
    let checked = 0;
    for (const [sport, variant, overrides, want] of rows) {
      const cfg = stageCfg(sport, resolveSportCfg(sport, variant, overrides), "knockout");
      expect(levelReachable(sport, cfg, "knockout"), `${sport}/${variant} ${JSON.stringify(overrides)}`).toBe(want);
      checked++;
    }
    // ... and every declared variant of the four, against the module's own declaration of whether FT can end level.
    for (const c of cases()) {
      if (!["hockey", "icehockey"].includes(c.key)) continue; // one-line reason: the period kernel's supportsDraws IS the rule (overtime/shootout null)
      const cfg = bracketCfg(c);
      expect(levelReachable(c.key, cfg, "knockout"), `${c.key}/${c.variant}`).toBe(c.module.supportsDraws(cfg as never, "league"));
      checked++;
    }
    expect(checked).toBeGreaterThan(rows.length);
  });

  it("level is a bracket request: in a table stage it is refused (a level result there is a draw or a tie)", () => {
    let checked = 0;
    for (const c of cases()) {
      expect(unreachable(() => generateStream(request(c, resolveSportCfg(c.key, c.variant), "league", { kind: "level" }))), `${c.key}/${c.variant}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(cases().length);
  });

  it("a draw asked of a bracket is refused at the gate even where the sport's generator could build one: supportsDraws is the engine's declaration, per sport × variant", () => {
    let gated = 0; // sports × variants whose generator builds a league draw but whose bracket declares no draws
    for (const c of cases()) {
      const league = resolveSportCfg(c.key, c.variant, { allowDraws: true });
      if (!c.module.supportsDraws(league as never, "league")) continue; // no league draw: nothing for the bracket gate to hold back
      const cfg = stageCfg(c.key, league, "knockout");
      expect(c.module.supportsDraws(cfg as never, "knockout"), `${c.key}/${c.variant}: the engine declares no bracket draw`).toBe(false);
      // the gate is generateStream's own: its message, not a generator's refusal
      expect(() => generateStream(request(c, cfg, "knockout", { kind: "draw" })), `${c.key}/${c.variant}`).toThrow(/supportsDraws/);
      gated++;
    }
    expect(gated).toBeGreaterThan(0);
  });

  it("each generator's own draw refusal, reached directly (generateStream's gate is not the only guard): generic in a bracket, carrom with the extra board", () => {
    let checked = 0;
    for (const c of cases()) {
      if (c.key === "generic") {
        const cfg = stageCfg(c.key, resolveSportCfg(c.key, c.variant, { allowDraws: true }), "knockout"); // one-line reason: GN-KO-1 is generic's
        expect(() => genericGenerator.decided({ ...request(c, cfg, "knockout", { kind: "draw" }), outcome: { kind: "draw" } }), c.variant).toThrow(/GN-KO-1/);
        // and the positive pair: the same generator builds a league draw
        expect(genericGenerator.decided({ ...request(c, resolveSportCfg(c.key, c.variant, { allowDraws: true }), "league", { kind: "draw" }), outcome: { kind: "draw" } }).length, c.variant).toBeGreaterThan(1);
        checked++;
      } else if (c.key === "carrom") {
        const extra = stageCfg(c.key, resolveSportCfg(c.key, c.variant), "knockout") as { tieBoard?: string };
        expect(extra.tieBoard, `${c.variant}: the overlay forces the extra board`).toBe("extra"); // one-line reason: CA-KO-1 is carrom's
        expect(() => carromGenerator.decided({ ...request(c, extra, "knockout", { kind: "draw" }), outcome: { kind: "draw" } }), c.variant).toThrow(/a level game plays an extra board/);
        const table = { ...(resolveSportCfg(c.key, c.variant) as object), tieBoard: "draw" };
        expect(carromGenerator.decided({ ...request(c, table, "league", { kind: "draw" }), outcome: { kind: "draw" } }).length, c.variant).toBeGreaterThan(1);
        checked++;
      }
    }
    expect(checked).toBe(variantKeys("generic").length + variantKeys("carrom").length);
    expect(checked).toBeGreaterThan(0);
  });

  it("generic in a bracket: winner-only results; a draw or a level request is OutcomeUnreachable (GN-KO-1), a league draw still builds", () => {
    let checked = 0;
    for (const c of cases()) {
      if (c.key !== "generic") continue; // one-line reason: GN-KO-1 is generic's
      const cfg = stageCfg(c.key, resolveSportCfg(c.key, c.variant, { allowDraws: true }), "knockout");
      expect(unreachable(() => generateStream(request(c, cfg, "knockout", { kind: "draw" }))), c.variant).toBe(true);
      expect(unreachable(() => generateStream(request(c, cfg, "knockout", { kind: "level" }))), c.variant).toBe(true);
      // The winner-only stream still decides, and the positive pair: a league fixture ends level as before.
      expect(outcomeAfter(c, cfg, generateStream(request(c, cfg, "knockout", { kind: "win", winner: "away" }))), c.variant).toMatchObject({ kind: "win", winner: c.away });
      const league = resolveSportCfg(c.key, c.variant, { allowDraws: true });
      expect(outcomeAfter(c, league, generateStream(request(c, league, "league", { kind: "draw" }))), c.variant).toEqual({ kind: "draw" });
      checked++;
    }
    expect(checked).toBe(variantKeys("generic").length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("W2a request vocabulary — labels, matching and the settle precondition", () => {
  it("empty case first: the closed sweep list of outcomes is unchanged (committed plans replay byte-identical)", () => {
    expect(ALL_OUTCOMES.map(outcomeLabel)).toEqual(["win-home", "win-away", "draw", "forfeit-away-walkover", "forfeit-home-retired", "abandon", "tie"]);
  });

  it("every new request has its own label, and none collides with an old one", () => {
    const fresh: RequestedOutcome[] = [
      { kind: "level" }, { kind: "abandon", atScore: true },
      { kind: "settle", then: "home", method: SETTLE_METHODS[0]!, after: "level" }, { kind: "settle", then: "away", method: SETTLE_METHODS[0]!, after: "level" },
      { kind: "settle", then: "home", method: SETTLE_METHODS[0]!, after: "abandon" }, { kind: "settle", then: "home", method: SETTLE_METHODS[1]!, after: "level" },
      { kind: "tiebreak", rung: TIEBREAK_RUNGS[0], winner: "home" }, { kind: "tiebreak", rung: TIEBREAK_RUNGS[1], winner: "home" }, { kind: "tiebreak", rung: TIEBREAK_RUNGS[0], winner: "away" },
    ];
    const labels = [...ALL_OUTCOMES, ...fresh].map(outcomeLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.length).toBeGreaterThan(ALL_OUTCOMES.length);
  });

  it("the settle precondition (X-ST-1, C12): a level outcome or no outcome settles; a win or an award does not", () => {
    const rows: [string, Parameters<typeof settleableOutcome>[0], boolean][] = [
      ["no outcome (an abandon with nothing decided)", null, true],
      ["draw", { kind: "draw" }, true], ["tie", { kind: "tie" }, true], ["no_result", { kind: "no_result" }, true],
      ["win", { kind: "win", winner: "a", loser: "b" } as never, false], ["award", { kind: "award", winner: "a" } as never, false],
    ];
    let checked = 0;
    for (const [name, outcome, want] of rows) { expect(settleableOutcome(outcome), name).toBe(want); checked++; }
    expect(checked).toBe(rows.length);
  });

  it("generateStream refuses a settle after an abandon the ENGINE decides as a win (X-ST-1, C12): a period sport whose cfg awards an abandon, over every sport × variant", () => {
    let awarding = 0; // cases whose abandon-at-score the engine folds to a win: the settle must be refused there
    let settling = 0; // cases whose abandon-at-score the engine leaves undecided or level: the settle must build
    for (const c of cases()) {
      // The cfg the engine KEEPS: a sport whose schema does not declare abandonPolicy drops the override, so this is its own answer.
      const cfg = stageCfg(c.key, resolveSportCfg(c.key, c.variant, { abandonPolicy: "award" }), "knockout");
      const cut = generateStream(request(c, cfg, "knockout", { kind: "abandon", atScore: true }));
      const folded = outcomeAfter(c, cfg, cut);
      const settleable = folded === null || isLevelOutcome(folded);
      const ask = (): unknown => generateStream(request(c, cfg, "knockout", { kind: "settle", then: "home", method: SETTLE_METHODS[0]!, after: "abandon" }));
      if (settleable) { expect(ask, `${c.key}/${c.variant}`).not.toThrow(); settling++; }
      else { expect(ask, `${c.key}/${c.variant}: the abandon folds to '${folded.kind}'`).toThrow(/core\.settle does not apply/); awarding++; }
    }
    expect(awarding, "some sport awards an abandon, or the guard is never reached").toBeGreaterThan(0);
    expect(settling).toBeGreaterThan(0);
    expect(awarding + settling).toBe(cases().length);
  });

  it("matchesRequest: level, settle and tiebreak are judged on their own facts; abandon at score stays unasserted", () => {
    const req = (outcome: RequestedOutcome): StreamRequest => ({ sportKey: "football", cfg: {}, stageKind: "knockout", home: "H", away: "A", outcome });
    const win = (winner: string, method?: string) => ({ kind: "win", winner, loser: winner === "H" ? "A" : "H", ...(method === undefined ? {} : { method }) }) as never;
    const rows: [string, RequestedOutcome, unknown, string][] = [
      ["level / draw", { kind: "level" }, { kind: "draw" }, "match"],
      ["level / tie", { kind: "level" }, { kind: "tie" }, "match"],
      ["level / no_result", { kind: "level" }, { kind: "no_result" }, "match"],
      ["level / win", { kind: "level" }, win("H"), "mismatch"],
      ["level / nothing", { kind: "level" }, null, "mismatch"],
      ["settle / its winner, its method", { kind: "settle", then: "home", method: "lot", after: "level" }, win("H", "settled_lot"), "match"],
      ["settle / the other winner", { kind: "settle", then: "home", method: "lot", after: "level" }, win("A", "settled_lot"), "mismatch"],
      ["settle / another method", { kind: "settle", then: "home", method: "lot", after: "level" }, win("H", "settled_organiser"), "mismatch"],
      ["settle / a plain win (no settle recorded)", { kind: "settle", then: "home", method: "lot", after: "level" }, win("H"), "mismatch"],
      ["tiebreak / its winner, its rung", { kind: "tiebreak", rung: "blitz", winner: "away" }, win("A", "tiebreak_blitz"), "match"],
      ["tiebreak / another rung", { kind: "tiebreak", rung: "blitz", winner: "away" }, win("A", "tiebreak_rapid"), "mismatch"],
      ["tiebreak / the other winner", { kind: "tiebreak", rung: "blitz", winner: "away" }, win("H", "tiebreak_blitz"), "mismatch"],
      ["abandon at score / whatever it folded to", { kind: "abandon", atScore: true }, null, "unasserted"],
    ];
    let checked = 0;
    for (const [name, outcome, folded, want] of rows) { expect(matchesRequest(req(outcome), folded as never), name).toBe(want); checked++; }
    expect(checked).toBe(rows.length);
  });

  it("levelReachable is answered by the generator: true where a level stream exists, false where it is refused, false outside a bracket", () => {
    const football = resolveSportCfg("football", variantKeys("football")[0]!);
    expect(levelReachable("football", football, "knockout")).toBe(true);
    expect(levelReachable("football", football, "league")).toBe(false); // not a bracket kind
    expect(levelReachable("tennis", resolveSportCfg("tennis", variantKeys("tennis")[0]!), "knockout")).toBe(false); // tennis ends no match level
    expect(() => levelReachable("no-such-sport", {}, "knockout")).toThrow(/no generator|no-such-sport/); // a defect is not "unreachable"
  });
});

// The sweep above folds each stream through foldMatchWithStoppage directly; this one pins that the HARNESS's own
// fold (lib/fold.ts, what decideFixture uses for parity) reads the same prefix the generator cut, so the two agree.
describe("the harness fold agrees with the engine fold on the abandon prefix", () => {
  it("foldStream of the cut prefix is undecided for every sport × variant", () => {
    let checked = 0;
    for (const c of cases()) {
      const cfg = bracketCfg(c);
      const events = generateStream(request(c, cfg, "knockout", { kind: "abandon", atScore: true }));
      expect(foldStream(c.module, cfg, c.home, c.away, events.slice(0, -1)).outcome, `${c.key}/${c.variant}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(cases().length);
  });
});
