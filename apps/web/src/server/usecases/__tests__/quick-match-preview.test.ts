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
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { QUICK_MATCH_KNOCKOUT_MIN_SIDES, QUICK_MATCH_SEMIS_MIN_SIDES } from "@/lib/quick-match-constants";
import {
  quickMatchPreview,
  quickMatchStageCount,
  quickMatchStageInputs,
  type QuickMatchFormat,
  type QuickMatchPreview,
  type QuickMatchPreviewRound,
  type QuickMatchStageInput,
} from "../quick-match-preview";

/** The one stage of a League or a Knockout (`quickMatchStageInputs` answers one for both). */
const onlyStage = (format: "league" | "knockout", plays = 1, name = "x"): QuickMatchStageInput => {
  const inputs = quickMatchStageInputs({ format, plays, name, qualifiers: null });
  if (inputs.length !== 1) throw new Error(`premise: a ${format} is one stage, got ${inputs.length}`);
  return inputs[0]!;
};

/** The byes the preview draws: its own bye lines (the preview no longer counts them; nothing in production read the count). */
const byesOf = (p: QuickMatchPreview) => p.rounds.flatMap((r) => r.lines).filter((l) => l.bye).length;

const pairs = (r: QuickMatchPreviewRound) =>
  new Set(r.lines.filter((l) => !l.bye).map((l) => [l.home.seed, l.away.seed].sort().join("v")));

