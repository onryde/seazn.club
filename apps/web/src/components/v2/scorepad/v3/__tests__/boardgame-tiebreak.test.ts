import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
// single-sport: the chess tie-break's own rungs and module — no other sport declares a decider
import { ARMAGEDDON_RESULTS, TIEBREAK_RUNGS, boardgame, type TiebreakRung } from "@seazn/engine/sports/boardgame";
import { declaredCfgs, defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { ORGANISER_ONLY_SPORT_EVENTS, isOrganiserOnlyEvent } from "@/lib/organiser-only-events";
import { entrantDisplayName } from "@/lib/entrant-name";
import type { SideInfo } from "@/components/v2/fixture-console";
import { entrantNamesFrom } from "../../registry";
import uiEn from "@/dictionaries/en/ui.json";
import { dockFor, resolveDockSpec } from "../pad-host";
import { V3_SKINS } from "../registry";
import {
  boardgameSkinV3,
  buildScorebug,
  buildSheets,
  buildTiles,
  DRAW_TILE_ID,
  RESULT_TYPE,
  resolvePhase,
  settlementOf,
  TIEBREAK_TILE_ID,
  TIEBREAK_TYPE,
} from "../skins/boardgame";
import { answerStep, backStep, currentStep, initialSheetState, type GuidedSheetState } from "../guided-sheet";
import type { GuidedSheetSpec, GuidedSheetStep, PadHostView } from "../types";
import { liveView } from "./_views";

// W2a Task 12 — the chess three-step tie-break on the pad (spec §5.5; BG-KO-1; BG-KO-2 per ruling 82; UI-2 option B;
// D6), gated on the kernel's `deciderPending` (loop-H addendum 1, ruling D-C5), and the chess dock's organiser-only
// methods (addendum 2, ruling D-O1). Every view is a REAL fold of a real ledger (class 1): the drawn game goes to
// phase "tiebreak" because the engine says so, never because a test patched the state.

const echo = (k: string) => k;
const TB_CFG = { tiebreak: true };
const START = { type: "core.start", payload: {} };
const DRAWN = { type: RESULT_TYPE, payload: { winner: null, method: "agreement" } };
const SETTLE = { type: "core.settle", payload: { winner: "H", method: "lot" } };
// single-sport: a chess knockout game drawn into its tie-break — the only sport with one
const tiebreakView = (o: { canOrganise?: boolean } = {}) =>
  liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG, events: [START, DRAWN], ...o });
const shownFor = (step: GuidedSheetStep, answers: Record<string, string>) => step.when?.(answers) ?? true;
/** The ids of the steps a scorer who has answered `answers` sees, in declaration order (the chassis' own `when` rule). */
const visibleIds = (sheet: GuidedSheetSpec, answers: Record<string, string>) => sheet.steps.filter((s) => shownFor(s, answers)).map((s) => s.id);
/** A chess knockout drawn into its tie-break under a stage that plays exactly `rungs` (absent = every rung). */
// single-sport: the tie-break rungs and the Armageddon are chess's alone — boardgame is the only module declaring a decider (pinned by the registry sweep above)
const stageView = (rungs?: readonly TiebreakRung[], names?: PadHostView["entrantNames"]) =>
  liveView("boardgame", {
    stageKind: "knockout",
    cfg: { tiebreak: true, ...(rungs === undefined ? {} : { tiebreakRungs: rungs }) },
    events: [START, DRAWN],
    ...(names === undefined ? {} : { entrantNames: names }),
  });
const sheetOf = (view: PadHostView) => buildSheets(view, echo)[TIEBREAK_TILE_ID]!;
/** The two steps that name the entrants, with the option ids each one answers (the Black step prefixes its own). */
const NAMED_STEPS = [["winner", ["home", "away"]], ["black", ["black-home", "black-away"]]] as const;
/** `defaultLineupPair` seats entrants "H" (home) and "A" (away). */
const ENTRANT = { home: "H", away: "A" } as const;
const otherSide = (side: "home" | "away") => (side === "home" ? "away" : "home");
/** BG-KO-2, from the rulebook (packages/engine/rules/boardgame.md): White won → the OTHER entrant advances; Black won or
 *  the Armageddon was drawn → Black advances. Written out here, never read from the engine's helper. */
