// `momentsFor` — the overlay's recent window → the slabs that fire (stream
// overlay W2 Task 2, spec "Step two — moments").
//
// Every POSITIVE case drives a REAL ledger through the REAL module and the
// REAL server projection (`buildOverlayRecent` + `replayDerived`), so a moment
// is only asserted to fire against a payload the engine actually produces. A
// hand-typed `recent` is used ONLY for negative cases, where the point is that
// a shape which could arrive produces nothing.
//
// `msg` returns the KEY plus its params rather than English, so every
// assertion pins a dictionary key and its variables — a test written against
// "SIX" would pass with the wrong key wired to the right copy.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { CricketWicket } from "@seazn/engine/sports/cricket";
import { buildOverlayRecent, replayDerived } from "@/server/overlay/recent";
import { DISCIPLINE_LABEL_KEYS } from "@/lib/public-site";
import type { RecentEvent, RecentPerson } from "@/lib/overlay-recent-types";
import { GOAL_KIND_KEYS, MOMENT_KEYS, MOMENT_RULES, maxSeq, momentsFor } from "../overlay-moments";
import en from "@/dictionaries/en/public.json";

const msg = ((key: string, vars?: Record<string, string | number>) =>
  `${key}${vars ? JSON.stringify(vars) : ""}`) as never;
const SIDES: [string, string] = ["HOM", "AWY"];
const ENTRANTS: [string, string] = ["H", "A"];

const moduleFor = (key: string) => {
  const m = builtinModules.find((mod) => mod.key === key);
  if (!m) throw new Error(`no builtin module for "${key}"`);
  return m;
};
const cfgFor = (key: string) => moduleFor(key).configSchema.parse(SIM_CONFIGS[key] ?? {});

const NAMED: Record<string, RecentPerson> = {
  "H-p1": { name: "H. One", masked: true },
  "H-p2": { name: "H. Two", masked: true },
  "A-p1": { name: "A. One", masked: true },
  "A-p3": { name: "A. Three", masked: true },
};
const personOf = (id: unknown): RecentPerson | undefined =>
  typeof id === "string" ? NAMED[id] : undefined;

/** A real ledger → the exact `recent` the overlay endpoint would publish. */
function recentOf(
  key: string,
  stream: readonly (readonly [string, unknown])[],
  window = 40,
): RecentEvent[] {
  const mod = moduleFor(key);
  const cfg = cfgFor(key);
  const lineups = defaultLineupPair(mod.positions);
  const events: EventEnvelope[] = stream.map(([type, payload], i) => ({
    ...makeEnvelope(i + 1, { type, payload } as never),
    recordedAt: "2026-09-11T09:00:00.000Z",
  }));
  // Folding is the assertion that every payload below is a shape the engine
  // accepts; a projection of a fiction proves nothing.
  foldMatch(mod as never, cfg as never, lineups, events);
  const { bySeq } = replayDerived({
    sportKey: key,
    module: mod as never,
    cfg: cfg as never,
    lineups,
    active: events,
    window,
  });
  return buildOverlayRecent({ active: events, sides: ENTRANTS, personOf, window, derived: bySeq });
}

const of = (key: string, recent: readonly RecentEvent[], since = 0) =>
  momentsFor(key, recent, since, msg, SIDES);

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

