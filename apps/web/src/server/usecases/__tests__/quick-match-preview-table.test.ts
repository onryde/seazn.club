// Quick match plan 2, Task 2 (pre-flight amendments D1, A2, A3, B2, C2): the setup screen's every match count, computed
// on the server and handed to the setup island as a prop, so the number on the Start button is a lookup — never a fetch
// that can land stale or out of order. A guest's quick match is a League or a League + Knockout (plan 5 D1; owner 2026-11-12
// "take out" the plain Knockout), so the table holds league cells and League + Knockout cells; the knockout draws
// (`quickMatchKnockoutDraws`) are kept, unshipped, and pinned here the same way.
//
// No DB. ONE table for every sport: the draw is the stage kind's, not the sport's. The engine's generators take no sport
// (spec §7.3: a league is `generateRoundRobin({ entrants, seeds, config: { legs } })`, a knockout `generateSingleElim`),
// the create builds its stages from `quickMatchStageInputs` and its count from `quickMatchPreview`, neither of which takes
// a sport — the type test below pins both inputs, so adding one reds here before a per-sport table is needed — and plan
// 1's probe (`_quick-match-probe.ts` step 3) crosses the preview's count with real creates in every offered sport.
//
// Expected values come from the rulebook, never from running the code: a round robin plays n(n−1)/2 pairs × plays; a
// knockout pads to the next power of two S with the byes to the top seeds, seed i meets seed S+1−i (lib/format-
// templates.ts:104-107), the halves of an 8-draw are (1v8, 4v5) and (3v6, 2v7), and every match but the final sends one
// side home, so a knockout of n plays n − 1 matches. Spec §7.3 step 3 names who sits out.
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  QUICK_MATCH_KNOCKOUT_MIN_SIDES,
  QUICK_MATCH_MAX_PLAYS,
  QUICK_MATCH_MAX_SIDES,
  QUICK_MATCH_QUALIFIERS,
  QUICK_MATCH_SEMIS_MIN_SIDES,
} from "@/lib/quick-match-constants";
import { previewStageDraw, type PreviewDrawFixture } from "../stages";
import {
  quickMatchPreview,
  quickMatchPreviewTable,
  quickMatchStageInputs,
  type QuickMatchDrawSeat,
  quickMatchKnockoutDraws,
  type QuickMatchFormat,
  type QuickMatchKnockoutCell,
  type QuickMatchKnockoutDraws,
} from "../quick-match-preview";

/** The rulebook's ranges (CreateQuickMatch: 2..6 sides, 1..2 plays — Once | Twice, owner 2026-11-12; C16: a knockout
 *  needs three sides). */
const LEAGUE_KEYS = [2, 3, 4, 5, 6].flatMap((n) => [1, 2].map((p) => `league:${n}:${p}`));
const KNOCKOUT_KEYS = [3, 4, 5, 6].map((n) => `knockout:${n}:1`);
/** League + Knockout (spec §3): the top 2 from three sides up, the top 4 from four (the constants the create refuses by). */
const LK_KEYS = QUICK_MATCH_QUALIFIERS.flatMap((q) => {
  const from = q === 4 ? QUICK_MATCH_SEMIS_MIN_SIDES : QUICK_MATCH_KNOCKOUT_MIN_SIDES;
  return Array.from({ length: QUICK_MATCH_MAX_SIDES - from + 1 }, (_, i) => from + i).flatMap((n) =>
    Array.from({ length: QUICK_MATCH_MAX_PLAYS }, (_, p) => `league_knockout:${n}:${p + 1}:${q}`),
  );
});
/** The one stage of a Knockout. */
const knockoutStage = () => quickMatchStageInputs({ format: "knockout", plays: 1, name: "x", qualifiers: null })[0]!;

const knockout = (t: QuickMatchKnockoutDraws, n: number): QuickMatchKnockoutCell => {
  const cell = t[`knockout:${n}:1`];
  if (!cell) throw new Error(`no knockout cell for ${n} sides`);
  return cell;
};

