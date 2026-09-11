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
import { buildOverlayRecent, personIdsIn, recentWindow } from "../recent";
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

  it("cricket: the wicket names the DISMISSED batter, through the resolver", () => {
    const out = build("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      ball(0, 1, "H-p1", "A-p1", 0, { wicket: { kind: "bowled", out: "H-p1", bowlerCredited: true } }),
    ]);
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
      ball(0, 1, "H-p1", "A-p1", 0, { wicket: { kind: "bowled", out: "H-p1", bowlerCredited: true } }),
    ]);
    // The ball records striker, nonStriker AND bowler; only the dismissed
    // batter is named on air, so only that id may be looked up.
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
