// X-TP-3: the standings export of a finished bracket marks a SHARED place - "3=" on both semi-final losers, "5" on the next
// row (the stored RANK, C8) - and is untouched for a table (a league's level rank is not a shared place).
import { describe, expect, it } from "vitest";
import type { StandingsRow, TableLayout } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { standingsTableSections } from "../exports-standings";

const LAYOUT: TableLayout = { apart: [], unit: "whole", ballsPerOver: 6 };
const row = (entrantId: string, rank: number): StandingsRow => ({ entrantId, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank });
const ranksPrinted = (ranks: readonly number[], stageKind: string | undefined): unknown[] => {
  const rows = ranks.map((r, i) => row(`e${i}`, r));
  const sections = standingsTableSections({
    title: "T",
    common: {} as never,
    rows,
    metricSpecs: builtinModules[0]!.metrics as never,
    cascade: ["points"],
    layout: LAYOUT,
    nameOf: (id) => id,
    msg: (k) => t(en as Dict, k),
    ...(stageKind !== undefined ? { stageKind } : {}),
  });
  const printed = sections.flatMap((s) => s.table?.rows ?? []);
  expect(printed.length, "anti-vacuity: rows were printed").toBe(ranks.length);
  return printed.map((r) => r[0]);
};

describe("X-TP-3 standings export of a bracket's places", () => {
  it("empty case: a bracket with no rows prints none", () => {
    const sections = standingsTableSections({ title: "T", common: {} as never, rows: [], metricSpecs: [], cascade: [], layout: LAYOUT, nameOf: (i) => i, msg: (k) => t(en as Dict, k), stageKind: "knockout" });
    expect(JSON.stringify(sections)).not.toContain("=");
  });

  it("a shared 3rd prints '3=' on both rows and 5 on the next - differential: today 3, 3, 5 with nothing marking the share", () => {
    expect(ranksPrinted([1, 2, 3, 3, 5], "knockout")).toEqual([1, 2, "3=", "3=", 5]);
  });

  it("strict places print plain numbers", () => {
    expect(ranksPrinted([1, 2, 3, 4], "knockout")).toEqual([1, 2, 3, 4]);
  });

  it("the same ranks on a table (or with no kind named) are not marked", () => {
    expect(ranksPrinted([1, 2, 3, 3, 5], "league")).toEqual([1, 2, 3, 3, 5]);
    expect(ranksPrinted([1, 2, 3, 3, 5], undefined)).toEqual([1, 2, 3, 3, 5]);
  });
});
