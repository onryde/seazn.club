// `buildOverlayRecent` — the surviving ledger tail → the overlay's `recent`
// window (stream overlay W2 Task 1, design §3.2).
//
// PURE: no DB. Every stream here is FOLDED THROUGH THE REAL MODULE before it is
// projected, so the engine itself vouches for every payload shape the
// projectors read. A hand-typed `{ boundary: 6 }` would prove only that this
// file can type an object; `foldMatch` refusing a stream is what proves
// `CricketBall.boundary` is really `4 | 6` and really lives at the top level.
//
// The window this projects is `FoldedFixture.active` — the stream `foldFixture`
// has ALREADY void-resolved (`fold.ts`: `active: resolveVoids(envelopes)`).
// `buildOverlayRecent` resolves again anyway, and the "a voided event is
// absent" case below is written against RAW envelopes so that guard is
// exercised rather than assumed: a caller holding an unresolved ledger must not
// publish a struck event.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import {
  buildOverlayRecent,
  diffClosedSets,
  nameCricketBundle,
  overlayCricketBundleIds,
  personIdsIn,
  recentWindow,
  replayDerived,
  type OverlayCricketBundleIds,
} from "../recent";
import { OVERLAY_RECENT_WINDOW, type RecentPerson } from "@/lib/overlay-recent-types";

const moduleFor = (key: string) => {
  const m = builtinModules.find((mod) => mod.key === key);
  if (!m) throw new Error(`no builtin module for "${key}"`);
  return m;
};
/** The engine's OWN declaration of a valid raw config per module — the same
 *  source `project.test.ts` uses, so these streams move with it. */
const cfgFor = (key: string) => moduleFor(key).configSchema.parse(SIM_CONFIGS[key] ?? {});

const WALL = "2026-09-11T09:00:00.000Z";
const SIDES: [string, string] = ["H", "A"];

/** Folds `stream` through the real module and hands back what `foldFixture`
 *  would put on `FoldedFixture.active`. Folding is not decoration: it is the
 *  assertion that each payload below is a shape the engine accepts. */
function active(key: string, stream: readonly (readonly [string, unknown])[]): EventEnvelope[] {
  const mod = moduleFor(key);
  const events: EventEnvelope[] = stream.map(([type, payload], i) => ({
    ...makeEnvelope(i + 1, { type, payload } as never),
    recordedAt: WALL,
  }));
  foldMatch(mod as never, cfgFor(key) as never, defaultLineupPair(mod.positions), events);
  return events;
}

/** A resolver that names two people and refuses everyone else — the shape the
 *  server one has (`readPublicLineups` knows the lineup and nobody else). */
const NAMED: Record<string, RecentPerson> = {
  "H-p1": { name: "H. One", masked: true },
  "A-p1": { name: "Away One", masked: false },
};
const personOf = (id: unknown): RecentPerson | undefined =>
  typeof id === "string" ? NAMED[id] : undefined;

const build = (key: string, stream: readonly (readonly [string, unknown])[], window?: number) =>
  buildOverlayRecent({ active: active(key, stream), sides: SIDES, personOf, window });

/** Cricket deliveries. A read fold is NON-strict, so rotation and quotas are
 *  tolerant; the stream is still written as a real card. */
/** `CricketWicket.bowlerCredited` is REQUIRED, not optional — the fold refused
 *  a wicket ball without it, which is exactly why these streams are folded. */
const ball = (
  over: number,
  ballInOver: number,
  striker: string,
  bowler: string,
  runs: number,
  extra?: Record<string, unknown>,
) =>
  [
    "cricket.ball",
    {
      over,
      ballInOver,
      striker,
      nonStriker: striker === "H-p1" ? "H-p2" : "H-p1",
      bowler,
      runs: { bat: runs },
      ...extra,
    },
  ] as const;

