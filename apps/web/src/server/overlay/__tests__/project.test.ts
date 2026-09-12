// `projectOverlayLiveData` — the folded state → the overlay's wire contract
// (design §3.2). Every case folds a SHORT REAL ledger through the REAL module
// (`foldMatch`, packages/engine/src/core/events.ts, with
// `defaultLineupPair`/`makeEnvelope` from `@seazn/engine/testkit`) — the same
// builder Task 2's overlay-model.test.ts uses — so the two numbers the
// overlay needs are read off the state the ENGINE produced, never off a
// hand-typed object that happens to have the right keys.
//
// Pure: no DB. `FoldedFixture` is assembled from the fold's own outputs.
//
// RE-PINNED against the tree 2026-09-09 (the brief's stream shapes were a
// hypothesis; four of them were wrong and are corrected here, each noted at
// its use site): `FootballPeriod` is `{ phase, addedMinutes?, at? }` not
// `{ to, at }` (football.ts:264-283); `CricketClose.reason` has no
// "declared" member (cricket.ts:249-253); `cricket.toss` must PRECEDE
// `core.start` ("toss must precede core.start", cricket.ts:3511); and
// `closeOpenInnings` throws `no innings in progress` (cricket.ts:951) unless
// a delivery has actually opened one.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { projectOverlayLiveData } from "../project";
import type { FoldedFixture } from "@/server/engine-db/fold";

const moduleFor = (key: string) => {
  const m = builtinModules.find((mod) => mod.key === key);
  if (!m) throw new Error(`no builtin module for "${key}"`);
  return m;
};

/** The raw config every builtin module is exercised under across this repo.
 *  `parse({})` is NOT universal — `generic`'s schema requires `resultMode` and
 *  `allowDraws` with no defaults, so the brief's `configSchema.parse({})`
 *  threw a ZodError on the all-sports sweep. `SIM_CONFIGS`
 *  (`@seazn/engine/testkit`, simulation.ts:91) is the engine's OWN declaration
 *  of a valid raw config per module — the same one chaos.test.ts and
 *  stoppages.test.ts use — so the numbers this file asserts move with it
 *  instead of freezing yesterday's constants. */
const cfgFor = (key: string) => moduleFor(key).configSchema.parse(SIM_CONFIGS[key] ?? {});

const WALL = "2026-09-07T14:00:00.000Z";

/** Folds `stream` through the real module and returns what foldFixture would.
 *  A stream entry may carry its OWN `recordedAt` as a third slot — without
 *  that, every envelope shares one wall time and the anchor-pairing bug of
 *  review finding I2 is unwitnessable (any envelope gives the same answer). */
function folded(
  key: string,
  stream: readonly (readonly [string, unknown, string?])[],
  recordedAt = WALL,
): FoldedFixture {
  const mod = moduleFor(key);
  const cfg = cfgFor(key);
  const lineups = defaultLineupPair(mod.positions);
  const events: EventEnvelope[] = stream.map(([type, p, at], i) => ({
    ...makeEnvelope(i, { type, payload: p } as never),
    recordedAt: at ?? recordedAt,
  }));
  const state = foldMatch(mod as never, cfg as never, lineups, events);
  const m = mod as unknown as {
    summary: (s: unknown) => FoldedFixture["summary"];
    outcome?: (s: unknown) => FoldedFixture["outcome"];
  };
  return {
    fixtureId: "fx-1",
    lastSeq: events.length,
    state,
    summary: m.summary(state),
    outcome: m.outcome ? m.outcome(state) : null,
    active: events,
  };
}

/** A FoldedFixture whose STATE is written here rather than folded — used only
 *  where a real fold cannot reach the state cheaply (an extra-time phase needs
 *  a whole drawn match) or where the point IS a state the engine never
 *  produces (a clock-bearing state with no cfg). The envelope carries the
 *  matching stamp so `anchorWallMs` resolves it exactly as it would a real one. */
function handMade(state: { cfg?: unknown; phase: string; asOf: { period: string; elapsed: number } }): FoldedFixture {
  const envelope = {
    ...makeEnvelope(0, { type: "core.start", payload: { at: state.asOf } } as never),
    recordedAt: WALL,
  };
  return {
    fixtureId: "fx-hand",
    lastSeq: 1,
    state,
    summary: { headline: "x" } as FoldedFixture["summary"],
    outcome: null,
    active: [envelope],
  };
}

