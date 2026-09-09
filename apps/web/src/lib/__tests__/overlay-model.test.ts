// `overlayModel` — the ONE projection all eleven sports render through (R3).
//
// Every case folds a SHORT REAL ledger through the REAL module
// (`foldMatch`, packages/engine/src/core/events.ts:445, with
// `defaultLineupPair`/`makeEnvelope` from `@seazn/engine/testkit`) and projects
// the module's OWN `summary()` — the pattern
// `components/v2/scorepad/__tests__/view-model.test.ts:8-12` uses. A typed
// summary table on both ends would only prove the table.
//
// RE-PIN (2026-09-09, implementer re-pin before building on the task-2
// brief — AGENTS.md #5, "the brief is a hypothesis"): the brief's own stream
// literals used `"home"`/`"away"` as EntrantId payload values (`football.goal
// { by: "home" }`, `badminton.rally { wonBy: "home" }`, `volleyball.rally
// { wonBy: "home" }`, `tennis.point { by: "away" }`, `cricket.toss { wonBy:
// HOME_ID }` with `HOME_ID` never declared). Every one of those fields is
// typed `EntrantId` and every kernel's `sideOf` throws `"unknown entrant"` for
// anything but the real id (`defaultLineupPair` seeds "H"/"A" — confirmed in
// `testkit/helpers.ts:54` and independently in `football.ts:643-647`,
// `nested/kernel.ts:741-744`, `setbased/kernel.ts:420-423`). Fixed to "H"/"A"
// throughout. Also: `["core.period.end", {}]` is not a real event type —
// football's own is `"football.period"` with `phase` one of
// `HT|FT|ET_HT|ET_FT|QT|3QT` (football.ts:264-283); fixed to
// `["football.period", { phase: "HT" }]`. Also: `mod.configSchema.parse({})`
// is not universal — `generic` requires `resultMode`/`allowDraws` with no
// defaults (generic.ts:31-32) — fixed to route every sport's cfg through
// `SIM_CONFIGS[key] ?? {}` (the engine's own per-module valid raw config,
// `testkit/simulation.ts:91-99`), the same helper `chaos.test.ts` and
// `stoppages.test.ts` use. Also: `CricketClose.reason` has no `"declared"`
// member (`all_out|overs_complete|target_reached|time|weather|forfeited|
// other`, cricket.ts:249-253); fixed to omit `reason` (it is optional).
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { V3_SKINS } from "@/components/v2/scorepad/v3/registry";
import { overlayModel, overlayStartLabel, shortCode, splitLine, type OverlayMsg } from "@/lib/overlay-model";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { LiveFixtureData, OverlayLiveData } from "@/components/public-site/live-score-data";

/** A msg that returns its own key, so any literal that leaked into the model
 *  shows up as prose among keys (R14). Never the real dictionary. */
const keyMsg: OverlayMsg = (key, vars) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

const TEMPLATES: DecidedOutcomeTemplates = {
  tie: "TIE",
  plain: "WIN {winner}",
  shootoutPlain: "WIN {winner} SO",
  byMethod: { regulation: "WIN {winner} REG" },
};

const SIDES: [{ id: string; name: string }, { id: string; name: string }] = [
  { id: "H", name: "Milton Keynes Rovers" },
  { id: "A", name: "Northbridge Athletic" },
];

const moduleFor = (key: string) => {
  const m = builtinModules.find((mod) => mod.key === key);
  if (!m) throw new Error(`no builtin module for "${key}" — the skin list and the module list disagree`);
  return m;
};

/** Folds `stream` through the real module and returns the LiveFixtureData the
 *  public endpoint would serve for it. `SIM_CONFIGS[key] ?? {}` — see the
 *  RE-PIN note above; `mod.configSchema.parse({})` alone is not universal. */
