// W5 follow-ups C: the paged Schedule's pure choices - which rounds a chip lists and in what order, what a header counts under a
// chip, which teams a typed query suggests, and where a folded round is asked for. The rounds here are hand-built headers; the
// expected values are read off them, never off the helpers.
import { describe, expect, it } from "vitest";
import { chipCount, roundsForChip, roundsUrl, teamSuggestions, type PagedChip } from "../paged-schedule";
import type { PagedScheduleGroup } from "@/lib/schedule-paging";

const g = (roundNo: number, live: number, upcoming: number, result: number): PagedScheduleGroup => ({
  key: JSON.stringify(["lg", `Round ${roundNo}`]),
  state: live > 0 ? "live" : upcoming === 0 ? "finished" : "upcoming",
  open: live > 0,
  total: live + upcoming + result,
  live,
  upcoming,
  result,
  label: `Round ${roundNo}`,
  stageId: "lg",
  roundNo,
  catchUp: false,
  sitsOut: null,
  anchorAt: null,
});
const rounds = [g(1, 0, 0, 4), g(2, 0, 0, 4), g(3, 2, 1, 1), g(4, 0, 4, 0), g(5, 0, 4, 0)];

describe("paged Schedule helpers", () => {
  it("All lists every round in play order; a chip lists only the rounds holding one of its matches; Results most recent first", () => {
    const want: Record<PagedChip, number[]> = { all: [1, 2, 3, 4, 5], live: [3], upcoming: [3, 4, 5], result: [3, 2, 1] };
    let checked = 0;
    for (const chip of Object.keys(want) as PagedChip[]) {
      expect(roundsForChip(rounds, chip).map((r) => r.roundNo), chip).toEqual(want[chip]);
      checked += 1;
    }
    expect(checked).toBe(4);
    expect(roundsForChip([], "live"), "the empty division lists nothing").toEqual([]);
    expect(rounds.map((r) => r.roundNo), "the input is not reordered in place").toEqual([1, 2, 3, 4, 5]);
  });

  it("a header counts every match under All and only the chip's own under a chip", () => {
    const r3 = rounds[2]!;
    expect([chipCount(r3, "all"), chipCount(r3, "live"), chipCount(r3, "upcoming"), chipCount(r3, "result")]).toEqual([4, 2, 1, 1]);
  });

  it("team suggestions match inside a name, ignore case and accents, sort by name and stop at the limit", () => {
    const names = { a: "Zoë Brand", b: "Chloé Martin", c: "zoe Adams", d: "Bram" };
    expect(teamSuggestions(names, "zoe").map((s) => s.name)).toEqual(["Zoë Brand", "zoe Adams"].sort((x, y) => x.localeCompare(y)));
    expect(teamSuggestions(names, "CHLOE").map((s) => s.id)).toEqual(["b"]);
    expect(teamSuggestions(names, "  ")).toEqual([]);
    expect(teamSuggestions(names, "nobody")).toEqual([]);
    expect(teamSuggestions(names, "a", 2)).toHaveLength(2);
  });

  it("a folded round and a team are asked for beside the division page, encoded", () => {
    const key = JSON.stringify(["lg", "Round 8"]);
    expect(roundsUrl("/live/o/c/d", { round: key })).toBe(`/live/o/c/d/rounds?round=${encodeURIComponent(key)}`);
    expect(roundsUrl("/live/o/c/d", { entrant: "e 1" })).toBe("/live/o/c/d/rounds?entrant=e%201");
  });
});