/** A seat in words the rulebook uses: a seed's number, or W(<the pair it is the winner of>). */
function seatWords(cell: QuickMatchKnockoutCell, seat: QuickMatchDrawSeat): string {
  if ("seed" in seat) return String(seat.seed);
  const pair = cell.rounds[seat.winnerOf.round - 1]?.pairs[seat.winnerOf.pair - 1];
  if (!pair) throw new Error(`winnerOf ${JSON.stringify(seat.winnerOf)} names no pair`);
  return `W(${pairWords(cell, pair)})`;
}
const pairWords = (cell: QuickMatchKnockoutCell, pair: [QuickMatchDrawSeat, QuickMatchDrawSeat]) =>
  pair.map((s) => seatWords(cell, s)).sort().join("v");

describe("quickMatchPreviewTable — the cells", () => {
  it("holds exactly the 10 league cells (2..6 sides × 1..2 plays), the League + Knockout cells, and no knockout cell", () => {
    const keys = Object.keys(quickMatchPreviewTable());
    // The League + Knockout cells, counted from the rulebook's ranges: top 2 over 3..6 sides, top 4 over 4..6, each Once and
    // Twice: (4 + 3) × 2 = 14. (The plan's "12 at q=2 plus 6 at q=4, so 18" miscounted the q=2 range: 3..6 is four side counts.)
    expect(LK_KEYS).toHaveLength((4 + 3) * 2);
    expect(keys.length).toBe(10 + 14); // anti-vacuity: an empty table is a failure, not a pass
    expect(new Set(keys)).toEqual(new Set([...LEAGUE_KEYS, ...LK_KEYS]));
    expect(keys.filter((k) => k.startsWith("knockout:")), "no plain knockout ships to a guest (owner 2026-11-12)").toEqual([]);
    // §3: no League + Knockout of two sides, and no semi-finals below four.
    expect(keys.filter((k) => k.startsWith("league_knockout:2:")), "two sides: no knockout row").toEqual([]);
    expect(keys.filter((k) => /^league_knockout:3:\d+:4$/.test(k)), "three sides: no semi-finals").toEqual([]);
  });

  it("every League + Knockout cell counts the league's round robin plus the knockout of the top q, q − 1 matches", () => {
    // The rulebook: plays × n(n−1)/2 league matches, then a single-elimination of q sides, q − 1 matches (no third place). The
    // knockout's count is crossed with the generator's own draw of q sides (`previewStageDraw`, raw, byes dropped), and the
    // league's with the table's own league cell, so a cell is the sum of the two parts it promises.
    const t = quickMatchPreviewTable();
    let checked = 0;
    for (const key of LK_KEYS) {
      const [, n, plays, q] = key.split(":").map(Number) as [number, number, number, number];
      const knockoutDrawn = previewStageDraw(knockoutStage(), q).filter((f) => !f.bye).length;
      expect(knockoutDrawn, `the generator's knockout of ${q}`).toBe(q - 1);
      const cell = t[key as `league_knockout:${number}:${number}:${number}`];
      expect(cell?.matchCount, key).toBe((plays * n * (n - 1)) / 2 + (q - 1));
      expect(cell?.matchCount, key).toBe(t[`league:${n}:${plays}`]!.matchCount + knockoutDrawn);
      checked++;
    }
    expect(checked).toBe(14);
    // The semi-finals' count is also the kept draw's own (`quickMatchKnockoutDraws`, the four-side bracket).
    expect(knockout(quickMatchKnockoutDraws(), 4).matchCount).toBe(4 - 1);
  });

  it("the kept knockout draws hold exactly the 4 draws (3..6 sides), for League + Knockout", () => {
    const keys = Object.keys(quickMatchKnockoutDraws());
    expect(keys.length).toBe(4);
    expect(new Set(keys)).toEqual(new Set(KNOCKOUT_KEYS));
  });

  it("every league cell counts plays × n(n−1)/2 matches (round robin)", () => {
    const t = quickMatchPreviewTable();
    let checked = 0;
    for (let n = 2; n <= 6; n++)
      for (let plays = 1; plays <= 2; plays++) {
        expect(t[`league:${n}:${plays}`]?.matchCount, `league ${n}×${plays}`).toBe((plays * n * (n - 1)) / 2);
        checked++;
      }
    expect(checked).toBe(10);
  });

  it("every knockout draw counts n − 1 matches, and the top seeds sit out round one (spec §7.3 step 3)", () => {
    const t = quickMatchKnockoutDraws();
    const holders: Record<number, number[]> = { 3: [1], 4: [], 5: [1, 2, 3], 6: [1, 2] };
    let checked = 0;
    for (const n of [3, 4, 5, 6]) {
      const cell = knockout(t, n);
      expect(cell.matchCount, `knockout of ${n}`).toBe(n - 1);
      // a bye is no match: the pairs are the matches, and nothing else is
      expect(cell.rounds.flatMap((r) => r.pairs)).toHaveLength(n - 1);
      expect([...cell.byes].sort(), `knockout of ${n}`).toEqual(holders[n]);
      checked++;
    }
    expect(checked).toBe(4);
  });

  // Hand-derived from the padded draw: 3 → S 4 (1v4 is a bye); 4 → S 4; 5 → S 8 (1v8, 2v7, 3v6 are byes); 6 → S 8
  // (1v8, 2v7 are byes). A bye holder takes the seat its bye line feeds, so round two names a SIDE, never "the winner"
  // of a match nobody plays — and with 5 sides, seeds 2 and 3 meet in a semi-final everyone can see coming.
  it.each([
    [3, [["2v3"], ["1vW(2v3)"]]],
    [4, [["1v4", "2v3"], ["W(1v4)vW(2v3)"]]],
    [5, [["4v5"], ["1vW(4v5)", "2v3"], ["W(1vW(4v5))vW(2v3)"]]],
    [6, [["3v6", "4v5"], ["1vW(4v5)", "2vW(3v6)"], ["W(1vW(4v5))vW(2vW(3v6))"]]],
  ])("the knockout of %i draws %j, round by round", (n, rounds) => {
    const cell = knockout(quickMatchKnockoutDraws(), n);
    // the PAIRING is the assertion, not the order of the pairs in a round
    expect(cell.rounds.map((r) => new Set(r.pairs.map((p) => pairWords(cell, p))))).toEqual(rounds.map((r) => new Set(r)));
  });

  // The rulebook names a knockout round by its distance from the final; S has log2(S) rounds.
  it.each([
    [3, ["semi_final", "final"]],
    [4, ["semi_final", "final"]],
    [5, ["quarter_final", "semi_final", "final"]],
    [6, ["quarter_final", "semi_final", "final"]],
  ])("the knockout of %i names its rounds %j", (n, roles) => {
    expect(knockout(quickMatchKnockoutDraws(), n).rounds.map((r) => r.role?.kind)).toEqual(roles);
  });

  it("a winner's seat only ever names an EARLIER round's pair (no loop, no forward reference)", () => {
    const t = quickMatchKnockoutDraws();
    let seats = 0;
    for (const n of [3, 4, 5, 6]) {
      const cell = knockout(t, n);
      cell.rounds.forEach((r, i) =>
        r.pairs.flat().forEach((s) => {
          if ("winnerOf" in s) expect(s.winnerOf.round, `knockout of ${n}, round ${i + 1}`).toBeLessThan(i + 1);
          seats++;
        }),
      );
    }
    // two seats per match: 2 × (2 + 3 + 4 + 5)
    expect(seats).toBe(28);
  });
});