describe("recentWindow", () => {
  it("an empty ledger yields nothing", () => {
    expect(buildOverlayRecent({ active: [], sides: SIDES, personOf })).toEqual([]);
  });

  it("a ledger of nothing but kernel and line-up events yields nothing — the overlay has no moment to raise", () => {
    const out = build("football", [
      ["core.start", {}],
      ["core.note", { text: "kick-off delayed" }],
      // `core.lineup.substitution` is `{ side, off: PersonId, on: LineupSlot }`
      // — re-pinned against `LINEUP_EVENT_SCHEMAS`, which refused the brief's
      // `{ by, off, on }` outright.
      [
        "core.lineup.substitution",
        { side: "home", off: "H-p1", on: { personId: "H-p12", slot: "starting", orderNo: 1 } },
      ],
    ]);
    expect(out).toEqual([]);
  });

  it("keeps the LAST eight module events, oldest first, with the engine's own type string unmapped", () => {
    const goals = Array.from({ length: 12 }, (_, i) => ["football.goal", { by: i % 2 ? "A" : "H" }] as const);
    const out = build("football", [["core.start", {}], ...goals]);
    expect(out).toHaveLength(OVERLAY_RECENT_WINDOW);
    expect(out.map((e) => e.seq)).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
    expect(new Set(out.map((e) => e.type))).toEqual(new Set(["football.goal"]));
    expect(out.every((e) => e.at === WALL)).toBe(true);
  });

  it("`window` is a parameter, not a constant baked into the filter", () => {
    const goals = Array.from({ length: 5 }, () => ["football.goal", { by: "H" }] as const);
    expect(build("football", [["core.start", {}], ...goals], 2)).toHaveLength(2);
  });

  it("a VOIDED event is absent from the window, and so is the void itself", () => {
    // Raw envelopes, deliberately NOT pre-resolved: this is the guard that
    // stops a struck goal being published as a moment.
    const raw: EventEnvelope[] = [
      makeEnvelope(1, { type: "core.start", payload: {} } as never),
      makeEnvelope(2, { type: "football.goal", payload: { by: "H" } } as never),
      makeEnvelope(3, { type: "football.goal", payload: { by: "A" } } as never),
      makeEnvelope(4, { type: "core.void", payload: {} } as never, "e-3"),
    ];
    const out = buildOverlayRecent({ active: raw, sides: SIDES, personOf });
    expect(out.map((e) => e.seq)).toEqual([2]);
    expect(out.some((e) => e.type.startsWith("core."))).toBe(false);
  });
});

