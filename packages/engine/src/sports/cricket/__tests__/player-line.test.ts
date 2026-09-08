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

// Task 18 — owner ruling 12 (S18): the pad wiring these declarations feed.
// `checkActionValidity` (apps/web view-model.ts) gates Confirm on EVERY
// declared field unless it is flagged `optional`, so the six new fields
// need that flag or the "legacy 7-field payload stays reachable" half of
// ruling 12 is broken at the pad, even though the schema itself already
// accepts the legacy shape (proved above). `chips`/`requiresField` are the
// other two pieces of pad-facing data this task's renderer/builder read.
describe("cricket.player.line padSpec — S18 pad-wiring flags", () => {
  const cfg = cricket.configSchema.parse({});
  const action = padSpec(cfg)
    .panels.flatMap((p) => p.actions)
    .find((a) => a.type === "cricket.player.line")!;

  it("flags exactly the six band-2 fields optional — the original seven stay required", () => {
    const optionalPaths = action.fields.filter((f) => f.optional === true).map((f) => f.path);
    expect(optionalPaths.sort()).toEqual(
      [
        "batting.fours",
        "batting.sixes",
        "batting.dismissal.kind",
        "bowling.maidens",
        "bowling.wides",
        "bowling.noBalls",
      ].sort(),
    );
    const legacyPaths = ["innings", "batting.out", "batting.runs", "batting.balls", "bowling.legalBalls", "bowling.runs", "bowling.wickets"];
    for (const path of legacyPaths) {
      expect(action.fields.find((f) => f.path === path)!.optional).not.toBe(true);
    }
  });

  it("declares batting.dismissal.kind as a chip-rendered enum", () => {
    const kindField = action.fields.find((f) => f.path === "batting.dismissal.kind")!;
    expect(kindField.kind).toBe("enum");
    if (kindField.kind === "enum") expect(kindField.chips).toBe(true);
  });

  it("gates both dismissal-credit attributions on batting.dismissal.kind", () => {
    const bowler = action.attribution.find((a) => a.path === "batting.dismissal.bowler")!;
    const fielder = action.attribution.find((a) => a.path === "batting.dismissal.fielder")!;
    expect(bowler.requiresField).toBe("batting.dismissal.kind");
    expect(fielder.requiresField).toBe("batting.dismissal.kind");
  });
});

