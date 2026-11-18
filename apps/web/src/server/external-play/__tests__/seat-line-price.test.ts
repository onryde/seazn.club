// Check-in capacity plan 2, Task 7 (the line's stamped price) - the PURE half: the price table of owner ruling R1 (2026-11-17), the
// constants it is built from, and the removal of the constants it replaces. The table is HAND-DERIVED here from the vendor's own call
// counts (a room create, a participant add, a token, a read of one call with the proof flag or three without, the session probe that
// finds nobody) and the room's own schedule (CAMERA_EVIDENCE_MAX_POLLS + 1 reads), and is compared with what seat-line.ts says -
// never computed from it. The measured half (the fixture vendor's own request log, per stay kind and flag state) is
// usecases/__tests__/external-play-line-cost.test.ts; the stamp, the pool and the ETA through the real gate are
// external-play-line-price.test.ts.
//
// Single sport, deliberately: the price knows no sport (online play exists for `boardgame` only, guard.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAMERA_EVIDENCE_MAX_POLLS } from "@/components/public-site/match-room/room-snapshot";
import {
  LINE_CLAIM_COST,
  LINE_END_ROOM_CALLS,
  LINE_FALLBACK_READ_CALLS,
  LINE_MINT_PARTICIPANT_CALLS,
  LINE_MINT_ROOM_CALLS,
  LINE_READ_CALLS,
  LINE_RESERVATION_MAX,
  LINE_RESERVATION_MIN,
  LINE_SESSION_PROBE_CALLS,
  LINE_TOKEN_CALLS,
  lineCompletingLevel,
  lineFirstClaimCalls,
  lineRecheckCost,
  lineReservation,
} from "../seat-line";
import { lex, productionSources } from "./_video-source-scan";

const SRC = join(import.meta.dirname, "..", "..", "..");
const WEB = join(SRC, "..");

type Kind = "room" | "none" | "all";
const KINDS: readonly Kind[] = ["room", "none", "all"];

describe("the declared call counts are the ruling's (each is asserted equal to the fixture vendor's own count in the cost suite)", () => {
  it("the numbers", () => {
    expect(
      {
        mintRoom: LINE_MINT_ROOM_CALLS,
        mintParticipant: LINE_MINT_PARTICIPANT_CALLS,
        read: LINE_READ_CALLS,
        fallbackRead: LINE_FALLBACK_READ_CALLS,
        token: LINE_TOKEN_CALLS,
        probe: LINE_SESSION_PROBE_CALLS,
        endRoom: LINE_END_ROOM_CALLS,
        claim: LINE_CLAIM_COST,
      },
      "the table's inputs",
    ).toEqual({ mintRoom: 1, mintParticipant: 1, read: 1, fallbackRead: 3, token: 1, probe: 1, endRoom: 2, claim: 6 });
  });

  it("LINE_CLAIM_COST is the most ONE claim spends: two stale rooms ended, its own created, the participant added", () => {
    expect(LINE_CLAIM_COST).toBe(2 * LINE_END_ROOM_CALLS + LINE_MINT_ROOM_CALLS + LINE_MINT_PARTICIPANT_CALLS);
  });

  it("the room's schedule the table rests on: CAMERA_EVIDENCE_MAX_POLLS + 1 = 6 reads (five polls of a starting camera, then the verdict)", () => {
    expect(CAMERA_EVIDENCE_MAX_POLLS + 1).toBe(6);
  });
});

