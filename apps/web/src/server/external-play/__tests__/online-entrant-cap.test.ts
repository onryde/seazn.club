// The online chess entrant cap's arithmetic (online-entrant-cap.ts): min(plan cap, 256) for a division that plays online, the plan's
// own cap for every other division. Expected answers are written from the owner's ruling (2026-11-21; the cap raised from 128 to 256
// on 2026-11-23) as a hand table, never read back
// from the functions: a CAPACITY limit, not an upsell - so when the plan cap is lower the plan's 402 (upgrade copy) answers, and when it
// is not the cap answers with its own 422 code.
//
// The doors that call these (createEntrants, sign-up, promote, the online switch, ...) are driven through their real usecases in
// usecases/__tests__/online-entrant-cap-doors.test.ts; this file is the table they all share.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forEachSport } from "@seazn/engine/testkit";
import { describe, expect, it } from "vitest";
import { PaymentRequiredError } from "@/lib/errors";
import {
  ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION,
  ONLINE_DIVISION_FULL,
  ONLINE_PLAY_TOO_MANY_ENTRANTS,
} from "@/lib/online-chess";
import { ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION as FROM_ONLINE_PLAY } from "../online-play";
import {
  assertEntrantRoom,
  assertOnlinePlayFits,
  assertOnlineRoom,
  effectiveEntrantCap,
  onlineCapBinds,
  onlineDivisionFullError,
  onlineRoomLeft,
} from "../online-entrant-cap";
import { supportsOnlinePlay } from "../online-play";

const MAX = ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION;
const ONLINE = { sport_key: "boardgame", config: { onlinePlay: "lichess" } };
const OVER_THE_BOARD = { sport_key: "boardgame", config: { variant: "classical" } };

type Verdict = "ok" | "plan" | "online";
/** What `assertEntrantRoom` answers for `adding` entrants to a division holding `rows` rows (the plan's count) and `held` places (the online count). */
const verdictForCounts = (
  division: { sport_key: string; config: unknown },
  planCap: number | null,
  counts: { rows: number; held: number },
  adding: number,
): Verdict => {
  try {
    assertEntrantRoom(division, planCap, counts, adding);
    return "ok";
  } catch (err) {
    if (err instanceof PaymentRequiredError) return "plan";
    if ((err as { code?: string }).code === ONLINE_DIVISION_FULL) return "online";
    throw err;
  }
};
/** One entrant added to a division whose two counts agree (`wouldBe - 1` of each): the cap's own table, before the counts diverge. */
const verdictOf = (division: { sport_key: string; config: unknown }, planCap: number | null, wouldBe: number): Verdict =>
  verdictForCounts(division, planCap, { rows: wouldBe - 1, held: wouldBe - 1 }, 1);

describe("the constant", () => {
  it("is the owner's 256 (2026-11-23: lifted from 128 after the 256-board real-lila load run), and is the one number the predicate's module re-exports", () => {
    expect(MAX).toBe(256);
    expect(FROM_ONLINE_PLAY, "online-play.ts re-exports the one constant (it does not declare a second)").toBe(MAX);
  });
});

describe("effectiveEntrantCap: min(plan cap, 256) for an online division, the plan's cap for every other", () => {
  it("the table, from the ruling (every plan cap the catalogue holds, and unlimited)", () => {
    // [online, plan cap, effective cap]
    const table: [boolean, number | null, number | null][] = [
      [true, 64, 64], // Community: the plan binds
      [true, 128, 128], // an Event Pass's 128: the plan binds now (at a cap of 128 it was the tie)
      [true, 255, 255],
      [true, 256, 256], // Pro: exactly the online cap
      [true, 512, 256], // Event Pass L: the online cap binds
      [true, null, 256], // unlimited: the online cap is the only cap
      [false, 64, 64],
      [false, 512, 512], // not online: Event Pass L keeps 512
      [false, null, null], // not online and unlimited: no cap
    ];
    let checked = 0;
    for (const [online, plan, want] of table) {
      expect(effectiveEntrantCap(online, plan), `online ${online}, plan ${plan}`).toBe(want);
      checked += 1;
    }
    expect(checked, "rows checked").toBe(table.length);
    expect(table.length, "anti-vacuity: the table is not empty").toBeGreaterThanOrEqual(9);
  });

  it("onlineCapBinds: only for an online division whose plan cap is absent or no lower than 256 (the tie goes to the online cap)", () => {
    expect(onlineCapBinds(true, 64), "a lower plan cap binds first - an upgrade lifts it").toBe(false);
    expect(onlineCapBinds(true, 128), "an Event Pass's 128 is below the cap now: an upgrade does lift it").toBe(false);
    expect(onlineCapBinds(true, MAX - 1)).toBe(false);
    expect(onlineCapBinds(true, MAX), "equal (Pro's 256): no upgrade changes anything").toBe(true);
    expect(onlineCapBinds(true, 512)).toBe(true);
    expect(onlineCapBinds(true, null)).toBe(true);
    expect(onlineCapBinds(false, 512), "not online: never").toBe(false);
    expect(onlineCapBinds(false, null)).toBe(false);
  });
});

