// R7/task D — WHO OWNS THE RESULT LINE.
//
// `pad-host.tsx` renders `data-role="v3-headline"`, a slate bar above the
// scorebug carrying the engine's `summary.headline`. It exists for a real
// reason: v3 originally dropped the legacy pad's headline and a finished match
// showed two scores and nothing saying who WON — on a tie that is the entire
// outcome. So it is never simply deletable.
//
// It is also, for most sports, the third render of the same score above the
// fold (D-11/GF-2). R6's ruling, verbatim:
//
//   "do not hardcode a per-sport suppression list in the chassis. A skin
//   should DECLARE whether it owns the headline's information, the same
//   opt-in shape `phase?(view)` already uses — then hockey and ice hockey
//   suppress it once their own strip surfaces shootout and OT, cricket keeps
//   it (the chase equation earns its place), and no chassis-side list has to
//   be kept in sync with eleven skins."
//
// This file holds all three halves of that: the chassis gate, the pinned set
// of skins that declare, and — the part that actually matters — proof that
// each declaring skin's OWN surface carries what its headline says. A
// declaration is a claim about the product; without the third section it is
// just a boolean nobody checked, and the wave's own register is full of those.
import { describe, it, expect } from "vitest";
import { initSquads, type LineupPair } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import type { EventEnvelope } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldClient } from "../../module-client";
import {
  decidedShootout,
  foldPeriod,
  lineupsFor,
  nextAdvanceOf,
  periodCfg,
  shootoutCfgOf,
  summaryOf,
  type Spec,
} from "./_period-fold";
import { shouldRenderHeadline } from "../pad-host";
import { V3_SKINS } from "../registry";
import { summaryHeadline } from "../../view-model";
import type { PadHostView, ScorebugSpec, SkinDefV3 } from "../types";
import type { TFn } from "../skins/period-shared";

import enUi from "@/dictionaries/en/ui.json";

/** Resolves REAL copy, not the key. The first draft returned the key itself and
 *  the period sweep reported three defects that were not there: the ice hockey
 *  shoot-out chip "says GWS" only once `pad.icehockey.strip.shootout` is
 *  translated, and under a key-echoing stub it says `pad.icehockey.strip.
 *  shootout`. A test measuring a scorer-visible string has to resolve copy the
 *  way the scorer's browser does. Falls back to the key so a missing entry
 *  shows up as an obviously-wrong string rather than an empty one. */
const DICT = enUi as Record<string, string>;
const T = ((key: string) => DICT[key] ?? key) as unknown as TFn;

const HERE = new URL(".", import.meta.url).pathname;

const moduleOf = (key: string): AnySportModule => {
  const found = builtinModules.find((m) => m.key === key);
  if (!found) throw new Error(`no engine module for "${key}"`);
  return found;
};

/** A `PadHostView` whose `state` AND `summary` both come out of the REAL fold,
 *  never a hand-shaped object — the same construction every skin test in this
 *  directory uses, for the same reason: a fixture on both ends proves the
 *  fixture. */
/** The cfg a module would really run under. `parse({})` succeeds for ten of
 *  the eleven; generic's `resultMode` has no default, on purpose — the whole
 *  point of that module is that an organiser SAYS whether the sport is scored
 *  or win/loss. Rather than type a config here (which would be this file
 *  asserting against its own invention), fall back to the module's own first
 *  SHIPPED variant, the same rows synced into `sport_variants` and served to
 *  clients as `default_config`. */
function cfgFor(sportModule: AnySportModule): unknown {
  try {
    return sportModule.configSchema.parse({});
  } catch {
    const variants = (sportModule as { variants?: Record<string, unknown> }).variants ?? {};
    const first = Object.values(variants)[0];
    if (first === undefined) throw new Error(`${sportModule.key}: no default cfg and no shipped variant to fall back to`);
    return sportModule.configSchema.parse(first);
  }
}

function viewOf(key: string, stream: readonly (readonly [string, unknown])[] = [["core.start", {}]]): PadHostView {
  const sportModule = moduleOf(key);
  const cfg: unknown = cfgFor(sportModule);
  const lineups: LineupPair = defaultLineupPair(sportModule.positions);
  const events: EventEnvelope[] = stream.map(([type, payload], i) =>
    makeEnvelope(i, { type, payload } as never),
  );
  const state = foldClient(sportModule, cfg, lineups, events);
  return {
    cfg,
    state,
    summary: sportModule.summary(state as never),
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: {},
    squads: (((state as { squads?: unknown }).squads as PadHostView["squads"]) ?? initSquads(lineups)),
    events,
    contextOverrides: {},
  };
}