describe("the price table (owner ruling R1): a stay's first claim, then six reads, then the token handed with the verdict", () => {
  // Hand-derived. first claim: room = the participant add (1; its token comes with it); none = the token (1), plus - with the proof
  // flag OFF only - today's read finding no live session (1); all = the room create and the participant add (2).
  // stay = first claim + 6 reads x readCalls + the verdict's token (1).
  const TABLE: { kind: Kind; readCalls: number; first: number; price: number; why: string }[] = [
    { kind: "room", readCalls: 1, first: 1, price: 8, why: "1 + 6 x 1 + 1" },
    { kind: "room", readCalls: 3, first: 1, price: 20, why: "1 + 6 x 3 + 1" },
    { kind: "none", readCalls: 1, first: 1, price: 8, why: "1 + 6 x 1 + 1" },
    { kind: "none", readCalls: 3, first: 2, price: 21, why: "2 + 6 x 3 + 1" },
    { kind: "all", readCalls: 1, first: 2, price: 9, why: "2 + 6 x 1 + 1" },
    { kind: "all", readCalls: 3, first: 2, price: 21, why: "2 + 6 x 3 + 1" },
  ];

  it("lineFirstClaimCalls and lineReservation agree with the hand count in every cell (6 cells)", () => {
    let checked = 0;
    for (const c of TABLE) {
      expect(lineFirstClaimCalls(c.kind, c.readCalls), `${c.kind} @${c.readCalls} first claim`).toBe(c.first);
      expect(lineReservation(c.kind, c.readCalls), `${c.kind} @${c.readCalls}: ${c.why}`).toBe(c.price);
      checked += 1;
    }
    expect(checked, "cells checked").toBe(6);
    expect(new Set(TABLE.map((c) => `${c.kind}/${c.readCalls}`)).size, "every (kind, read price) cell is in the table").toBe(KINDS.length * 2);
  });

  it("the guards are reached: a stay mint or a read price the table does not know is a named refusal, never a silent price", () => {
    expect(() => lineFirstClaimCalls("bogus" as never, LINE_READ_CALLS)).toThrow(/unknown stay mint/);
    expect(() => lineReservation("none", 2)).toThrow(/prices a read at 1 or 3 calls, not 2/);
    for (const mint of KINDS) expect(() => lineReservation(mint, 0), `${mint}: every kind refuses an unpriced read`).toThrow(/prices a read at 1 or 3 calls, not 0/);
  });

  it("the least price is LINE_RESERVATION_MIN (8) and the greatest LINE_RESERVATION_MAX (21, the price of a stay the gate has not priced)", () => {
    const prices = TABLE.map((c) => lineReservation(c.kind, c.readCalls));
    expect(LINE_RESERVATION_MIN).toBe(8);
    expect(LINE_RESERVATION_MAX).toBe(21);
    expect(Math.min(...prices), "the least of the six is the minimum").toBe(LINE_RESERVATION_MIN);
    expect(Math.max(...prices), "the greatest of the six is the maximum").toBe(LINE_RESERVATION_MAX);
    expect(prices.length, "anti-vacuity").toBe(6);
  });

  it("one claim never spends more than the least price (so no reservation is smaller than the claim that makes it)", () => {
    expect(LINE_CLAIM_COST).toBeLessThanOrEqual(LINE_RESERVATION_MIN);
  });

  it("the re-verify is ONE read with the proof flag and three without; the completing level adds the claim's own read and token above it", () => {
    expect([lineRecheckCost(LINE_READ_CALLS), lineRecheckCost(LINE_FALLBACK_READ_CALLS)]).toEqual([1, 3]);
    // The seating claim's own read and token, THEN the re-verify the seat's create makes: 1 + 1 + 1 and 3 + 1 + 3.
    expect([lineCompletingLevel(LINE_READ_CALLS), lineCompletingLevel(LINE_FALLBACK_READ_CALLS)]).toEqual([3, 7]);
    for (const r of [LINE_READ_CALLS, LINE_FALLBACK_READ_CALLS]) {
      // The defect the old level's doc comment records (a level of the recheck cost ALONE created one board 268.7 s late) must not return.
      expect(lineCompletingLevel(r), `readCalls ${r}: above the recheck cost alone`).toBeGreaterThan(lineRecheckCost(r));
    }
  });
});

