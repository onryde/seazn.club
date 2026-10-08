import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { CoreSettle, deciderPending, foldMatch, foldMatchWithStoppage, outcomeOf, settleApplies, type EventEnvelope } from "../../core/events.ts";
import { mulberry32 } from "../../core/rng.ts";
import { evalPadGate } from "../../sport/module.ts";
import { aggregatePlayerStats, type PlayerStatsFoldCtx } from "../../stats/stats.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { generic } from "../generic/index.ts";
import { boardgame, BoardgameMethod, BoardgameTiebreak, CHESS_SCORE, TIEBREAK_RUNGS } from "./boardgame.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const lineups = defaultLineupPair(boardgame.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;
const ko = boardgame.configSchema.parse({ ...boardgame.bracketDeciders(boardgame.configSchema.parse({})) });
const league = boardgame.configSchema.parse({});
const drawn = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" })];
const fold = (cfg: unknown, events: EventEnvelope[]) => foldMatch(boardgame, cfg as never, lineups, events);
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };
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

  it("BG-KO-1: a double forfeit still folds to no_result (W2b owns it), never a tie-break", () => {
    expect(boardgame.outcome(fold(ko, [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })]))).toEqual({ kind: "no_result" });
  });

  it("T15-R1 BG-KO-1: only a game the league calls DRAWN enters the tie-break — a bracket double forfeit is held no_result, awaitingDecider false, closed by settle", () => {
    // Every null-winner method (and the omitted one): in a bracket, a method whose league fold is a draw goes to
    // phase tiebreak; any other folds exactly as the league does. The ruling names the one other: double_forfeit.
    const methods: (string | undefined)[] = [...BoardgameMethod.options, undefined];
    let tiebreaks = 0;
    const held: string[] = [];
    for (const method of methods) {
      const events = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, ...(method === undefined ? {} : { method }) })];
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
    expect(tiebreaks).toBe(methods.length - 1);
    // Held, not stalled: no tie-break is accepted after it (ruling D-C7: TIEBREAK_NOT_APPLICABLE, spec §7), and settle
    // (X-ST-1) closes it.
    const df = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })];
    expect(codeOf(() => fold(ko, [...df, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H })]))).toBe("TIEBREAK_NOT_APPLICABLE");
    const settled = foldMatchWithStoppage(boardgame, ko as never, lineups, [...df, ev(3, "core.settle", { winner: H, method: "organiser" })]);
    expect(outcomeOf(boardgame, settled)).toEqual({ kind: "win", winner: H, loser: A, method: "settled_organiser" });
  });

  it("BG-KO-1: each rung decides a win with method tiebreak_<rung>, and the summary still shows the level game", () => {
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const s = fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung, winner: A })]);
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
      const refused = errOf(() => fold(ko, [ev(1, "core.start"), ev(2, "boardgame.tiebreak", { rung, winner: H })]));
      expect(refused.code, rung).toBe("TIEBREAK_NOT_APPLICABLE");
      // The kernel's refusal (ruling D-C7), which names the refused event — the module's own phase guard below it is
      // the direct-apply backstop (testkit), pinned separately.
      expect(refused.data, rung).toMatchObject({ eventId: "e-2" });
      expect(refused.message, rung).toContain("boardgame.tiebreak");
      expect(codeOf(() => fold(league, [...drawn, ev(3, "boardgame.tiebreak", { rung, winner: H })])), rung).toBe("TIEBREAK_NOT_APPLICABLE");
      // The module's own guard, reached only by direct apply: it names the phase it was refused in.
      const direct = errOf(() => boardgame.apply(fold(ko, [ev(1, "core.start")]), ev(2, "boardgame.tiebreak", { rung, winner: H }) as never));
      expect(direct.code, rung).toBe("TIEBREAK_NOT_APPLICABLE");
      expect(direct.message, rung).toContain('"live"');
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("BG-KO-1: a second tiebreak is refused (ruling D-C7: TIEBREAK_NOT_APPLICABLE)", () => {
    expect(codeOf(() => fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H }), ev(4, "boardgame.tiebreak", { rung: "blitz", winner: A })]))).toBe("TIEBREAK_NOT_APPLICABLE");
  });

  it("BG-KO-2 (ruling 82): the engine records the armageddon winner the scorer taps — either side, with or without colours", () => {
    // W2a enforces BG-KO-2 by the pad's hint (Task 12), not here; colours are W2c's (spec §2.3).
    const noColours = boardgame.configSchema.parse({ colors: false, tiebreak: true });
    let checked = 0;
    for (const cfg of [ko, noColours]) for (const winner of [H, A]) {
      const s = fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", { rung: "armageddon", winner })]);
      expect(boardgame.outcome(s)).toEqual({ kind: "win", winner, loser: winner === H ? A : H, method: "tiebreak_armageddon" });
      checked++;
    }
    expect(checked).toBe(4);
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
    // And the held double forfeit (T15-R1): settle applies (a level no_result), no decider is pending.
    const df = run([ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })]);
    expect(settleApplies(boardgame, facts(df))).toBe(true);
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
      ["after a held double forfeit", ko, df],
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

  it("BG-KO-1: a core.forfeit while the tie-break is pending is refused WRONG_PHASE — the game is over; a no-show in the tie-break is the scorer's tie-break winner or the organiser's settle", () => {
    const refused = errOf(() => fold(ko, [...drawn, ev(3, "core.forfeit", { by: H, reason: "no-show for the rapid games" })]));
    expect(refused.code).toBe("WRONG_PHASE");
    expect(refused.message).toContain('forfeit not allowed in phase "tiebreak"'); // the forfeit's own guard, not the result's below it
    // The positive pair: the same forfeit while the game is live decides it.
    expect(boardgame.outcome(fold(ko, [ev(1, "core.start"), ev(2, "core.forfeit", { by: H, reason: "no-show" })]))).toMatchObject({ kind: "win", winner: A });
  });

  it("review Minor 4: the tie-break winner is the same entrant-id schema core.settle names its winner with", () => {
    expect(BoardgameTiebreak.shape.winner).toBe(CoreSettle.shape.winner);
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
    expect(action.fields).toEqual([{ kind: "enum", path: "rung", values: TIEBREAK_RUNGS }]);
    expect(action.attribution.map((i) => [i.kind, i.path])).toEqual([["side", "winner"]]);
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

  it("BG-KO-1 generator: in phase tiebreak arbitraryEvent emits a tie-break the fold accepts — every rung, both winners, the score present and absent", () => {
    const pending = fold(ko, drawn);
    const seen = { rung: new Set<string>(), winner: new Set<string>(), score: new Set<string>() };
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const e = boardgame.arbitraryEvent!(pending, mulberry32(seed));
      expect(e?.type, `seed ${seed}`).toBe("boardgame.tiebreak");
      const p = e!.payload as Record<string, unknown>;
      if (Object.hasOwn(p, "score")) expect(typeof p.score, `seed ${seed}`).toBe("string"); // never an undefined key
      expect(boardgame.outcome(fold(ko, [...drawn, ev(3, e!.type, p)]))?.kind, `seed ${seed}`).toBe("win"); // accepted
      seen.rung.add(String(p.rung));
      seen.winner.add(String(p.winner));
      seen.score.add(typeof p.score === "string" ? p.score : "(none)");
      checked++;
    }
    expect(checked).toBe(200);
    expect([...seen.rung].sort()).toEqual([...TIEBREAK_RUNGS].sort());
    expect([...seen.winner].sort()).toEqual([A, H].sort());
    expect(seen.score.has("(none)")).toBe(true);
    expect(seen.score.size).toBeGreaterThanOrEqual(3); // absent, and at least two distinct chess scores
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
      fc.record({ k: fc.constant("tiebreak" as const), rung: fc.constantFrom(...TIEBREAK_RUNGS), side: fc.constantFrom(H, A) }),
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
          : s.k === "tiebreak" ? ev(seq, "boardgame.tiebreak", { rung: s.rung, winner: s.side })
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
          const p = last.payload as { rung: string; winner: string };
          expect(o).toEqual({ kind: "win", winner: p.winner, loser: p.winner === H ? A : H, method: `tiebreak_${p.rung}` });
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
