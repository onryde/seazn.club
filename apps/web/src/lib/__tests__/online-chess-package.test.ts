// The Online Chess package leaf (spec 2026-11-23-online-chess-credits-design.md, section 3 decisions 2-5 and 9, P1, P10, P16, P17).
// Every expected value below is typed from the SPEC'S OWN tables (the price table of decision 5, P1's included rounds, P16's stage kinds,
// the plan's Global Constraints error codes), never read back from the module: the module is the thing under test. The one value that
// comes from outside the spec is the stage-kind list, which is READ FROM THE MIGRATION TEXT (stages_kind_check), the schema's own declaration.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ONLINE_ALLOWED_STAGE_KINDS,
  ONLINE_PACKAGE_CODES,
  ONLINE_REFUSED_STAGE_KINDS,
  ONLINE_SIZES,
  ONLINE_SIZE_DOORS,
  includedRounds,
  isOnlineSize,
  nextSize,
  packagePrice,
  sizeAllowedByPlan,
  sizeFor,
  sizeForRounds,
  type OnlineSize,
} from "../online-chess-package";
import { ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION } from "../online-chess-cap";

const REPO = join(import.meta.dirname, "..", "..", "..", "..", "..");

/** Decision 5's table: [size, credits without cameras, credits with the Fair-play camera]. */
const PRICE_TABLE: [OnlineSize, number, number][] = [
  [16, 1, 2],
  [32, 2, 4],
  [64, 4, 8],
  [128, 8, 16],
  [256, 16, 32],
];

/** P1's included Swiss rounds per size. */
const ROUNDS_TABLE: [OnlineSize, number][] = [
  [16, 6],
  [32, 7],
  [64, 8],
  [128, 9],
  [256, 10],
];

describe("the sizes", () => {
  it("are 16, 32, 64, 128 and 256, in that order (decision 2)", () => {
    expect([...ONLINE_SIZES]).toEqual([16, 32, 64, 128, 256]);
  });

  it("the largest size IS the online entrant cap: two leaves, one 256, tied here (the leaf itself stays import-free)", () => {
    // If the cap is lowered, a size above it must leave the ladder in the same change; otherwise a size nobody can fill stays on sale.
    expect(ONLINE_SIZES[ONLINE_SIZES.length - 1]).toBe(ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION);
    // the ladder is never longer than the cap allows either
    expect(ONLINE_SIZES.filter((s) => s > ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION)).toEqual([]);
  });

  it("nextSize walks the ladder one step and is null at 256 (every step checked, the top included)", () => {
    const steps: [OnlineSize, OnlineSize | null][] = [
      [16, 32],
      [32, 64],
      [64, 128],
      [128, 256],
      [256, null],
    ];
    let checked = 0;
    for (const [size, next] of steps) {
      expect(nextSize(size), `nextSize(${size})`).toBe(next);
      checked += 1;
    }
    expect(checked, "ladder steps checked").toBe(5);
  });

  it("isOnlineSize answers yes for the five ladder sizes and no for every number off the ladder (a stored size is asserted before it is priced)", () => {
    // The ladder is typed from decision 2, never read from ONLINE_SIZES: the module is the thing under test.
    const on = [16, 32, 64, 128, 256];
    // Off the ladder: zero, a half and a double of a size, the size-pack cap 96 (P17), neighbours of 16, a negative, a fraction,
    // and the non-finite numbers. packagePrice(0) would price at 0 and 48 at 3: either reaching a quote is money from nowhere.
    const off = [0, 8, 15, 17, 48, 96, 512, -16, 16.5, Number.NaN, Number.POSITIVE_INFINITY];
    let checked = 0;
    for (const n of on) {
      expect(isOnlineSize(n), String(n)).toBe(true);
      checked += 1;
    }
    for (const n of off) {
      expect(isOnlineSize(n), String(n)).toBe(false);
      checked += 1;
    }
    expect(checked, "sizes judged").toBe(on.length + off.length);
  });
});

describe("packagePrice (decision 5)", () => {
  it("prices all 10 cells, and every size the leaf declares has a typed row here", () => {
    let checked = 0;
    for (const [size, plain, withCameras] of PRICE_TABLE) {
      expect(packagePrice(size, false), `${size} without cameras`).toBe(plain);
      expect(packagePrice(size, true), `${size} with cameras`).toBe(withCameras);
      checked += 2;
    }
    expect(checked, "price cells checked").toBe(10);
    // The table above covers exactly the sizes the leaf declares: a size added to the leaf without a typed price here is a red.
    expect(PRICE_TABLE.map(([s]) => s)).toEqual([...ONLINE_SIZES]);
  });

  it("a camera package costs exactly double the plain one at every size (decision 5: 1 vs 2 credits per 16 players)", () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      expect(packagePrice(size, true), `${size}`).toBe(packagePrice(size, false) * 2);
      checked += 1;
    }
    expect(checked, "sizes checked").toBe(5);
  });
});

