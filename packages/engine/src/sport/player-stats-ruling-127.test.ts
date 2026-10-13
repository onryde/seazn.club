// W2b ruling 127 (2026-10-13, owner "A"; amends X-PS-1): a withdrawal counts as a match in players' stats if and only
// if play was recorded before it (`playRecorded`, as rulings 115 and 120 read it: any active sport event after the
// Start, scoring or not — ruling 114 — and in chess the Start itself, ruling 118). Before any play nobody is credited.
// After real play the match stands for both sides' players — appearances, the goals and points already played, a
// keeper's clean sheet — but it credits NO personal win or loss: nobody won or lost the match on the field. The
// ruling's example: a football or hockey knockout held level after full time, then a withdrawal.
//
// The expected values come from the ruling's text, never from the fold or the reader: each scene states, from the
// events it is built of, whether anything was played before the withdrawal. "No match" is `playedInStats` false (asked
// with the module, and with the model alone as the shared fold asks it) and every per-match key zero; "a match" is
// `playedInStats` true, each declared appearance key one for every player, every personal-result key zero, and every
// per-event credit exactly what the same ledger credits WITHOUT the withdrawal. Every scene is folded through the real
// kernel first, so the sweep reads only ledgers the product records; a refusal is named and counted. Every sport,
// every declared cfg.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { aggregatePlayerStats, playedInStats, STATS_FOLD_VERSION, type PlayerStatRow, type PlayerStatsFoldCtx, type PlayerStatsModel } from "../stats/stats.ts";
import { builtinModules } from "../sports/index.ts";
import { reachableAfterStart } from "../testkit/after-start-events.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { onePlayEvent } from "../testkit/play-event.ts";
import type { AnySportModule } from "./module.ts";

const H = "H";
const A = "A";
type Step = { type: string; payload: unknown; voidsIndex?: number };
const seqd = (steps: readonly Step[]): EventEnvelope[] =>
  steps.map((s, i) => makeEnvelope(i + 1, { type: s.type, payload: s.payload }, s.voidsIndex === undefined ? undefined : `e-${s.voidsIndex + 1}`));
const START: Step = { type: "core.start", payload: {} };
/** H withdraws — the withdrawal cascade's own forfeit (withdrawal.ts applyUpdate). */
const WITHDREW: Step = { type: "core.forfeit", payload: { by: H, reason: "withdrew" } };
/** Chess's pairing card before the Start (player-stats-ruling-115.test.ts): what its "games" appearance counts. */
const PRE: Record<string, Step[]> = {
  boardgame: [{ type: "boardgame.pairing", payload: { white: H, homePerson: "H-p1", awayPerson: "A-p1" } }],
};
/** The per-MATCH keys a person's row counts (player-stats-forfeit.test.ts): an appearance, a result, a clean sheet. */
const MATCH_KEYS = ["matches", "games", "wins", "draws", "losses", "clean_sheets"] as const;
/** The appearance keys: a match played counts one for every player. */
const APPEARANCE_KEYS = ["matches", "games"] as const;
/** The personal-result keys ruling 127 withholds after play. */
const RESULT_KEYS = ["wins", "draws", "losses"] as const;
const declared = (model: PlayerStatsModel, keys: readonly string[]): string[] => {
  const all = new Set([...model.metrics.map((x) => x.key), ...(model.folded?.keys.map((k) => k.key) ?? [])]);
  return keys.filter((k) => all.has(k));
};

function refusalOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    if (EngineError.is(e)) return e.code;
    throw e;
  }
}