describe("quickMatchPreviewTable and quickMatchKnockoutDraws — the exhaustive differential against the direct calls", () => {
  // Every cell against `quickMatchPreview` called directly, and every knockout seat against the generator's own RAW
  // draw (`previewStageDraw`), which carries each fixture's explicit seq — so a feeder is resolved here by lookup on
  // (round, seq), independently of the table's walk over the fold's ordered lines.
  it("every cell's count, every knockout round's role, bye and pair, and every seat equal the direct calls", () => {
    const t = quickMatchPreviewTable();
    const draws = quickMatchKnockoutDraws();
    let cells = 0;
    let seats = 0;
    for (const key of [...Object.keys(t), ...Object.keys(draws)]) {
      const [format, sides, plays, q] = key.split(":") as [QuickMatchFormat, string, string, string | undefined];
      const qualifiers = q === undefined ? null : (Number(q) as 2 | 4);
      const input = { format, sides: Number(sides), plays: Number(plays), qualifiers };
      const direct = quickMatchPreview(input);
      cells++;
      if (format === "league" || format === "league_knockout") {
        expect((t as Record<string, unknown>)[key], key).toEqual({ matchCount: direct.matchCount });
        continue;
      }
      const cell = knockout(draws, input.sides);
      expect(cell.matchCount, key).toBe(direct.matchCount);
      expect(cell.rounds.map((r) => r.role), key).toEqual(direct.rounds.map((r) => r.role));
      expect(cell.byes, key).toEqual(direct.rounds.flatMap((r) => r.lines.filter((l) => l.bye).map((l) => l.home.seed)));

      const raw = previewStageDraw(knockoutStage(), input.sides);
      const at = (round: number, seq: number): PreviewDrawFixture => {
        const f = raw.find((x) => x.roundNo === round && x.seqInRound === seq);
        if (!f) throw new Error(`${key}: no raw fixture R${round}·${seq}`);
        return f;
      };
      // a raw fixture's place among its round's matches (byes skipped), in seq order: its 1-based pair number
      const pairNo = (f: PreviewDrawFixture) =>
        raw.filter((x) => x.roundNo === f.roundNo && !x.bye && x.seqInRound <= f.seqInRound).length;
      const expectedSeat = (seed: number | null, from: PreviewDrawFixture["homeFrom"]): QuickMatchDrawSeat => {
        if (seed !== null) return { seed };
        const src = at(from!.round, from!.seq);
        return src.bye ? { seed: src.homeSeed! } : { winnerOf: { round: src.roundNo, pair: pairNo(src) } };
      };
      for (const f of raw.filter((x) => !x.bye)) {
        const pair = cell.rounds[f.roundNo - 1]?.pairs[pairNo(f) - 1];
        expect(pair, `${key} R${f.roundNo}·${f.seqInRound}`).toEqual([
          expectedSeat(f.homeSeed, f.homeFrom),
          expectedSeat(f.awaySeed, f.awayFrom),
        ]);
        seats += 2;
      }
      expect(cell.rounds.flatMap((r) => r.pairs), key).toHaveLength(raw.filter((x) => !x.bye).length);
    }
    expect(cells).toBe(28); // anti-vacuity: 10 league cells + 14 League + Knockout cells + 4 knockout draws
    expect(seats).toBe(28); // 2 × (2 + 3 + 4 + 5)
  });
});

