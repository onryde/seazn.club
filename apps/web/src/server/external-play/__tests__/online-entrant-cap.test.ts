// The online chess entrant cap's arithmetic (online-entrant-cap.ts): min(plan cap, 128) for a division that plays online, the plan's
// own cap for every other division. Expected answers are written from the owner's ruling (2026-11-21) as a hand table, never read back
// from the functions: a CAPACITY limit, not an upsell - so when the plan cap is lower the plan's 402 (upgrade copy) answers, and when it
// is not the cap answers with its own 422 code.
//
// The doors that call these (createEntrants, sign-up, promote, the online switch, ...) are driven through their real usecases in
// usecases/__tests__/online-entrant-cap-doors.test.ts; this file is the table they all share.
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
  effectiveEntrantCap,
  onlineCapBinds,
  onlineDivisionFullError,
} from "../online-entrant-cap";
import { supportsOnlinePlay } from "../online-play";

const MAX = ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION;
const ONLINE = { sport_key: "boardgame", config: { onlinePlay: "lichess" } };
const OVER_THE_BOARD = { sport_key: "boardgame", config: { variant: "classical" } };

type Verdict = "ok" | "plan" | "online";
const verdictOf = (division: { sport_key: string; config: unknown }, planCap: number | null, wouldBe: number): Verdict => {
  try {
    assertEntrantRoom(division, planCap, wouldBe);
    return "ok";
  } catch (err) {
    if (err instanceof PaymentRequiredError) return "plan";
    if ((err as { code?: string }).code === ONLINE_DIVISION_FULL) return "online";
    throw err;
  }
};

describe("the constant", () => {
  it("is the owner's 128, and is the one number the predicate's module re-exports", () => {
    expect(MAX).toBe(128);
    expect(FROM_ONLINE_PLAY, "online-play.ts re-exports the one constant (it does not declare a second)").toBe(MAX);
  });
});

describe("effectiveEntrantCap: min(plan cap, 128) for an online division, the plan's cap for every other", () => {
  it("the table, from the ruling (every plan cap the catalogue holds, and unlimited)", () => {
    // [online, plan cap, effective cap]
    const table: [boolean, number | null, number | null][] = [
      [true, 64, 64], // Community: the plan binds
      [true, 127, 127],
      [true, 128, 128], // exactly the online cap
      [true, 256, 128], // Pro: the online cap binds
      [true, null, 128], // unlimited: the online cap is the only cap
      [false, 64, 64],
      [false, 256, 256], // not online: Pro keeps 256
      [false, null, null], // not online and unlimited: no cap
    ];
    let checked = 0;
    for (const [online, plan, want] of table) {
      expect(effectiveEntrantCap(online, plan), `online ${online}, plan ${plan}`).toBe(want);
      checked += 1;
    }
    expect(checked, "rows checked").toBe(table.length);
    expect(table.length, "anti-vacuity: the table is not empty").toBeGreaterThanOrEqual(8);
  });

  it("onlineCapBinds: only for an online division whose plan cap is absent or no lower than 128 (the tie goes to the online cap)", () => {
    expect(onlineCapBinds(true, 64), "a lower plan cap binds first - an upgrade lifts it").toBe(false);
    expect(onlineCapBinds(true, MAX - 1)).toBe(false);
    expect(onlineCapBinds(true, MAX), "equal: no upgrade changes anything").toBe(true);
    expect(onlineCapBinds(true, 256)).toBe(true);
    expect(onlineCapBinds(true, null)).toBe(true);
    expect(onlineCapBinds(false, 256), "not online: never").toBe(false);
    expect(onlineCapBinds(false, null)).toBe(false);
  });
});

describe("assertEntrantRoom: which refusal answers, and where the line falls", () => {
  it("online division, the table - 128 is the last entrant it holds on every plan that allows it; a lower plan cap answers with its own 402", () => {
    // [plan cap, would-be count, verdict]
    const table: [number | null, number, Verdict][] = [
      [64, 64, "ok"],
      [64, 65, "plan"], // Community: still refused at 65, with the plan message - the min
      [64, 129, "plan"],
      [127, 128, "plan"],
      [128, 128, "ok"],
      [128, 129, "online"], // a plan of exactly 128 (an Event Pass): the online cap answers
      [256, 127, "ok"],
      [256, 128, "ok"], // the 128th
      [256, 129, "online"], // the 129th: the online cap, not the plan's 256
      [null, 128, "ok"],
      [null, 129, "online"], // unlimited plan: still 128
      [null, 5_000, "online"],
    ];
    let checked = 0;
    for (const [plan, wouldBe, want] of table) {
      expect(verdictOf(ONLINE, plan, wouldBe), `online, plan ${plan}, would be ${wouldBe}`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(table.length);
  });

  it("an over-the-board division follows the plan's cap alone: 129 is fine on Pro, refused past 256, and unlimited stays unlimited", () => {
    const table: [number | null, number, Verdict][] = [
      [64, 64, "ok"],
      [64, 65, "plan"],
      [256, 129, "ok"],
      [256, 256, "ok"],
      [256, 257, "plan"],
      [null, 129, "ok"],
      [null, 5_000, "ok"],
    ];
    let checked = 0;
    for (const [plan, wouldBe, want] of table) {
      expect(verdictOf(OVER_THE_BOARD, plan, wouldBe), `over the board, plan ${plan}, would be ${wouldBe}`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(table.length);
  });

  it("a stored `onlinePlay: lichess` on a sport that cannot play online caps nothing extra - every sport in the registry (the predicate's own sweep)", () => {
    let online = 0;
    let others = 0;
    const visited = forEachSport(({ key }) => {
      const division = { sport_key: key, config: { onlinePlay: "lichess" } };
      if (supportsOnlinePlay(key)) {
        online += 1;
        expect(verdictOf(division, 256, MAX + 1), `${key}: online, the 129th`).toBe("online");
        return;
      }
      others += 1;
      expect(verdictOf(division, 256, MAX + 1), `${key}: not an online sport, the 129th follows the plan`).toBe("ok");
      expect(verdictOf(division, 256, 257), `${key}: ...and the plan's own line is still the plan's 402`).toBe("plan");
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
  it("the empty case first, then the line: 0 and 128 entrants fit, 129 is refused with its own code and both numbers", () => {
    expect(() => assertOnlinePlayFits(0), "an empty division").not.toThrow();
    expect(() => assertOnlinePlayFits(MAX - 1)).not.toThrow();
    expect(() => assertOnlinePlayFits(MAX), "exactly the cap fits").not.toThrow();
    const err = (() => {
      try {
        assertOnlinePlayFits(MAX + 1);
      } catch (e) {
        return e as { status: number; code: string; extra: unknown; message: string };
      }
      throw new Error("anti-vacuity: 129 entrants must be refused");
    })();
    expect(err.status).toBe(422);
    expect(err.code, "its own code, not the add door's").toBe(ONLINE_PLAY_TOO_MANY_ENTRANTS);
    expect(err.code).not.toBe(ONLINE_DIVISION_FULL);
    expect(err.extra).toEqual({ limit: MAX, entrants: MAX + 1 });
    expect(err.message).toContain(String(MAX + 1));
    expect(err.message).toContain(String(MAX));
  });
});
