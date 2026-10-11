// Engine mutation debt (sport-free lane) — squad-state.ts's adoption rule and its doubles readers. Squads are built with the
// real `initSquads`, never a hand-rolled SquadMember, so a fixture cannot drift from what a fold produces. The rules under
// test are the file's own declarations: a sheet "declares squad detail" when ANY member on EITHER side carries a pairOrder
// or a non-player role (ruling 3's coach/staff); the rotation is the on-field PLAYERS that declared a pairOrder, first-named
// first, ties broken by team-sheet order; a turn outside 0, 1, 2, … has no server.
//
// Sport-agnostic helpers over SquadState — no module is involved, so there is no sport registry to sweep here.
import { describe, expect, it } from "vitest";
import { initSquads } from "../core/lineup.ts";
import type { LineupPair, LineupSlot } from "../core/types.ts";
import {
  declaresSquadDetail,
  expectedPairServer,
  expectedPairServerOf,
  makeSquadAdopter,
  pairOrderOf,
  type SquadCarrier,
} from "./squad-state.ts";

type Side = LineupPair["home"];
const side = (entrantId: string, slots: Omit<LineupSlot, "orderNo">[]): Side => ({
  entrantId,
  slots: slots.map((s, i) => ({ ...s, orderNo: i + 1 })),
});
const plain = (prefix: string, n: number): Omit<LineupSlot, "orderNo">[] =>
  Array.from({ length: n }, (_, i) => ({ personId: `${prefix}${i + 1}`, slot: "starting" as const }));

const PLAIN_HOME = side("H", plain("h", 3));
const PLAIN_AWAY = side("A", plain("a", 3));

