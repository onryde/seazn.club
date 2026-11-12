// Quick match plan 1, Task 4: the setup screen's match count and knockout draw (spec C17, C22), read from the real
// generator's STRUCTURE through `previewStageDraw` (stages/preview.ts) — seeds, feeders, the bye flag and the engine's typed
// round role — never from previewDivisionFixtures' English text (pre-flight C2, C10).
//
// No DB. Sport-independent by construction: the preview takes no sport (the draw is the stage kind's, not the
// sport's), so there is no registry to sweep here — Task 6's probe crosses these counts with every offered sport.
//
// Expected values come from the generator's documented rules, never from running it: a round robin plays
// N(N-1)/2 pairs × legs; a knockout pads to the next power of two with the byes to the top seeds
// (lib/division-builder/format-estimate.ts:43-46, "the padded draw's byes go to the top seeds"), and seed i meets
// seed S+1-i of the padded size S (C22; lib/format-templates.ts:104-107). Spec §7.3 step 3 names the bye holders:
// "With 3 sides seed 1 sits out; with 5, seeds 1 to 3; with 6, seeds 1 and 2."
import { afterEach, describe, expect, it, vi } from "vitest";
import { msg } from "@/lib/messages";
import { roundRoleLabel } from "@/lib/round-role-label";
import { previewDivisionFixtures, previewStageDraw } from "../stages";
import { quickMatchPreview, quickMatchStageInput, type QuickMatchPreviewRound } from "../quick-match-preview";

const pairs = (r: QuickMatchPreviewRound) =>
  new Set(r.lines.filter((l) => !l.bye).map((l) => [l.home.seed, l.away.seed].sort().join("v")));

describe("quickMatchPreview — counts", () => {
  // [3,1,3] and [5,2,20] are odd fields: where a round-robin phantom bye could leak into the count (pre-flight B4)
  it.each([
    [2, 1, 1],
    [2, 3, 3],
    [3, 1, 3],
    [4, 1, 6],
    [4, 2, 12],
    [5, 2, 20],
    [6, 4, 60],
  ])("league %i sides × %i plays = %i matches", (sides, plays, n) => {
    expect(quickMatchPreview({ format: "league", sides, plays }).matchCount).toBe(n);
  });

  // Knockout matches = sides − 1 (every match but the final sends one side home); byes = padded size − sides.
  // [5,4,3]: a naive "padded size − 1" constant says 7 matches, the right answer is 4 — the bye is not a match.
  it.each([
    [2, 1, 0],
    [3, 2, 1],
    [4, 3, 0],
    [5, 4, 3],
    [6, 5, 2],
  ])("knockout %i sides = %i matches, %i byes", (sides, n, byes) => {
    const p = quickMatchPreview({ format: "knockout", sides, plays: 1 });
    expect(p.matchCount).toBe(n);
    expect(p.byeCount).toBe(byes);
  });
});