describe("the payload projection", () => {
  it("football: a goal carries the side it credits, the scorer and both flags; a card carries its colour", () => {
    const out = build("football", [
      ["core.start", {}],
      ["football.goal", { by: "H", scorer: "H-p1", penalty: true }],
      ["football.card", { by: "A", person: "A-p1", color: "yellow" }],
    ]);
    expect(out[0]).toMatchObject({
      type: "football.goal",
      payload: { side: 0, person: { name: "H. One", masked: true }, ownGoal: false, penalty: true },
    });
    expect(out[1]).toMatchObject({
      type: "football.card",
      payload: { side: 1, person: { name: "Away One", masked: false }, colour: "yellow" },
    });
  });

  it("period sports: the goal's `kind` rides beside it, and `og` reads as an own goal", () => {
    const out = build("hockey", [
      ["core.start", {}],
      ["hockey.goal", { by: "H", person: "H-p1", kind: "og" }],
      ["hockey.suspension.start", { by: "A", person: "A-p1", class: "green" }],
    ]);
    expect(out[0]!.payload).toMatchObject({ side: 0, kind: "og", ownGoal: true });
    expect(out[1]).toMatchObject({
      type: "hockey.suspension.start",
      payload: { side: 1, class: "green", person: { name: "Away One" } },
    });
  });

  it("cricket: a six, a wicket and a plain single project differently — and NONE of them names a side", () => {
    const out = build("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      ball(0, 1, "H-p1", "A-p1", 6, { boundary: 6 }),
      ball(0, 2, "H-p1", "A-p1", 1),
      ball(0, 3, "H-p2", "A-p1", 0, { wicket: { kind: "caught", out: "H-p2", fielder: "A-p2", bowlerCredited: true } }),
    ]);
    expect(out.map((e) => e.type)).toEqual([
      "cricket.toss",
      "cricket.ball",
      "cricket.ball",
      "cricket.ball",
    ]);
    expect(out[1]!.payload).toEqual({ runs: 6, boundary: 6 });
    expect(out[2]!.payload).toEqual({ runs: 1 });
    expect(out[3]!.payload).toMatchObject({ runs: 0, wicketKind: "caught" });
    // The dismissed batter, not the striker on the ball before.
    expect(out[3]!.payload.person).toBeUndefined(); // H-p2 is outside the resolver
    expect(out.every((e) => e.payload.side === undefined)).toBe(true);
  });

  it("cricket: the wicket names the DISMISSED batter — a RUN OUT, so it is not the striker", () => {
    // The striker and the dismissed batter are DIFFERENT PEOPLE here, and
    // deliberately: a run out is the ordinary case where they diverge. With
    // `out === striker` this assertion passes against a projector reading
    // either field, which is the shape a mutation sweep found and this case
    // exists to deny. Only the dismissed batter is in the resolver, so reading
    // the striker yields no name at all.
    const out = build("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      ball(0, 1, "H-p2", "A-p1", 0, {
        wicket: { kind: "runout", out: "H-p1", fielder: "A-p1", bowlerCredited: false },
      }),
    ]);
    expect(out.at(-1)!.payload).toMatchObject({ wicketKind: "runout" });
    expect(out.at(-1)!.payload.person).toEqual({ name: "H. One", masked: true });
  });

  it("tennis: the point credits a side, names its scorer and carries the shot type", () => {
    const out = build("tennis", [
      ["core.start", {}],
      ["tennis.point", { by: "H", scorer: "H-p1", meta: { kind: "ace" } }],
    ]);
    expect(out.at(-1)!.payload).toMatchObject({ side: 0, kind: "ace", person: { name: "H. One" } });
  });

  it("set-based sports: the side comes off `wonBy`, not `by`", () => {
    const out = build("badminton", [
      ["core.start", {}],
      ["badminton.rally", { wonBy: "A", scorer: "A-p1" }],
    ]);
    expect(out.at(-1)!.payload).toMatchObject({ side: 1, person: { name: "Away One" } });
  });

  it("an entrant id that is NEITHER side yields no side rather than a wrong one", () => {
    const raw = [makeEnvelope(1, { type: "football.goal", payload: { by: "someone-else" } } as never)];
    const out = buildOverlayRecent({ active: raw, sides: SIDES, personOf });
    expect(out.at(-1)!.payload.side).toBeUndefined();
  });

  it("a type with no projector is still CARRIED, with an empty payload — the client allowlist decides, not this table", () => {
    const out = build("football", [
      ["core.start", {}],
      ["football.shot", { by: "H", outcome: "saved" }],
    ]);
    expect(out.at(-1)).toMatchObject({ type: "football.shot", payload: {} });
  });

  it("a band-0 ledger degrades to the side alone — an absent person is ABSENT, never an empty name", () => {
    const out = build("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
    ]);
    expect(out.at(-1)!.payload).toEqual({ side: 0, ownGoal: false, penalty: false });
    expect("person" in out.at(-1)!.payload).toBe(false);
  });
});

