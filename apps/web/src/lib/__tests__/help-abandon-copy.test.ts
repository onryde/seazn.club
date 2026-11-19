// Truth-in-copy guard for the "If a match is abandoned" section of the scoring-basics help page and the pointer to it from
// "Knockout deciders" (W2c Task 7, fix round 1). The page makes claims about which stages hold an abandon, which sports
// can share the points, and what the controls are called; each is read out of the product (the engine's kind sets and
// abandon options, the editor's labels, the English dictionary) and not retyped, so a change there moves this test.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/ui.json";
import { ABANDON_LABELS } from "@/lib/match-rules/shared";
import { GENERIC_RULES } from "@/lib/match-rules/generic";
import { CARROM_RULES } from "@/lib/match-rules/carrom";

const helpFile = (rel: string) => readFileSync(join(process.cwd(), "content/help/scoring", rel), "utf8");
const BASICS = helpFile("basics.md");
const DECIDERS = helpFile("knockout-deciders.md");

/** The section, from its heading to the next `## `. */
const sectionOf = (md: string, heading: string): string => {
  const start = md.indexOf(`## ${heading}`);
  expect(start, `the page has a "${heading}" section`).toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + heading.length + 3);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
};
const SECTION = sectionOf(BASICS, "If a match is abandoned");
const dict = en as Record<string, string>;

// How the page names each stage kind. Keyed by EVERY kind, so a kind added to the engine fails here until the page is
// updated and the name is added.
const KIND_NAME: Record<(typeof StageKind.options)[number], string> = {
  knockout: "Knockout",
  double_elim: "double elimination",
  page_playoff: "page playoff",
  stepladder: "stepladder",
  ladder: "ladder",
  league: "League",
  group: "group",
  swiss: "Swiss",
  americano: "americano",
};

describe("help: if a match is abandoned", () => {
  it("the section exists, and the knockout page points at its anchor", () => {
    expect(SECTION.length).toBeGreaterThan(200);
    expect(DECIDERS).toContain("(/help/scoring/basics#if-a-match-is-abandoned)");
  });

  it("every stage kind is named, bracket kinds in the held bullet and table kinds in the other (counted)", () => {
    expect(Object.keys(KIND_NAME).sort()).toEqual([...StageKind.options].sort());
    const [bracketBullet, tableBullet] = SECTION.split("\n").filter((l) => l.startsWith("- **") && /\*\*:?\*\*|:\*\*/.test(l) && /Knockout|League/.test(l.slice(0, 80)));
    expect(bracketBullet, "a bullet for the bracket kinds").toBeTruthy();
    expect(tableBullet, "a bullet for the table kinds").toBeTruthy();
    const head = (b: string) => b.slice(0, b.indexOf(":**") + 3);
    let checked = 0;
    for (const kind of StageKind.options) {
      const inBracket = head(bracketBullet!).toLowerCase().includes(KIND_NAME[kind].toLowerCase());
      const inTable = head(tableBullet!).toLowerCase().includes(KIND_NAME[kind].toLowerCase());
      expect(inBracket, `${kind} in the bracket bullet`).toBe(BRACKET_KINDS.has(kind));
      expect(inTable, `${kind} in the table bullet`).toBe(DRAW_KINDS.has(kind));
      checked++;
    }
    expect(checked).toBe(BRACKET_KINDS.size + DRAW_KINDS.size);
  });

  it("the policies and the sports that offer each are the engine's, under the editor's own labels (every row counted)", () => {
    // Page name for each sport that declares abandon options. A sport the engine adds to the list fails here until the page
    // table names it and this map does.
    const PAGE_NAME: Record<string, string> = { football: "football", hockey: "field hockey", icehockey: "ice hockey", carrom: "carrom", generic: "generic" };
    const declaring = builtinModules.filter((m) => (m.abandonOptions ?? []).length > 0).map((m) => m.key).sort();
    expect(declaring, "the sports that declare an abandon option").toEqual(Object.keys(PAGE_NAME).sort());
    const rows = SECTION.split("\n").filter((l) => l.startsWith("| **")).map((l) => l.split("|").map((c) => c.trim()));
    let checked = 0;
    for (const policy of ["replay", "award", "q4_stands", "share"] as const) {
      const row = rows.find((r) => r[1] === `**${ABANDON_LABELS[policy]}**`);
      expect(row, `a table row for ${policy} under the editor's label`).toBeDefined();
      const offered = builtinModules.filter((m) => m.abandonOptions?.includes(policy)).map((m) => PAGE_NAME[m.key]!).sort();
      expect(offered.length, `at least one sport offers ${policy}`).toBeGreaterThan(0);
      const onPage = row![3]!.split(",").map((x) => x.trim()).sort();
      expect(onPage, `the sports the page lists for ${policy}`).toEqual(offered);
      checked++;
    }
    expect(checked, "four policies checked").toBe(4);
    const sharers = builtinModules.filter((m) => m.abandonOptions?.includes("share")).map((m) => m.key).sort();
    expect(sharers, "share is carrom and generic").toEqual(["carrom", "generic"]);
    const label = (rules: readonly { label: string }[], key: string) => (rules as { key: string; label: string }[]).find((r) => r.key === key)!.label;
    expect(SECTION).toContain(`**${label(GENERIC_RULES, "abandon")}**`);
    expect(SECTION).toContain(`**${label(GENERIC_RULES, "allowDraws")}**`);
    expect(SECTION).toContain(`**${label(CARROM_RULES, "tieBoard")}**`);
    const carromDraw = (CARROM_RULES as { key: string; options?: { value: string; label: string }[] }[]).find((r) => r.key === "tieBoard")!.options!.find((o) => o.value === "draw")!;
    expect(carromDraw.label.startsWith("Drawn game")).toBe(true);
    expect(SECTION).toContain("**Drawn game**");
  });

  it("the controls it names are the product's own words", () => {
    expect(SECTION).toContain(`**${dict["score.needsDecision.settle"]}**`);
    expect(SECTION).toContain(`**${dict["score.needsDecision.title"]}**`);
    expect(SECTION).toContain(`**${dict["score.voidLast"]!.replace(/^\S+\s/, "")}**`);
    expect(SECTION).toContain("**Abandon**");
    expect(dict["score.abandon"]!.startsWith("Abandon"), "the page calls the button by its first word").toBe(true);
  });

  it("the knockout page no longer claims every decider is marked 'Knockout fixtures only', nor that an abandon advances the bracket", () => {
    expect(DECIDERS).not.toContain("All three are marked");
    expect(DECIDERS).not.toContain("record an outcome the bracket can advance from");
  });
});
