// S3/W4b (#426) pass B — the nested kernel adopting `core/lineup.ts` for
// tennis. One deferred dossier row:
//
//   `tennis/DOMAIN.md` — "doubles serving and receiving order". The row already
//   noted that `server` makes the order RECONSTRUCTABLE after the fact, and
//   that enforcing the fixed rotation needs "the pair's declared order, which
//   is a lineup-layer fact". That fact now exists (`LineupSlot.pairOrder`),
//   survives `init` into `NestedState.squads`, and `expectedDoublesServer`
//   turns it into the answer a rotation check compares the ledger against.
//
// A test that asserted the FIELD is present would pass against a fold that
// stored the sheet and never read it, so every assertion here names a personId.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { makeEnvelope } from "../../testkit/helpers.ts";
import { tennis } from "../tennis/tennis.ts";
import { expectedDoublesServer } from "./kernel.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

const ev = (seq: number, type: string, payload: unknown): EventEnvelope =>
  makeEnvelope(seq, { type, payload });

/** A doubles team sheet. `pairOrder` is the declaration; `orderNo` is the
 *  team-sheet position and deliberately runs the OTHER way, so a reader that
 *  quietly used `orderNo` instead answers with the wrong player. */
function pairSide(entrantId: string, first: string, second: string): Lineup {
  return {
    entrantId,
    slots: [
      { personId: second, slot: "starting", orderNo: 1, pairOrder: 2 },
      { personId: first, slot: "starting", orderNo: 2, pairOrder: 1 },
    ],
  };
}

const doubles: LineupPair = {
  home: pairSide("H", "H-first", "H-second"),
  away: pairSide("A", "A-first", "A-second"),
};

const singles: LineupPair = {
  home: { entrantId: "H", slots: [{ personId: "H-solo", slot: "starting", orderNo: 1 }] },
  away: { entrantId: "A", slots: [{ personId: "A-solo", slot: "starting", orderNo: 1 }] },
};

const cfg = tennis.configSchema.parse(tennis.variants["doubles-noad-mtb10"]);

describe("tennis — the declared doubles order reaches State", () => {
  it("carries the pair order into State at init, first-named first", () => {
    const state = foldMatch(tennis, cfg, doubles, [ev(1, "core.start", {})], STRICT_ALL);
    const home = state.squads!.home;
    expect(home.members.map((m) => m.personId)).toEqual(["H-second", "H-first"]);
    expect(home.members.map((m) => m.pairOrder)).toEqual([2, 1]);
  });

  it("answers the ITF service rotation by personId, and does not read orderNo", () => {
    const state = foldMatch(tennis, cfg, doubles, [ev(1, "core.start", {})], STRICT_ALL);
    expect(expectedDoublesServer(state, "home", 0)).toBe("H-first");
    expect(expectedDoublesServer(state, "home", 1)).toBe("H-second");
    expect(expectedDoublesServer(state, "home", 2)).toBe("H-first");
    expect(expectedDoublesServer(state, "away", 3)).toBe("A-second");
  });

  it("gives a singles fixture no rotation, and writes nothing into State", () => {
    const state = foldMatch(tennis, cfg, singles, [ev(1, "core.start", {})], STRICT_ALL);
    expect(expectedDoublesServer(state, "home", 0)).toBeNull();
    expect(JSON.stringify(state)).not.toContain('"squads"');
  });
});

describe("tennis — a retirement is a squad fact, and nobody comes back", () => {
  it("records the retired player and refuses the resumption (ITF Rule 30)", () => {
    // A retired tennis player does not resume: the match is over. So the
    // engine's answer must be a REFUSAL under the variant's policy, not a
    // shrug — and that refusal has to be the sport's, since the same kernel
    // would have to answer differently for a sport whose players do resume.
    const retire = ev(2, "core.lineup.retirement", { side: "H", personId: "H-first" });
    const state = foldMatch(tennis, cfg, doubles, [ev(1, "core.start", {}), retire], STRICT_ALL);
    const member = state.squads!.home.members.find((m) => m.personId === "H-first");
    expect(member?.onField).toBe(false);
    expect(member?.timesOff).toBe(1);

    expect(() =>
      foldMatch(
        tennis,
        cfg,
        doubles,
        [
          ev(1, "core.start", {}),
          retire,
          ev(3, "core.lineup.entry", {
            side: "H",
            on: { personId: "H-first", slot: "starting", orderNo: 2, pairOrder: 1 },
          }),
        ],
        STRICT_ALL,
      ),
    ).toThrow(EngineError);
  });

  it("still folds that recorded resumption on REPLAY", () => {
    // cfg is read live and the stream replays on every read: a variant edit
    // must never make a scored fixture unreadable.
    expect(() =>
      foldMatch(tennis, cfg, doubles, [
        ev(1, "core.start", {}),
        ev(2, "core.lineup.retirement", { side: "H", personId: "H-first" }),
        ev(3, "core.lineup.entry", {
          side: "H",
          on: { personId: "H-first", slot: "starting", orderNo: 2, pairOrder: 1 },
        }),
      ]),
    ).not.toThrow();
  });
});