describe("quickMatchPreviewTable — ONE table for every sport, and small enough to ship in the page", () => {
  it("neither the table nor the preview and stage input it is built from take a sport", () => {
    // Compile-time only (vitest runs no assertion here): tsc checks these, scoped locally and in CI. A sport parameter
    // added to any of the three reds here — mutated once, an optional `sport` on two of them gave TS2741 on both lines —
    // which is the moment a per-sport table would be owed.
    expectTypeOf(quickMatchPreviewTable).parameters.toEqualTypeOf<[]>();
    expectTypeOf<Parameters<typeof quickMatchPreview>[0]>().toEqualTypeOf<{
      format: QuickMatchFormat;
      sides: number;
      plays: number;
      qualifiers?: 2 | 4 | null;
    }>();
    expectTypeOf<Parameters<typeof quickMatchStageInputs>[0]>().toEqualTypeOf<{
      format: QuickMatchFormat;
      plays: number;
      name: string;
      qualifiers: 2 | 4 | null;
    }>();
  });

  it("serializes inside a 2 KiB budget, and its shape holds exactly 48 keys", () => {
    // The table rides in every /play page payload: the budget is the requirement.
    const t = quickMatchPreviewTable();
    expect(JSON.stringify(t).length).toBeLessThanOrEqual(2048);
    // The shape's tripwire: every object key in the table, NOT descending into `role` (the engine's RoundRole may grow
    // a field without the table changing shape). Hand count: (10 league + 14 League + Knockout) cell keys, each with one
    // `matchCount` = 48 (no plain knockout cell rides in the page, owner 2026-11-12).
    const keysIn = (v: unknown): number =>
      Array.isArray(v)
        ? v.reduce((n: number, x) => n + keysIn(x), 0)
        : v !== null && typeof v === "object"
          ? Object.entries(v).reduce((n, [k, x]) => n + 1 + (k === "role" ? 0 : keysIn(x)), 0)
          : 0;
    expect(keysIn(t)).toBe(48);
  });
});