describe("includedRounds (P1)", () => {
  it("includes 6, 7, 8, 9 and 10 rounds", () => {
    let checked = 0;
    for (const [size, rounds] of ROUNDS_TABLE) {
      expect(includedRounds(size), `${size}`).toBe(rounds);
      checked += 1;
    }
    expect(checked, "sizes checked").toBe(5);
    expect(ROUNDS_TABLE.map(([s]) => s)).toEqual([...ONLINE_SIZES]);
  });
});

describe("sizeFor (the smallest size that holds the places)", () => {
  it("at each boundary, and sizeFor(0) is 16", () => {
    const cases: [number, OnlineSize | null][] = [
      [0, 16],
      [1, 16],
      [16, 16],
      [17, 32],
      [32, 32],
      [33, 64],
      [64, 64],
      [65, 128],
      [128, 128],
      [129, 256],
      [256, 256],
      [257, null],
      [1000, null],
    ];
    let checked = 0;
    for (const [places, want] of cases) {
      expect(sizeFor(places), `sizeFor(${places})`).toBe(want);
      checked += 1;
    }
    expect(checked, "boundaries checked").toBe(13);
  });

  it("refuses a count that is not a count: NaN and negatives throw instead of quoting a size", () => {
    expect(() => sizeFor(Number.NaN)).toThrow(RangeError);
    expect(() => sizeFor(-1)).toThrow(RangeError);
    // and the guard does not swallow a legitimate zero (the empty case a division with nobody in it quotes)
    expect(sizeFor(0)).toBe(16);
  });
});

describe("sizeForRounds (P1, P10)", () => {
  it("6 rounds fit 16 ... 10 rounds need 256, and above 10 there is no size", () => {
    const cases: [number, OnlineSize | null][] = [
      [0, 16], // a division with no stages yet counts 0 rounds (plan Review Focus 2)
      [1, 16],
      [6, 16],
      [7, 32],
      [8, 64],
      [9, 128],
      [10, 256],
      [11, null],
      [50, null],
    ];
    let checked = 0;
    for (const [rounds, want] of cases) {
      expect(sizeForRounds(rounds), `sizeForRounds(${rounds})`).toBe(want);
      checked += 1;
    }
    expect(checked, "round counts checked").toBe(9);
  });

  it("refuses a count that is not a count", () => {
    expect(() => sizeForRounds(Number.NaN)).toThrow(RangeError);
    expect(() => sizeForRounds(-1)).toThrow(RangeError);
  });
});

describe("sizeAllowedByPlan (P17)", () => {
  it("cap 96 allows 128 and refuses 256; cap 32 allows 32 and refuses 64; null allows 256", () => {
    expect(sizeAllowedByPlan(128, 96)).toBe(true);
    expect(sizeAllowedByPlan(256, 96)).toBe(false);
    expect(sizeAllowedByPlan(32, 32)).toBe(true);
    expect(sizeAllowedByPlan(64, 32)).toBe(false);
    expect(sizeAllowedByPlan(256, null)).toBe(true);
  });

  it("the whole matrix: every plan cap against every size (typed cap -> allowed sizes)", () => {
    // a cap that is a ladder value allows up to it; a cap between two values also allows the NEXT value up (the size pack's 96 may buy 128)
    const allowedByCap: [cap: number | null, allowed: OnlineSize[]][] = [
      [1, [16]],
      [15, [16]],
      [16, [16]],
      [17, [16, 32]],
      [32, [16, 32]],
      [33, [16, 32, 64]],
      [64, [16, 32, 64]],
      [96, [16, 32, 64, 128]],
      [128, [16, 32, 64, 128]],
      [129, [16, 32, 64, 128, 256]],
      [256, [16, 32, 64, 128, 256]],
      [300, [16, 32, 64, 128, 256]],
      [null, [16, 32, 64, 128, 256]],
    ];
    let checked = 0;
    for (const [cap, allowed] of allowedByCap) {
      for (const size of ONLINE_SIZES) {
        expect(sizeAllowedByPlan(size, cap), `cap ${cap}, size ${size}`).toBe(allowed.includes(size));
        checked += 1;
      }
    }
    expect(checked, "cap x size cells checked").toBe(allowedByCap.length * 5);
    expect(checked).toBe(65);
  });
});

