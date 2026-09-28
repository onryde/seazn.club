import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import {
  CfgInvalid, UnknownSport, UnknownVariant, drawsAllowed, entrantKindFor, resolveSportCfg, sportModule, variantKeys,
} from "../lib/sport-cfg.ts";
import { FOLD_OPTIONS, declaredPoints, envelopes, foldStream, lineupsFor } from "../lib/fold.ts";
import { ALL_OUTCOMES, OutcomeUnreachable, START, outcomeLabel, type StreamRequest } from "../lib/streams/types.ts";
import { generateStream, matchesRequest } from "../lib/streams/index.ts";

const H = "H";
const A = "A";
const req = (variant: string, outcome: StreamRequest["outcome"], stageKind: StreamRequest["stageKind"] = "league"): StreamRequest => ({
  sportKey: "generic", cfg: resolveSportCfg("generic", variant), stageKind, home: H, away: A, outcome,
});

describe("sport-cfg — empty/unknown first", () => {
  it("refuses an unknown sport and an unknown variant with the declared list", () => {
    expect(() => sportModule("")).toThrow(UnknownSport);
    expect(() => resolveSportCfg("generic", "nope")).toThrow(UnknownVariant);
    try { resolveSportCfg("generic", "nope"); } catch (e) { expect((e as UnknownVariant).declared).toEqual(variantKeys("generic")); }
  });

  it("refuses a cfg the module's schema rejects (mirrors createDivision's 422 CONFIG_INVALID)", () => {
    expect(() => resolveSportCfg("badminton", "bwf", { bestOf: 2 })).toThrow(CfgInvalid);
  });

  it("variant keys come from the module in declaration order, never an empty list", () => {
    for (const m of builtinModules) expect(variantKeys(m.key).length, m.key).toBeGreaterThan(0);
  });
});

describe("sport-cfg — derived from declarations", () => {
  it("drawsAllowed is the module's supportsDraws, and differs across generic variants and stage kinds", () => {
    const score = resolveSportCfg("generic", "score");
    const winLoss = resolveSportCfg("generic", "win_loss");
    expect(drawsAllowed("generic", score, "league")).toBe(sportModule("generic").supportsDraws(score as never, "league"));
    expect(drawsAllowed("generic", score, "league")).toBe(true);
    expect(drawsAllowed("generic", winLoss, "league")).toBe(false);
    expect(drawsAllowed("generic", score, "knockout")).toBe(false);
  });

  it("entrantKindFor reads the effective entrant model", () => {
    expect(["individual", "pair"]).toContain(entrantKindFor("badminton", resolveSportCfg("badminton", "bwf")));
  });
});

