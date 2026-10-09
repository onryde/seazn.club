import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { TIEBREAK_RUNGS, boardgame } from "@seazn/engine/sports/boardgame";
import { declaredCfgs, defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { isOrganiserOnlyEvent } from "@/lib/organiser-only-events";
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
import type { GuidedSheetStep, PadHostView } from "../types";
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
const tiebreakView = (o: { canOrganise?: boolean } = {}) =>
  liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG, events: [START, DRAWN], ...o });
const winnerKey = (rung: string) => (rung === "armageddon" ? "winner-armageddon" : "winner");
const shownFor = (step: GuidedSheetStep, answers: Record<string, string>) => step.when?.(answers) ?? true;

describe("the chess three-step tie-break on the pad (spec §5.5, BG-KO-1, BG-KO-2 per ruling 82, D6)", () => {
  it("TIEBREAK_TYPE is the engine's own decider type, not a second spelling", () => {
    expect(boardgame.deciderTypes).toEqual([TIEBREAK_TYPE]);
  });

  it("empty case first: in phase live there is no tie-break tile (Draw is there instead)", () => {
    const v = liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG });
    const ids = buildTiles(v, echo).map((t) => t.id);
    expect(ids).not.toContain(TIEBREAK_TILE_ID);
    expect(ids).toContain(DRAW_TILE_ID);
  });

  it("in phase tiebreak: only the tie-break tile; Draw is gone and the halves are not tappable", () => {
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

  it("BG-KO-2 (ruling 82): every rung shows ONE winner step with exactly the two entrants; the 'draw means Black advances' hint is on armageddon only", () => {
    const sheet = buildSheets(tiebreakView(), echo)[TIEBREAK_TILE_ID]!;
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const shown = sheet.steps.filter((s) => s.id.startsWith("winner") && shownFor(s, { rung }));
      expect(shown, rung).toHaveLength(1);
      const step = shown[0]!;
      expect(step.kind === "choice" && step.options.map((o) => o.id), rung).toEqual(["home", "away"]); // no third "drawn" choice
      expect(step.kind === "choice" && step.hintKey === "pad.boardgame.tiebreak.armageddonHint", rung).toBe(rung === "armageddon");
      checked++;
    }
    expect(checked).toBe(TIEBREAK_RUNGS.length);
    expect(sheet.buildPayload({ rung: "armageddon", "winner-armageddon": "away" })).toEqual({ rung: "armageddon", winner: "A" });
    expect(sheet.buildPayload({ rung: "armageddon", "winner-armageddon": "home" })).toEqual({ rung: "armageddon", winner: "H" });
  });

  it("I2 (spec §5.5 'two entrants, always'): with NO pairing card the winner and armageddon options read the ENTRANTS' names, ids stay home/away", () => {
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
    for (const id of ["winner", "winner-armageddon"]) {
      const step = sheet.steps.find((s) => s.id === id)!;
      expect(step.kind === "choice" && step.options.map((o) => o.id), id).toEqual(["home", "away"]);
      expect(step.kind === "choice" && step.options.map((o) => o.labelText), id).toEqual(["Riverside Chess Club", "Summit Knights"]);
      checked++;
    }
    expect(checked).toBe(2);
    // The entrant still wins over a person the lineup seats: the tie-break advances an ENTRANT.
    const seated = liveView("boardgame", {
      stageKind: "knockout",
      cfg: TB_CFG,
      events: [START, DRAWN],
      personNames: { "H-p1": "Magnus Carlsen", "A-p1": "Hou Yifan" },
      entrantNames: { home: "Riverside Chess Club", away: "Summit Knights" },
    });
    const winner = buildSheets(seated, echo)[TIEBREAK_TILE_ID]!.steps.find((s) => s.id === "winner")!;
    expect(winner.kind === "choice" && winner.options.map((o) => o.labelText)).toEqual(["Riverside Chess Club", "Summit Knights"]);
  });

  it("with no entrant name the winner options fall back to the players the lineup puts on the board, then to Home/Away", () => {
    const names = { "H-p1": "Magnus Carlsen", "A-p1": "Hou Yifan" }; // defaultLineupPair seats `<entrant>-p1`
    const winnerStep = (personNames: Record<string, string>) =>
      buildSheets(liveView("boardgame", { stageKind: "knockout", cfg: TB_CFG, events: [START, DRAWN], personNames }), echo)[TIEBREAK_TILE_ID]!.steps.find(
        (s) => s.id === "winner",
      )!;
    const named = winnerStep(names);
    const unnamed = winnerStep({});
    // The key stays the canonical fallback on every option; the name, when the lineup has one, wins (labelText).
    expect(named.kind === "choice" && named.options.map((o) => o.label)).toEqual(["scorepad.attribution.home", "scorepad.attribution.away"]);
    expect(named.kind === "choice" && named.options.map((o) => o.labelText)).toEqual(["Magnus Carlsen", "Hou Yifan"]);
    expect(unnamed.kind === "choice" && unnamed.options.map((o) => o.labelText)).toEqual([undefined, undefined]);
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
    // Rapid answered (home, 2–0), then Back to step 1 and Armageddon (away): only armageddon's own answer counts.
    expect(sheet.buildPayload({ rung: "armageddon", winner: "home", score: "2–0", "winner-armageddon": "away" })).toEqual({ rung: "armageddon", winner: "A" });
    // …and the other way: an armageddon answer left behind does not decide a blitz.
    expect(sheet.buildPayload({ rung: "blitz", "winner-armageddon": "home", winner: "away", score: "2–0" })).toEqual({ rung: "blitz", winner: "A", score: "2–0" });
  });

  it("with no winner answered for the chosen rung the sheet refuses to build a payload — it never defaults a winner", () => {
    const sheet = buildSheets(tiebreakView(), echo)[TIEBREAK_TILE_ID]!;
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      expect(() => sheet.buildPayload({ rung }), rung).toThrow(/no winner answered/);
      checked++;
    }
    expect(checked).toBe(TIEBREAK_RUNGS.length);
    expect(() => sheet.buildPayload({ rung: "rapid", winner: "draw" })).toThrow(/no winner answered/);
  });

  it("the seam: every payload the sheet can build folds through the REAL engine to a win for the tapped side (class 1)", () => {
    let checked = 0;
    const sheet = buildSheets(tiebreakView(), echo)[TIEBREAK_TILE_ID]!;
    const scoreStep = sheet.steps.find((s) => s.id === "score")!;
    const scores = scoreStep.kind === "choice" ? scoreStep.options.map((o) => o.id) : [];
    expect(scores).toContain("none");
    const cfg = boardgame.configSchema.parse(TB_CFG);
    const lineups = defaultLineupPair(boardgame.positions);
    const env = (seq: number, type: string, payload: unknown): EventEnvelope =>
      ({ id: `e${seq}`, fixtureId: "fx", seq, type, payload, recordedAt: "2026-10-08T00:00:00Z", recordedBy: null }) as EventEnvelope;
    for (const rung of TIEBREAK_RUNGS)
      for (const winner of ["home", "away"])
        for (const score of rung === "armageddon" ? [undefined] : scores) {
          const payload = sheet.buildPayload({ rung, [winnerKey(rung)]: winner, ...(score ? { score } : {}) });
          const s = foldMatch(boardgame, cfg, lineups, [env(1, "core.start", {}), env(2, RESULT_TYPE, DRAWN.payload), env(3, TIEBREAK_TYPE, payload)]);
          expect(boardgame.outcome(s), JSON.stringify(payload)).toMatchObject({ kind: "win", winner: winner === "home" ? "H" : "A", method: `tiebreak_${rung}` });
          checked++;
        }
    expect(checked).toBe(2 * scores.length * 2 + 2); // rapid and blitz × each score × both sides, armageddon × both sides
  });

  it("every key the tie-break can render exists in the English dictionary", () => {
    const seen = new Set<string>();
    const recording = (k: string) => (seen.add(k), k);
    const v = tiebreakView();
    for (const tile of buildTiles(v, recording)) seen.add(tile.label);
    for (const step of buildSheets(v, recording)[TIEBREAK_TILE_ID]!.steps) {
      seen.add(step.title);
      if (step.kind === "choice") {
        if (step.hintKey) seen.add(step.hintKey);
        for (const o of step.options) seen.add(o.label);
      }
    }
    expect(seen.size).toBeGreaterThan(8);
    expect([...seen].filter((k) => !(k in (uiEn as Record<string, string>)))).toEqual([]);
  });
});

