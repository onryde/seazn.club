// The /start funnel's one format layer (start-wizard redesign plan, Task 1): the cards' match counts, their time, the
// Best-fit pick and the stages the emailed claim builds all come from `lib/funnel-formats.ts`, so the preview and the
// built event cannot disagree (review focus 1). Every expected value here is read from a source the layer does not own:
// - the engine's own draw (`previewStageDraw`, the same `generate()` the real draw runs) and its Swiss pairer (`pairRound`),
//   simulated round by round with the higher seed winning every match;
// - the house's declarations (FORMAT_BOUNDS, swiss-rounds.ts's band table and rulebook-W3 bounds, `stageGraphSizeGate`,
//   `templatesForSport`, match-length.ts's per-sport lengths, `pickVariant`);
// - the owner-approved mock swr13a01 (A1: 16 players, 2 courts, 4 hours; A2: 12 players, 4 courts, 6 hours);
// - the sports catalogue's real writer (`scripts/sync-sports.ts`, driven against a recording fake);
// - the plan's pinned template table (the one table typed here, because the plan is its authority).
// Every sweep counts what it checked and fails on zero.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { pairKey, pairRound, type Colour, type SwissStanding } from "@seazn/engine/scheduling";
import { previewStageDraw, type PreviewDrawFixture } from "@/server/usecases/stages/preview";
import { buildTemplateStages, detectTemplate, templatesForSport, type StageDraft } from "@/lib/format-templates";
import { withinFormatBounds } from "@/lib/format-bounds";
import { stageGraphSizeGate } from "@/lib/format-size-gates";
import { judgeSwissRounds, swissRoundsDefault } from "@/lib/swiss-rounds";
import { defaultMatchMinutes } from "@/lib/match-length";
import { pickVariant } from "@/lib/preferred-variant";
import {
  FUNNEL_FORMATS,
  FUNNEL_MORE_FORMATS,
  funnelFormatKnobs,
  funnelFormatMin,
  funnelFormatRounds,
  funnelFormatStages,
  isFunnelFormat,
  type FunnelFormat,
} from "@/lib/funnel-formats";
import { bestFitSlug, rankFormats, type RankedFormat } from "@/lib/format-recommend";
import { FUNNEL_SPORTS, funnelSportByKeyOrName, funnelSportMatchMinutes, type FunnelSport } from "@/lib/funnel-sports";
import { syncSports } from "../../../../../scripts/sync-sports.ts";
import { engineEntrantKinds } from "./_engine-entrant-kinds";

const ALL: readonly FunnelFormat[] = [...FUNNEL_FORMATS, ...FUNNEL_MORE_FORMATS];

/** The plan's pinned template table (Task 1 "Values pinned"). */
const PINNED_TEMPLATE: Record<FunnelFormat, string> = {
  league: "league",
  "groups-knockout": "groups_ko",
  knockout: "knockout",
  swiss: "swiss",
  double_elim: "double_elim",
};

/** previewStageDraw clamps its field to 64 (plan N5), so the engine sweeps stop there. */
const PREVIEW_MAX = 64;

const sportByKey = (key: string): FunnelSport => FUNNEL_SPORTS.find((s) => s.key === key)!;
const BADMINTON = funnelSportMatchMinutes(sportByKey("badminton"));

interface Played {
  /** Matches played in each round, in round order (zeros included: a round of walkovers plays nothing). */
  rounds: number[];
  /** Matches each seed (1..field) played. */
  games: Map<number, number>;
  /** Seeds that hold a seat anywhere in the draw. */
  seated: Set<number>;
}

/** Plays an engine draw with the higher seed winning every match. A seat is held by a seed, by the winner of a fixture
 *  with anyone in it (a bye's holder walks through), or by the loser of a fixture that was played — so a bye's empty seat
 *  is not a match, and neither is a losers'-bracket board fed by a bye's missing loser. Read off the engine's own feed
 *  graph, never a formula. A feed from a fixture not yet played is an assumption broken, refused by name. */