describe("fold", () => {
  it("envelopes number seq from 1 and fold strict from seq 1", () => {
    const env = envelopes("f1", [START, { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } }]);
    expect(env.map((e) => e.seq)).toEqual([1, 2]);
    expect(FOLD_OPTIONS.strictFromSeq).toBe(1);
    expect(lineupsFor(H, A)).toEqual({ home: { entrantId: H, slots: [] }, away: { entrantId: A, slots: [] } });
  });

  it("an empty stream folds to no outcome (empty case) and declares no points", () => {
    const m = sportModule("generic");
    const cfg = resolveSportCfg("generic", "score");
    expect(foldStream(m, cfg, H, A, []).outcome).toBeNull();
    expect(declaredPoints(m, cfg, { kind: "league" }, H, A, [])).toBeNull();
  });

  it("a strict fold throws on an invalid event instead of returning a plausible state", () => {
    const m = sportModule("generic");
    const winLoss = resolveSportCfg("generic", "win_loss");
    // The draw the score variant would accept: refused where supportsDraws says false.
    expect(() => foldStream(m, winLoss, H, A, [START, { type: "generic.result", payload: { isDraw: true } }])).toThrow();
  });

  // The draw refusal above is NOT strict-gated (generic.ts applyResult checks
  // allowDraws on every fold), so it cannot tell a strict fold from a tolerant
  // one — found by mutation: dropping FOLD_OPTIONS from the fold call stayed
  // green. The kernel's monotonic game-time guard IS strict-only
  // (events.ts `backwards && strict`): a tolerant fold accepts a backwards
  // stamp. Positive pair first, so the throw is witnessed as the stamp's fault.
  it("the fold is strict: a backwards game-time stamp is refused (a tolerant fold would accept it)", () => {
    const m = sportModule("generic");
    const cfg = resolveSportCfg("generic", "score");
    const at = (elapsed: number) => ({ period: "P1", elapsed });
    const stoppage = (suspendAt: number, resumeAt: number) => [
      START,
      { type: "core.suspend", payload: { at: at(suspendAt) } },
      { type: "core.resume", payload: { at: at(resumeAt) } },
    ];
    expect(foldStream(m, cfg, H, A, stoppage(50, 100)).outcome).toBeNull();
    let code: unknown = "did not throw";
    try { foldStream(m, cfg, H, A, stoppage(100, 50)); } catch (e) { code = (e as { code?: unknown }).code; }
    expect(code).toBe("NON_MONOTONIC_TIME");
  });

  it("declaredPoints delegates to standingsDelta: a win gives the winner more, a draw gives equal points", () => {
    const m = sportModule("generic");
    const cfg = resolveSportCfg("generic", "score");
    const win = declaredPoints(m, cfg, { kind: "league" }, H, A, generateStream(req("score", { kind: "win", winner: "away" })))!;
    expect(win.away).toBeGreaterThan(win.home);
    expect(win.forOutcome).toMatchObject({ kind: "win", winner: A });
    const draw = declaredPoints(m, cfg, { kind: "league" }, H, A, generateStream(req("score", { kind: "draw" })))!;
    expect(draw.home).toBe(draw.away);
  });
});

describe("generic streams + matchesRequest", () => {
  // Discovery guard: an emptied ALL_OUTCOMES would delete every it.each row
  // below and leave the file green having checked nothing (R25).
  it("ALL_OUTCOMES is the six requested outcomes, labels distinct", () => {
    const labels = ALL_OUTCOMES.map(outcomeLabel);
    expect(labels).toEqual(["win-home", "win-away", "draw", "forfeit-away-walkover", "forfeit-home-retired", "abandon"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each(ALL_OUTCOMES.map((o) => [outcomeLabel(o), o] as const))("score variant, league: %s folds to what was asked", (_l, o) => {
    const r = req("score", o);
    const folded = foldStream(sportModule("generic"), r.cfg, H, A, generateStream(r));
    expect(matchesRequest(r, folded.outcome)).toBe(o.kind === "abandon" ? "unasserted" : "match");
  });

  it("a draw where supportsDraws is false is OutcomeUnreachable, not a stream", () => {
    expect(() => generateStream(req("score", { kind: "draw" }, "knockout"))).toThrow(OutcomeUnreachable);
    expect(() => generateStream(req("win_loss", { kind: "draw" }))).toThrow(OutcomeUnreachable);
  });

  it("matchesRequest says mismatch when the wrong side won (the right answer differs from the wrong one)", () => {
    const r = req("score", { kind: "win", winner: "home" });
    expect(matchesRequest(r, { kind: "win", winner: A, loser: H })).toBe("mismatch");
    expect(matchesRequest(r, null)).toBe("mismatch");
    const f = req("score", { kind: "forfeit", by: "away", reason: "walkover" });
    expect(matchesRequest(f, { kind: "award", winner: H })).toBe("match");
    expect(matchesRequest(f, { kind: "award", winner: A })).toBe("mismatch");
    expect(matchesRequest(req("score", { kind: "draw" }), { kind: "tie" })).toBe("mismatch");
  });

  it("an unregistered sport is GeneratorUnsupported, never an empty stream", () => {
    expect(() => generateStream({ ...req("score", { kind: "win", winner: "home" }), sportKey: "curling" })).toThrow(/no generator/);
  });
});
