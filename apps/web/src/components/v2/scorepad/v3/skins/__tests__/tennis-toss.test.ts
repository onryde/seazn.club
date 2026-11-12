// S2-7 (TN-TS-1, engine 8.0.0) — the tennis toss on the web: "Who serves first?" asked as part of starting the match.
//
// The controller's rulings this file holds:
//   1. The toss goes BEFORE `core.start` (a toss after the Start with nothing scored counts as play, ruling 112).
//      `runTossThenStart` (lib/__tests__/start-with-toss.test.ts) holds the order; here, the Start control only ever
//      hands it a toss built from the chosen chip, and only when the engine says one is still open.
//   2. The live pad never offers the toss (review R1-M6): the engine's padSpec DOES declare a gated `live` toss panel —
//      proved below, so the filter is load-bearing — and the More sheet does not list it.
//   3. A match with no toss keeps working exactly as before: home serves first.
//
// Every state below is a REAL fold of the public `tennis` module (never a hand-built shape), so the serve the scorebug
// names is the engine's, through the skin's own `serveContext` shim — the seam the toss had to be threaded through
// (`deriveServeContext` passes `opener`; without it the fold says away serves while the ITF walk starts from home,
// `serveOrderKnown` reads drift, and the pad names no server for the whole match).
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";
import type { EventEnvelope, LineupPair, SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import type { ModuleEvent } from "@seazn/engine/sport";
import { tennisPadRules } from "@seazn/engine/pad";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { tennis } from "@seazn/engine/sports/tennis";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { foldClient } from "../../../module-client";
import { buildPadView } from "../../../view-model";
import { ChoiceDock } from "../../detail-dock";
import { dedicatedEventTypes, moreActions, softCommitPlan } from "../../pad-host";
import { StartTossQuestion, useStartWithToss, type StartWithTossInput } from "../../start-match-control";
import type { DockChip, DockSpec, PadHostView } from "../../types";
import {
  buildScorebug,
  buildSheets,
  buildTiles,
  refusedEventTypes,
  startNeedsToss,
  startTossQuestion,
  tennisDetail,
  tossEventFor,
  type TFn,
} from "../tennis";

const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);
const NAMES: Record<string, string> = {
  H: "Home Player",
  A: "Away Player",
  "H-first": "Home First",
  "H-second": "Home Second",
  "A-first": "Away First",
  "A-second": "Away Second",
};
const HOME = { id: "H", name: "Hana Home" };
const AWAY = { id: "A", name: "Ava Away" };

const STRICT_ALL = { strictFromSeq: 0 } as const;
const CFG = tennis.configSchema.parse({});
const SINGLES_LINEUPS: LineupPair = defaultLineupPair(tennis.positions);
const start: ModuleEvent = { type: "core.start", payload: {} };
const toss = (serving: string): ModuleEvent => ({ type: "tennis.toss", payload: { serving } });
const point = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
const game = (by: string): ModuleEvent[] => Array.from({ length: 4 }, () => point(by));

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}
function fold(events: ModuleEvent[] | EventEnvelope[], lineups: LineupPair = SINGLES_LINEUPS): Record<string, unknown> {
  const env = events.length > 0 && "seq" in (events[0] as object) ? (events as EventEnvelope[]) : envelopes(events as ModuleEvent[]);
  return foldClient(tennis, CFG, lineups, env, STRICT_ALL) as unknown as Record<string, unknown>;
}

function singlesSquads(): SquadState {
  return initSquads({
    home: { entrantId: "H", slots: [{ personId: "H", slot: "starting", orderNo: 1 }] },
    away: { entrantId: "A", slots: [{ personId: "A", slot: "starting", orderNo: 1 }] },
  });
}
const DOUBLES_LINEUPS: LineupPair = {
  home: {
    entrantId: "H",
    slots: [
      { personId: "H-second", slot: "starting", orderNo: 1, pairOrder: 2 },
      { personId: "H-first", slot: "starting", orderNo: 2, pairOrder: 1 },
    ],
  },
  away: {
    entrantId: "A",
    slots: [
      { personId: "A-second", slot: "starting", orderNo: 1, pairOrder: 2 },
      { personId: "A-first", slot: "starting", orderNo: 2, pairOrder: 1 },
    ],
  },
};

function view(state: unknown, over: Partial<PadHostView> = {}): PadHostView {
  const phase = (state as { phase?: string }).phase === "pre" ? "pre" : "live";
  return {
    cfg: CFG,
    state,
    summary: {},
    phase,
    band: 3,
    entitlements: {},
    personNames: NAMES,
    squads: singlesSquads(),
    events: [],
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
    ...over,
  };
}
const strip = (v: PadHostView, id: string) => buildScorebug(v, t).strip.find((item) => item.id === id)?.value;
const servingNames = (v: PadHostView) =>
  buildScorebug(v, t)
    .halves.flatMap((half) => half.who)
    .filter((who) => who.serving === true)
    .map((who) => who.name);