const skinOf = (key: string): SkinDefV3 => {
  const factory = (V3_SKINS as unknown as Record<string, ((t: TFn) => SkinDefV3) | undefined>)[key];
  if (!factory) throw new Error(`no v3 skin for "${key}"`);
  return factory(T);
};

/** Every string the scorebug actually puts on screen: both halves' names,
 *  big number and sub, plus every strip item's label and value, plus the phase
 *  token. Deliberately NOT the raw spec object — the question is what a scorer
 *  READS, so anything not rendered as text must not count as "already shown". */
function bugText(bug: ScorebugSpec): string {
  const parts: string[] = [];
  for (const half of bug.halves) {
    for (const who of half.who ?? []) parts.push(who.name ?? "");
    parts.push(half.big ?? "", half.sub ?? "");
  }
  for (const item of bug.strip ?? []) parts.push(item.label ?? "", item.value ?? "");
  parts.push(bug.phase ?? "", bug.context ?? "");
  return parts.join(" ");
}


// The headline's own tokens, taken from the ENGINE's string rather than a
// table typed here — so a kernel that starts saying something new reds this
// instead of leaving the assertion pinned to yesterday's grammar. Separators
// and the em-dash are dropped; what remains is the facts.
/** The headline's own DATA tokens — anything containing a digit — taken from
 *  the ENGINE's string rather than a table typed here, so a kernel that starts
 *  publishing a new number reds this instead of leaving the assertion pinned to
 *  yesterday's grammar.
 *
 *  DIGITS ONLY, and that is a deliberate narrowing rather than a convenience.
 *  A headline and a strip chip may legitimately state the same FACT in
 *  different words — ice hockey's headline abbreviates a win in extra time as
 *  `(OT)` while the chip spells it out ("Won in overtime"), which is better
 *  copy on the chip, not a missing fact. A literal word match would call that a
 *  defect. Numbers have no such freedom: a score is the same characters
 *  wherever it appears, so a missing one is always a real loss. The word-shaped
 *  facts are asserted individually instead, against the chip that carries
 *  them. */
const dataTokens = (headline: string): string[] =>
  headline
    .split(/[\s—·,()–]+/u)
    .map((token) => token.trim())
    .filter((token) => /\d/.test(token));

// ---------------------------------------------------------------------------
// 1. THE CHASSIS GATE
// ---------------------------------------------------------------------------

describe("the gate itself", () => {
  const view = viewOf("generic");

  it("renders when the skin says nothing — omitting the method must mean KEEP", () => {
    expect(shouldRenderHeadline("1 — 0", {}, view)).toBe(true);
  });

  it("suppresses when the skin declares it owns the information", () => {
    expect(shouldRenderHeadline("1 — 0", { ownsHeadline: () => true }, view)).toBe(false);
  });

  it("renders when a skin declares FALSE — an explicit 'I do not cover it' is not the same as silence, and must not be read as one", () => {
    expect(shouldRenderHeadline("1 — 0", { ownsHeadline: () => false }, view)).toBe(true);
  });

  it("renders nothing when the engine published no headline, whatever the skin says", () => {
    // The two reasons are INDEPENDENT. A skin that owns the headline must not
    // resurrect a null one, and a null one must not be taken as a suppression.
    expect(shouldRenderHeadline(null, {}, view)).toBe(false);
    expect(shouldRenderHeadline(null, { ownsHeadline: () => true }, view)).toBe(false);
  });

  it("is handed the SAME view the skin's other builders get, so a state-dependent answer is possible", () => {
    // Nothing needs this yet — every current answer is state-independent — but
    // the signature is the guarantee that a future skin covering the headline
    // in some states and not others can say so, instead of choosing between a
    // duplicated bar and a lost fact.
    const seen: PadHostView[] = [];
    shouldRenderHeadline("1 — 0", { ownsHeadline: (v) => (seen.push(v as PadHostView), true) }, view);
    expect(seen).toEqual([view]);
  });
});

// ---------------------------------------------------------------------------
// 2. THE DECISION, PINNED
// ---------------------------------------------------------------------------