describe("quickMatchKnockoutDraws — a knockout seat it cannot name is refused, never shown blank or mislabeled", () => {
  afterEach(() => {
    vi.doUnmock("../stages");
    vi.resetModules();
  });

  const r1 = { roundNo: 1, role: null, homeFrom: null, awayFrom: null };
  const holder = { ...r1, seqInRound: 1, homeSeed: 1, awaySeed: null, bye: true };
  const match = { ...r1, seqInRound: 2, homeSeed: 2, awaySeed: 3, bye: false };
  const final = { roundNo: 2, seqInRound: 1, homeSeed: null, awaySeed: null, bye: false, role: null };
  const winner = (round: number, seq: number) => ({ round, seq, side: "winner" });

  it.each([
    ["a bye whose holder is no seed", [{ ...holder, homeSeed: null, homeFrom: winner(1, 2) }, match, { ...final, homeFrom: winner(1, 1), awayFrom: winner(1, 2) }]],
    ["a seat fed by a match that is not in the draw", [holder, match, { ...final, homeFrom: winner(1, 1), awayFrom: winner(1, 9) }]],
    ["a seat that is both seeded and fed", [holder, match, { ...final, homeSeed: 4, homeFrom: winner(1, 1), awayFrom: winner(1, 2) }]],
  ])("refuses %s", async (_label, drawn) => {
    // The real generator draws none of these (the sweeps above); a stub draw reaches the guard. The next test is its
    // positive pair: the same stub with well-formed seats is accepted.
    vi.resetModules();
    vi.doMock("../stages", () => ({ previewStageDraw: () => drawn }));
    const { quickMatchKnockoutDraws: fresh } = await import("../quick-match-preview");
    expect(() => fresh()).toThrow(/^quickMatchKnockoutDraws cannot name /);
  });

  it("the stubbed path accepts a well-formed draw (so the refusals above are the seat's, not the stub's)", async () => {
    vi.resetModules();
    const drawn = [holder, match, { ...final, homeFrom: winner(1, 1), awayFrom: winner(1, 2) }];
    vi.doMock("../stages", () => ({ previewStageDraw: () => drawn }));
    const { quickMatchKnockoutDraws: fresh } = await import("../quick-match-preview");
    // the bye holder takes the final's home seat; the away seat is the winner of the one real match
    expect(fresh()["knockout:4:1"]).toEqual({
      matchCount: 2,
      byes: [1],
      rounds: [
        { role: null, pairs: [[{ seed: 2 }, { seed: 3 }]] },
        { role: null, pairs: [[{ seed: 1 }, { winnerOf: { round: 1, pair: 1 } }]] },
      ],
    });
  });
});
