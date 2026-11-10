// X-TP-3: the standings export of a finished bracket marks a SHARED place - in the org's words (`table.sharedRank`) on both semi-final losers, "5" on the next
// row (the stored RANK, C8) - and is untouched for a table (a league's level rank is not a shared place).
import { describe, expect, it } from "vitest";
import type { StandingsRow, TableLayout } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { standingsTableSections } from "../exports-standings";

const LAYOUT: TableLayout = { apart: [], unit: "whole", ballsPerOver: 6 };
const row = (entrantId: string, rank: number): StandingsRow => ({ entrantId, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank });
const ranksPrinted = (ranks: readonly number[], stageKind: string | undefined, dict: Dict = en as Dict): unknown[] => {
  const rows = ranks.map((r, i) => row(`e${i}`, r));
  const sections = standingsTableSections({
    title: "T",
    common: {} as never,
    rows,
    metricSpecs: builtinModules[0]!.metrics as never,
    cascade: ["points"],
    layout: LAYOUT,
    nameOf: (id) => id,
    msg: (k, v) => t(dict, k, v),
    ...(stageKind !== undefined ? { stageKind } : {}),
  });
  const printed = sections.flatMap((s) => s.table?.rows ?? []);
  expect(printed.length, "anti-vacuity: rows were printed").toBe(ranks.length);
  return printed.map((r) => r[0]);
};

describe("X-TP-3 standings export of a bracket's places", () => {
  it("empty case: a bracket with no rows prints none", () => {
    const sections = standingsTableSections({ title: "T", common: {} as never, rows: [], metricSpecs: [], cascade: [], layout: LAYOUT, nameOf: (i) => i, msg: (k, v) => t(en as Dict, k, v), stageKind: "knockout" });
    expect(JSON.stringify(sections)).not.toContain("shared");
  });

  it("a shared 3rd prints the dictionary's shared-place words on both rows and 5 on the next - differential: today 3, 3, 5 with nothing marking the share", () => {
    const shared = t(en as Dict, "table.sharedRank", { rank: 3 });
    expect(shared).not.toBe("3");
    expect(ranksPrinted([1, 2, 3, 3, 5], "knockout")).toEqual([1, 2, shared, shared, 5]);
  });

  it("the words are the org's language: es, fr and nl differ from English and from each other (counted, 3)", () => {
    const words = (d: Dict) => t(d, "table.sharedRank", { rank: 3 });
    const english = words(en as Dict);
    const others = [es, fr, nl].map((d) => words(d as Dict));
    expect(others.length).toBe(3);
    for (const w of others) {
      expect(w).toContain("3");
      expect(w).not.toBe(english);
    }
    expect(new Set([english, ...others]).size).toBe(4);
  });

  it("the printed cell is the INJECTED language's words, not a baked-in English suffix (es, fr, nl each, counted 3)", () => {
    let checked = 0;
    for (const d of [es, fr, nl] as Dict[]) {
      const w = t(d, "table.sharedRank", { rank: 3 });
      expect(ranksPrinted([1, 2, 3, 3, 5], "knockout", d)).toEqual([1, 2, w, w, 5]);
      expect(w).not.toBe(t(en as Dict, "table.sharedRank", { rank: 3 }));
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("strict places print plain numbers", () => {
    expect(ranksPrinted([1, 2, 3, 4], "knockout")).toEqual([1, 2, 3, 4]);
  });

  it("the same ranks on a table (or with no kind named) are not marked", () => {
    expect(ranksPrinted([1, 2, 3, 3, 5], "league")).toEqual([1, 2, 3, 3, 5]);
    expect(ranksPrinted([1, 2, 3, 3, 5], undefined)).toEqual([1, 2, 3, 3, 5]);
  });
});