describe("personIdsIn", () => {
  it("asks for exactly the ids the projectors read — no more (a privacy floor) and no fewer (a naming gap)", () => {
    const stream = active("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      ball(0, 1, "H-p2", "A-p1", 0, {
        wicket: { kind: "runout", out: "H-p1", fielder: "A-p1", bowlerCredited: false },
      }),
    ]);
    // The ball records a striker (H-p2), a non-striker, a bowler and a fielder;
    // only the DISMISSED batter (H-p1) is ever spoken, so only that id may be
    // looked up. Three of the four ids on this payload are wrong answers, and
    // each of them is a different person from the right one.
    expect(personIdsIn(recentWindow(stream), SIDES)).toEqual(["H-p1"]);
  });

  it("collects across the window and dedupes", () => {
    const stream = active("football", [
      ["core.start", {}],
      ["football.goal", { by: "H", scorer: "H-p1" }],
      ["football.card", { by: "A", person: "A-p1" , color: "red" }],
      ["football.goal", { by: "H", scorer: "H-p1" }],
    ]);
    expect(personIdsIn(recentWindow(stream), SIDES).sort()).toEqual(["A-p1", "H-p1"]);
  });

  it("a ledger that names nobody asks for nothing — the server skips the person read entirely", () => {
    const stream = active("football", [["core.start", {}], ["football.goal", { by: "H" }]]);
    expect(personIdsIn(recentWindow(stream), SIDES)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Step 7 — `derived`: the two facts the ledger does not record.
//
// Every expectation below is DERIVED FROM THE ENGINE, never typed as a
// constant: the streams are driven to a state and the module is then asked what
// it thinks. A table of "a tennis set is 6 games" written here would freeze
// today's rules into a test that cannot witness tomorrow's variant.
// ---------------------------------------------------------------------------

/** Replays `stream` exactly as the loader does and returns the window with its
 *  derived annotations attached. */
function derivedOf(key: string, stream: readonly (readonly [string, unknown])[], window?: number) {
  const mod = moduleFor(key);
  const events = active(key, stream);
  const replay = replayDerived({
    sportKey: key,
    module: mod as never,
    cfg: cfgFor(key) as never,
    lineups: defaultLineupPair(mod.positions),
    active: events,
    window,
  });
  return {
    replay,
    events: buildOverlayRecent({
      active: events,
      sides: SIDES,
      personOf,
      window,
      derived: replay.bySeq,
    }),
  };
}

/** Points until `stop(n)` says enough — the engine decides when, not a literal. */
const points = (n: number, by: string) =>
  Array.from({ length: n }, () => ["badminton.rally", { wonBy: by }] as const);

describe("diffClosedSets", () => {
  it("returns nothing when either side has no sets at all", () => {
    expect(diffClosedSets(null, null, "badminton")).toBeUndefined();
    expect(diffClosedSets({ detail: {} }, { detail: {} }, "badminton")).toBeUndefined();
  });

  it("names the set that CLOSED, its ordinal and its winner — and says nothing on the next event", () => {
    const mod = moduleFor("badminton");
    const cfg = cfgFor("badminton");
    const lineups = defaultLineupPair(mod.positions);
    const upToGame: (readonly [string, unknown])[] = [["core.start", {}]];
    // Drive until the module itself says a set closed — no "21" typed here.
    let closed = 0;
    let before = (mod as never as { summary: (s: unknown) => unknown }).summary(
      (mod as never as { init: (c: unknown, l: unknown) => unknown }).init(cfg, lineups),
    );
    for (let i = 0; i < 60 && closed === 0; i++) {
      upToGame.push(["badminton.rally", { wonBy: "H" }]);
      const evs = active("badminton", upToGame);
      const state = foldMatch(mod as never, cfg as never, lineups, evs);
      const after = (mod as never as { summary: (s: unknown) => unknown }).summary(state);
      const won = diffClosedSets(before, after, "badminton");
      if (won) {
        expect(won).toMatchObject({ set: 1, winner: 0, away: 0 });
        expect(won.home).toBeGreaterThan(0);
        closed = 1;
      }
      before = after;
    }
    expect(closed).toBe(1);
  });
});

describe("replayDerived", () => {
  it("a sport with no sets derives nothing at all — `derived` is ABSENT, never an empty object", () => {
    const { events, replay } = derivedOf("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
    ]);
    expect(replay.complete).toBe(true);
    expect(events.at(-1)!.derived).toBeUndefined();
    expect("derived" in events.at(-1)!).toBe(false);
  });

  it("badminton: the point that closes a game annotates setWon on THAT event", () => {
    const mod = moduleFor("badminton");
    // 21 unanswered points closes a game under any shipped variant; the
    // assertion reads the module's own set list rather than the number 21.
    const { events } = derivedOf("badminton", [["core.start", {}], ...points(21, "H")]);
    const wins = events.filter((e) => e.derived?.setWon);
    expect(wins).toHaveLength(1);
    expect(wins[0]!.derived!.setWon).toMatchObject({ set: 1, winner: 0, away: 0 });
    void mod;
  });

  it("badminton: one point short of the game is a SET point for the leader, and it is FRESH exactly once", () => {
    const { events } = derivedOf("badminton", [["core.start", {}], ...points(20, "H")], 25);
    const last = events.at(-1)!;
    expect(last.derived?.pointState).toMatchObject({ kind: "set", side: 0 });
    // Nothing before 20-0 is a set point, so this one is a transition.
    expect(last.derived?.pointState?.fresh).toBe(true);
    const setPoints = events.filter((e) => e.derived?.pointState?.kind === "set");
    expect(setPoints).toHaveLength(1);
  });

  it("badminton: a set point that would also win the MATCH reads as match, not set", () => {
    // Game one to H, then one point short of game two.
    const { events } = derivedOf(
      "badminton",
      [["core.start", {}], ...points(21, "H"), ...points(20, "H")],
      50,
    );
    expect(events.at(-1)!.derived?.pointState).toMatchObject({ kind: "match", side: 0 });
  });

  it("a DECIDED match is at no point state at all — the slab must not announce a match point after the handshake", () => {
    const { events } = derivedOf("badminton", [["core.start", {}], ...points(21, "H"), ...points(21, "H")], 60);
    expect(events.at(-1)!.derived?.pointState).toBeUndefined();
  });

  it("`fresh` is FALSE while the same state persists — a deuce fought out is one match point arriving, not many", () => {
    // 20-0 then 20-1, 20-2 … H stays one point from the game throughout.
    const { events } = derivedOf(
      "badminton",
      [["core.start", {}], ...points(20, "H"), ...points(3, "A")],
      50,
    );
    const run = events.filter((e) => e.derived?.pointState?.kind === "set");
    expect(run.length).toBeGreaterThan(1);
    expect(run[0]!.derived!.pointState!.fresh).toBe(true);
    expect(run.slice(1).every((e) => e.derived!.pointState!.fresh === false)).toBe(true);
  });

  it("the probe never runs a type the module does not DECLARE", () => {
    const mod = moduleFor("badminton");
    const blind = { ...(mod as object), eventSchemas: {} } as never;
    const replay = replayDerived({
      sportKey: "badminton",
      module: blind,
      cfg: cfgFor("badminton") as never,
      lineups: defaultLineupPair(mod.positions),
      active: active("badminton", [["core.start", {}], ...points(20, "H")]),
    });
    expect([...replay.bySeq.values()].some((d) => d.pointState)).toBe(false);
  });

  it("a module that REFUSES the ledger part-way reports it rather than pretending the rest had nothing", () => {
    const mod = moduleFor("badminton");
    const exploding = {
      ...(mod as object),
      apply: () => {
        throw new Error("refused");
      },
    } as never;
    const replay = replayDerived({
      sportKey: "badminton",
      module: exploding,
      cfg: cfgFor("badminton") as never,
      lineups: defaultLineupPair(mod.positions),
      active: active("badminton", [["core.start", {}], ...points(3, "H")]),
    });
    expect(replay.complete).toBe(false);
  });
});

describe("replayDerived — tennis, the only sport with a BREAK", () => {
  const point = (by: string) => ["tennis.point", { by }] as const;

  it("the RECEIVER one point from the game is at BREAK point; the SERVER at game point is at no point state", () => {
    // Who serves first is the engine's answer, not a literal — read it off the
    // summary after `core.start` and drive the receiver to 0–40.
    const mod = moduleFor("tennis");
    const cfg = cfgFor("tennis");
    const lineups = defaultLineupPair(mod.positions);
    const opened = foldMatch(mod as never, cfg as never, lineups, active("tennis", [["core.start", {}]]));
    const serving = (mod as never as { summary: (s: unknown) => { detail?: { serving?: string } } })
      .summary(opened).detail?.serving;
    expect(serving).toBe("home");
    const receiver = "A";

    const { events } = derivedOf("tennis", [["core.start", {}], point(receiver), point(receiver), point(receiver)], 20);
    expect(events.at(-1)!.derived?.pointState).toMatchObject({ kind: "break", side: 1, fresh: true });

    // The server at 40–0 would win the GAME, which is not a break, not a set
    // and not a match — so nothing is announced.
    const held = derivedOf("tennis", [["core.start", {}], point("H"), point("H"), point("H")], 20);
    expect(held.events.at(-1)!.derived?.pointState).toBeUndefined();
  });
});

describe("replayDerived — the guards, each witnessed alone", () => {
  const CLOSED = { home: 21, away: 0, closed: true };
  const envelopes = (n: number) =>
    Array.from({ length: n }, (_, i) => makeEnvelope(i + 1, { type: "badminton.rally", payload: { wonBy: "H" } } as never));

  it("a module whose `apply` TOLERATES a point after the match is decided is still not asked", () => {
    // The `catch` around the probe hides this on every real module, because
    // theirs throw. A tolerant one would fold a phantom point and report a
    // match point after the handshake — which is exactly what the decided
    // guard exists for, and the only way to witness it.
    const tolerant = {
      eventSchemas: { "badminton.rally": {} },
      init: () => ({}),
      apply: (s: unknown) => s,
      summary: () => ({ headline: "", detail: { sets: [CLOSED] } }),
      outcome: () => ({ kind: "win", winner: "H" }),
    } as never;
    const replay = replayDerived({
      sportKey: "badminton",
      module: tolerant,
      cfg: {},
      lineups: defaultLineupPair(moduleFor("badminton").positions),
      active: envelopes(3),
    });
    expect([...replay.bySeq.values()].some((d) => d.pointState)).toBe(false);
  });

  it("when one side would win a SET and the other the MATCH, the match wins the announcement", () => {
    const probing = {
      eventSchemas: { "badminton.rally": {} },
      init: () => ({ probe: null }),
      apply: (_s: unknown, ev: { id: string; payload: { wonBy?: string } }) =>
        ({ probe: ev.id === "overlay-probe" ? (ev.payload.wonBy ?? null) : null }),
      summary: (s: { probe: string | null }) => ({
        headline: "",
        detail: { sets: s.probe === "H" ? [CLOSED, CLOSED] : [CLOSED] },
      }),
      outcome: (s: { probe: string | null }) => (s.probe === "A" ? { kind: "win", winner: "A" } : null),
    } as never;
    const replay = replayDerived({
      sportKey: "badminton",
      module: probing,
      cfg: {},
      lineups: defaultLineupPair(moduleFor("badminton").positions),
      active: envelopes(2),
    });
    const states = [...replay.bySeq.values()].map((d) => d.pointState);
    expect(states.at(-1)).toMatchObject({ kind: "match", side: 1 });
  });

  it("a set already closed is not re-won by every event that follows it", () => {
    const { events } = derivedOf(
      "badminton",
      [["core.start", {}], ...points(21, "H"), ...points(5, "A")],
      60,
    );
    expect(events.filter((e) => e.derived?.setWon)).toHaveLength(1);
  });

  it("at the DEFAULT window the first entry still knows it is a continuation, not a fresh point state", () => {
    // The probe runs from ONE event before the window for exactly this. With
    // the window starting at the probe, the first entry has no previous state
    // to compare against and every run reads as fresh.
    // EIGHT replies, so the whole window sits AFTER H reached 20 and every
    // entry in it — including the first — is a continuation. With six, the
    // window's first entry was H's 19th point, which is not a set point at
    // all, and the case proved nothing.
    const { events } = derivedOf("badminton", [["core.start", {}], ...points(20, "H"), ...points(8, "A")]);
    expect(events).toHaveLength(OVERLAY_RECENT_WINDOW);
    expect(events.every((e) => e.derived?.pointState?.kind === "set")).toBe(true);
    expect(events[0]!.derived?.pointState).toMatchObject({ kind: "set", side: 0, fresh: false });
  });
});

describe("replayDerived — the dismissed batter's figures", () => {
  it("a wicket carries the OUT batter's runs and balls, counting the dismissal delivery", () => {
    // H-p1 faces three: 4, then 0, then run out for 0. Three balls, four runs —
    // and the figures must be HIS, not the striker's on some other ball and not
    // the innings total.
    const { events } = derivedOf("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      ball(0, 1, "H-p1", "A-p1", 4, { boundary: 4 }),
      ball(0, 2, "H-p1", "A-p1", 0),
      ball(0, 3, "H-p1", "A-p1", 0, {
        wicket: { kind: "runout", out: "H-p1", fielder: "A-p2", bowlerCredited: false },
      }),
    ]);
    expect(events.at(-1)!.derived?.batter).toEqual({ runs: 4, balls: 3 });
  });

  it("a ball that takes no wicket carries no figures at all", () => {
    const { events } = derivedOf("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      ball(0, 1, "H-p1", "A-p1", 4, { boundary: 4 }),
    ]);
    expect(events.at(-1)!.derived).toBeUndefined();
  });

  it("the NON-striker run out is named, not the striker — they are different people and different figures", () => {
    const { events } = derivedOf("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      ball(0, 1, "H-p1", "A-p1", 6, { boundary: 6 }),
      // Striker H-p1 (6 off 1); the non-striker H-p2 has faced nothing.
      ball(0, 2, "H-p1", "A-p1", 0, {
        wicket: { kind: "runout", out: "H-p2", fielder: "A-p2", bowlerCredited: false },
      }),
    ]);
    expect(events.at(-1)!.derived?.batter).toEqual({ runs: 0, balls: 0 });
  });

  it("a COARSE innings carries no per-batter tally, so the figures are ABSENT rather than 0 (0)", () => {
    // Fidelity bands 0 and 1 keep `fine: null`. No real ledger can be driven
    // there AND take a wicket ball in one stream, so the two innings shapes are
    // put in front of the reader directly — a fabricated `0 (0)` on air reads
    // as a duck, which is a different and wrong fact.
    const wicket = {
      over: 0,
      ballInOver: 1,
      striker: "H-p1",
      nonStriker: "H-p2",
      bowler: "A-p1",
      runs: { bat: 0 },
      wicket: { kind: "bowled", out: "H-p1", bowlerCredited: true },
    };
    const stub = (fine: unknown) =>
      ({
        eventSchemas: {},
        init: () => ({ innings: [{ fine }], superOver: null }),
        apply: (s: unknown) => s,
        summary: () => ({ headline: "", detail: {} }),
        outcome: () => null,
      }) as never;
    const run = (fine: unknown) =>
      replayDerived({
        sportKey: "cricket",
        module: stub(fine),
        cfg: {},
        lineups: defaultLineupPair(moduleFor("cricket").positions),
        active: [makeEnvelope(1, { type: "cricket.ball", payload: wicket } as never)],
      });

    expect([...run(null).bySeq.values()][0]?.batter).toBeUndefined();
    // Its positive pair, so "absent" is a decision rather than the code never
    // reaching the read at all.
    expect(
      [...run({ batterRuns: { "H-p1": 7 }, batterBalls: { "H-p1": 3 } }).bySeq.values()][0]?.batter,
    ).toEqual({ runs: 7, balls: 3 });
  });
});