describe("quickMatchPreview — the draw (C22)", () => {
  // Hand-derived from seed i v S+1−i of the padded size S, dropping the pairs whose S+1−i is past the field (byes):
  // 3 → S 4: 1v4 bye, 2v3 · 4 → 1v4, 2v3 · 5 → S 8: 1v8, 2v7, 3v6 byes, 4v5 · 6 → S 8: 1v8, 2v7 byes, 3v6, 4v5.
  it.each([
    [3, ["2v3"]],
    [4, ["1v4", "2v3"]],
    [5, ["4v5"]],
    [6, ["3v6", "4v5"]],
  ])("knockout of %i pairs %j in round one (C22)", (sides, expected) => {
    // the PAIRING is the assertion, not the line order
    expect(pairs(quickMatchPreview({ format: "knockout", sides, plays: 1 }).rounds[0]!)).toEqual(new Set(expected));
  });

  it.each([
    [3, [1]],
    [5, [1, 2, 3]],
    [6, [1, 2]],
  ])("knockout of %i: the byes go to seeds %j (spec §7.3 step 3)", (sides, holders) => {
    const r1 = quickMatchPreview({ format: "knockout", sides, plays: 1 }).rounds[0]!;
    expect(r1.lines.filter((l) => l.bye).map((l) => l.home.seed).sort()).toEqual(holders);
    // The generator's own bye fixtures, read raw (the fold blanks a bye's away seat, so its output cannot witness
    // this): nobody sits opposite a bye holder and nothing feeds that seat.
    const rawByes = previewStageDraw(quickMatchStageInput({ format: "knockout", plays: 1, name: "x" }), sides).filter((f) => f.bye);
    expect(rawByes).toHaveLength(holders.length);
    expect(rawByes.map((f) => [f.awaySeed, f.awayFrom])).toEqual(holders.map(() => [null, null]));
  });

  // The rulebook names a knockout round by its distance from the final: final, semi-final, quarter-final. The padded
  // size S has log2(S) rounds: 2 sides → S 2 (1 round), 3–4 → S 4 (2), 5–6 → S 8 (3).
  it.each([
    [2, ["final"]],
    [3, ["semi_final", "final"]],
    [4, ["semi_final", "final"]],
    [5, ["quarter_final", "semi_final", "final"]],
    [6, ["quarter_final", "semi_final", "final"]],
  ])("knockout of %i: the rounds are %j", (sides, roles) => {
    const p = quickMatchPreview({ format: "knockout", sides, plays: 1 });
    expect(p.rounds.map((r) => r.role?.kind)).toEqual(roles);
    // every line of a round sits in it (the fold takes the round's role from its first line)
    expect(p.rounds.map((r) => r.roundNo)).toEqual(roles.map((_, i) => i + 1));
  });

  it("a later knockout round names its sides by feeder, never by seed or by text, and every knockout round carries the engine's role", () => {
    const p = quickMatchPreview({ format: "knockout", sides: 4, plays: 1 });
    const [final] = p.rounds[1]!.lines;
    expect(final!.home.seed).toBeNull();
    expect(final!.away.seed).toBeNull();
    const feeders = [final!.home.feeder, final!.away.feeder];
    expect(feeders.every((f) => f?.round === 1)).toBe(true);
    expect(new Set(feeders.map((f) => f!.seq)).size).toBe(2);
    expect(p.rounds.every((r) => r.role !== null)).toBe(true);
    expect(quickMatchPreview({ format: "league", sides: 4, plays: 1 }).rounds.every((r) => r.role === null)).toBe(true);
  });

  it("matchCount, byeCount and the round names equal previewDivisionFixtures' for every format, side count and plays (C17 differential)", () => {
    const bye = msg("bracket.slot.bye"); // a test file: the bye-render-sites scan reads non-test files only
    let checked = 0;
    for (const format of ["league", "knockout"] as const)
      for (let sides = 2; sides <= 6; sides++)
        for (const plays of format === "league" ? [1, 2, 3, 4] : [1]) {
          const label = `${format} ${sides}×${plays}`;
          const sections = previewDivisionFixtures([quickMatchStageInput({ format, plays, name: "x" })], sides)[0]!.sections;
          const lines = sections.flatMap((s) => s.matches);
          const p = quickMatchPreview({ format, sides, plays });
          expect(p.matchCount, label).toBe(lines.filter((m) => m.away !== bye).length);
          expect(p.byeCount, label).toBe(lines.filter((m) => m.away === bye).length);
          // A round robin's odd field sits one side out per round, but that is no fixture: never a bye line.
          if (format === "league") expect(p.byeCount, label).toBe(0);
          // Each round's typed role, named the way the text preview names it, is that preview's section title.
          expect(
            p.rounds.map((r) => (r.role ? roundRoleLabel(msg, r.role) : msg("bracket.round.plain", { n: r.roundNo }))),
            label,
          ).toEqual(sections.map((s) => s.title));
          checked++;
        }
    expect(checked).toBe(25); // 5 side counts × (4 plays + 1): anti-vacuity
  });

  it("every seat a quick match knockout feeds is a WINNER feed — the only kind the preview's feeder can name", () => {
    // A quick match knockout carries no third place (W4 G4 keeps the Shared default, spec §10), so no seat is ever
    // fed by a loser; quickMatchPreview refuses one rather than call it "the winner of" (see the guard test below).
    let feeds = 0;
    for (let sides = 2; sides <= 6; sides++) {
      for (const f of previewStageDraw(quickMatchStageInput({ format: "knockout", plays: 1, name: "x" }), sides)) {
        for (const from of [f.homeFrom, f.awayFrom]) {
          if (!from) continue;
          expect(from.side, `${sides} sides R${f.roundNo}·${f.seqInRound}`).toBe("winner");
          feeds++;
        }
      }
    }
    // Hand count: a padded draw of S has S−2 fed seats (every round after the first, two seats per match):
    // S = 2, 4, 4, 8, 8 for 2..6 sides → 0 + 2 + 2 + 6 + 6.
    expect(feeds).toBe(16);
  });
});

describe("quickMatchStageInput — ONE stage input for the preview and the create (pre-flight A8)", () => {
  it("a league carries its plays as legs; a knockout carries no config at all, whatever plays says", () => {
    expect(quickMatchStageInput({ format: "league", plays: 3, name: "Sunday" })).toEqual({
      kind: "league",
      name: "Sunday",
      config: { legs: 3 },
      progression: null,
    });
    expect(quickMatchStageInput({ format: "knockout", plays: 3, name: "Sunday" })).toEqual({
      kind: "knockout",
      name: "Sunday",
      config: {},
      progression: null,
    });
  });
});

