// What the round's notice says about a payment (Online Chess credits, spec 2026-11-23-online-chess-credits-design.md §7.6, §8.4; plan Task 12):
// `openNoticeText` words the open's answer, and a "Paid N credits" line is a claim about money - so it is said ONLY when the server's own
// `payment.applied` says this press took (or gave back) something. Owner ruling 1: no "paid" text unless `payment.applied`.
//
// The result shapes are the server's (`OpenRoundResult`, lib/open-round.ts); the words are the English dictionary's, never retyped here; the credit
// figure is the one the result carries (a different number from the round and the size, so a swapped variable shows).
// Anti-vacuity: every sweep reports its count.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { OPEN_ROUND_INVITED_KEY, type OpenRoundPayment, type OpenRoundResult, type OpenRoundView } from "@/lib/open-round";
import { emptyExtendTally } from "@/lib/checkin-extend";
import { openNoticeText } from "../open-round-control";

const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", locale, "ui.json"), "utf8")) as Dict;
const EN = load("en");
const msgIn = (d: Dict) => (key: string, vars?: Record<string, string | number>) => tRuntime(d, key, vars);
const pluralIn = (d: Dict, locale: "en" | "es" | "fr" | "nl") => (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(d, key, count, locale, vars);
const en = EN as unknown as Record<string, string>;

const VIEW = (roundNo: number): OpenRoundView => ({
  stageId: "s1", stageName: "Swiss", roundNo, state: "paired", openedAt: null, deadlineAt: null, windowMinutes: 10, staggered: false, batches: [],
  staggerSpanMinutes: 0, scheduledAt: null, press: "open", earlierInPlay: [], pairings: [], extendableBoards: 0, extendWindows: [], extendRefusals: emptyExtendTally(),
});
const opened = (payment: OpenRoundPayment | null): OpenRoundResult => ({ opened: true, invited: 6, retrying: 0, skipped: [], payment });
const lines = (result: OpenRoundResult, roundNo = 1, d: Dict = EN, locale: "en" | "es" | "fr" | "nl" = "en") =>
  openNoticeText({ kind: "answered", result }, VIEW(roundNo), msgIn(d) as never, pluralIn(d, locale) as never);

describe("the round's notice names a payment only when the server says one was applied", () => {
  it("applied, credits taken: 'Paid N credits. Round R is open.' first, then the invites; one credit reads 'credit'", () => {
    const paid = lines(opened({ applied: true, credits: 4, size: 64, capacityLoweredTo: null }), 1);
    expect(paid[0]).toBe(en["onlineChess.openRound.paid.other"]!.replace("{count}", "4").replace("{round}", "1"));
    expect(paid[0]).toBe("Paid 4 credits. Round 1 is open.");
    expect(paid.length, "then the open's own invite line").toBe(2);
    expect(lines(opened({ applied: true, credits: 1, size: 16, capacityLoweredTo: null }))[0]).toBe("Paid 1 credit. Round 1 is open.");
  });

  it("applied with no credits taken (a move that cost nothing): the size line, never 'Paid 0 credits'", () => {
    const moved = lines(opened({ applied: true, credits: 0, size: 32, capacityLoweredTo: null }), 1);
    expect(moved[0]).toBe("Online Chess is now up to 32 players. Round 1 is open.");
    expect(moved.join(" ")).not.toMatch(/Paid/);
    const back = lines(opened({ applied: true, credits: -2, size: 32, capacityLoweredTo: null }), 3);
    expect(back[0], "a move down gives credits back: no 'paid' line, the new size").toBe("Online Chess is now up to 32 players. Round 3 is open.");
  });

  it("NOT applied (the package was frozen or already at that size): no payment line at all - the credits are 0 but the receipt confirmed more", () => {
    let checked = 0;
    for (const credits of [0, 4]) {
      const out = lines(opened({ applied: false, credits, size: 64, capacityLoweredTo: null }));
      expect(out.join(" "), `credits ${credits}`).not.toMatch(/Paid|up to 64/);
      expect(out.length, "only the open's own invite line").toBe(1);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("no pay was sent (payment null): the plain open's lines, unchanged", () => {
    const out = lines(opened(null));
    expect(out.length).toBe(1);
    expect(out[0]).toBe(en[`${OPEN_ROUND_INVITED_KEY}.other`]!.replace("{count}", "6"));
  });

  it("a payment that lowered the registration capacity says so, after the paid line", () => {
    const out = lines(opened({ applied: true, credits: 2, size: 32, capacityLoweredTo: 32 }), 1);
    expect(out[0]).toBe("Paid 2 credits. Round 1 is open.");
    expect(out[1]).toBe("Registration is now limited to 32 players.");
    expect(lines(opened({ applied: true, credits: 2, size: 32, capacityLoweredTo: null })).join(" ")).not.toMatch(/limited/);
  });

  it("a payment on a round that did NOT open says nothing about money: the round's own reason stands alone", () => {
    const refused: OpenRoundResult = { opened: false, reason: "not_paired" };
    const out = lines(refused);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/Paid/);
    const already: OpenRoundResult = { opened: false, reason: "already_open", skipped: [] };
    expect(lines(already).join(" ")).not.toMatch(/Paid/);
  });

  it("is said in every language, with the round and the figure in place (sweep)", () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const d = load(locale);
      const out = lines(opened({ applied: true, credits: 7, size: 128, capacityLoweredTo: 64 }), 5, d, locale);
      expect(out[0], `${locale}: paid`).toMatch(/7/);
      expect(out[0], `${locale}: round`).toMatch(/5/);
      expect(out[0], `${locale}: no raw placeholder`).not.toMatch(/\{/);
      expect(out[1], `${locale}: capacity`).toMatch(/64/);
      const moved = lines(opened({ applied: true, credits: 0, size: 128, capacityLoweredTo: null }), 5, d, locale)[0]!;
      expect(moved, `${locale}: moved`).toMatch(/128/);
      expect(moved).toMatch(/5/);
      if (locale !== "en") expect(out[0], `${locale}: translated`).not.toBe(lines(opened({ applied: true, credits: 7, size: 128, capacityLoweredTo: 64 }), 5)[0]);
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});
