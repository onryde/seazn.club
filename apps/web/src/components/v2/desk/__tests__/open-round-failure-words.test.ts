// `openFailureWords` (components/v2/desk/open-round-control.tsx): the round's OWN words for a refused open, keyed by the code the door answers. One authority for the run sheet's
// notice (`openNoticeText`) and the Match Day pay-and-open receipt (spec 2026-11-23-online-chess-credits-design.md §8.5: a round refusal is the round's reason, never a
// payment sentence). The codes are the producers' own constants; the expected sentences are the dictionary's keys the existing notice tests already pin.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { ONLINE_CHESS_DISABLED_CODE } from "@/lib/online-chess";
import { BILLING_FROZEN_CODE } from "@/lib/open-round";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { openFailureWords, openNoticeText } from "../open-round-control";

const EN = en as Record<string, string>;
const msg = ((k: string) => EN[k] ?? `MISSING:${k}`) as never;
const plural = (() => "") as never;
const VIEW = { roundNo: 1, pairings: [] } as never;

describe("openFailureWords: the round's reason for each code the open door refuses with", () => {
  const NAMED: [string, string][] = [
    [BILLING_FROZEN_CODE, "runsheet.round.err.frozen"],
    [ONLINE_CHESS_DISABLED_CODE, "runsheet.round.err.disabled"],
    ["ROUND_CHANGED", "runsheet.round.err.roundChanged"],
    ["ROUND_NOT_ONLINE", "runsheet.round.err.notOnline"],
  ];

  it("each named code is its own sentence (409 changed, 402 frozen, 403 off, 422 not online)", () => {
    let checked = 0;
    for (const [code, key] of NAMED) {
      expect(openFailureWords(code, msg), code).toBe(EN[key]);
      expect(EN[key], `premise: ${key} is a real sentence`).toBeTruthy();
      checked += 1;
    }
    expect(checked).toBe(4);
    expect(new Set(NAMED.map(([, k]) => EN[k])).size, "four different sentences").toBe(4);
  });

  it("a code the round does not name is null - the caller keeps its own generic or unknown wording (UNKNOWN, a 500, a package code, nothing)", () => {
    for (const code of ["UNKNOWN", "INTERNAL", ONLINE_PACKAGE_CODES.unpaid, ONLINE_PACKAGE_CODES.noCredits, ONLINE_PACKAGE_CODES.quoteChanged, ""]) {
      expect(openFailureWords(code, msg), JSON.stringify(code)).toBeNull();
    }
  });

  it("the run sheet's notice says exactly these words for a named code and its generic line for any other: one authority, not two copies", () => {
    for (const [code] of NAMED) {
      expect(openNoticeText({ kind: "failed", code }, VIEW, msg, plural), code).toEqual([openFailureWords(code, msg)]);
    }
    expect(openNoticeText({ kind: "failed", code: "INTERNAL" }, VIEW, msg, plural)).toEqual([EN["runsheet.round.err.failed"]]);
  });
});
