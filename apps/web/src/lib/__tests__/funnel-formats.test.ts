// The /start funnel's one format layer (start-wizard redesign plan, Task 1): the cards' match counts, the Best-fit pick
// and the stages the emailed claim builds all come from `lib/funnel-formats.ts`, so the preview and the built event cannot
// disagree (review focus 1). Every expected value here is read from a source the layer does not own:
// - the engine's own draw (`previewStageDraw`, the same `generate()` the real draw runs) and its Swiss pairer (`pairRound`);
// - the house's declarations (FORMAT_BOUNDS, the rulebook-W3 Swiss bounds in `swiss-rounds.ts`, `templatesForSport`);
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
import { judgeSwissRounds } from "@/lib/swiss-rounds";
import {
  FUNNEL_FORMATS,
  FUNNEL_MORE_FORMATS,
  funnelFormatKnobs,
  funnelFormatMin,
  funnelFormatStages,
  isFunnelFormat,
  type FunnelFormat,
} from "@/lib/funnel-formats";
import { bestFitSlug, rankFormats } from "@/lib/format-recommend";
import { FUNNEL_SPORTS, funnelSportByKeyOrName } from "@/lib/funnel-sports";
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

/** The fixtures of an engine draw that are actually PLAYED: both seats filled. A seat is filled by a seed, by the winner of
 *  a fixture with anyone in it (a bye's holder walks through), or by the loser of a fixture that is itself played — so a
 *  bye's empty seat is not counted, and neither is a losers'-bracket board fed by a bye's missing loser. Read off the
 *  engine's own feed graph, never a formula. */
function playedFixtures(draw: readonly PreviewDrawFixture[]): number {
  const at = (round: number, seq: number) => `${round}:${seq}`;
  const byPos = new Map(draw.map((f) => [at(f.roundNo, f.seqInRound), f]));
  const memo = new Map<string, readonly [boolean, boolean]>();
  const seats = (f: PreviewDrawFixture): readonly [boolean, boolean] => {
    const key = at(f.roundNo, f.seqInRound);
    const known = memo.get(key);
    if (known) return known;
    const seat = (seed: number | null, from: PreviewDrawFixture["homeFrom"]): boolean => {
      if (seed !== null) return true;
      if (from === null) return false;
      const source = byPos.get(at(from.round, from.seq));
      if (source === undefined) throw new Error(`draw feeds from a fixture it does not hold (${at(from.round, from.seq)})`);
      const [home, away] = seats(source);
      return from.side === "winner" ? home || away : home && away;
    };
    const both = [seat(f.homeSeed, f.homeFrom), seat(f.awaySeed, f.awayFrom)] as const;
    memo.set(key, both);
    return both;
  };
  return draw.filter((f) => {
    const [home, away] = seats(f);
    return home && away;
  }).length;
}

/** The engine pairs a Swiss of `n` over `rounds` rounds (higher seed wins every board); null when a round is refused. With
 *  `chess`, the pairer works under the colour limits (white = home), as it does for the chess sport. */
function swissPlayed(n: number, rounds: number, chess: boolean): number | null {
  const ids = Array.from({ length: n }, (_, i) => `e${i + 1}`);
  const score = new Map(ids.map((id) => [id, 0]));
  const colours = new Map<string, Colour[]>(ids.map((id) => [id, []]));
  const played = new Set<string>();
  const byes = new Set<string>();
  let boards = 0;
  for (let round = 1; round <= rounds; round++) {
    const standings: SwissStanding[] = [...ids]
      .sort((a, b) => score.get(b)! - score.get(a)! || ids.indexOf(a) - ids.indexOf(b))
      .map((entrantId, i) => ({ entrantId, score: score.get(entrantId)!, rank: i + 1 }));
    const result = pairRound(standings, { played, byes, colours }, { chess });
    if (!result.ok) return null;
    for (const p of result.pairings) {
      played.add(pairKey(p.home, p.away));
      score.set(p.home, score.get(p.home)! + 1);
      colours.get(p.home)!.push("W");
      colours.get(p.away)!.push("B");
    }
    if (result.bye !== undefined) {
      byes.add(result.bye);
      score.set(result.bye, score.get(result.bye)! + 1);
    }
    boards += result.pairings.length;
  }
  return boards;
}