describe("the allowlist is held against the modules' own declarations", () => {
  for (const mod of builtinModules) {
    it(`${mod.key}: every recorded-event key it allowlists is a type the module DECLARES`, () => {
      const declared = Object.keys(mod.eventSchemas ?? {});
      const listed = Object.keys(MOMENT_RULES[mod.key] ?? {}).filter((k) => !k.startsWith("derived."));
      for (const type of listed) {
        expect(declared, `${mod.key} allowlists undeclared type ${type}`).toContain(type);
      }
    });
  }

  it("football allowlists EXACTLY the goal and the card — not every type it declares", () => {
    // The parity check above passes for any DECLARED type, so it cannot see a
    // rule wired to `football.shot`. This is the membership assertion.
    expect(Object.keys(MOMENT_RULES.football!).sort()).toEqual(["football.card", "football.goal"]);
  });

  it("board games, carrom and generic raise nothing, by construction", () => {
    for (const key of ["boardgame", "carrom", "generic"]) {
      expect(Object.keys(MOMENT_RULES[key] ?? {})).toEqual([]);
    }
  });

  it("an unlisted type, and an unknown sport, yield nothing rather than throwing", () => {
    const ev: RecentEvent = { seq: 9, type: "football.shot", at: "", payload: {} };
    expect(of("football", [ev])).toEqual([]);
    expect(of("some.future.sport", [{ ...ev, type: "x.y" }])).toEqual([]);
  });

  it("a sport with NO allowlist renders nothing even for a type another sport honours", () => {
    // The negative above cannot see a fallthrough: `x.y` is in nobody's list,
    // so "no rules" and "football's rules" answer alike. A type football DOES
    // honour is the case that tells them apart — and a twelfth sport arriving
    // in the registry must not start throwing slabs because its event names
    // resemble somebody else's.
    const goal: RecentEvent = { seq: 1, type: "football.goal", at: "", payload: { side: 0 } };
    expect(of("some.future.sport", [goal])).toEqual([]);
    // Its positive pair, so the case cannot pass by the payload being unusable.
    expect(of("football", [goal])).toHaveLength(1);
  });

  it("every key a rule can emit is authored in the English dictionary", () => {
    const authored = new Set(Object.keys(en as Record<string, string>));
    const missing = MOMENT_KEYS.filter((k) => !authored.has(k));
    expect(missing, `unauthored moment keys: ${missing.join(", ")}`).toEqual([]);
  });

  it("every wicket kind the ENGINE declares has a line key — a new kind is a missing key, not English", () => {
    for (const kind of CricketWicket.shape.kind.options) {
      expect(MOMENT_KEYS, `no key for wicket kind ${kind}`).toContain(`overlay.moment.wicket.${kind}`);
    }
  });

  it("every suspension class the period sports DECLARE has a tone", () => {
    // Derived from each module's own parsed config, so a class a federation
    // sheet adds reds here rather than rendering toneless.
    for (const key of ["hockey", "icehockey"]) {
      const cfg = cfgFor(key) as { suspensions?: { classes?: Record<string, unknown> } };
      const classes = Object.keys(cfg.suspensions?.classes ?? {});
      expect(classes.length, `${key} declares no classes — the probe is vacuous`).toBeGreaterThan(0);
      for (const cls of classes) {
        const ev: RecentEvent = {
          seq: 1,
          type: `${key}.suspension.start`,
          at: "",
          payload: { side: 0, class: cls },
        };
        expect(of(key, [ev]), `${key} class ${cls} raises nothing`).toHaveLength(1);
      }
    }
  });
});

describe("cricket", () => {
  const stream = [
    ["cricket.toss", { wonBy: "H", elected: "bat" }],
    ["core.start", {}],
    ball(0, 1, "H-p1", "A-p1", 6, { boundary: 6 }),
    ball(0, 2, "H-p1", "A-p1", 1),
    ball(0, 3, "H-p2", "A-p1", 4, { boundary: 4 }),
    ball(0, 4, "H-p2", "A-p1", 0, {
      wicket: { kind: "bowled", out: "H-p2", bowlerCredited: true },
    }),
  ] as const;
  const recent = recentOf("cricket", stream);

  it("SIX, FOUR and OUT fire; the single is SILENT; order is ledger order", () => {
    expect(of("cricket", recent).map((m) => [m.seq, m.kind, m.tone])).toEqual([
      [3, "six", "led"],
      [5, "four", "led"],
      [6, "wicket", "dismissal"],
    ]);
  });

  it("the OUT line carries the dismissed batter's name, the engine's figures and the kind", () => {
    const out = of("cricket", recent, 5)[0]!;
    expect(out.headline).toBe("overlay.moment.out");
    expect(out.line).toBe(
      `overlay.moment.batterLine${JSON.stringify({
        name: "H. Two",
        runs: 4,
        balls: 2,
        kind: "overlay.moment.wicket.bowled",
      })}`,
    );
  });

  it("`sinceSeq` is EXCLUSIVE — the tip is not replayed, the one before it is", () => {
    expect(of("cricket", recent, 6)).toEqual([]);
    expect(of("cricket", recent, 5).map((m) => m.seq)).toEqual([6]);
  });

  it("a wicket with NO figures (a coarse innings) still fires, with the kind alone", () => {
    const ev: RecentEvent = {
      seq: 4,
      type: "cricket.ball",
      at: "",
      payload: { wicketKind: "lbw", person: { name: "H. One", masked: true } },
    };
    const m = of("cricket", [ev])[0]!;
    expect(m.tone).toBe("dismissal");
    expect(m.line).toBe("overlay.moment.wicket.lbw");
  });

  it("a super-over delivery runs the SAME rule as an ordinary one", () => {
    const ev: RecentEvent = {
      seq: 40,
      type: "cricket.superover.ball",
      at: "",
      payload: { boundary: 6, runs: 6 },
    };
    expect(of("cricket", [ev])[0]).toMatchObject({ kind: "six", tone: "led" });
  });
});