describe("the price is DERIVED, never typed: the declarations are built from the counts", () => {
  const src = readFileSync(join(SRC, "server/external-play/seat-line.ts"), "utf8");
  const code = lex(src).live;
  /** `a + (b + c) + d` as its top-level terms: a `+` inside parentheses does not split. */
  const topTerms = (expr: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of expr) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "+" && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  /** The terms of `export function <name>(...): number { return a + b + c; }`, sorted. */
  const terms = (name: string): string[] => {
    const m = new RegExp(`export function ${name}\\([^)]*\\)[^{]*\\{\\s*return ([^;]+);`).exec(code);
    expect(m, `${name} is a one-return function`).not.toBeNull();
    return topTerms(m![1]!).sort();
  };

  it("the term splitter keeps a parenthesised sum whole (the scan can fail)", () => {
    expect(topTerms("a + b * (c + 1) + f(x, y)")).toEqual(["a", "b * (c + 1)", "f(x, y)"]);
  });

  it("lineCompletingLevel = readCalls + LINE_TOKEN_CALLS + lineRecheckCost(readCalls); lineRecheckCost = readCalls", () => {
    expect(terms("lineCompletingLevel")).toEqual(["LINE_TOKEN_CALLS", "lineRecheckCost(readCalls)", "readCalls"]);
    expect(terms("lineRecheckCost")).toEqual(["readCalls"]);
  });

  it("lineReservation = lineFirstClaimCalls(...) + readCalls x (polls + 1) + LINE_TOKEN_CALLS", () => {
    const t = terms("lineReservation");
    expect(t).toHaveLength(3);
    expect(t).toContain("LINE_TOKEN_CALLS");
    expect(t).toContain("lineFirstClaimCalls(mint, readCalls)");
    expect(t).toContain("readCalls * (CAMERA_EVIDENCE_MAX_POLLS + 1)");
  });

  it("the minimum and the maximum are read off the table, not typed", () => {
    expect(code).toMatch(/export const LINE_RESERVATION_MIN\s*=\s*lineReservation\("none",\s*LINE_READ_CALLS\)/);
    expect(code).toMatch(/export const LINE_RESERVATION_MAX\s*=\s*lineReservation\("all",\s*LINE_FALLBACK_READ_CALLS\)/);
  });
});

describe("the constants the stamped price replaces are gone, nowhere re-declared or read", () => {
  const REMOVED = ["LINE_RESERVATION", "LINE_RECHECK_COST", "LINE_COMPLETING_LEVEL", "LINE_MINT_CALLS"];
  const mention = (text: string, name: string) => new RegExp(`\\b${name}\\b`).test(text);

  it("a planted mention is found, a derived name that merely starts with one is not (the scan can fail)", () => {
    expect(mention("const x = LINE_RESERVATION + 1;", "LINE_RESERVATION")).toBe(true);
    expect(mention("const x = LINE_RESERVATION_MAX + 1;", "LINE_RESERVATION")).toBe(false);
    expect(mention("import { LINE_MINT_CALLS } from 'x'", "LINE_MINT_CALLS")).toBe(true);
  });

  // Comments removed the way the one-reader guard does it (a whole-tree lexer pass would trip on a regex literal somewhere in 500 files).
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\w])\/\/[^\n]*/g, "$1");

  it("no production file (comments aside) and neither load-harness file names any of them (production files scanned reported)", () => {
    const files = productionSources(SRC);
    expect(files.length, "anti-vacuity: production files scanned").toBeGreaterThan(500);
    const offenders: string[] = [];
    for (const f of files) {
      const live = code(readFileSync(join(SRC, f), "utf8"));
      for (const name of REMOVED) if (mention(live, name)) offenders.push(`${f}: ${name}`);
    }
    // The load harness lives beside the specs, outside `src`; it copies the line's numbers (line-load.ts) and words its bars by name.
    const harness = ["e2e/load/line-load.ts", "e2e/load/chess-30-boards.load.ts"];
    for (const f of harness) {
      const text = readFileSync(join(WEB, f), "utf8");
      expect(text.length, `${f} was read`).toBeGreaterThan(1_000);
      for (const name of REMOVED) if (mention(code(text), name)) offenders.push(`${f}: ${name}`);
    }
    expect(offenders).toEqual([]);
  });
});