function playDraw(draw: readonly PreviewDrawFixture[]): Played {
  const at = (round: number, seq: number) => `${round}:${seq}`;
  const result = new Map<string, { winner: number | null; loser: number | null }>();
  const perRound = new Map<number, number>();
  const games = new Map<number, number>();
  const seated = new Set<number>();
  const ordered = [...draw].sort((a, b) => a.roundNo - b.roundNo || a.seqInRound - b.seqInRound);
  const seat = (seed: number | null, from: PreviewDrawFixture["homeFrom"]): number | null => {
    if (seed !== null) return seed;
    if (from === null) return null;
    const source = result.get(at(from.round, from.seq));
    if (source === undefined) throw new Error(`draw feeds from a fixture not yet played (${at(from.round, from.seq)})`);
    return from.side === "winner" ? source.winner : source.loser;
  };
  for (const f of ordered) {
    if (f.homeSeed !== null) seated.add(f.homeSeed);
    if (f.awaySeed !== null) seated.add(f.awaySeed);
    const home = seat(f.homeSeed, f.homeFrom);
    const away = seat(f.awaySeed, f.awayFrom);
    perRound.set(f.roundNo, perRound.get(f.roundNo) ?? 0);
    if (home !== null && away !== null) {
      perRound.set(f.roundNo, perRound.get(f.roundNo)! + 1);
      games.set(home, (games.get(home) ?? 0) + 1);
      games.set(away, (games.get(away) ?? 0) + 1);
      result.set(at(f.roundNo, f.seqInRound), { winner: Math.min(home, away), loser: Math.max(home, away) });
    } else {
      result.set(at(f.roundNo, f.seqInRound), { winner: home ?? away, loser: null });
    }
  }
  const rounds = [...perRound.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  return { rounds, games, seated };
}

/** The engine pairs a Swiss of `n` over `rounds` rounds (higher seed wins every board); null when a round is refused. With
 *  `chess`, the pairer works under the colour limits (white = home), as it does for the chess sport. */
function playSwiss(n: number, rounds: number, chess: boolean): Played | null {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const id = (seed: number) => `e${seed}`;
  const score = new Map(ids.map((s) => [id(s), 0]));
  const colours = new Map<string, Colour[]>(ids.map((s) => [id(s), []]));
  const played = new Set<string>();
  const byes = new Set<string>();
  const games = new Map<number, number>(ids.map((s) => [s, 0]));
  const perRound: number[] = [];
  for (let round = 1; round <= rounds; round++) {
    const standings: SwissStanding[] = ids
      .map(id)
      .sort((a, b) => score.get(b)! - score.get(a)! || Number(a.slice(1)) - Number(b.slice(1)))
      .map((entrantId, i) => ({ entrantId, score: score.get(entrantId)!, rank: i + 1 }));
    const pairing = pairRound(standings, { played, byes, colours }, { chess });
    if (!pairing.ok) return null;
    for (const p of pairing.pairings) {
      played.add(pairKey(p.home, p.away));
      const winner = Number(p.home.slice(1)) < Number(p.away.slice(1)) ? p.home : p.away;
      score.set(winner, score.get(winner)! + 1);
      colours.get(p.home)!.push("W");
      colours.get(p.away)!.push("B");
      for (const side of [p.home, p.away]) games.set(Number(side.slice(1)), games.get(Number(side.slice(1)))! + 1);
    }
    if (pairing.bye !== undefined) {
      byes.add(pairing.bye);
      score.set(pairing.bye, score.get(pairing.bye)! + 1);
    }
    perRound.push(pairing.pairings.length);
  }
  return { rounds: perRound, games, seated: new Set(ids) };
}

/** A fed stage's field and how many of each pool it takes, read off its own take rules and its source's pools. The
 *  funnel's one fed stage is Groups + knockout's bracket; any other rule is an assumption broken, refused by name. */
function fedTake(stage: StageDraft, source: StageDraft): { field: number; perPool: number } {
  const pools = (source.config.pools as { count?: number } | undefined)?.count ?? 1;
  let field = 0;
  let perPool = 0;
  for (const s of stage.progression?.sources ?? []) {
    for (const rule of s.take) {
      if (rule.kind === "topNPerGroup") {
        field += rule.n * pools;
        perPool += rule.n;
      } else if (rule.kind === "bestNth") field += rule.count;
      else throw new Error(`fedTake: unexpected take rule ${rule.kind}`);
    }
  }
  return { field, perPool };
}

/** The pools of a round-robin draw: the seeds each connected group of fixtures holds. */
function poolsOf(draw: readonly PreviewDrawFixture[]): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  for (const f of draw) {
    if (f.homeSeed === null || f.awaySeed === null) continue;
    parent.set(find(f.homeSeed), find(f.awaySeed));
  }
  const pools = new Map<number, number[]>();
  for (const f of draw) {
    for (const s of [f.homeSeed, f.awaySeed]) {
      if (s === null) continue;
      const root = find(s);
      if (!pools.has(root)) pools.set(root, []);
      if (!pools.get(root)!.includes(s)) pools.get(root)!.push(s);
    }
  }
  return [...pools.values()];
}

