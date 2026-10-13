// W2b Task 12 (spec §5.2 "Chess forfeit paths", §5.5 "Pad"; plan D15; X-RS-3) — the chess dock after W2b.
//
// A chess forfeit is `core.forfeit` with its reason, as in the other ten sports (D15). The server retires
// `boardgame.result{method: forfeit | double_forfeit}` on write for EVERY writer, organiser included (append-event.ts
// `RETIRED_ON_WRITE_SPORT_EVENTS`). So the dock — the method chips a half tap or the Draw tile opens — must not offer
// either value to anyone: a chip the server refuses for everybody is a dead tap, and before W2b it recorded a forfeit
// as `decided` rather than `forfeited` (two statuses for one fact). The retired values are read from the SERVER's own
// list, never typed here; the dock's method lists are pinned to the engine's padSpec in skins/__tests__/boardgame.test.ts.
//
// The organiser's chess forfeit (who; why by phase — walkover, retired or disqualified, in play and in a pending
// tie-break; Neither only where the match feeds a next one) is the console's forfeit dialog (UI-1, Task 11:
// forfeit-dialog-model.test.ts, BG-WO-3), the one surface every sport's forfeit goes through. This file pins the pad's
// half of X-RS-3: whoever is not an organiser is offered no organiser-only write from any chess pad surface.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS } from "@seazn/engine/core";
import { RETIRED_ON_WRITE_SPORT_EVENTS } from "@/server/engine-db/append-event";
import { isOrganiserOnlyEvent } from "@/lib/organiser-only-events";
import { dockFor, tileEventType } from "../pad-host";
import {
  boardgameSkinV3,
  buildDock,
  buildScorebug,
  buildSheets,
  buildTiles,
  DRAW_TILE_ID,
  PAIRING_TYPE,
  RESULT_TYPE,
  TIEBREAK_TYPE,
} from "../skins/boardgame";
import type { PadHostView, TapEvent } from "../types";
import { liveView } from "./_views";

const echo = (k: string) => k;
const skin = boardgameSkinV3(echo);
/** Every stage kind the engine declares (its two disjoint halves), plus a fixture with no stage: chess keeps its result
 *  taps and Draw in each while live (D-P1). */
const KINDS: readonly (string | null)[] = [...BRACKET_KINDS, ...DRAW_KINDS, null];
const START = { type: "core.start", payload: {} };

/** What a live chess pad can hold for the dock: each half's tap and the Draw tile's event. */
function resultOffers(v: PadHostView): TapEvent[] {
  const offers: TapEvent[] = [];
  for (const half of buildScorebug(v, echo).halves) if (half.tapEvent) offers.push(half.tapEvent);
  const draw = buildTiles(v, echo).find((t) => t.id === DRAW_TILE_ID);
  if (draw && "event" in draw.action) offers.push(draw.action.event);
  return offers;
}

describe("the chess dock offers no retired forfeit method (W2b D15)", () => {
  it("empty case first: the dock answers only the result — the pairing card and the tie-break open none", () => {
    const v = liveView("boardgame");
    expect(buildDock(PAIRING_TYPE, v, echo, {})).toBeNull();
    expect(buildDock(TIEBREAK_TYPE, v, echo, {})).toBeNull();
    expect(buildDock(RESULT_TYPE, v, echo, { winner: "H" }), "the positive pair: a result opens one").not.toBeNull();
  });

  it("D15: no chip, for any viewer in any stage kind, writes a method the server retires on write — both docks, every chip, counted", () => {
    const retired = RETIRED_ON_WRITE_SPORT_EVENTS[RESULT_TYPE];
    expect(retired, "the server retires chess's forfeit methods on write").toBeDefined();
    expect(retired!.values.length, "the retired list is not empty, so the check below can fail").toBeGreaterThan(0);
    let chips = 0;
    let docks = 0;
    for (const stageKind of KINDS) {
      for (const canOrganise of [true, false]) {
        const v = liveView("boardgame", { stageKind, canOrganise });
        const offers = resultOffers(v);
        expect(offers.length, `${String(stageKind)}: two halves and the Draw tile`).toBe(3);
        for (const offer of offers) {
          const payload = { ...(offer.payload as Record<string, unknown>) };
          const dock = dockFor(skin, offer.type, v, payload);
          expect(dock, `${String(stageKind)} ${JSON.stringify(payload)}: a result opens the dock`).not.toBeNull();
          docks++;
          for (const chip of dock!.chips) {
            const written = chip.mutate(payload);
            expect(retired!.values, `${String(stageKind)} ${chip.id}`).not.toContain(written[retired!.field]);
            chips++;
          }
        }
      }
    }
    expect(docks, `docks judged: ${docks}`).toBe(KINDS.length * 2 * 3);
    expect(chips, `chips judged: ${chips}`).toBeGreaterThan(docks);
  });
});

describe("X-RS-3: a non-organiser's chess pad offers no organiser-only write", () => {
  it("no tile, sheet, half or dock chip, in any phase the pad reaches (pre, live, tie-break, decided), writes one — counted", () => {
    // single-sport: chess is the one sport whose pad was ever offered a forfeit (W2a D-O1's dock chips); the chassis
    // block on every other sport's grid is authority-only-tiles.test.ts.
    const TB_CFG = { tiebreak: true };
    const scenes: Record<string, { stageKind: string; cfg?: Record<string, unknown>; events: { type: string; payload: unknown }[] }> = {
      pre: { stageKind: "league", events: [] },
      live: { stageKind: "knockout", events: [START] },
      tiebreak: { stageKind: "knockout", cfg: TB_CFG, events: [START, { type: RESULT_TYPE, payload: { winner: null, method: "agreement" } }] },
      decided: { stageKind: "league", events: [START, { type: RESULT_TYPE, payload: { winner: "H", method: "resign" } }] },
    };
    let surfaces = 0;
    const phases = new Set<string>();
    for (const [name, scene] of Object.entries(scenes)) {
      const v = liveView("boardgame", { stageKind: scene.stageKind, cfg: scene.cfg, events: scene.events, canOrganise: false });
      phases.add(String((v.state as { phase?: string }).phase));
      const sheets = buildSheets(v, echo);
      for (const tile of buildTiles(v, echo)) {
        const type = tileEventType(tile, sheets, []);
        const payload = "event" in tile.action ? tile.action.event.payload : {};
        expect(type === null ? false : isOrganiserOnlyEvent(type, payload), `${name}: tile ${tile.id}`).toBe(false);
        surfaces++;
      }
      for (const [id, sheet] of Object.entries(sheets)) {
        expect(isOrganiserOnlyEvent(sheet.event, {}), `${name}: sheet ${id}`).toBe(false);
        surfaces++;
      }
      for (const offer of resultOffers(v)) {
        const payload = { ...(offer.payload as Record<string, unknown>) };
        expect(isOrganiserOnlyEvent(offer.type, payload), `${name}: ${offer.type}`).toBe(false);
        surfaces++;
        for (const chip of dockFor(skin, offer.type, v, payload)?.chips ?? []) {
          expect(isOrganiserOnlyEvent(offer.type, chip.mutate(payload)), `${name}: chip ${chip.id}`).toBe(false);
          surfaces++;
        }
      }
    }
    // Each scene reached the phase it names in the REAL fold (a scene that silently folded elsewhere would judge the
    // wrong pad), and the sweep saw controls — zero would pass vacuously.
    expect([...phases].sort()).toEqual(["done", "live", "pre", "tiebreak"]);
    expect(surfaces, `surfaces judged: ${surfaces}`).toBeGreaterThan(10);
  });
});