describe("football, hockey and ice hockey", () => {
  it("a goal names its scorer; an own goal changes the HEADLINE; a penalty keeps the name AND says penalty", () => {
    const recent = recentOf("football", [
      ["core.start", {}],
      ["football.goal", { by: "H", scorer: "H-p1" }],
      ["football.goal", { by: "A", scorer: "A-p1", ownGoal: true }],
      ["football.goal", { by: "H", scorer: "H-p2", penalty: true }],
    ]);
    const got = of("football", recent);
    expect(got.map((m) => m.headline)).toEqual([
      "overlay.moment.goal",
      "overlay.moment.ownGoal",
      "overlay.moment.goal",
    ]);
    expect(got[0]!.line).toBe("H. One");
    // The owner ruling of 2026-09-11, pinned as a VALUE rather than as "the
    // line mentions a penalty": the bare `overlay.moment.penalty` this once
    // emitted also mentions one, and would pass a weaker assertion while
    // dropping the scorer — which was the defect.
    expect(got[2]!.line).toBe(
      'overlay.moment.goalKindLine{"name":"H. Two","kind":"overlay.moment.goalKind.penalty"}',
    );
    expect(got.every((m) => m.tone === "led")).toBe(true);
  });

  it("a penalty with no nameable scorer falls back to the bare word", () => {
    // `scorer` is optional in the engine's schema and the visibility rules can
    // mask a person away, so the half-known case is reachable in production —
    // and it must still say a penalty was scored rather than show no line.
    const recent = recentOf("football", [
      ["core.start", {}],
      ["football.goal", { by: "H", penalty: true }],
    ]);
    const got = of("football", recent);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: "goal",
      headline: "overlay.moment.goal",
      line: "overlay.moment.goalKind.penalty",
    });
  });

  it("a HOCKEY penalty stroke names its taker AND says stroke — football's parity", () => {
    // The defect this closes: `PeriodGoal` is a `z.strictObject` with NO
    // `penalty` field, so the football branch could never fire for hockey and
    // a stroke reached air as a bare name — indistinguishable from a goal
    // scored in open play.
    const recent = recentOf("hockey", [
      ["core.start", {}],
      ["hockey.goal", { by: "H", person: "H-p1" }],
      ["hockey.goal", { by: "H", person: "H-p2", kind: "stroke" }],
      ["hockey.goal", { by: "H", person: "H-p1", kind: "pc" }],
    ]);
    const got = of("hockey", recent);
    // Open play FIRST, so "the line carries the kind" cannot pass by every
    // line carrying one.
    expect(got[0]!.line).toBe("H. One");
    expect(got[1]!.line).toBe(
      'overlay.moment.goalKindLine{"name":"H. Two","kind":"overlay.moment.goalKind.stroke"}',
    );
    // And a SECOND kind, whose key differs from the first: one row cannot
    // witness a table.
    expect(got[2]!.line).toBe(
      'overlay.moment.goalKindLine{"name":"H. One","kind":"overlay.moment.goalKind.penaltyCorner"}',
    );
    expect(got.every((m) => m.headline === "overlay.moment.goal")).toBe(true);
  });

  it("an ICE HOCKEY penalty shot, power play and short-handed goal each say which", () => {
    const recent = recentOf("icehockey", [
      ["core.start", {}],
      ["icehockey.goal", { by: "H", person: "H-p1", kind: "ps" }],
      ["icehockey.goal", { by: "H", person: "H-p2", kind: "pp" }],
      ["icehockey.goal", { by: "A", person: "A-p1", kind: "sh" }],
    ]);
    expect(of("icehockey", recent).map((m) => m.line)).toEqual([
      'overlay.moment.goalKindLine{"name":"H. One","kind":"overlay.moment.goalKind.penaltyShot"}',
      'overlay.moment.goalKindLine{"name":"H. Two","kind":"overlay.moment.goalKind.powerPlay"}',
      'overlay.moment.goalKindLine{"name":"A. One","kind":"overlay.moment.goalKind.shortHanded"}',
    ]);
  });

  it("`og` stays a HEADLINE and adds no suffix, on the period kernel too", () => {
    // `og` is in `cfg.goalKinds` for both period sports, so the table's
    // exclusion of it is a real decision rather than an absence. Without this
    // the sweep below would be satisfied by a table that named `og` as well,
    // and an own goal would read "OWN GOAL / H. One · Own goal".
    const recent = recentOf("hockey", [
      ["core.start", {}],
      ["hockey.goal", { by: "H", person: "H-p1", kind: "og" }],
    ]);
    const got = of("hockey", recent);
    expect(got[0]!.headline).toBe("overlay.moment.ownGoal");
    expect(got[0]!.line).toBe("H. One");
  });

  it("a period goal with a nameless taker shows the KIND alone, never an empty line", () => {
    // `person` is optional in `PeriodGoal`, and a club that records the goal
    // without the scorer is ordinary. The stroke must still say stroke.
    const recent = recentOf("hockey", [
      ["core.start", {}],
      ["hockey.goal", { by: "H", kind: "stroke" }],
    ]);
    expect(of("hockey", recent)[0]!.line).toBe("overlay.moment.goalKind.stroke");
  });

  it("every goal kind the PERIOD SPORTS declare has a line key — a new kind is a missing key", () => {
    // TWO sources of truth, neither of them this file: the KINDS come from each
    // module's own parsed config (as the suspension sweep above does), and the
    // KEY each one maps to comes from the overlay's own exported table. A
    // literal typed here would be a third copy, and would keep asserting
    // yesterday's answer after either moved.
    //
    // `fg` and `og` are excluded BY THIS ASSERTION rather than by the table
    // quietly not naming them — a plain goal has nothing to add, and an own
    // goal is the headline (pinned separately above).
    for (const key of ["hockey", "icehockey"]) {
      const kinds = (cfgFor(key) as { goalKinds: string[] }).goalKinds.filter(
        (k) => k !== "fg" && k !== "og",
      );
      expect(kinds.length, `${key} declares no goal kinds — the probe is vacuous`).toBeGreaterThan(0);
      for (const kind of kinds) {
        const dictKey = GOAL_KIND_KEYS[kind];
        expect(dictKey, `${key} declares goal kind "${kind}" and no key names it`).toBeDefined();
        const recent = recentOf(key, [
          ["core.start", {}],
          [`${key}.goal`, { by: "H", person: "H-p1", kind }],
        ]);
        expect(of(key, recent)[0]!.line, `${key} goal kind ${kind} reaches air as a bare name`).toBe(
          `overlay.moment.goalKindLine{"name":"H. One","kind":"${dictKey}"}`,
        );
      }
    }
  });

  it("yellow cautions; red and a second yellow dismiss — and each has its own headline", () => {
    // A-p1 is booked BEFORE the second yellow: the engine refuses
    // `second_yellow` for a player with no prior caution, which is the fold
    // earning its place in this harness rather than a fixture being humoured.
    const recent = recentOf("football", [
      ["core.start", {}],
      ["football.card", { by: "H", person: "H-p1", color: "yellow" }],
      ["football.card", { by: "A", person: "A-p1", color: "yellow" }],
      ["football.card", { by: "A", person: "A-p1", color: "second_yellow" }],
      ["football.card", { by: "A", person: "A-p3", color: "red" }],
    ]);
    expect(of("football", recent).map((m) => [m.headline, m.tone])).toEqual([
      ["overlay.moment.card.yellow", "caution"],
      ["overlay.moment.card.yellow", "caution"],
      ["overlay.moment.card.secondYellow", "dismissal"],
      ["overlay.moment.card.red", "dismissal"],
    ]);
  });

  it("hockey: green and yellow caution, red dismisses — the sport's own three-card ladder", () => {
    const recent = recentOf("hockey", [
      ["core.start", {}],
      ["hockey.suspension.start", { by: "H", person: "H-p1", class: "green" }],
      ["hockey.suspension.start", { by: "H", person: "H-p2", class: "yellow" }],
      ["hockey.suspension.start", { by: "A", person: "A-p1", class: "red" }],
    ]);
    expect(of("hockey", recent).map((m) => [m.headline, m.tone])).toEqual([
      ["overlay.moment.card.green", "caution"],
      ["overlay.moment.card.yellow", "caution"],
      ["overlay.moment.card.red", "dismissal"],
    ]);
  });

  it("ice hockey: one PENALTY headline, the class on the line, and only the serious ones dismiss", () => {
    const recent = recentOf("icehockey", [
      ["core.start", {}],
      ["icehockey.suspension.start", { by: "H", person: "H-p1", class: "minor" }],
      ["icehockey.suspension.start", { by: "A", person: "A-p1", class: "match" }],
    ]);
    const got = of("icehockey", recent);
    expect(got.map((m) => [m.headline, m.tone])).toEqual([
      ["overlay.moment.penaltyHeadline", "caution"],
      ["overlay.moment.penaltyHeadline", "dismissal"],
    ]);
    // The class label is W1's OWN key, not a second copy of the same words.
    expect(got[0]!.line).toBe(`${DISCIPLINE_LABEL_KEYS.minor} · H. One`);
    expect(DISCIPLINE_LABEL_KEYS.minor).toBe("overlay.card.minor");
  });

  it("a card colour no tone table names renders NOTHING rather than a toneless slab", () => {
    const ev: RecentEvent = { seq: 3, type: "football.card", at: "", payload: { colour: "orange" } };
    expect(of("football", [ev])).toEqual([]);
  });
});