describe("quickMatchPreview — inputs the create would refuse (CreateQuickMatch: 2..6 sides, 1..4 plays)", () => {
  // The empty case. The generator's preview clamps a field below two up to two, so without this refusal one side
  // would preview as "1 match" — a count for a draw the create refuses (CreateQuickMatch.sides .min(2)).
  it.each([
    ["one side", { format: "league", sides: 1, plays: 1 }],
    ["seven sides", { format: "knockout", sides: 7, plays: 1 }],
    ["a fractional side count", { format: "league", sides: 2.5, plays: 1 }],
    ["zero plays", { format: "league", sides: 4, plays: 0 }],
    ["five plays", { format: "knockout", sides: 4, plays: 5 }],
  ] as const)("refuses %s", (_label, input) => {
    expect(() => quickMatchPreview(input)).toThrow(RangeError);
  });

  it("accepts both ends of the range", () => {
    expect(quickMatchPreview({ format: "league", sides: 2, plays: 1 }).matchCount).toBe(1);
    expect(quickMatchPreview({ format: "league", sides: 6, plays: 4 }).matchCount).toBe(60);
  });
});

describe("previewStageDraw — structure only, nothing quick-match specific", () => {
  it("a format generate() cannot draw ahead of results returns no fixtures, as the text preview shows none", () => {
    // swiss pairs from live standings; generate() refuses it, and the text preview's own catch shows no lines.
    expect(previewStageDraw({ kind: "swiss", name: "x", config: {}, progression: null }, 6)).toEqual([]);
    expect(previewStageDraw({ kind: "no_such_kind", name: "x", config: {}, progression: null }, 4)).toEqual([]);
  });

  it("a knockout with a third-place match feeds it from the semi-finals' LOSERS, and says so", () => {
    // The third-place match is played by the two beaten semi-finalists: for 4 sides, the losers of R1·1 and R1·2.
    const draw = previewStageDraw({ kind: "knockout", name: "x", config: { thirdPlace: true }, progression: null }, 4);
    const loserFed = draw.filter((f) => f.homeFrom?.side === "loser" || f.awayFrom?.side === "loser");
    expect(loserFed).toHaveLength(1);
    const [third] = loserFed;
    expect([third!.homeFrom, third!.awayFrom].map((x) => `${x!.side}:${x!.round}·${x!.seq}`).sort()).toEqual([
      "loser:1·1",
      "loser:1·2",
    ]);
    expect(third!.role).toEqual({ kind: "third_place" });
  });
});

describe("quickMatchPreview — a seat it cannot name is refused, never shown blank or mislabeled", () => {
  afterEach(() => {
    vi.doUnmock("../stages");
    vi.resetModules();
  });

  const fixture = { roundNo: 2, seqInRound: 1, homeSeed: null, awaySeed: null, bye: false, role: null };
  it.each([
    ["a loser feed", [{ ...fixture, homeFrom: { round: 1, seq: 1, side: "loser" }, awayFrom: { round: 1, seq: 2, side: "winner" } }]],
    ["a match seat with neither seed nor feeder", [{ ...fixture, homeFrom: null, awayFrom: { round: 1, seq: 2, side: "winner" } }]],
    ["a draw of no fixtures", []],
    ["a bye with its away seat filled", [{ ...fixture, roundNo: 1, homeSeed: 1, awaySeed: 4, homeFrom: null, awayFrom: null, bye: true }]],
  ])("refuses %s", async (_label, drawn) => {
    // The real generator never produces any of these for a quick match stage (the sweeps above); a stub draw reaches
    // the guard. The next test is its positive pair: the same stub with well-formed seats is accepted.
    vi.resetModules();
    vi.doMock("../stages", () => ({ previewStageDraw: () => drawn }));
    const { quickMatchPreview: fresh } = await import("../quick-match-preview");
    expect(() => fresh({ format: "knockout", sides: 4, plays: 1 })).toThrow(/^quickMatchPreview cannot name /);
  });

  it("the stubbed path accepts a well-formed draw (so the refusals above are the seat's, not the stub's)", async () => {
    vi.resetModules();
    const good = { ...fixture, homeFrom: { round: 1, seq: 1, side: "winner" }, awayFrom: { round: 1, seq: 2, side: "winner" } };
    vi.doMock("../stages", () => ({ previewStageDraw: () => [good] }));
    const { quickMatchPreview: fresh } = await import("../quick-match-preview");
    expect(fresh({ format: "knockout", sides: 4, plays: 1 })).toEqual({
      matchCount: 1,
      byeCount: 0,
      rounds: [{ roundNo: 2, role: null, lines: [{ home: { seed: null, feeder: { round: 1, seq: 1 } }, away: { seed: null, feeder: { round: 1, seq: 2 } }, bye: false }] }],
    });
  });
});
