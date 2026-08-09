// S3/W4b (#426) — the `core.lineup.*` family and its seam with the fold.
//
// The kernel owns these events exactly as it owns core.void / core.suspend:
// it validates them, folds them into SquadState, and NEVER forwards them to
// module.apply. One implementation therefore serves all eleven sports, no
// module state moves, and no frozen golden shifts.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import {
  CORE_EVENT_SCHEMAS,
  foldMatch,
  foldMatchWithStoppage,
  isCoreEventType,
  type EventEnvelope,
  type FoldContext,
  type FoldableModule,
} from "./events.ts";
import {
  DEFAULT_LINEUP_POLICY,
  LINEUP_EVENT_SCHEMAS,
  isLineupEventType,
  personsAtPosition,
  type LineupEventType,
  type LineupPolicy,
  type SquadState,
} from "./lineup.ts";
import type { LineupPair } from "./types.ts";

// ---------------------------------------------------------------------------
// A toy sport with a keeper, so "who is in goal" is a question the module can
// be caught answering (or failing to answer) mid-fold.
// ---------------------------------------------------------------------------

interface ToyCfg {
  readonly policy?: LineupPolicy;
}

interface ToyState {
  readonly seen: readonly string[];
  /** What the module was told about the keeper when each event arrived. */
  readonly keeperLog: readonly string[];
  /** Snapshots handed over by the kernel through `onLineup`. */
  readonly squadSnapshots: number;
  readonly goals: number;
  readonly stopped: boolean;
}

const lineups: LineupPair = {
  home: {
    entrantId: "H",
    slots: [
      { personId: "h-gk", positionKey: "GK", slot: "starting", orderNo: 1 },
      { personId: "h-fw", positionKey: "FW", slot: "starting", orderNo: 2 },
      { personId: "h-sub-gk", positionKey: "GK", slot: "bench", orderNo: 3 },
    ],
  },
  away: {
    entrantId: "A",
    slots: [{ personId: "a-gk", positionKey: "GK", slot: "starting", orderNo: 1 }],
  },
};

/** Builds a module; `over` swaps in the optional hooks under test. */
function toy(over: Partial<FoldableModule<ToyCfg, ToyState>> = {}): FoldableModule<ToyCfg, ToyState> {
  return {
    init: () => ({ seen: [], keeperLog: [], squadSnapshots: 0, goals: 0, stopped: false }),
    apply(state, event: EventEnvelope, ctx?: FoldContext) {
      const keeper = ctx?.squads === undefined ? "no-ctx" : (personsAtPosition(ctx.squads.home, "GK")[0] ?? "none");
      const next: ToyState = {
        ...state,
        seen: [...state.seen, event.type],
        keeperLog: [...state.keeperLog, keeper],
      };
      if (event.type === "toy.goal") return { ...next, goals: next.goals + 1 };
      if (event.type === "toy.end") return { ...next, stopped: true };
      return next;
    },
    outcome: (state) => (state.stopped ? { kind: "win", winner: "H", loser: "A" } : null),
    ...over,
  };
}

const cfg: ToyCfg = {};
let n = 0;
const env = (seq: number, type: string, payload: unknown = {}): EventEnvelope => ({
  id: `e-${seq}-${(n += 1)}`,
  fixtureId: "f1",
  seq,
  type,
  payload,
  recordedAt: "2026-08-09T10:00:00Z",
  recordedBy: null,
});

const subGk = (seq: number, off = "h-gk", on = "h-sub-gk"): EventEnvelope =>
  env(seq, "core.lineup.substitution", {
    side: "H",
    off,
    on: { personId: on, positionKey: "GK", slot: "starting", orderNo: 3 },
  });

// ---------------------------------------------------------------------------
// The family is registered in the kernel's own schema map
// ---------------------------------------------------------------------------