describe("assertEntrantRoom: which refusal answers, and where the line falls", () => {
  it("online division, the table - 256 is the last entrant it holds on every plan that allows it; a lower plan cap answers with its own 402", () => {
    // [plan cap, would-be count, verdict]
    const table: [number | null, number, Verdict][] = [
      [64, 64, "ok"],
      [64, 65, "plan"], // Community: still refused at 65, with the plan message - the min
      [64, 257, "plan"],
      [128, 128, "ok"],
      [128, 129, "plan"], // an Event Pass's 128 is below the online cap now: the plan answers, and an upgrade lifts it
      [255, 256, "plan"],
      [256, 255, "ok"],
      [256, 256, "ok"], // the 256th, on Pro
      [256, 257, "online"], // the 257th on Pro (exactly the online cap): the online cap answers, no upgrade changes anything
      [512, 256, "ok"],
      [512, 257, "online"], // Event Pass L: the online cap, not the plan's 512
      [null, 256, "ok"],
      [null, 257, "online"], // unlimited plan: still 256
      [null, 5_000, "online"],
    ];
    let checked = 0;
    for (const [plan, wouldBe, want] of table) {
      expect(verdictOf(ONLINE, plan, wouldBe), `online, plan ${plan}, would be ${wouldBe}`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(table.length);
  });

  it("an over-the-board division follows the plan's cap alone: 257 is fine on Event Pass L, refused past 512, and unlimited stays unlimited", () => {
    const table: [number | null, number, Verdict][] = [
      [64, 64, "ok"],
      [64, 65, "plan"],
      [256, 256, "ok"],
      [256, 257, "plan"], // Pro over the board: the plan's own 402, at the line the online cap draws for an online division
      [512, 257, "ok"],
      [512, 512, "ok"],
      [512, 513, "plan"],
      [null, 257, "ok"],
      [null, 5_000, "ok"],
    ];
    let checked = 0;
    for (const [plan, wouldBe, want] of table) {
      expect(verdictOf(OVER_THE_BOARD, plan, wouldBe), `over the board, plan ${plan}, would be ${wouldBe}`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(table.length);
  });

  it("the two counts are separate (review C1): the online cap reads `held`, the plan's cap reads `rows` - each refuses on its own count only", () => {
    // [plan cap, rows (every entrants row), held (places held), adding, verdict]
    const table: [number | null, number, number, number, Verdict][] = [
      [512, 600, 200, 1, "plan"], // 600 rows, 400 of them withdrawn: the plan's count refuses; the online count (200) would not
      [null, 600, 200, 1, "ok"], // unlimited: no plan cap, and 200 held is under the online cap - withdrawn rows are not places
      [512, 300, 255, 1, "ok"], // the 256th place, whatever the rows say
      [512, 300, 256, 1, "online"], // the 257th place: held says full though only 300 rows exist
      [512, 10, 256, 1, "online"], // sign-ups let in fill places that are not rows at all: 10 rows, 256 held
      [512, 10, 255, 2, "online"], // a batch of two on 255 held
      [256, 256, 256, 1, "online"], // the tie (Pro): both full, the online cap answers (no upgrade changes anything)
      [128, 40, 128, 1, "plan"], // an Event Pass's 128, below the online cap: the PLAN's refusal, on the places held
      [64, 64, 10, 1, "plan"], // Community: its own 64 rows bind, online or not
      [64, 10, 64, 1, "plan"], // ...a plan BELOW the online cap judges the places held too (re-review N2): 64 held on a plan of 64, rows (10) or not
      [96, 40, 95, 1, "ok"], // a size pack's 96: the 96th place
      [96, 40, 96, 1, "plan"], // ...the 97th is the PLAN's refusal, on the places held (96 added and 96 signed up is 192)
      [96, 96, 10, 1, "plan"], // ...and its own rows still refuse on their own
    ];
    let checked = 0;
    for (const [plan, rows, held, adding, want] of table) {
      expect(verdictForCounts(ONLINE, plan, { rows, held }, adding), `online, plan ${plan}, rows ${rows}, held ${held}, adding ${adding}`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(table.length);
    // Over the board `held` is not looked at at all.
    expect(verdictForCounts(OVER_THE_BOARD, 512, { rows: 10, held: 5_000 }, 1), "over the board: held is ignored").toBe("ok");
    expect(verdictForCounts(OVER_THE_BOARD, 512, { rows: 512, held: 0 }, 1), "over the board: the plan's rows still refuse").toBe("plan");
  });

  it("onlineRoomLeft and assertOnlineRoom: 256 minus what is held, never below 0, and the line falls between 256 and 257", () => {
    expect([onlineRoomLeft(0), onlineRoomLeft(100), onlineRoomLeft(MAX), onlineRoomLeft(MAX + 2)], "the empty case first").toEqual([MAX, MAX - 100, 0, 0]);
    // Under a plan cap below the online cap (re-review N2) the room is the plan's: min(plan, 256) is the cap the doors pass in.
    expect([onlineRoomLeft(0, 96), onlineRoomLeft(95, 96), onlineRoomLeft(96, 96), onlineRoomLeft(120, 96)]).toEqual([96, 1, 0, 0]);
    expect(() => assertOnlineRoom(0)).not.toThrow();
    expect(() => assertOnlineRoom(MAX)).not.toThrow();
    expect(() => assertOnlineRoom(MAX + 1)).toThrow(expect.objectContaining({ status: 422, code: ONLINE_DIVISION_FULL }));
  });

  it("a stored `onlinePlay: lichess` on a sport that cannot play online caps nothing extra - every sport in the registry (the predicate's own sweep)", () => {
    let online = 0;
    let others = 0;
    const visited = forEachSport(({ key }) => {
      const division = { sport_key: key, config: { onlinePlay: "lichess" } };
      if (supportsOnlinePlay(key)) {
        online += 1;
        expect(verdictOf(division, 512, MAX + 1), `${key}: online, the 257th`).toBe("online");
        return;
      }
      others += 1;
      expect(verdictOf(division, 512, MAX + 1), `${key}: not an online sport, the 257th follows the plan`).toBe("ok");
      expect(verdictOf(division, 512, 513), `${key}: ...and the plan's own line is still the plan's 402`).toBe("plan");
    });
    expect(visited, "sports in the registry").toBeGreaterThan(1);
    expect(online + others, "every sport was classified").toBe(visited);
    expect(online, "registry pin: ONE sport plays online - widen the cap's reach on purpose if this changes").toBe(1);
  });

  it("the online refusal is a 422 with its own code and `limit`, and says nothing about plans or upgrading", () => {
    const err = onlineDivisionFullError();
    expect(err.status, "never the plan-limit 402").toBe(422);
    expect(err.code).toBe(ONLINE_DIVISION_FULL);
    expect(err.extra).toEqual({ limit: MAX });
    expect(err.message).toContain(String(MAX));
    expect(err.message, "a capacity limit: no upsell").not.toMatch(/upgrade|plan|raise|pro\b/i);
    expect(err).not.toBeInstanceOf(PaymentRequiredError);
  });
});

describe("assertOnlinePlayFits: turning online play on", () => {
  it("the empty case first, then the line: 0 and 256 entrants fit, 257 is refused with its own code and both numbers", () => {
    expect(() => assertOnlinePlayFits(0), "an empty division").not.toThrow();
    expect(() => assertOnlinePlayFits(MAX - 1)).not.toThrow();
    expect(() => assertOnlinePlayFits(MAX), "exactly the cap fits").not.toThrow();
    const err = (() => {
      try {
        assertOnlinePlayFits(MAX + 1);
      } catch (e) {
        return e as { status: number; code: string; extra: unknown; message: string };
      }
      throw new Error("anti-vacuity: 257 entrants must be refused");
    })();
    expect(err.status).toBe(422);
    expect(err.code, "its own code, not the add door's").toBe(ONLINE_PLAY_TOO_MANY_ENTRANTS);
    expect(err.code).not.toBe(ONLINE_DIVISION_FULL);
    expect(err.extra).toEqual({ limit: MAX, entrants: MAX + 1 });
    expect(err.message).toContain(String(MAX + 1));
    expect(err.message).toContain(String(MAX));
  });
});

describe("every automatic promotion site asks the cap (re-review N1: a seam that nothing forces is a seam that gets forgotten)", () => {
  const USECASES = join(import.meta.dirname, "..", "..", "usecases");
  // The five callers of `promoteOldestWaitlisted` outside its own module. Four are AUTOMATIC (a place was just freed: withdrawal,
  // expiry, lapse, rejection) and must ask `onlineCapHoldsPromotion`; the fifth is the organiser's oldest-first Promote, which
  // passes `beforePromote` (the room check of `assertOrganiserPromotionHasRoom`, itself counting held places under the lock).
  const FILES = ["registrations/withdraw.ts", "registrations/sweep.ts", "registration-approval.ts"];
  const code = (file: string): string[] =>
    readFileSync(join(USECASES, file), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !l.includes("import "));

  it("each automatic site in withdraw / sweep / approval is behind the cap guard; the explicit-room one carries its own check", () => {
    let calls = 0;
    let guarded = 0;
    let withRoomCheck = 0;
    for (const file of FILES) {
      const lines = code(file);
      const text = lines.join("\n");
      const here = lines.filter((l) => l.includes("promoteOldestWaitlisted(")).length;
      const guards = (text.match(/onlineCapHoldsPromotion\(/g) ?? []).length;
      const room = (text.match(/promoteOldestWaitlisted\([^)]*,\s*async \(picked\)/g) ?? []).length;
      expect(here - room, `${file}: every automatic promotion has a guard call`).toBe(guards);
      calls += here;
      guarded += guards;
      withRoomCheck += room;
    }
    expect([calls, guarded, withRoomCheck], "anti-vacuity: 5 sites = 4 guarded + 1 room-checked").toEqual([5, 4, 1]);
  });
});
