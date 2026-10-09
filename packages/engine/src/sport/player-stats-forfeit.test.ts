// W2b Task 4 (spec §5.2 "Player-stat folds", W2b-R9; Appendix A X-PS-1, X-PS-2, BG-WO-3). A walkover, a withdrawal or a
// double walkover is not a match anybody played: no appearance, no personal win or loss. A retirement or an in-match
// disqualification is: an appearance for both sides' players and the W/L as decided. The match-level keys below are
// the ones a person's row counts per MATCH (appearance, result, a keeper's clean sheet); per-event credits (goals,
// points, runs) are what was played and stay credited either way.
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { aggregatePlayerStats, type PlayerStatRow, type PlayerStatsFoldCtx, type PlayerStatsModel } from "../stats/stats.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";

const H = "H";
const A = "A";
type Spec = Array<[string, unknown?]>;
const evs = (spec: Spec): EventEnvelope[] => spec.map(([t, p], i) => makeEnvelope(i + 1, { type: t, payload: p ?? {} }));
const mod = (k: string) => {
  const m = builtinModules.find((x) => x.key === k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};
/** The per-MATCH keys: an appearance, a result, a keeper's clean sheet. */
const MATCH_KEYS = ["matches", "games", "wins", "draws", "losses", "clean_sheets"] as const;
const declaredMatchKeys = (model: PlayerStatsModel): string[] => {
  const declared = new Set([...model.metrics.map((x) => x.key), ...(model.folded?.keys.map((k) => k.key) ?? [])]);
  return MATCH_KEYS.filter((k) => declared.has(k));
};

/** Before core.start: chess records the arbiter's pairing card (W4), which is what its "games" counts. */
const PRE: Record<string, Spec> = {
  boardgame: [["boardgame.pairing", { white: H, homePerson: "H-p1", awayPerson: "A-p1" }]],
};
/** After core.start: a little play in which ONLY A scores, so H's keeper concedes and A's keeps a clean sheet. */
const PLAYED: Record<string, Spec> = {
  football: [["football.goal", { by: A }]],
  hockey: [["hockey.goal", { by: A }]],
  icehockey: [["icehockey.goal", { by: A }]],
  volleyball: [["volleyball.rally", { wonBy: A }]],
  tabletennis: [["tabletennis.rally", { wonBy: A }]],
  badminton: [["badminton.rally", { wonBy: A }]],
  tennis: [["tennis.point", { by: A }]],
  cricket: [["cricket.innings.summary", { runs: 12, wickets: 0, legalBalls: 6, partial: true }]],
  boardgame: [],
  carrom: [["carrom.board.summary", { winner: A, opponentCoinsLeft: 4, queenTo: null }]],
  generic: [["generic.score", { by: A, points: 1 }]],
};

function statsOf(key: string, spec: Spec, raw: Record<string, unknown> = {}): { rows: PlayerStatRow[]; persons: Record<string, string[]> } {
  const m = mod(key);
  const lineups = defaultLineupPair(m.positions);
  const persons: Record<string, string[]> = { [H]: lineups.home.slots.map((s) => s.personId), [A]: lineups.away.slots.map((s) => s.personId) };
  const ctx: PlayerStatsFoldCtx = {
    // "individual" for every sport: the fold's kind guard credits a "team" entrant nobody, which would make the
    // appearance assertions below vacuous for the team sports.
    entrants: [{ id: H, kind: "individual" }, { id: A, kind: "individual" }],
    personsOf: (id) => persons[id] ?? [],
    cfg: m.configSchema.parse({ ...(m.configSchema.safeParse({}).success ? {} : Object.values(m.variants)[0]), ...raw }),
  };
  return { rows: aggregatePlayerStats(evs(spec), m.playerStats!, lineups, ctx), persons };
}
const sumOf = (rows: PlayerStatRow[], keys: readonly string[]) =>
  rows.reduce((n, r) => n + keys.reduce((k, key) => k + (r.stats[key] ?? 0), 0), 0);
const statOf = (rows: PlayerStatRow[], person: string, key: string) => rows.find((r) => r.personId === person)?.stats[key] ?? 0;

/** Every unplayed stream a sport can record (spec §5.1 phases): before start, after start, both sides. */
function unplayedStreams(key: string): Array<[string, Spec]> {
  const pre = PRE[key] ?? [];
  const played = PLAYED[key]!;
  const streams: Array<[string, Spec]> = [
    ["walkover", [...pre, ["core.forfeit", { by: A, reason: "walkover" }]]],
    ["withdrew before start", [...pre, ["core.forfeit", { by: A, reason: "withdrew" }]]],
    ["withdrew after play", [...pre, ["core.start"], ...played, ["core.forfeit", { by: A, reason: "withdrew" }]]],
    ["double walkover", [...pre, ["core.forfeit", { by: "both", reason: "walkover" }]]],
  ];
  // BG-WO-1: a chess no-show is a walkover after the session starts too (FIDE Laws 6.7.1).
  if (key === "boardgame") streams.push(["walkover after start", [...pre, ["core.start"], ["core.forfeit", { by: A, reason: "walkover" }]]]);
  return streams;
}

describe("X-PS-1 / X-PS-2: forfeits in player stats (spec §5.2, W2b-R9)", () => {
  it("empty case first: a fixture with no events credits no match-level key in any sport", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      if (m.playerStats === undefined) return;
      expect(sumOf(statsOf(m.key, []).rows, MATCH_KEYS.filter((k) => k !== "clean_sheets")), m.key).toBe(0);
      checked++;
    });
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("X-PS-1: a walkover, a withdrawal or a double walkover credits no appearance and no personal W/L — every sport", () => {
    let streams = 0;
    let sportsWithKeys = 0;
    let noMatchKey = 0;
    forEachSport(({ module: m }) => {
      if (m.playerStats === undefined) return;
      const keys = declaredMatchKeys(m.playerStats);
      // Cricket counts per ball only (runs, wickets, balls) — it declares no per-match key, so there is nothing to skip.
      if (keys.length === 0) { noMatchKey++; return; }
      sportsWithKeys++;
      for (const [label, spec] of unplayedStreams(m.key)) {
        const { rows } = statsOf(m.key, spec);
        expect(sumOf(rows, keys), `${m.key} ${label}: ${JSON.stringify(rows)}`).toBe(0);
        streams++;
      }
    });
    expect(sportsWithKeys).toBeGreaterThanOrEqual(10);
    expect(noMatchKey, "only cricket declares no per-match key").toBe(1);
    expect(streams).toBeGreaterThanOrEqual(40);
  });

  it("X-PS-2: a retirement or an in-match disqualification is a match for both sides' players, W/L as decided — every sport", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      if (m.playerStats === undefined) return;
      const keys = declaredMatchKeys(m.playerStats);
      if (keys.length === 0) return; // cricket: no per-match key (see X-PS-1)
      for (const reason of ["retired", "disqualified"]) {
        // H retires after A's bit of play, so A wins.
        const spec: Spec = [...(PRE[m.key] ?? []), ["core.start"], ...PLAYED[m.key]!, ["core.forfeit", { by: H, reason }]];
        const { rows, persons } = statsOf(m.key, spec);
        const label = `${m.key} ${reason}`;
        expect(sumOf(rows, keys), `${label}: something per-match is credited`).toBeGreaterThan(0);
        if (keys.includes("matches")) {
          for (const p of [...persons[H]!, ...persons[A]!]) expect(statOf(rows, p, "matches"), `${label} ${p}`).toBe(1);
        }
        if (keys.includes("games")) {
          // chess "games" counts the pairing card's two players
          for (const p of ["H-p1", "A-p1"]) expect(statOf(rows, p, "games"), `${label} ${p}`).toBe(1);
        }
        if (keys.includes("wins")) {
          for (const p of persons[A]!) expect(statOf(rows, p, "wins"), `${label} winner ${p}`).toBe(1);
          for (const p of persons[H]!) expect(statOf(rows, p, "wins"), `${label} loser ${p}`).toBe(0);
        }
        if (keys.includes("losses")) {
          for (const p of persons[H]!) expect(statOf(rows, p, "losses"), `${label} loser ${p}`).toBe(1);
          for (const p of persons[A]!) expect(statOf(rows, p, "losses"), `${label} winner ${p}`).toBe(0);
        }
        if (keys.includes("clean_sheets")) {
          // Only A scored: A's keeper kept a clean sheet in a match that was played.
          expect(sumOf(rows, ["clean_sheets"]), label).toBe(1);
        }
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it("X-PS-2: an abandon with a result (the award policy) is a match — the leader's keeper keeps the clean sheet", () => {
    let checked = 0;
    for (const [key, goalType] of [["football", "football.goal"], ["hockey", "hockey.goal"], ["icehockey", "icehockey.goal"]] as const) {
      const { rows } = statsOf(key, [["core.start"], [goalType, { by: A }], ["core.abandon", { reason: "floodlights" }]], { abandonPolicy: "award" });
      expect(sumOf(rows, ["clean_sheets"]), key).toBe(1);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("BG-WO-3: a chess draw then a tie-break walkover keeps the classical game a draw in stats (D-C6)", () => {
    const ko = mod("boardgame").configSchema.parse({ ...mod("boardgame").bracketDeciders(mod("boardgame").configSchema.parse({})) });
    const spec: Spec = [
      ...PRE.boardgame!,
      ["core.start"],
      ["boardgame.result", { winner: null, method: "agreement" }],
      ["core.forfeit", { by: A, reason: "walkover" }],
    ];
    const { rows } = statsOf("boardgame", spec, ko as Record<string, unknown>);
    for (const p of ["H-p1", "A-p1"]) {
      expect([statOf(rows, p, "games"), statOf(rows, p, "draws"), statOf(rows, p, "wins"), statOf(rows, p, "losses")], p).toEqual([1, 1, 0, 0]);
    }
  });
});
