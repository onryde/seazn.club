// S9/#418 — pure unit coverage for the career rollup's group→sum→label step
// (`groupCareerStatsBySport`, server/player-stats.ts). No DB: fabricated
// snapshot rows, real football/badminton module registrations (booted the
// same way labelPlayerStats's own test already relies on — the first
// resolveModule/resolveLatestModule call registers every builtin).
import { describe, expect, it } from "vitest";
import { groupCareerStatsBySport, type CareerSnapshotRow } from "@/server/player-stats";
import type { MsgFn } from "@/lib/scoring-vocab";
import uiEn from "@/dictionaries/en/ui.json";

const en: MsgFn = (k) => (uiEn as Record<string, string>)[k];

function row(over: Partial<CareerSnapshotRow>): CareerSnapshotRow {
  return {
    division_id: "div-1",
    sport_key: "football",
    variant_key: "default",
    stats: {},
    ...over,
  };
}

describe("groupCareerStatsBySport", () => {
  it("sums the SAME metric across two divisions of one sport — not first-row-wins", () => {
    const rows = [
      row({ division_id: "d1", stats: { goals: 2, assists: 1 } }),
      row({ division_id: "d2", stats: { goals: 5, assists: 0 } }),
    ];
    const out = groupCareerStatsBySport(rows, new Map(), en);
    expect(out).toHaveLength(1);
    const football = out[0]!;
    expect(football.sport_key).toBe("football");
    const byKey = Object.fromEntries(football.metrics.map((x) => [x.key, x.value]));
    expect(byKey.goals).toBe(7); // 2 + 5, proves real summation (not 2, not 5)
    expect(byKey.assists).toBe(1); // 1 + 0
  });

  it("re-derives AFTER summing raw components (points = goals + assists over the TOTAL)", () => {
    const rows = [
      row({ division_id: "d1", stats: { goals: 2, assists: 1 } }),
      row({ division_id: "d2", stats: { goals: 1, assists: 2 } }),
    ];
    const out = groupCareerStatsBySport(rows, new Map(), en);
    const byKey = Object.fromEntries(out[0]!.metrics.map((x) => [x.key, x.value]));
    expect(byKey.goals).toBe(3);
    expect(byKey.assists).toBe(3);
    expect(byKey.points).toBe(6); // derived from the SUMMED totals, not summed pre-derived
  });

  it("distinguishes divisions from variants: two divisions on the SAME variant_key count as 1 variant, 2 divisions", () => {
    const rows = [
      row({ division_id: "d1", variant_key: "default", stats: { goals: 1 } }),
      row({ division_id: "d2", variant_key: "default", stats: { goals: 1 } }),
    ];
    const out = groupCareerStatsBySport(rows, new Map(), en);
    expect(out[0]!.divisions).toBe(2);
    expect(out[0]!.variants).toBe(1);
  });

  it("two divisions on DIFFERENT variant_keys count as 2 variants", () => {
    const rows = [
      row({ division_id: "d1", variant_key: "sevens", stats: { goals: 1 } }),
      row({ division_id: "d2", variant_key: "elevens", stats: { goals: 1 } }),
    ];
    const out = groupCareerStatsBySport(rows, new Map(), en);
    expect(out[0]!.divisions).toBe(2);
    expect(out[0]!.variants).toBe(2);
  });

  it("sums matches from the per-division lookup, defaulting an absent division to 0", () => {
    const rows = [row({ division_id: "d1" }), row({ division_id: "d2" }), row({ division_id: "d3" })];
    const matches = new Map([
      ["d1", 4],
      ["d2", 6],
      // d3 deliberately absent — must not throw, must count as 0
    ]);
    const out = groupCareerStatsBySport(rows, matches, en);
    expect(out[0]!.matches).toBe(10);
  });

  // S9/#418 — a career card states its match count once, in the meta line
  // (`matches`, derived from `fixtures`, which every sport has). Three
  // modules ALSO declare a folded `matches` metric counted a different way:
  // the engine counts a fixture with any recorded play, the meta counts a
  // COMPLETED one, so the two routinely disagree. On screen that read as
  // "1 division · 1 variant · 0 matches" directly above a tile saying
  // "MATCHES 1" — one word, two numbers, one card. The tile is what gives
  // way, because the meta count is the one that exists for all eleven sports.
  it("drops a folded `matches` tile — the meta count is the card's only match number", () => {
    const rows = [row({ sport_key: "badminton", division_id: "d1", stats: { matches: 1, points_won: 7 } })];
    const out = groupCareerStatsBySport(rows, new Map([["d1", 0]]), en);
    expect(out[0]!.matches).toBe(0);
    expect(out[0]!.metrics.map((x) => x.key)).not.toContain("matches");
    // …and only that key goes — the sport's real metrics are untouched.
    expect(out[0]!.metrics.find((x) => x.key === "points_won")?.value).toBe(7);
  });

  // Regression (c) — S9/#418: goalkeeper metrics (folded: goals_conceded,
  // clean_sheets) and outfield metrics (goals) for the SAME person in the
  // SAME sport, contributed by DIFFERENT divisions (a keeper season and an
  // outfield season), must land on ONE sport card, not two half-populated
  // ones and not silently dropped.
  it("the keeper split renders on ONE football card — outfield and goalkeeper rows share one entry", () => {
    const rows = [
      row({ division_id: "outfield-season", stats: { goals: 4, assists: 2 } }),
      row({ division_id: "keeper-season", stats: { goals_conceded: 3, clean_sheets: 2 } }),
    ];
    const out = groupCareerStatsBySport(rows, new Map(), en);
    expect(out).toHaveLength(1); // ONE football card, not two
    const byKey = Object.fromEntries(out[0]!.metrics.map((x) => [x.key, x.value]));
    expect(byKey.goals).toBe(4);
    expect(byKey.assists).toBe(2);
    expect(byKey.goals_conceded).toBe(3);
    expect(byKey.clean_sheets).toBe(2);
    expect(out[0]!.divisions).toBe(2);
  });

  it("groups multiple sports into separate cards, sorted by localized sport label", () => {
    const rows = [
      row({ division_id: "d1", sport_key: "football", stats: { goals: 1 } }),
      row({ division_id: "d2", sport_key: "badminton", stats: { points_won: 3 } }),
    ];
    const out = groupCareerStatsBySport(rows, new Map(), en);
    expect(out.map((s) => s.sport_key)).toEqual(["badminton", "football"]); // alphabetical by EN label
    expect(out[0]!.sport_label).toBe("Badminton");
    expect(out[1]!.sport_label).toBe("Football");
  });

  it("an unknown/retired sport_key degrades to empty metrics, never throws — counts stay correct", () => {
    const rows = [row({ division_id: "d1", sport_key: "no-such-sport@9.9.9", stats: { whatever: 5 } })];
    const out = groupCareerStatsBySport(rows, new Map(), en);
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toEqual([]);
    expect(out[0]!.divisions).toBe(1);
  });

  it("no rows in → no sports out", () => {
    expect(groupCareerStatsBySport([], new Map(), en)).toEqual([]);
  });

  it("zero-valued totals are dropped, same discipline as labelPlayerStats", () => {
    const rows = [row({ division_id: "d1", stats: { goals: 3, assists: 0 } })];
    const out = groupCareerStatsBySport(rows, new Map(), en);
    expect(out[0]!.metrics.find((m) => m.key === "assists")).toBeUndefined();
  });
});
