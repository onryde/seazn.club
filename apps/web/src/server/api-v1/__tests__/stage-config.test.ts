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
import { CreateStage, StageConfig } from "@/server/api-v1/schemas";

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
  shootout: { bestOf: 5 },
  extraTime: { halves: 2, minutes: 15 },
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

  it("leaves the shapes another authority owns unvalidated, deliberately", () => {
    // `points` is the engine's PointsRule; shootout/extraTime belong to each
    // sport module's configSchema. The KEY is real, the SHAPE is not this
    // file's to enforce — a second copy here is how two shapes of one fact
    // drift apart. If these ever start failing, the shape moved home.
    expect(StageConfig.safeParse({ points: { anything: true } }).success).toBe(true);
    expect(StageConfig.safeParse({ shootout: "whatever" }).success).toBe(true);
  });

  it("defaults to {} so an omitted config is still a valid stage", () => {
    const r = CreateStage.safeParse({ seq: 1, kind: "league", name: "League" });
    expect(r.success).toBe(true);
    expect(r.data?.config).toEqual({});
  });
});