const ROW = (last_seq: number | null, status = "in_play") => ({
  status,
  summary: { headline: "x" },
  outcome: null,
  last_seq,
});

/** The testkit's HOME entrant id. `CricketToss` (cricket.ts:240) is
 *  `strictObject { wonBy: EntrantId, elected: "bat"|"bowl" }`, and `EntrantId`
 *  is a bare non-empty string (core/types.ts:10) — so a wrong value is
 *  ACCEPTED by the schema and only refused by `sideOf`. Read it off
 *  `defaultLineupPair` rather than typing "H". */
const HOME_ID: string = (
  defaultLineupPair(moduleFor("cricket").positions) as { home: { entrantId: string } }
).home.entrantId;

/** Deliveries. A read fold is NON-strict (`foldFixture` passes no options), so
 *  over/ballInOver, the bowler quota and striker rotation are all tolerant —
 *  only "bowler is in the fielding lineup" (cricket.ts:1298) is unconditional.
 *  The rotation below is still written honestly so the stream is a real card. */
const ball = (
  over: number,
  ballInOver: number,
  striker: string,
  nonStriker: string,
  bowler: string,
  runs: number,
  boundary?: 4 | 6,
) =>
  [
    "cricket.ball",
    {
      over,
      ballInOver,
      striker,
      nonStriker,
      bowler,
      runs: { bat: runs },
      ...(boundary ? { boundary } : {}),
    },
  ] as const;