describe("nameCricketBundle — the ended-card name resolution (I2/M11)", () => {
  const EMPTY_BUNDLE: OverlayCricketBundleIds = {
    live: null,
    toss: null,
    lastClosedOver: null,
    scoringStarted: true,
    highlights: null,
  };

  it("a MASKED person's highlight renders — masked means shortened for consent, not suppressed", () => {
    // "H-p1" is masked in NAMED (`{ name: "H. One", masked: true }`). The
    // old guard (`person.masked`) dropped this chip even though
    // `nameCricketLive` puts the SAME masked name on air in the crease band
    // and (via `nameClosedOver`) the end-of-over card, with no masked check
    // at all — the inconsistency this fix removes.
    const bundle: OverlayCricketBundleIds = {
      ...EMPTY_BUNDLE,
      highlights: { batter: { name: "H-p1", line: "50 (30)", detail: "SR 166.7" } },
    };
    const named = nameCricketBundle(bundle, personOf);
    expect(named.highlights?.batter).toEqual({ name: "H. One", line: "50 (30)", detail: "SR 166.7" });
  });

  it("an unresolved person is still dropped from highlights — the guard still refuses something", () => {
    const bundle: OverlayCricketBundleIds = {
      ...EMPTY_BUNDLE,
      highlights: { bowler: { name: "unknown-id", line: "2/10" } },
    };
    expect(nameCricketBundle(bundle, personOf).highlights).toBeNull();
  });

  it("lastClosedOver batters/bowler are named, including a MASKED batter", () => {
    const bundle: OverlayCricketBundleIds = {
      ...EMPTY_BUNDLE,
      lastClosedOver: {
        inningsIndex: 0,
        over: 3,
        runs: 8,
        wickets: 1,
        score: "24/2",
        glyphs: [],
        bowler: { name: "A-p1", overs: "3.0", maidens: 0, runs: 8, wickets: 1 },
        batters: [{ name: "H-p1", runs: 12, balls: 9, onStrike: true }],
      },
    };
    const named = nameCricketBundle(bundle, personOf);
    expect(named.lastClosedOver?.batters).toEqual([{ name: "H. One", runs: 12, balls: 9, onStrike: true }]);
    expect(named.lastClosedOver?.bowler).toEqual({
      name: "Away One",
      overs: "3.0",
      maidens: 0,
      runs: 8,
      wickets: 1,
    });
  });
});

