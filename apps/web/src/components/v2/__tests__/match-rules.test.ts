// Pure unit tests for buildRuleOverride's per-sport field collapse
// (match-rules.tsx). Covers the `values`-param pattern that lets one field's
// build() read a SIBLING field's raw value to assemble one nested override
// object from several rendered inputs (icehockey overtime/shootout, boardgame
// clock) — the mechanism this suite exists to pin, since it is easy to get
// the "primary blank skips the whole group" and "siblings default when
// blank" halves backwards. Also covers a sample of the sports that gained
// fields entirely (cricket, tennis, carrom, generic) so a typo in a
// build()'s key name reds here rather than silently producing a config the
// server-side configSchema rejects.
import { describe, expect, it } from "vitest";
import { hockey } from "@seazn/engine/sports/hockey";
import { icehockey } from "@seazn/engine/sports/icehockey";
import { buildRuleOverride, hydrateRuleValues } from "@/components/v2/rules/match-format-editor";

describe("buildRuleOverride — icehockey overtime, the values-param collapse", () => {
  it("assembles the nested override from the primary field plus its siblings", () => {
    expect(
      buildRuleOverride("icehockey", { overtime: "on", overtimeMinutes: "7", overtimeSkaters: "4" }),
    ).toEqual({ overtime: { kind: "sudden_death", minutes: 7, skaters: 4 } });
  });

  it("leaving the primary field blank skips the whole group, even with siblings filled in", () => {
    expect(buildRuleOverride("icehockey", { overtimeMinutes: "7", overtimeSkaters: "4" })).toEqual({});
  });

  it("falls back to the documented IIHF default when a sibling is left blank", () => {
    expect(buildRuleOverride("icehockey", { overtime: "on" })).toEqual({
      overtime: { kind: "sudden_death", minutes: 5, skaters: 3 },
    });
  });

  it("a sibling field alone (no primary) contributes nothing on its own", () => {
    expect(buildRuleOverride("icehockey", { overtimeSkaters: "4" })).toEqual({});
  });
});

describe("buildRuleOverride — hockey shootout, the same pattern with a fixed clock", () => {
  it("reads the sibling attempts value and keeps clockSeconds at the FIH fixed 8", () => {
    expect(buildRuleOverride("hockey", { shootout: "on", shootoutAttempts: "8" })).toEqual({
      shootout: { attempts: 8, clockSeconds: 8 },
    });
  });

  it("blank primary skips the group", () => {
    expect(buildRuleOverride("hockey", { shootoutAttempts: "8" })).toEqual({});
  });
});