const advancerOf = (black: "home" | "away", result: (typeof ARMAGEDDON_RESULTS)[number]) => (result === "white" ? otherSide(black) : black);
/** A drawn game followed by `payload`, folded through the REAL engine: the outcome the fixture would carry. */
const foldTiebreak = (payload: Record<string, unknown>) => {
  const env = (seq: number, type: string, body: unknown): EventEnvelope =>
    ({ id: `e${seq}`, fixtureId: "fx", seq, type, payload: body, recordedAt: "2026-10-08T00:00:00Z", recordedBy: null }) as EventEnvelope;
  return boardgame.outcome(
    foldMatch(boardgame, boardgame.configSchema.parse(TB_CFG), defaultLineupPair(boardgame.positions), [env(1, "core.start", {}), env(2, RESULT_TYPE, DRAWN.payload), env(3, TIEBREAK_TYPE, payload)]),
  );
};
/** The English dictionary with `{var}` interpolation — the sentence a scorer would read. */
const tEn = (key: string, vars?: Record<string, string | number>): string => {
  const raw = (uiEn as Record<string, string>)[key];
  if (raw === undefined) throw new Error(`no English entry for ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name]));
};

describe("the chess three-step tie-break on the pad (spec §5.5, BG-KO-1, BG-KO-2 per ruling 82, D6)", () => {
  it("the single-sport reasons in this file hold: of every registry sport, only boardgame declares a decider (awaitingDecider, deciderTypes), and since W2b (D15) none declares an organiser-only result method", () => {
    const deciders: string[] = [];
    const organiserMethods: string[] = [];
    let swept = 0;
    for (const m of builtinModules) {
      const mod = m as { key: string; awaitingDecider?: unknown; deciderTypes?: readonly string[] };
      if (typeof mod.awaitingDecider === "function" || (mod.deciderTypes?.length ?? 0) > 0) deciders.push(mod.key);
      if (Object.keys(ORGANISER_ONLY_SPORT_EVENTS).some((type) => type.startsWith(`${mod.key}.`))) organiserMethods.push(mod.key);
      swept++;
    }
    expect(swept).toBe(builtinModules.length);
    expect(swept, "the registry has more than the one sport").toBeGreaterThan(1);
    expect(deciders).toEqual(["boardgame"]);
    // W2b D15 / W2b-R15: chess's forfeit methods are retired on write for every writer, so the payload-scoped table is
    // empty and a chess forfeit is a core.forfeit like every other sport's.
    expect(Object.keys(ORGANISER_ONLY_SPORT_EVENTS)).toEqual([]);
    expect(organiserMethods).toEqual([]);
  });

  it("TIEBREAK_TYPE is the engine's own decider type, not a second spelling", () => {
    expect(boardgame.deciderTypes).toEqual([TIEBREAK_TYPE]);
  });

  it("empty case first: in phase live there is no tie-break tile (Draw is there instead)", () => {
    // single-sport: the tie-break is chess's alone — boardgame is the only module declaring awaitingDecider/deciderTypes (pinned by the registry sweep in this describe)
    const v = liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG });
    const ids = buildTiles(v, echo).map((t) => t.id);
    expect(ids).not.toContain(TIEBREAK_TILE_ID);
    expect(ids).toContain(DRAW_TILE_ID);
  });

  it("in phase tiebreak: only the tie-break tile; Draw is gone and the halves are not tappable", () => {
    // single-sport: the tie-break is chess's alone — boardgame is the only module declaring awaitingDecider/deciderTypes (pinned by the registry sweep in this describe)
    const v = tiebreakView();
    expect((v.state as { phase?: string }).phase, "the real fold put the drawn game in tiebreak").toBe("tiebreak");
    expect(buildTiles(v, echo).map((t) => t.id)).toEqual([TIEBREAK_TILE_ID]);
    const halves = buildScorebug(v, echo).halves;
    expect(halves).toHaveLength(2);
    expect(halves.filter((h) => h.tappable)).toEqual([]);
    expect(resolvePhase(v)).toBe("live");
    // The positive pair: the same halves ARE tappable while the game is live.
    expect(buildScorebug(liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG }), echo).halves.every((h) => h.tappable)).toBe(true);
  });

  it("addendum 1 / D-C5: after an organiser's settle in phase tiebreak nothing is offered and the pad reads post", () => {
    // single-sport: the tie-break is chess's alone — boardgame is the only module declaring awaitingDecider/deciderTypes (pinned by the registry sweep in this describe)
    const settled = liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG, events: [START, DRAWN, SETTLE] });
    expect((settled.state as { phase?: string }).phase, "the settle leaves the module phase untouched").toBe("tiebreak");
    expect(buildTiles(settled, echo)).toEqual([]);
    expect(buildScorebug(settled, echo).halves.some((h) => h.tappable)).toBe(false);
    expect(resolvePhase(settled)).toBe("post");
    // The sequence: voiding the settle makes the decider owed again, and the tile comes back.
    const voided = liveView("boardgame", {
      stageKind: "knockout",
      cfg: TB_CFG,
      events: [START, DRAWN, SETTLE, { type: "core.void", payload: {}, voids: "e-3" }],
    });
    expect(buildTiles(voided, echo).map((t) => t.id)).toEqual([TIEBREAK_TILE_ID]);
    expect(resolvePhase(voided)).toBe("live");
  });

  it("a ledger whose settle names neither side is refused loudly — the pad never guesses who advanced", () => {
    const v = tiebreakView();
    const bogus = { ...v, events: [...v.events, makeEnvelope(3, { type: "core.settle", payload: { winner: "X", method: "lot" } } as never)] };
    expect(() => settlementOf(bogus)).toThrow(/names neither side/);
    // The positive pair: the same ledger with a real winner reads as that settle.
    const real = { ...v, events: [...v.events, makeEnvelope(3, { type: "core.settle", payload: { winner: "A", method: "lot" } } as never)] };
    expect(settlementOf(real)).toEqual({ winner: "A", loser: "H", method: "lot", eventId: "e-3" });
  });

  it("after the tie-break is recorded the match is decided: no tile, no tappable half, phase post", () => {
    // single-sport: the tie-break is chess's alone — boardgame is the only module declaring awaitingDecider/deciderTypes (pinned by the registry sweep in this describe)
    const done = liveView("boardgame", {
      stageKind: "knockout",
      cfg: TB_CFG,
      events: [START, DRAWN, { type: TIEBREAK_TYPE, payload: { rung: "blitz", winner: "A" } }],
    });
    expect(buildTiles(done, echo)).toEqual([]);
    expect(buildScorebug(done, echo).halves.some((h) => h.tappable)).toBe(false);
    expect(resolvePhase(done)).toBe("post");
  });

  it("the skin's phase hook is the one the host calls, and it reads the ledger (a settle) as well as the state", () => {
    // single-sport: the tie-break is chess's alone — boardgame is the only module declaring awaitingDecider/deciderTypes (pinned by the registry sweep in this describe)
    const skin = boardgameSkinV3(echo);
    expect(skin.phase?.(tiebreakView())).toBe("live");
    expect(skin.phase?.(liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG, events: [START, DRAWN, SETTLE] }))).toBe("post");
  });

  it("step 1 offers exactly the engine's rungs, labelled by the shared rung vocabulary, and says lots is the organiser's", () => {
    const sheet = buildSheets(tiebreakView(), echo)[TIEBREAK_TILE_ID]!;
    expect(sheet.event).toBe(TIEBREAK_TYPE);
    const rung = sheet.steps.find((s) => s.id === "rung")!;
    expect(rung.kind === "choice" && rung.options.map((o) => o.id)).toEqual([...TIEBREAK_RUNGS]);
    expect(rung.kind === "choice" && rung.options.map((o) => o.label)).toEqual(TIEBREAK_RUNGS.map((r) => `pad.boardgame.tiebreak.rung.${r}`));
    expect(rung.kind === "choice" && rung.hintKey).toBe("pad.boardgame.tiebreak.lotsHint");
  });

  it("the tie-break sheet never offers settle or lots (X-ST-2: settle is the organiser's, on the console; preflight C21)", () => {
    const v = tiebreakView();
    const ids = [
      ...buildTiles(v, echo).map((t) => t.id),
      ...Object.values(buildSheets(v, echo)).flatMap((sh) => sh.steps.flatMap((st) => (st.kind === "choice" ? st.options.map((o) => o.id) : []))),
    ];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => /settle|\blots?\b/i.test(id))).toEqual([]);
  });

  it("BG-KO-3 the rung step offers exactly the rungs the STAGE plays, in the STAGE's order, never the engine's canonical list", () => {
    // ["armageddon", "rapid"] is NOT TIEBREAK_RUNGS order, so a sheet that re-sorts to the canonical list fails here.
    expect(TIEBREAK_RUNGS.indexOf("rapid")).toBeLessThan(TIEBREAK_RUNGS.indexOf("armageddon"));
    const lists: (readonly TiebreakRung[])[] = [["armageddon", "rapid"], ["blitz"], ["armageddon"], ["blitz", "armageddon", "rapid"], [...TIEBREAK_RUNGS]];
    let checked = 0;
    for (const list of lists) {
      const rung = sheetOf(stageView(list)).steps.find((s) => s.id === "rung")!;
      expect(rung.kind === "choice" && rung.options.map((o) => o.id), JSON.stringify(list)).toEqual([...list]);
      checked++;
    }
    expect(checked).toBe(lists.length);
    // The engine's own padSpec is the second witness of WHICH rungs are playable: the pad offers the same set (the order
    // is the stage's; padSpec splits the timed rungs from the Armageddon, so only the set is comparable).
    const offeredBy = (rungs: readonly TiebreakRung[]) => {
      const spec = boardgame.padSpec!(boardgame.configSchema.parse({ tiebreak: true, tiebreakRungs: rungs }));
      const panel = spec.panels.find((p) => p.labelKey.key === "pad.boardgame.panel.tiebreak");
      return (panel?.actions ?? []).flatMap((a) => a.fields ?? []).flatMap((f) => (f.kind === "enum" && f.path === "rung" ? [...f.values] : [])).sort();
    };
    let compared = 0;
    for (const list of lists) {
      const rung = sheetOf(stageView(list)).steps.find((s) => s.id === "rung")!;
      expect(rung.kind === "choice" && rung.options.map((o) => o.id).sort(), JSON.stringify(list)).toEqual(offeredBy(list));
      compared++;
    }
    expect(compared).toBe(lists.length);
    // The positive pair: a stage that lists nothing plays every rung, in the engine's order (today's behaviour).
    const all = sheetOf(stageView()).steps.find((s) => s.id === "rung")!;
    expect(all.kind === "choice" && all.options.map((o) => o.id)).toEqual([...TIEBREAK_RUNGS]);
  });

  it("BG-KO-3 an empty rung list offers no tie-break tile (the drawn game is the organiser's to settle); a one-rung list offers it", () => {
    // Empty case first: with no rung to play the engine never leaves phase done, so there is nothing to record.
    const none = stageView([]);
    expect((none.state as { phase?: string }).phase, "a drawn game with no rung to play stays a draw").toBe("done");
    expect(buildTiles(none, echo).map((t) => t.id)).not.toContain(TIEBREAK_TILE_ID);
    expect(resolvePhase(none)).toBe("post");
    // …and the pair: one listed rung is enough for the tile.
    expect(buildTiles(stageView(["blitz"]), echo).map((t) => t.id)).toEqual([TIEBREAK_TILE_ID]);
  });

  it("BG-KO-2 the Armageddon branch asks Black then the result, then reads the outcome back; rapid and blitz keep winner then score", () => {
    const sheet = sheetOf(stageView(["armageddon", "rapid"]));
    expect(visibleIds(sheet, { rung: "armageddon" })).toEqual(["rung", "black", "result", "confirm"]);
    // Rapid and blitz are unchanged by this task (the positive pair of the Armageddon branch).
    for (const rung of ["rapid", "blitz"]) expect(visibleIds(sheet, { rung }), rung).toEqual(["rung", "winner", "score"]);
    const black = sheet.steps.find((s) => s.id === "black")!;
    expect(black.kind === "choice" && black.options.map((o) => o.id)).toEqual(["black-home", "black-away"]);
    expect(black.kind === "choice" && black.options.map((o) => o.label)).toEqual(["scorepad.attribution.home", "scorepad.attribution.away"]);
    expect(black.title).toBe("pad.boardgame.tiebreak.black.title");
    // The result step offers exactly the engine's three results, in its order; the draw's label carries its consequence.
    const result = sheet.steps.find((s) => s.id === "result")!;
    expect(result.title).toBe("pad.boardgame.tiebreak.result.title");
    expect(result.kind === "choice" && result.options.map((o) => o.id)).toEqual(ARMAGEDDON_RESULTS.map((r) => `result-${r}`));
    expect(result.kind === "choice" && result.options.map((o) => o.label)).toEqual(ARMAGEDDON_RESULTS.map((r) => `pad.boardgame.armageddon.result.${r}`));
    expect(tEn("pad.boardgame.armageddon.result.draw")).toBe("Drawn — Black advances");
    // The payload is Task 8's, with Black as an ENTRANT id and the result as the engine's token.
    expect(sheet.buildPayload({ rung: "armageddon", black: "black-away", result: "result-draw" })).toEqual({ rung: "armageddon", black: "A", result: "draw" });
    expect(sheet.buildPayload({ rung: "armageddon", black: "black-home", result: "result-white" })).toEqual({ rung: "armageddon", black: "H", result: "white" });
  });

  it("BG-KO-2 the 'draw means Black advances' hint stays, on the Armageddon result step only", () => {
    const sheet = sheetOf(stageView());
    let checked = 0;
    for (const step of sheet.steps) {
      if (step.kind !== "choice") continue;
      expect(step.hintKey === "pad.boardgame.tiebreak.armageddonHint", step.id).toBe(step.id === "result");
      checked++;
    }
    expect(checked, "every choice step was inspected").toBe(sheet.steps.filter((s) => s.kind === "choice").length);
    expect(checked).toBeGreaterThanOrEqual(5);
    // What a scorer SEES, per rung: the hint is on a shown step for the Armageddon and on none for rapid or blitz. (The check
    // above says which step carries it; this one says the step is not shown on a rung that never plays it.)
    let rungs = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const hinted = sheet.steps.filter((s) => shownFor(s, { rung }) && s.kind === "choice" && s.hintKey === "pad.boardgame.tiebreak.armageddonHint");
      expect(hinted.map((s) => s.id), `rung ${rung}`).toEqual(rung === "armageddon" ? ["result"] : []);
      rungs++;
    }
    expect(rungs, "every rung the engine declares was inspected").toBe(TIEBREAK_RUNGS.length);
  });

  it("BG-KO-2 the confirm line names who advances and why, for every Black × result — the scorer never applies the rule", () => {
    const names = { home: "Asha Rao", away: "Priya Menon" };
    const confirm = buildSheets(stageView(undefined, names), tEn)[TIEBREAK_TILE_ID]!.steps.find((s) => s.id === "confirm")!;
    if (confirm.kind !== "confirm") throw new Error(`the Armageddon sheet ends on a confirm step, not ${confirm.kind}`);
    let checked = 0;
    const advancers = new Set<string>();
    for (const black of ["home", "away"] as const)
      for (const result of ARMAGEDDON_RESULTS) {
        // The sentence is the dictionary's own, in the scorer's language; WHO advances comes from the rule (BG-KO-2).
        const name = names[advancerOf(black, result)];
        const want = result === "draw" ? `Advances: ${name} — Black, Armageddon drawn` : `Advances: ${name} — ${result === "white" ? "White" : "Black"} won`;
        expect(confirm.summary({ rung: "armageddon", black: `black-${black}`, result: `result-${result}` }), `${black}/${result}`).toBe(want);
        advancers.add(`${black}/${name}`);
        checked++;
      }
    expect(checked).toBe(2 * ARMAGEDDON_RESULTS.length);
    // Teeth: White winning and Black winning name DIFFERENT entrants for the same Black, so a sentence that always
    // named Black (or always the other player) fails somewhere in the loop above.
    expect(advancers.size, "both entrants are named as the advancer somewhere").toBe(4);
  });

  it("BG-KO-2 with no name known the confirm line falls back to Home/Away, and a seated player's name wins over the entrant's", () => {
    const view = (personNames: Record<string, string>, entrantNames: PadHostView["entrantNames"]) =>
      liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG, events: [START, DRAWN], personNames, entrantNames }); // single-sport: the Armageddon read-back is chess's alone (see the registry sweep above)
    const line = (v: PadHostView) => {
      const c = buildSheets(v, tEn)[TIEBREAK_TILE_ID]!.steps.find((s) => s.id === "confirm")!;
      if (c.kind !== "confirm") throw new Error("unreachable");
      return c.summary({ rung: "armageddon", black: "black-away", result: "result-draw" });
    };
    expect(line(view({}, {}))).toBe(`Advances: ${tEn("scorepad.attribution.away")} — Black, Armageddon drawn`);
    expect(line(view({}, { home: "Riverside", away: "Summit Knights" }))).toBe("Advances: Summit Knights — Black, Armageddon drawn");
    expect(line(view({ "A-p1": "Hou Yifan" }, { home: "Riverside", away: "Summit Knights" }))).toBe("Advances: Hou Yifan — Black, Armageddon drawn");
  });

  it("BG-KO-2 walking the real sheet: Back from the result step keeps Black, a different result rewrites the line, and only Confirm writes", () => {
    const sheet = buildSheets(stageView(["armageddon", "rapid"], { home: "Asha Rao", away: "Priya Menon" }), tEn)[TIEBREAK_TILE_ID]!;
    const idAt = (st: GuidedSheetState) => currentStep(sheet, st)?.id;
    const advance = (st: GuidedSheetState, value: string): GuidedSheetState => {
      const out = answerStep(sheet, st, value);
      if (out.done) throw new Error(`the sheet completed early on "${value}"`);
      return out.state;
    };
    const lineAt = (st: GuidedSheetState) => {
      const c = currentStep(sheet, st);
      if (c === null || c.kind !== "confirm") throw new Error("not on the confirm step");
      return c.summary(st.answers);
    };
    let s = advance(initialSheetState(), "armageddon");
    expect(idAt(s)).toBe("black");
    s = advance(s, "black-away");
    expect(idAt(s)).toBe("result");
    s = advance(s, "result-draw");
    expect(idAt(s), "the result opens the read-back, it does not write").toBe("confirm");
    expect(lineAt(s)).toBe("Advances: Priya Menon — Black, Armageddon drawn");
    s = backStep(sheet, s);
    expect(idAt(s), "Back from the confirm step lands on the result").toBe("result");
    s = backStep(sheet, s);
    expect(idAt(s), "…and Back again lands on Black").toBe("black");
    expect(s.answers.black, "Back keeps what was answered").toBe("black-away");
    s = advance(s, "black-home"); // changed Black to Asha
    s = advance(s, "result-white"); // …and White won
    expect(lineAt(s), "Asha had Black and White won: the other entrant advances").toBe("Advances: Priya Menon — White won");
    expect(answerStep(sheet, s, "ok")).toEqual({ done: true, event: { type: TIEBREAK_TYPE, payload: { rung: "armageddon", black: "H", result: "white" } } });
  });

  it("I2 (spec §5.5 'two entrants, always'): with NO pairing card the winner and Black options read the ENTRANTS' names, ids stay home/away", () => {
    // single-sport: the tie-break is chess's alone — boardgame is the only module declaring awaitingDecider/deciderTypes (pinned by the registry sweep in this describe)
    // The production shape the review caught: a chess knockout with no pairing card, so no person is named on the board,
    // and every option read "Home"/"Away". The entrant display names arrive in the view (registry.tsx `entrantNamesFrom`).
    const view = liveView("boardgame", {
      stageKind: "knockout",
      cfg: TB_CFG,
      events: [START, DRAWN],
      entrantNames: { home: "Riverside Chess Club", away: "Summit Knights" },
    });
    const sheet = buildSheets(view, echo)[TIEBREAK_TILE_ID]!;
    let checked = 0;
    for (const [id, ids] of NAMED_STEPS) {
      const step = sheet.steps.find((s) => s.id === id)!;
      expect(step.kind === "choice" && step.options.map((o) => o.id), id).toEqual(ids);
      expect(step.kind === "choice" && step.options.map((o) => o.labelText), id).toEqual(["Riverside Chess Club", "Summit Knights"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("N1 (fix round 2): a pairing card's seated person still wins over the entrant label — on the winner step AND the Black step; ids stay home/away (black-home/black-away on Black)", () => {
    // single-sport: the tie-break is chess's alone — boardgame is the only module declaring awaitingDecider/deciderTypes (pinned by the registry sweep in this describe)
    // Round 1 let the entrant label beat the person the card seats; the person at the board is who the scorer saw play.
    const seated = liveView("boardgame", {
      stageKind: "knockout",
      cfg: TB_CFG,
      events: [START, DRAWN],
      personNames: { "H-p1": "Magnus Carlsen", "A-p1": "Hou Yifan" }, // defaultLineupPair seats `<entrant>-p1`
      entrantNames: { home: "Riverside Chess Club", away: "Summit Knights" },
    });
    const sheet = buildSheets(seated, echo)[TIEBREAK_TILE_ID]!;
    let checked = 0;
    for (const [id, ids] of NAMED_STEPS) {
      const step = sheet.steps.find((s) => s.id === id)!;
      expect(step.kind === "choice" && step.options.map((o) => o.id), id).toEqual(ids);
      expect(step.kind === "choice" && step.options.map((o) => o.labelText), id).toEqual(["Magnus Carlsen", "Hou Yifan"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("N1 (fix round 2, D-6): a SINGLES entrant whose snapshot reads 'Entry 3' is named by its member — the same name the heading shows — on the winner step and the Black step", () => {
    // single-sport: the tie-break is chess's alone — boardgame is the only module declaring awaitingDecider/deciderTypes (pinned by the registry sweep in this describe)
    // The production shape: an individual entrant's `display_name` is whatever the entry flow wrote ("Entry 3"); the
    // console heading and the device header resolve the roster (`entrantDisplayName`) and read "Ada Okonkwo". The pad's
    // names arrive through the REAL producer, `entrantNamesFrom`, which both mounts (console and device link) call.
    const single = (id: string, name: string, personId: string, fullName: string): SideInfo => ({
      id,
      name,
      kind: "individual",
      members: [{ person_id: personId, full_name: fullName, squad_number: null, default_position_key: null, is_captain: false, roles: [] }],
      lineup: [],
    });
    const home = single("H", "Entry 3", "p-ada", "Ada Okonkwo");
    const away = single("A", "Entry 4", "p-bea", "Bea Lindqvist");
    const team: SideInfo = { id: "T", name: "Riverside Chess Club", kind: "team", members: home.members, lineup: [] };
    // Empty case first: a team keeps its own name, and a singles entrant with no member yet falls back to its snapshot.
    expect(entrantNamesFrom(team, { ...away, members: [] })).toEqual({ home: "Riverside Chess Club", away: "Entry 4" });
    const names = entrantNamesFrom(home, away);
    expect(names, "the pad's names ARE the heading's").toEqual({ home: entrantDisplayName(home), away: entrantDisplayName(away) });
    const sheet = buildSheets(liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG, events: [START, DRAWN], entrantNames: names }), echo)[
      TIEBREAK_TILE_ID
    ]!;
    let checked = 0;
    for (const [id, ids] of NAMED_STEPS) {
      const step = sheet.steps.find((s) => s.id === id)!;
      expect(step.kind === "choice" && step.options.map((o) => o.id), id).toEqual(ids);
      expect(step.kind === "choice" && step.options.map((o) => o.labelText), id).toEqual(["Ada Okonkwo", "Bea Lindqvist"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("with no entrant name the winner and Black options fall back to the players the lineup puts on the board, then to Home/Away", () => {
    // single-sport: the tie-break is chess's alone — boardgame is the only module declaring awaitingDecider/deciderTypes (pinned by the registry sweep in this describe)
    const names = { "H-p1": "Magnus Carlsen", "A-p1": "Hou Yifan" }; // defaultLineupPair seats `<entrant>-p1`
    const stepOf = (id: string, personNames: Record<string, string>) =>
      buildSheets(liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG, events: [START, DRAWN], personNames }), echo)[TIEBREAK_TILE_ID]!.steps.find(
        (s) => s.id === id,
      )!;
    let checked = 0;
    for (const [id] of NAMED_STEPS) {
      const named = stepOf(id, names);
      const unnamed = stepOf(id, {});
      // The key stays the canonical fallback on every option; the name, when the lineup has one, wins (labelText).
      expect(named.kind === "choice" && named.options.map((o) => o.label), id).toEqual(["scorepad.attribution.home", "scorepad.attribution.away"]);
      expect(named.kind === "choice" && named.options.map((o) => o.labelText), id).toEqual(["Magnus Carlsen", "Hou Yifan"]);
      expect(unnamed.kind === "choice" && unnamed.options.map((o) => o.labelText), id).toEqual([undefined, undefined]);
      checked++;
    }
    expect(checked).toBe(NAMED_STEPS.length);
  });

  it("the score step shows for rapid and blitz only, and 'none' sends no score", () => {
    const sheet = buildSheets(tiebreakView(), echo)[TIEBREAK_TILE_ID]!;
    const score = sheet.steps.find((s) => s.id === "score")!;
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      expect(shownFor(score, { rung, winner: "home" }), rung).toBe(rung !== "armageddon");
      checked++;
    }
    expect(checked).toBe(3);
    expect(sheet.buildPayload({ rung: "rapid", winner: "away", score: "1½–½" })).toEqual({ rung: "rapid", winner: "A", score: "1½–½" });
    expect(sheet.buildPayload({ rung: "rapid", winner: "away", score: "none" })).toEqual({ rung: "rapid", winner: "A" });
  });

  it("answers left by a rung the scorer backed out of are never sent: the rung decides which winner and whether a score", () => {
    const sheet = buildSheets(tiebreakView(), echo)[TIEBREAK_TILE_ID]!;
    // Rapid answered (home, 2–0), then Back to step 1 and Armageddon (Black away, drawn): only the Armageddon branch counts,
    // and neither the rapid winner nor its score rides along.
    expect(sheet.buildPayload({ rung: "armageddon", winner: "home", score: "2–0", black: "black-away", result: "result-draw" })).toEqual({ rung: "armageddon", black: "A", result: "draw" });
    // …and the other way: an Armageddon answer left behind does not decide a blitz.
    expect(sheet.buildPayload({ rung: "blitz", black: "black-home", result: "result-white", winner: "away", score: "2–0" })).toEqual({ rung: "blitz", winner: "A", score: "2–0" });
  });

  it("with no winner, Black or result answered for the chosen rung the sheet refuses to build a payload — it never defaults one", () => {
    const sheet = buildSheets(tiebreakView(), echo)[TIEBREAK_TILE_ID]!;
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      expect(() => sheet.buildPayload({ rung }), rung).toThrow(rung === "armageddon" ? /no Black answered/ : /no winner answered/);
      checked++;
    }
    expect(checked).toBe(TIEBREAK_RUNGS.length);
    expect(() => sheet.buildPayload({ rung: "rapid", winner: "draw" })).toThrow(/no winner answered/);
    // An Armageddon with Black but no result, or a result but no Black, or an answer that is not one of the options.
    expect(() => sheet.buildPayload({ rung: "armageddon", black: "black-home" })).toThrow(/no result answered/);
    expect(() => sheet.buildPayload({ rung: "armageddon", result: "result-draw" })).toThrow(/no Black answered/);
    expect(() => sheet.buildPayload({ rung: "armageddon", black: "home", result: "result-draw" })).toThrow(/no Black answered/);
    expect(() => sheet.buildPayload({ rung: "armageddon", black: "black-home", result: "draw" })).toThrow(/no result answered/);
    // The pair: the same answers, complete, build.
    expect(sheet.buildPayload({ rung: "armageddon", black: "black-home", result: "result-draw" })).toEqual({ rung: "armageddon", black: "H", result: "draw" });
  });

  it("the seam: every payload the sheet can build folds through the REAL engine to the win the rulebook gives — the tapped winner, or the entrant BG-KO-2 advances (class 1)", () => {
    let checked = 0;
    const sheet = buildSheets(tiebreakView(), echo)[TIEBREAK_TILE_ID]!;
    const scoreStep = sheet.steps.find((s) => s.id === "score")!;
    const scores = scoreStep.kind === "choice" ? scoreStep.options.map((o) => o.id) : [];
    expect(scores).toContain("none");
    const fold = foldTiebreak;
    for (const rung of TIEBREAK_RUNGS) {
      if (rung === "armageddon") continue; // the Armageddon is driven below: it has no winner and no score
      for (const winner of ["home", "away"] as const)
        for (const score of scores) {
          const payload = sheet.buildPayload({ rung, winner, ...(score !== "none" ? { score } : {}) });
          expect(fold(payload), JSON.stringify(payload)).toMatchObject({ kind: "win", winner: ENTRANT[winner], method: `tiebreak_${rung}` });
          checked++;
        }
    }
    // BG-KO-2: Black × result. Who advances is the RULEBOOK's (White won → the other entrant; Black won or drawn → Black),
    // never read off the payload the sheet built: the engine derives it, and this is the only place both halves meet.
    for (const black of ["home", "away"] as const)
      for (const result of ARMAGEDDON_RESULTS) {
        const payload = sheet.buildPayload({ rung: "armageddon", black: `black-${black}`, result: `result-${result}` });
        expect(payload, "no winner key: the entrant is never named as the winner").not.toHaveProperty("winner");
        expect(fold(payload), JSON.stringify(payload)).toMatchObject({ kind: "win", winner: ENTRANT[advancerOf(black, result)], method: "tiebreak_armageddon" });
        checked++;
      }
    // rapid and blitz × each score × both sides, plus Armageddon × both Black × each result
    expect(checked).toBe((TIEBREAK_RUNGS.length - 1) * scores.length * 2 + 2 * ARMAGEDDON_RESULTS.length);
  });

  it("BG-KO-2 the read-back names the entrant the REAL engine advances, for every Black × result — the sentence cannot drift from the fold", () => {
    const names = { home: "Asha Rao", away: "Priya Menon" };
    const sheet = buildSheets(stageView(undefined, names), tEn)[TIEBREAK_TILE_ID]!;
    const confirm = sheet.steps.find((s) => s.id === "confirm");
    if (confirm === undefined || confirm.kind !== "confirm") throw new Error("the Armageddon sheet has no confirm step");
    const nameOfEntrant = { H: names.home, A: names.away } as const;
    let checked = 0;
    for (const black of ["home", "away"] as const)
      for (const result of ARMAGEDDON_RESULTS) {
        const answers = { rung: "armageddon", black: `black-${black}`, result: `result-${result}` };
        const outcome = foldTiebreak(sheet.buildPayload(answers)) as { kind: string; winner: "H" | "A"; loser: "H" | "A" };
        const line = confirm.summary(answers);
        expect(line, `${black}/${result}: names the engine's winner`).toContain(`Advances: ${nameOfEntrant[outcome.winner]} —`);
        expect(line, `${black}/${result}: never names the loser as the advancer`).not.toContain(`Advances: ${nameOfEntrant[outcome.loser]}`);
        checked++;
      }
    expect(checked).toBe(2 * ARMAGEDDON_RESULTS.length);
  });

  it("every key the tie-break can render exists in the English dictionary", () => {
    const seen = new Set<string>();
    const recording = (k: string) => (seen.add(k), k);
    const v = tiebreakView();
    for (const tile of buildTiles(v, recording)) seen.add(tile.label);
    let confirms = 0;
    for (const step of buildSheets(v, recording)[TIEBREAK_TILE_ID]!.steps) {
      seen.add(step.title);
      if (step.kind === "choice") {
        if (step.hintKey) seen.add(step.hintKey);
        for (const o of step.options) seen.add(o.label);
      }
      if (step.kind === "confirm") {
        // The read-back sentence resolves its own keys through the `t` the sheet was built with: drive every answer.
        for (const black of ["home", "away"]) for (const result of ARMAGEDDON_RESULTS) step.summary({ rung: "armageddon", black: `black-${black}`, result: `result-${result}` });
        confirms++;
      }
    }
    expect(confirms, "the Armageddon branch ends on exactly one confirm step").toBe(1);
    expect(seen.size).toBeGreaterThan(14);
    expect([...seen].filter((k) => !(k in (uiEn as Record<string, string>)))).toEqual([]);
  });
});