// The crease band rides `deriveCricketScorecard`, which used to hand the
// kernel-owned events (`core.suspend`, `core.resume`, `core.lineup.*`) straight
// to `cricket.apply` — an `unknown event type` throw, swallowed here into the
// EMPTY bundle, so a club on air lost its batters, bowler and end-of-over card
// for the rest of the match after one stoppage or one concussion replacement.
describe("overlayCricketBundleIds — the events the kernel folds itself", () => {
  const cricketModule = moduleFor("cricket");
  const lineups = defaultLineupPair(cricketModule.positions);
  const cfg = cricketModule.configSchema.parse({
    ...(SIM_CONFIGS.cricket as Record<string, unknown>),
    lineupChanges: { concussionReplacements: 1 },
  });
  const inputs = { sportKey: "cricket", module: cricketModule, cfg, lineups };
  const envelopes = (stream: readonly (readonly [string, unknown])[]) =>
    stream.map(([type, payload], i) => ({ ...makeEnvelope(i + 1, { type, payload } as never), recordedAt: WALL }));

  // Over 0 is A-p1's six dots; play stops for rain; A-p2 is concussed and
  // replaced by A-p12, who bowls over 1. A-p12 BOWLING is the point: a fold
  // that skipped the replacement instead of folding it would refuse him.
  const stream = [
    ["cricket.toss", { wonBy: "H", elected: "bat" }],
    ["core.start", {}],
    ...[1, 2, 3, 4, 5, 6].map((n) => ball(0, n, "H-p1", "A-p1", 0)),
    ["core.suspend", { reason: "rain" }],
    ["core.resume", {}],
    [
      "core.lineup.replacement",
      { side: "A", off: "A-p2", on: { personId: "A-p12", slot: "bench", orderNo: 12 }, exemption: "concussion" },
    ],
    ball(1, 1, "H-p2", "A-p12", 4, { boundary: 4 }),
    ball(1, 2, "H-p2", "A-p12", 0),
  ] as const;

  it("keeps the whole bundle — crease band, toss, closed over — with the replacement bowling", () => {
    const events = envelopes(stream);
    // Legal on the WRITE path, not merely tolerated on replay.
    const kernel = foldMatch(cricketModule as never, cfg as never, lineups, events, { strictFromSeq: 0 }) as {
      innings: { fine: { bowlerRuns: Record<string, number> } }[];
    };

    const bundle = overlayCricketBundleIds(inputs, events);
    expect(bundle.scoringStarted).toBe(true);
    expect(bundle.toss).not.toBeNull();
    expect(bundle.lastClosedOver).not.toBeNull();
    expect(bundle.live).not.toBeNull();
    expect(bundle.live?.bowler?.name).toBe("A-p12");
    expect(bundle.live?.bowler?.runs).toBe(kernel.innings[0]?.fine.bowlerRuns["A-p12"]);
    expect(bundle.live?.bowler?.runs).toBe(4);
    expect(bundle.live?.batters.map((b) => [b.name, b.runs, b.balls])).toEqual([
      ["H-p2", 4, 2],
      ["H-p1", 0, 6],
    ]);
  });

  // The negative pair: a ledger the fold REFUSES still degrades to the empty
  // bundle, so "the bundle is present" above is a verdict on the ledger and
  // not a function that never returns empty.
  it("a ledger the fold refuses still degrades to the empty bundle", () => {
    const refused = envelopes([ball(0, 1, "H-p1", "A-p1", 1)]);
    expect(overlayCricketBundleIds(inputs, refused)).toEqual({
      live: null,
      toss: null,
      lastClosedOver: null,
      scoringStarted: false,
      highlights: null,
    });
  });
});