function rowsOf(m: AnySportModule, cfg: unknown, l: LineupPair, events: readonly EventEnvelope[]): PlayerStatRow[] {
  const persons: Record<string, string[]> = { [H]: l.home.slots.map((s) => s.personId), [A]: l.away.slots.map((s) => s.personId) };
  // "individual" for every sport: the fold's kind guard credits a "team" entrant nobody (player-stats-forfeit.test.ts).
  const ctx: PlayerStatsFoldCtx = { entrants: [{ id: H, kind: "individual" }, { id: A, kind: "individual" }], personsOf: (id) => persons[id] ?? [], cfg };
  return aggregatePlayerStats(events, m.playerStats!, l, ctx);
}
const keyOf = (rows: PlayerStatRow[], person: string, key: string) => rows.find((r) => r.personId === person)?.stats[key] ?? 0;
/** Every per-EVENT credit (anything that is not a per-match key), person by person, zeros dropped. */
const perEvent = (rows: PlayerStatRow[]) =>
  Object.fromEntries(
    rows
      .map((r) => [r.personId, Object.fromEntries(Object.entries(r.stats).filter(([k, v]) => !(MATCH_KEYS as readonly string[]).includes(k) && v !== 0))] as const)
      .filter(([, s]) => Object.keys(s).length > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

/** Ruling 114's non-scoring play, per sport, from each module's own declarations (testkit/after-start-events.ts). */
const NON_SCORING = new Map(
  builtinModules
    .flatMap((m) => reachableAfterStart(m as never))
    .filter((s) => !s.scoring)
    .map((s) => [s.sport, s] as const),
);

describe("ruling 127: a withdrawal is a match in players' stats only if play was recorded before it — and never a personal W/L (X-PS-1 as amended)", () => {
  it("before the Start, after a bare Start (ruling 112) or after play voided away it is no match for anybody (chess: the Start is play); after play — scoring or not — it is a match with no personal result; every declared cfg of every sport", () => {
    const n = { sports: 0, cfgs: 0, scenes: 0, refused: 0, noPlay: 0, unplayed: 0, played: 0, nonScoring: 0, chessStart: 0, perMatchPinned: 0, appearancePinned: 0, resultPinned: 0, perEventPinned: 0, decidedBefore: 0 };
    const refusals = new Map<string, number>();
    forEachSport(({ module: m }) => {
      const model = m.playerStats;
      if (model === undefined) return;
      n.sports++;
      const l = defaultLineupPair(m.positions);
      const persons = [...l.home.slots, ...l.away.slots].map((s) => s.personId);
      const pre = PRE[m.key] ?? [];
      const startIsPlay = m.startIsPlay === true;
      const perMatch = declared(model, MATCH_KEYS);
      const appearance = declared(model, APPEARANCE_KEYS);
      const result = declared(model, RESULT_KEYS);
      const nonScoring = NON_SCORING.get(m.key);
      for (const { name, cfg } of declaredCfgs(m as never)) {
        n.cfgs++;
        const label = (s: string) => `${m.key}/${name}: ${s}`;
        const prefix = seqd([...pre, START]);
        const playCfg = [cfg, m.configSchema.parse({ ...(cfg as object), ...m.bracketDeciders(cfg as never) })].find((c) => onePlayEvent(m, c, l, prefix) !== null);
        const play = playCfg === undefined ? null : onePlayEvent(m, playCfg, l, prefix);
        if (play === null) n.noPlay++;
        const P: Step | null = play === null ? null : { type: play.type, payload: play.payload };
        const NS: Step | null = nonScoring === undefined || nonScoring.cfgName !== name ? null : { type: nonScoring.event.type, payload: nonScoring.event.payload };
        const at = pre.length + 1; // P's index, right after the Start
        // [scene, steps BEFORE the withdrawal, the cfg it is played under, the ruling's answer: was anything played?]
        const scenes: [string, Step[] | null, unknown, boolean][] = [
          ["before the Start", [...pre], cfg, false],
          ["a bare Start", [...pre, START], cfg, startIsPlay],
          ["play voided away", P && [...pre, START, P, { type: "core.void", payload: {}, voidsIndex: at }], playCfg, startIsPlay],
          ["play", P && [...pre, START, P], playCfg, true],
          ["non-scoring play (ruling 114)", NS && [...pre, START, NS], cfg, true],
        ];
        for (const [what, before, c, played] of scenes) {
          if (before === null) continue;
          const events = seqd([...before, WITHDREW]);
          const refused = refusalOf(() => foldMatchWithStoppage(m as never, c as never, l, events));
          if (refused !== null) {
            const key = `${m.key}: ${what}: ${refused}`;
            refusals.set(key, (refusals.get(key) ?? 0) + 1);
            n.refused++;
            continue;
          }
          n.scenes++;
          const scene = `${what}, then a withdrawal`;
          expect(playedInStats(events, m), label(`${scene}: the one reader, with the module`)).toBe(played);
          expect(playedInStats(events, { playerStats: model }), label(`${scene}: the shared fold's reading, the model alone`)).toBe(played);
          const rows = rowsOf(m, c, l, events);
          if (!played) {
            n.unplayed++;
            if (perMatch.length > 0) {
              for (const p of persons) for (const k of perMatch) expect(keyOf(rows, p, k), label(`${scene}: ${p}'s ${k}`)).toBe(0);
              n.perMatchPinned++;
            }
            continue;
          }
          n.played++;
          // BG-WO-3 (D-C6): where the play before the withdrawal already credits a personal result (chess's one event is
          // a game result — a classical draw stands even while a tie-break is owed), that result stands and the forfeit
          // adds nothing: every key exactly the ledger's without it.
          const priorRows = rowsOf(m, c, l, seqd(before));
          if (persons.some((p) => result.some((k) => keyOf(priorRows, p, k) > 0))) {
            expect(rows, label(`${scene}: the result before it stands, the withdrawal adds nothing (BG-WO-3)`)).toEqual(rowsOf(m, c, l, seqd(before)));
            n.decidedBefore++;
            continue;
          }
          if (NS !== null && before.includes(NS)) n.nonScoring++;
          if (startIsPlay && what === "a bare Start") n.chessStart++;
          if (appearance.length > 0) {
            for (const p of persons) for (const k of appearance) expect(keyOf(rows, p, k), label(`${scene}: ${p}'s ${k}`)).toBe(1);
            n.appearancePinned++;
          }
          if (result.length > 0) {
            for (const p of persons) for (const k of result) expect(keyOf(rows, p, k), label(`${scene}: no personal result — ${p}'s ${k}`)).toBe(0);
            n.resultPinned++;
          }
          // What was played stays credited, exactly: the same ledger without the withdrawal credits the same per-event
          // stats (goals, points, serves …).
          expect(perEvent(rows), label(`${scene}: per-event credits`)).toEqual(perEvent(rowsOf(m, c, l, seqd(before))));
          n.perEventPinned++;
        }
      }
    });
    // Anti-vacuity: every sport and cfg ran, every branch was reached, every pin judged something.
    expect(n.sports).toBe(builtinModules.filter((m) => m.playerStats !== undefined).length);
    expect(n.cfgs).toBeGreaterThanOrEqual(n.sports);
    expect(n.refused, `refused scenes: ${JSON.stringify([...refusals])}`).toBe(0);
    expect(n.unplayed, "no-play scenes judged").toBeGreaterThanOrEqual(n.cfgs * 2);
    expect(n.played, "played scenes judged").toBeGreaterThanOrEqual(n.cfgs);
    expect(n.chessStart, "chess: a withdrawal after its bare Start is a game both players played (ruling 118)").toBeGreaterThan(0);
    expect(n.nonScoring, "ruling 114's non-scoring play reached").toBeGreaterThan(0);
    expect(n.appearancePinned, "appearance keys pinned").toBeGreaterThan(0);
    expect(n.resultPinned, "personal-result keys pinned (generic, carrom, chess)").toBeGreaterThan(0);
    expect(n.perEventPinned + n.decidedBefore).toBe(n.played);
    expect(n.decidedBefore, "chess: its one play is a game result (BG-WO-3)").toBeGreaterThan(0);
    expect(n.perMatchPinned).toBeGreaterThan(0);
  });

  it("the ruling's example: a football or hockey knockout held level after full time, then a withdrawal — goals and the keepers' clean sheets stand, no personal result", () => {
    // single-sport: the two sports with keepers the ruling names (ice hockey shares hockey's period kernel fold).
    // [sport, the level ledger, the goals each side scored, a keeper's clean sheet per side in a match played]
    const SCENES: { key: string; level: Step[]; goals: number; cleanSheets: number }[] = [
      { key: "football", goals: 1, cleanSheets: 0, level: [START, { type: "football.goal", payload: { by: H, scorer: "H-p1" } }, { type: "football.goal", payload: { by: A, scorer: "A-p1" } }, { type: "football.period", payload: { phase: "HT" } }, { type: "football.period", payload: { phase: "FT" } }] },
      { key: "football", goals: 0, cleanSheets: 2, level: [START, { type: "football.period", payload: { phase: "HT" } }, { type: "football.period", payload: { phase: "FT" } }] },
      { key: "hockey", goals: 1, cleanSheets: 0, level: [START, { type: "hockey.goal", payload: { by: H, person: "H-p1" } }, { type: "hockey.goal", payload: { by: A, person: "A-p1" } }, ...["Q2", "Q3", "Q4", "FT"].map((to): Step => ({ type: "hockey.period.advance", payload: { to } }))] },
      { key: "hockey", goals: 0, cleanSheets: 2, level: [START, ...["Q2", "Q3", "Q4", "FT"].map((to): Step => ({ type: "hockey.period.advance", payload: { to } }))] },
    ];
    let checked = 0;
    for (const s of SCENES) {
      const m = builtinModules.find((x) => x.key === s.key)!;
      const cfg = m.configSchema.parse({});
      const l = defaultLineupPair(m.positions);
      const events = seqd([...s.level, WITHDREW]);
      expect(refusalOf(() => foldMatchWithStoppage(m as never, cfg as never, l, events)), `${s.key}: the kernel records it`).toBeNull();
      const label = `${s.key} held ${s.goals}-${s.goals}`;
      expect(playedInStats(events, m), `${label}: a match played (ruling 127)`).toBe(true);
      const rows = rowsOf(m, cfg, l, events);
      const total = (k: string) => rows.reduce((t, r) => t + (r.stats[k] ?? 0), 0);
      expect(total("goals"), `${label}: the goals played stand`).toBe(2 * s.goals);
      expect(total("clean_sheets"), `${label}: a keeper who conceded nothing keeps the clean sheet`).toBe(s.cleanSheets);
      for (const k of RESULT_KEYS) expect(total(k), `${label}: no personal ${k}`).toBe(0);
      checked++;
    }
    expect(checked).toBe(SCENES.length);
  });

  it("the fold's output changed for the same ledger, so the fold version moved past ruling 120's 5 (R115-2)", () => {
    expect(STATS_FOLD_VERSION).toBeGreaterThanOrEqual(6);
  });
});