describe("core.lineup.* registration", () => {
  it("registers exactly the five lineup types with the kernel", () => {
    expect(Object.keys(LINEUP_EVENT_SCHEMAS).sort()).toEqual([
      "core.lineup.entry",
      "core.lineup.position",
      "core.lineup.replacement",
      "core.lineup.retirement",
      "core.lineup.substitution",
    ]);
    for (const type of Object.keys(LINEUP_EVENT_SCHEMAS)) {
      // The kernel validates them (validateCoreEvent dispatches off this map),
      // which is what makes them kernel-owned rather than sport-owned.
      expect(CORE_EVENT_SCHEMAS, `${type} missing from CORE_EVENT_SCHEMAS`).toHaveProperty([type]);
      expect(isCoreEventType(type)).toBe(true);
      expect(isLineupEventType(type)).toBe(true);
    }
    expect(isLineupEventType("core.suspend")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE SWALLOWED-SIBLING TEST.
//
// The hazard this closes: a family modelled as one `z.union` matches
// FIRST-BRANCH-WINS, so a sibling whose shape is a compatible prefix of an
// earlier branch is silently parsed as that earlier branch and folds as the
// wrong event. Sibling TYPES plus `z.strictObject` make that unrepresentable —
// but "make it unrepresentable" is an argument, and this is the proof. Every
// payload must parse under its own type and be REFUSED by all four others.
// ---------------------------------------------------------------------------

const SAMPLE: Record<LineupEventType, unknown> = {
  "core.lineup.substitution": {
    side: "H",
    off: "h-gk",
    on: { personId: "h-sub-gk", slot: "starting", orderNo: 3 },
  },
  "core.lineup.replacement": {
    side: "H",
    off: "h-gk",
    on: { personId: "h-sub-gk", slot: "starting", orderNo: 3 },
    exemption: "concussion",
  },
  "core.lineup.position": { side: "H", personId: "h-fw", positionKey: "GK" },
  "core.lineup.retirement": { side: "H", personId: "h-fw", reason: "injury" },
  "core.lineup.entry": {
    side: "H",
    on: { personId: "h-sub-gk", slot: "starting", orderNo: 3 },
  },
};

describe("core.lineup.* discriminates its siblings", () => {
  const types = Object.keys(LINEUP_EVENT_SCHEMAS) as LineupEventType[];

  it.each(types)("%s round-trips to itself", (type) => {
    const parsed = LINEUP_EVENT_SCHEMAS[type].safeParse(SAMPLE[type]);
    expect(parsed.success, `own payload rejected: ${JSON.stringify(parsed)}`).toBe(true);
  });

  it.each(types)("%s does not swallow any sibling's payload", (type) => {
    for (const other of types) {
      if (other === type) continue;
      const parsed = LINEUP_EVENT_SCHEMAS[type].safeParse(SAMPLE[other]);
      expect(parsed.success, `${type} accepted a ${other} payload`).toBe(false);
    }
  });

  it("refuses an unknown key rather than dropping it", () => {
    // z.object would strip `kind` and fold a mis-typed event as if it were
    // well formed; strictObject is what makes the matrix above hold.
    const parsed = LINEUP_EVENT_SCHEMAS["core.lineup.retirement"].safeParse({
      ...(SAMPLE["core.lineup.retirement"] as object),
      kind: "substitution",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a malformed lineup payload through the kernel's own validator", () => {
    expect(() => foldMatch(toy(), cfg, lineups, [env(0, "core.lineup.retirement", { side: "H" })])).toThrow(
      EngineError,
    );
  });
});

// ---------------------------------------------------------------------------
// Routing: the kernel folds them, the module never sees them
// ---------------------------------------------------------------------------

describe("foldMatch routes core.lineup.* to the kernel", () => {
  it("never forwards a lineup event to module.apply", () => {
    const state = foldMatch(toy(), cfg, lineups, [
      env(0, "toy.goal"),
      subGk(1),
      env(2, "toy.goal"),
    ]);
    expect(state.seen).toEqual(["toy.goal", "toy.goal"]);
    expect(state.goals).toBe(2);
  });

  it("surfaces the final squads alongside state and stoppage", () => {
    const { state, stoppage, squads } = foldMatchWithStoppage(toy(), cfg, lineups, [subGk(0)]);
    expect(stoppage).toBeNull();
    expect(state.seen).toEqual([]);
    expect(personsAtPosition(squads.home, "GK")).toEqual(["h-sub-gk"]);
    // and the untouched side is still the one the team sheet named
    expect(personsAtPosition(squads.away, "GK")).toEqual(["a-gk"]);
  });

  it("accepts a lineup change while play is suspended", () => {
    // An injury stoppage is precisely when a replacement happens; refusing one
    // here would make the commonest substitution in the game unrecordable.
    const { squads, stoppage } = foldMatchWithStoppage(toy(), cfg, lineups, [
      env(0, "core.suspend", { reason: "injury" }),
      subGk(1),
      env(2, "core.resume"),
    ]);
    expect(stoppage).toBeNull();
    expect(personsAtPosition(squads.home, "GK")).toEqual(["h-sub-gk"]);
  });
});

// ---------------------------------------------------------------------------
// The two read paths a module gets
// ---------------------------------------------------------------------------

describe("module read paths", () => {
  it("names the keeper to apply() through FoldContext, mid-fold", () => {
    const state = foldMatch(toy(), cfg, lineups, [
      env(0, "toy.goal"),
      subGk(1),
      env(2, "toy.goal"),
    ]);
    // BY IDENTITY at both points: the starting keeper, then the substitute.
    expect(state.keeperLog).toEqual(["h-gk", "h-sub-gk"]);
  });

  it("calls the optional onLineup hook with the squads after each change", () => {
    const seenAt: number[] = [];
    const module = toy({
      onLineup(state: ToyState, squads: SquadState) {
        seenAt.push(personsAtPosition(squads.home, "GK").length);
        return { ...state, squadSnapshots: state.squadSnapshots + 1 };
      },
    });
    const state = foldMatch(module, cfg, lineups, [subGk(0)]);
    // Once at init (so a module's State can never disagree with the kernel's
    // squads) and once per accepted change.
    expect(state.squadSnapshots).toBe(2);
    expect(seenAt).toEqual([1, 1]);
  });

  it("leaves a module that declares neither hook completely unchanged", () => {
    const bare = foldMatch(toy(), cfg, lineups, [env(0, "toy.goal")]);
    expect(bare).toEqual({
      seen: ["toy.goal"],
      keeperLog: ["h-gk"],
      squadSnapshots: 0,
      goals: 1,
      stopped: false,
    });
  });

  it("does not call onLineup for a refused change", () => {
    let calls = 0;
    const module = toy({
      lineupPolicy: () => DEFAULT_LINEUP_POLICY,
      onLineup(state: ToyState) {
        calls += 1;
        return state;
      },
    });
    // h-fw was never substituted off, so bringing him "back" is structurally
    // impossible — he is already on the field.
    foldMatch(module, cfg, lineups, [
      env(0, "core.lineup.entry", {
        side: "H",
        on: { personId: "h-fw", slot: "starting", orderNo: 2 },
      }),
    ]);
    expect(calls).toBe(1); // init only
  });
});

// ---------------------------------------------------------------------------
// The §3.3 seam — a cfg-derived refusal is a write-path error and a replay no-op
// ---------------------------------------------------------------------------

describe("policy refusals across the strict/replay seam", () => {
  const returning: EventEnvelope[] = [
    subGk(0), // h-gk off, h-sub-gk on
    env(1, "core.lineup.substitution", {
      side: "H",
      off: "h-sub-gk",
      on: { personId: "h-gk", positionKey: "GK", slot: "starting", orderNo: 1 },
    }),
  ];

  it("refuses a forbidden return on the WRITE path, as LINEUP_INVALID", () => {
    const module = toy({ lineupPolicy: () => ({ ...DEFAULT_LINEUP_POLICY, reentry: "none" }) });
    try {
      foldMatch(module, cfg, lineups, returning, { strictFromSeq: 0 });
      expect.unreachable("a forbidden return must be refused on the write path");
    } catch (err) {
      expect(EngineError.is(err, "LINEUP_INVALID")).toBe(true);
      expect((err as EngineError).data).toMatchObject({ reason: "reentry-forbidden" });
    }
  });

  it("accepts the SAME stream on the write path when the variant permits it", () => {
    const module = toy({
      lineupPolicy: () => ({ ...DEFAULT_LINEUP_POLICY, reentry: "unlimited" }),
    });
    const { squads } = foldMatchWithStoppage(module, cfg, lineups, returning, { strictFromSeq: 0 });
    expect(personsAtPosition(squads.home, "GK")).toEqual(["h-gk"]);
  });

  it("does not throw on REPLAY, and still folds what was recorded", () => {
    // The organiser has since switched the variant to no-return. The fixture
    // was legal when it was scored, there is no event to void, and a throw
    // here would make every already-scored fixture in the division unreadable.
    const module = toy({ lineupPolicy: () => ({ ...DEFAULT_LINEUP_POLICY, reentry: "none" }) });
    const { squads } = foldMatchWithStoppage(module, cfg, lineups, returning);
    expect(personsAtPosition(squads.home, "GK")).toEqual(["h-gk"]);
  });

  it("does not throw on replay for a cap the variant has since lowered", () => {
    const module = toy({ lineupPolicy: () => ({ ...DEFAULT_LINEUP_POLICY, maxSubs: 0 }) });
    const { squads } = foldMatchWithStoppage(module, cfg, lineups, [subGk(0)]);
    expect(personsAtPosition(squads.home, "GK")).toEqual(["h-sub-gk"]);
  });

  it("tolerates a STRUCTURAL impossibility on replay as a no-op", () => {
    // Nothing cfg can change makes this coherent: h-sub-gk was never on the
    // field. Replay must still not throw — it must show the fixture.
    const { squads } = foldMatchWithStoppage(toy(), cfg, lineups, [
      env(0, "core.lineup.retirement", { side: "H", personId: "h-sub-gk" }),
    ]);
    expect(personsAtPosition(squads.home, "GK")).toEqual(["h-gk"]);
  });

  it("defaults to the kernel policy when a module declares none", () => {
    // No `lineupPolicy` hook at all — the eight modules that do not care. The
    // default forbids a return, so the write path refuses one.
    expect(() => foldMatch(toy(), cfg, lineups, returning, { strictFromSeq: 0 })).toThrow(
      EngineError,
    );
  });

  it("reads the policy from cfg, not from the module identity", () => {
    // Same module object, two variants, opposite verdicts — the proof that
    // ruling 2 is a cfg knob and not a per-sport constant.
    const module = toy({ lineupPolicy: (c: ToyCfg) => c.policy ?? DEFAULT_LINEUP_POLICY });
    const strict = { strictFromSeq: 0 };
    const permissive: ToyCfg = { policy: { ...DEFAULT_LINEUP_POLICY, reentry: "unlimited" } };
    expect(() => foldMatch(module, permissive, lineups, returning, strict)).not.toThrow();
    expect(() =>
      foldMatch(module, { policy: { ...DEFAULT_LINEUP_POLICY, reentry: "none" } }, lineups, returning, strict),
    ).toThrow(EngineError);
  });
});

describe("existing kernel guarantees still hold over the new family", () => {
  it("refuses a lineup change after the outcome is decided", () => {
    expect(() =>
      foldMatch(toy(), cfg, lineups, [env(0, "toy.end"), subGk(1)], { strictFromSeq: 0 }),
    ).toThrow(EngineError);
  });

  it("drops a voided lineup event before it reaches the squads", () => {
    const sub = subGk(0);
    const { squads } = foldMatchWithStoppage(toy(), cfg, lineups, [
      sub,
      { ...env(1, "core.void"), voids: sub.id },
    ]);
    expect(personsAtPosition(squads.home, "GK")).toEqual(["h-gk"]);
  });
});
