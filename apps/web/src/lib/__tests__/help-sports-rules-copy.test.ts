// Truth-in-copy for the per-sport help pages (content/help/sports/*.md): every number in a format table, and the format a new
// division starts on, is read from the engine's own module declarations (@seazn/engine, the registry the product runs), never
// typed beside the claim.
//
// The page names a format by the label the builder shows (dictionary `variant.<sport>.<key>`), and each table row carries the
// numbers in a fixed order. The expected numbers come from `configSchema.parse(variant)`, so a retuned preset moves the test, not
// the other way round. The default-format sentence is checked against `pickVariant` (the one pick the builder and the funnel
// share), over the variants listed by key: the builder lists them by key, which is why a new carrom division starts on Club.
//
// Hockey's own numbers (quarters, cards, strength chip, tie-break order) are pinned by help-hockey-format-copy.test.ts, and the
// chess check-in section by help-checkin-extend-copy.test.ts; both are exempt here and the exemption is asserted.
// Single-process reason for the sweep: it walks the whole sport registry (builtinModules) and reports what it checked.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "@seazn/engine/sports";
import ui from "@/dictionaries/en/ui.json";
import { pickVariant } from "@/lib/preferred-variant";

const DICT = ui as Record<string, string>;
const PAGE_OF: Readonly<Record<string, string>> = {
  badminton: "badminton", carrom: "carrom", boardgame: "chess", cricket: "cricket", football: "football", generic: "generic",
  hockey: "hockey", icehockey: "icehockey", tabletennis: "tabletennis", tennis: "tennis", volleyball: "volleyball",
};
const read = (slug: string) => readFileSync(join(process.cwd(), "content/help/sports", `${slug}.md`), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfg = any;
interface Row { readonly sport: string; readonly variant: string; readonly labelKey: string; readonly nums: (c: Cfg) => number[] }
const tb = (c: Cfg) => [c.bestOf, c.set.gamesTo, c.set.tiebreakAt, c.set.tiebreakAt];
const ROWS: readonly Row[] = [
  { sport: "badminton", variant: "bwf", labelKey: "variant.badminton.bwf", nums: (c) => [c.setTo, c.cap] },
  { sport: "badminton", variant: "bwf-3x15", labelKey: "variant.badminton.bwf3x15", nums: (c) => [c.setTo, c.cap] },
  { sport: "badminton", variant: "short", labelKey: "variant.badminton.short", nums: (c) => [c.setTo, c.cap] },
  { sport: "tabletennis", variant: "bo5", labelKey: "variant.tabletennis.bo5", nums: (c) => [c.bestOf, c.setTo] },
  { sport: "tabletennis", variant: "bo7", labelKey: "variant.tabletennis.bo7", nums: (c) => [c.bestOf, c.setTo] },
  { sport: "tabletennis", variant: "hardbat-21", labelKey: "variant.tabletennis.hardbat21", nums: (c) => [c.bestOf, c.setTo] },
  { sport: "volleyball", variant: "beach", labelKey: "variant.volleyball.beach", nums: (c) => [c.bestOf, c.setTo, c.finalSetTo] },
  { sport: "volleyball", variant: "indoor", labelKey: "variant.volleyball.indoor", nums: (c) => [c.bestOf, c.setTo, c.finalSetTo] },
  { sport: "carrom", variant: "icf", labelKey: "variant.carrom.icf", nums: (c) => [c.gameTo, c.queenPoints, c.queenCapAt] },
  { sport: "carrom", variant: "club-29", labelKey: "variant.carrom.club29", nums: (c) => [c.gameTo, c.queenPoints, c.queenCapAt] },
  { sport: "football", variant: "11-a-side", labelKey: "variant.football.elevenASide", nums: (c) => [c.halves, c.halfMinutes] },
  { sport: "football", variant: "youth", labelKey: "variant.football.youth", nums: (c) => [c.halves, c.halfMinutes] },
  { sport: "football", variant: "small-sided", labelKey: "variant.football.smallSided", nums: (c) => [c.halves, c.halfMinutes, c.teamSize] },
  { sport: "football", variant: "mini-soccer", labelKey: "variant.football.miniSoccer", nums: (c) => [c.halves, c.halfMinutes, c.teamSize] },
  { sport: "cricket", variant: "t20", labelKey: "variant.cricket.t20", nums: (c) => [c.ballsPerInnings / c.ballsPerOver, c.ballsPerOver, c.maxOversPerBowler] },
  { sport: "cricket", variant: "odi", labelKey: "variant.cricket.odi", nums: (c) => [c.ballsPerInnings / c.ballsPerOver, c.ballsPerOver, c.maxOversPerBowler] },
  { sport: "cricket", variant: "hundred", labelKey: "variant.cricket.hundred", nums: (c) => [c.ballsPerInnings, c.ballsPerOver, c.maxOversPerBowler] },
  // "Two innings a side" is spelled on the page: the two-innings premise is asserted here, the cell carries no digit.
  { sport: "cricket", variant: "test", labelKey: "variant.cricket.test", nums: (c) => (c.inningsPerSide !== 2 ? [-1] : c.maxOversPerBowler === undefined ? [] : [c.maxOversPerBowler]) },
  { sport: "tennis", variant: "tour", labelKey: "variant.tennis.tour", nums: tb },
  { sport: "tennis", variant: "grand-slam", labelKey: "variant.tennis.grandSlam", nums: (c) => [...tb(c), c.finalSet.tiebreakTo] },
  { sport: "tennis", variant: "fast4", labelKey: "variant.tennis.fast4", nums: tb },
  { sport: "tennis", variant: "short-sets", labelKey: "variant.tennis.shortSets", nums: tb },
  { sport: "tennis", variant: "doubles-noad-mtb10", labelKey: "variant.tennis.doublesNoAdMatchTiebreak", nums: (c) => [...tb(c), c.finalSet.matchTiebreakTo] },
  { sport: "icehockey", variant: "iihf", labelKey: "variant.icehockey.iihf", nums: (c) => [c.periods.count, c.periods.minutes, c.overtime.minutes, c.overtime.skaters, c.shootout.attempts, c.points.win, c.points.otWin, c.points.otLoss, c.points.loss] },
  { sport: "icehockey", variant: "recreational", labelKey: "variant.icehockey.recreational", nums: (c) => [c.periods.count, c.periods.minutes, c.points.win, c.points.draw, c.points.loss] },
];
/** Variants whose numbers are pinned elsewhere or that carry none. Each reason is asserted, not assumed. */
const EXEMPT: Readonly<Record<string, string>> = {
  "hockey/fih-outdoor": "help-hockey-format-copy.test.ts", "hockey/fih-shootout": "help-hockey-format-copy.test.ts", "hockey/youth": "help-hockey-format-copy.test.ts",
  "boardgame/classical": "a time-control label: the page quotes no number for it", "boardgame/rapid": "a time-control label: the page quotes no number for it", "boardgame/blitz": "a time-control label: the page quotes no number for it",
  "generic/score": "no numbers: a running tally", "generic/win_loss": "no numbers: a bare result",
};
const mod = (sport: string) => builtinModules.find((m) => m.key === sport) as unknown as { key: string; variants: Record<string, unknown>; configSchema: { parse: (v: unknown) => Cfg } };
const cfg = (sport: string, variant: string): Cfg => mod(sport).configSchema.parse(mod(sport).variants[variant]);
const ints = (s: string) => [...s.matchAll(/\d+/g)].map((m) => Number(m[0]));

describe("help: per-sport format tables are the engine's declarations", () => {
  it("every row's numbers are the variant's own, in the page's order (and the sweep checked them)", () => {
    let checked = 0;
    for (const row of ROWS) {
      const label = DICT[row.labelKey];
      expect(label, `premise: the dictionary labels ${row.labelKey}`).toBeDefined();
      const md = read(PAGE_OF[row.sport]!);
      const line = md.split("\n").find((l) => l.startsWith(`| **${label}**`));
      expect(line, `${PAGE_OF[row.sport]}.md has no table row for "${label}"`).toBeDefined();
      const cells = line!.slice(`| **${label}**`.length);
      const want = row.nums(cfg(row.sport, row.variant));
      expect(want.every((n) => Number.isFinite(n)), `engine numbers for ${row.sport}/${row.variant}: ${want}`).toBe(true);
      expect(ints(cells), `${row.sport}/${row.variant} ("${label}")`).toEqual(want);
      checked++;
    }
    expect(checked, "anti-vacuity: rows checked").toBe(ROWS.length);
    expect(checked).toBeGreaterThan(20);
  });

  it("the sport registry is fully accounted for: every variant has a row or a stated exemption, and every sport has a page", () => {
    let seen = 0;
    for (const m of builtinModules) {
      expect(PAGE_OF[m.key], `sport "${m.key}" has no help page: add one`).toBeDefined();
      for (const v of Object.keys(m.variants)) {
        const covered = ROWS.some((r) => r.sport === m.key && r.variant === v) || `${m.key}/${v}` in EXEMPT;
        expect(covered, `${m.key}/${v} has no row in this guard and no exemption`).toBe(true);
        seen++;
      }
    }
    expect(seen, "anti-vacuity: variants walked").toBeGreaterThanOrEqual(ROWS.length + Object.keys(EXEMPT).length);
    for (const key of Object.keys(EXEMPT)) {
      const [sport, variant] = key.split("/") as [string, string];
      expect(Object.keys(mod(sport).variants), `exemption ${key} names a variant that no longer exists`).toContain(variant);
    }
  });

  it("each page names the variant a new division starts on, and it is the one the builder preselects", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const listed = Object.keys(m.variants).sort().map((key) => ({ key }));
      const start = pickVariant(m.key, listed);
      const labelKey = ROWS_LABEL_OF(m.key, start);
      expect(DICT[labelKey], `premise: ${m.key}/${start} has a dictionary label (${labelKey})`).toBeDefined();
      const label = DICT[labelKey]!;
      const plain = label.replace(/\s*\(.*\)$/, "");
      const md = read(PAGE_OF[m.key]!);
      const claimed = [...md.matchAll(/starts on \*\*(.+?)\*\*/g)].map((x) => x[1]);
      expect(claimed.some((c) => c === label || c === plain), `${PAGE_OF[m.key]}.md says a new division starts on ${JSON.stringify(claimed)}, the builder preselects "${label}"`).toBe(true);
      checked++;
    }
    expect(checked, "anti-vacuity: sports checked").toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
  });
});

/** The dictionary key of a variant: from a row when the sport has one, else from the exemption's own naming. */
function ROWS_LABEL_OF(sport: string, variant: string): string {
  const row = ROWS.find((r) => r.sport === sport && r.variant === variant);
  if (row) return row.labelKey;
  const camel = variant.replace(/[-_](\w)/g, (_x, c: string) => c.toUpperCase());
  const named: Record<string, string> = { "fih-outdoor": "fihOutdoor", "fih-shootout": "fihShootout", "win_loss": "winLoss" };
  return `variant.${sport}.${named[variant] ?? camel}`;
}