describe("the racket and set-based sports, from the derived probe", () => {
  it("tennis: an ace fires; a plain point does not", () => {
    const recent = recentOf("tennis", [
      ["core.start", {}],
      ["tennis.point", { by: "H", scorer: "H-p1", meta: { kind: "ace" } }],
      ["tennis.point", { by: "H", scorer: "H-p1" }],
    ]);
    const got = of("tennis", recent).filter((m) => m.kind === "ace");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ headline: "overlay.moment.ace", tone: "led", seq: 2 });
  });

  it("tennis: the receiver one point from the game raises BREAK POINT, once", () => {
    const recent = recentOf("tennis", [
      ["core.start", {}],
      ["tennis.point", { by: "A" }],
      ["tennis.point", { by: "A" }],
      ["tennis.point", { by: "A" }],
    ]);
    const got = of("tennis", recent).filter((m) => m.kind.startsWith("point."));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ headline: "overlay.moment.breakPoint", kind: "point.break" });
  });

  it("badminton says GAME POINT and volleyball says SET POINT — the unit comes from the shared set, not from 'it has sets'", () => {
    // The differential that proves `GAME_UNIT_SPORTS` is consulted. A rule that
    // said "set-based sport ⇒ game point" would pass badminton and fail here.
    const bad = recentOf("badminton", [
      ["core.start", {}],
      ...Array.from({ length: 20 }, () => ["badminton.rally", { wonBy: "H" }] as const),
    ]);
    expect(of("badminton", bad).at(-1)).toMatchObject({ headline: "overlay.moment.gamePoint" });

    const vol = recentOf("volleyball", [
      ["core.start", {}],
      ...Array.from({ length: 24 }, () => ["volleyball.rally", { wonBy: "H" }] as const),
    ]);
    expect(of("volleyball", vol).at(-1)).toMatchObject({ headline: "overlay.moment.setPoint" });
  });

  it("winning the set raises SET/GAME {n} with the winner's short name and the score", () => {
    const bad = recentOf("badminton", [
      ["core.start", {}],
      ...Array.from({ length: 21 }, () => ["badminton.rally", { wonBy: "H" }] as const),
    ]);
    const won = of("badminton", bad).find((m) => m.kind === "setWon")!;
    expect(won.headline).toBe(`overlay.moment.gameWon${JSON.stringify({ n: 1 })}`);
    expect(won.line).toBe(
      `overlay.moment.setWonLine${JSON.stringify({ short: "HOM", home: 21, away: 0 })}`,
    );

    // Volleyball's differential, for the SET-WON headline this time. Without
    // it, a rule that said "set-based sport ⇒ game" passed on the strength of
    // badminton alone and volleyball announced "GAME 1" on air.
    const vol = recentOf("volleyball", [
      ["core.start", {}],
      ...Array.from({ length: 25 }, () => ["volleyball.rally", { wonBy: "H" }] as const),
    ]);
    const volWon = of("volleyball", vol).find((m) => m.kind === "setWon")!;
    expect(volWon.headline).toBe(`overlay.moment.setWon${JSON.stringify({ n: 1 })}`);
  });

  it("a point state that is NOT fresh raises nothing, however new its seq", () => {
    const ev: RecentEvent = {
      seq: 99,
      type: "tennis.point",
      at: "",
      payload: {},
      derived: { pointState: { kind: "match", side: 0, fresh: false } },
    };
    expect(of("tennis", [ev])).toEqual([]);
  });

  it("one event can raise TWO moments, and the set won is announced before the point it opens", () => {
    const ev: RecentEvent = {
      seq: 50,
      type: "tennis.point",
      at: "",
      payload: {},
      derived: {
        setWon: { set: 1, winner: 0, home: 6, away: 4 },
        pointState: { kind: "match", side: 0, fresh: true },
      },
    };
    expect(of("tennis", [ev]).map((m) => m.kind)).toEqual(["setWon", "point.match"]);
  });
});