interface EngineDay {
  /** Every entrant holds a seat and every stage draws. */
  builds: boolean;
  /** Matches played per round across the whole graph, in play order, rounds with nothing to play dropped. */
  rounds: number[];
  /** The fewest matches any entrant is sure to play: the fewest in the engine's play-through, where an entrant counts a
   *  fed stage's matches only when the take rules seat everyone in its pool. */
  fewest: number;
}

/** What the engine makes of format `f` at `n`, built at the layer's own knobs through the plan's template (so a format
 *  below its minimum can still be asked). */
function engineDay(f: FunnelFormat, n: number): EngineDay {
  const stages = buildTemplateStages(PINNED_TEMPLATE[f], funnelFormatKnobs(f, n));
  if (stages.length > 2) throw new Error(`engineDay: ${f} builds ${stages.length} stages`);
  const root = stages[0]!;
  const fewestOf = (p: Played, field: number) => Math.min(...Array.from({ length: field }, (_, i) => p.games.get(i + 1) ?? 0));
  if (root.kind === "swiss") {
    const swiss = playSwiss(n, root.config.rounds as number, false);
    if (swiss === null) return { builds: false, rounds: [], fewest: 0 };
    return { builds: swiss.rounds.some((m) => m > 0), rounds: swiss.rounds.filter((m) => m > 0), fewest: fewestOf(swiss, n) };
  }
  const draw = previewStageDraw(root, n);
  const first = playDraw(draw);
  let builds = first.rounds.some((m) => m > 0) && first.seated.size === n;
  let rounds = first.rounds;
  let fewest = fewestOf(first, n);
  const fed = stages[1];
  if (fed !== undefined) {
    const { field, perPool } = fedTake(fed, root);
    const bracket = playDraw(previewStageDraw(fed, field));
    builds = builds && field >= 2 && field <= n && bracket.rounds.some((m) => m > 0);
    rounds = [...rounds, ...bracket.rounds];
    const bracketFewest = fewestOf(bracket, field);
    fewest = Math.min(
      ...poolsOf(draw).flatMap((pool) =>
        pool.map((seed) => (first.games.get(seed) ?? 0) + (pool.length <= perPool ? bracketFewest : 0)),
      ),
    );
  }
  return { builds, rounds: rounds.filter((m) => m > 0), fewest };
}

const ENGINE = new Map<string, EngineDay>();
const engine = (f: FunnelFormat, n: number): EngineDay => {
  const key = `${f}:${n}`;
  if (!ENGINE.has(key)) ENGINE.set(key, engineDay(f, n));
  return ENGINE.get(key)!;
};

/** The day the engine's rounds take, one after another: ⌈matches / courts⌉ slots of one match length per round. */
const engineMinutes = (rounds: readonly number[], courts: number, minutes: number) =>
  rounds.reduce((sum, m) => sum + Math.ceil(m / courts), 0) * minutes;

const rank = (n: number, courts: number, hours: number, matchMinutes = BADMINTON) =>
  rankFormats({ entrants: n, courts, hours, matchMinutes });
const card = (ranked: readonly RankedFormat[], slug: FunnelFormat) => ranked.find((r) => r.slug === slug)!;

