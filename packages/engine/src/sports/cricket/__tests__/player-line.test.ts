// Task 17 — owner ruling 12 (2026-09-05): band-2 player lines carry OPTIONAL
// 4s/6s/how-out/maidens/wides/no-balls on top of the seven legacy fields, so
// the spectator scorecard fold (scorecard.ts) can show them without a
// delivery behind them. The band stays 2 — additive, optional, never a
// re-implementation of a cricket rule (the maidens bound below reads
// `cfg.ballsPerOver`, never a hardcoded 6).
import { describe, expect, it } from "vitest";
import { cricket, padSpec, CricketPlayerLine } from "../cricket.ts";
import { lineLedger } from "./scorecard-ledger.ts";

describe("CricketPlayerLine — enriched band-2 lines", () => {
  it("accepts the seven legacy fields unchanged (byte-identical legacy payload still parses)", () => {
    // Exactly the seven `playerLineAction.fields` paths pre-Task-17:
    // innings, batting.out/runs/balls, bowling.legalBalls/runs/wickets.
    const legacy = {
      innings: 1,
      person: "h1",
      batting: { runs: 30, balls: 20, out: true },
      bowling: { legalBalls: 12, runs: 20, wickets: 2 },
    };
    const result = CricketPlayerLine.safeParse(legacy);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(legacy);
  });

  it("accepts fours/sixes/dismissal on batting and maidens/wides/noBalls on bowling", () => {
    const enriched = {
      innings: 1,
      person: "h1",
      batting: {
        runs: 30,
        balls: 20,
        out: true,
        fours: 3,
        sixes: 1,
        dismissal: { kind: "caught", bowler: "a7", fielder: "a3" },
      },
      bowling: { legalBalls: 12, runs: 20, wickets: 2, maidens: 1, wides: 2, noBalls: 0 },
    };
    const result = CricketPlayerLine.safeParse(enriched);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(enriched);
  });

  // False premise, found by running the full cricket suite (not assumed):
  // the brief called these "schema refinements", but `batting.fours`/
  // `.sixes`/`.dismissal.kind` and `.out` are each independent PadFields on
  // `playerLineAction`, and `testkit/conformance-pad.ts`'s property (b)/(g)
  // fuzz every field/attribution item independently and require the SCHEMA
  // to accept whatever in-bounds combination results. A cross-field zod
  // `.refine()` breaks that (the fuzzer freely pairs `out: false` with a
  // fuzzed `dismissal`, and a high `fours`/`sixes` with a low `runs`) — see
  // `CricketPlayerLine`'s own comment. Both checks live in `applyPlayerLine`
  // instead, mirroring `CricketWicket`'s "fielderAssist requires fielder"
  // (no schema refine there either — enforced only where a wicket is built).
  it("CricketPlayerLine schema accepts fours*4 + sixes*6 > runs (no cross-field refine — see applyPlayerLine below)", () => {
    const result = CricketPlayerLine.safeParse({
      innings: 1,
      person: "h1",
      batting: { runs: 10, balls: 5, fours: 3 }, // 3*4=12 > 10
    });
    expect(result.success).toBe(true);
  });

  it("applyPlayerLine rejects fours*4 + sixes*6 > runs", () => {
    expect(() =>
      lineLedger(undefined, [
        { innings: 1, person: "h1", batting: { runs: 10, balls: 5, fours: 3 } }, // 3*4=12 > 10
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_EVENT",
        data: expect.objectContaining({ field: "batting.fours" }),
      }),
    );
  });

  it("applyPlayerLine rejects a dismissal without out: true", () => {
    expect(() =>
      lineLedger(undefined, [
        { innings: 1, person: "h1", batting: { runs: 10, balls: 5, dismissal: { kind: "caught" } } },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_EVENT",
        data: expect.objectContaining({ field: "batting.dismissal" }),
      }),
    );
  });

  it("applyPlayerLine rejects maidens > floor(legalBalls / ballsPerOver)", () => {
    // LINE_CFG (scorecard-ledger.ts's default for lineLedger) leaves
    // `ballsPerOver` at its schema default, 6: floor(13 / 6) = 2, so 3
    // maidens is one over the bound this line's own legalBalls allow.
    expect(() =>
      lineLedger(undefined, [
        { innings: 1, person: "a7", bowling: { legalBalls: 13, runs: 5, wickets: 0, maidens: 3 } },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_EVENT",
        data: expect.objectContaining({ field: "bowling.maidens" }),
      }),
    );
  });

  it("padSpec(cfg) declares the new fields and the two optional person attributions for cricket.player.line", () => {
    const cfg = cricket.configSchema.parse({});
    const action = padSpec(cfg)
      .panels.flatMap((p) => p.actions)
      .find((a) => a.type === "cricket.player.line")!;
    expect(action.fields.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "batting.fours",
        "batting.sixes",
        "batting.dismissal.kind",
        "bowling.maidens",
        "bowling.wides",
        "bowling.noBalls",
      ]),
    );
    expect(action.attribution.filter((a) => a.optional === true).map((a) => a.path)).toEqual([
      "batting.dismissal.bowler",
      "batting.dismissal.fielder",
    ]);
  });

  it("fidelity of cricket.player.line stays 2", () => {
    const cfg = cricket.configSchema.parse({});
    expect(padSpec(cfg).fidelity["cricket.player.line"]).toBe(2);
  });
});
