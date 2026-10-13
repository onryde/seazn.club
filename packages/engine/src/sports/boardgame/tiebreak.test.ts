import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { CoreSettle, deciderPending, foldMatch, foldMatchWithStoppage, outcomeOf, settleApplies, type EventEnvelope } from "../../core/events.ts";
import { mulberry32 } from "../../core/rng.ts";
import { evalPadGate } from "../../sport/module.ts";
import { aggregatePlayerStats, type PlayerStatsFoldCtx } from "../../stats/stats.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { generic } from "../generic/index.ts";
import { builtinModules } from "../index.ts";
import { ARMAGEDDON_RESULTS, boardgame, BoardgameArmageddon, BoardgameMethod, BoardgameRungTiebreak, BoardgameTiebreak, CHESS_SCORE, effectiveRungs, TIEBREAK_RUNGS, type TiebreakRung } from "./boardgame.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const lineups = defaultLineupPair(boardgame.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;
const ko = boardgame.configSchema.parse({ ...boardgame.bracketDeciders(boardgame.configSchema.parse({})) });
const league = boardgame.configSchema.parse({});
const drawn = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" })];
const fold = (cfg: unknown, events: EventEnvelope[]) => foldMatch(boardgame, cfg as never, lineups, events);
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };
/** W2c D7: a tie-break event on `rung` that advances `winner`. Rapid and blitz name the winner; an Armageddon records
 *  who had Black and the result (greenfield: `{rung, winner}` is no longer an Armageddon), so here Black is `winner`
 *  and Black won. */
const tieBreak = (seq: number, rung: TiebreakRung, winner: string): EventEnvelope =>
  ev(seq, "boardgame.tiebreak", rung === "armageddon" ? { rung, black: winner, result: "black" } : { rung, winner });
/** A bracket cfg with the stage's own tie-break rung list (W2c D8). The list is parsed by the module's own schema. */
const koWith = (rungs: readonly string[]) => boardgame.configSchema.parse({ ...boardgame.bracketDeciders(boardgame.configSchema.parse({})), tiebreakRungs: rungs });
/** An Armageddon: who had Black and how it ended (W2c D7). */
const arm = (seq: number, black: string, result: "white" | "black" | "draw") => ev(seq, "boardgame.tiebreak", { rung: "armageddon", black, result });
/** BG-KO-2, from the rule text and not from the module: White won -> the non-Black entrant advances; Black won or the
 *  Armageddon was drawn -> Black advances. Rapid and blitz name the entrant who advances. */
const advancerOf = (p: { rung: string; winner?: string; black?: string; result?: string }): string =>
  p.rung !== "armageddon" ? p.winner! : p.result === "white" ? (p.black === H ? A : H) : p.black!;
const errOf = (f: () => unknown): EngineError => {
  try { f(); } catch (e) { if (EngineError.is(e)) return e; throw e; }
  throw new Error("expected an EngineError refusal, got none");
};

