// Truth-in-copy for the help section on extending a board's check-in (scoring/boardgame.md, "Online chess: adding time to check-in").
// The prose says the step is "five minutes", that a board takes it "up to three times", that it works only while check-in is open,
// and it quotes the panel's own reasons word for word. Each of those is a claim about code that moves: the step and the cap are
// constants (lib/checkin-extend.ts, the owner's 2026-10-19 values), and the quoted reasons are dictionary strings. Nothing else
// pinned the page to them, so a retuned step or a reworded reason would leave the page wrong behind a green suite.
//
// The numbers are SPELLED in the prose, so the expected words come from a number-word table keyed by the constant - never typed
// beside the claim. A value the table lacks fails the test and says so (it must be extended on purpose), so a step of 7 cannot
// slip past as "no claim found".
// Single-sport reason: the article is the chess page; no other sport has a check-in.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MINUTES, EXTEND_WHY_KEYS } from "@/lib/checkin-extend";
import { helpArticleBySlug } from "./_help-copy";

const WORDS: Record<number, string> = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
const EN = en as Record<string, string>;
const SLUG = "scoring/boardgame";

/** The section, from its heading to the next one. */
function section(): string {
  const md = helpArticleBySlug(SLUG);
  const start = md.indexOf("## Online chess: adding time to check-in");
  expect(start, "the section exists").toBeGreaterThan(-1);
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next === -1 ? undefined : next);
}

describe("help: extending a board's check-in", () => {
  it("the step and the cap it names are the constants' (spelled), and no other count of minutes or times is claimed", () => {
    const s = section();
    const step = WORDS[CHECKIN_EXTEND_STEP_MINUTES];
    const max = WORDS[CHECKIN_EXTEND_MAX];
    expect(step, "the number-word table covers the step").toBeTruthy();
    expect(max, "the number-word table covers the cap").toBeTruthy();
    expect(s).toContain(`adds ${step} minutes to that board's check-in`);
    expect(s).toContain(`up to ${max} times`);
    const minutes = [...s.matchAll(/\b(\w+) minutes\b/g)].map((m) => m[1]!.toLowerCase());
    expect(minutes.length, "anti-vacuity: the minutes claimed").toBeGreaterThanOrEqual(1);
    expect(new Set(minutes), "every count of minutes is the step").toEqual(new Set([step]));
  });

  it("the reasons it quotes are the panel's own words, and the buttons it names are the panel's labels", () => {
    const s = section();
    const worded = Object.entries(EXTEND_WHY_KEYS).filter(([, key]) => key !== null);
    let quoted = 0;
    for (const [refusal, key] of worded) {
      const words = EN[key!]!;
      // The page quotes the three the panel shows around a closed or unopened window; the others it names by their words.
      if (["not_open", "closed", "cap_reached"].includes(refusal)) {
        expect(s, `${refusal}: "${words}"`).toContain(words);
        quoted += 1;
      }
    }
    expect(quoted, "anti-vacuity: three reasons quoted").toBe(3);
    expect(s).toContain(`**+${CHECKIN_EXTEND_STEP_MINUTES} min**`);
    expect(s).toContain(`**+${CHECKIN_EXTEND_STEP_MINUTES} min to the round**`);
    expect(EN["externalPlay.checkinExtend.round"], "premise: the round button is '+N min to the round'").toBe(`+{minutes} min to the round`);
    expect(EN["externalPlay.checkinExtend.board"], "premise: the board button starts '+N min'").toMatch(/^\+\{minutes\} min/);
  });

  it("the rules it states: only while check-in is open, the round button skips what it should, every use is logged", () => {
    const s = section().replace(/\s+/g, " ");
    expect(s).toContain("only while check-in is open");
    expect(s).toMatch(/skips\*\* boards whose check-in has not opened yet or has already closed/);
    expect(s).toContain("boards whose game has started");
    expect(s).toContain("boards with no extensions left");
    expect(s).toContain("Every use is logged");
    expect(s).toContain("the check-in countdown on their board updates");
  });
});