function payload(
  key: string,
  stream: readonly (readonly [string, unknown])[],
  status: string,
  outcome: LiveFixtureData["outcome"] = null,
): LiveFixtureData {
  const mod = moduleFor(key);
  const cfg = mod.configSchema.parse(SIM_CONFIGS[key] ?? {});
  const lineups = defaultLineupPair(mod.positions);
  const events: EventEnvelope[] = stream.map(([type, p], i) =>
    makeEnvelope(i, { type, payload: p } as never),
  );
  const state = foldMatch(mod as never, cfg as never, lineups, events);
  const summary = (mod as { summary: (s: unknown) => LiveFixtureData["summary"] }).summary(state);
  return { status, summary, outcome };
}

/** `payload()` returns the public shape; the model takes the OVERLAY shape
 *  (a superset — Task 0). The two extra fields default here so the eleven
 *  sport cases stay short; the clock and cricket cases pass them explicitly. */
const project = (key: string, data: LiveFixtureData | OverlayLiveData, startLabel: string | null = null, clockLabel: string | null = null) =>
  overlayModel({
    sportKey: key,
    data: { lastSeq: null, venueTz: "UTC", ...data } as OverlayLiveData,
    sides: SIDES,
    startLabel,
    clockLabel,
    msg: keyMsg,
    decidedTemplates: TEMPLATES,
  });

const CRICKET_BALL = (over: number, ball: number, runs: number) =>
  ["cricket.ball", { over, ballInOver: ball, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p1", runs: { bat: runs } }] as const;

describe("shortCode / splitLine", () => {
  it("upper-cases the first three letters when the entrant has no short name", () => {
    expect(shortCode({ id: "H", name: "Milton Keynes Rovers" })).toBe("MIL");
    expect(shortCode({ id: "A", name: "ab" })).toBe("AB");
    expect(shortCode({ id: "A", name: "  " })).toBe("—");
  });

  it("prefers an explicit short name, upper-cased", () => {
    expect(shortCode({ id: "H", name: "Milton Keynes Rovers", short: "mkr" })).toBe("MKR");
  });

  it("splits a kernel side line into its value and its trailing meta", () => {
    expect(splitLine("142/6 (20)")).toEqual({ big: "142/6", sub: "(20)" });
    expect(splitLine("3")).toEqual({ big: "3" });
  });
});

describe("overlayModel — the empty case first", () => {
  it("a scheduled fixture is not live, shows an em dash both sides and no cells", () => {
    const model = project("generic", { status: "scheduled", summary: null, outcome: null }, "Sat 14:00");
    expect(model.live).toBe(false);
    expect(model.decided).toBe(false);
    expect(model.sides[0].big).toBe("—");
    expect(model.sides[1].big).toBe("—");
    expect(model.sides[0].led).toBe(false);
    expect(model.sides[1].led).toBe(false);
    expect(model.cells).toEqual([]);
    expect(model.detail).toEqual([]);
    expect(model.result).toBeUndefined();
    expect(model.chase).toBeUndefined();
    expect(model.header.context, "the server-formatted start time, in the venue zone").toBe("Sat 14:00");
  });

  it("falls back to a dictionary key when a scheduled fixture has no start time", () => {
    const model = project("generic", { status: "scheduled", summary: null, outcome: null }, null);
    expect(model.header.context).toBe("overlay.header.notStarted");
  });
});

describe("overlayModel — every skin key projects without throwing", () => {
  it("covers all eleven V3_SKINS keys, each with an empty payload", () => {
    const keys = Object.keys(V3_SKINS).sort();
    expect(keys.length, "R3: eleven skins is the working sport-key list").toBe(11);
    for (const key of keys) {
      const model = project(key, { status: "scheduled", summary: null, outcome: null });
      expect(model.sides.length, key).toBe(2);
      expect(model.sides[0].short, key).toBe("MIL");
      expect(model.cells, key).toEqual([]);
    }
  });
});

describe("overlayModel — led and serving truth table", () => {
  it("cricket: the LED sits on the side batting, and moves when the innings does", () => {
    const first = payload("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      CRICKET_BALL(0, 1, 4),
    ], "in_play");
    const a = project("cricket", first);
    expect(a.sides[0].led, "home is batting").toBe(true);
    expect(a.sides[1].led).toBe(false);
    expect(a.sides[0].serving, "cricket has no serve").toBe(false);

    const second = payload("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      CRICKET_BALL(0, 1, 4),
      ["cricket.innings.close", {}],
    ], "in_play");
    const b = project("cricket", second);
    expect(
      [b.sides[0].led, b.sides[1].led],
      "an ordering-differential case: the LED must FLIP with the innings, not sit on home by construction",
    ).not.toEqual([a.sides[0].led, a.sides[1].led]);
  });

  it("tennis: the LED and the serve dot follow the server", () => {
    const data = payload("tennis", [
      ["core.start", {}],
      ["tennis.point", { by: "A" }],
    ], "in_play");
    const model = project("tennis", data);
    const serving = model.sides.findIndex((s) => s.serving);
    expect(serving, "the kernel declares a server at rally fidelity").toBeGreaterThanOrEqual(0);
    expect(model.sides[serving].led, "the server carries the LED").toBe(true);
    expect(model.sides[1 - serving].led).toBe(false);
  });

  it("football: neither side is led or serving while the match is level and open", () => {
    const data = payload("football", [["core.start", {}]], "in_play");
    const model = project("football", data);
    expect(model.sides.map((s) => s.led)).toEqual([false, false]);
    expect(model.sides.map((s) => s.serving)).toEqual([false, false]);
  });

  it("boardgame, carrom and generic have no cells and no detail, by construction", () => {
    for (const key of ["boardgame", "carrom", "generic"]) {
      const data = payload(key, [["core.start", {}]], "in_play");
      const model = project(key, data);
      expect(model.cells, key).toEqual([]);
      expect(model.detail, key).toEqual([]);
    }
  });
});