describe("the dock never offers an organiser-only write to anyone else (D-O1; loop-H addendum 2)", () => {
  const chipIds = (v: PadHostView, payload: Record<string, unknown>) =>
    dockFor(boardgameSkinV3(echo), RESULT_TYPE, v, payload)?.chips.map((c) => c.id) ?? [];

  it("chess: a scorer's decisive dock has no forfeit and the drawn dock no double forfeit; the organiser's has both", () => {
    const scorer = liveView("boardgame", { stageKind: "knockout", canOrganise: false });
    const organiser = liveView("boardgame", { stageKind: "knockout", canOrganise: true });
    expect(chipIds(organiser, { winner: "H" })).toContain("method:forfeit");
    expect(chipIds(organiser, { winner: null })).toContain("method:double_forfeit");
    expect(chipIds(scorer, { winner: "H" })).not.toContain("method:forfeit");
    expect(chipIds(scorer, { winner: null })).not.toContain("method:double_forfeit");
    // Only the organiser-only chips go: every other method is still offered.
    expect(chipIds(scorer, { winner: "H" })).toEqual(chipIds(organiser, { winner: "H" }).filter((id) => id !== "method:forfeit"));
    expect(chipIds(scorer, { winner: null })).toEqual(chipIds(organiser, { winner: null }).filter((id) => id !== "method:double_forfeit"));
  });

  it("the dock the host RENDERS is the filtered one (resolveDockSpec reads dockFor)", () => {
    const skin = boardgameSkinV3(echo);
    const held = { eventType: RESULT_TYPE, payload: { winner: "H" } };
    const ids = (canOrganise: boolean) =>
      resolveDockSpec(skin, held, liveView("boardgame", { stageKind: "knockout", canOrganise }))?.chips.map((c) => c.id) ?? [];
    expect(ids(true)).toContain("method:forfeit");
    expect(ids(false)).not.toContain("method:forfeit");
    expect(ids(false).length).toBe(ids(true).length - 1);
  });

  it("the host builds its view from its props: the stage kind, organiser flag and entrant names reach every skin (source audit)", () => {
    // pad-host.tsx is not renderable in this node workspace (no DOM); this mirror is the same audit clock.test.ts keeps
    // for clockAt. The behavioural witness is bracket-finish.spec.ts (a generic bracket shows no Draw on the pad).
    const src = readFileSync(fileURLToPath(new URL("../pad-host.tsx", import.meta.url)), "utf8");
    expect(src).toContain("      stageKind: props.stageKind,\n      canOrganise: props.canOrganise,\n      entrantNames: props.entrantNames,\n");
    expect(src).toContain("[props.cfg, props.stageKind, props.canOrganise, props.entrantNames, pipeline.state,");
  });

  it("D-P1: the organiser keeps Draw and the double-forfeit chip in every stage kind while live", () => {
    let checked = 0;
    for (const stageKind of ["knockout", "league", "swiss", null]) {
      const organiser = liveView("boardgame", { stageKind, canOrganise: true });
      expect(buildTiles(organiser, echo).some((t) => t.id === DRAW_TILE_ID), String(stageKind)).toBe(true);
      expect(chipIds(organiser, { winner: null }), String(stageKind)).toContain("method:double_forfeit");
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
    expect(docks).toBeGreaterThan(0);
    expect(removed, "chess's forfeit and double forfeit were actually removed").toBeGreaterThanOrEqual(2);
  });
});