describe("the dock never offers an organiser-only write to anyone else (D-O1; loop-H addendum 2)", () => {
  const chipIds = (v: PadHostView, payload: Record<string, unknown>) =>
    dockFor(boardgameSkinV3(echo), RESULT_TYPE, v, payload)?.chips.map((c) => c.id) ?? [];

  it("chess (W2b D15): the organiser's and the scorer's docks are the same chips — no chess method is organiser-only any more, and neither dock offers forfeit or double forfeit", () => {
    // single-sport: chess was the one sport with a payload-scoped organiser-only method (W2a D-O1); every sport's dock is swept in the last test of this describe
    const scorer = liveView("boardgame", { stageKind: "knockout", canOrganise: false });
    const organiser = liveView("boardgame", { stageKind: "knockout", canOrganise: true });
    let docks = 0;
    for (const payload of [{ winner: "H" }, { winner: null }]) {
      const ids = chipIds(organiser, payload);
      expect(ids.length, JSON.stringify(payload)).toBeGreaterThan(0);
      expect(chipIds(scorer, payload), JSON.stringify(payload)).toEqual(ids);
      expect(ids.filter((id) => id === "method:forfeit" || id === "method:double_forfeit"), JSON.stringify(payload)).toEqual([]);
      docks++;
    }
    expect(docks).toBe(2);
  });

  it("the dock the host RENDERS is the filtered one (resolveDockSpec reads dockFor)", () => {
    // single-sport: a chassis witness — the sport only supplies a view; the dock under test is a stub (every sport's real dock is swept in the last test of this describe)
    // W2b: no shipped skin's dock carries an organiser-only chip any more (the sweep below), so the chassis filter is
    // witnessed on a skin built for it — a dock held over an organiser-only TYPE (core.settle, the server's predicate),
    // whose every chip is that write. The filter must still drop them for a non-organiser and keep them for an organiser.
    const base = boardgameSkinV3(echo);
    const skin = {
      ...base,
      dock: () => ({ title: "t", chips: [{ id: "lot", label: "l", mutate: (p: Record<string, unknown>) => ({ ...p, method: "lot" }) }] }),
    };
    const held = { eventType: "core.settle", payload: { winner: "H" } };
    const ids = (canOrganise: boolean) =>
      resolveDockSpec(skin, held, liveView("boardgame", { stageKind: "knockout", canOrganise }))?.chips.map((c) => c.id) ?? [];
    expect(ids(true)).toEqual(["lot"]);
    expect(ids(false)).toEqual([]);
  });

  it("the host builds its view from its props: the stage kind, organiser flag and entrant names reach every skin (source audit)", () => {
    // pad-host.tsx is not renderable in this node workspace (no DOM); this mirror is the same audit clock.test.ts keeps
    // for clockAt. The behavioural witness is bracket-finish.spec.ts (a generic bracket shows no Draw on the pad).
    const src = readFileSync(fileURLToPath(new URL("../pad-host.tsx", import.meta.url)), "utf8");
    expect(src).toContain("      stageKind: props.stageKind,\n      canOrganise: props.canOrganise,\n      entrantNames: props.entrantNames,\n");
    expect(src).toContain("[props.cfg, props.stageKind, props.canOrganise, props.entrantNames, pipeline.state,");
  });

  it("D-P1: the organiser keeps Draw in every stage kind while live; its dock holds no double forfeit (W2b D15)", () => {
    // single-sport: D-P1 is a chess ruling — chess keeps its Draw in every stage kind (a generic bracket drops it: X-DR-1)
    let checked = 0;
    for (const stageKind of ["knockout", "league", "swiss", null]) {
      const organiser = liveView("boardgame", { stageKind, canOrganise: true });
      expect(buildTiles(organiser, echo).some((t) => t.id === DRAW_TILE_ID), String(stageKind)).toBe(true);
      const drawn = chipIds(organiser, { winner: null });
      expect(drawn.length, String(stageKind)).toBeGreaterThan(0);
      expect(drawn, String(stageKind)).not.toContain("method:double_forfeit");
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("every sport: no dock a non-organiser can open carries a chip whose write the server refuses them", () => {
    let docks = 0;
    let removed = 0;
    let sports = 0;
    for (const sport of builtinModules) {
      const make = V3_SKINS[sport.key];
      if (!make) continue;
      const skin = make(echo);
      for (const cfg of declaredCfgs(sport)) {
        for (const canOrganise of [false, true]) {
          let v: PadHostView;
          try {
            v = liveView(sport.key, { cfg: cfg as Record<string, unknown>, canOrganise });
          } catch {
            continue; // a cfg whose bare core.start does not fold is not a live pad; counted below by `docks`
          }
          const offers: { type: string; payload: Record<string, unknown> }[] = [];
          for (const tile of skin.tiles(v)) if ("event" in tile.action) offers.push({ type: tile.action.event.type, payload: { ...(tile.action.event.payload as object) } });
          for (const half of skin.scorebug(v).halves) if (half.tapEvent) offers.push({ type: half.tapEvent.type, payload: { ...(half.tapEvent.payload as object) } });
          for (const { type, payload } of offers) {
            const filtered = dockFor(skin, type, v, payload);
            const raw = skin.dock(type, v, payload);
            if (filtered === null) continue;
            docks++;
            if (!canOrganise) {
              for (const chip of filtered.chips) expect(isOrganiserOnlyEvent(type, chip.mutate(payload)), `${sport.key} ${type} ${chip.id}`).toBe(false);
              removed += (raw?.chips.length ?? 0) - filtered.chips.length;
            } else {
              expect(filtered.chips.length, `${sport.key} ${type}: the organiser loses nothing`).toBe(raw?.chips.length);
            }
          }
        }
      }
      sports++;
    }
    expect(sports).toBeGreaterThanOrEqual(10);
    expect(docks, `docks judged: ${docks}`).toBeGreaterThan(0);
    // W2b D15: chess's forfeit / double forfeit left the dock for everyone, so the filter removes nothing from any
    // shipped skin — a chip it removes again is a new organiser-only dock write, and owes its own ruling.
    expect(removed, "no shipped dock carries an organiser-only chip").toBe(0);
  });
});
