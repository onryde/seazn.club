// scoreLevels (task B3): the structured score reader behind Match Day's panel and rows and the public match page's large type.
// Every summary here is the ENGINE's own fold of a recorded golden stream (the corpus Match Day's SSR sweep uses, `_golden.ts`),
// and every expected value is read off a DIFFERENT engine field than the one the reader uses — never the headline, never the
// reader's own path: sets won are counted from the closed sets, a set sport's live points are the match totals less the closed
// sets, tennis's games are `detail.games` and its live line is `detail.game`.
import { describe, expect, it } from "vitest";
import { stripLiveSetPoints } from "@/lib/public-site";
import { scoreLevels } from "@/lib/score/levels";
import { CORPORA, SPORTS, goldenMoments, tennisMatchTiebreak, type GoldenMoment } from "./_golden";

type SetEntry = { home: number; away: number; closed: boolean; tb?: unknown; mtb?: unknown };
const detailOf = (m: GoldenMoment): Record<string, unknown> => (m.summary.detail ?? {}) as Record<string, unknown>;
const setsOf = (m: GoldenMoment): SetEntry[] | null => {
  const sets = detailOf(m).sets;
  return Array.isArray(sets) && sets.length > 0 ? (sets as SetEntry[]) : null;
};
/** Sets (or games) a side has won, counted off the CLOSED sets: the larger score takes the set. */
const wonByCount = (sets: SetEntry[]): [number, number] => [
  sets.filter((s) => s.closed && s.home > s.away).length,
  sets.filter((s) => s.closed && s.away > s.home).length,
];

/** Every registered sport's moments, folded once. */
const MOMENTS = new Map<string, GoldenMoment[]>(SPORTS.map((key) => [key, goldenMoments(key)]));
const all = (pick: (key: string) => boolean = () => true): GoldenMoment[] =>
  [...MOMENTS].filter(([k]) => pick(k)).flatMap(([, ms]) => ms);
const SET_SPORTS = ["badminton", "tabletennis", "volleyball", "tennis"];

