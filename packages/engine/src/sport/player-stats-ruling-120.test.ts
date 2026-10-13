// W2b ruling 120 (2026-10-12, owner "A"): an abandon counts as a match played in players' stats only if `playRecorded`
// is true before it — any active sport event after `core.start`, scoring or not (ruling 114), and in chess the Start
// itself (ruling 118). With nothing played, nobody's stats get a match, whatever the abandon's result or settle; with
// something played, X-PS-2 applies as before. The ruling's example: cricket started, then rain before the first ball.
//
// The expected values come from the ruling's text, never from the fold or the reader: each scene states, from the
// events it is built of, whether anything was played before its abandon — a sport event left active after the Start,
// or, where the module declares its Start play, the Start. "No match for anybody" is checked as `playedInStats` false
// (asked with the module, and with the model alone as the shared fold asks it) and every per-match key zero for every
// player; "a match" as `playedInStats` true and each declared appearance key one. Every scene is folded through the
// real kernel first, so the sweep reads only ledgers the product records; a refusal is named and counted. Every sport.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { aggregatePlayerStats, playedInStats, type PlayerStatRow, type PlayerStatsFoldCtx, type PlayerStatsModel } from "../stats/stats.ts";
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
const ABANDON: Step = { type: "core.abandon", payload: { reason: "rain" } };
const SETTLE: Step = { type: "core.settle", payload: { winner: H, method: "higher_seed" } };
/** Chess's pairing card before the Start (player-stats-ruling-115.test.ts): what its "games" appearance counts. */
const PRE: Record<string, Step[]> = {
  boardgame: [{ type: "boardgame.pairing", payload: { white: H, homePerson: "H-p1", awayPerson: "A-p1" } }],
};
/** The per-MATCH keys a person's row counts (player-stats-forfeit.test.ts): an appearance, a result, a clean sheet. */
const MATCH_KEYS = ["matches", "games", "wins", "draws", "losses", "clean_sheets"] as const;
/** The appearance keys: a match played counts one for every player. */
const APPEARANCE_KEYS = ["matches", "games"] as const;
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

/** Ruling 114's non-scoring play, per sport, from each module's own declarations (testkit/after-start-events.ts). */
const NON_SCORING = new Map(
  builtinModules
    .flatMap((m) => reachableAfterStart(m as never))
    .filter((s) => !s.scoring)
    .map((s) => [s.sport, s] as const),
);

