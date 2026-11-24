// The online chess entrant cap's arithmetic (online-entrant-cap.ts): min(plan cap, 256) for a division that plays online, the plan's
// own cap for every other division. Expected answers are written from the owner's ruling (2026-11-21; the cap raised from 128 to 256
// on 2026-11-23) as a hand table, never read back
// from the functions: a CAPACITY limit, not an upsell - so when the plan cap is lower the plan's 402 (upgrade copy) answers, and when it
// is not the cap answers with its own 422 code.
//
// The doors that call these (createEntrants, sign-up, promote, the online switch, ...) are driven through their real usecases in
// usecases/__tests__/online-entrant-cap-doors.test.ts; this file is the table they all share.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { forEachSport } from "@seazn/engine/testkit";
import { describe, expect, it } from "vitest";
import { PaymentRequiredError } from "@/lib/errors";
import {
  ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION,
  ONLINE_DIVISION_FULL,
  ONLINE_PLAY_TOO_MANY_ENTRANTS,
} from "@/lib/online-chess";
import { ONLINE_PACKAGE_CODES, ONLINE_SIZES, ONLINE_SIZE_DOORS, type OnlineSize } from "@/lib/online-chess-package";
import { ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION as FROM_ONLINE_PLAY } from "../online-play";
import {
  assertEntrantRoom,
  assertOnlineHeldRoom,
  assertOnlinePlayFits,
  assertOnlineRoom,
  assertSizeRoom,
  capBinder,
  effectiveEntrantCap,
  onlineCapBinds,
  onlineDivisionFullError,
  onlineRoomLeft,
  onlineSizeFullError,
  PLAN_LIMIT_NOT_READ,
  readPlanLimit,
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
    expect(() => assertOnlinePlayFits(0, null), "an empty division").not.toThrow();
    expect(() => assertOnlinePlayFits(MAX - 1, null)).not.toThrow();
    expect(() => assertOnlinePlayFits(MAX, null), "exactly the cap fits").not.toThrow();
    const err = (() => {
      try {
        assertOnlinePlayFits(MAX + 1, null);
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

  // Cap-256 review m1 (controller ruling 2026-11-23): the switch judges the places held against min(plan cap, 256), as every door.
  // [plan cap, places held, verdict] - typed from the ruling.
  it("against min(plan cap, 256): a lower plan cap answers with the plan's own 402, the tie and above with the switch's own 422", () => {
    const table: [number | null, number, "ok" | "plan" | "too_many"][] = [
      [128, 0, "ok"], // the empty case first
      [128, 128, "ok"],
      [128, 129, "plan"], // an Event Pass's 128: more than the plan holds is the plan's refusal, and an upgrade lifts it
      [128, 257, "plan"], // past both: the lower line (the plan's) answers
      [64, 65, "plan"],
      [256, 256, "ok"],
      [256, 257, "too_many"], // Pro's 256: the tie goes to the online cap
      [512, 257, "too_many"],
      [null, 257, "too_many"],
    ];
    let checked = 0;
    for (const [plan, held, want] of table) {
      let got: "ok" | "plan" | "too_many" = "ok";
      try {
        assertOnlinePlayFits(held, plan);
      } catch (e) {
        if (e instanceof PaymentRequiredError) got = "plan";
        else if ((e as { code?: string }).code === ONLINE_PLAY_TOO_MANY_ENTRANTS) got = "too_many";
        else throw e;
      }
      expect(got, `plan ${plan}, ${held} held`).toBe(want);
      checked += 1;
    }
    expect(checked, "rows checked").toBe(table.length);
  });
});

describe("readPlanLimit: a plan never read fails closed (cap-256 re-review n2)", () => {
  it("an unopened guard throws by name; an unlimited plan (null) and a plan's number come back as read", () => {
    expect(() => readPlanLimit(undefined), "never read is not unlimited").toThrow(PLAN_LIMIT_NOT_READ);
    expect(PLAN_LIMIT_NOT_READ).toContain("plan limit not read");
    expect(readPlanLimit({ planLimit: null }), "null IS an unlimited plan: only an unread guard is refused").toBeNull();
    expect(readPlanLimit({ planLimit: 128 })).toBe(128);
  });
});

describe("assertOnlineHeldRoom: a door that adds a place but no row (Reinstate) asks min(plan cap, 256) too (cap-256 review m1)", () => {
  it("the table, typed from the ruling: a lower plan cap is the plan's 402, the tie and above ONLINE_DIVISION_FULL", () => {
    // [plan cap, places held after the write, verdict]
    const table: [number | null, number, "ok" | "plan" | "online"][] = [
      [128, 1, "ok"], // the empty case first: the first place back
      [128, 128, "ok"],
      [128, 129, "plan"], // an Event Pass's 128: the plan's refusal (the bug this closes: the flat check admitted it, up to 256)
      [96, 97, "plan"],
      [256, 256, "ok"],
      [256, 257, "online"], // Pro's 256: the tie goes to the online cap
      [512, 257, "online"],
      [null, 257, "online"],
    ];
    let checked = 0;
    for (const [plan, wouldHold, want] of table) {
      let got: "ok" | "plan" | "online" = "ok";
      try {
        assertOnlineHeldRoom(plan, wouldHold);
      } catch (e) {
        if (e instanceof PaymentRequiredError) got = "plan";
        else if ((e as { code?: string }).code === ONLINE_DIVISION_FULL) got = "online";
        else throw e;
      }
      expect(got, `plan ${plan}, ${wouldHold} held`).toBe(want);
      checked += 1;
    }
    expect(checked, "rows checked").toBe(table.length);
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


// ─── Online Chess credits, Task 7: the purchased size is the third term (spec 2026-11-23-online-chess-credits-design.md §5.2, §7.6) ──
//
// Every expected value below is typed from the spec and the plan's Global Constraints, never read back from the functions:
//   - the cap is min(plan cap, size, 256);
//   - which refusal answers: the plan's own 402 when the PLAN is the lowest line, 422 ONLINE_SIZE_FULL when the SIZE is, 422
//     ONLINE_DIVISION_FULL at 256; a tie between the plan and the size goes to the plan (an organiser who buys a bigger size cannot
//     seat more than the plan allows), a tie with 256 goes to the online cap (the existing ruling: no upgrade changes anything);
//   - an online division with no live row (size null) is judged as it was before the size existed: min(plan, 256).
describe("Task 7: effectiveEntrantCap and capBinder with the size", () => {
  // [online, plan cap, size, effective cap, binder]
  const table: [boolean, number | null, number | null, number | null, "plan" | "size" | "online" | null][] = [
    [true, 32, 64, 32, "plan"], // plan 32, size 64: the plan is lowest (the plan's 402)
    [true, 256, 32, 32, "size"], // plan 256, size 32: the size is lowest (ONLINE_SIZE_FULL)
    [true, 512, 256, 256, "online"], // size 256: the online cap (ONLINE_DIVISION_FULL)
    [true, null, 256, 256, "online"],
    [true, null, 16, 16, "size"], // an unlimited plan: only the size and 256 draw a line
    [true, 96, 128, 96, "plan"], // a size pack's 96 under a bought 128: the plan binds (P17: "the division seats 96")
    [true, 128, 64, 64, "size"],
    [true, 64, 64, 64, "plan"], // the tie between plan and size goes to the plan
    [true, 256, 256, 256, "online"], // Pro's 256 and a 256 size: both ARE the online cap
    [true, 300, 256, 256, "online"],
    [true, 64, 16, 16, "size"], // Community's 64 over a 16: the size
    [true, 64, 128, 64, "plan"],
    [true, 512, null, 256, "online"], // no live row: today's cap, min(plan, 256)
    [true, 64, null, 64, "plan"],
    [true, null, null, 256, "online"],
    [false, 64, 16, 64, null], // not online: no package is read, the plan's cap alone
    [false, null, 16, null, null],
    [false, 512, 16, 512, null],
  ];
  it("the table, typed from the ruling: min(plan, size, 256) and the line that answers", () => {
    let checked = 0;
    for (const [online, plan, size, cap, binder] of table) {
      expect(effectiveEntrantCap(online, plan, size), `cap: online ${online}, plan ${plan}, size ${size}`).toBe(cap);
      expect(capBinder(online, plan, size), `binder: online ${online}, plan ${plan}, size ${size}`).toBe(binder);
      checked += 1;
    }
    expect(checked, "rows checked").toBe(table.length);
    expect(table.length, "anti-vacuity: the table is not empty and names every binder").toBeGreaterThanOrEqual(15);
    expect(new Set(table.map((r) => r[4])), "every answer is exercised").toEqual(new Set(["plan", "size", "online", null]));
  });

  it("a size left out reads as no size, exactly as the two-argument call always did (the callers that predate the size)", () => {
    expect(effectiveEntrantCap(true, 512)).toBe(256);
    expect(effectiveEntrantCap(true, null)).toBe(256);
    expect(effectiveEntrantCap(true, 64)).toBe(64);
    expect(onlineCapBinds(true, 512)).toBe(true);
    expect(onlineCapBinds(true, 64)).toBe(false);
  });

  it("onlineCapBinds is the 'online' answer of capBinder: a size below 256 means the online cap is not what stops the division", () => {
    expect(onlineCapBinds(true, 512, 256)).toBe(true);
    expect(onlineCapBinds(true, 512, 128)).toBe(false);
    expect(onlineCapBinds(true, null, 16)).toBe(false);
    expect(onlineCapBinds(false, null, 256)).toBe(false);
  });
});

describe("Task 7: ONLINE_SIZE_FULL", () => {
  it("every size on the ladder: 422 with `size` and the next size up (null at 256), and a sentence that sells nothing", () => {
    // typed from the leaf's ladder 16/32/64/128/256 (decision 5), not read from nextSize()
    const next: [OnlineSize, OnlineSize | null][] = [[16, 32], [32, 64], [64, 128], [128, 256], [256, null]];
    let checked = 0;
    for (const [size, want] of next) {
      const err = onlineSizeFullError(size);
      expect(err.status, `${size}: never the plan-limit 402`).toBe(422);
      expect(err.code).toBe(ONLINE_PACKAGE_CODES.sizeFull);
      expect(err.code).toBe("ONLINE_SIZE_FULL");
      expect(err.extra, `${size}: body`).toEqual({ size, nextSize: want });
      expect(err.message).toContain(String(size));
      expect(err.message, "a capacity sentence: no price, credits or plan upsell").not.toMatch(/credit|price|upgrade|plan|pro\b/i);
      expect(err).not.toBeInstanceOf(PaymentRequiredError);
      expect(err.code, "never the other cap's code").not.toBe(ONLINE_DIVISION_FULL);
      checked += 1;
    }
    expect(checked, "sizes checked").toBe(ONLINE_SIZES.length);
  });

  it("assertSizeRoom: the line falls between size and size + 1, for every size", () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      expect(() => assertSizeRoom(size, 0), `${size}: the empty case first`).not.toThrow();
      expect(() => assertSizeRoom(size, size), `${size}: exactly the size fits`).not.toThrow();
      expect(() => assertSizeRoom(size, size + 1), `${size}: one more is refused`).toThrow(
        expect.objectContaining({ status: 422, code: "ONLINE_SIZE_FULL", extra: { size, nextSize: ONLINE_SIZES[ONLINE_SIZES.indexOf(size) + 1] ?? null } }),
      );
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});

describe("Task 7: assertEntrantRoom (add) with the size", () => {
  type V = Verdict | "size";
  const verdict = (planCap: number | null, size: OnlineSize | null, counts: { rows: number; held: number }, adding: number): V => {
    try {
      assertEntrantRoom(ONLINE, planCap, counts, adding, size);
      return "ok";
    } catch (err) {
      if (err instanceof PaymentRequiredError) return "plan";
      const code = (err as { code?: string }).code;
      if (code === ONLINE_DIVISION_FULL) return "online";
      if (code === "ONLINE_SIZE_FULL") return "size";
      throw err;
    }
  };

  it("which refusal answers: the lowest of plan, size and 256 (every row typed from the ruling)", () => {
    // [plan cap, size, rows, held, adding, verdict]
    const t: [number | null, OnlineSize | null, number, number, number, V][] = [
      [256, 16, 0, 0, 1, "ok"], // the empty case first
      [256, 16, 15, 15, 1, "ok"], // the 16th
      [256, 16, 16, 16, 1, "size"], // the 17th: the size
      [256, 32, 31, 31, 1, "ok"],
      [256, 32, 32, 32, 1, "size"],
      [256, 32, 31, 31, 2, "size"], // a batch is judged whole
      [32, 64, 32, 32, 1, "plan"], // plan 32 size 64: the plan's 402
      [96, 128, 96, 96, 1, "plan"], // plan 96 size 128: the 97th gets the plan's refusal
      [96, 128, 95, 95, 1, "ok"],
      [64, 64, 64, 64, 1, "plan"], // the tie goes to the plan
      [512, 256, 256, 256, 1, "online"], // size 256: ONLINE_DIVISION_FULL
      [null, 256, 256, 256, 1, "online"],
      [null, 16, 16, 16, 1, "size"],
      [512, null, 256, 256, 1, "online"], // no live row: today's cap
      [512, null, 100, 100, 1, "ok"],
      [64, null, 64, 64, 1, "plan"],
      [512, 16, 600, 3, 1, "plan"], // the plan's own ROW count (withdrawn rows included) still answers for itself
      [512, 32, 40, 32, 1, "size"], // rows 40 are fine for a 512 plan; held 32 is the size
    ];
    let checked = 0;
    for (const [plan, size, rows, held, adding, want] of t) {
      expect(verdict(plan, size, { rows, held }, adding), `plan ${plan}, size ${size}, rows ${rows}, held ${held}, +${adding}`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(t.length);
    expect(t.length).toBeGreaterThanOrEqual(15);
  });

  it("over the board the size is ignored, even if one is passed (another sport / another mode never reads a package)", () => {
    let checked = 0;
    for (const size of [null, 16, 256] as (OnlineSize | null)[]) {
      expect(() => assertEntrantRoom(OVER_THE_BOARD, 512, { rows: 100, held: 100 }, 1, size), `size ${size}`).not.toThrow();
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

describe("Task 7: assertOnlineHeldRoom (Reinstate) with the size", () => {
  it("the lowest line answers, and the size is judged on the places the division would hold", () => {
    // [plan cap, size, would hold, answer]
    const t: [number | null, OnlineSize | null, number, "ok" | "plan" | "online" | "size"][] = [
      [256, 16, 1, "ok"],
      [256, 16, 16, "ok"],
      [256, 16, 17, "size"],
      [32, 64, 33, "plan"],
      [64, 64, 65, "plan"],
      [512, 256, 257, "online"],
      [512, null, 257, "online"],
      [128, null, 129, "plan"],
      [null, 128, 129, "size"],
    ];
    let checked = 0;
    for (const [plan, size, wouldHold, want] of t) {
      let got: "ok" | "plan" | "online" | "size" = "ok";
      try {
        assertOnlineHeldRoom(plan, wouldHold, size);
      } catch (e) {
        if (e instanceof PaymentRequiredError) got = "plan";
        else if ((e as { code?: string }).code === ONLINE_DIVISION_FULL) got = "online";
        else if ((e as { code?: string }).code === "ONLINE_SIZE_FULL") got = "size";
        else throw e;
      }
      expect(got, `plan ${plan}, size ${size}, would hold ${wouldHold}`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(t.length);
  });
});

describe("Task 7: the door list is data in the leaf, and it names every place that reads the size", () => {
  const SERVER = join(import.meta.dirname, "..", "..");
  /** Every non-test source file under apps/web/src/server, as [path relative to server/, comment-stripped code lines]. */
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" || e.name === "__fixtures__" ? [] : walk(full);
      return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
    });
  const codeLines = (file: string): string[] =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/^\s*import\b/.test(l) && !/^\s*\}?\s*from\b/.test(l));

  /** Where `sizeForDoor(` is CALLED (its own definition aside), by file, as the door ids the leaf lists for it. Typed here from the
   *  spec §5.2 / §7.6 list of doors, not derived: the scan below asserts the source agrees. `online_switch` has no `sizeForDoor` call
   *  - its size is the request's (the save writes the row), judged by `assertSizeFits` (online-package/size.ts). */
  const SITES: Record<string, string[]> = {
    "usecases/entrants.ts": ["add_entrants", "reinstate"],
    "usecases/registration-submit.ts": ["sign_up"],
    "usecases/registrations/waitlist.ts": ["promote", "confirm", "waive"],
    "usecases/registrations/settings.ts": ["capacity_save", "places_left"],
    "external-play/online-entrant-cap.ts": ["auto_promotion"],
  };
  /** How many `sizeForDoor(` calls each file holds: one per site, two where a file holds two (entrants: add and Reinstate; settings:
   *  the capacity save and the places-left read). Promote / Confirm / Waive share the ONE room check; the automatic promotions
   *  share the ONE guard (`onlineCapHoldsPromotion`, in the cap module itself). */
  const CALLS: Record<string, number> = {
    "usecases/entrants.ts": 2,
    "usecases/registration-submit.ts": 1,
    "usecases/registrations/waitlist.ts": 1,
    "usecases/registrations/settings.ts": 2,
    "external-play/online-entrant-cap.ts": 1,
  };

  it("the leaf's list is the ten doors of spec §5.2 / §7.6, each named once", () => {
    const want = ["add_entrants", "reinstate", "sign_up", "promote", "confirm", "waive", "auto_promotion", "online_switch", "capacity_save", "places_left"];
    expect([...ONLINE_SIZE_DOORS].sort()).toEqual([...want].sort());
    expect(new Set(ONLINE_SIZE_DOORS).size, "no door twice").toBe(ONLINE_SIZE_DOORS.length);
    expect(ONLINE_SIZE_DOORS.length, "anti-vacuity").toBe(10);
  });

  it("a `sizeForDoor(` call outside the declared sites fails: a new door has to be listed", () => {
    const files = walk(SERVER);
    expect(files.length, "anti-vacuity: server source files scanned").toBeGreaterThan(100);
    const found: Record<string, number> = {};
    let calls = 0;
    for (const file of files) {
      const n = codeLines(file).filter((l) => /\bsizeForDoor\(/.test(l) && !/export async function sizeForDoor\(/.test(l)).length;
      if (n > 0) {
        found[file.slice(SERVER.length + 1)] = n;
        calls += n;
      }
    }
    expect(found, "every call site of sizeForDoor in source").toEqual(CALLS);
    expect(calls, "anti-vacuity: call sites found").toBe(7);
    // every door the sites name is in the leaf's list, and every listed door except the switch is named by a site
    const named = Object.values(SITES).flat();
    expect([...named, "online_switch"].sort()).toEqual([...ONLINE_SIZE_DOORS].sort());
  });
});
