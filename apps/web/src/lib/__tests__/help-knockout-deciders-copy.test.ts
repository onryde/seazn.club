// Truth-in-copy guard for the sport table on `content/help/scoring/knockout-deciders.md` (Task 9 fix round 1). The page
// says, per sport, which deciders a knockout has, under which Match rules labels, and which sports have none. Every row is
// derived from the engine's own declarations across ALL variants of ALL sports (`deciderKeysFor`, `bracketMayEndLevel`,
// `stageDefaultsFor`) and the editor's own labels (`rulesFor`), never typed here. It would have caught the four false rows
// the first draft shipped: cricket super over for every variant, carrom's tie-board offered in a knockout, ice hockey under
// invented labels, and "no decider where a stage can end level" against a league shoot-out the engine declares.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bracketMayEndLevel, deciderKeysFor, stageDefaultsFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { rulesFor } from "@/lib/match-rules";

const PAGE = readFileSync(join(process.cwd(), "content/help/scoring/knockout-deciders.md"), "utf8");
const ROWS = PAGE.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Sport") && !l.startsWith("|---"));

/** The page row that names each sport. Keyed by EVERY engine module, so a sport added to the engine fails here until the
 *  page has a row and this map names it. */
const ROW_NAME: Record<string, string> = {
  football: "Football",
  cricket: "Cricket",
  hockey: "Field hockey",
  icehockey: "Ice hockey",
  boardgame: "Chess and other board games",
  carrom: "Carrom",
  generic: "Generic scoring",
  tennis: "Tennis, badminton, table tennis, volleyball",
  badminton: "Tennis, badminton, table tennis, volleyball",
  tabletennis: "Tennis, badminton, table tennis, volleyball",
  volleyball: "Tennis, badminton, table tennis, volleyball",
};
const rowFor = (sport: string): string => {
  const name = ROW_NAME[sport];
  expect(name, `the page has a row name for ${sport}`).toBeDefined();
  const row = ROWS.find((r) => r.startsWith(`| ${name} |`));
  expect(row, `a table row for ${sport} ("${name}")`).toBeDefined();
  return row!;
};
const labelOf = (sport: string, key: string): string => {
  const f = rulesFor(sport).find((r) => r.key === key);
  expect(f, `${sport} has a Match rules field ${key}`).toBeDefined();
  return f!.label;
};

describe("help: knockout deciders table is the engine's, for every variant of every sport", () => {
  it("every row of every variant matches: deciders under their labels, held, forced extra board, or none (counted)", () => {
    const total = builtinModules.reduce((n, m) => n + Object.keys(m.variants).length, 0);
    let checked = 0;
    const seen = { decider: 0, held: 0, forced: 0, none: 0 };
    for (const m of builtinModules) {
      for (const v of Object.keys(m.variants)) {
        const cfg = m.configSchema.parse({ ...m.variants[v] });
        const ko = deciderKeysFor(m, "knockout", v);
        const league = deciderKeysFor(m, "league", v);
        const mayEndLevel = bracketMayEndLevel(m, "knockout", cfg);
        const row = rowFor(m.key);
        const at = `${m.key}/${v}`;
        if (ko.length > 0) {
          for (const k of ko) expect(row, `${at}: row names **${labelOf(m.key, k)}**`).toContain(`**${labelOf(m.key, k)}**`);
          // A knockout stage starts with these on (the page says so): the engine either writes them into the stage's defaults
          // or lays them over every bracket itself (`bracketDeciders`, chess), so a level match can never end level there.
          expect(
            Object.keys(stageDefaultsFor(m, "knockout", v)).length > 0 || !mayEndLevel,
            `${at}: a new knockout stage turns its deciders on`,
          ).toBe(true);
          seen.decider++;
        } else if (mayEndLevel) {
          expect(row, `${at}: a level knockout match is held`).toMatch(/\bheld\b/);
          seen.held++;
        } else if (league.length > 0) {
          // The bracket forces the decider (carrom's extra board): the setting is a table-stage one.
          for (const k of league) expect(row, `${at}: row names the table-only **${labelOf(m.key, k)}**`).toContain(`**${labelOf(m.key, k)}**`);
          expect(row, `${at}: row says the extra board is always played`).toMatch(/always played/);
          seen.forced++;
        } else {
          expect(row, `${at}: row says there is no decider`).toMatch(/\bNone\b/);
          seen.none++;
        }
        // The page says a league or group stage does not turn deciders on by itself.
        expect(stageDefaultsFor(m, "league", v), `${at}: a new league stage has no deciders switched on`).toEqual({});
        checked++;
      }
    }
    expect(total, "the engine's variant count").toBeGreaterThan(0);
    expect(checked, "every variant checked").toBe(total);
    expect(builtinModules.length, "every sport has a page row name").toBe(Object.keys(ROW_NAME).length);
    // Anti-vacuity: each of the four cases is reached by at least one variant.
    for (const [k, n] of Object.entries(seen)) expect(n, `${k} case reached`).toBeGreaterThan(0);
    expect(seen.decider + seen.held + seen.forced + seen.none).toBe(total);
  });

  it("a league shoot-out is a declared decider, so the page cannot say a decider is unused where a stage can end level", () => {
    const withLeagueDecider = builtinModules.filter((m) => Object.keys(m.variants).some((v) => deciderKeysFor(m, "league", v).length > 0));
    expect(withLeagueDecider.length, "sports whose league stage declares a decider").toBeGreaterThan(0);
    expect(PAGE).not.toMatch(/the decider is not used/i);
    expect(PAGE).toMatch(/league or group stage[^.]*same[^.]*settings are there/i);
  });
});