// ---------------------------------------------------------------------------
// Ruling 1 + 3 — what the toss does to the serve, read through the skin.
// ---------------------------------------------------------------------------

describe("a toss before the Start: the pad names the server the toss chose", () => {
  it("singles: away won the toss → away serves game 1, home game 2 (and the tap carries the right server)", () => {
    const v = view(fold([toss("A"), start]));
    expect(strip(v, "server")).toBe(NAMES.A);
    expect(servingNames(v)).toEqual([NAMES.A]);
    // The tap stamps the server person — ace/double-fault attribution depends on it.
    expect(buildScorebug(v, t).halves[0]!.tapEvent?.payload.server).toBe("A");

    const afterGame = view(fold([toss("A"), start, ...game("A")]));
    expect(strip(afterGame, "server")).toBe(NAMES.H);
  });

  it("doubles with a declared pair order: away's first-named partner serves first", () => {
    const v = view(fold([toss("A"), start], DOUBLES_LINEUPS), { squads: initSquads(DOUBLES_LINEUPS) });
    expect(strip(v, "server")).toBe(NAMES["A-first"]);
    // Next game is home's first-named; the one after, away's second-named (ITF 14: partners alternate turns).
    const g2 = view(fold([toss("A"), start, ...game("A")], DOUBLES_LINEUPS), { squads: initSquads(DOUBLES_LINEUPS) });
    expect(strip(g2, "server")).toBe(NAMES["H-first"]);
    const g3 = view(fold([toss("A"), start, ...game("A"), ...game("A")], DOUBLES_LINEUPS), { squads: initSquads(DOUBLES_LINEUPS) });
    expect(strip(g3, "server")).toBe(NAMES["A-second"]);
  });

  it("a toss naming HOME reads the same as no toss — the answer differs from the away case, so the test can witness it", () => {
    expect(strip(view(fold([toss("H"), start])), "server")).toBe(NAMES.H);
  });
});

describe("no toss: home serves first, exactly as before (ruling 3)", () => {
  it("a match started without a toss names the home player, and alternates from there", () => {
    const v = view(fold([start]));
    expect(strip(v, "server")).toBe(NAMES.H);
    expect(strip(view(fold([start, ...game("H")])), "server")).toBe(NAMES.A);
  });

  it("a voided toss is no toss: home serves", () => {
    const events = [
      makeEnvelope(0, toss("A")),
      makeEnvelope(1, { type: "core.void", payload: { event_id: "e-0" } }, "e-0"),
      makeEnvelope(2, start),
    ];
    expect(strip(view(fold(events)), "server")).toBe(NAMES.H);
  });
});

// ---------------------------------------------------------------------------
// When Start asks — the engine's own `tossOpen`, not a ledger sniff.
// ---------------------------------------------------------------------------