describe("ruling 120: an abandon is a match in players' stats only if something was played before it (X-PS-2, X-AB-1)", () => {
  it("ruling 120 + X-PS-2 + X-AB-1: after a bare Start, a settle, or play voided away, an abandon is no match for anybody (chess: the Start is play); after play — scoring or not — it is a match; every declared cfg of every sport", () => {
    const n = {
      sports: 0, cfgs: 0, scenes: 0, refused: 0, noPlay: 0, unplayed: 0, played: 0, nonScoring: 0,
      cricketNoResult: 0, chessStartAbandon: 0, perMatchPinned: 0, appearancePinned: 0, settledUnplayed: 0, voidedUnplayed: 0,
    };
    const refusals = new Map<string, number>();
    const sports = new Set<string>();
    forEachSport(({ module: m }) => {
      const model = m.playerStats;
      if (model === undefined) return;
      n.sports++;
      sports.add(m.key);
      const l = defaultLineupPair(m.positions);
      const persons = [...l.home.slots, ...l.away.slots].map((s) => s.personId);
      const pre = PRE[m.key] ?? [];
      const startIsPlay = m.startIsPlay === true;
      const perMatch = declared(model, MATCH_KEYS);
      const appearance = declared(model, APPEARANCE_KEYS);
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
        // [scene, steps, the cfg it is played under, the ruling's answer: was anything played before the abandon?]
        const scenes: [string, Step[] | null, unknown, boolean][] = [
          ["a bare Start, then the abandon", [...pre, START, ABANDON], cfg, startIsPlay],
          ["a bare Start, the abandon, then a settle", [...pre, START, ABANDON, SETTLE], cfg, startIsPlay],
          ["play voided away, the abandon, then a settle", P && [...pre, START, P, { type: "core.void", payload: {}, voidsIndex: at }, ABANDON, SETTLE], playCfg, startIsPlay],
          ["play, then the abandon", P && [...pre, START, P, ABANDON], playCfg, true],
          ["play, the abandon, then a settle", P && [...pre, START, P, ABANDON, SETTLE], playCfg, true],
          ["non-scoring play (ruling 114), then the abandon", NS && [...pre, START, NS, ABANDON], cfg, true],
        ];
        for (const [what, steps, c, played] of scenes) {
          if (steps === null) continue;
          const events = seqd(steps);
          const refused = refusalOf(() => foldMatchWithStoppage(m as never, c as never, l, events));
          if (refused !== null) {
            const key = `${m.key}: ${what}: ${refused}`;
            refusals.set(key, (refusals.get(key) ?? 0) + 1);
            n.refused++;
            continue;
          }
          n.scenes++;
          expect(playedInStats(events, m), label(`${what}: the one reader, with the module`)).toBe(played);
          expect(playedInStats(events, { playerStats: model }), label(`${what}: the shared fold's reading, the model alone`)).toBe(played);
          const rows = rowsOf(m, c, l, events);
          if (!played) {
            n.unplayed++;
            if (perMatch.length > 0) {
              for (const p of persons) for (const k of perMatch) expect(keyOf(rows, p, k), label(`${what}: ${p}'s ${k}`)).toBe(0);
              n.perMatchPinned++;
            }
            if (steps.includes(SETTLE)) n.settledUnplayed++;
            if (steps.some((s) => s.type === "core.void")) n.voidedUnplayed++;
            if (m.key === "cricket" && (outcomeOf(m as never, foldMatchWithStoppage(m as never, c as never, l, events) as never) as { kind?: string } | null)?.kind === "no_result") n.cricketNoResult++;
          } else {
            n.played++;
            if (NS !== null && steps.includes(NS)) n.nonScoring++;
            if (startIsPlay && what === "a bare Start, then the abandon") n.chessStartAbandon++;
            if (appearance.length > 0) {
              for (const p of persons) for (const k of appearance) expect(keyOf(rows, p, k), label(`${what}: ${p}'s ${k}`)).toBe(1);
              n.appearancePinned++;
            }
          }
        }
      }
    });
    const report = JSON.stringify({ ...n, refusals: Object.fromEntries(refusals) });
    // Not vacuous: every sport with a players'-stats model, every scene kind reached, and the ruling's own example.
    expect([...sports].sort(), report).toEqual(builtinModules.filter((m) => m.playerStats !== undefined).map((m) => m.key).sort());
    expect(n.scenes, report).toBeGreaterThan(n.cfgs * 3);
    expect(n.unplayed, report).toBeGreaterThan(n.cfgs);
    expect(n.played, report).toBeGreaterThan(n.cfgs);
    expect(n.settledUnplayed, report).toBeGreaterThan(0);
    expect(n.voidedUnplayed, report).toBeGreaterThan(0);
    expect(n.nonScoring, `ruling 114's non-scoring play reached: ${report}`).toBeGreaterThan(0);
    expect(n.cricketNoResult, `the ruling's example, cricket abandoned before a ball as a no result: ${report}`).toBeGreaterThan(0);
    expect(n.chessStartAbandon, `ruling 118: chess abandoned after its bare Start is a game: ${report}`).toBeGreaterThan(0);
    expect(n.perMatchPinned, report).toBeGreaterThan(0);
    expect(n.appearancePinned, report).toBeGreaterThan(0);
    expect(n.noPlay, report).toBe(0);
  });
});
