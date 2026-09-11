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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { V3_SKINS } from "@/components/v2/scorepad/v3/registry";
import { DISCIPLINE_LABEL_KEYS } from "@/lib/public-site";
import {
  DISCIPLINE_CLASS_TONE,
  disciplineTone,
  overlayModel,
  overlayStartLabel,
  shortCode,
  splitLine,
  type OverlayMsg,
} from "@/lib/overlay-model";
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
  /** Fix round 5 — the DLS marker needs `cfg.dls.enabled`, which no sport's
   *  `SIM_CONFIGS` entry turns on (cricket's is `{ ballsPerInnings: 30 }`).
   *  Still parsed through the module's OWN schema, so an invalid override is
   *  a ZodError here rather than a silently different world. */
  rawCfg: unknown = undefined,
): LiveFixtureData {
  const mod = moduleFor(key);
  const cfg = mod.configSchema.parse(rawCfg ?? SIM_CONFIGS[key] ?? {});
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
    expect(model.cellsKind, "no summary at all — the breakdown kind is \"none\"").toBe("none");
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
      expect(model.cellsKind, key).toBe("none");
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
      expect(model.cellsKind, key).toBe("none");
      expect(model.cells, key).toEqual([]);
      expect(model.detail, key).toEqual([]);
    }
  });

  // W2 Task 3 — the crease band REACHING the model, which is the only thing
  // that makes `cricketDetail` more than a well-tested function nothing calls.
  // Before W2, cricket's `detail` was always empty: the sport carries no
  // serving side, no strength and no discipline list, so the bar's second band
  // never rendered for it at all.
  it("cricket: the crease band reaches OverlayModel.detail, and is ABSENT without it", () => {
    const base = payload("cricket", [["cricket.toss", { wonBy: "H", elected: "bat" }], ["core.start", {}]], "in_play");
    expect(project("cricket", base).detail, "no crease block ⇒ no band").toEqual([]);

    const withCrease = {
      ...base,
      cricketLive: {
        batters: [
          { name: "Sharma", runs: 34, balls: 21, onStrike: true },
          { name: "Kohli", runs: 12, balls: 9, onStrike: false },
        ],
        bowler: { name: "Bumrah", overs: "2.3", maidens: 0, runs: 14, wickets: 1 },
        thisOver: [
          { kind: "runs" as const, runs: 1 },
          { kind: "runs" as const, runs: 4 },
          { kind: "wicket" as const, dismissal: "bowled" as const },
        ],
      },
    };
    const model = project("cricket", withCrease as never);
    // This suite's `msg` returns the KEY, so the two translated fragments
    // appear as keys — which is the point: the assertion pins the key AND the
    // composition around it, where an English expectation would pass with the
    // wrong key wired to the right word.
    const MARK = "overlay.cricket.strikerMark";
    const THIS_OVER = "overlay.cricket.thisOver";
    expect(model.detail.map((d) => d.text)).toEqual([
      `Sharma${MARK} 34 (21) · Kohli 12 (9)`,
      `Bumrah 2.3-0-14-1 · ${THIS_OVER} 1 4 W`,
    ]);
    // Not card chips — the band's tone is reserved for discipline lines.
    expect(model.detail.every((d) => d.tone === undefined)).toBe(true);
  });

  it("cricket: a DECIDED fixture drops the crease band — nobody is at the crease after the handshake", () => {
    // WITH A VERDICT, deliberately. A decided fixture carrying a null outcome
    // is VOIDED, and `detail` is emptied by the void guard before the live
    // guard is ever consulted — so the case would have passed against a build
    // that renders the crease band after the handshake. Found by a mutant that
    // removed the live guard and survived.
    const base = payload(
      "cricket",
      [["cricket.toss", { wonBy: "H", elected: "bat" }], ["core.start", {}]],
      "decided",
      { kind: "win", winner: "H" },
    );
    const model = project("cricket", {
      ...base,
      cricketLive: {
        batters: [{ name: "Sharma", runs: 34, balls: 21, onStrike: true }],
        thisOver: [],
      },
    } as never);
    expect(model.decided, "the verdict is real, so the void guard is NOT what empties the band").toBe(true);
    expect(model.voided).toBe(false);
    expect(model.detail).toEqual([]);
  });
});

describe("overlayModel — cells", () => {
  it("badminton renders one cell per game, in order, home–away, and cellsKind is \"sets\"", () => {
    const data = payload("badminton", [
      ["core.start", {}],
      ...Array.from({ length: 21 }, () => ["badminton.rally", { wonBy: "H" }] as const),
    ], "in_play");
    const model = project("badminton", data);
    expect(model.cellsKind, "a set/game breakdown, never \"periods\"").toBe("sets");
    expect(model.cells.length, "one closed game").toBeGreaterThanOrEqual(1);
    expect(model.cells[0].key).toBe("1");
    expect(model.cells[0].value).toMatch(/^\d+–\d+$/);
  });

  it("football renders one cell per period once periods exist, and cellsKind is \"periods\" — round 4, R1/R2's root cause: this is NOT the \"sets\" kind, so a renderer must not treat it as one", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
      ["football.period", { phase: "HT" }],
    ], "in_play");
    const model = project("football", data);
    expect(model.cellsKind).toBe("periods");
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
    expect(model.voided, "a plain decided fixture is never voided").toBe(false);
    expect(model.live).toBe(false);
    expect(model.header.context, "the status word — 'Final', not 'Ended' (F7)").toBe("overlay.header.ended");
    expect(model.result, "the ONE decided-sentence authority, renderDecidedOutcome").toBe(
      "WIN Milton Keynes Rovers REG",
    );
    expect(model.chase).toBeUndefined();
    expect(model.sides[0].led, "the winner keeps the LED").toBe(true);
    expect(model.sides[1].led).toBe(false);
  });
});

