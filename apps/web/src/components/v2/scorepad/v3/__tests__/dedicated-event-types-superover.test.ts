// R3.5/B follow-up (coordinator finding, 2026-08-26): pad-host.test.ts's own
// `dedicatedEventTypes` unit tests (B1-B5) run the function against
// HAND-BUILT tiles/sheets. That is exactly what let B4 originally encode
// the wrong expectation — a sheet whose only opening tile is disabled was
// asserted as "still claimed" — because a synthetic fixture only tells you
// whether the function does what its author believes, never whether the
// belief matches what the REAL skin actually declares.
//
// This file is the missing check: `dedicatedEventTypes` fed the REAL
// cricket skin's own `buildTiles`/`buildSheets`/`buildScorebug` output,
// against a state `foldMatch` actually produced — never a hand-built
// literal. Same posture `_football-fold.ts`'s own header states for
// football: assertions here say "everything the skin offers, the fold
// accepts", never "the skin offers X" asserted against a mirror of the
// engine that can only ever agree with itself.
//
// THE DEFECT THIS PINS. Cricket's `wicket` tile is `{sheet: "wicket"}`, and
// today's (pre-Task-C) skin disables the WHOLE delivery row — including
// that tile — for the length of a super over (`blockedByClosure` in
// `skins/cricket.tsx`, derived from `currentInnings`/`dueBattingSide` still
// reading the closed MAIN innings rather than `state.superOver.innings`;
// Task C's own fix). The `wicket` SHEET itself declares
// `event: ballEventType(state)`, which is `"cricket.superover.ball"` in
// that phase — and `dedicatedEventTypes`'s sheets loop used to add every
// sheet's event unconditionally, regardless of whether any enabled tile
// could still open it. So the type stayed "claimed" even though the only
// tile able to open that sheet was unusable, which is exactly what
// suppressed the Super-over panel from the More sheet and closed the last
// route to recording a super-over ball at all.
//
// Deliberately its own file, not folded into pad-host.test.ts (synthetic
// tile/sheet-shape unit tests) or skins/__tests__/cricket.test.ts (task C's
// own skin-level unit tests, out of this task's file scope) — this is the
// cross-cutting check spanning the real skin AND the chassis together, the
// same reason cricket-dispatch-totality.test.ts is its own file rather than
// folded into either.
import { describe, expect, it } from "vitest";
import { foldMatch, initSquads, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { cricket, type CricketCfg, type CricketState } from "@seazn/engine/sports/cricket";
import { buildScorebug, buildSheets, buildTiles } from "../skins/cricket";
import { dedicatedEventTypes } from "../pad-host";
import type { PadHostView } from "../types";

/** A tied 1-over-a-side match with the super over enabled — the shortest
 *  legal route to `phase: "super_over"` with the main innings genuinely
 *  CLOSED by the fold (never a hand-built `closed: true` literal), which is
 *  what makes `blockedByClosure` true under today's skin code.
 *  `minOversForResult: 1` is required: the cfg refine rejects a result
 *  floor longer than the innings. */
function tiedWithSuperOver(): CricketCfg {
  return cricket.configSchema.parse({
    superOver: true, ballsPerInnings: 6, ballsPerOver: 6, minOversForResult: 1,
  });
}

function lineups(): LineupPair {
  const side = (p: string) => ({
    entrantId: p,
    slots: Array.from({ length: 11 }, (_, i) => ({
      personId: `${p}-${i + 1}`, slot: "starting" as const, orderNo: i + 1,
      ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
    })),
  });
  return { home: side("H"), away: side("A") } as never as LineupPair;
}

function ball(
  type: string,
  overN: number, ballInOver: number,
  striker: string, nonStriker: string, bowler: string, bat: number,
): [string, unknown] {
  return [type, { over: overN, ballInOver, striker, nonStriker, bowler, runs: { bat } }];
}

function foldCricket(cfg: CricketCfg, specs: readonly [type: string, payload?: unknown][]): CricketState {
  const envelopes: EventEnvelope[] = specs.map(([type, payload], i) =>
    makeEnvelope(i, { type, payload: payload ?? {} }));
  return foldMatch(cricket, cfg, lineups(), envelopes);
}

function view(cfg: CricketCfg, state: CricketState): PadHostView {
  return {
    cfg, state, summary: {}, phase: "live", band: 3, entitlements: {},
    personNames: {}, squads: initSquads(lineups()), events: [], contextOverrides: {},
  };
}

const t = (key: string) => key;

describe("dedicatedEventTypes against a REAL folded cricket super over", () => {
  it("a live super over does not suppress cricket.superover.ball from More via the disabled wicket sheet", () => {
    const cfg = tiedWithSuperOver();
    const state = foldCricket(cfg, [
      ["core.start"],
      ball("cricket.ball", 0, 1, "H-1", "H-2", "A-11", 1),
      ball("cricket.ball", 0, 2, "H-1", "H-2", "A-11", 1),
      ball("cricket.ball", 0, 3, "H-1", "H-2", "A-11", 1),
      ball("cricket.ball", 0, 4, "H-1", "H-2", "A-11", 1),
      ball("cricket.ball", 0, 5, "H-1", "H-2", "A-11", 1),
      ball("cricket.ball", 0, 6, "H-1", "H-2", "A-11", 1),
      ball("cricket.ball", 0, 1, "A-1", "A-2", "H-11", 1),
      ball("cricket.ball", 0, 2, "A-1", "A-2", "H-11", 1),
      ball("cricket.ball", 0, 3, "A-1", "A-2", "H-11", 1),
      ball("cricket.ball", 0, 4, "A-1", "A-2", "H-11", 1),
      ball("cricket.ball", 0, 5, "A-1", "A-2", "H-11", 1),
      ball("cricket.ball", 0, 6, "A-1", "A-2", "H-11", 1),
      // Both main innings tie 6-6; superOver:true sends the fold straight
      // to phase "super_over". One super-over ball, bowled by someone who
      // did NOT bowl the closing over of the main innings (H-10, not H-11).
      ball("cricket.superover.ball", 0, 1, "A-1", "A-2", "H-10", 1),
    ]);
    expect(state.phase).toBe("super_over");

    const v = view(cfg, state);
    const tiles = buildTiles(v, t);
    // Pins the MECHANISM, not just the symptom: the wicket tile really is
    // disabled in this real-folded state (today's pre-Task-C
    // blockedByClosure defect) — which is what makes its sheet's own claim
    // on cricket.superover.ball the ONLY thing suppressing the More panel.
    const wicketTile = tiles.find((x) => x.id === "wicket");
    expect(wicketTile?.disabled).toBe(true);

    const dedicated = dedicatedEventTypes(tiles, buildSheets(v, t), [], buildScorebug(v, t));
    expect(dedicated.has("cricket.superover.ball")).toBe(false);
  });
});
