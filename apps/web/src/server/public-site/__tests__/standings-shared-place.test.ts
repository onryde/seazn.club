// X-TP-3 (D1): a cut through a shared 3rd flags the row `tieUnbroken` with `tieBreak.key: "shared_place"` (the engine's
// `rank_range` takes by position). The tie note must say "Shared place" in the page's language, not print the
// frame "Tied with X - split on shared_place" with the raw key.
import { describe, expect, it } from "vitest";
import type { StandingsRow } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";
import { tieBreakRule, tieNoteText } from "../standings-view";

const row = (entrantId: string, over: Partial<StandingsRow> = {}): StandingsRow => ({
  entrantId,
  played: 0,
  won: 0,
  drawn: 0,
  lost: 0,
  points: 0,
  metrics: {},
  rank: 3,
  ...over,
});
const NAMES: Record<string, string> = { c: "Cara", d: "Dev" };
const LOCALES: [string, Dict][] = [
  ["en", en as Dict],
  ["es", es as Dict],
  ["fr", fr as Dict],
  ["nl", nl as Dict],
];

describe("D1 shared_place in the tie note (X-TP-3)", () => {
  it("empty case: a row with no trace has no note", () => {
    expect(tieNoteText(row("c"), [row("c")], (k: TKey) => t(en as Dict, k), (id) => NAMES[id]!, () => null)).toBeNull();
  });

  it("the English note says 'Shared place' and names the others - never the raw key", () => {
    const c = row("c", { tieUnbroken: true, tieBreak: { key: "shared_place", with: ["d"] } });
    const text = tieNoteText(c, [c, row("d")], (k: TKey, v) => t(en as Dict, k, v), (id) => NAMES[id]!, () => null)!;
    expect(text).toContain("Shared place");
    expect(text).toContain("Dev");
    expect(text).not.toContain("shared_place");
    expect(text).not.toMatch(/split on/);
  });

  it("every locale has its own words (counted, 4), none the English leak or the raw key", () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      const c = row("c", { tieUnbroken: true, tieBreak: { key: "shared_place", with: ["d"] } });
      const msg = (k: TKey, v?: Record<string, string | number>) => t(dict, k, v);
      const rule = tieBreakRule("shared_place", msg, c, [c, row("d")]);
      expect(rule, loc).not.toBe("shared_place");
      if (loc !== "en") expect(rule, loc).not.toBe("Shared place");
      expect(tieNoteText(c, [c, row("d")], msg, (id) => NAMES[id]!, () => null), loc).toContain(rule);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a real rule still reads through the 'split on' frame (positive pair)", () => {
    const c = row("c", { tieBreak: { key: "points", with: ["d"] } });
    const text = tieNoteText(c, [c, row("d")], (k: TKey, v) => t(en as Dict, k, v), (id) => NAMES[id]!, () => null)!;
    expect(text).toContain("split on");
  });
});