describe("overlayModel — cells", () => {
  it("badminton renders one cell per game, in order, home–away", () => {
    const data = payload("badminton", [
      ["core.start", {}],
      ...Array.from({ length: 21 }, () => ["badminton.rally", { wonBy: "H" }] as const),
    ], "in_play");
    const model = project("badminton", data);
    expect(model.cells.length, "one closed game").toBeGreaterThanOrEqual(1);
    expect(model.cells[0].key).toBe("1");
    expect(model.cells[0].value).toMatch(/^\d+–\d+$/);
  });

  it("football renders one cell per period once periods exist", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
      ["football.period", { phase: "HT" }],
    ], "in_play");
    const model = project("football", data);
    // Anti-vacuity (AGENTS.md #3): without this, an empty `cells` would pass
    // the loop below by running it zero times.
    expect(model.cells.length, "H1 (with the goal) plus the pushed H2").toBeGreaterThan(0);
    for (const cell of model.cells) expect(cell.value).toMatch(/^\d+–\d+$/);
  });
});

describe("overlayModel — decided", () => {
  it("sets result from the decided templates, drops chase, and leaves the LED on the winner", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
    ], "decided", { kind: "win", winner: "H", method: "regulation" });
    const model = project("football", data);
    expect(model.decided).toBe(true);
    expect(model.live).toBe(false);
    expect(model.result, "the ONE decided-sentence authority, renderDecidedOutcome").toBe(
      "WIN Milton Keynes Rovers REG",
    );
    expect(model.chase).toBeUndefined();
    expect(model.sides[0].led, "the winner keeps the LED").toBe(true);
    expect(model.sides[1].led).toBe(false);
  });
});