describe("which skins declare they own the result line", () => {
  // Pinned as two explicit lists rather than counted: the point is that each
  // sport made a decision, so a NEW skin appearing in neither list is a red
  // that asks the question, and a sport silently moving between them is a red
  // that asks for a reason. Both are what this test is for.
  // ALWAYS owns — the answer does not depend on match state.
  const OWNS = ["boardgame", "carrom", "football", "generic", "hockey", "icehockey"];
  // ALWAYS keeps — their headline carries the closed-set lines (`21–15, 18–21`)
  // and nothing else on the pad shows them.
  const KEEPS = ["badminton", "tabletennis", "tennis", "volleyball"];
  // STATE-DEPENDENT. Cricket is the first skin to answer per state, which is
  // what `ownsHeadline` taking `view` was for. Asserted in BOTH states in its
  // own block below, not here — a single-state row in either list above would
  // record half the rule and read as if it were the whole one.
  const STATEFUL = ["cricket"];

  it("covers every shipped v3 skin, with no sport in two lists or none", () => {
    expect([...OWNS, ...KEEPS, ...STATEFUL].sort()).toEqual(Object.keys(V3_SKINS).sort());
  });

  for (const key of OWNS) {
    it(`${key} declares it owns the headline, so the chassis bar is suppressed`, () => {
      const view = viewOf(key);
      expect(skinOf(key).ownsHeadline?.(view)).toBe(true);
      expect(shouldRenderHeadline("anything", skinOf(key), view)).toBe(false);
    });
  }

  // R7/D follow-up — cricket's two states, the first state-dependent answer in
  // the chassis.
  //
  // Before a ball is bowled `sideLine` (cricket.ts) returns the literal "—"
  // for each side, so the bar renders `— — —`: a slate band above the fold on
  // a phone carrying nothing at all, on the first screen a cricket scorer
  // opens. After that the bar is the ONLY surface showing both sides' totals —
  // the halves show the striking side's score and the overs, never the other
  // innings — so it earns its place and keeps it for the rest of the match.
  describe("cricket answers per STATE", () => {
    // A REAL delivery, full `CricketBall` payload (cricket.ts) — person ids are
    // `defaultLineupPair`'s own H-p*/A-p*. A partial payload is refused by the
    // engine, which is the right behaviour and would make this fixture a lie.
    const BALL = [
      "cricket.ball",
      { over: 0, ballInOver: 1, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p1", runs: { bat: 1 } },
    ] as const;

    it("owns it before a ball is bowled — the bar would say `— — —` and nothing else", () => {
      const view = viewOf("cricket");
      expect(summaryHeadline(view.summary), "the state this rule exists for").toBe("— — —");
      expect(skinOf("cricket").ownsHeadline?.(view)).toBe(true);
      expect(shouldRenderHeadline("— — —", skinOf("cricket"), view)).toBe(false);
    });

    it("gives it back the moment an innings exists, and the bar then says something the bug does not", () => {
      const view = viewOf("cricket", [["core.start", {}], BALL]);
      expect(skinOf("cricket").ownsHeadline?.(view)).toBe(false);
      const headline = summaryHeadline(view.summary);
      expect(headline, "an innings exists, so this is no longer all dashes").not.toBe("— — —");
      expect(shouldRenderHeadline(headline, skinOf("cricket"), view)).toBe(true);
    });

    it("is NOT gated on `chaseTarget`, which returns null for an entire TEST match", () => {
      // The obvious predicate — "suppress until there is something to chase" —
      // is a different question wearing the same words. `chaseTarget` is a
      // DISPLAY helper whose own doc records the gap: for a two-innings match
      // it returns non-null only on an explicit DLS/manual revision, because
      // the natural 4th-innings target needs aggregation the engine keeps
      // private. Gating on it would blank the bar through a whole Test,
      // including the fourth innings, where two totals a side is exactly the
      // fact that matters. Pinned so nobody "simplifies" the predicate into it.
      const cricket = readFileSync(join(HERE, "..", "skins", "cricket.tsx"), "utf8");
      const declaration = /ownsHeadline:([^,]*),/.exec(cricket)?.[1] ?? "";
      expect(declaration, "cricket declares no ownsHeadline any more").not.toBe("");
      expect(declaration, "ownsHeadline must not be gated on chaseTarget").not.toContain("chaseTarget");
      expect(declaration).toContain("innings");
    });
  });

  for (const key of KEEPS) {
    it(`${key} keeps the chassis bar — its headline says something its own surface does not`, () => {
      const view = viewOf(key);
      expect(skinOf(key).ownsHeadline?.(view) ?? false).toBe(false);
      expect(shouldRenderHeadline("anything", skinOf(key), view)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. THE CLAIM, CHECKED AGAINST THE PRODUCT
// ---------------------------------------------------------------------------

describe("a skin that declares ownership really does show what its headline says", () => {


  const CASES: { key: string; stream?: readonly (readonly [string, unknown])[]; why: string }[] = [
    { key: "generic", why: "headline is literally the two perSide lines the halves render" },
    {
      key: "boardgame",
      stream: [["core.start", {}], ["boardgame.result", { winner: "H", method: "checkmate" }]],
      why: "decided: the points ARE the halves' own numbers",
    },
    { key: "carrom", why: "gamesWon, which the halves already carry as each side's `sub`" },
    { key: "football", why: "goals, which are the halves' own big numbers" },
    { key: "hockey", why: "score plus the period, both on the bug" },
    { key: "icehockey", why: "score plus the period, both on the bug" },
  ];

  for (const { key, stream, why } of CASES) {
    it(`${key}: every fact in the engine's headline is on the scorebug — ${why}`, () => {
      const view = viewOf(key, stream);
      const headline = summaryHeadline(view.summary);
      // A sport whose fold publishes no headline in this state cannot prove
      // anything here, and a silent skip is how a check becomes decoration.
      expect(headline, `${key} published no headline to check against`).not.toBeNull();
      const text = bugText(skinOf(key).scorebug(view));
      for (const token of dataTokens(headline!)) {
        expect(text, `${key}: headline says "${token}" and the scorebug never does`).toContain(token);
      }
    });
  }

  it("boardgame UNDECIDED: the only thing the bar adds is the connecting word 'vs', which states no fact", () => {
    // Handled separately from the token sweep above, and NOT by teaching that
    // sweep a stopword list — "vs" is not a fact the scorebug is failing to
    // show, it is a connective, and a list of words to ignore is exactly the
    // hand-typed table this file avoids everywhere else. So the claim is made
    // precisely instead: before an outcome the ENTIRE headline is the literal
    // string "vs", both `perSide` lines are empty, and the two halves already
    // name the two sides. Nothing is lost by suppressing it.
    //
    // If a future kernel ever puts a real fact in that pre-decision headline,
    // this assertion reds — which is the point, because at that moment
    // boardgame's declaration would become a lie.
    const view = viewOf("boardgame");
    expect(summaryHeadline(view.summary)).toBe("vs");
    const bug = skinOf("boardgame").scorebug(view);
    const named = bug.halves.flatMap((half) => (half.who ?? []).map((who) => who.name ?? ""));
    expect(named.filter((name) => name.length > 0), "both sides must already be named on the bug").toHaveLength(2);
  });

  it("generic and boardgame are IDENTICAL to their perSide lines, not merely overlapping", () => {
    // The strongest available statement for these two, and stronger than the
    // token sweep above: their kernels build `headline` out of the very same
    // strings they put in `perSide`, and `bigOf` renders `perSide[].line`
    // verbatim. So this is not "the numbers happen to match today" — the two
    // renders cannot diverge without the kernel changing shape.
    for (const key of ["generic", "boardgame"]) {
      const view = viewOf(key, [["core.start", {}]]);
      const summary = view.summary as { headline?: string; perSide?: { line?: string }[] };
      const lines = (summary.perSide ?? []).map((row) => row.line ?? "");
      expect(lines, `${key} publishes no perSide lines`).toHaveLength(2);
      const halves = skinOf(key).scorebug(view).halves.map((half) => half.big ?? "");
      // Undecided boardgame publishes empty lines and the half falls back to
      // an em-dash placeholder; that IS the state where the bar says "vs".
      const expected = lines.map((line) => (line.length > 0 ? line : "—"));
      expect(halves).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. THE PERIOD PAIR IN THE STATES THAT ACTUALLY DIFFER
// ---------------------------------------------------------------------------
//
// Section 3 folds `core.start` and nothing else, which for hockey and ice
// hockey means a headline of `0 — 0 · P1` — every token trivially on the bug.
// That is not a check, and MUTATION PROVED it: deleting the `ot` strip chip
// left section 3 entirely green. (`period-pair.test.ts` caught it, so the chip
// itself was never unguarded — but the file carrying the DECLARATION could not
// see the surface the declaration depends on, which is the seam this whole
// wave is about.)
//
// The ruling's own words are conditional — hockey and ice hockey suppress
// "ONCE their own strip surfaces shootout and OT" — so those two states are
// exactly the ones this declaration has to be tested in.
describe("hockey and ice hockey own the headline in the states where it says something extra", () => {
  const PERIOD = ["hockey", "icehockey"] as const;

  function periodView(key: string, cfg: unknown, state: unknown): PadHostView {
    const sportModule = moduleOf(key);
    const lineups = lineupsFor(sportModule, cfg);
    return {
      cfg,
      state,
      summary: summaryOf(sportModule, state as never),
      phase: "live",
      band: 3,
      entitlements: {},
      personNames: {},
      squads: (((state as { squads?: unknown }).squads as PadHostView["squads"]) ?? initSquads(lineups)),
      events: [],
      contextOverrides: {},
    };
  }

  for (const key of PERIOD) {
    it(`${key}: a DECIDED shoot-out — the headline's own "(GWS n–n)" tally is on the bug`, () => {
      const sportModule = moduleOf(key);
      const { cfg } = shootoutCfgOf(sportModule);
      const { state } = decidedShootout(sportModule, cfg);
      const view = periodView(key, cfg, state);
      const headline = summaryHeadline(view.summary);
      expect(headline, `${key} published no headline for a decided shoot-out`).not.toBeNull();
      // The state is only interesting if the headline really did gain a
      // suffix — otherwise this passes for the same empty reason section 3
      // did.
      expect(headline!, "the fixture never reached a credited shoot-out").toMatch(/\(/);
      const text = bugText(skinOf(key).scorebug(view));
      for (const token of dataTokens(headline!)) {
        expect(text, `${key}: headline says "${token}" and the scorebug never does`).toContain(token);
      }
      // The tally's LABEL, asserted against the chip that carries it. The
      // headline writes ` (${preset.shootoutLabel} 3–0)`; the chip's own copy
      // must be that same label, or the bug shows two numbers with nothing
      // saying they are shoot-out kicks rather than goals.
      const chip = skinOf(key).scorebug(view).strip.find((item) => item.id === "shootout");
      expect(chip, `${key}: no shoot-out chip on a DECIDED shoot-out`).toBeDefined();
      expect(headline!, `${key}: the chip label "${String(chip!.label)}" is not what the headline used`).toContain(
        String(chip!.label),
      );
    });

    it(`${key}: a match DECIDED IN EXTRA TIME — the headline's "(OT)" is on the bug`, () => {
      const sportModule = moduleOf(key);
      const cfg = periodCfg(sportModule);
      const specs: Spec[] = [["core.start"]];
      for (let i = 0; i < 10; i += 1) {
        const s = foldPeriod(sportModule, cfg, specs);
        if (String(s.phase).startsWith("OT")) break;
        const next = nextAdvanceOf(sportModule, s);
        if (next === null) break;
        specs.push([`${key}.period.advance`, { to: next }]);
      }
      const inOt = foldPeriod(sportModule, cfg, specs);
      if (!String(inOt.phase).startsWith("OT")) {
        // Stated rather than skipped: a variant with no overtime ladder cannot
        // produce an `(OT)` headline either, so the declaration is not at risk
        // — but a silent `return` here is how a check becomes decoration.
        expect(summaryHeadline(periodView(key, cfg, inOt).summary) ?? "").not.toContain("OT");
        return;
      }
      const decided = foldPeriod(sportModule, cfg, [...specs, [`${key}.goal`, { by: "H" }]]);
      expect((decided.outcome as { method?: string } | undefined)?.method).toBe("extra_time");
      const view = periodView(key, cfg, decided);
      const headline = summaryHeadline(view.summary);
      expect(headline!, "this fixture exists to produce an (OT) headline").toContain("OT");
      const text = bugText(skinOf(key).scorebug(view));
      for (const token of dataTokens(headline!)) {
        expect(text, `${key}: headline says "${token}" and the scorebug never does`).toContain(token);
      }
      // The `(OT)` fact itself. NOT matched as the literal token "OT": the chip
      // deliberately spells it out where the headline abbreviates, which is
      // better copy on the chip and not a missing fact. What must be true is
      // that a dedicated chip EXISTS in this state and does not in the one
      // before it — otherwise suppressing the bar loses the only statement that
      // the match went beyond regulation.
      const bug = skinOf(key).scorebug(view);
      expect(
        bug.strip.find((item) => item.id === "ot"),
        `${key}: no OT chip on a match decided in extra time — the headline's "(OT)" would be lost`,
      ).toBeDefined();
      expect(
        skinOf(key).scorebug(periodView(key, cfg, inOt)).strip.find((item) => item.id === "ot"),
        `${key}: an OT chip while still PLAYING overtime would claim a decision that has not happened`,
      ).toBeUndefined();
    });
  }
});