describe("BG-KO-1 / BG-KO-2: the chess knockout tie-break (ruling 73)", () => {
  it("empty case first: without tiebreak in cfg a drawn game is an ordinary draw (golden-safe)", () => {
    expect("tiebreak" in league).toBe(false); // absent, never defaulted (finding 12)
    expect(boardgame.outcome(fold(league, drawn))).toEqual({ kind: "draw" });
  });

  it("BG-KO-1: with tiebreak, a drawn game opens phase 'tiebreak' with no outcome, and the summary keeps the level score", () => {
    const s = fold(ko, drawn);
    expect(s.phase).toBe("tiebreak");
    expect(boardgame.outcome(s)).toBeNull();
    expect(boardgame.summary(s).headline).toBe(boardgame.summary(fold(league, drawn)).headline); // ½ — ½, never "vs"
    expect((boardgame.summary(s).detail as { tiebreak?: unknown }).tiebreak).toStrictEqual({}); // pending: no rung yet
    // The positive pair: before the game is drawn the bracket board is undecided ("vs", the module's undecided
    // headline), and a league draw's detail carries no tie-break at all.
    const live = boardgame.summary(fold(ko, [ev(1, "core.start")]));
    expect(live.headline).toBe("vs");
    expect(live.perSide.map((p) => p.line)).toEqual(["", ""]);
    expect(Object.hasOwn(boardgame.summary(fold(league, drawn)).detail as object, "tiebreak")).toBe(false);
  });

  it("BG-DW-1 (W2b): a double forfeit folds to double_walkover in a bracket and a league alike, never a tie-break", () => {
    // W2b retires T15-R1's held `no_result`: both players absent is a double walkover — nobody advances, both lose.
    const df = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })];
    expect(boardgame.outcome(fold(ko, df))).toEqual({ kind: "double_walkover" });
    expect(boardgame.outcome(fold(league, df))).toEqual({ kind: "double_walkover" });
  });

  it("BG-KO-1 / BG-DW-1: only a game the league calls DRAWN enters the tie-break — a bracket double forfeit is a double walkover, awaitingDecider false; a new settle is refused, a legacy one replays (D6)", () => {
    // Every null-winner method (and the omitted one): in a bracket, a method whose league fold is a draw goes to
    // phase tiebreak; any other folds exactly as the league does. The ruling names the one other: double_forfeit.
    const methods: (string | undefined)[] = [...BoardgameMethod.options, undefined];
    let tiebreaks = 0;
    const held: string[] = [];
    let refused = 0;
    for (const method of methods) {
      const events = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, ...(method === undefined ? {} : { method }) })];
      // W2b (spec §5.2, f-w2): a single forfeit names its winner, so a null-winner "forfeit" is no result at all — the
      // schema refuses it in both kinds. (Before W2b it parsed and folded as a draw, then went to the tie-break.)
      if (method === "forfeit") {
        expect(codeOf(() => fold(league, events)), String(method)).toBe("INVALID_EVENT");
        expect(codeOf(() => fold(ko, events)), String(method)).toBe("INVALID_EVENT");
        refused++;
        continue;
      }
      const asLeague = fold(league, events);
      const asKo = fold(ko, events);
      const name = String(method);
      if (boardgame.outcome(asLeague)?.kind === "draw") {
        expect(asKo.phase, name).toBe("tiebreak");
        expect(boardgame.awaitingDecider!(asKo), name).toBe(true);
        tiebreaks++;
      } else {
        expect(asKo.phase, name).not.toBe("tiebreak");
        expect(asKo.tiebreak, name).toBeUndefined();
        expect(boardgame.outcome(asKo), name).toEqual(boardgame.outcome(asLeague));
        expect(boardgame.awaitingDecider!(asKo), name).toBe(false);
        held.push(name);
      }
    }
    expect(held).toEqual(["double_forfeit"]);
    expect(refused).toBe(1);
    expect(tiebreaks).toBe(methods.length - 2);
    // Decided, not held: no tie-break is accepted after it (ruling D-C7: TIEBREAK_NOT_APPLICABLE, spec §7), and a
    // NEW settle is refused (a double walkover is not level, X-BR-1). A settle recorded over one before W2b, when it
    // was a held no_result, still replays and wins (D6) — the non-strict fold below.
    const df = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })];
    expect(codeOf(() => fold(ko, [...df, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H })]))).toBe("TIEBREAK_NOT_APPLICABLE");
    const settle = ev(3, "core.settle", { winner: H, method: "organiser" });
    expect(codeOf(() => foldMatchWithStoppage(boardgame, ko as never, lineups, [...df, settle], { strictFromSeq: 3 }))).toBe("SETTLE_NOT_APPLICABLE");
    const settled = foldMatchWithStoppage(boardgame, ko as never, lineups, [...df, settle]);
    expect(outcomeOf(boardgame, settled)).toEqual({ kind: "win", winner: H, loser: A, method: "settled_organiser" });
  });

  it("BG-KO-1: each rung decides a win with method tiebreak_<rung>, and the summary still shows the level game", () => {
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const s = fold(ko, [...drawn, tieBreak(3, rung, A)]);
      expect(boardgame.outcome(s), rung).toEqual({ kind: "win", winner: A, loser: H, method: `tiebreak_${rung}` });
      expect(boardgame.summary(s).headline).toBe(boardgame.summary(fold(league, drawn)).headline);
      expect((boardgame.summary(s).detail as { tiebreak?: unknown }).tiebreak).toStrictEqual({ rung }); // no score key at all
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("BG-KO-1: a tiebreak outside phase 'tiebreak' is refused, per rung", () => {
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const refused = errOf(() => fold(ko, [ev(1, "core.start"), tieBreak(2, rung, H)]));
      expect(refused.code, rung).toBe("TIEBREAK_NOT_APPLICABLE");
      // The kernel's refusal (ruling D-C7), which names the refused event — the module's own phase guard below it is
      // the direct-apply backstop (testkit), pinned separately.
      expect(refused.data, rung).toMatchObject({ eventId: "e-2" });
      expect(refused.message, rung).toContain("boardgame.tiebreak");
      expect(codeOf(() => fold(league, [...drawn, tieBreak(3, rung, H)])), rung).toBe("TIEBREAK_NOT_APPLICABLE");
      // The module's own guard, reached only by direct apply: it names the phase it was refused in.
      const direct = errOf(() => boardgame.apply(fold(ko, [ev(1, "core.start")]), tieBreak(2, rung, H) as never));
      expect(direct.code, rung).toBe("TIEBREAK_NOT_APPLICABLE");
      expect(direct.message, rung).toContain('"live"');
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("BG-KO-1: a second tiebreak is refused (ruling D-C7: TIEBREAK_NOT_APPLICABLE)", () => {
    expect(codeOf(() => fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H }), ev(4, "boardgame.tiebreak", { rung: "blitz", winner: A })]))).toBe("TIEBREAK_NOT_APPLICABLE");
  });

  it("BG-KO-2 (ruling 82, D7): an Armageddon records Black and the result — either side can advance, whoever had Black, with or without division colours", () => {
    // W2a enforced BG-KO-2 by the pad's hint; W2c records the colour (spec §2.3). `colors: false` is a division switch
    // for the classical game's colour history; it never excuses an Armageddon from naming Black.
    const noColours = boardgame.configSchema.parse({ colors: false, tiebreak: true });
    let checked = 0;
    for (const cfg of [ko, noColours]) for (const winner of [H, A]) {
      const loser = winner === H ? A : H;
      for (const [black, result] of [[winner, "black"], [loser, "white"]] as const) {
        const s = fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", { rung: "armageddon", black, result })]);
        expect(boardgame.outcome(s), `black ${black === H ? "H" : "A"} ${result}`).toEqual({ kind: "win", winner, loser, method: "tiebreak_armageddon" });
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("the optional score is validated as a chess score", () => {
    for (const ok of ["1½–½", "2–0", "½–1½", "3–2"]) expect(CHESS_SCORE.test(ok), ok).toBe(true);
    for (const bad of ["1.5-0.5", "2-0", "", "–", "a–b", "1½–½ "]) expect(CHESS_SCORE.test(bad), bad).toBe(false);
    expect(codeOf(() => fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: A, score: "2-0" })]))).toBe("INVALID_EVENT");
    const s = fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: A, score: "1½–½" })]);
    expect((boardgame.summary(s).detail as { tiebreak?: unknown }).tiebreak).toStrictEqual({ rung: "rapid", score: "1½–½" });
  });

  it("C12: in phase tiebreak lots is the organiser's settle — settleApplies is true, a settle decides, and a later tiebreak is refused", () => {
    const pending = fold(ko, drawn);
    expect(settleApplies(boardgame, { outcome: boardgame.outcome(pending), abandoned: false, state: pending })).toBe(true);
    const settled = foldMatchWithStoppage(boardgame, ko as never, lineups, [...drawn, ev(3, "core.settle", { winner: A, method: "lot" })]);
    expect(outcomeOf(boardgame, settled)).toEqual({ kind: "win", winner: A, loser: H, method: "settled_lot" });
    expect(codeOf(() => foldMatchWithStoppage(boardgame, ko as never, lineups, [...drawn, ev(3, "core.settle", { winner: A, method: "lot" }), ev(4, "boardgame.tiebreak", { rung: "rapid", winner: H })]))).toBe("TIEBREAK_NOT_APPLICABLE");
    // The positive pair's negative: in phase "live" (nothing played) the same settle is refused.
    expect(settleApplies(boardgame, { outcome: null, abandoned: false, state: fold(ko, [ev(1, "core.start")]) })).toBe(false);
    expect(codeOf(() => foldMatchWithStoppage(boardgame, ko as never, lineups, [ev(1, "core.start"), ev(2, "core.settle", { winner: A, method: "lot" })]))).toBe("SETTLE_NOT_APPLICABLE");
  });

  it("ruling D-C5: once decided — by a settle in phase tiebreak, or by the tie-break itself — settle no longer applies and finalize is accepted; before it, settle applies and finalize is refused", () => {
    const run = (events: EventEnvelope[]) => foldMatchWithStoppage(boardgame, ko as never, lineups, events);
    const facts = (f: ReturnType<typeof run>) => ({ outcome: outcomeOf(boardgame, f), abandoned: false, state: f.state });
    // The positive pair: drawn, in phase tiebreak, nothing decided.
    const pending = run(drawn);
    expect(pending.state.phase).toBe("tiebreak");
    expect(settleApplies(boardgame, facts(pending))).toBe(true);
    expect(deciderPending(boardgame, pending)).toBe(true);
    expect(codeOf(() => run([...drawn, ev(3, "core.finalize")]))).toBe("WRONG_PHASE");
    // Settled by lot: the module phase is STILL "tiebreak" (the kernel owns the settle), yet nothing is pending.
    const lot = [...drawn, ev(3, "core.settle", { winner: A, method: "lot" })];
    const settled = run(lot);
    expect(settled.state.phase).toBe("tiebreak");
    expect(boardgame.awaitingDecider!(settled.state)).toBe(true); // the module alone cannot tell…
    expect(settleApplies(boardgame, facts(settled))).toBe(false); // …the effective outcome can
    expect(deciderPending(boardgame, settled)).toBe(false);
    expect(outcomeOf(boardgame, run([...lot, ev(4, "core.finalize")]))).toMatchObject({ kind: "win", winner: A, method: "settled_lot" });
    // Decided by the tie-break itself.
    const tb = [...drawn, ev(3, "boardgame.tiebreak", { rung: "blitz", winner: H })];
    const decided = run(tb);
    expect(settleApplies(boardgame, facts(decided))).toBe(false);
    expect(deciderPending(boardgame, decided)).toBe(false);
    expect(run([...tb, ev(4, "core.finalize")]).state.phase).toBe("final");
    // And the double forfeit (W2b BG-DW-1, retiring T15-R1's held no_result): a double walkover is decided and not
    // level, so settle does NOT apply, and no decider is pending.
    const df = run([ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })]);
    expect(settleApplies(boardgame, facts(df))).toBe(false);
    expect(deciderPending(boardgame, df)).toBe(false);
    // Nothing owed where nothing is pending: a live bracket game, and a module that declares no decider hook at all.
    expect(deciderPending(boardgame, run([ev(1, "core.start")]))).toBe(false);
    const gl = defaultLineupPair(generic.positions);
    const gcfg = generic.configSchema.parse(generic.variants.score);
    expect(deciderPending(generic, foldMatchWithStoppage(generic, gcfg as never, gl, [ev(1, "core.start")]))).toBe(false);
  });

  it("abandon in phase tiebreak is accepted and leaves the outcome null (closed by settle, X-ST-1)", () => {
    const s = fold(ko, [...drawn, ev(3, "core.abandon", { reason: "venue closed" })]);
    expect(s.phase).toBe("abandoned");
    expect(boardgame.outcome(s)).toBeNull();
  });

  it("ruling D-C7 (spec §7): boardgame.tiebreak is refused TIEBREAK_NOT_APPLICABLE whenever no decider is pending — before the game, while it is live, in a league, after a win, a settle, a tie-break, a double forfeit, an abandon or a finalize", () => {
    const run = (cfg: unknown, events: EventEnvelope[]) => foldMatchWithStoppage(boardgame, cfg as never, lineups, events);
    const tb = (seq: number) => ev(seq, "boardgame.tiebreak", { rung: "rapid", winner: H });
    const df = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })];
    const arms: [string, unknown, EventEnvelope[]][] = [
      ["before the game", ko, []],
      ["live", ko, [ev(1, "core.start")]],
      ["a league draw (no tie-break in cfg)", league, drawn],
      ["after a win", ko, [ev(1, "core.start"), ev(2, "boardgame.result", { winner: A, method: "resign" })]],
      ["after a settle in phase tiebreak", ko, [...drawn, ev(3, "core.settle", { winner: A, method: "lot" })]],
      ["after a tie-break (a second one)", ko, [...drawn, tb(3)]],
      ["after a double forfeit (a double walkover)", ko, df],
      ["after an abandon in phase tiebreak", ko, [...drawn, ev(3, "core.abandon", { reason: "venue closed" })]],
      ["after a finalize", ko, [...drawn, tb(3), ev(4, "core.finalize")]],
    ];
    let checked = 0;
    for (const [arm, cfg, prefix] of arms) {
      expect(deciderPending(boardgame, run(cfg, prefix)), arm).toBe(false); // the predicate the ruling names
      const refused = errOf(() => run(cfg, [...prefix, tb(prefix.length + 1)]));
      expect(refused.code, arm).toBe("TIEBREAK_NOT_APPLICABLE");
      expect(refused.data, arm).toMatchObject({ eventId: `e-${prefix.length + 1}` });
      checked++;
    }
    expect(checked).toBe(arms.length);
    // The positive pair: drawn in a bracket, the decider IS pending and the same event is accepted.
    expect(deciderPending(boardgame, run(ko, drawn))).toBe(true);
    expect(outcomeOf(boardgame, run(ko, [...drawn, tb(3)]))).toMatchObject({ kind: "win", winner: H, method: "tiebreak_rapid" });
  });

  it("R14 (W2b): a one-side forfeit while the tie-break is pending walks the other side over, reason kept; a double walkover there is refused — the classical game was played", () => {
    // W2b rewrites this pin. W2a refused every core.forfeit in phase "tiebreak" (WRONG_PHASE), so a tie-break no-show
    // could only be closed by a settle — finding N1, a silent hold. R14 admits one side's forfeit (FIDE Laws 6.7.1)
    // and refuses `both` (plan D3 R3).
    let checked = 0;
    for (const reason of ["walkover", "withdrew"] as const) {
      const f = foldMatchWithStoppage(boardgame, ko as never, lineups, [...drawn, ev(3, "core.forfeit", { by: H, reason })]);
      expect(outcomeOf(boardgame, f), reason).toEqual({ kind: "award", winner: A, loser: H, reason });
      expect(deciderPending(boardgame, f), reason).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
    const refused = errOf(() => foldMatchWithStoppage(boardgame, ko as never, lineups, [...drawn, ev(3, "core.forfeit", { by: "both", reason: "walkover" })]));
    expect(refused.code).toBe("FORFEIT_REASON_WRONG_PHASE");
    expect(refused.data).toMatchObject({ eventId: "e-3", phase: "tiebreak" });
    // The positive pair: the same forfeit while the game is live decides it the same way.
    expect(boardgame.outcome(fold(ko, [ev(1, "core.start"), ev(2, "core.forfeit", { by: H, reason: "walkover" })]))).toEqual({ kind: "award", winner: A, loser: H, reason: "walkover" });
  });

  it("review Minor 4: the tie-break winner is the same entrant-id schema core.settle names its winner with", () => {
    expect(BoardgameRungTiebreak.shape.winner).toBe(CoreSettle.shape.winner);
    expect(BoardgameArmageddon.shape.black).toBe(CoreSettle.shape.winner); // W2c: Black is an entrant, the same schema
    expect(BoardgameTiebreak.options).toEqual([BoardgameRungTiebreak, BoardgameArmageddon]); // the union is exactly these two shapes
  });

  it("ruling D-C6 (FIDE practice): a drawn bracket game counts as a DRAW in player stats even when a tie-break or a settle decides who advances; a won game credits the win", () => {
    // The decider settles ADVANCEMENT, not the game: the classical game stays drawn for both players.
    const ctx: PlayerStatsFoldCtx = {
      entrants: [{ id: H, kind: "individual" }, { id: A, kind: "individual" }],
      personsOf: (entrantId) => [`${entrantId}-p1`],
    };
    const statsOf = (events: EventEnvelope[]) => aggregatePlayerStats(events, boardgame.playerStats!, undefined, ctx);
    const drawForBoth = [{ personId: `${A}-p1`, stats: { draws: 1 } }, { personId: `${H}-p1`, stats: { draws: 1 } }];
    const byTiebreak = [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H })];
    expect(outcomeOf(boardgame, foldMatchWithStoppage(boardgame, ko as never, lineups, byTiebreak))).toMatchObject({ kind: "win", winner: H }); // it DID decide who advances
    expect(statsOf(byTiebreak)).toEqual(drawForBoth);
    const bySettle = [...drawn, ev(3, "core.settle", { winner: A, method: "lot" })];
    expect(outcomeOf(boardgame, foldMatchWithStoppage(boardgame, ko as never, lineups, bySettle))).toMatchObject({ kind: "win", winner: A });
    expect(statsOf(bySettle)).toEqual(drawForBoth);
    // The positive pair: a game won on the board credits the win and the loss.
    const won = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: H, method: "resign" })];
    expect(statsOf(won)).toEqual([{ personId: `${A}-p1`, stats: { losses: 1 } }, { personId: `${H}-p1`, stats: { wins: 1 } }]);
  });

  it("padSpec: unchanged for a cfg without tiebreak; with it, a tie-break panel gated on state.phase", () => {
    const plain = boardgame.padSpec!(league);
    expect(plain.panels.map((p) => p.gate)).toEqual(plain.panels.map(() => undefined));
    const withTb = boardgame.padSpec!(ko);
    const tb = withTb.panels.find((p) => p.actions.some((a) => a.type === "boardgame.tiebreak"));
    expect(tb?.gate).toEqual({ op: "path-equals", path: "state.phase", value: "tiebreak" });
    expect(withTb.fidelity["boardgame.tiebreak"]).toBe(0);
    // The labels are the dictionary contract (apps/web ui.json, ruling D-C4); the field and the attribution are the
    // tiebreak payload's own: `rung` over the engine's rungs, `winner` as a side.
    const action = tb!.actions.find((a) => a.type === "boardgame.tiebreak")!;
    expect(tb!.labelKey).toEqual({ key: "pad.boardgame.panel.tiebreak", label: "Tie-break" });
    expect(action.labelKey).toEqual({ key: "pad.boardgame.action.tiebreak", label: "Tie-break" });
    // Two actions of the one event type (W2c): rapid/blitz name the winner; an Armageddon names Black and the result.
    const timedRungs = TIEBREAK_RUNGS.filter((r) => r !== "armageddon");
    expect(action.fields).toEqual([{ kind: "enum", path: "rung", values: timedRungs }]);
    expect(action.attribution.map((i) => [i.kind, i.path, i.required])).toEqual([["side", "winner", true]]);
    const armageddon = tb!.actions.find((a) => a.type === "boardgame.tiebreak" && a !== action)!;
    expect(armageddon.fields).toEqual([
      { kind: "enum", path: "rung", values: ["armageddon"] },
      { kind: "enum", path: "result", values: ARMAGEDDON_RESULTS },
    ]);
    expect(armageddon.attribution.map((i) => [i.kind, i.path, i.required])).toEqual([["side", "black", true]]); // Confirm waits for Black
    expect(armageddon.labelKey).toEqual({ key: "pad.boardgame.action.armageddon", label: "Armageddon game" }); // the dictionary contract (apps/web ui.json)
    expect(tb!.actions).toHaveLength(2);
    // Behaviour, through the pad's own evaluator: a live bracket game offers the result panels, a drawn one only the
    // tie-break.
    const shown = (events: EventEnvelope[]) => {
      const s = fold(ko, events);
      return withTb.panels
        .filter((p) => p.phase === "live" && (p.gate === undefined || evalPadGate(p.gate, { state: s, summary: boardgame.summary(s) })))
        .map((p) => p.labelKey.key);
    };
    expect(shown([ev(1, "core.start")])).toEqual(["pad.boardgame.panel.result", "pad.boardgame.panel.draw"]);
    expect(shown(drawn)).toEqual(["pad.boardgame.panel.tiebreak"]);
  });

  it("BG-KO-3 padSpec: the pad offers only the stage's rungs, in the stage's order — an Armageddon action iff it is listed, and no tie-break panel for an empty list", () => {
    const actionsFor = (rungs: readonly string[]) =>
      boardgame.padSpec!(koWith(rungs)).panels.filter((p) => p.actions.some((a) => a.type === "boardgame.tiebreak")).flatMap((p) => p.actions);
    const timed = (rungs: readonly string[]) => actionsFor(rungs).filter((a) => a.fields[0]?.kind === "enum" && !a.fields[0].values.includes("armageddon"));
    const armageddonOf = (rungs: readonly string[]) => actionsFor(rungs).filter((a) => a.fields[0]?.kind === "enum" && a.fields[0].values.includes("armageddon"));
    let checked = 0;
    // [listed rungs, the timed rungs the pad offers (in order), whether the Armageddon action is offered]
    const cases: [readonly string[], readonly string[], boolean][] = [
      [["blitz", "rapid"], ["blitz", "rapid"], false], // order kept, not re-sorted
      [["armageddon", "rapid"], ["rapid"], true],
      [["rapid"], ["rapid"], false],
      [["armageddon"], [], true],
    ];
    for (const [rungs, offeredTimed, offersArmageddon] of cases) {
      const t = timed(rungs);
      expect(t.length, `${rungs}: the rapid/blitz action is present iff a timed rung is listed`).toBe(offeredTimed.length > 0 ? 1 : 0);
      if (offeredTimed.length > 0) expect(t[0]!.fields[0], rungs.join(",")).toEqual({ kind: "enum", path: "rung", values: offeredTimed });
      expect(armageddonOf(rungs).length, `${rungs}: the Armageddon action is present iff it is listed`).toBe(offersArmageddon ? 1 : 0);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // An empty list leaves nothing to record: no tie-break panel at all, and the result panels are not gated away from
    // the drawn game (it stays a draw, ruling 79).
    const empty = boardgame.padSpec!(koWith([]));
    expect(actionsFor([])).toEqual([]);
    expect(empty.panels.map((p) => p.gate)).toEqual(empty.panels.map(() => undefined));
  });

  it("BG-KO-1 generator: in phase tiebreak arbitraryEvent emits a tie-break the fold accepts — every rung, both winners, the score present and absent", () => {
    const pending = fold(ko, drawn);
    const seen = { rung: new Set<string>(), winner: new Set<string>(), score: new Set<string>(), black: new Set<string>(), result: new Set<string>() };
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const e = boardgame.arbitraryEvent!(pending, mulberry32(seed));
      expect(e?.type, `seed ${seed}`).toBe("boardgame.tiebreak");
      const p = e!.payload as Record<string, unknown>;
      if (Object.hasOwn(p, "score")) expect(typeof p.score, `seed ${seed}`).toBe("string"); // never an undefined key
      const o = boardgame.outcome(fold(ko, [...drawn, ev(3, e!.type, p)]));
      expect(o?.kind, `seed ${seed}`).toBe("win"); // accepted
      expect(o && o.kind === "win" && o.winner, `seed ${seed}: the advancer is the rulebook's`).toBe(advancerOf(p as never));
      seen.rung.add(String(p.rung));
      seen.winner.add(advancerOf(p as never));
      if (p.rung === "armageddon") {
        // The Armageddon shape: Black and the result, never a winner or a score.
        expect(Object.keys(p).sort(), `seed ${seed}`).toEqual(["black", "result", "rung"]);
        seen.black.add(String(p.black));
        seen.result.add(String(p.result));
      } else seen.score.add(typeof p.score === "string" ? p.score : "(none)");
      checked++;
    }
    expect(checked).toBe(200);
    expect([...seen.rung].sort()).toEqual([...TIEBREAK_RUNGS].sort());
    expect([...seen.winner].sort()).toEqual([A, H].sort());
    expect([...seen.black].sort()).toEqual([A, H].sort());
    expect([...seen.result].sort()).toEqual(["black", "draw", "white"]);
    expect(seen.score.has("(none)")).toBe(true);
    expect(seen.score.size).toBeGreaterThanOrEqual(3); // absent, and at least two distinct chess scores
  });

  it("W2c generator: it offers only the rungs the stage lists — a one-rung list emits that rung every time", () => {
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const cfg = koWith([rung]);
      const pending = fold(cfg, drawn);
      for (let seed = 1; seed <= 40; seed++) {
        const e = boardgame.arbitraryEvent!(pending, mulberry32(seed));
        expect((e!.payload as { rung: string }).rung, `${rung} seed ${seed}`).toBe(rung);
        expect(boardgame.outcome(fold(cfg, [...drawn, ev(3, e!.type, e!.payload)]))?.kind, `${rung} seed ${seed}`).toBe("win");
        checked++;
      }
    }
    expect(checked).toBe(TIEBREAK_RUNGS.length * 40);
  });

  it("rule 10: any sequence of results, tie-breaks, settles, abandons, finalizes and void-last in a bracket keeps the invariants after every step", () => {
    // Invariants after every step: (a) a bracket game never folds to a draw; (b) phase tiebreak ⇔ awaitingDecider, and
    // there the module decides nothing — the outcome is a settle's or none; (c) a tie-break win names the last active tie-break's rung and winner; (d) a refused
    // step leaves the fold byte-equal, with a code from the closed set below; (e) a finalize is accepted iff the
    // effective outcome (outcomeOf) is non-null — refused WRONG_PHASE otherwise (the kernel rule; the bracket's
    // LEVEL_RESULT_IN_BRACKET is the server's, loop F); (f) a tie-break is accepted iff deciderPending — refused
    // TIEBREAK_NOT_APPLICABLE otherwise (ruling D-C7).
    const REFUSALS = new Set(["TIEBREAK_NOT_APPLICABLE", "ALREADY_DECIDED", "SETTLE_NOT_APPLICABLE", "WRONG_PHASE"]);
    const step = fc.oneof(
      fc.record({ k: fc.constant("draw" as const), method: fc.constantFrom("agreement", "stalemate", "double_forfeit") }),
      fc.record({ k: fc.constant("win" as const), side: fc.constantFrom(H, A) }),
      fc.record({ k: fc.constant("tiebreak" as const), rung: fc.constantFrom(...TIEBREAK_RUNGS), side: fc.constantFrom(H, A), result: fc.constantFrom("white", "black", "draw") }),
      fc.record({ k: fc.constant("settle" as const), side: fc.constantFrom(H, A) }),
      fc.constant({ k: "abandon" as const }),
      fc.constant({ k: "finalize" as const }),
      fc.constant({ k: "voidLast" as const }),
    );
    const live = (events: readonly EventEnvelope[]) => events.filter((e) => e.type !== "core.void" && !events.some((v) => v.voids === e.id));
    const counts = { steps: 0, refused: 0, tiebreakWins: 0, pending: 0, finalized: 0, finalizeRefused: 0, tiebreakRefused: 0 };
    fc.assert(fc.property(fc.array(step, { maxLength: 10 }), (steps) => {
      const events: EventEnvelope[] = [ev(1, "core.start")];
      const run = (es: EventEnvelope[]) => foldMatchWithStoppage(boardgame, ko as never, lineups, es);
      for (const s of steps) {
        const seq = events.length + 1;
        const candidate =
          s.k === "draw" ? ev(seq, "boardgame.result", { winner: null, method: s.method })
          : s.k === "win" ? ev(seq, "boardgame.result", { winner: s.side, method: "resign" })
          : s.k === "tiebreak" ? ev(seq, "boardgame.tiebreak", s.rung === "armageddon" ? { rung: s.rung, black: s.side, result: s.result } : { rung: s.rung, winner: s.side })
          : s.k === "settle" ? ev(seq, "core.settle", { winner: s.side, method: "lot" })
          : s.k === "abandon" ? ev(seq, "core.abandon", { reason: "r" })
          : s.k === "finalize" ? ev(seq, "core.finalize")
          : (() => { const t = live(events).at(-1); return t === undefined || t.seq <= 1 ? null : ev(seq, "core.void", {}, t.id); })();
        if (candidate === null) continue;
        const prior = run(events);
        const before = JSON.stringify(prior);
        let refusedCode: string | null = null;
        try { run([...events, candidate]); events.push(candidate); } catch (e) {
          if (!EngineError.is(e)) throw e;
          expect(REFUSALS.has(e.code), e.code).toBe(true); // (d)
          expect(JSON.stringify(run(events))).toBe(before); // (d)
          refusedCode = e.code;
          counts.refused++;
        }
        if (s.k === "finalize") { // (e)
          expect(refusedCode).toBe(outcomeOf(boardgame, prior) === null ? "WRONG_PHASE" : null);
          if (refusedCode === null) counts.finalized++; else counts.finalizeRefused++;
        }
        if (s.k === "tiebreak") { // (f)
          expect(refusedCode).toBe(deciderPending(boardgame, prior) ? null : "TIEBREAK_NOT_APPLICABLE");
          if (refusedCode !== null) counts.tiebreakRefused++;
        }
        const f = run(events);
        const o = outcomeOf(boardgame, f);
        expect(o?.kind).not.toBe("draw"); // (a)
        expect(boardgame.awaitingDecider!(f.state)).toBe(f.state.phase === "tiebreak"); // (b)
        if (f.state.phase === "tiebreak") { // (b): the module decides nothing there; only a settle (lots) can
          expect(boardgame.outcome(f.state)).toBeNull();
          expect(o === null).toBe(f.settlement === null);
          counts.pending++;
        }
        if (o?.kind === "win" && o.method?.startsWith("tiebreak_")) { // (c)
          const last = live(events).filter((e) => e.type === "boardgame.tiebreak").at(-1)!;
          const p = last.payload as { rung: string; winner?: string; black?: string; result?: string };
          const advances = advancerOf(p);
          expect(o).toEqual({ kind: "win", winner: advances, loser: advances === H ? A : H, method: `tiebreak_${p.rung}` });
          counts.tiebreakWins++;
        }
        counts.steps++;
      }
    }), { numRuns: 300 });
    expect(counts.steps).toBeGreaterThan(0);
    expect(counts.refused).toBeGreaterThan(0);
    expect(counts.tiebreakWins).toBeGreaterThan(0);
    expect(counts.pending).toBeGreaterThan(0);
    expect(counts.finalized).toBeGreaterThan(0);
    expect(counts.finalizeRefused).toBeGreaterThan(0);
    expect(counts.tiebreakRefused).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// W2c Task 8 (spec item 13; D7, D8): the stage chooses its tie-break rungs, and an Armageddon records Black.
// ---------------------------------------------------------------------------

describe("BG-KO-3 a stage chooses its tie-break rungs and their order", () => {
  it("absent list = every rung in TIEBREAK_RUNGS order (today)", () => {
    expect(boardgame.configSchema.parse({}).tiebreakRungs).toBeUndefined();
    expect(Object.hasOwn(boardgame.configSchema.parse({}), "tiebreakRungs")).toBe(false); // absent, never defaulted (finding 12)
    expect(fold(ko, drawn).phase).toBe("tiebreak");
  });
  it("empty list: a drawn bracket game is level, not awaiting a decider (ruling 79 hold applies)", () => {
    const s = fold(koWith([]), drawn);
    expect(s.phase).not.toBe("tiebreak");
    expect(boardgame.awaitingDecider!(s as never)).toBe(false);
    expect(s.outcome).toMatchObject({ kind: "draw" });
    // The positive pair: the same drawn game under a non-empty list waits for its decider.
    expect(boardgame.awaitingDecider!(fold(koWith(["rapid"]), drawn) as never)).toBe(true);
  });
  it("empty list: the tie-break event itself is refused TIEBREAK_NOT_APPLICABLE — no rung may be recorded", () => {
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      expect(codeOf(() => fold(koWith([]), [...drawn, tieBreak(3, rung, H)])), rung).toBe("TIEBREAK_NOT_APPLICABLE");
      checked++;
    }
    expect(checked).toBe(TIEBREAK_RUNGS.length);
  });
  it("a rung outside the stage's list is refused TIEBREAK_NOT_APPLICABLE", () => {
    expect(codeOf(() => fold(koWith(["armageddon"]), [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H })]))).toBe("TIEBREAK_NOT_APPLICABLE");
  });
  it("a single-rung list accepts exactly that rung and refuses each of the others (membership, per rung)", () => {
    let accepted = 0;
    let refused = 0;
    for (const listed of TIEBREAK_RUNGS) {
      for (const tried of TIEBREAK_RUNGS) {
        const code = codeOf(() => fold(koWith([listed]), [...drawn, tieBreak(3, tried, A)]));
        expect(code, `list [${listed}] event ${tried}`).toBe(tried === listed ? null : "TIEBREAK_NOT_APPLICABLE");
        if (code === null) accepted++; else refused++;
      }
    }
    expect(accepted).toBe(TIEBREAK_RUNGS.length);
    expect(refused).toBe(TIEBREAK_RUNGS.length * (TIEBREAK_RUNGS.length - 1));
  });
  it("a refused rung changes nothing: the next, listed rung is still accepted", () => {
    const cfg = koWith(["blitz", "armageddon"]);
    const refusedFirst = [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H })];
    expect(codeOf(() => fold(cfg, refusedFirst))).toBe("TIEBREAK_NOT_APPLICABLE");
    expect(fold(cfg, [...drawn, tieBreak(3, "blitz", A)]).outcome).toMatchObject({ kind: "win", winner: A, method: "tiebreak_blitz" });
  });
  it("the list is a menu in the stage's order, not a gate: a later-listed rung may decide the game on its own", () => {
    expect(fold(koWith(["rapid", "blitz", "armageddon"]), [...drawn, tieBreak(3, "armageddon", H)]).outcome).toMatchObject({ kind: "win", winner: H, method: "tiebreak_armageddon" });
  });
  it("duplicates are refused by the schema; order is kept", () => {
    expect(boardgame.configSchema.safeParse({ tiebreakRungs: ["blitz", "blitz"] }).success).toBe(false);
    expect(koWith(["blitz", "rapid"]).tiebreakRungs).toEqual(["blitz", "rapid"]);
  });
  it("the schema refuses a rung the engine does not declare, a list longer than the rungs, and a non-list", () => {
    let refused = 0;
    for (const bad of [["lots"], ["rapid", "lots"], [...TIEBREAK_RUNGS, "rapid"], "rapid", null, [1]]) {
      expect(boardgame.configSchema.safeParse({ tiebreakRungs: bad }).success, JSON.stringify(bad)).toBe(false);
      refused++;
    }
    expect(refused).toBe(6);
    // The positive pair: every subset in every order the engine's three rungs allow is accepted.
    let accepted = 0;
    for (const list of [[], ["rapid"], ["armageddon", "rapid"], ["blitz", "armageddon", "rapid"], [...TIEBREAK_RUNGS]]) {
      expect(boardgame.configSchema.safeParse({ tiebreakRungs: list }).success, JSON.stringify(list)).toBe(true);
      accepted++;
    }
    expect(accepted).toBe(5);
  });
  it("I12: the stage's order is the order played — [blitz, rapid] is NOT re-sorted to TIEBREAK_RUNGS order", () => {
    expect(TIEBREAK_RUNGS.indexOf("rapid")).toBeLessThan(TIEBREAK_RUNGS.indexOf("blitz")); // precondition: the canonical order differs
    expect(effectiveRungs(koWith(["blitz", "rapid"]))).toEqual(["blitz", "rapid"]);
    expect(effectiveRungs(koWith([]))).toEqual([]);
    expect(effectiveRungs(boardgame.configSchema.parse({}))).toEqual([...TIEBREAK_RUNGS]);
  });
  it("tiebreakRungs is boardgame's alone: no other sport declares the key or reads a decider's winner", () => {
    let others = 0;
    for (const m of builtinModules) {
      if (m.key === "boardgame") continue;
      expect(Object.hasOwn(m.ruleKeys ?? {}, "tiebreakRungs"), m.key).toBe(false);
      expect((m as { deciderWinner?: unknown }).deciderWinner, m.key).toBeUndefined();
      others++;
    }
    expect(others).toBe(builtinModules.length - 1);
    expect(others).toBeGreaterThan(0);
    expect(boardgame.ruleKeys?.tiebreakRungs).toMatchObject({ scope: "stage" });
  });
});