describe("projectOverlayLiveData", () => {
  it("carries the row's snapshot fields and the venue zone, and lastSeq from the ROW (one authority: match_states)", () => {
    const out = projectOverlayLiveData({ row: ROW(7), folded: null, venueTz: "Asia/Kolkata" });
    expect(out.status).toBe("in_play");
    expect(out.summary).toEqual({ headline: "x" });
    expect(out.outcome).toBeNull();
    expect(out.lastSeq).toBe(7);
    expect(out.venueTz).toBe("Asia/Kolkata");
    expect(out.clock).toBeUndefined();
    expect(out.cricket).toBeUndefined();
    // W2 — ALWAYS an array. The overlay reads `data.recent` every poll, and an
    // absent field and an empty one would be two shapes for one fact.
    expect(out.recent).toEqual([]);
  });

  it("W2: `recent` is passed IN and reaches the wire — naming a person needs the line-up, which this projection cannot read", () => {
    const recent = [
      { seq: 4, type: "football.goal", at: WALL, payload: { side: 0 as const, person: { name: "A. One", masked: true } } },
    ];
    const out = projectOverlayLiveData({ row: ROW(4), folded: null, venueTz: "UTC", recent });
    expect(out.recent).toEqual(recent);
  });

  it("football: a stamped goal in a running half anchors the clock at the stamp, on the last event's wall time", () => {
    const f = folded("football", [
      ["core.start", {}],
      ["football.goal", { by: "H", at: { period: "H1", elapsed: 761 } }],
    ]);
    const out = projectOverlayLiveData({ row: ROW(2), folded: f, venueTz: "UTC" });
    expect(out.clock).toEqual({
      phase: "H1",
      anchorSeconds: 761,
      anchorAtWallMs: Date.parse("2026-09-07T14:00:00.000Z"),
      // F16 — the half's nominal length, from the cfg the fixture was folded
      // under. Derived from the module's OWN parsed config, never the literal
      // 45: the ceiling has to move when the competition's does.
      nominalSeconds: (cfgFor("football") as { halfMinutes: number }).halfMinutes * 60,
    });
    expect(out.cricket).toBeUndefined();
  });

  it("football: between periods the clock is ABSENT (the stage holds the last value), never a stale stamp", () => {
    // H1's closing whistle carries an H1 stamp; `applyPeriod`'s "HT" arm then
    // pushes `state.phase` to "H2" (football.ts:1548-1551) while `asOf` stays
    // at the whistle's own H1 stamp (:2525) — so the stamp names a phase the
    // match has left, which is exactly the guard `footballPosition` applies.
    const f = folded("football", [
      ["core.start", {}],
      ["football.goal", { by: "H", at: { period: "H1", elapsed: 761 } }],
      ["football.period", { phase: "HT", at: { period: "H1", elapsed: 2700 } }],
    ]);
    const out = projectOverlayLiveData({ row: ROW(3), folded: f, venueTz: "UTC" });
    expect(out.clock, "a stale clock on air is worse than no clock").toBeUndefined();
  });

  it("football: an UNSTAMPED event after the stamped one does not drag the anchor forward", () => {
    // Review 2026-09-09 (I2). `applyEvent` only writes `asOf` for an event
    // carrying an `at` (football.ts:2522), so this card leaves `asOf` at the
    // goal's 761 while being the chronologically last envelope. Anchoring on
    // the last envelope would pair 761 with the CARD's wall time, 90 s later —
    // and the stage's `anchorSeconds + (now - anchorAtWallMs)` would jump
    // BACKWARD by 90 s the moment the card was recorded.
    const goalWall = "2026-09-07T14:00:00.000Z";
    const cardWall = "2026-09-07T14:01:30.000Z";
    const f = folded("football", [
      ["core.start", {}, goalWall],
      ["football.goal", { by: "H", at: { period: "H1", elapsed: 761 } }, goalWall],
      ["football.card", { by: "A", color: "yellow" }, cardWall],
    ]);
    const out = projectOverlayLiveData({ row: ROW(3), folded: f, venueTz: "UTC" });
    expect(out.clock).toEqual({
      phase: "H1",
      anchorSeconds: 761,
      anchorAtWallMs: Date.parse(goalWall),
      nominalSeconds: (cfgFor("football") as { halfMinutes: number }).halfMinutes * 60,
    });
    // The assertion that actually witnesses the regression: the wrong answer
    // is a DIFFERENT constant, not a missing field.
    expect(out.clock!.anchorAtWallMs).not.toBe(Date.parse(cardWall));
  });

  it("football: a stream nothing stamped carries no clock", () => {
    const f = folded("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
    ]);
    expect(projectOverlayLiveData({ row: ROW(2), folded: f, venueTz: "UTC" }).clock).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // F16 — the period's nominal length, so the stage has a ceiling to hold the
  // clock against (product ruling 2026-09-10, `_THEMES.md` §3). Driven live, a
  // fixture left `in_play` displayed `1205:25`.
  //
  // The length IS knowable, which the brief left open: BOTH clock-bearing
  // kernels carry their resolved cfg ON THE STATE — `FootballState.cfg`
  // (football.ts:564) and `PeriodState.cfg` (period/kernel.ts:530) — and both
  // derive every phase length from REQUIRED scalars: `cfg.halfMinutes` /
  // `cfg.extraTime.halfMinutes` (football.ts:773-788) and
  // `cfg.periods.minutes` / `cfg.overtime.minutes` (period/kernel.ts:760-772).
  // So this reads the state's own cfg by SHAPE, exactly as `clockOf` and
  // `cricketOf` read the rest of it, and every number below is derived from the
  // module's own parsed config rather than typed in.
  // -------------------------------------------------------------------------
  it("football: the nominal comes from the cfg's own halfMinutes, not a hardcoded 45", () => {
    const halfMinutes = (cfgFor("football") as { halfMinutes: number }).halfMinutes;
    const f = folded("football", [
      ["core.start", {}],
      ["football.goal", { by: "H", at: { period: "H1", elapsed: 761 } }],
    ]);
    const out = projectOverlayLiveData({ row: ROW(2), folded: f, venueTz: "UTC" });
    expect(out.clock!.nominalSeconds).toBe(halfMinutes * 60);
    // The witness that it is READ and not defaulted: fold the SAME stream under
    // a competition that plays 30-minute halves — the module's own schema parses
    // it, so this is a real cfg, not an invented one — and the ceiling moves.
    const mod = moduleFor("football");
    const shortCfg = mod.configSchema.parse({ halfMinutes: 30 }) as { halfMinutes: number };
    expect(shortCfg.halfMinutes, "the schema ignored the override").toBe(30);
    const shortState = { ...(f.state as object), cfg: shortCfg };
    const short = projectOverlayLiveData({ row: ROW(2), folded: { ...f, state: shortState }, venueTz: "UTC" });
    expect(short.clock!.nominalSeconds).toBe(30 * 60);
    expect(short.clock!.nominalSeconds).not.toBe(out.clock!.nominalSeconds);
  });

  it.each(["hockey", "icehockey"])(
    "%s: the nominal comes from the period kernel's own periods.minutes",
    (key) => {
      const minutes = (cfgFor(key) as { periods: { minutes: number } }).periods.minutes;
      const phase = (cfgFor(key) as { periods: { count: number } }).periods.count === 4 ? "Q1" : "P1";
      const f = folded(key, [
        ["core.start", {}],
        [`${key}.goal`, { by: "H", at: { period: phase, elapsed: 300 } }],
      ]);
      const out = projectOverlayLiveData({ row: ROW(2), folded: f, venueTz: "UTC" });
      expect(out.clock, `${key} produced no clock at all`).toBeDefined();
      expect(out.clock!.phase).toBe(phase);
      expect(out.clock!.nominalSeconds).toBe(minutes * 60);
    },
  );

  it("an overtime phase takes the OVERTIME scalar, not the regulation one", () => {
    // Reaching ET/OT through a real fold means playing a whole drawn match, so
    // the STATE here is assembled by hand — but the cfg is the module's own
    // parsed config, which is where both numbers come from, and the two are
    // asserted DIFFERENT so neither can be passing on the other's value.
    const football = moduleFor("football").configSchema.parse({
      halfMinutes: 45,
      extraTime: { enabled: true, halfMinutes: 15 },
    }) as { halfMinutes: number; extraTime: { halfMinutes: number } };
    expect(football.extraTime.halfMinutes).not.toBe(football.halfMinutes);
    const et = projectOverlayLiveData({
      row: ROW(1),
      folded: handMade({ cfg: football, phase: "ET_H1", asOf: { period: "ET_H1", elapsed: 120 } }),
      venueTz: "UTC",
    });
    expect(et.clock!.nominalSeconds).toBe(football.extraTime.halfMinutes * 60);
    expect(et.clock!.nominalSeconds).not.toBe(football.halfMinutes * 60);

    const ice = moduleFor("icehockey").configSchema.parse({}) as {
      periods: { minutes: number };
      overtime: { minutes: number } | null;
    };
    expect(ice.overtime, "icehockey's preset no longer declares an overtime — re-pin this case").not.toBeNull();
    expect(ice.overtime!.minutes).not.toBe(ice.periods.minutes);
    const ot = projectOverlayLiveData({
      row: ROW(1),
      folded: handMade({ cfg: ice, phase: "OT", asOf: { period: "OT", elapsed: 60 } }),
      venueTz: "UTC",
    });
    expect(ot.clock!.nominalSeconds).toBe(ice.overtime!.minutes * 60);
    expect(ot.clock!.nominalSeconds).not.toBe(ice.periods.minutes * 60);
  });

  it("a state carrying no readable cfg still carries its clock — WITHOUT a ceiling", () => {
    // The documented fallback, and the reason the stage HOLDS rather than
    // ticking when this field is absent. Unreachable for the two kernels that
    // produce a clock today (both carry `state.cfg`, asserted above); it exists
    // so a twelfth sport that grows `phase`/`asOf` without a recognisable cfg
    // cannot silently start counting to 1205:25.
    const out = projectOverlayLiveData({
      row: ROW(1),
      folded: handMade({ phase: "H1", asOf: { period: "H1", elapsed: 761 } }),
      venueTz: "UTC",
    });
    expect(out.clock, "the clock itself must survive — this is a missing ceiling, not a missing clock").toBeDefined();
    expect(out.clock!.anchorSeconds).toBe(761);
    expect(out.clock!.nominalSeconds).toBeUndefined();
  });

  it("cricket: every innings' runs, wickets, legalBalls and ballsLimit, from the state — the quota derived from the cfg, never typed here", () => {
    const quota = (cfgFor("cricket") as { ballsPerInnings: number }).ballsPerInnings;
    const f = folded("cricket", [
      // The toss comes FIRST: `applyToss` refuses any phase but "pre".
      ["cricket.toss", { wonBy: HOME_ID, elected: "bat" }],
      ["core.start", {}],
      ball(0, 1, "H-p1", "H-p2", "A-p1", 4, 4),
      ball(0, 2, "H-p1", "H-p2", "A-p1", 0),
      ball(0, 3, "H-p1", "H-p2", "A-p1", 1),
      ball(0, 4, "H-p2", "H-p1", "A-p1", 6, 6),
      ball(0, 5, "H-p2", "H-p1", "A-p1", 0),
      ball(0, 6, "H-p2", "H-p1", "A-p1", 2),
      // No `reason: "declared"` — `CricketClose.reason` is a closed enum that
      // does not contain it (declaring is its own event, and is two-innings
      // only). The bare close is the honest "innings over" marker here.
      ["cricket.innings.close", {}],
      ball(0, 1, "A-p1", "A-p2", "H-p1", 1),
    ]);
    const out = projectOverlayLiveData({ row: ROW(f.lastSeq), folded: f, venueTz: "UTC" });
    expect(out.cricket).toBeDefined();
    expect(out.cricket!.innings).toHaveLength(2);
    expect(out.cricket!.innings[0]).toMatchObject({
      runs: 13,
      wickets: 0,
      legalBalls: 6,
      ballsLimit: quota,
    });
    expect(out.cricket!.innings[1]).toMatchObject({
      runs: 1,
      wickets: 0,
      legalBalls: 1,
      ballsLimit: quota,
    });
    // The number the chase line renders — and it differs from the runs, so a
    // transposed pair cannot pass.
    expect(out.cricket!.innings[1]!.ballsLimit! - out.cricket!.innings[1]!.legalBalls).toBe(
      quota - 1,
    );
    expect(out.clock).toBeUndefined();
  });

  it("cricket: a DLS revision moves ballsLimit with the target (the case that makes it a live number)", () => {
    // `CricketRevise` (cricket.ts:259-266) is `strictObject { oversPerSide?,
    // target? }` with a refine — there is no `ballsLimit` and no `source`.
    // The limit the engine derives is `oversPerSide × cfg.ballsPerOver`
    // (cricket.ts:1025) — read from the module's own config, never the
    // literal 60. Both innings must EXIST for the revise to land on the
    // second, and an innings is created by its first delivery
    // (`createInnings`, cricket.ts:796) — hence one ball on each side.
    const f = folded("cricket", [
      ["cricket.toss", { wonBy: HOME_ID, elected: "bat" }],
      ["core.start", {}],
      ball(0, 1, "H-p1", "H-p2", "A-p1", 4, 4),
      ["cricket.innings.close", {}],
      ball(0, 1, "A-p1", "A-p2", "H-p1", 1),
      ["cricket.revise", { oversPerSide: 10, target: 91 }],
    ]);
    const bpo = (cfgFor("cricket") as { ballsPerOver: number }).ballsPerOver;
    const out = projectOverlayLiveData({ row: ROW(f.lastSeq), folded: f, venueTz: "UTC" });
    expect(out.cricket!.innings[1]!.ballsLimit).toBe(10 * bpo);
    expect(out.cricket!.innings[1]!.ballsLimit).not.toBe(out.cricket!.innings[0]!.ballsLimit);
  });

  it("every other sport: neither clock nor cricket, by shape, not by a sport-key branch", () => {
    // Derived from `builtinModules`, not a hand-typed list: the brief named
    // seven of the nine non-football/cricket modules and silently dropped
    // `icehockey` and `hockey` — the two that, being period sports, are the
    // most likely to grow a `phase`/`asOf` pair and land in `clockOf`.
    const others = builtinModules
      .map((m) => m.key)
      .filter((key) => key !== "football" && key !== "cricket");
    expect(others.length, "a new sport must join this sweep by construction").toBe(
      builtinModules.length - 2,
    );
    for (const key of others) {
      const f = folded(key, [["core.start", {}]]);
      const out = projectOverlayLiveData({ row: ROW(1), folded: f, venueTz: "UTC" });
      expect(out.clock, key).toBeUndefined();
      expect(out.cricket, key).toBeUndefined();
    }
  });

  it("highlights from the cricket fold ride on the wire for the ended card", () => {
    const highlights = {
      batter: { name: "Kohli", line: "78 (42)", detail: "SR 185.7" },
      bowler: { name: "Bumrah", line: "3/24", detail: "Econ 6.0" },
    };
    const out = projectOverlayLiveData({
      row: ROW(1),
      folded: null,
      venueTz: "UTC",
      highlights,
    });
    expect(out.highlights).toEqual(highlights);
    expect(
      projectOverlayLiveData({ row: ROW(1), folded: null, venueTz: "UTC", highlights: null }).highlights,
    ).toBeUndefined();
  });
});