// Task 20 — Task 19's live run proved a second, pre-existing defect: the pad's
// generic form always sent BOTH `batting` and `bowling` (the legacy seven
// fields carried no `optional: true`), so `applyPlayerLine`'s independent
// order-membership checks then required the SAME person to be a member of
// BOTH the batting side's AND the opposing side's bowling order —
// structurally impossible for any real two-team fixture.
//
// Verified from source first (task-19-review.md's own independent read,
// re-confirmed here): `CricketPlayerLine.batting`/`.bowling` are ALREADY
// each `.optional()` (cricket.ts:338-365) with a `.refine()` requiring at
// least one (cricket.ts:367-369), and `applyPlayerLine`'s two order checks
// (cricket.ts:1806, 1838) already run only `if (payload.batting !==
// undefined)` / `if (payload.bowling !== undefined)`. So NO schema or
// reducer change is needed — this suite proves that, and
// `scorecard-ledger.ts`'s own `DEFAULT_LINES` (h1 batting-only, a7
// bowling-only — see that file's comment) has exercised exactly this shape
// as the DEFAULT fixture for every test using `lineLedger()` since Task 4,
// which is independent, pre-existing evidence the reducer path was never
// the problem. The fix (below, view-model.ts) is confined to the pad-form
// layer: `PadField.group` lets the legacy 7 fields stay optional AS A
// GROUP (an untouched aspect is omitted from the payload) while a NEITHER-
// aspect line is still refused before Confirm.
describe("cricket.player.line — a single aspect is accepted end to end (Task 20)", () => {
  it("CricketPlayerLine schema accepts a batting-only line (no bowling key at all)", () => {
    const result = CricketPlayerLine.safeParse({ innings: 1, person: "h1", batting: { runs: 30, balls: 20 } });
    expect(result.success).toBe(true);
    if (result.success) expect(Object.prototype.hasOwnProperty.call(result.data, "bowling")).toBe(false);
  });

  it("CricketPlayerLine schema accepts a bowling-only line (no batting key at all)", () => {
    const result = CricketPlayerLine.safeParse({
      innings: 1,
      person: "a7",
      bowling: { legalBalls: 12, runs: 20, wickets: 2 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(Object.prototype.hasOwnProperty.call(result.data, "batting")).toBe(false);
  });

  it("CricketPlayerLine schema rejects a line with NEITHER aspect", () => {
    const result = CricketPlayerLine.safeParse({ innings: 1, person: "h1" });
    expect(result.success).toBe(false);
  });

  it("applyPlayerLine accepts a batting-only line for a home player — never consults the away bowling order", () => {
    // "h1" is in home's BATTING order only; if the reducer wrongly checked
    // the bowling side too (the pre-Task-20 pad-layer defect's symptom), this
    // would throw "not in the bowling lineup" instead of succeeding.
    expect(() => lineLedger(undefined, [{ innings: 1, person: "h1", batting: { runs: 5, balls: 5 } }])).not.toThrow();
  });

  it("applyPlayerLine accepts a bowling-only line for an away player — never consults the home batting order", () => {
    expect(() =>
      lineLedger(undefined, [{ innings: 1, person: "a7", bowling: { legalBalls: 6, runs: 5, wickets: 0 } }]),
    ).not.toThrow();
  });

  it("padSpec(cfg) groups every batting.* field 'batting' and every bowling.* field 'bowling' (view-model.ts's group-omission needs this)", () => {
    const cfg = cricket.configSchema.parse({});
    const action = padSpec(cfg)
      .panels.flatMap((p) => p.actions)
      .find((a) => a.type === "cricket.player.line")!;
    for (const field of action.fields) {
      if (field.path.startsWith("batting.")) expect(field.group).toBe("batting");
      else if (field.path.startsWith("bowling.")) expect(field.group).toBe("bowling");
      else expect(field.group).toBeUndefined(); // "innings" — shared, ungrouped
    }
  });
});

// ---------------------------------------------------------------------------
// Task A — every `cricket.player.line` control is NAMED.
//
// A `PadField`/`PadAttributionItem` with no `labelKey` is legal by design
// (`PadFieldEnum`'s own header, sport/module.ts), and apps/web's universal
// renderer then falls back to `deriveFieldPathLabel(field.path)`
// (view-model.ts) — a word-split of the dotted path. That fallback is
// DERIVED ENGLISH and is never routed through a dictionary, so a French,
// Spanish or Dutch scorer read "Bowling legal balls" off this action's seven
// uncaptioned fields (and "Scorecard line — Person" off its one uncaptioned
// attribution item) in every locale.
//
// The other twelve cricket actions keep their uncaptioned fields
// deliberately (see `WICKET_ATTRIBUTION`'s own comment in cricket.ts): this
// suite is scoped to `cricket.player.line`, the one action a scorer fills in
// FIELD BY FIELD with no surrounding layout naming anything.
// ---------------------------------------------------------------------------
describe("cricket.player.line padSpec — every control carries a labelKey (Task A)", () => {
  const cfg = cricket.configSchema.parse({});
  const action = padSpec(cfg)
    .panels.flatMap((p) => p.actions)
    .find((a) => a.type === "cricket.player.line")!;

  it("leaves NO field and NO attribution item uncaptioned", () => {
    const uncaptioned = [
      ...action.fields.filter((f) => f.labelKey === undefined).map((f) => `field ${f.path}`),
      ...action.attribution.filter((a) => a.labelKey === undefined).map((a) => `attribution ${a.path}`),
    ];
    expect(uncaptioned, "these render deriveFieldPathLabel()'s English in all four locales").toEqual([]);
  });

  it("names each of them under the action's own key namespace, with a non-empty English fallback", () => {
    const keys = [...action.fields.map((f) => f.labelKey!), ...action.attribution.map((a) => a.labelKey!)];
    for (const { key, label } of keys) {
      expect(key, `"${key}" is outside the action's namespace`).toMatch(
        /^pad\.cricket\.action\.playerLine(\.field\.[A-Za-z]+)?$/,
      );
      expect(label.trim(), `"${key}" has an empty English fallback`).not.toBe("");
    }
    expect(new Set(keys.map((k) => k.key)).size, "two controls share one key").toBe(keys.length);
  });

  it("disambiguates the two aspects that collide on a leaf name — batting.runs is not bowling.runs", () => {
    // The pre-existing sibling convention (`batting.fours` -> `…field.fours`)
    // drops the aspect segment, which is only safe while no two paths share a
    // leaf. `batting.runs`/`bowling.runs` DO, on this one action, so the new
    // keys carry the aspect. A single key for both would make
    // `checkLabelKeysUnique` (testkit/conformance-pad.ts) a false alarm and
    // would caption two different numbers identically on one form.
    const battingRuns = action.fields.find((f) => f.path === "batting.runs")!.labelKey!;
    const bowlingRuns = action.fields.find((f) => f.path === "bowling.runs")!.labelKey!;
    expect(battingRuns.key).not.toBe(bowlingRuns.key);
    expect(battingRuns.label).not.toBe(bowlingRuns.label);
  });
});

// ---------------------------------------------------------------------------
// Task B — the pad must not OFFER a bowler on a dismissal the reducer
// refuses one for.
//
// W1 review finding P2 tightened `applyPlayerLine` (above): naming
// `dismissal.bowler` on a kind outside `BOWLER_CREDITED_KINDS` is refused
// outright. `requiresField` alone only asks that SOME kind be picked, so a
// scorer could tap "Run out", name a bowler and hit Confirm into a refusal —
// the exact "never offer what the engine will refuse" rule this programme
// runs on.
//
// The expected set is MEASURED FROM THE REDUCER, never typed into this test
// (memory rule #19): each declared dismissal kind is folded twice through the
// real `applyPlayerLine`, once with a bowler named and once without, and the
// differential IS the set the pad may offer. Change `BOWLER_CREDITED_KINDS`
// in cricket.ts and this test moves with it.
// ---------------------------------------------------------------------------
describe("cricket.player.line padSpec — the bowler chip is offered only for bowler-credited dismissals (Task B)", () => {
  const cfg = cricket.configSchema.parse({});
  const action = padSpec(cfg)
    .panels.flatMap((p) => p.actions)
    .find((a) => a.type === "cricket.player.line")!;
  const kindField = action.fields.find((f) => f.path === "batting.dismissal.kind")!;
  const kinds = kindField.kind === "enum" ? kindField.values : [];

  // "h1" bats for home in innings 1; "a7" bowls for away (scorecard-ledger.ts's
  // own DEFAULT_LINES comment). A bowler from the fielding side is therefore
  // the ONLY variable between the two folds below.
  const foldsClean = (bowler: string | undefined, kind: string): boolean => {
    try {
      lineLedger(undefined, [
        {
          innings: 1,
          person: "h1",
          batting: {
            runs: 30,
            balls: 20,
            out: true,
            dismissal: { kind, ...(bowler === undefined ? {} : { bowler }) },
          },
        },
      ] as never);
      return true;
    } catch {
      return false;
    }
  };

  it("every declared dismissal kind is foldable WITHOUT a bowler — so the differential below is about the bowler alone", () => {
    expect(kinds.length).toBeGreaterThan(1);
    expect(kinds.filter((k) => !foldsClean(undefined, k))).toEqual([]);
  });

  it("declares requiresFieldIn as exactly the kinds applyPlayerLine actually accepts a bowler on", () => {
    const acceptedByTheReducer = kinds.filter((k) => foldsClean("a7", k));
    // Vacuity guard: if the reducer accepted a bowler on every kind there
    // would be nothing to gate, and an empty `requiresFieldIn` would pass.
    expect(acceptedByTheReducer.length).toBeGreaterThan(0);
    expect(acceptedByTheReducer.length).toBeLessThan(kinds.length);

    const bowler = action.attribution.find((a) => a.path === "batting.dismissal.bowler")!;
    expect([...(bowler.requiresFieldIn ?? [])].sort()).toEqual([...acceptedByTheReducer].sort());
  });

  it("leaves the fielder ungated by VALUE — creditFielding accepts a fielder on every kind", () => {
    // Negative pair: `requiresFieldIn` must not be sprayed across every
    // gated item. A fielder is legal on any dismissal (creditFielding only
    // checks lineup membership), so gating it would hide a legal control.
    const fielder = action.attribution.find((a) => a.path === "batting.dismissal.fielder")!;
    expect(fielder.requiresFieldIn).toBeUndefined();
    expect(fielder.requiresField).toBe("batting.dismissal.kind");
  });
});