describe("scoreLevels — every registered sport, over the engine's recorded golden streams", () => {
  it("a sport with a set table reads as levels, every other sport (cricket included) reads null — at every moment of every stream", () => {
    const withTable: string[] = [];
    const without: string[] = [];
    let checked = 0;
    for (const key of SPORTS) {
      const moments = MOMENTS.get(key)!;
      // Only a sport with no recorded stream may sit out — never one whose streams yield no moment.
      if (moments.length === 0) {
        expect(CORPORA.some((c) => c.key === key), `${key} has a corpus but no moment`).toBe(false);
        continue;
      }
      for (const m of moments) {
        const levels = scoreLevels(m.summary);
        const hasTable = setsOf(m) !== null;
        expect(levels !== null, `${key} stream ${m.stream} @${m.events}: levels iff the engine carries a set table`).toBe(hasTable);
        checked++;
      }
      (moments.some((m) => setsOf(m) !== null) ? withTable : without).push(key);
    }
    for (const key of SET_SPORTS) expect(withTable, `${key} should carry a set table`).toContain(key);
    expect(without, "the non-set sports swept").toContain("cricket");
    expect(without.length).toBeGreaterThan(2);
    expect(checked).toBe(all().length);
    expect(checked).toBeGreaterThan(1000);
  });

  it("won: each side's sets (games) won — the engine's own count of its closed sets, at every moment of play, for every set sport", () => {
    const perSport: Record<string, number> = {};
    for (const key of SET_SPORTS) {
      for (const m of MOMENTS.get(key)!) {
        const sets = setsOf(m);
        // A decided match may be a forfeit, whose credited sets are not a count of the closed ones: that is checked below.
        if (sets === null || m.decided) continue;
        expect(scoreLevels(m.summary)!.won, `${key} stream ${m.stream} @${m.events}`).toEqual(wonByCount(sets));
        perSport[key] = (perSport[key] ?? 0) + 1;
      }
    }
    for (const key of SET_SPORTS) expect(perSport[key], `${key} moments checked`).toBeGreaterThan(20);
  });

  it("won: a forfeit or award reads the sets the engine CREDITS (perSide), not a count of the closed ones", () => {
    let checked = 0;
    for (const key of SET_SPORTS) {
      for (const m of MOMENTS.get(key)!) {
        const sets = setsOf(m);
        if (sets === null || !m.decided) continue;
        const credited = m.summary.perSide!.map((p) => Number(p.line));
        if (credited.join() === wonByCount(sets).join()) continue; // played out: the other test's case
        expect(scoreLevels(m.summary)!.won, `${key} stream ${m.stream} @${m.events}`).toEqual(credited);
        checked++;
      }
    }
    expect(checked, "decided moments whose credit differs from the closed sets").toBeGreaterThan(0);
  });

  it("a set-based sport (badminton, table tennis, volleyball): no middle level; live is the open set's points — the match totals less the closed sets", () => {
    const counts = { live: 0, between: 0, stopped: 0 };
    for (const key of ["badminton", "tabletennis", "volleyball"]) {
      for (const m of MOMENTS.get(key)!) {
        const sets = setsOf(m);
        if (sets === null) continue;
        const levels = scoreLevels(m.summary)!;
        const points = detailOf(m).points as { home: number; away: number };
        const closed = sets.filter((s) => s.closed);
        const liveHome = points.home - closed.reduce((n, s) => n + s.home, 0);
        const liveAway = points.away - closed.reduce((n, s) => n + s.away, 0);
        const where = `${key} stream ${m.stream} @${m.events}`;
        expect(levels.mid, where).toBeNull();
        if (sets.some((s) => !s.closed)) {
          expect(levels.live, where).toEqual({ label: `${liveHome}–${liveAway}` });
          // The open set has points on the board, else the equality above would hold of a 0–0 for any reading.
          expect(liveHome + liveAway, where).toBeGreaterThan(0);
          counts[m.decided ? "stopped" : "live"]++;
        } else {
          // Between sets, or finished: every point is in a closed set, so there is no live level.
          expect(liveHome + liveAway, where).toBe(0);
          expect(levels.live, where).toBeNull();
          counts.between++;
        }
      }
    }
    expect(counts.live, "badminton/table tennis/volleyball mid-set moments").toBeGreaterThan(100);
    expect(counts.between, "between sets or finished").toBeGreaterThan(20);
  });

  it("a finished set-based match has no live level — every set closed", () => {
    let checked = 0;
    for (const key of ["badminton", "tabletennis", "volleyball"]) {
      for (const m of MOMENTS.get(key)!) {
        const sets = setsOf(m);
        if (!m.decided || sets === null || sets.some((s) => !s.closed)) continue;
        expect(scoreLevels(m.summary)!.live, `${key} stream ${m.stream} @${m.events}`).toBeNull();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("tennis mid-game: sets won · the set's games (detail.games) · the game's points (detail.game); each its own level", () => {
    let checked = 0;
    let distinct = 0;
    let notStarted = 0;
    for (const m of MOMENTS.get("tennis")!) {
      const d = detailOf(m);
      const games = d.games as { home: number; away: number };
      const game = d.game as string;
      // The engine says who serves only while play is live (`serving: null` otherwise: abandoned, suspended, not begun), and
      // then drops the set's open entry though `games` and `game` still hold the last score. A decided match is the
      // finished / stopped test's.
      if (m.decided) continue;
      const live = d.serving !== null;
      const inProgress = live && (games.home + games.away > 0 || !/^(MTB |TB )?0–0$/.test(game));
      const where = `tennis stream ${m.stream} @${m.events}`;
      // Nothing played in the set yet (the match tie-break's first point included), or play not live: no open entry, and with
      // no closed set either the table is empty — which reads as no set table at all, so the headline stands.
      if (!inProgress) {
        const levels = scoreLevels(m.summary);
        if (setsOf(m) === null) expect(levels, where).toBeNull();
        else expect(levels, where).toMatchObject({ mid: null, live: null });
        notStarted++;
        continue;
      }
      const levels = scoreLevels(m.summary)!;
      if (d.gameKind === "matchTiebreak") {
        // The open entry is the match tie-break's points: games are not a level then.
        expect(levels.mid, where).toBeNull();
      } else {
        expect(levels.mid, where).toEqual([games.home, games.away]);
      }
      expect(levels.live, where).toEqual({ label: game });
      checked++;
      // A moment where the three levels differ from each other, or a swap of two of them could not be seen.
      if (levels.mid !== null && levels.live!.label !== `${levels.mid[0]}–${levels.mid[1]}` && levels.won[0] !== levels.mid[0]) distinct++;
    }
    expect(checked, "tennis moments with a set in progress").toBeGreaterThan(500);
    expect(notStarted, "tennis moments between sets / before the first point").toBeGreaterThan(20);
    expect(distinct, "moments where won, mid and live all differ").toBeGreaterThan(100);
  });

  it("tennis in a per-set tie-break: the games are the mid level, the tie-break's points are live ('TB 3–2'); the tie-break is not a game", () => {
    const seen = goldenTiebreaks();
    expect(seen.length, "tennis moments inside a set tie-break").toBeGreaterThan(10);
    for (const m of seen) {
      const levels = scoreLevels(m.summary)!;
      const games = detailOf(m).games as { home: number; away: number };
      const where = `stream ${m.stream} @${m.events}`;
      expect(levels.mid, where).toEqual([games.home, games.away]);
      expect(levels.live!.label, where).toMatch(/^TB \d+–\d+$/);
      expect(levels.live!.label, where).toBe(detailOf(m).game);
    }
  });

  it("a finished set's tie-break score ('7–6(5)') never leaks into live — the headline reading it replaced did", () => {
    // A set that went to a tie-break is a closed entry carrying `tb`; the headline writes it "7–6(3)" and, on a decided match,
    // ends with that "(3)". Read off the headline, the loser's tie-break points were the "live" score and the large type lost
    // them (`stripLiveSetPoints`); read off the structure, there is no live level once every set is closed.
    let checked = 0;
    let headlineWouldMisread = 0;
    for (const m of MOMENTS.get("tennis")!) {
      const sets = setsOf(m);
      if (sets === null || !m.decided || sets.some((s) => !s.closed) || !sets.some((s) => s.closed && s.tb !== undefined)) continue;
      expect(scoreLevels(m.summary)!.live, `stream ${m.stream} @${m.events}`).toBeNull();
      checked++;
      if (/\(([^)]*)\)\s*$/.test(m.summary.headline!) && stripLiveSetPoints(m.summary.headline!) !== m.summary.headline) headlineWouldMisread++;
    }
    expect(checked, "finished tennis matches with a tie-break set").toBeGreaterThan(3);
    expect(headlineWouldMisread, "…of which the headline reading would have misread the tie-break's points").toBeGreaterThan(0);
  });

  it("tennis match tie-break: no middle level, the tie-break's points are live ('MTB 3–2'), and the closed sets stay out of it", () => {
    // The recorded streams stop as the match tie-break begins; the engine's own point events carry one into play.
    const base = tennisMatchTiebreak([]);
    expect((base.summary.detail as Record<string, unknown>).gameKind, "the recorded prefix ends in the match tie-break").toBe("matchTiebreak");
    expect(scoreLevels(base.summary)!.live, "no point played yet: nothing live").toBeNull();
    const played = tennisMatchTiebreak(["H", "H", "A", "H", "A"]);
    const d = played.summary.detail as Record<string, unknown>;
    expect(played.decided).toBe(false);
    expect(d.gameKind).toBe("matchTiebreak");
    expect(d.game).toBe("MTB 3–2");
    const levels = scoreLevels(played.summary)!;
    expect(levels.won, "a set each").toEqual([1, 1]);
    expect(levels.mid).toBeNull();
    expect(levels.live).toEqual({ label: "MTB 3–2" });
    // The closed sets' scores (7–6 with its tie-break, 1–6) are not the live level, nor part of it.
    expect(levels.live!.label).not.toContain("7");
    expect(levels.live!.label).not.toContain("6");
  });

  it("a finished tennis match has no live level, a stopped one keeps the engine's open entry (a caller shows live only in play)", () => {
    let finished = 0;
    let stopped = 0;
    for (const m of MOMENTS.get("tennis")!) {
      const sets = setsOf(m);
      if (!m.decided || sets === null) continue;
      const levels = scoreLevels(m.summary)!;
      if (sets.some((s) => !s.closed)) {
        expect(levels.live, `stopped: stream ${m.stream} @${m.events}`).toEqual({ label: detailOf(m).game });
        stopped++;
      } else {
        expect(levels.live, `finished: stream ${m.stream} @${m.events}`).toBeNull();
        expect(levels.mid, `finished: stream ${m.stream} @${m.events}`).toBeNull();
        finished++;
      }
    }
    expect(finished).toBeGreaterThan(10);
    expect(stopped, "a tennis match stopped mid-set (default / retirement)").toBeGreaterThan(0);
  });

  it("cricket: null at every moment — its innings keep their own scorebug", () => {
    const moments = MOMENTS.get("cricket")!;
    expect(moments.length).toBeGreaterThan(100);
    for (const m of moments) expect(scoreLevels(m.summary), `stream ${m.stream} @${m.events}`).toBeNull();
  });
});

describe("scoreLevels — shapes it refuses (a refusal reads the caller's own headline, never a guess)", () => {
  const sets = [{ home: 21, away: 15, closed: true }, { home: 14, away: 11, closed: false }];
  const summary = (over: Record<string, unknown> = {}) => ({
    headline: "1 — 0 · 21–15 (14–11)",
    perSide: [{ entrantId: "H", line: "1" }, { entrantId: "A", line: "0" }],
    detail: { sets },
    ...over,
  });

  it("the well-formed set-based shape is read (so each refusal below is the one change that matters)", () => {
    expect(scoreLevels(summary())).toEqual({ won: [1, 0], mid: null, live: { label: "14–11" } });
  });

  it.each([
    ["no summary", null],
    ["not an object", "1 — 0"],
    ["no detail", summary({ detail: undefined })],
    ["no set table", summary({ detail: {} })],
    ["an empty set table", summary({ detail: { sets: [] } })],
    ["a malformed set entry", summary({ detail: { sets: [{ home: "21", away: 15, closed: true }] } })],
    ["no sides", summary({ perSide: undefined })],
    ["one side", summary({ perSide: [{ entrantId: "H", line: "1" }] })],
    ["three sides", summary({ perSide: [{ entrantId: "H", line: "1" }, { entrantId: "A", line: "0" }, { entrantId: "B", line: "0" }] })],
    ["a side line that is not a count (a score line)", summary({ perSide: [{ entrantId: "H", line: "6-4 3-6" }, { entrantId: "A", line: "0" }] })],
    ["a side line that is a half-point", summary({ perSide: [{ entrantId: "H", line: "½" }, { entrantId: "A", line: "½" }] })],
    ["a nested kernel with a game kind it does not know", summary({ detail: { sets, game: "40–30", gameKind: "superTiebreak" } })],
    ["a nested kernel with no game kind", summary({ detail: { sets, game: "40–30" } })],
  ])("%s -> null", (_name, input) => {
    expect(scoreLevels(input)).toBeNull();
  });

  it("a nested kernel's sides, mid and live are read from the structure the engine names", () => {
    const nested = summary({
      headline: "0 — 1 · 6–4 · 3–2 (40–30)",
      perSide: [{ entrantId: "H", line: "0" }, { entrantId: "A", line: "1" }],
      detail: { sets: [{ home: 4, away: 6, closed: true }, { home: 3, away: 2, closed: false }], games: { home: 3, away: 2 }, game: "40–30", gameKind: "standard" },
    });
    expect(scoreLevels(nested)).toEqual({ won: [0, 1], mid: [3, 2], live: { label: "40–30" } });
  });
});

/** Tennis moments inside a per-set tie-break: the engine says so itself (`gameKind`), with its open entry carrying the games. */
function goldenTiebreaks(): GoldenMoment[] {
  return MOMENTS.get("tennis")!.filter((m) => detailOf(m).gameKind === "tiebreak" && setsOf(m)?.some((s) => !s.closed));
}