describe("buildRuleOverride — the shoot-out builders write the engine's declared shape (W2e D4, HK-SO-2 IH-SO-2)", () => {
  // W2e deleted `shootout.suddenDeath` (declared, never read). A builder that still wrote it would lean on the engine's
  // deploy-window strip for ever; the expected keys are the ones each sport's own shoot-out preset declares (parsed, so a
  // variant that inherits the base shoot-out is read the way the engine reads it).
  it("hockey (fih-shootout) and ice hockey (iihf) write exactly their preset's shoot-out keys, with the attempts typed", () => {
    const cases = [
      { sport: "hockey", preset: hockey.configSchema.parse(hockey.variants["fih-shootout"]) },
      { sport: "icehockey", preset: icehockey.configSchema.parse(icehockey.variants.iihf) },
    ];
    let checked = 0;
    for (const { sport, preset } of cases) {
      const declared = (preset as { shootout?: Record<string, unknown> | null }).shootout;
      expect(declared, `${sport}: the preset declares a shoot-out`).toBeTruthy();
      const built = buildRuleOverride(sport, { shootout: "on", shootoutAttempts: "3" }) as { shootout?: Record<string, unknown> };
      expect(Object.keys(built.shootout ?? {}).sort(), sport).toEqual(Object.keys(declared ?? {}).sort());
      expect(built.shootout?.attempts, sport).toBe(3);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });
});

describe("buildRuleOverride — boardgame clock, a three-way merge", () => {
  it("skips the whole override when the base field is blank, even with increment/delay set", () => {
    expect(
      buildRuleOverride("boardgame", { clockIncrementSeconds: "5", clockDelaySeconds: "3" }),
    ).toEqual({});
  });

  it("builds base-only when neither optional add-on is set", () => {
    expect(buildRuleOverride("boardgame", { clockBaseMinutes: "15" })).toEqual({
      clock: { base: 900 },
    });
  });

  it("adds increment and delay onto the base when both are set", () => {
    expect(
      buildRuleOverride("boardgame", {
        clockBaseMinutes: "5",
        clockIncrementSeconds: "3",
        clockDelaySeconds: "2",
      }),
    ).toEqual({ clock: { base: 300, increment: 3, delay: 2 } });
  });
});

// W2c Task 8 (BG-KO-3) — the chess tie-break rungs, the first ORDERED-LIST ("sequence") field: the value is the chosen
// rungs, comma-joined, in the order they are played.
describe("buildRuleOverride — boardgame tie-break rungs (BG-KO-3), an ordered list", () => {
  it("builds the rungs in the order chosen, never re-sorted, and a blank value writes nothing (the engine's own order)", () => {
    expect(buildRuleOverride("boardgame", { tiebreakRungs: "blitz,armageddon" })).toEqual({ tiebreakRungs: ["blitz", "armageddon"] });
    expect(buildRuleOverride("boardgame", { tiebreakRungs: "armageddon,rapid,blitz" })).toEqual({ tiebreakRungs: ["armageddon", "rapid", "blitz"] });
    expect(buildRuleOverride("boardgame", { tiebreakRungs: "" })).toEqual({});
  });

  it("a saved list reopens as the value that rebuilds it — a blank would silently drop it on the next save (a stage's PUT is a fragment)", () => {
    const saved = { tiebreakRungs: ["blitz", "rapid"] };
    const values = hydrateRuleValues("boardgame", saved);
    expect(values).toEqual({ tiebreakRungs: "blitz,rapid" });
    expect(buildRuleOverride("boardgame", values)).toEqual(saved);
    // The positive pair: a config that carries no list shows nothing, and does not invent one.
    expect(hydrateRuleValues("boardgame", {})).toEqual({});
    expect(hydrateRuleValues("boardgame", { tiebreak: true })).toEqual({});
  });
});

describe("buildRuleOverride — fields added to sports the picker already covered", () => {
  it("cricket: playersPerSide", () => {
    expect(buildRuleOverride("cricket", { playersPerSide: "6" })).toEqual({ playersPerSide: 6 });
  });

  it("tennis: tiebreakWinBy", () => {
    expect(buildRuleOverride("tennis", { tiebreakWinBy: "1" })).toEqual({ tiebreak: { winBy: 1 } });
  });
});

describe("buildRuleOverride — sports the picker did not cover at all before", () => {
  it("carrom: a mix of number, select and bool fields", () => {
    expect(
      buildRuleOverride("carrom", {
        gameTo: "25",
        tieBoard: "draw",
        queenFollowsBoard: "on",
      }),
    ).toEqual({ gameTo: 25, tieBoard: "draw", queenFollowsBoard: true });
  });

  it("carrom: a gameTo above the schema's queenCapAt default leaves it untouched", () => {
    // 25 >= 22 (the pinned schema's own queenCapAt default), so the default
    // stays valid without a redundant override.
    expect(buildRuleOverride("carrom", { gameTo: "25" })).toEqual({ gameTo: 25 });
  });

  it("carrom: a quick-game gameTo below 22 pulls queenCapAt down with it", () => {
    // Reproduces a real schema-refine failure this once shipped: gameTo=15
    // alone left queenCapAt at its schema default of 22, and the pinned
    // config's own queenCapAt <= gameTo refine rejected the combination on
    // a field the organizer never touched.
    expect(buildRuleOverride("carrom", { gameTo: "15" })).toEqual({ gameTo: 15, queenCapAt: 15 });
  });

  it("carrom: an explicit queenCapAt always wins over gameTo's fallback", () => {
    expect(buildRuleOverride("carrom", { gameTo: "15", queenCapAt: "10" })).toEqual({
      gameTo: 15,
      queenCapAt: 10,
    });
  });

  it("generic: resultMode and allowDraws", () => {
    expect(buildRuleOverride("generic", { resultMode: "score", allowDraws: "on" })).toEqual({
      resultMode: "score",
      allowDraws: true,
    });
  });
});

describe("buildRuleOverride — football's two independent substitution caps", () => {
  it("maxSubs and subWindows each build their own top-level key", () => {
    expect(buildRuleOverride("football", { maxSubs: "3", subWindows: "2" })).toEqual({
      maxSubs: 3,
      subWindows: 2,
    });
  });

  it("leaving both blank overrides neither — an unstamped/uncapped division stays uncapped", () => {
    expect(buildRuleOverride("football", {})).toEqual({});
  });
});

// W2d (spec §5.3, B2; PS-1) — the R3.5/Task I shoot-out points pair is gone (greenfield): a table shoot-out is a draw
// plus `points.soBonus`, which the stage's Points section edits, never this field list. So no football field writes
// `points` any more, and a value under either retired key (a stale form, a hand-built request) builds nothing.
describe("buildRuleOverride — football has no shoot-out points field (W2d PS-1)", () => {
  it("a value under a retired shoot-out points key builds nothing — no `points` override at all", () => {
    expect(buildRuleOverride("football", { shootoutWin: "2", shootoutLoss: "1" })).toEqual({});
    expect(buildRuleOverride("football", { shootoutWin: "", shootoutLoss: "" })).toEqual({});
  });

  it("football's other fields build as before beside one", () => {
    expect(buildRuleOverride("football", { shootoutWin: "2", maxSubs: "3" })).toEqual({ maxSubs: 3 });
    expect(buildRuleOverride("football", { maxSubs: "3" })).toEqual({ maxSubs: 3 });
  });

  it("a saved soBonus hydrates no football field (the stage Points section owns it)", () => {
    expect(hydrateRuleValues("football", { points: { win: 3, draw: 1, loss: 0, soBonus: 1 } })).toEqual({});
  });
});