describe("the funnel's format layer", () => {
  it("League is always offered and available at every n 2..256", () => {
    let checked = 0;
    for (let n = 2; n <= 256; n++) {
      for (let courts = 1; courts <= 4; courts++) {
        for (let hours = 1; hours <= 8; hours++) {
          expect(card(rank(n, courts, hours), "league")?.available, `n=${n} c=${courts} h=${hours}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBe(255 * 4 * 8);
  });

  it("fixed display order for every input in the wizard's range (n 2..256, courts 1..4, hours 1..8, every sport)", () => {
    let checked = 0;
    const wrong: string[] = [];
    for (const s of FUNNEL_SPORTS) {
      const minutes = funnelSportMatchMinutes(s);
      for (let n = 2; n <= 256; n++) {
        for (let courts = 1; courts <= 4; courts++) {
          for (let hours = 1; hours <= 8; hours++) {
            const slugs = rank(n, courts, hours, minutes).map((r) => r.slug).join(",");
            if (slugs !== ALL.join(",")) wrong.push(`${s.key} n=${n} c=${courts} h=${hours}: ${slugs}`);
            checked++;
          }
        }
      }
    }
    expect(wrong.join("\n")).toBe("");
    expect(checked).toBe(FUNNEL_SPORTS.length * 255 * 4 * 8);
    expect(ALL).toEqual(["league", "groups-knockout", "knockout", "swiss", "double_elim"]);
  });

  it("an input the wizard can hold while typing has no cards, and no cards wear no badge", () => {
    // A cleared stepper reads Number("") = 0; a ?entrants=1 link, a fraction, a cleared courts or hours box: the page
    // renders these on every keystroke, so the answer is an empty list, never a throw in render.
    const empties = [
      { entrants: 0, courts: 2, hours: 4, matchMinutes: 30 },
      { entrants: 1, courts: 2, hours: 4, matchMinutes: 30 },
      { entrants: Number.NaN, courts: 2, hours: 4, matchMinutes: 30 },
      { entrants: 7.5, courts: 2, hours: 4, matchMinutes: 30 },
      { entrants: 8, courts: 0, hours: 4, matchMinutes: 30 },
      { entrants: 8, courts: 2, hours: 0, matchMinutes: 30 },
      { entrants: 8, courts: 2, hours: Number.NaN, matchMinutes: 30 },
      { entrants: 8, courts: 2, hours: 4, matchMinutes: 0 },
    ];
    for (const input of empties) expect(rankFormats(input), JSON.stringify(input)).toEqual([]);
    expect(empties).toHaveLength(8);
    expect(bestFitSlug([])).toBeNull();
    // …and its positive pair: the smallest real field has every card.
    expect(rankFormats({ entrants: 2, courts: 1, hours: 1, matchMinutes: 30 })).toHaveLength(ALL.length);
  });

  it("no badge when nothing fits; the mock's A2 day picks the format that guarantees the most play", () => {
    // Mock A1's complaint: 40 players, 2 courts, 4 hours (badminton) — nothing fits, so nothing may wear Best fit.
    const forty = rank(40, 2, 4);
    expect(forty.filter((r) => r.fits)).toEqual([]);
    expect(bestFitSlug(forty)).toBeNull();
    // Mock A2 (12 players, 4 courts, 6 hours): League runs over. Of the rest, a 4-round Swiss on an even field
    // guarantees everyone 4 matches; Groups + knockout guarantees 3 (pools of four, only the top two play on); double
    // elimination 2, a knockout 1. So Swiss — not the first fitting card on the page.
    const a2 = rank(12, 4, 6);
    expect(a2.filter((r) => r.fits).map((r) => r.slug)).toEqual(["groups-knockout", "knockout", "swiss", "double_elim"]);
    expect(bestFitSlug(a2)).toBe("swiss");
  });

  it("a guaranteed-play tie goes to the format with fewer matches, not display order", () => {
    // 4 entrants, 1 court, 2 hours of 24-minute matches. Groups + knockout (two pools of two — everyone qualifies — then a
    // final four: 5 matches in 5 slots) and a 2-round Swiss (4 matches) both guarantee 2 matches each and both fit; Swiss
    // plays fewer, although Groups + knockout comes first on the page.
    const ranked = rank(4, 1, 2, 24);
    const g = card(ranked, "groups-knockout");
    const s = card(ranked, "swiss");
    expect([g.fits, s.fits, g.perEntrant === s.perEntrant, s.matches < g.matches]).toEqual([true, true, true, true]);
    expect(bestFitSlug(ranked)).toBe("swiss");
  });

  it("three entrants on one court for an hour: the knockout, where everyone plays, beats a Swiss where one sits out", () => {
    // n = 3: the house's Swiss is one round (safe maximum ⌊3/2⌋ = 1), whose bye leaves an entrant with no match at all; a
    // knockout (one bye, then a final) gives everyone at least one. Both fit the hour.
    const ranked = rank(3, 1, 1);
    expect([card(ranked, "swiss").fits, card(ranked, "swiss").perEntrant]).toEqual([true, 0]);
    expect([card(ranked, "knockout").fits, card(ranked, "knockout").perEntrant]).toEqual([true, 1]);
    expect(bestFitSlug(ranked)).toBe("knockout");
  });

  it("a format that runs over never wins, and the badge is reachable both ways (every sport's match length)", () => {
    let checked = 0;
    let winners = 0;
    let none = 0;
    const wrong: string[] = [];
    for (const s of FUNNEL_SPORTS) {
      const minutes = funnelSportMatchMinutes(s);
      for (let n = 2; n <= PREVIEW_MAX; n++) {
        for (let courts = 1; courts <= 4; courts++) {
          for (let hours = 1; hours <= 8; hours++) {
            const ranked = rank(n, courts, hours, minutes);
            const winner = bestFitSlug(ranked);
            checked++;
            if (winner === null) {
              none++;
              continue;
            }
            winners++;
            const row = card(ranked, winner);
            if (!(row.fits && row.available)) wrong.push(`${s.key} n=${n} c=${courts} h=${hours} ${winner}`);
          }
        }
      }
    }
    expect(wrong.join("\n")).toBe("");
    expect(checked).toBe(FUNNEL_SPORTS.length * 63 * 4 * 8);
    expect(winners).toBeGreaterThan(0);
    expect(none).toBeGreaterThan(0);
  });

  it("a card below its format's minimum never says Fits, however much time there is", () => {
    let below = 0;
    for (let n = 2; n <= 256; n++) {
      for (const r of rank(n, 32, 72, 10)) {
        if (r.available) continue;
        below++;
        expect(r.fits, `n=${n} ${r.slug}`).toBe(false);
      }
    }
    expect(below).toBeGreaterThan(0);
  });

  it("available is exactly what the engine can draw, and the house's size gate agrees (n 2..64; gate to 256)", () => {
    const counts = new Map<FunnelFormat, { on: number; off: number }>(ALL.map((f) => [f, { on: 0, off: 0 }]));
    for (let n = 2; n <= PREVIEW_MAX; n++) {
      for (const f of ALL) {
        const builds = engine(f, n).builds;
        expect(n >= funnelFormatMin(f), `${f} at n=${n}`).toBe(builds);
        const c = counts.get(f)!;
        if (builds) c.on++;
        else c.off++;
      }
    }
    for (const f of ALL) expect(counts.get(f)!.on, f).toBeGreaterThan(0);
    // Groups + knockout is the one format with a real floor: two pools of two (C38 refuses a pool of one).
    expect(counts.get("groups-knockout")!.off).toBeGreaterThan(0);
    // lib/format-size-gates.ts declares the fields a stage graph can be played on; no funnel graph may be refused by it.
    let gated = 0;
    for (const f of ALL) {
      for (let n = funnelFormatMin(f); n <= 256; n++) {
        expect(stageGraphSizeGate(funnelFormatStages(f, n), n), `${f} at n=${n}`).toBeNull();
        gated++;
      }
    }
    expect(gated).toBe(ALL.reduce((sum, f) => sum + 257 - funnelFormatMin(f), 0));
  });

  it("each card's rounds, matches and guaranteed play equal the engine's own play-through (n 2..64)", () => {
    const checked = new Map<FunnelFormat, number>(ALL.map((f) => [f, 0]));
    const wrong: string[] = [];
    for (let n = 2; n <= PREVIEW_MAX; n++) {
      const ranked = rank(n, 2, 4);
      for (const f of ALL) {
        if (n < funnelFormatMin(f)) continue;
        const day = engine(f, n);
        const rounds = funnelFormatRounds(f, n).filter((m) => m > 0);
        if (rounds.join(",") !== day.rounds.join(",")) wrong.push(`${f} n=${n} rounds ${rounds} vs engine ${day.rounds}`);
        const r = card(ranked, f);
        const engineMatches = day.rounds.reduce((a, b) => a + b, 0);
        if (r.matches !== engineMatches) wrong.push(`${f} n=${n} matches ${r.matches} vs engine ${engineMatches}`);
        if (r.perEntrant !== day.fewest) wrong.push(`${f} n=${n} perEntrant ${r.perEntrant} vs engine ${day.fewest}`);
        checked.set(f, checked.get(f)! + 1);
      }
    }
    expect(wrong.join("\n")).toBe("");
    for (const f of ALL) expect(checked.get(f), f).toBeGreaterThan(0);
  });

  it("each card's time and Fits tag are the engine's rounds played one after another, at every sport's match length", () => {
    let checked = 0;
    const wrong: string[] = [];
    for (const s of FUNNEL_SPORTS) {
      const minutes = funnelSportMatchMinutes(s);
      for (let n = 2; n <= PREVIEW_MAX; n++) {
        for (let courts = 1; courts <= 4; courts++) {
          for (const hours of [1, 2, 4, 6, 8, 12, 24]) {
            for (const r of rank(n, courts, hours, minutes)) {
              if (!r.available) continue;
              const need = engineMinutes(engine(r.slug, n).rounds, courts, minutes);
              const hoursShown = Math.round((need / 60) * 10) / 10;
              if (r.estHours !== hoursShown || r.fits !== need <= hours * 60) {
                wrong.push(`${s.key} ${r.slug} n=${n} c=${courts} h=${hours}: ${r.estHours}h ${r.fits} vs ${hoursShown}h`);
              }
              checked++;
            }
          }
        }
      }
    }
    expect(wrong.join("\n")).toBe("");
    expect(checked).toBeGreaterThan(FUNNEL_SPORTS.length * 63 * 4 * 7 * 3);
  });

  it("the mock's cards: A1 (16 players, 2 courts, 4 hours) and A2 (12, 4 courts, 6 hours), badminton", () => {
    // swr13a01 §2 B2 / §1 A2, owner-approved: matches and the Fits / Runs over tag. Swiss plays the house's recommended
    // rounds (controller ruling m1, the band table), so its count is the Rules card's, not the mock's ⌈log2 n⌉ + 1.
    const a1 = rank(16, 2, 4);
    expect((["league", "groups-knockout", "knockout"] as const).map((s) => [card(a1, s).matches, card(a1, s).fits])).toEqual([
      [120, false],
      [31, false],
      [15, true],
    ]);
    expect([card(a1, "swiss").matches, card(a1, "swiss").fits]).toEqual([swissRoundsDefault(16) * 8, false]);
    const a2 = rank(12, 4, 6);
    expect((["league", "groups-knockout", "knockout"] as const).map((s) => [card(a2, s).matches, card(a2, s).fits])).toEqual([
      [66, false],
      [23, true],
      [11, true],
    ]);
    expect([card(a2, "swiss").matches, card(a2, "swiss").fits]).toEqual([swissRoundsDefault(12) * 6, true]);
  });

  it("each format builds the plan's template, every stage inside the house's format bounds (n min..256)", () => {
    let checked = 0;
    for (const f of ALL) {
      for (let n = funnelFormatMin(f); n <= 256; n++) {
        const stages = funnelFormatStages(f, n);
        expect(detectTemplate(stages), `${f} at n=${n}`).toBe(PINNED_TEMPLATE[f]);
        for (const s of stages) {
          const legs = s.config.legs;
          if (legs !== undefined) expect(withinFormatBounds("legs", legs as number)).toBe(true);
          const pools = (s.config.pools as { count?: number } | undefined)?.count;
          if (pools !== undefined) expect(withinFormatBounds("pools", pools), `${f} n=${n} pools ${pools}`).toBe(true);
          if (s.kind === "swiss") expect(withinFormatBounds("swissRounds", s.config.rounds as number)).toBe(true);
        }
        if (f === "groups-knockout") {
          const q = fedTake(stages[1]!, stages[0]!).field;
          expect(withinFormatBounds("qualify", q) && q <= n, `${f} n=${n} qualified ${q}`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBe(ALL.reduce((sum, f) => sum + 257 - funnelFormatMin(f), 0));
  });

  it("the knobs never qualify more than the field or leave the house's bounds, at any n 2..256 (below a minimum too)", () => {
    // funnelFormatKnobs is the layer's exported seam (the claim and the wizard read it), so its knobs hold at every field,
    // not only at the fields a format can be built for.
    let checked = 0;
    for (const f of ALL) {
      for (let n = 2; n <= 256; n++) {
        const k = funnelFormatKnobs(f, n);
        expect(k.qualified <= n && k.qualified >= 2, `${f} n=${n} qualified ${k.qualified}`).toBe(true);
        expect(withinFormatBounds("pools", k.poolCount) && withinFormatBounds("swissRounds", k.swissRounds)).toBe(true);
        expect(withinFormatBounds("legs", k.legs)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(ALL.length * 255);
  });

  it("the Swiss it builds plays what its Rules card recommends, is never warned or refused, and pairs every round (chess too)", () => {
    // swiss-rounds.ts: the owner's band table capped at the safe maximum ⌊n/2⌋ is what a new Swiss's Rules card
    // recommends (`swissRoundsDefault`); rulebook-W3 §3.1/§3.2 warn above the safe maximum and refuse above the hard one.
    let judged = 0;
    for (let n = funnelFormatMin("swiss"); n <= 256; n++) {
      const rounds = funnelFormatStages("swiss", n)[0]!.config.rounds as number;
      expect(rounds, `n=${n}`).toBe(swissRoundsDefault(n));
      expect(judgeSwissRounds(rounds, n).verdict, `n=${n} rounds=${rounds}`).toBe("ok");
      judged++;
    }
    expect(judged).toBe(255);
    let paired = 0;
    for (let n = funnelFormatMin("swiss"); n <= PREVIEW_MAX; n++) {
      const rounds = funnelFormatStages("swiss", n)[0]!.config.rounds as number;
      expect(playSwiss(n, rounds, true), `chess n=${n} rounds=${rounds}`).not.toBeNull();
      paired++;
    }
    expect(paired).toBe(63);
  });

  it("every funnel format is one the builder offers every sport", () => {
    // The claim builds through the standard stage use-case; a format the builder would not offer a sport (chess is
    // individual-only, pair-minting kinds need individuals) must not be one the funnel builds for it.
    let checked = 0;
    for (const m of builtinModules) {
      const offered = new Set(templatesForSport(m.key, engineEntrantKinds(m.key)).map((t) => t.key));
      for (const f of ALL) {
        expect(offered.has(PINNED_TEMPLATE[f]), `${m.key} ${f}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(builtinModules.length * ALL.length);
    expect(builtinModules.length).toBeGreaterThan(1);
  });

  it("the claim path refuses by name what it cannot build: below a minimum, a fractional or tiny field, an unknown format", () => {
    expect(() => funnelFormatStages("groups-knockout", 3)).toThrow(RangeError);
    expect(funnelFormatStages("groups-knockout", 4)).toHaveLength(2);
    expect(() => funnelFormatStages("league", 1)).toThrow(RangeError);
    expect(() => funnelFormatKnobs("league", 7.5)).toThrow(RangeError);
    expect(() => funnelFormatKnobs("ladder" as FunnelFormat, 8)).toThrow(RangeError);
    expect(() => funnelFormatMin("ladder" as FunnelFormat)).toThrow(RangeError);
  });

  it("isFunnelFormat knows exactly the five slugs", () => {
    for (const f of ALL) expect(isFunnelFormat(f), f).toBe(true);
    for (const x of ["ladder", "groups_ko", "League", "", "constructor", "__proto__", null, undefined, 3, {}]) {
      expect(isFunnelFormat(x), String(x)).toBe(false);
    }
  });
});

/** The `sports.name` the catalogue sync writes for each engine key, read by driving `syncSports` against a fake `sql` that
 *  records each `insert into sports` — the real writer's own mapping, not a copy of it. */
async function syncedSportNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const fake = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (/insert into sports\b/.test(strings.join("?"))) names.set(values[0] as string, values[1] as string);
    return Promise.resolve([]);
  };
  const sql = Object.assign(fake, { json: (v: unknown) => v });
  await syncSports(sql as unknown as Parameters<typeof syncSports>[0]);
  return names;
}

/** The system variant the claim builds for an engine sport: `pickVariant` (lib/preferred-variant.ts, the pick
 *  lib/funnel.ts `resolveSport` makes) over the variants the catalogue sync writes, by key. */
function claimedVariant(module: string): string {
  const m = builtinModules.find((x) => x.key === module);
  if (m === undefined) throw new Error(`claimedVariant: no engine module '${module}'`);
  return pickVariant(module, Object.keys(m.variants).sort().map((key) => ({ key })));
}

describe("the funnel's sports", () => {
  it("every funnel sport but Other names a real sport, by the name the catalogue stores", async () => {
    const synced = await syncedSportNames();
    expect(synced.size).toBe(builtinModules.length);
    let checked = 0;
    for (const s of FUNNEL_SPORTS) {
      if (s.key === "other") continue;
      expect(synced.get(s.key), s.key).toBe(s.name);
      expect(s.module, s.key).toBe(s.key);
      checked++;
    }
    expect(checked).toBe(FUNNEL_SPORTS.length - 1);
    // …and Other is honestly not one (its positive pair above): no catalogue row carries its name, so the claim falls to
    // the generic module, which is a real one.
    const other = FUNNEL_SPORTS.filter((s) => s.key === "other");
    expect(other.map((s) => [s.name, s.module])).toEqual([["Other", "generic"]]);
    expect(synced.has("other")).toBe(false);
    expect([...synced.values()].map((v) => v.toLowerCase())).not.toContain("other");
    expect(synced.has("generic")).toBe(true);
  });

  it("each sport builds the variant the claim picks, and times its cards at that variant's match length", () => {
    let checked = 0;
    let notThirty = 0;
    for (const s of FUNNEL_SPORTS) {
      const variant = claimedVariant(s.module);
      expect(s.variant, s.key).toBe(variant);
      const minutes = defaultMatchMinutes(s.module, variant);
      expect(funnelSportMatchMinutes(s), s.key).toBe(minutes);
      if (minutes !== 30) notThirty++;
      checked++;
    }
    expect(checked).toBe(FUNNEL_SPORTS.length);
    // No silent cross-sport default: the house declares other lengths, and the cards use them.
    expect(notThirty).toBeGreaterThan(0);
  });

  it("at the mock's defaults (16, 2 courts, 4 hours) football, tennis and cricket fit nothing; badminton's knockout fits", () => {
    let checked = 0;
    for (const key of ["football", "tennis", "cricket"]) {
      const ranked = rank(16, 2, 4, funnelSportMatchMinutes(sportByKey(key)));
      expect(ranked.filter((r) => r.fits).map((r) => r.slug), key).toEqual([]);
      expect(bestFitSlug(ranked), key).toBeNull();
      checked++;
    }
    expect(checked).toBe(3);
    const badminton = rank(16, 2, 4, funnelSportMatchMinutes(sportByKey("badminton")));
    expect(card(badminton, "knockout").fits).toBe(true);
    expect(bestFitSlug(badminton)).toBe("knockout");
  });

  it("the mock's B1 chip order, keys and names unique, the list and its entries frozen", () => {
    expect(FUNNEL_SPORTS.map((s) => s.key)).toEqual([
      "badminton",
      "boardgame",
      "carrom",
      "football",
      "hockey",
      "icehockey",
      "tabletennis",
      "tennis",
      "volleyball",
      "cricket",
      "other",
    ]);
    expect(new Set(FUNNEL_SPORTS.map((s) => s.name.toLowerCase())).size).toBe(FUNNEL_SPORTS.length);
    expect(Object.isFrozen(FUNNEL_SPORTS)).toBe(true);
    let frozen = 0;
    for (const s of FUNNEL_SPORTS) {
      expect(Object.isFrozen(s), s.key).toBe(true);
      frozen++;
    }
    expect(frozen).toBe(FUNNEL_SPORTS.length);
    const found = funnelSportByKeyOrName("tennis")!;
    expect(() => {
      (found as { name: string }).name = "Padel";
    }).toThrow(TypeError);
    expect(funnelSportByKeyOrName("tennis")?.name).toBe("Tennis");
  });

  it("funnelSportByKeyOrName takes a key or a name in any case, and nothing else", () => {
    const hits: [string, string][] = [
      ["tabletennis", "tabletennis"],
      ["Table Tennis", "tabletennis"],
      ["table tennis", "tabletennis"],
      ["TABLETENNIS", "tabletennis"],
      ["boardgame", "boardgame"],
      ["Chess", "boardgame"],
      ["icehockey", "icehockey"],
      ["Ice Hockey", "icehockey"],
      ["Football", "football"],
      ["other", "other"],
    ];
    for (const [raw, key] of hits) expect(funnelSportByKeyOrName(raw)?.key, raw).toBe(key);
    let misses = 0;
    for (const raw of ["", "   ", "quidditch", "<script>", "generic", "Generic", "table-tennis", "constructor"]) {
      expect(funnelSportByKeyOrName(raw), raw).toBeNull();
      misses++;
    }
    expect(misses).toBe(8);
  });
});