describe("overlayModel — the decided/void three-case split (fix round 3, F1)", () => {
  // RE-PIN: `VOID_STATUSES` (stages-panel.tsx) is the console's own authority
  // for "cancelled | abandoned | forfeited" — `overlay-model.ts` keeps a LOCAL
  // literal (bundle-weight reasoning, same as `use-overlay-clock.ts`'s
  // `NO_CLOCK_STATUSES`), proven equal here rather than imported.
  it("OVERLAY_VOID_STATUSES equals the console's own VOID_STATUSES", async () => {
    const { OVERLAY_VOID_STATUSES } = await import("@/lib/overlay-model");
    const { VOID_STATUSES } = await import("@/components/v2/stages-panel");
    expect(OVERLAY_VOID_STATUSES).toEqual(VOID_STATUSES);
  });

  // §3/§4's own two-conjunct predicate, `V355__division_results_abandoned_
  // outcome.sql`'s: `outcome is not null and outcome->>'kind' <> 'no_result'`.
  // Every case below is driven from a REAL outcome shape (never a
  // hand-written `decided` boolean) — `outcome` is the fixtures-table column
  // the projection reads verbatim, the same posture the pre-existing
  // "decided" describe block above already takes (folding the SUMMARY
  // through the real engine, since `outcome` itself is not a fold output).
  it("void carrying a verdict (forfeit, kind:'award'): the DECIDED treatment, with the status word instead of 'Final'", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
    ], "forfeited", { kind: "award", winner: "H", method: "regulation" });
    const model = project("football", data);
    expect(model.decided, "a real verdict on a void status still gets the decided treatment").toBe(true);
    expect(model.voided).toBe(false);
    expect(model.header.context, "the status word, NOT 'Final'").toBe("overlay.status.forfeited");
    expect(model.sides[0].led, "the winner keeps the LED even though the status is void").toBe(true);
    expect(model.sides[1].led).toBe(false);
    expect(model.result, "the footer/band sentence — already correct (P8) — must still render").toBeDefined();
  });

  it("void, no verdict (cricket abandon → a no_result OUTCOME): both sides ink-50%, no LED, no band", () => {
    // V355's own warning: a cricket abandon folds to a no_result OUTCOME —
    // the column is non-null, the verdict is "nothing happened". This is the
    // case `outcome != null` alone would misclassify as decided.
    const data = payload("cricket", [
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["core.start", {}],
      CRICKET_BALL(0, 1, 4),
    ], "abandoned", { kind: "no_result" });
    const model = project("cricket", data);
    expect(model.decided).toBe(false);
    expect(model.voided, "outcome is present but carries no verdict").toBe(true);
    expect(model.header.context).toBe("overlay.status.abandoned");
    expect(model.sides[0].led).toBe(false);
    expect(model.sides[1].led).toBe(false);
    expect(model.result).toBeUndefined();
    expect(model.detail, "no detail band for a void-no-verdict frame").toEqual([]);
  });

  it("void, no verdict, null outcome (the observed live bug): an abandoned match must NOT say 'Live'", () => {
    // The exact case the visual pass caught live: a real abandoned football
    // fixture with `outcome: null` rendered the word "Live" at full ink.
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
    ], "abandoned", null);
    const model = project("football", data);
    expect(model.decided).toBe(false);
    expect(model.voided).toBe(true);
    expect(model.header.context, "must be the status word, never 'overlay.header.live'").toBe(
      "overlay.status.abandoned",
    );
    expect(model.sides[0].led).toBe(false);
    expect(model.sides[1].led).toBe(false);
  });

  it("status 'decided' with a null outcome: ended but no verdict — 'Final', not the winner treatment", () => {
    const data = payload("tennis", [["core.start", {}]], "decided", null);
    const model = project("tennis", data);
    expect(model.decided, "no outcome to name a winner from").toBe(false);
    expect(model.voided).toBe(true);
    expect(model.header.context, "still 'Final' — the status itself is 'decided'").toBe("overlay.header.ended");
    expect(model.sides[0].led).toBe(false);
    expect(model.sides[1].led).toBe(false);
  });

  it("a void-no-verdict frame does not leak a stale LED from a frozen batting/serving side", () => {
    // Differential case for `ledEntrantId`'s `ended` guard: without it, this
    // payload's own OPEN (not closed) innings would hand `battingEntrantId`
    // a truthy id and light an LED on an abandoned match with no verdict.
    const data: OverlayLiveData = {
      status: "abandoned",
      summary: {
        headline: "180/8 (20) — 40/2 (8)",
        perSide: [{ entrantId: "H", line: "180/8 (20)" }, { entrantId: "A", line: "40/2 (8)" }],
        detail: {
          innings: [
            { entrantId: "H", runs: 180, wickets: 8, legalBalls: 120, closed: true },
            { entrantId: "A", runs: 40, wickets: 2, legalBalls: 48, closed: false },
          ],
        },
      },
      outcome: { kind: "no_result" },
      lastSeq: null,
      venueTz: "UTC",
    };
    const model = project("cricket", data);
    expect(model.voided).toBe(true);
    expect(
      model.sides.map((s) => s.led),
      "the ended guard must win over the open-innings fallback",
    ).toEqual([false, false]);
  });

  it("a live fixture is never treated as decided even if a stray outcome is present — `ended` gates `verdict`, not the reverse", () => {
    // Kills a `decided = verdict` (or `ended || verdict`) mutant: dropping the
    // `ended` conjunct would let a malformed/stale in-flight payload light the
    // decided/LED treatment on air mid-match.
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
    ], "in_play", { kind: "win", winner: "H" });
    const model = project("football", data);
    expect(model.decided, "in_play is not in ENDED_STATUSES, whatever the outcome column says").toBe(false);
    expect(model.voided).toBe(false);
    expect(model.header.context).toBe("overlay.header.live");
  });

  it("a voided frame clears a REAL discipline line, not only an absent one", () => {
    // Kills a `detail: voided ? [] : detailOf(...)` guard removed entirely:
    // icehockey's period kernel DOES populate `summary().detail.discipline`,
    // so an unguarded `detailOf` would render a card line on a match with no
    // verdict at all — exactly the "no detail band" case §3/§4 forbid.
    const data = payload("icehockey", [
      ["core.start", {}],
      ["icehockey.suspension.start", { by: "H", class: "minor" }],
    ], "abandoned", null);
    const model = project("icehockey", data);
    expect(model.voided).toBe(true);
    expect(model.detail, "no detail band on a void-no-verdict frame, even with a real discipline entry").toEqual([]);
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

// ---------------------------------------------------------------------------
// Fix round 5, I2 — `_THEMES.md` §3's "Decided / void" row specifies a CONTEXT
// LINE for all three of its cases, and the shipped model produced one for none
// of them: `headerPeriod` returned `undefined` for every ended fixture. Two of
// the three were simply missing; the third was an active REMOVAL, since §3
// says the sport's own line is "unchanged" there.
//
// The status WORD (`header.context`) is already right and is not re-litigated
// here — those cases live in the three-case-split describe above. This block
// is only about the second line.
// ---------------------------------------------------------------------------
describe("overlayModel — §3's decided/void context line (fix round 5, I2)", () => {
  it("decided: the context line is the SHORT form of the result sentence, from the same producer", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
    ], "decided", { kind: "win", winner: "H", method: "regulation" });
    const model = project("football", data);
    // §3:330-333 — "the band carries `resultMsg`'s full sentence, the context
    // line carries the same sentence with the winner reduced to the short name
    // the cell already uses… Both come from `resultMsg`; only the winner token
    // differs." `shortCode("Milton Keynes Rovers")` is "MIL".
    expect(model.result, "the detail band's own full sentence is unchanged").toBe(
      "WIN Milton Keynes Rovers REG",
    );
    expect(model.header.period, "the same sentence, short winner").toBe("WIN MIL REG");
    expect(
      model.header.period,
      "the differential: a short form built from the FULL name map would be identical to the band's",
    ).not.toBe(model.result);
  });

  it("void carrying a verdict (a forfeit): the same short form, under the status word", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
    ], "forfeited", { kind: "award", winner: "A", method: "regulation" });
    const model = project("football", data);
    expect(model.header.context, "the status word, not 'Final'").toBe("overlay.status.forfeited");
    // The winner here is AWAY, so a short form that always names sides[0]
    // would read "MIL" and pass a home-winner case forever.
    expect(model.header.period, "§3: 'the short form, same as decided'").toBe("WIN NOR REG");
    expect(model.result).toBe("WIN Northbridge Athletic REG");
  });

  it("void, no verdict — a CANCELLED tennis match keeps the set line it had while live", () => {
    // The concrete regression: before ending, the bar reads "Live / Set 3";
    // after, §3 says the sport's own line is UNCHANGED, and the shipped model
    // dropped it. The expectation is DERIVED from the same fold read as live,
    // never typed here — "unchanged" is a comparison, not a literal.
    const stream = [
      ["core.start", {}],
      ...Array.from({ length: 24 }, () => ["tennis.point", { by: "H" }] as const),
      ...Array.from({ length: 24 }, () => ["tennis.point", { by: "A" }] as const),
      ["tennis.point", { by: "H" }],
    ] as const;
    const live = project("tennis", payload("tennis", stream, "in_play"));
    expect(live.header.period, "anti-vacuity: the live fold must HAVE a set line").toBeDefined();
    expect(live.header.period, "…and it must be the set key, not a stray string").toMatch(
      /^overlay\.header\.set\(n=\d+\)$/,
    );

    const cancelled = project("tennis", payload("tennis", stream, "cancelled", null));
    expect(cancelled.voided, "cancelled never carries a verdict").toBe(true);
    expect(cancelled.header.context).toBe("overlay.status.cancelled");
    expect(cancelled.header.period, "§3: 'the sport's own line unchanged'").toBe(live.header.period);
  });

  it("void, no verdict — an ABANDONED football match keeps its period line too (the other branch of the sport's own line)", () => {
    // `headerPeriod` has two arms — `periodBreakdown` and `setBreakdown`. The
    // tennis case above only proves the second; mutating the first alone would
    // survive it.
    const stream = [
      ["core.start", {}],
      ["football.goal", { by: "H" }],
      ["football.period", { phase: "HT" }],
    ] as const;
    const live = project("football", payload("football", stream, "in_play"));
    expect(live.header.period, "anti-vacuity: H2 after the HT marker").toBe("H2");
    const abandoned = project("football", payload("football", stream, "abandoned", null));
    expect(abandoned.voided).toBe(true);
    expect(abandoned.header.period).toBe("H2");
  });

  it("a scheduled fixture still has NO context line — the guard that survives I2", () => {
    const model = project("generic", { status: "scheduled", summary: null, outcome: null }, "Sat 14:00");
    expect(model.header.period, "nothing has happened yet; there is no line to carry").toBeUndefined();
  });

  it("decided with a DRAW: no context line rather than a raw key or an empty string", () => {
    // `renderDecidedOutcome` returns null for `draw` (it describes wins, ties
    // and awards only), so both the band sentence and the short form are
    // absent — §3 asks for the short form OF the result sentence, and there
    // is none. The header must not fall back to the sport's own line here:
    // "H2" under the word "Final" would read as a live period.
    const data = payload("football", [
      ["core.start", {}],
      ["football.period", { phase: "HT" }],
    ], "decided", { kind: "draw" });
    const model = project("football", data);
    expect(model.decided, "a draw is a real verdict").toBe(true);
    expect(model.result).toBeUndefined();
    expect(model.header.period).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The DLS / Revised marker (owner ruling 2026-09-10, `_THEMES.md` §3's cricket
// row). `targetSource` is `"dls" | "manual" | null` — THREE cases, and a
// manually-set target must never be labelled DLS: that is a false claim about
// how a target was set, on a live broadcast.
//
// Every case below folds a REAL cricket ledger through the REAL module, so the
// `targetSource` under test is the one the engine emits beside `target`
// (`cricket.ts:3678-3680`) and the projection passes through whole — not a
// field a fixture on both ends invented.
// ---------------------------------------------------------------------------
describe("overlayModel — the chase line's revision marker (fix round 5)", () => {
  /** Innings 2's deliveries: the bowler must be in the FIELDING lineup, which
   *  is the one membership check a non-strict read fold enforces. */
  const CHASE_BALL = (over: number, ball: number, runs: number) =>
    ["cricket.ball", { over, ballInOver: ball, striker: "A-p1", nonStriker: "A-p2", bowler: "H-p1", runs: { bat: runs } }] as const;

  /** H bats first for 8, closes, (optionally revises), A faces one ball. */
  const stream = (revise: readonly (readonly [string, unknown])[]) => [
    ["cricket.toss", { wonBy: "H", elected: "bat" }],
    ["core.start", {}],
    CRICKET_BALL(0, 1, 4),
    CRICKET_BALL(0, 2, 4),
    ["cricket.innings.close", {}],
    ...revise,
    CHASE_BALL(0, 1, 1),
  ] as const;

  const DLS_CFG = { ballsPerInnings: 30, dls: { enabled: true, edition: "standard" } };

  const sourceOf = (data: LiveFixtureData) =>
    (data.summary as { detail?: { targetSource?: unknown } } | null)?.detail?.targetSource;

  it("no revision: the chase line is unchanged, with no marker at all", () => {
    const data = payload("cricket", stream([]), "in_play");
    expect(sourceOf(data), "an unrevised fold emits no targetSource — the third union member").toBeUndefined();
    const model = project("cricket", data);
    expect(model.chase, "8 set, 1 chased ⇒ need 8").toBe("overlay.chase.need(runs=8)");
    expect(model.chase).not.toContain("·");
  });

  it("a MANUALLY revised target is labelled 'Revised' — never DLS", () => {
    const data = payload("cricket", stream([["cricket.revise", { target: 40 }]]), "in_play");
    expect(sourceOf(data), "the engine's own word for this ledger").toBe("manual");
    const model = project("cricket", data);
    expect(model.chase).toBe("overlay.chase.need(runs=39) · overlay.chase.revised");
    expect(
      model.chase,
      "the whole point of the three-case split: this must not claim a DLS calculation",
    ).not.toContain("overlay.chase.dls");
  });

  it("a DLS-computed target is labelled 'DLS'", () => {
    // A rain-shortened chase: innings 1 closed at 30 balls of resources, the
    // chase revised down to 3 overs, so the engine recomputes the target
    // itself and stamps `targetSource: "dls"`.
    const data = payload(
      "cricket",
      stream([["cricket.revise", { oversPerSide: 3 }]]),
      "in_play",
      null,
      DLS_CFG,
    );
    expect(sourceOf(data), "the engine computed this one").toBe("dls");
    const model = project("cricket", data);
    expect(model.chase).toContain(" · overlay.chase.dls");
    expect(model.chase, "…and it must not read as a manual revision").not.toContain(
      "overlay.chase.revised",
    );
    expect(model.chase, "the marker rides the existing line, it does not replace it").toMatch(
      /^overlay\.chase\.need\(runs=\d+\) · overlay\.chase\.dls$/,
    );
  });

  it("the three cases produce three DIFFERENT markers — the runs alone already differ, so compare the SUFFIX", () => {
    // Comparing whole chase lines here would be vacuous: the three folds set
    // three different targets, so the lines differ whether or not a marker is
    // appended at all. The marker is what this asserts.
    const markerOf = (line: string | undefined) =>
      (line ?? "").replace(/^overlay\.chase\.need\(runs=\d+\)/, "");
    const none = markerOf(project("cricket", payload("cricket", stream([]), "in_play")).chase);
    const manual = markerOf(
      project("cricket", payload("cricket", stream([["cricket.revise", { target: 40 }]]), "in_play")).chase,
    );
    const dls = markerOf(
      project(
        "cricket",
        payload("cricket", stream([["cricket.revise", { oversPerSide: 3 }]]), "in_play", null, DLS_CFG),
      ).chase,
    );
    expect(none, "no revision ⇒ nothing after the line").toBe("");
    expect(new Set([none, manual, dls]).size, "three distinct markers").toBe(3);
  });

  it("a wire that carries a target but NO targetSource gets no marker — never a guessed method", () => {
    // Older rows, a coarsened summary, or any producer that stops emitting the
    // field: `target` alone must not be read as "revised by DLS".
    const data: OverlayLiveData = {
      status: "in_play",
      summary: {
        headline: "180/8 (20) — 91/3 (12)",
        perSide: [{ entrantId: "H", line: "180/8 (20)" }, { entrantId: "A", line: "91/3 (12)" }],
        detail: {
          target: 150,
          innings: [
            { entrantId: "H", runs: 180, wickets: 8, legalBalls: 120, closed: true },
            { entrantId: "A", runs: 91, wickets: 3, legalBalls: 72, closed: false },
          ],
        },
      },
      outcome: null,
      lastSeq: null,
      venueTz: "UTC",
    };
    expect(project("cricket", data).chase).toBe("overlay.chase.need(runs=59)");
  });

  it("an UNKNOWN targetSource gets no marker — the reader names the two methods it knows, not 'not null'", () => {
    // A future method (VJD, a bespoke league rule) must fall through to the
    // unmarked line rather than being announced as DLS.
    const data: OverlayLiveData = {
      status: "in_play",
      summary: {
        headline: "180/8 (20) — 91/3 (12)",
        perSide: [{ entrantId: "H", line: "180/8 (20)" }, { entrantId: "A", line: "91/3 (12)" }],
        detail: {
          target: 150,
          targetSource: "vjd",
          innings: [
            { entrantId: "H", runs: 180, wickets: 8, legalBalls: 120, closed: true },
            { entrantId: "A", runs: 91, wickets: 3, legalBalls: 72, closed: false },
          ],
        },
      },
      outcome: null,
      lastSeq: null,
      venueTz: "UTC",
    };
    expect(project("cricket", data).chase).toBe("overlay.chase.need(runs=59)");
  });

  it("no chase, no marker — a revised target on an ENDED fixture carries nothing", () => {
    const data = payload(
      "cricket",
      stream([["cricket.revise", { target: 40 }]]),
      "abandoned",
      { kind: "no_result" },
    );
    const model = project("cricket", data);
    expect(model.voided).toBe(true);
    expect(model.chase, "§3's void-no-verdict frame renders no detail band at all").toBeUndefined();
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
    // Fix round 3, F4 — split: the FIRST line always says "Live" while
    // playing (never the phase), and the phase is now its own context LINE.
    expect(model.header.context, "the live/status word — never the phase").toBe("overlay.header.live");
    expect(model.header.period, "the phase is its own context line").toBe("H2");
    const done = project("football", { ...data, status: "decided", outcome: { kind: "win", winner: "H" } }, null, "90:00");
    expect(done.header.clock, "no clock on a decided frame, whatever the stage hands in").toBeUndefined();
    // AMENDED, fix round 5 (I2). This line used to assert `toBeUndefined()`
    // "no second line once ended (P8's already-correct decided render)" — it
    // was pinning the DEFECT: `_THEMES.md` §3's "Decided / void" row gives the
    // decided case a context line ("the short form of the result sentence"),
    // and round 3's `headerPeriod` returned undefined for every ended fixture.
    // The clock is still dropped; the LINE is now the short sentence. The
    // templates here carry no `regulation` entry, so `renderDecidedOutcome`
    // falls to `plain` — "WIN {winner}" with the CELL's short name.
    expect(done.header.period, "the short form replaces the phase once decided").toBe("WIN MIL");
    expect(done.header.period, "…and it is NOT the phase it showed while live").not.toBe("H2");
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
    // Fix round 3, F4 — badminton DOES have a context line (its game/set
    // breakdown); a sport with neither periods nor sets (generic) has none —
    // an absent line, not a fallback to "Live" repeated on two lines.
    expect(project("badminton", badminton).header.period).toBeDefined();
    const generic = payload("generic", [["core.start", {}]], "in_play");
    expect(project("generic", generic).header.context).toBe("overlay.header.live");
    expect(project("generic", generic).header.period).toBeUndefined();
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
      expect(line.text, "detail lines are dictionary keys or engine notation, never English typed here")
        .toMatch(/^(overlay\.|[0-9]|[A-Za-z]{1,3}v[0-9])/);
    }
  });
});

describe("overlayModel — discipline chip tone (review round 1, IMPORTANT)", () => {
  // Folded through the REAL engine, same shape as the test above: icehockey's
  // period kernel writes `classKey: payload.class` straight off the
  // suspension event (`packages/engine/src/sports/period/kernel.ts:1195`,
  // `:2524` for `discipline: state.cardLog`). Three classes, three different
  // answers — the differential this table exists to prove, not one lucky
  // sample (AGENTS.md #7): `minor` is coloured, `major` is DECLARED
  // uncoloured (not merely unknown), `match` is a different tone again.
  it("a coloured class (icehockey minor → caution) carries that tone", () => {
    const data = payload("icehockey", [
      ["core.start", {}],
      ["icehockey.suspension.start", { by: "H", class: "minor" }],
    ], "in_play");
    const model = project("icehockey", data);
    const card = model.detail.find((l) => l.text.startsWith("overlay.detail.card"));
    expect(card, "no card line — the discipline entry itself is missing").toBeDefined();
    expect(card!.tone).toBe("caution");
  });

  it("a 5-minute major carries the DISMISSAL tone — it used to carry none (F13)", () => {
    // This test asserted `toBeUndefined()` until 2026-09-10, freezing the
    // defect as its expected value (AGENTS.md #4). `major` rendered no chip
    // at all while a 2-minute `minor` rendered one, which is backwards on a
    // broadcast: the more serious the offence, the less visible the graphic.
    const data = payload("icehockey", [
      ["core.start", {}],
      ["icehockey.suspension.start", { by: "H", class: "major" }],
    ], "in_play");
    const model = project("icehockey", data);
    const card = model.detail.find((l) => l.text.startsWith("overlay.detail.card"));
    expect(card, "no card line — the discipline entry itself is missing").toBeDefined();
    expect(card!.tone, "_THEMES.md §2a: major is the serious family").toBe("dismissal");
  });

  it("an UNKNOWN class still carries no tone — absence must stay reachable", () => {
    // The positive pair for every "carries a tone" case above. With §2a's
    // ruling no DECLARED class is uncoloured any more, so `disciplineTone`'s
    // undefined arm is now reachable only through a class no table names —
    // and a mutant that returned a constant tone would otherwise survive.
    expect(disciplineTone("no_such_class")).toBeUndefined();
  });

  it("a THIRD class (icehockey match → dismissal) differs from both — not a constant", () => {
    const data = payload("icehockey", [
      ["core.start", {}],
      ["icehockey.suspension.start", { by: "H", class: "match" }],
    ], "in_play");
    const model = project("icehockey", data);
    const card = model.detail.find((l) => l.text.startsWith("overlay.detail.card"));
    expect(card, "no card line — the discipline entry itself is missing").toBeDefined();
    expect(card!.tone).toBe("dismissal");
  });

  it("a non-discipline detail line (the serve sentence) never carries a tone", () => {
    const data = payload("tennis", [
      ["core.start", {}],
      ["tennis.point", { by: "H" }],
    ], "in_play");
    const model = project("tennis", data);
    const serveLine = model.detail.find((l) => l.text.startsWith("overlay.detail.serving"));
    expect(serveLine, "tennis's serve line should be present here").toBeDefined();
    expect(serveLine!.tone).toBeUndefined();
  });

  // Review round 2 finding: football's own branch of DISCIPLINE_CLASS_TONE
  // is unreachable today — football is not a period-kernel sport
  // (`packages/engine/src/sports/football/football.ts:509`, "The period
  // kernel's cardLog is the same idea; football simply had none") and its
  // `summary().detail` never carries a `discipline` key at all (only
  // `periods`, optionally `shootout`, optionally `abandoned` — confirmed by
  // reading the function body, not inferred). `disciplineList()` is
  // therefore always null for football, so `detailOf()`'s card branch never
  // runs for it — no card LINE, let alone a coloured chip. Folded through
  // the real engine with an actual `football.card` event to prove this
  // empirically rather than asserting it only in a comment.
  it("football never produces a card line — not a bug, an engine data gap (review round 2)", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.card", { by: "H", color: "yellow" }],
    ], "in_play");
    const model = project("football", data);
    const cardLine = model.detail.find((l) => l.text.startsWith("overlay.detail.card"));
    expect(
      cardLine,
      "if this ever finds a line, football's engine summary has grown a discipline field and " +
        "DISCIPLINE_CLASS_TONE's football entries are live — update the docstring in overlay-model.ts",
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F13 — "every card class gets a chip" (product ruling 2026-09-10). `_THEMES.md`
// §2a's TABLE is the authority for the overlay's chip tones, so the expectations
// below are PARSED OUT OF IT rather than retyped here: a table typed into a
// test asserts yesterday's numbers the moment the sheet moves (AGENTS.md #19).
// The parser is deliberately the same shape as `contrast.test.ts`'s
// (`sheetSection` / `tableRows`), which reads §2 and §5 of the same file.
// ---------------------------------------------------------------------------
const SHEET_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../../..", "docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md");

/** Non-throwing on purpose — an `it.each` source that throws at COLLECTION
 *  time takes the whole file down into a vacuous green. The strict read is a
 *  named test below. */
function sheet(): string {
  try {
    return readFileSync(SHEET_PATH, "utf8");
  } catch {
    return "";
  }
}

/** §2a's rows as `{ sport, classKey, tone }`, one entry PER CLASS — the table
 *  lists icehockey's families three and four to a row. */
function sheetClassTones(): { sport: string; classKey: string; tone: string }[] {
  const text = sheet();
  const start = text.indexOf("\n### 2a.");
  const section = start < 0 ? "" : text.slice(start, (() => {
    const end = text.indexOf("\n## ", start + 1);
    return end < 0 ? undefined : end;
  })());
  const out: { sport: string; classKey: string; tone: string }[] = [];
  for (const line of section.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length !== 6) continue; // 4 columns + the two empty edges
    const [, sport, classes, tone] = cells;
    if (sport !== "hockey" && sport !== "icehockey") continue;
    const toneWord = tone!.match(/\b(advisory|caution|dismissal)\b/)?.[1];
    if (!toneWord) continue;
    for (const m of classes!.matchAll(/`([a-z_]+)`/g)) out.push({ sport, classKey: m[1]!, tone: toneWord });
  }
  return out;
}

describe("DISCIPLINE_CLASS_TONE is §2a's table, class by class (F13)", () => {
  // The empty case FIRST: every sweep below is an `it.each` over the parsed
  // rows, and an empty parse answers yes to every question there is.
  it("the sheet parses into the ten rows §2a declares — three hockey, seven icehockey", () => {
    expect(() => readFileSync(SHEET_PATH, "utf8"), `_THEMES.md at ${SHEET_PATH}`).not.toThrow();
    const rows = sheetClassTones();
    expect(rows.filter((r) => r.sport === "hockey").map((r) => r.classKey).sort()).toEqual(["green", "red", "yellow"]);
    expect(rows.filter((r) => r.sport === "icehockey").map((r) => r.classKey).sort()).toEqual(
      ["bench_minor", "double_minor", "game_misconduct", "major", "match", "minor", "misconduct"],
    );
    // §2a: "Two tiers for icehockey, not three… `advisory` stays unused there".
    expect(rows.filter((r) => r.sport === "icehockey" && r.tone === "advisory"), "no green card in ice hockey").toEqual([]);
  });

  // PER MEMBER, not per map: a single case over the whole table is satisfied
  // by any one class, and the five classes this ruling exists for are exactly
  // the ones such a case would not name.
  it.each(sheetClassTones())("$sport $classKey → $tone", ({ classKey, tone }) => {
    expect(disciplineTone(classKey)).toBe(tone);
  });

  // Review MINOR 9 — §2a's OTHER ruling about these same ten classes: the
  // LABEL is owed in four locales, keyed off the class rather than off the
  // derived English, "so a future class is a missing key rather than a
  // silently-anglicised label". This is the test that makes that true: the
  // class list is parsed from §2a's own table, so a row added to the sheet
  // reds here until its key exists, and the anglicised label never ships.
  it("every class §2a's table names has a label key, and the map names no other (MINOR 9)", () => {
    const declared = [...new Set(sheetClassTones().map((r) => r.classKey))].sort();
    expect(declared.length, "the sheet parsed no classes — this check would be vacuous").toBe(10);
    expect(Object.keys(DISCIPLINE_LABEL_KEYS).sort()).toEqual(declared);
  });

  it("the model resolves the card label through msg, never as a typed English word", () => {
    // `keyMsg` returns the key it was handed, so a label that came from the
    // class key instead of the dictionary shows up as prose among keys.
    const data = payload("icehockey", [
      ["core.start", {}],
      ["icehockey.suspension.start", { by: "H", class: "bench_minor" }],
    ], "in_play");
    const model = project("icehockey", data);
    const card = model.detail.find((l) => l.text.startsWith("overlay.detail.card"));
    expect(card, "no card line — the discipline entry itself is missing").toBeDefined();
    expect(card!.text, "the label reached the wire as English, not as a key").toContain(
      "card=overlay.card.benchMinor",
    );
    expect(card!.text).not.toContain("Bench minor");
  });

  // The tone has to survive the REAL fold, not just the lookup table — the
  // three engine-driven cases above cover minor/major/match; this covers the
  // remaining four, each through its own `icehockey.suspension.start`.
  it.each(["bench_minor", "double_minor", "misconduct", "game_misconduct"])(
    "%s reaches the detail line with §2a's tone, folded through the real engine",
    (classKey) => {
      const expected = sheetClassTones().find((r) => r.sport === "icehockey" && r.classKey === classKey)?.tone;
      expect(expected, `§2a names no tone for ${classKey}`).toBeDefined();
      const data = payload("icehockey", [
        ["core.start", {}],
        ["icehockey.suspension.start", { by: "H", class: classKey }],
      ], "in_play");
      const model = project("icehockey", data);
      const card = model.detail.find((l) => l.text.startsWith("overlay.detail.card"));
      expect(card, "no card line — the discipline entry itself is missing").toBeDefined();
      expect(card!.tone).toBe(expected);
    },
  );
});

// The title keeps the phrase `skins/football.tsx`'s own comment points at
// ("DISCIPLINE_CLASS_TONE mirrors the pad's own per-sport tables"), but no
// longer claims it without exception: §2a took ice hockey's TONES off the pad
// (F13). The key sets are still one authority; the second case below is the
// divergence, asserted rather than implied.
describe("DISCIPLINE_CLASS_TONE mirrors the pad's own per-sport tables, except ice hockey's tones (§2a)", () => {
  // `overlay-model.ts` deliberately holds a LITERAL rather than importing
  // these "use client" pad skins (bundle weight — same reasoning as
  // `overlay-tokens.ts`'s `OVERLAY_SPORT_KEYS`). This is where the two are
  // proven equal, in BOTH directions, so neither a class this literal drops
  // nor one the pad adds can drift unnoticed. Import cost is fine here: test
  // code never ships (`contrast.test.ts` already imports the whole
  // `V3_SKINS` registry the same way).
  it("names exactly the classes the pad's tables name — no more, no fewer", async () => {
    const { CARD_TONES } = await import("@/components/v2/scorepad/v3/skins/football");
    const { HOCKEY_CLASSES } = await import("@/components/v2/scorepad/v3/skins/hockey");
    const { ICEHOCKEY_CLASSES } = await import("@/components/v2/scorepad/v3/skins/icehockey");
    const union: Record<string, readonly string[]> = {
      ...CARD_TONES,
      ...HOCKEY_CLASSES,
      ...ICEHOCKEY_CLASSES,
    };
    // The KEY SET is still mirrored in both directions — a class either table
    // adds, drops or renames must red here — the same shape `contrast.test.ts`
    // uses for `OVERLAY_SPORT_KEYS` vs `V3_SKINS`. A count match alone would
    // hide a rename (same length, different name).
    expect(Object.keys(DISCIPLINE_CLASS_TONE).sort(), "this literal names a class the pad's tables don't").toEqual(
      Object.keys(union).sort(),
    );
    // VALUES: football and hockey still resolve to the pad's own tone. Their
    // rows are unchanged by §2a ("Hockey's three are unchanged"), so a drift
    // there is a defect, not a ruling.
    for (const [classKey, tones] of [...Object.entries(CARD_TONES), ...Object.entries(HOCKEY_CLASSES)]) {
      const expected = tones.length > 0 ? tones[tones.length - 1] : undefined;
      expect(disciplineTone(classKey), classKey).toBe(expected);
    }
  });

  it("DIVERGES from the pad on ice hockey, deliberately — §2a outranks ICEHOCKEY_CLASSES here", async () => {
    // The one place the two are no longer one authority, recorded rather than
    // silently dropped. The pad's table declares five of the seven UNCOLOURED
    // (`[]`); §2a rules that every card class gets a chip on air. The pad is
    // `components/v2/**` and out of this wave's scope, so the divergence is
    // asserted in BOTH halves: which classes the pad still leaves empty, and
    // that the overlay colours every one of them. If the pad is later brought
    // into line, this test reds and is deleted — it must not be weakened into
    // "they agree" while the empties are still there.
    const { ICEHOCKEY_CLASSES } = await import("@/components/v2/scorepad/v3/skins/icehockey");
    const padEmpty = Object.entries(ICEHOCKEY_CLASSES)
      .filter(([, tones]) => tones.length === 0)
      .map(([classKey]) => classKey)
      .sort();
    expect(padEmpty, "the pad's own uncoloured set moved — re-read §2a before changing this").toEqual(
      ["bench_minor", "double_minor", "game_misconduct", "major", "misconduct"],
    );
    for (const classKey of padEmpty) {
      expect(disciplineTone(classKey), `${classKey} must carry a chip on air`).toBeDefined();
    }
  });
});