describe("declaresSquadDetail", () => {
  it("the empty case: two empty sheets, and two plain sheets (positions included), declare nothing", () => {
    expect(declaresSquadDetail(initSquads({ home: side("H", []), away: side("A", []) }))).toBe(false);
    expect(declaresSquadDetail(initSquads({ home: PLAIN_HOME, away: PLAIN_AWAY }))).toBe(false);
    const positioned = side("H", [{ personId: "gk", slot: "starting", positionKey: "GK" }, ...plain("h", 2)]);
    expect(declaresSquadDetail(initSquads({ home: positioned, away: PLAIN_AWAY }))).toBe(false);
  });

  it("ONE member of ONE side is enough — on either side, with the rest of the sheet plain", () => {
    const withOne = (detail: Partial<LineupSlot>, prefix: string, entrantId: string): Side =>
      side(entrantId, [...plain(prefix, 2), { personId: `${prefix}-x`, slot: "starting", ...detail }]);
    const details: Partial<LineupSlot>[] = [{ pairOrder: 1 }, { role: "coach" }, { role: "staff" }, { role: "coach", slot: "bench" }];
    let checked = 0;
    for (const detail of details) {
      expect(declaresSquadDetail(initSquads({ home: withOne(detail, "h", "H"), away: PLAIN_AWAY })), `home ${JSON.stringify(detail)}`).toBe(true);
      expect(declaresSquadDetail(initSquads({ home: PLAIN_HOME, away: withOne(detail, "a", "A") })), `away ${JSON.stringify(detail)}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(details.length);
  });
});

describe("makeSquadAdopter — the init handshake", () => {
  interface St extends SquadCarrier {
    readonly n: number;
  }

  it("at init a plain sheet is NOT written into the state; every later call persists, plain or not (a second call)", () => {
    const adopter = makeSquadAdopter<St>();
    const plainSquads = initSquads({ home: PLAIN_HOME, away: PLAIN_AWAY });
    const state = adopter.fresh({ n: 1 });
    const atInit = adopter.adopt(state, plainSquads);
    expect(atInit).toBe(state);
    expect(Object.hasOwn(atInit, "squads")).toBe(false);
    // The handshake is consumed: the same object's next lineup change persists even though the sheet is still plain.
    expect(adopter.adopt(state, plainSquads)).toStrictEqual({ n: 1, squads: plainSquads });
  });

  it("at init a sheet that declares detail IS written — a coach on one side only, or one pairOrder on the other", () => {
    const sheets: LineupPair[] = [
      { home: side("H", [...plain("h", 2), { personId: "coach", slot: "bench", role: "coach" }]), away: PLAIN_AWAY },
      { home: PLAIN_HOME, away: side("A", [{ personId: "a1", slot: "starting", pairOrder: 1 }, ...plain("b", 2)]) },
    ];
    let checked = 0;
    for (const sheet of sheets) {
      const adopter = makeSquadAdopter<St>();
      const squads = initSquads(sheet);
      const state = adopter.fresh({ n: 2 });
      expect(adopter.adopt(state, squads)).toStrictEqual({ n: 2, squads });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a state that never went through fresh() always persists", () => {
    const adopter = makeSquadAdopter<St>();
    const squads = initSquads({ home: PLAIN_HOME, away: PLAIN_AWAY });
    expect(adopter.adopt({ n: 3 }, squads)).toStrictEqual({ n: 3, squads });
  });
});

describe("pairOrderOf / expectedPairServer — the doubles rotation", () => {
  it("the empty case: a side that declared no pair order (singles, a plain team) has no rotation and no server", () => {
    const singles = initSquads({ home: side("H", [{ personId: "solo", slot: "starting" }]), away: PLAIN_AWAY });
    expect(pairOrderOf(singles.home)).toEqual([]);
    expect(pairOrderOf(singles.away)).toEqual([]);
    let checked = 0;
    for (const turn of [0, 1, 2, 3]) {
      expect(expectedPairServer(singles.home, turn)).toBeNull();
      expect(expectedPairServerOf(singles, "away", turn)).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
    expect(expectedPairServerOf(undefined, "home", 0)).toBeNull();
  });

  it("an on-field partner who declared no pair order is not in the rotation beside the two who did", () => {
    const squads = initSquads({
      home: side("H", [
        { personId: "undeclared", slot: "starting" },
        { personId: "second", slot: "starting", pairOrder: 2 },
        { personId: "first", slot: "starting", pairOrder: 1 },
      ]),
      away: PLAIN_AWAY,
    });
    expect(pairOrderOf(squads.home)).toEqual(["first", "second"]);
  });

  it("a coach on the starting sheet carrying a pair order is never in the rotation — only players serve", () => {
    const squads = initSquads({
      home: side("H", [
        { personId: "coach", slot: "starting", role: "coach", pairOrder: 1 },
        { personId: "staff", slot: "starting", role: "staff", pairOrder: 1 },
        { personId: "second", slot: "starting", pairOrder: 2 },
        { personId: "first", slot: "starting", pairOrder: 1 },
      ]),
      away: PLAIN_AWAY,
    });
    expect(squads.home.members.find((m) => m.personId === "coach")?.onField).toBe(true); // premise: it reached the field
    expect(pairOrderOf(squads.home)).toEqual(["first", "second"]);
    expect([0, 1, 2].map((t) => expectedPairServer(squads.home, t))).toEqual(["first", "second", "first"]);
  });

  it("a tie on pair order falls back to team-sheet order — whichever order the sheet lists the pair in", () => {
    // `side()` numbers orderNo by sheet position, so the explicit orderNo here is what decides, not array order.
    const tied = (rows: LineupSlot[]): Side => ({ entrantId: "H", slots: rows });
    const early: LineupSlot = { personId: "early", slot: "starting", orderNo: 1, pairOrder: 1 };
    const late: LineupSlot = { personId: "late", slot: "starting", orderNo: 2, pairOrder: 1 };
    let checked = 0;
    for (const rows of [
      [late, early],
      [early, late],
    ]) {
      const squads = initSquads({ home: tied(rows), away: PLAIN_AWAY });
      expect(pairOrderOf(squads.home), rows.map((r) => r.personId).join(",")).toEqual(["early", "late"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a turn outside 0, 1, 2, … has no server — including a negative exact multiple of the rotation length", () => {
    // -2 % 2 is -0, which indexes the FIRST partner if the negative turn reaches the lookup.
    const squads = initSquads({
      home: side("H", [
        { personId: "first", slot: "starting", pairOrder: 1 },
        { personId: "second", slot: "starting", pairOrder: 2 },
      ]),
      away: PLAIN_AWAY,
    });
    const refused = [-1, -2, -4, -3, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const turn of refused) expect(expectedPairServer(squads.home, turn), `turn ${turn}`).toBeNull();
    // Positive pair: the legal turns alternate first-named first.
    expect([0, 1, 2, 3, 4].map((t) => expectedPairServer(squads.home, t))).toEqual(["first", "second", "first", "second", "first"]);
    expect(expectedPairServerOf(squads, "home", -2)).toBeNull();
    expect(expectedPairServerOf(squads, "home", 3)).toBe("second");
  });
});