describe("quickMatchPreview — counts", () => {
  // [3,1,3] and [5,2,20] are odd fields: where a round-robin phantom bye could leak into the count (pre-flight B4)
  it.each([
    [2, 1, 1],
    [2, 2, 2],
    [3, 1, 3],
    [4, 1, 6],
    [4, 2, 12],
    [5, 2, 20],
    [6, 2, 30],
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
    expect(byesOf(p)).toBe(byes);
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
    const rawByes = previewStageDraw(onlyStage("knockout"), sides).filter((f) => f.bye);
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

  it("matchCount, the byes and the round names equal previewDivisionFixtures' for every format, side count and plays (C17 differential)", () => {
    const bye = msg("bracket.slot.bye"); // a test file: the bye-render-sites scan reads non-test files only
    let checked = 0;
    for (const format of ["league", "knockout"] as const)
      for (let sides = 2; sides <= 6; sides++)
        for (const plays of format === "league" ? [1, 2] : [1]) {
          const label = `${format} ${sides}×${plays}`;
          const sections = previewDivisionFixtures([onlyStage(format, plays)], sides)[0]!.sections;
          const lines = sections.flatMap((s) => s.matches);
          const p = quickMatchPreview({ format, sides, plays });
          expect(p.matchCount, label).toBe(lines.filter((m) => m.away !== bye).length);
          expect(byesOf(p), label).toBe(lines.filter((m) => m.away === bye).length);
          // A round robin's odd field sits one side out per round, but that is no fixture: never a bye line.
          if (format === "league") expect(byesOf(p), label).toBe(0);
          // Each round's typed role, named the way the text preview names it, is that preview's section title.
          expect(
            p.rounds.map((r) => (r.role ? roundRoleLabel(msg, r.role) : msg("bracket.round.plain", { n: r.roundNo }))),
            label,
          ).toEqual(sections.map((s) => s.title));
          checked++;
        }
    expect(checked).toBe(15); // 5 side counts × (2 plays + 1): anti-vacuity
  });

  it("every seat a quick match knockout feeds is a WINNER feed — the only kind the preview's feeder can name", () => {
    // A quick match knockout carries no third place (W4 G4 keeps the Shared default, spec §10), so no seat is ever
    // fed by a loser; quickMatchPreview refuses one rather than call it "the winner of" (see the guard test below).
    let feeds = 0;
    for (let sides = 2; sides <= 6; sides++) {
      for (const f of previewStageDraw(onlyStage("knockout"), sides)) {
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

describe("quickMatchStageInputs — ONE stage graph for the preview and the create (pre-flight A8; plan 5 T3)", () => {
  it("a league carries its plays as legs; a knockout carries no config at all, whatever plays says: one stage each", () => {
    expect(quickMatchStageInputs({ format: "league", plays: 3, name: "Sunday", qualifiers: null })).toEqual([
      { kind: "league", name: "Sunday", config: { legs: 3 }, progression: null },
    ]);
    expect(quickMatchStageInputs({ format: "knockout", plays: 3, name: "Sunday", qualifiers: null })).toEqual([
      { kind: "knockout", name: "Sunday", config: {}, progression: null },
    ]);
  });

  it.each([2, 4] as const)(
    "a League + Knockout (top %i): the league with its plays as legs, then the league_ko template's knockout stage, named after the match",
    (q) => {
      // The authority is the organiser's own template (lib/format-templates.ts `league_ko`, P1): its SECOND stage, built for q.
      const template = STAGE_TEMPLATES.find((t) => t.key === "league_ko");
      expect(template, "premise: the league_ko template exists").toBeDefined();
      const [, templateKnockout] = template!.build({ qualified: q, swissRounds: 1, poolCount: 1, legs: 1 });
      expect(templateKnockout?.kind, "premise: the template's second stage is its knockout").toBe("knockout");
      const inputs = quickMatchStageInputs({ format: "league_knockout", plays: 2, name: "Sunday", qualifiers: q });
      expect(inputs).toEqual([
        { kind: "league", name: "Sunday", config: { legs: 2 }, progression: null },
        { ...templateKnockout, name: "Sunday" },
      ]);
      // …and the spec's own words (§3, §7, D1), not only the template's: the top q of the previous stage, in rank order,
      // drawn at setup so the bracket shows from the start. The count lives here and nowhere else.
      expect(inputs[1]!.progression).toEqual({
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: q }] }],
        placement: "rank_order",
        timing: "setup",
      });
    },
  );

  it("a format and a count that disagree are refused as a fault (the schema's rule, kept for callers that never parsed one)", () => {
    const cases: [QuickMatchFormat, 2 | 4 | null][] = [["league_knockout", null], ["league", 2], ["league", 4], ["knockout", 4]];
    let refused = 0;
    for (const [format, qualifiers] of cases) {
      expect(() => quickMatchStageInputs({ format, plays: 1, name: "x", qualifiers }), `${format} with ${qualifiers}`).toThrow(/qualifiers/);
      refused++;
    }
    expect(refused).toBe(4);
  });

  it("quickMatchStageCount is the stage graph's length, for every format (the rename and the home read it)", () => {
    // Expected from the spec: a League and a Knockout are one stage, a League + Knockout two (D10).
    const owed: Record<QuickMatchFormat, number> = { league: 1, knockout: 1, league_knockout: 2 };
    let checked = 0;
    for (const format of Object.keys(owed) as QuickMatchFormat[]) {
      const qualifiers = format === "league_knockout" ? 2 : null;
      expect(quickMatchStageCount(format), format).toBe(owed[format]);
      expect(quickMatchStageInputs({ format, plays: 1, name: "x", qualifiers }), format).toHaveLength(owed[format]);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("quickMatchPreview — League + Knockout: the league, then the knockout of the top q (plan 5 T3, mockup §6)", () => {
  // The mockup's own numbers (the Start button): 6 sides Once + semis = 15 + 3; Twice = 30 + 3; 3 sides Once + final = 3 + 1.
  it.each([
    [6, 1, 4, 18],
    [6, 2, 4, 33],
    [3, 1, 2, 4],
  ] as const)("%i sides × %i plays, top %i = %i matches", (sides, plays, qualifiers, n) => {
    expect(quickMatchPreview({ format: "league_knockout", sides, plays, qualifiers }).matchCount).toBe(n);
  });

  it("its rounds are the league's: the knockout is counted, not drawn (the bracket waits on the table)", () => {
    const p = quickMatchPreview({ format: "league_knockout", sides: 4, plays: 1, qualifiers: 4 });
    const league = quickMatchPreview({ format: "league", sides: 4, plays: 1 });
    expect(p.rounds).toEqual(league.rounds);
    expect(p.rounds.every((r) => r.role === null)).toBe(true);
    // 4·3/2 league + 3 knockout: the knockout counts though no round of it is shown.
    expect(p.matchCount).toBe(6 + 3);
  });

  it("every combination equals the organiser preview of the same two stages (previewDivisionFixtures sizes the knockout from its progression)", () => {
    const bye = msg("bracket.slot.bye");
    let checked = 0;
    for (const qualifiers of [2, 4] as const)
      for (let sides = qualifiers === 4 ? QUICK_MATCH_SEMIS_MIN_SIDES : QUICK_MATCH_KNOCKOUT_MIN_SIDES; sides <= 6; sides++)
        for (const plays of [1, 2]) {
          const phases = previewDivisionFixtures(quickMatchStageInputs({ format: "league_knockout", plays, name: "x", qualifiers }), sides);
          expect(phases, `${sides}×${plays} top ${qualifiers}: two phases`).toHaveLength(2);
          const lines = phases.flatMap((ph) => ph.sections.flatMap((s) => s.matches)).filter((m) => m.away !== bye);
          expect(quickMatchPreview({ format: "league_knockout", sides, plays, qualifiers }).matchCount, `${sides}×${plays} top ${qualifiers}`)
            .toBe(lines.length);
          checked++;
        }
    // q = 2: 3..6 sides; q = 4: 4..6 sides; each Once and Twice.
    expect(checked).toBe((4 + 3) * 2);
  });

  it.each([
    ["two sides (§3: no knockout row)", { sides: 2, qualifiers: 2 }],
    ["semi-finals of three (§3)", { sides: 3, qualifiers: 4 }],
  ] as const)("refuses %s, as the create does", (_label, { sides, qualifiers }) => {
    expect(() => quickMatchPreview({ format: "league_knockout", sides, plays: 1, qualifiers })).toThrow(RangeError);
  });

  it("refuses a League + Knockout with no count, and a count on any other format", () => {
    expect(() => quickMatchPreview({ format: "league_knockout", sides: 4, plays: 1 })).toThrow(/qualifiers/);
    expect(() => quickMatchPreview({ format: "league", sides: 4, plays: 1, qualifiers: 2 })).toThrow(/qualifiers/);
  });
});

describe("quickMatchPreview — inputs the create would refuse (CreateQuickMatch: 2..6 sides, 1..2 plays)", () => {
  // The empty case. The generator's preview clamps a field below two up to two, so without this refusal one side
  // would preview as "1 match" — a count for a draw the create refuses (CreateQuickMatch.sides .min(2)).
  it.each([
    ["one side", { format: "league", sides: 1, plays: 1 }],
    ["seven sides", { format: "knockout", sides: 7, plays: 1 }],
    ["a fractional side count", { format: "league", sides: 2.5, plays: 1 }],
    ["zero plays", { format: "league", sides: 4, plays: 0 }],
    // Owner 2026-11-12: "Each pair plays" is Once | Twice only, so three is the first refused value.
    ["three plays", { format: "league", sides: 4, plays: 3 }],
    ["five plays", { format: "knockout", sides: 4, plays: 5 }],
  ] as const)("refuses %s", (_label, input) => {
    expect(() => quickMatchPreview(input)).toThrow(RangeError);
  });

  it("accepts both ends of the range", () => {
    expect(quickMatchPreview({ format: "league", sides: 2, plays: 1 }).matchCount).toBe(1);
    expect(quickMatchPreview({ format: "league", sides: 6, plays: 2 }).matchCount).toBe(30); // 2 × 6·5/2
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
      rounds: [{ roundNo: 2, role: null, lines: [{ home: { seed: null, feeder: { round: 1, seq: 1 } }, away: { seed: null, feeder: { round: 1, seq: 2 } }, bye: false }] }],
    });
  });
});