describe("startNeedsToss", () => {
  it("tennis with nothing recorded asks — both an empty /state (null) and a pre-start fold", () => {
    expect(startNeedsToss("tennis", null)).toBe(true);
    expect(startNeedsToss("tennis", undefined)).toBe(true);
    expect(startNeedsToss("tennis", fold([]))).toBe(true);
  });

  it("a held toss is not asked again (another screen recorded it, or our toss landed and our Start did not)", () => {
    expect(startNeedsToss("tennis", fold([toss("A")]))).toBe(false);
    expect(startNeedsToss("tennis", fold([toss("H")]))).toBe(false);
  });

  it("a voided toss is asked again", () => {
    const events = [makeEnvelope(0, toss("A")), makeEnvelope(1, { type: "core.void", payload: { event_id: "e-0" } }, "e-0")];
    expect(startNeedsToss("tennis", fold(events))).toBe(true);
  });

  it("a decided match is never asked", () => {
    const decided = fold([start, { type: "tennis.set_summary", payload: { home: 6, away: 0 } }, { type: "tennis.set_summary", payload: { home: 6, away: 0 } }]);
    expect(tennisPadRules.tossOpen(decided), "premise: the engine closes the toss on a decided match").toBe(false);
    expect(startNeedsToss("tennis", decided)).toBe(false);
  });

  it("every other sport never asks — Start stays the plain button", () => {
    const others = ["badminton", "tabletennis", "volleyball", "football", "cricket", "carrom", "boardgame", "generic"];
    for (const sport of others) expect(startNeedsToss(sport, null), sport).toBe(false);
    expect(others.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The question and the event it sends.
// ---------------------------------------------------------------------------

describe("startTossQuestion / tossEventFor", () => {
  const spec = startTossQuestion(HOME, AWAY, t);

  it("is a required ChoiceDock: 'Who serves first?', home then away, each named as typed", () => {
    expect(spec.title).toBe("pad.tennis.start.toss.title");
    expect((uiEn as Record<string, string>)["pad.tennis.start.toss.title"]).toBe("Who serves first?");
    expect(spec.requires).toBe("serving");
    expect(spec.chips.map((chip) => chip.id)).toEqual(["home", "away"]);
    expect(spec.chips.map((chip) => chip.labelText)).toEqual([HOME.name, AWAY.name]);
    for (const chip of spec.chips) expect((uiEn as Record<string, string>)[chip.label], chip.label).toBeTruthy();
    // The chassis' own check: a required dock whose chips cannot answer it is refused by name.
    expect(softCommitPlan(spec, {})).toBe("choose");
  });

  it("each chip sends tennis.toss naming ITS entrant, and the real fold seats that side", () => {
    const [home, away] = spec.chips as [DockChip, DockChip];
    expect(tossEventFor(home)).toEqual({ type: "tennis.toss", payload: { serving: "H" } });
    expect(tossEventFor(away)).toEqual({ type: "tennis.toss", payload: { serving: "A" } });
    // The seam, end to end: the builder's own output through the real engine.
    const awayEvent = tossEventFor(away);
    const folded = fold([{ type: awayEvent.type, payload: awayEvent.payload }, start]);
    expect(folded.opener).toBe("away");
    expect(folded.serving).toBe("away");
  });

  it("a double tap on the real ChoiceDock answers once", () => {
    const onChoose = vi.fn();
    const island = renderIsland(ChoiceDock, { spec, t, onChoose, onCancel: vi.fn() });
    const press = (id: string) => {
      const button = island.tree().find((el) => el.type === "button" && propsOf(el)["data-testid"] === `pad-dock-chip-${id}`)!;
      const onClick = propsOf(button).onClick as (() => void) | undefined;
      if (onClick !== undefined) onClick();
    };
    press("away");
    press("away");
    press("home");
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect((onChoose.mock.calls[0]![0] as DockChip).id).toBe("away");
  });
});

// ---------------------------------------------------------------------------
// Ruling 2 — the live pad never offers the toss.
// ---------------------------------------------------------------------------

describe("the live pad does not offer the toss (review R1-M6)", () => {
  const padSpec = tennis.padSpec?.(CFG);
  if (padSpec === undefined) throw new Error("premise: tennis declares a padSpec");

  function moreFor(state: Record<string, unknown>, refused: ReadonlySet<string>) {
    const v = view(state);
    const dedicated = dedicatedEventTypes(buildTiles(v), buildSheets(v, t), [], buildScorebug(v, t));
    const ctx = { state, summary: {}, phase: v.phase, band: 3 as const };
    return moreActions(padSpec!, ctx, dedicated, refused).map((action) => action.type);
  }

  it("premise: the engine's padSpec offers 'Who serves first' in a live, untossed match — so the filter is load-bearing", () => {
    const live = fold([start, ...game("H")]);
    const ctx = { state: live, summary: {}, phase: "live" as const, band: 3 as const };
    const offered = buildPadView(padSpec, ctx).panels.flatMap((panel) => panel.actions.map((action) => action.type));
    expect(offered).toContain("tennis.toss");
    expect(moreFor(live, new Set()), "with no refusal the More sheet WOULD list it").toContain("tennis.toss");
  });

  it("the More sheet of a live, untossed match does not list it — mid-game, at 0-0, and after a set", () => {
    const states = [fold([start]), fold([start, ...game("H"), point("A")]), fold([start, { type: "tennis.set_summary", payload: { home: 6, away: 4 } }])];
    for (const state of states) {
      const v = view(state);
      expect(refusedEventTypes(v)).toContain("tennis.toss");
      const more = moreFor(state, new Set(refusedEventTypes(v)));
      expect(more).not.toContain("tennis.toss");
      // Positive pair, per state: with the refusal taken away the same More sheet DOES list it.
      expect(moreFor(state, new Set())).toContain("tennis.toss");
    }
  });

  it("no tile offers it either, before or during play", () => {
    for (const state of [fold([]), fold([start])]) {
      const tiles = buildTiles(view(state));
      expect(tiles.some((tile) => "event" in tile.action && tile.action.event.type === "tennis.toss")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The activity row.
// ---------------------------------------------------------------------------

describe("tennisDetail — tennis.toss", () => {
  it("names the side the toss chose, through the fold's entrants", () => {
    const state = fold([toss("A")]);
    expect(tennisDetail({ t, eventType: "tennis.toss", payload: { serving: "A" }, state })).toBe("scorepad.attribution.away");
    expect(tennisDetail({ t, eventType: "tennis.toss", payload: { serving: "H" }, state })).toBe("scorepad.attribution.home");
  });
  it("an id it cannot resolve adds nothing — never the raw id", () => {
    expect(tennisDetail({ t, eventType: "tennis.toss", payload: { serving: "zz" }, state: fold([]) })).toBeUndefined();
    expect(tennisDetail({ t, eventType: "tennis.toss", payload: { serving: "A" } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The Start behaviour the console and the remote pad both mount (`useStartWithToss` + `StartTossQuestion`), driven
// through a stand-in page that renders exactly what the two pages render: the question while asking, else the button.
// ---------------------------------------------------------------------------

describe("useStartWithToss / StartTossQuestion", () => {
  type Toss = { type: string; payload: Record<string, unknown> };
  const msg = (key: string) => key;

  function Page(props: StartWithTossInput) {
    const start = useStartWithToss(props);
    return start.asking
      ? createElement(StartTossQuestion, { home: HOME, away: AWAY, msg, start })
      : createElement("button", { type: "button", "data-testid": "score-start-match", onClick: start.press }, "Start match");
  }

  function page(over: Partial<StartWithTossInput> = {}) {
    const onStart = vi.fn();
    let settle: () => void = () => {};
    const sent: Toss[] = [];
    const onTossThenStart = vi.fn((tossEvent: Toss) => {
      sent.push(tossEvent);
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    });
    const island = renderIsland(Page, { sportKey: "tennis", state: null, onStart, onTossThenStart, ...over });
    const startButton = () => island.tree().find((el) => el.type === "button" && propsOf(el)["data-testid"] === "score-start-match");
    const question = () => island.tree().find((el) => el.type === StartTossQuestion);
    /** The question's own markup (it holds no hooks, so it renders as a plain call): the ChoiceDock it mounts. */
    const dockOf = (el: ReturnType<typeof question>) => {
      const rendered = StartTossQuestion(el!.props as Parameters<typeof StartTossQuestion>[0]);
      expect(propsOf(rendered)["data-testid"]).toBe("score-start-toss");
      return (rendered.props as { children: ReturnType<typeof createElement> }).children;
    };
    return { onStart, onTossThenStart, sent, startButton, question, dockOf, settle: () => settle() };
  }

  it("tennis: Start asks first, sends nothing, and the answer sends ONE toss for the chosen side", async () => {
    const c = page();
    (propsOf(c.startButton()!).onClick as () => void)();
    expect(c.onStart).not.toHaveBeenCalled();
    expect(c.question(), "Start opened the question").toBeDefined();
    const dock = c.dockOf(c.question());
    expect(dock.type).toBe(ChoiceDock);
    const spec = propsOf(dock).spec as DockSpec;
    expect(spec.title).toBe("pad.tennis.start.toss.title");
    expect(spec.chips.map((chip) => chip.labelText)).toEqual([HOME.name, AWAY.name]);
    (propsOf(dock).onChoose as (chip: DockChip) => void)(spec.chips[1]!);
    expect(c.sent).toEqual([{ type: "tennis.toss", payload: { serving: "A" } }]);
    // Mid-sequence the question stays up (its answer marked by the dock), so Start cannot come back and fire twice.
    expect(c.startButton()).toBeUndefined();
    expect(c.question()).toBeDefined();
    c.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.startButton(), "once both writes settle the button is back").toBeDefined();
    expect(c.onTossThenStart).toHaveBeenCalledTimes(1);
    expect(c.onStart).not.toHaveBeenCalled();
  });

  it("Cancel puts the button back and sends nothing", () => {
    const c = page();
    (propsOf(c.startButton()!).onClick as () => void)();
    (propsOf(c.dockOf(c.question())).onCancel as () => void)();
    expect(c.startButton()).toBeDefined();
    expect(c.onStart).not.toHaveBeenCalled();
    expect(c.onTossThenStart).not.toHaveBeenCalled();
  });

  it("a held toss: Start only starts", () => {
    const c = page({ state: fold([toss("A")]) });
    (propsOf(c.startButton()!).onClick as () => void)();
    expect(c.onStart).toHaveBeenCalledTimes(1);
    expect(c.question()).toBeUndefined();
  });

  it("another sport: the plain Start, as before", () => {
    const c = page({ sportKey: "badminton" });
    expect(textOf(c.startButton()!)).toBe("Start match");
    (propsOf(c.startButton()!).onClick as () => void)();
    expect(c.onStart).toHaveBeenCalledTimes(1);
    expect(c.question()).toBeUndefined();
    expect(c.onTossThenStart).not.toHaveBeenCalled();
  });
});