describe("BG-KO-2 a drawn Armageddon is won by the recorded Black (P8 engine half)", () => {
  it("White wins → the non-black entrant advances", () => {
    expect(fold(koWith(["armageddon"]), [...drawn, arm(3, A, "white")]).outcome).toMatchObject({ kind: "win", winner: H, method: "tiebreak_armageddon" });
  });
  it("Black wins → black advances", () => {
    expect(fold(koWith(["armageddon"]), [...drawn, arm(3, A, "black")]).outcome).toMatchObject({ winner: A });
  });
  it("drawn → black advances (the rule this row exists for; differs from a 'home advances' constant)", () => {
    expect(fold(koWith(["armageddon"]), [...drawn, arm(3, A, "draw")]).outcome).toMatchObject({ winner: A });
    expect(fold(koWith(["armageddon"]), [...drawn, arm(3, H, "draw")]).outcome).toMatchObject({ winner: H });
  });
  it("every Black × result: the advancer is the rulebook's, and the loser is the other entrant", () => {
    let checked = 0;
    for (const black of [H, A]) for (const result of ["white", "black", "draw"] as const) {
      const o = fold(koWith(["armageddon"]), [...drawn, arm(3, black, result)]).outcome;
      const advances = advancerOf({ rung: "armageddon", black, result });
      expect(o, `black ${black === H ? "H" : "A"} ${result}`).toEqual({ kind: "win", winner: advances, loser: advances === H ? A : H, method: "tiebreak_armageddon" });
      checked++;
    }
    expect(checked).toBe(6);
  });
  it("the colour lives in its own field, never colorOfHome", () => {
    const s = fold(koWith(["armageddon"]), [...drawn, arm(3, A, "draw")]) as { armageddonBlack: string; colorOfHome?: unknown };
    const before = fold(koWith(["armageddon"]), drawn) as { colorOfHome?: unknown };
    expect(s.armageddonBlack).toBe(A);
    expect(s.colorOfHome).toEqual(before.colorOfHome);
  });
  it("I11: a fold with no Armageddon carries NO armageddonBlack key (goldens replay byte-identical)", () => {
    expect(Object.hasOwn(fold(ko, drawn), "armageddonBlack")).toBe(false);
    expect(Object.hasOwn(fold(koWith(["rapid"]), [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H })]), "armageddonBlack")).toBe(false);
    expect(Object.hasOwn(boardgame.init(ko, lineups), "armageddonBlack")).toBe(false);
    expect(Object.hasOwn(fold(league, drawn), "armageddonBlack")).toBe(false);
  });
  it("an Armageddon without black is refused TIEBREAK_COLOUR_REQUIRED", () => {
    expect(codeOf(() => fold(koWith(["armageddon"]), [...drawn, ev(3, "boardgame.tiebreak", { rung: "armageddon", result: "draw" })]))).toBe("TIEBREAK_COLOUR_REQUIRED");
  });
  it("BG-KO-3: a colourless Armageddon in a stage that does not list it is told that first — the rung list outranks the colour", () => {
    const colourless = ev(3, "boardgame.tiebreak", { rung: "armageddon", result: "draw" });
    for (const unlisted of [["rapid"], ["blitz", "rapid"]] as const) {
      expect(codeOf(() => fold(koWith([...unlisted]), [...drawn, colourless])), unlisted.join(",")).toBe("TIEBREAK_NOT_APPLICABLE");
    }
    // …and the same event where it IS listed is the colour refusal (the pair that makes the order observable).
    expect(codeOf(() => fold(koWith(["rapid", "armageddon"]), [...drawn, colourless]))).toBe("TIEBREAK_COLOUR_REQUIRED");
  });
  it("a refused colourless Armageddon changes nothing: Black recorded next is accepted", () => {
    const cfg = koWith(["armageddon"]);
    const colourless = ev(3, "boardgame.tiebreak", { rung: "armageddon", result: "draw" });
    expect(codeOf(() => fold(cfg, [...drawn, colourless]))).toBe("TIEBREAK_COLOUR_REQUIRED");
    expect(fold(cfg, [...drawn, arm(3, H, "draw")]).outcome).toMatchObject({ winner: H });
  });
  it("a black who is not in the match is refused INVALID_EVENT; a result outside white/black/draw is too; and an Armageddon never carries a winner or a score", () => {
    const cfg = koWith(["armageddon"]);
    expect(codeOf(() => fold(cfg, [...drawn, arm(3, "nobody", "draw")]))).toBe("INVALID_EVENT");
    expect(codeOf(() => fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", { rung: "armageddon", black: A, result: "tie" })]))).toBe("INVALID_EVENT");
    expect(codeOf(() => fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", { rung: "armageddon", black: A, result: "draw", winner: H })]))).toBe("INVALID_EVENT");
    expect(codeOf(() => fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", { rung: "armageddon", black: A, result: "draw", score: "1½–½" })]))).toBe("INVALID_EVENT");
    // The old shape is gone (greenfield): it names no Black, so it is refused for the colour it lacks, and with a Black
    // beside it the winner is a field the schema does not have.
    expect(codeOf(() => fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", { rung: "armageddon", winner: A })]))).toBe("TIEBREAK_COLOUR_REQUIRED");
    // …and rapid/blitz carry no colour or result.
    expect(codeOf(() => fold(koWith(["rapid"]), [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: A, black: A })]))).toBe("INVALID_EVENT");
    expect(codeOf(() => fold(koWith(["rapid"]), [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", black: A, result: "draw" })]))).toBe("INVALID_EVENT");
  });
  it("after a void of the Armageddon event the match is awaiting a decider again, and the colour is gone", () => {
    const cfg = koWith(["armageddon"]);
    const s = fold(cfg, [...drawn, arm(3, A, "draw"), ev(4, "core.void", {}, "e-3")]); /* makeEnvelope ids are `e-${seq}` (testkit/helpers.ts:13) */
    expect(s.phase).toBe("tiebreak");
    expect(Object.hasOwn(s, "armageddonBlack")).toBe(false);
    expect(boardgame.awaitingDecider!(s as never)).toBe(true);
    // The sequence: a corrected colour recorded after the void decides it the other way.
    expect(fold(cfg, [...drawn, arm(3, A, "draw"), ev(4, "core.void", {}, "e-3"), arm(5, H, "draw")]).outcome).toMatchObject({ winner: H });
  });
  it("a second tie-break after an Armageddon is refused TIEBREAK_NOT_APPLICABLE", () => {
    expect(codeOf(() => fold(ko, [...drawn, arm(3, A, "draw"), arm(4, H, "draw")]))).toBe("TIEBREAK_NOT_APPLICABLE");
  });
  it("the summary still shows the level game and names the rung alone — Black is the fold's, not the public detail", () => {
    const s = fold(koWith(["armageddon"]), [...drawn, arm(3, A, "draw")]);
    expect(boardgame.summary(s).headline).toBe(boardgame.summary(fold(league, drawn)).headline);
    expect((boardgame.summary(s).detail as { tiebreak?: unknown }).tiebreak).toStrictEqual({ rung: "armageddon" });
  });
});

describe("D-R7 / BG-KO-2: the decider's winner is read from the event, for the server's withdrawn-entrant guard", () => {
  const entrants = { home: H, away: A };
  it("rapid and blitz name the entrant who advances", () => {
    expect(boardgame.deciderWinner!({ rung: "rapid", winner: A }, entrants)).toBe(A);
    expect(boardgame.deciderWinner!({ rung: "blitz", winner: H, score: "2–0" }, entrants)).toBe(H);
  });
  it("an Armageddon's advancer is derived from Black and the result, matching what the fold decides", () => {
    let checked = 0;
    for (const black of [H, A]) for (const result of ["white", "black", "draw"] as const) {
      const payload = { rung: "armageddon", black, result };
      const advances = boardgame.deciderWinner!(payload, entrants);
      expect(advances, `${black === H ? "H" : "A"} ${result}`).toBe(advancerOf(payload));
      expect(advances).toBe((fold(koWith(["armageddon"]), [...drawn, ev(3, "boardgame.tiebreak", payload)]).outcome as { winner: string }).winner);
      checked++;
    }
    expect(checked).toBe(6);
  });
  it("a payload that names no advancer reads as undefined (the fold refuses it with its own code): no colour, a stranger as Black, junk", () => {
    let checked = 0;
    for (const bad of [{ rung: "armageddon", result: "draw" }, { rung: "armageddon", black: "nobody", result: "draw" }, { rung: "rapid" }, { rung: "lots", winner: A }, null, "x", 7]) {
      expect(boardgame.deciderWinner!(bad, entrants), JSON.stringify(bad)).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(7);
  });
});

describe("rule 10 — rungs × draw × tiebreak events × void (BG-KO-3, BG-KO-2)", () => {
  it("after every step: awaitingDecider ⇔ phase tiebreak; an event is accepted iff its rung is listed and a decider is pending; a decided match names the rulebook's advancer, from the lineups", () => {
    // Expectations come from the rule text: BG-KO-3 (the list is the menu; empty = no tie-break phase, so nothing to
    // record) and BG-KO-2 (White won → the other entrant, Black won or drawn → Black), never from the fold.
    const counts = { runs: 0, steps: 0, accepted: 0, refusedUnlisted: 0, refusedNoDecider: 0, emptyHeld: 0, armageddonWins: 0, voids: 0, blackAbsent: 0, blackPresent: 0 };
    const attempt = fc.record({
      rung: fc.constantFrom(...TIEBREAK_RUNGS),
      black: fc.constantFrom(H, A),
      winner: fc.constantFrom(H, A),
      result: fc.constantFrom("white", "black", "draw"),
      voidIt: fc.boolean(),
    });
    fc.assert(fc.property(
      fc.shuffledSubarray([...TIEBREAK_RUNGS], { minLength: 0 }),
      fc.array(attempt, { maxLength: 4 }),
      (rungs, attempts) => {
        counts.runs++;
        const cfg = koWith(rungs);
        const events = [...drawn];
        let decided = false; // an accepted tie-break that has not been voided
        if (rungs.length === 0) {
          expect(fold(cfg, events).phase).not.toBe("tiebreak");
          counts.emptyHeld++;
        }
        for (const a of attempts) {
          const payload = a.rung === "armageddon" ? { rung: a.rung, black: a.black, result: a.result } : { rung: a.rung, winner: a.winner };
          const next = [...events, ev(events.length + 1, "boardgame.tiebreak", payload)];
          const accepts = !decided && rungs.includes(a.rung);
          const code = codeOf(() => fold(cfg, next));
          expect(code, `${JSON.stringify(rungs)} ← ${JSON.stringify(payload)}`).toBe(accepts ? null : "TIEBREAK_NOT_APPLICABLE");
          counts.steps++;
          if (code === null) {
            counts.accepted++;
            events.push(next[next.length - 1]!);
            decided = true;
            const s = fold(cfg, events);
            expect(boardgame.awaitingDecider!(s as never)).toBe(s.phase === "tiebreak");
            const advances = advancerOf(payload as never);
            expect(s.outcome).toEqual({ kind: "win", winner: advances, loser: advances === H ? A : H, method: `tiebreak_${a.rung}` });
            expect([H, A]).toContain((s.outcome as { winner: string }).winner);
            expect(Object.hasOwn(s, "armageddonBlack")).toBe(a.rung === "armageddon");
            if (a.rung === "armageddon") {
              expect((s as { armageddonBlack?: string }).armageddonBlack).toBe(a.black);
              counts.armageddonWins++;
              counts.blackPresent++;
            } else counts.blackAbsent++;
            if (a.voidIt) {
              events.push(ev(events.length + 1, "core.void", {}, events[events.length - 1]!.id));
              decided = false;
              const after = fold(cfg, events);
              expect(after.phase).toBe("tiebreak"); // awaiting again…
              expect(boardgame.awaitingDecider!(after as never)).toBe(true);
              expect(Object.hasOwn(after, "armageddonBlack")).toBe(false); // …and the colour is gone with the event
              counts.voids++;
            }
          } else if (rungs.includes(a.rung)) counts.refusedNoDecider++;
          else counts.refusedUnlisted++;
        }
      },
    ), { seed: 20261013, numRuns: 300 });
    // Anti-vacuity: every kind of step the invariants describe was reached.
    expect(counts.runs).toBe(300);
    expect(counts.steps).toBeGreaterThan(0);
    expect(counts.accepted).toBeGreaterThan(0);
    expect(counts.refusedUnlisted).toBeGreaterThan(0);
    expect(counts.refusedNoDecider).toBeGreaterThan(0);
    expect(counts.emptyHeld).toBeGreaterThan(0);
    expect(counts.armageddonWins).toBeGreaterThan(0);
    expect(counts.voids).toBeGreaterThan(0);
    expect(counts.blackAbsent).toBeGreaterThan(0);
    expect(counts.blackPresent).toBeGreaterThan(0);
  });
});