/** How many entrants a fed stage's progression seats, read off its own take rules and its source's pools. The funnel's
 *  one fed stage is Groups + knockout's bracket; any other rule is an assumption broken, refused by name. */
function fedField(stage: StageDraft, source: StageDraft): number {
  const pools = (source.config.pools as { count?: number } | undefined)?.count ?? 1;
  let field = 0;
  for (const s of stage.progression?.sources ?? []) {
    for (const rule of s.take) {
      if (rule.kind === "topNPerGroup") field += rule.n * pools;
      else if (rule.kind === "bestNth") field += rule.count;
      else throw new Error(`fedField: unexpected take rule ${rule.kind}`);
    }
  }
  return field;
}

interface EngineVerdict {
  builds: boolean;
  played: number;
}

/** What the engine makes of format `f` at `n`, built at the layer's own knobs through the plan's template (so a format
 *  below its minimum can still be asked): does every entrant get a fixture and does every stage draw, and how many
 *  matches are played. */
function engineVerdict(f: FunnelFormat, n: number): EngineVerdict {
  const stages = buildTemplateStages(PINNED_TEMPLATE[f], funnelFormatKnobs(f, n));
  const root = stages[0]!;
  if (root.kind === "swiss") {
    const boards = swissPlayed(n, root.config.rounds as number, false);
    return { builds: boards !== null && boards > 0, played: boards ?? 0 };
  }
  const draw = previewStageDraw(root, n);
  const seated = new Set(draw.flatMap((d) => [d.homeSeed, d.awaySeed]).filter((s) => s !== null));
  let played = playedFixtures(draw);
  let builds = played > 0 && seated.size === n;
  const fed = stages[1];
  if (fed !== undefined) {
    const field = fedField(fed, root);
    const bracket = playedFixtures(previewStageDraw(fed, field));
    builds = builds && field >= 2 && field <= n && bracket > 0;
    played += bracket;
  }
  if (stages.length > 2) throw new Error(`engineVerdict: ${f} builds ${stages.length} stages`);
  return { builds, played };
}

const card = (n: number, courts: number, hours: number, slug: FunnelFormat) =>
  rankFormats({ entrants: n, courts, hours }).find((r) => r.slug === slug)!;