describe("overlayModel — cricket chase line", () => {
  it("renders 'Need 45 off 45' through msg, never as a typed literal", () => {
    // RE-PIN (2026-09-09): the brief's own literal here carried no `cricket`
    // field at all, so `chaseBalls(data.cricket)` saw `undefined` and this
    // case could only ever produce the runs-only key — even though the
    // "amended 2026-09-07" doc comment above (and the test's own expectation
    // below) says `chaseBalls` reads the endpoint's `cricket.innings[]`, not
    // `summary.detail.innings`. Adding `cricket` (the shape Task 0 projects:
    // `{ runs, wickets, legalBalls, ballsLimit }`, no `entrantId`) is what
    // makes 120 − 72 = 48 actually reachable.
    const data: OverlayLiveData = {
      status: "in_play",
      summary: {
        headline: "180/8 (20) — 91/3 (12)",
        perSide: [{ entrantId: "H", line: "180/8 (20)" }, { entrantId: "A", line: "91/3 (12)" }],
        detail: {
          innings: [
            { entrantId: "H", runs: 180, wickets: 8, legalBalls: 120, ballsLimit: 120, declared: false, closed: true },
            { entrantId: "A", runs: 91, wickets: 3, legalBalls: 72, ballsLimit: 120, declared: false, closed: false },
          ],
        },
      },
      outcome: null,
      lastSeq: null,
      venueTz: "UTC",
      cricket: {
        innings: [
          { runs: 180, wickets: 8, legalBalls: 120, ballsLimit: 120 },
          { runs: 91, wickets: 3, legalBalls: 72, ballsLimit: 120 },
        ],
      },
    };
    const model = project("cricket", data);
    // Owner answer 12 closed deviation 6: both numbers, the shape `_THEMES.md`
    // §3 draws. The runs and the balls DIFFER here (90 vs 48) on purpose — with
    // equal numbers a transposed pair would pass.
    expect(model.chase).toBe("overlay.chase.needBalls(runs=90,balls=48)");
    expect(model.sides[1].big).toBe("91/3");
    expect(model.sides[1].sub).toBe("(12)");
    expect(model.detail, "W2 fills cricket's detail band; W1 leaves it empty (spec §2)").toEqual([]);
  });

  it("falls back to the runs-only line where the format declares no quota", () => {
    // Timed / unlimited cricket carries `ballsLimit: null` — "off null balls"
    // must never reach air, so the shorter key is the CORRECT render here, not
    // a degraded one.
    //
    // RE-PIN (2026-09-09): matching the fix above — without a `cricket` field
    // this test passed for the wrong reason (no endpoint innings at all, so
    // `chaseBalls` never even reached its own `ballsLimit: null` branch).
    // Adding it so the null-quota branch is what's actually exercised here.
    const data: OverlayLiveData = {
      status: "in_play",
      summary: {
        headline: "180/8 — 91/3",
        perSide: [{ entrantId: "H", line: "180/8" }, { entrantId: "A", line: "91/3" }],
        detail: {
          innings: [
            { entrantId: "H", runs: 180, wickets: 8, legalBalls: 300, ballsLimit: null, declared: true, closed: true },
            { entrantId: "A", runs: 91, wickets: 3, legalBalls: 130, ballsLimit: null, declared: false, closed: false },
          ],
        },
      },
      outcome: null,
      lastSeq: null,
      venueTz: "UTC",
      cricket: {
        innings: [
          { runs: 180, wickets: 8, legalBalls: 300, ballsLimit: null },
          { runs: 91, wickets: 3, legalBalls: 130, ballsLimit: null },
        ],
      },
    };
    expect(project("cricket", data).chase).toBe("overlay.chase.need(runs=90)");
  });
});

describe("overlayModel — the football family's clock", () => {
  it("places the stage's formatted clock in header.clock, and drops it on a decided frame (amended 2026-09-07)", () => {
    // The clock is the STAGE's 1 Hz timer, formatted by `formatClock` before it
    // reaches this pure model — the model neither reads a stamp nor derives a
    // number. The bar and the bug both render the cell only when it is set,
    // so an empty slot is invisible and a wrong one is on air for ninety
    // minutes; a decided frame shows none.
    const data: OverlayLiveData = {
      status: "in_play",
      summary: {
        headline: "2 — 1",
        perSide: [{ entrantId: "H", line: "2" }, { entrantId: "A", line: "1" }],
        detail: { periods: [{ phase: "H1", home: 1, away: 1 }, { phase: "H2", home: 1, away: 0 }] },
      },
      outcome: null,
      lastSeq: 9,
      venueTz: "UTC",
      clock: { phase: "H2", anchorSeconds: 761, anchorAtWallMs: 0 },
    };
    const model = project("football", data, null, "12:41");
    expect(model.header.clock).toBe("12:41");
    expect(model.header.context, "the phase is the context; the clock is its own cell").toBe("H2");
    const done = project("football", { ...data, status: "decided", outcome: { kind: "win", winner: "H" } }, null, "90:00");
    expect(done.header.clock, "no clock on a decided frame, whatever the stage hands in").toBeUndefined();
  });

  it("leaves the clock absent when the stage has nothing to show, and for a sport with none", () => {
    const unstamped: OverlayLiveData = {
      status: "in_play",
      summary: {
        headline: "0 — 0",
        perSide: [{ entrantId: "H", line: "0" }, { entrantId: "A", line: "0" }],
        detail: { periods: [{ phase: "H1", home: 0, away: 0 }] },
      },
      outcome: null,
      lastSeq: 1,
      venueTz: "UTC",
    };
    expect(project("football", unstamped, null, null).header.clock).toBeUndefined();
    const badminton = payload("badminton", [["core.start", {}], ["badminton.rally", { wonBy: "H" }]], "in_play");
    expect(project("badminton", badminton).header.clock).toBeUndefined();
  });
});