describe("maxSeq", () => {
  it("0 for an absent or empty window, the highest seq otherwise", () => {
    expect(maxSeq(undefined)).toBe(0);
    expect(maxSeq([])).toBe(0);
    expect(maxSeq([{ seq: 4, type: "x", at: "", payload: {} }, { seq: 9, type: "x", at: "", payload: {} }])).toBe(9);
  });
});

describe("the wicket line degrades without trailing punctuation", () => {
  it("a dismissal kind the table does not name keeps the figures and drops the separator", () => {
    // `kind ?? ""` rendered "Name 4 (2) · " — a dangling separator on a
    // broadcast graphic, for exactly the future-kind case the fallback exists
    // to survive.
    const ev: RecentEvent = {
      seq: 9,
      type: "cricket.ball",
      at: "",
      payload: { wicketKind: "future_mode", person: { name: "H. One", masked: true } },
      derived: { batter: { runs: 4, balls: 2 } },
    };
    const m = of("cricket", [ev])[0]!;
    expect(m.tone).toBe("dismissal");
    expect(m.line).toBe("H. One 4 (2)");
    expect(m.line).not.toContain("·");
  });

  it("a KNOWN kind still renders the full line, separator and all", () => {
    const ev: RecentEvent = {
      seq: 9,
      type: "cricket.ball",
      at: "",
      payload: { wicketKind: "bowled", person: { name: "H. One", masked: true } },
      derived: { batter: { runs: 4, balls: 2 } },
    };
    expect(of("cricket", [ev])[0]!.line).toBe(
      `overlay.moment.batterLine${JSON.stringify({ name: "H. One", runs: 4, balls: 2, kind: "overlay.moment.wicket.bowled" })}`,
    );
  });
});