describe("the funnel's format layer", () => {
  it("League is always offered and available at every n 2..256", () => {
    let checked = 0;
    for (let n = 2; n <= 256; n++) {
      for (let courts = 1; courts <= 4; courts++) {
        for (let hours = 1; hours <= 8; hours++) {
          const league = rankFormats({ entrants: n, courts, hours }).find((r) => r.slug === "league");
          expect(league?.available, `n=${n} c=${courts} h=${hours}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBe(255 * 4 * 8);
  });

  it("no badge when nothing fits; the mock's A2 day picks the richest fitting format", () => {
    // Mock A1's complaint: 40 players, 2 courts, 4 hours — nothing fits, so nothing may wear Best fit.
    const forty = rankFormats({ entrants: 40, courts: 2, hours: 4 });
    expect(forty.filter((r) => r.fits)).toEqual([]);
    expect(bestFitSlug(forty)).toBeNull();
    // Mock A2: League runs over (66), Groups + knockout (23), Knockout (11) and Swiss (30, 5 rounds) fit; Swiss gives
    // each entrant the most play (5), so it is the pick — not the first fitting card in display order.
    expect(bestFitSlug(rankFormats({ entrants: 12, courts: 4, hours: 6 }))).toBe("swiss");
  });

  it("a perEntrant tie goes to the format with fewer matches, not display order", () => {
    // 4 entrants, 1 court, 2 hours of 24-minute matches = 5 slots. League (6) and Double elimination (6) run over;
    // Groups + knockout (two pools of two, then a final four: 5) and Swiss (2 rounds, 4) both give each entrant 2 matches,
    // and Swiss plays fewer — although Groups + knockout comes first on the page.
    const ranked = rankFormats({ entrants: 4, courts: 1, hours: 2, matchMinutes: 24 });
    const g = ranked.find((r) => r.slug === "groups-knockout")!;
    const s = ranked.find((r) => r.slug === "swiss")!;
    expect([g.fits, s.fits, g.perEntrant === s.perEntrant, s.matches < g.matches]).toEqual([true, true, true, true]);
    expect(bestFitSlug(ranked)).toBe("swiss");
  });

  it("a format that runs over never wins, and the badge is reachable both ways", () => {
    let checked = 0;
    let winners = 0;
    let none = 0;
    for (let n = 2; n <= PREVIEW_MAX; n++) {
      for (let courts = 1; courts <= 4; courts++) {
        for (let hours = 1; hours <= 8; hours++) {
          const ranked = rankFormats({ entrants: n, courts, hours });
          const winner = bestFitSlug(ranked);
          checked++;
          if (winner === null) {
            none++;
            continue;
          }
          winners++;
          const row = ranked.find((r) => r.slug === winner)!;
          expect(row.fits && row.available, `n=${n} c=${courts} h=${hours} ${winner}`).toBe(true);
        }
      }
    }
    expect(checked).toBe(63 * 4 * 8);
    expect(winners).toBeGreaterThan(0);
    expect(none).toBeGreaterThan(0);
  });

  it("a card below its format's minimum never says Fits, however much time there is", () => {
    let below = 0;
    for (let n = 2; n <= 256; n++) {
      for (const r of rankFormats({ entrants: n, courts: 32, hours: 72 })) {
        if (r.available) continue;
        below++;
        expect(r.fits, `n=${n} ${r.slug}`).toBe(false);
      }
    }
    expect(below).toBeGreaterThan(0);
  });

  it("available is exactly what the engine can draw: every entrant seated, every stage drawn (n 2..64)", () => {
    const counts = new Map<FunnelFormat, { on: number; off: number }>(ALL.map((f) => [f, { on: 0, off: 0 }]));
    for (let n = 2; n <= PREVIEW_MAX; n++) {
      for (const f of ALL) {
        const engine = engineVerdict(f, n);
        expect(n >= funnelFormatMin(f), `${f} at n=${n}`).toBe(engine.builds);
        const c = counts.get(f)!;
        if (engine.builds) c.on++;
        else c.off++;
      }
    }
    for (const f of ALL) expect(counts.get(f)!.on, f).toBeGreaterThan(0);
    // Groups + knockout is the one format with a real floor: two pools of two (C38 refuses a pool of one).
    expect(counts.get("groups-knockout")!.off).toBeGreaterThan(0);
  });

  it("card counts equal the engine's own draw (n 2..64)", () => {
    const checked = new Map<FunnelFormat, number>(ALL.map((f) => [f, 0]));
    for (let n = 2; n <= PREVIEW_MAX; n++) {
      const ranked = rankFormats({ entrants: n, courts: 2, hours: 4 });
      for (const f of ALL) {
        if (n < funnelFormatMin(f)) continue;
        const stages = funnelFormatStages(f, n);
        const root = stages[0]!;
        let engine: number;
        if (root.kind === "swiss") {
          engine = swissPlayed(n, root.config.rounds as number, false) ?? -1;
        } else {
          engine = playedFixtures(previewStageDraw(root, n));
          if (stages[1] !== undefined) engine += playedFixtures(previewStageDraw(stages[1], fedField(stages[1], root)));
        }
        expect(ranked.find((r) => r.slug === f)!.matches, `${f} at n=${n}`).toBe(engine);
        checked.set(f, checked.get(f)! + 1);
      }
    }
    for (const f of ALL) expect(checked.get(f), f).toBeGreaterThan(0);
  });

  it("the mock's cards: A1 (16 players, 2 courts, 4 hours) and A2 (12, 4 courts, 6 hours)", () => {
    // swr13a01 §2 B2 / §1 A2, owner-approved numbers: matches, ≈hours and the Fits / Runs over tag per card.
    const a1 = (["league", "groups-knockout", "knockout", "swiss"] as const).map((s) => card(16, 2, 4, s));
    expect(a1.map((r) => [r.matches, r.estHours, r.fits])).toEqual([
      [120, 30, false],
      [31, 7.8, false],
      [15, 3.8, true],
      [40, 10, false],
    ]);
    const a2 = (["league", "groups-knockout", "knockout", "swiss"] as const).map((s) => card(12, 4, 6, s));
    expect(a2.map((r) => [r.matches, r.estHours, r.fits])).toEqual([
      [66, 8.3, false],
      [23, 2.9, true],
      [11, 1.4, true],
      [30, 3.8, true],
    ]);
  });

  it("fixed display order for every input", () => {
    let checked = 0;
    for (const n of [2, 3, 4, 12, 16, 40, 64, 65, 256]) {
      for (const [courts, hours] of [[1, 1], [2, 4], [4, 6], [32, 72]] as const) {
        expect(rankFormats({ entrants: n, courts, hours }).map((r) => r.slug)).toEqual([...ALL]);
        checked++;
      }
    }
    expect(checked).toBe(36);
    expect(ALL).toEqual(["league", "groups-knockout", "knockout", "swiss", "double_elim"]);
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
          const q = fedField(stages[1]!, stages[0]!);
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

  it("the Swiss it builds is never refused or warned by the rulebook's bounds, and the engine pairs every round (chess too)", () => {
    // rulebook-W3-swiss §3.1/§3.2 (swiss-rounds.ts judgeSwissRounds): above ⌊n/2⌋ a rematch can be forced, above the hard
    // maximum Start refuses. A first-time organiser never sees the Rounds box, so the claim stays inside the safe one.
    let judged = 0;
    for (let n = funnelFormatMin("swiss"); n <= 256; n++) {
      const rounds = funnelFormatStages("swiss", n)[0]!.config.rounds as number;
      expect(judgeSwissRounds(rounds, n).verdict, `n=${n} rounds=${rounds}`).toBe("ok");
      judged++;
    }
    expect(judged).toBe(255);
    let paired = 0;
    for (let n = funnelFormatMin("swiss"); n <= PREVIEW_MAX; n++) {
      const rounds = funnelFormatStages("swiss", n)[0]!.config.rounds as number;
      expect(swissPlayed(n, rounds, true), `chess n=${n} rounds=${rounds}`).not.toBeNull();
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

  it("refuses by name what it cannot build: below a minimum, a fractional or tiny field, an unknown format", () => {
    expect(() => funnelFormatStages("groups-knockout", 3)).toThrow(RangeError);
    expect(funnelFormatStages("groups-knockout", 4)).toHaveLength(2);
    expect(() => funnelFormatStages("league", 1)).toThrow(RangeError);
    expect(() => funnelFormatKnobs("league", 7.5)).toThrow(RangeError);
    expect(() => funnelFormatKnobs("ladder" as FunnelFormat, 8)).toThrow(RangeError);
    expect(() => funnelFormatMin("ladder" as FunnelFormat)).toThrow(RangeError);
    expect(() => rankFormats({ entrants: 8, courts: 2, hours: 4, matchMinutes: 0 })).toThrow(RangeError);
    expect(() => rankFormats({ entrants: Number.NaN, courts: 2, hours: 4 })).toThrow(RangeError);
    expect(() => rankFormats({ entrants: 1, courts: 2, hours: 4 })).toThrow(RangeError);
    expect(() => rankFormats({ entrants: 8, courts: 0, hours: 4 })).toThrow(RangeError);
    expect(() => rankFormats({ entrants: 8, courts: 2, hours: 0 })).toThrow(RangeError);
    expect(rankFormats({ entrants: 2, courts: 1, hours: 1 })).toHaveLength(ALL.length);
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

describe("the funnel's sports", () => {
  it("every funnel sport but Other names a real sport, by the name the catalogue stores", async () => {
    const synced = await syncedSportNames();
    expect(synced.size).toBe(builtinModules.length);
    let checked = 0;
    for (const s of FUNNEL_SPORTS) {
      if (s.key === "other") continue;
      expect(synced.get(s.key), s.key).toBe(s.name);
      checked++;
    }
    expect(checked).toBe(FUNNEL_SPORTS.length - 1);
    // …and Other is honestly not one (its positive pair above).
    expect(synced.has("other")).toBe(false);
    expect(FUNNEL_SPORTS.filter((s) => s.key === "other")).toEqual([{ key: "other", name: "Other" }]);
  });

  it("the mock's B1 chip order, keys and names unique", () => {
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