describe("overlayStartLabel", () => {
  // The formatter the overlay page calls with the `venueTz` Task 0 puts on the
  // payload. It lives here, beside the model, so the model itself stays pure
  // and free of `Intl` (deviation 3) while the format has ONE home and a test.
  const KICKOFF = "2026-09-05T14:30:00.000Z";

  it("formats in the VENUE zone — a UTC fallback would fail this case", () => {
    const label = overlayStartLabel(KICKOFF, "en-GB", "Asia/Kolkata");
    // 14:30 UTC is 20:00 in Kolkata. Asserted against the zone-shifted value
    // computed the same way, so the case moves if the format does but still
    // cannot pass on a UTC fallback.
    expect(label).toContain("20:00");
    expect(label, "this is the whole point of owner answer 12").not.toContain("14:30");
    expect(overlayStartLabel(KICKOFF, "en-GB", "UTC")).toContain("14:30");
  });

  it("honours the locale as well as the zone", () => {
    const nl = overlayStartLabel(KICKOFF, "nl", "Europe/Amsterdam");
    const en = overlayStartLabel(KICKOFF, "en-GB", "Europe/Amsterdam");
    expect(nl).toContain("16:30");
    expect(nl, "the weekday is localised, so the two labels differ").not.toBe(en);
  });

  it("is null with no scheduled time, and degrades rather than throwing on a bad zone", () => {
    expect(overlayStartLabel(null, "en-GB", "Europe/Amsterdam")).toBeNull();
    // `resolveVenueTz` should never hand this on, but a RangeError from
    // `Intl.DateTimeFormat` here would 500 the overlay mid-broadcast.
    expect(overlayStartLabel(KICKOFF, "en-GB", "Mars/Olympus_Mons")).toContain("14:30");
  });
});

describe("overlayModel — no literal escapes the dictionary", () => {
  it("every string the model produces is a msg key, a kernel value or a name", () => {
    // RE-PIN (2026-09-09): the brief specified volleyball here, but the
    // set-based kernel's own `summary().detail` (badminton/volleyball/table
    // tennis, kernel.ts:2399-2418) carries no `serving`, `strength` or
    // `discipline` field at all — every one of `detailOf()`'s three sources
    // returns null for EVERY set-based sport BY CONSTRUCTION (design: only
    // the period kernel and, for `serving`, the nested/tennis kernel populate
    // those keys), so a volleyball fixture can never produce a non-empty
    // `model.detail` and the loop below would run zero times — a check that
    // cannot fail. Icehockey (period kernel) DOES carry `detail.discipline`
    // (`state.cardLog`, period/kernel.ts:2524), so a suspension event here
    // actually drives the assertion the test's name promises.
    const data = payload("icehockey", [
      ["core.start", {}],
      ["icehockey.suspension.start", { by: "H", class: "minor" }],
    ], "in_play");
    const model = project("icehockey", data);
    expect(model.detail.length, "must actually carry a line, or the loop below asserts nothing").toBeGreaterThan(0);
    for (const line of model.detail) {
      expect(line, "detail lines are dictionary keys or engine notation, never English typed here")
        .toMatch(/^(overlay\.|[0-9]|[A-Za-z]{1,3}v[0-9])/);
    }
  });
});
