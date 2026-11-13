// The account list's memory (quick match plan 3 Task 6, review m1 and m2): what the /me island knows past the page's read.
// The island itself needs a browser to click (its focus and its live region are the e2e's: e2e/quick-match.spec.ts and the
// walkthrough's (D)); what it SHOWS after each answer is this pure step, driven here through every event and its sequence.
//
// - A rename lays the new name over the row until the page's next read, which then wins (m1: the overrides reset when the
//   read changes, so a later rename elsewhere is never hidden behind this browser's old one).
// - A delete drops the row and says so in the list's live region (m2).
// - A refusal that the match is no longer in the account (NOT_IN_ACCOUNT: another tab deleted it, or it expired) drops the row
//   too and says THAT (m1), rather than leaving a row whose every control answers 404.
// - The empty case first: no read and no memory shows nothing and says nothing.
//
// Expected values are typed from the rules above, never read from the island. Sport: none (the list reads no sport).
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { plural } from "@/lib/i18n-runtime";
import { freshMemory, metaLine, onRead, remember, shownOf, type MyQuickMatchItem } from "../my-list";

const row = (id: string, name: string): MyQuickMatchItem => ({
  id,
  name,
  token: `qm_${id}`,
  format: "league",
  played: 0,
  notPlayed: 0,
  total: 1,
});
const A = row("a", "Sunday league");
const B = row("b", "Club cup");
const C = row("c", "Rematch");
const names = (items: readonly MyQuickMatchItem[]) => items.map((i) => [i.id, i.name]);

describe("the /me list's memory (review m1, m2)", () => {
  it("the empty case first: no rows read and nothing remembered shows nothing and says nothing", () => {
    const m = freshMemory([]);
    expect(shownOf([], m)).toEqual([]);
    expect(m.notice).toBeNull();
  });

  it("a rename lays the new name over its row only, keeps its link and its line; a second rename wins", () => {
    let m = freshMemory([A, B]);
    m = remember(m, { kind: "renamed", id: "a", name: "Sunday league II" });
    expect(names(shownOf([A, B], m))).toEqual([
      ["a", "Sunday league II"],
      ["b", "Club cup"],
    ]);
    expect(shownOf([A, B], m)[0]).toMatchObject({ token: "qm_a", format: "league", played: 0, total: 1 });
    m = remember(m, { kind: "renamed", id: "a", name: "Sunday league III" });
    expect(names(shownOf([A, B], m))[0]).toEqual(["a", "Sunday league III"]);
    expect(m.notice, "a rename says nothing in the live region: the row shows it").toBeNull();
  });

  it("a delete drops its row, keeps the others in their order, and says which was deleted, by the name shown", () => {
    let m = freshMemory([A, B, C]);
    m = remember(m, { kind: "renamed", id: "b", name: "Club cup final" });
    m = remember(m, { kind: "deleted", id: "b", name: "Club cup final" });
    expect(names(shownOf([A, B, C], m))).toEqual([
      ["a", "Sunday league"],
      ["c", "Rematch"],
    ]);
    expect(m.notice).toEqual({ key: "quickMatch.me.deleted", name: "Club cup final" });
  });

  it("the last row deleted: nothing left to show, and the live region still says what happened", () => {
    let m = freshMemory([A]);
    m = remember(m, { kind: "deleted", id: "a", name: "Sunday league" });
    expect(shownOf([A], m)).toEqual([]);
    expect(m.notice).toEqual({ key: "quickMatch.me.deleted", name: "Sunday league" });
  });

  it("m1: NOT_IN_ACCOUNT drops the row (another tab deleted it, or it expired) and says it is no longer in the account", () => {
    let m = freshMemory([A, B]);
    m = remember(m, { kind: "gone", id: "a", name: "Sunday league" });
    expect(names(shownOf([A, B], m))).toEqual([["b", "Club cup"]]);
    expect(m.notice).toEqual({ key: "quickMatch.me.notInAccount", name: "Sunday league" });
  });

  it("m1: a new read from the page clears the renames (the read's name wins), keeps what is gone and what was said", () => {
    let m = freshMemory([A, B]);
    m = remember(m, { kind: "renamed", id: "a", name: "Mine" });
    m = remember(m, { kind: "deleted", id: "b", name: "Club cup" });
    // The page's next read: the match was renamed again elsewhere ("Theirs"), and the deleted one is still in this stale read.
    const read = [{ ...A, name: "Theirs" }, B];
    m = onRead(m, read);
    expect(names(shownOf(read, m)), "the read's name, not this browser's older one; the deleted row stays gone").toEqual([["a", "Theirs"]]);
    expect(m.notice).toEqual({ key: "quickMatch.me.deleted", name: "Club cup" });
    expect(m.read).toBe(read);
  });

  it("each line the live region says is in all four languages, and names the match where it says a name", () => {
    let checked = 0;
    for (const dict of [en, es, fr, nl] as Record<string, string>[]) {
      expect(dict["quickMatch.me.deleted"]).toContain("{name}");
      expect(typeof dict["quickMatch.me.notInAccount"]).toBe("string");
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// The row's line under its name (plan 4 Task 4, spec 2026-11-12 §6): the format, then the home's played line with no
// countdown, and with a Not played match "· K not played", the full total kept. Expected lines are typed from the spec.
describe("the /me row's line (plan 4 Task 4)", () => {
  const en_ = en as Record<string, string>;
  const t = (key: string) => en_[key] ?? key;
  const p = (key: string, count: number, vars?: Record<string, string | number>) => plural(en_, key, count, "en", vars);
  const item = (over: Partial<MyQuickMatchItem>): MyQuickMatchItem => ({ ...row("x", "X"), ...over });

  it("the empty case first: nothing played, nothing skipped, says no Not played part", () => {
    expect(metaLine(item({ played: 0, notPlayed: 0, total: 6 }), t, p)).toBe("League · 0 of 6 matches played");
  });

  it("with one skipped: the full total and how many were not played", () => {
    expect(metaLine(item({ played: 2, notPlayed: 1, total: 6 }), t, p)).toBe("League · 2 of 6 matches played · 1 not played");
  });

  it("after a Put back (the count back to 0) the part goes away; a knockout says its own format", () => {
    expect(metaLine(item({ played: 2, notPlayed: 0, total: 6 }), t, p)).toBe("League · 2 of 6 matches played");
    expect(metaLine(item({ format: "knockout", played: 1, notPlayed: 0, total: 1 }), t, p)).toBe("Knockout · 1 of 1 match played");
  });

  it("every line has its keys in all four languages, the Not played part a {count} plural", () => {
    let checked = 0;
    for (const dict of [en, es, fr, nl] as Record<string, string>[]) {
      for (const key of ["quickMatch.home.playedSkippedSaved", "quickMatch.home.notPlayedPart", "quickMatch.home.playedSaved"]) {
        expect(dict[`${key}.other`], `${key}.other`).toBeTypeOf("string");
        checked++;
      }
      expect(dict["quickMatch.home.notPlayedPart.other"]).toContain("{count}");
      expect(dict["quickMatch.home.playedSkippedSaved.other"]).toContain("{skipped}");
    }
    expect(checked).toBe(12);
  });
});