describe("the stage kinds an online division may hold (decision 9, P16)", () => {
  /** stages_kind_check as the LATEST migration that (re)declares it spells it. Read from the SQL, not from any TypeScript. */
  function kindsInSchema(): { kinds: string[]; migration: string; scanned: number } {
    const found: { version: number; file: string; text: string }[] = [];
    let scanned = 0;
    for (const dir of readdirSync(join(REPO, "db", "migration"), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const f of readdirSync(join(REPO, "db", "migration", dir.name))) {
        const m = /^V(\d+)__.*\.sql$/.exec(f);
        if (!m) continue;
        scanned += 1;
        const text = readFileSync(join(REPO, "db", "migration", dir.name, f), "utf8");
        if (/add constraint stages_kind_check/i.test(text)) found.push({ version: Number(m[1]), file: f, text });
      }
    }
    expect(found.length, "migrations that declare stages_kind_check").toBeGreaterThan(0);
    found.sort((a, b) => b.version - a.version);
    const latest = found[0]!;
    const list = /add constraint stages_kind_check\s+check\s*\(\s*kind\s+in\s*\(([^)]*)\)/i.exec(latest.text);
    expect(list, `${latest.file}: the kind list parses`).not.toBeNull();
    const kinds = list![1]!
      .split(",")
      .map((k) => k.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);
    return { kinds, migration: latest.file, scanned };
  }

  it("every kind in stages_kind_check has a verdict: allowed, refused, or americano (already refused for chess)", () => {
    const { kinds, migration, scanned } = kindsInSchema();
    expect(scanned, "migration files scanned").toBeGreaterThan(100);
    expect(kinds.length, `${migration}: kinds read from the schema`).toBe(9);

    const verdicts = [...ONLINE_ALLOWED_STAGE_KINDS, ...ONLINE_REFUSED_STAGE_KINDS, "americano"];
    expect([...verdicts].sort()).toEqual([...kinds].sort());

    let checked = 0;
    for (const kind of kinds) {
      const hits = [
        ONLINE_ALLOWED_STAGE_KINDS.includes(kind),
        ONLINE_REFUSED_STAGE_KINDS.includes(kind),
        kind === "americano",
      ].filter(Boolean).length;
      expect(hits, `${kind} has exactly one verdict`).toBe(1);
      checked += 1;
    }
    expect(checked, "kinds judged").toBe(9);
  });

  it("allowed are swiss, knockout, double_elim, page_playoff, stepladder; refused are league, group, ladder (P16, typed from the spec)", () => {
    expect([...ONLINE_ALLOWED_STAGE_KINDS].sort()).toEqual(["double_elim", "knockout", "page_playoff", "stepladder", "swiss"]);
    expect([...ONLINE_REFUSED_STAGE_KINDS].sort()).toEqual(["group", "ladder", "league"]);
  });
});

describe("the error codes (plan Global Constraints, exactly)", () => {
  it("each of the 8 keys carries its code string", () => {
    const want: Record<string, string> = {
      noCredits: "ONLINE_CHESS_NO_CREDITS",
      unpaid: "ONLINE_CHESS_UNPAID",
      quoteChanged: "ONLINE_QUOTE_CHANGED",
      sizeFull: "ONLINE_SIZE_FULL",
      formatNotSupported: "ONLINE_FORMAT_NOT_SUPPORTED",
      roundsNeedSize: "ONLINE_ROUNDS_NEED_SIZE",
      roundsAboveMax: "ONLINE_ROUNDS_ABOVE_MAX",
      camerasNeedUpgrade: "ONLINE_CAMERAS_NEED_UPGRADE",
    };
    expect(Object.keys(ONLINE_PACKAGE_CODES).sort()).toEqual(Object.keys(want).sort());
    let checked = 0;
    for (const [key, code] of Object.entries(want)) {
      expect((ONLINE_PACKAGE_CODES as Record<string, string>)[key], key).toBe(code);
      checked += 1;
    }
    expect(checked, "codes checked").toBe(8);
  });

  it("no code reuses the stream ledger's no_credits (plan: never reuse it), and all eight are distinct", () => {
    const values: string[] = Object.values(ONLINE_PACKAGE_CODES);
    expect(values.length).toBe(8);
    expect(new Set(values).size).toBe(8);
    expect(values.every((v) => v !== "no_credits")).toBe(true);
  });
});

describe("ONLINE_SIZE_DOORS", () => {
  it("is a non-empty list of distinct door ids (Task 7 filled it; its door sweep counts against it: external-play/__tests__/online-entrant-cap.test.ts)", () => {
    expect(Array.isArray(ONLINE_SIZE_DOORS)).toBe(true);
    expect(ONLINE_SIZE_DOORS.length, "anti-vacuity: a sweep over nothing reports zero checked").toBeGreaterThan(0);
    expect(ONLINE_SIZE_DOORS.every((d) => typeof d === "string" && /^[a-z_]+$/.test(d))).toBe(true);
    expect(new Set(ONLINE_SIZE_DOORS).size).toBe(ONLINE_SIZE_DOORS.length);
  });
});
