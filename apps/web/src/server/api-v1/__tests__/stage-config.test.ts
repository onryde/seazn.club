// `CreateStage` has been `.strict()` since F2 Task 5, but `config` inside it
// was `z.record(z.string(), z.unknown())` — so the exact bug strictness was
// added to stop survived one level down. A misspelled `byes` parsed, stored,
// was read by nothing, and the product seeded its own draw and returned 201.
//
// These tests pin both halves of the fix: the key set is CLOSED (that is the
// defect), and the values whose shape belongs to another authority stay open
// (restating them here would be a second copy of a fact that already has an
// owner).
import { describe, expect, it } from "vitest";
import { deciderKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { CreateStage, PutStageRules, STAGE_DECIDER_MOVED, StageConfig } from "@/server/api-v1/schemas";

/** Every key with a real reader. Derived from the reader/writer sweep, not
 *  typed from memory — if one is dropped from the schema it becomes
 *  permanently unreachable, since CreateStage is the only client write path. */
const KNOWN: Record<string, unknown> = {
  legs: 2,
  pools: { count: 4 },
  thirdPlace: true,
  byes: ["ent-1", "ent-2"],
  slotOrder: [1, null, 3],
  bracketReset: true,
  mode: "americano",
  courtCount: 3,
  rounds: 7,
  chess: true,
  pairing: "rank_adjacent",
  challengeRange: 3,
  ladder_order: ["ent-1"],
  qualified: ["ent-1"],
  h2h_scope: "overall",
  rngSeed: 42,
  points: { w: 3, d: 1, l: 0 },
  carry_deltas: [{ entrant_id: "e1", points: 2 }],
  rank_overrides: [{ entrant_id: "e1", rank: 1 }],
  cross_feeds: [{ from_ext_key: "sf1", side: "loser", to_stage_seq: 2, to_ext_key: "f", slot: 1 }],
  placements: { f: [1, 2] },
  // W2c Task 12: a stage's deciders are its match rules (D3) — `shootout` / `extraTime` moved under `rules`.
  rules: { shootout: false, extraTime: { enabled: true, halfMinutes: 10 } },
};

const stage = (config: unknown) => ({ seq: 1, kind: "knockout", name: "Cup", config });

describe("StageConfig closes the key set", () => {
  it("rejects a misspelled key and NAMES it — the whole point", () => {
    // `byess` for `byes`. Before this schema it parsed, stored and did
    // nothing; the organiser got a draw they never asked for.
    const r = StageConfig.safeParse({ byess: ["ent-1"] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("byess");
  });

  it("rejects the near-miss on the other field the finding named", () => {
    expect(StageConfig.safeParse({ slotorder: [1, 2] }).success).toBe(false);
    expect(StageConfig.safeParse({ slot_order: [1, 2] }).success).toBe(false);
  });

  it("the refusal survives the CreateStage envelope, not just the inner schema", () => {
    // A guard that only works when called directly is not the guard the route
    // has. This is the shape a client actually POSTs.
    const r = CreateStage.safeParse(stage({ byess: ["ent-1"] }));
    expect(r.success).toBe(false);
  });

  it("accepts EVERY key that has a reader — one at a time", () => {
    // The negative test above passes just as well against a schema that
    // refuses everything. This is the half that proves the key set is right,
    // and it is per-key so a failure names the key that regressed.
    for (const [key, value] of Object.entries(KNOWN)) {
      const r = StageConfig.safeParse({ [key]: value });
      expect(r.success, `${key} must be accepted (it has a reader)`).toBe(true);
    }
  });

  it("accepts all of them together, as a real multi-kind config arrives", () => {
    expect(StageConfig.safeParse(KNOWN).success).toBe(true);
  });

  it("still type-checks the values this file owns", () => {
    // Closing the key set would be worth little if `legs: "two"` sailed past.
    expect(StageConfig.safeParse({ legs: "two" }).success).toBe(false);
    expect(StageConfig.safeParse({ legs: 0 }).success).toBe(false);
    expect(StageConfig.safeParse({ legs: 99 }).success).toBe(false);
    expect(StageConfig.safeParse({ mode: "mexicano" }).success).toBe(true);
    expect(StageConfig.safeParse({ mode: "conquian" }).success).toBe(false);
    expect(StageConfig.safeParse({ pools: { count: 4, extra: 1 } }).success).toBe(false);
    expect(StageConfig.safeParse({ h2h_scope: "group" }).success).toBe(false);
  });

  // Swiss Playoff's one new knob. The engine union is
  // `scheduling/swiss.ts`'s SwissConstraints.pairing; this is the only write
  // path that can reach it, so the union has to be spelled the same here.
  describe("swiss `pairing` (Swiss Playoff)", () => {
    it("accepts both engine pairing models and refuses anything else", () => {
      expect(StageConfig.safeParse({ pairing: "fold" }).success).toBe(true);
      expect(StageConfig.safeParse({ pairing: "rank_adjacent" }).success).toBe(true);
      expect(StageConfig.safeParse({ pairing: "rank-adjacent" }).success).toBe(false);
      expect(StageConfig.safeParse({ pairing: "hammes" }).success).toBe(false);
      expect(StageConfig.safeParse({ pairing: true }).success).toBe(false);
    });

    it("stays ABSENT when omitted — every existing swiss stage keeps fold pairing", () => {
      // The regression guard for the live stages that predate this key: an
      // omitted `pairing` must parse to undefined, NOT to a defaulted value
      // that the generator would then read as an opt-in. `swissGen` treats
      // anything but the literal "rank_adjacent" as fold.
      const r = StageConfig.safeParse({ rounds: 5 });
      expect(r.success).toBe(true);
      expect(r.data).not.toHaveProperty("pairing");
      expect((r.data as { pairing?: unknown }).pairing).toBeUndefined();
    });
  });

  it("leaves the shapes another authority owns unvalidated, deliberately", () => {
    // `points` is the engine's PointsRule; `rules` belongs to each sport
    // module's configSchema and declarations (validated by the usecase,
    // `stage-defaults.ts`). The KEY is real, the SHAPE is not this file's to
    // enforce — a second copy here is how two shapes of one fact drift apart.
    expect(StageConfig.safeParse({ points: { anything: true } }).success).toBe(true);
    expect(StageConfig.safeParse({ rules: { anything: "whatever" } }).success).toBe(true);
  });

  it("refuses a top-level stage decider LOUDLY, naming where it moved (W2c Task 12, greenfield: no shim)", () => {
    let checked = 0;
    for (const key of ["shootout", "extraTime"]) {
      for (const value of [true, false, { enabled: true, halfMinutes: 15 }, null]) {
        const r = StageConfig.safeParse({ [key]: value });
        expect(r.success, `${key}: ${JSON.stringify(value)}`).toBe(false);
        expect(r.error?.issues.map((i) => i.message), key).toEqual([STAGE_DECIDER_MOVED]);
        expect(r.error?.issues[0]?.path, key).toEqual([key]);
        checked++;
      }
    }
    expect(checked).toBe(8);
    expect(STAGE_DECIDER_MOVED, "the message says where it went").toContain("config.rules");
  });

  // W2c Task 13b finish-up (R-13b-1): the refused set is every whole decider any sport DECLARES (the engine's
  // `deciderKeysFor`, the create door's own set), not the two keys the retired overlay read. Expected values come from
  // the engine's declarations; both schemas a client sends a stage's config through are swept.
  it("R-13b-1 refuses EVERY decider the engine declares at the top level, by name, on StageConfig and PutStageRules (counted)", () => {
    const deciders = [...new Set((builtinModules as readonly AnySportModule[]).flatMap((m) => deciderKeysFor(m, null, null)))];
    expect(deciders, "the premise: deciders beyond the two named before").toEqual(expect.arrayContaining(["superOver", "tiebreakRungs", "tieBoard", "overtime"]));
    let checked = 0;
    for (const key of deciders) {
      for (const value of [true, false, [], null]) {
        const stage = StageConfig.safeParse({ [key]: value });
        expect(stage.success, `StageConfig ${key}: ${JSON.stringify(value)}`).toBe(false);
        expect(stage.error?.issues.map((i) => i.message), `StageConfig ${key}`).toEqual([STAGE_DECIDER_MOVED]);
        expect(stage.error?.issues[0]?.path, `StageConfig ${key}`).toEqual([key]);
        const put = PutStageRules.safeParse({ rules: {}, [key]: value });
        expect(put.success, `PutStageRules ${key}`).toBe(false);
        expect(put.error?.issues.map((i) => i.message), `PutStageRules ${key}`).toEqual([STAGE_DECIDER_MOVED]);
        expect(put.error?.issues[0]?.path, `PutStageRules ${key}`).toEqual([key]);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every decider x four values").toBe(deciders.length * 4);
    // The positive pair: under `rules` the same keys parse (their values are the sport's to judge, downstream).
    const underRules = { rules: Object.fromEntries(deciders.map((k) => [k, false])) };
    expect(StageConfig.safeParse(underRules).success).toBe(true);
    expect(PutStageRules.safeParse(underRules).success).toBe(true);
  });

  it("defaults to {} so an omitted config is still a valid stage", () => {
    const r = CreateStage.safeParse({ seq: 1, kind: "league", name: "League" });
    expect(r.success).toBe(true);
    expect(r.data?.config).toEqual({});
  });
});
