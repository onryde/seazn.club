// W2b ruling 115 (2026-10-12, owner "A"): a disqualification with nothing played is treated like a walkover. It covers
// a disqualification before `core.start` and one after a Start with nothing played (rulings 112 and 114: `playRecorded`,
// any active sport event after the Start). Its credit is the sport's walkover credit (ruling 113, built), and in
// players' stats it is X-PS-1's: no match played for either side's players, no personal W/L. Once something is played
// a disqualification is in-match and X-PS-2 applies — a match for both sides' players, W/L as decided.
//
// The expected values come from the ruling text, never from the stats fold: "treated like a walkover" is checked as the
// SAME rows a walkover at the same point earns, "in-match" as the same rows a retirement at the same point earns (X-PS-2
// names the two together), and "not a match played" as a zero `matches` count for every player. Every scene is first
// folded through the real kernel, so the sweep reads only ledgers the product can record (or names the refusal).
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, outcomeOf, playRecorded, resolveVoids, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { aggregatePlayerStats, forfeitStatsRole, playedInStats, type PlayerStatRow, type PlayerStatsFoldCtx, type PlayerStatsModel } from "../stats/stats.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { onePlayEvent } from "../testkit/play-event.ts";
import type { AnySportModule } from "./module.ts";

const H = "H";
const A = "A";
const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
/** Re-sequence a scene so every envelope's seq and id follow its position. */
const seqd = (events: readonly { type: string; payload: unknown; voidsIndex?: number }[]): EventEnvelope[] =>
  events.map((e, i) => ev(i + 1, e.type, e.payload, e.voidsIndex === undefined ? undefined : `e-${e.voidsIndex + 1}`));
/** The per-MATCH keys a person's row counts (player-stats-forfeit.test.ts): an appearance, a result, a clean sheet. */
const MATCH_KEYS = ["matches", "games", "wins", "draws", "losses", "clean_sheets"] as const;
const declaredMatchKeys = (model: PlayerStatsModel): string[] => {
  const declared = new Set([...model.metrics.map((x) => x.key), ...(model.folded?.keys.map((k) => k.key) ?? [])]);
  return MATCH_KEYS.filter((k) => declared.has(k));
};
/** Chess's pairing card before the Start: what its "games" appearance counts (W4). A fixture, as in
 *  player-stats-forfeit.test.ts — chess alone records its players before play. */
const PRE: Record<string, { type: string; payload: unknown }[]> = {
  boardgame: [{ type: "boardgame.pairing", payload: { white: H, homePerson: "H-p1", awayPerson: "A-p1" } }],
};

type Step = { type: string; payload: unknown; voidsIndex?: number };
const forfeit = (reason: string): Step => ({ type: "core.forfeit", payload: { by: A, reason } });

/** The engine's players'-stats reading of a ledger: `playedInStats`, the one reader every surface asks (the shared fold,
 *  apps/web's match counts). Cross-checked against its two parts — the model's own `unplayed`, else `forfeitStatsRole`
 *  — so the export cannot drift from what the fold's roles say. */
function statsMatchOf(m: AnySportModule, model: PlayerStatsModel, events: readonly EventEnvelope[]): boolean {
  const active = resolveVoids([...events]);
  const parts = !(model.unplayed?.(active) ?? forfeitStatsRole(active, undefined, m) === "unplayed");
  const reader = playedInStats(events, m);
  expect(reader, "playedInStats agrees with the model's unplayed / forfeitStatsRole").toBe(parts);
  return reader;
}

function rowsOf(m: AnySportModule, cfg: unknown, l: LineupPair, events: readonly EventEnvelope[]): PlayerStatRow[] {
  const persons: Record<string, string[]> = { [H]: l.home.slots.map((s) => s.personId), [A]: l.away.slots.map((s) => s.personId) };
  // "individual" for every sport: the fold's kind guard credits a "team" entrant nobody, which would make the
  // appearance assertions vacuous for the team sports (player-stats-forfeit.test.ts).
  const ctx: PlayerStatsFoldCtx = { entrants: [{ id: H, kind: "individual" }, { id: A, kind: "individual" }], personsOf: (id) => persons[id] ?? [], cfg };
  return aggregatePlayerStats(events, m.playerStats!, l, ctx);
}
const matchesOf = (rows: PlayerStatRow[], person: string) => rows.find((r) => r.personId === person)?.stats.matches ?? 0;
const perMatch = (rows: PlayerStatRow[], keys: readonly string[]) => rows.reduce((n, r) => n + keys.reduce((k, key) => k + (r.stats[key] ?? 0), 0), 0);

function refusalOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    if (EngineError.is(e)) return e.code;
    throw e;
  }
}

describe("ruling 115: a disqualification with nothing played is treated like a walkover in players' stats (X-PS-1, X-PS-2, X-RT-1)", () => {
  it("ruling 115 + X-PS-1 + X-PS-2 + X-RT-1: a disqualification before the Start, after a bare Start, or after its only play was voided (before or after the forfeit) is no match played — the walkover's rows, matches 0 for every player; after play it is a match — the retirement's rows, matches 1 — every declared cfg of every sport", () => {
    const n = { cfgs: 0, startIsPlayCfgs: 0, preRefused: 0, preAdmitted: 0, bare: 0, played: 0, voidedBefore: 0, voidedAfter: 0, noPlay: 0, matchesPinned: 0, perMatchPinned: 0 };
    const sports = new Set<string>();
    forEachSport(({ module: m }) => {
      if (m.playerStats === undefined) return;
      const model = m.playerStats;
      const keys = declaredMatchKeys(model);
      const l = defaultLineupPair(m.positions);
      const persons = [...l.home.slots, ...l.away.slots].map((s) => s.personId);
      const pre: Step[] = PRE[m.key] ?? [];
      const start: Step = { type: "core.start", payload: {} };
      sports.add(m.key);
      for (const { name, cfg } of declaredCfgs(m as never)) {
        n.cfgs++;
        const label = (s: string) => `${m.key}/${name}: ${s}`;
        const fold = (steps: Step[], c: unknown = cfg) => foldMatchWithStoppage(m as never, c as never, l, seqd(steps));
        /** "treated like a walkover": same reading, same rows; no player's matches count moves. */
        const expectWalkoverLike = (steps: Step[], walkover: Step[], what: string, c: unknown = cfg) => {
          const events = seqd(steps);
          expect(playRecorded(events, m), label(`${what}: nothing played`)).toBe(false);
          expect(statsMatchOf(m, model, events), label(`${what}: not a match played`)).toBe(false);
          const rows = rowsOf(m, c, l, events);
          expect(rows, label(`${what}: the walkover's rows`)).toEqual(rowsOf(m, c, l, seqd(walkover)));
          if (keys.includes("matches")) {
            for (const p of persons) expect(matchesOf(rows, p), label(`${what}: ${p}'s matches`)).toBe(0);
            n.matchesPinned++;
          }
          if (keys.length > 0) {
            expect(perMatch(rows, keys), label(`${what}: no per-match key`)).toBe(0);
            n.perMatchPinned++;
          }
        };

        // Before the Start: X-RS-1 records a disqualification from the Start on, so the kernel refuses it — the stats
        // reading of the ledger is still the walkover's (ruling 115 covers it).
        const preDq = [...pre, forfeit("disqualified")];
        const refused = refusalOf(() => fold(preDq));
        if (refused === null) n.preAdmitted++;
        else {
          expect(refused, label("a disqualification before the Start")).toBe("FORFEIT_REASON_WRONG_PHASE");
          n.preRefused++;
        }
        expectWalkoverLike(preDq, [...pre, forfeit("walkover")], "a disqualification before the Start");

        // After a bare Start: admitted (a disqualification from the Start), the walkover's credit (ruling 113) and the
        // walkover's stats (ruling 115). Ruling 118: where the Start is play (chess) a bare Start is not nothing played
        // — a DQ after it is in-match (forfeit-ruling-118.test.ts), so this scene and the voided ones are not its.
        const startIsPlay = m.startIsPlay === true;
        if (startIsPlay) n.startIsPlayCfgs++;
        const bare = [...pre, start, forfeit("disqualified")];
        expect(outcomeOf(m as never, fold(bare) as never), label("after a bare Start")).toMatchObject({ kind: "award", winner: H, loser: A, reason: "disqualified" });
        if (!startIsPlay) {
          expectWalkoverLike(bare, [...pre, start, forfeit("walkover")], "after a bare Start");
          n.bare++;
        }

        // Something played: the sport's own play from its generator (chess's one event decides a plain game; its
        // bracket deciders hold a draw instead).
        const prefix = seqd([...pre, start]);
        const playCfg = [cfg, m.configSchema.parse({ ...(cfg as object), ...m.bracketDeciders(cfg as never) })].find((c) => onePlayEvent(m, c, l, prefix) !== null);
        if (playCfg === undefined) { n.noPlay++; continue; }
        const play = onePlayEvent(m, playCfg, l, prefix)!;
        const p: Step = { type: play.type, payload: play.payload };
        const playIndex = pre.length + 1;

        const played = [...pre, start, p, forfeit("disqualified")];
        expect(outcomeOf(m as never, fold(played, playCfg) as never), label("after play")).toMatchObject({ kind: "award", winner: H, loser: A, reason: "disqualified" });
        expect(playRecorded(seqd(played), m), label("after play: something played")).toBe(true);
        expect(statsMatchOf(m, model, seqd(played)), label("after play: a match played (X-PS-2)")).toBe(true);
        const rows = rowsOf(m, playCfg, l, seqd(played));
        expect(rows, label("after play: the retirement's rows (X-PS-2)")).toEqual(rowsOf(m, playCfg, l, seqd([...pre, start, p, forfeit("retired")])));
        if (keys.includes("matches")) for (const q of persons) expect(matchesOf(rows, q), label(`after play: ${q}'s matches`)).toBe(1);
        if (keys.length > 0) expect(perMatch(rows, keys), label("after play: a per-match key")).toBeGreaterThan(0);
        n.played++;
        if (startIsPlay) continue; // ruling 118: voiding the play leaves the Start, which is play

        // The only play voided, then the disqualification: nothing played again.
        const voidedBefore = [...pre, start, p, { type: "core.void", payload: {}, voidsIndex: playIndex }, forfeit("disqualified")];
        expect(outcomeOf(m as never, fold(voidedBefore, playCfg) as never), label("play voided, then the DQ")).toMatchObject({ kind: "award", reason: "disqualified" });
        expectWalkoverLike(voidedBefore, [...pre, start, p, { type: "core.void", payload: {}, voidsIndex: playIndex }, forfeit("walkover")], "play voided, then the DQ", playCfg);
        n.voidedBefore++;

        // The disqualification after play, then the play voided (a later correction): the active ledger is a bare
        // Start and the forfeit — nothing played.
        const voidedAfter = [...pre, start, p, forfeit("disqualified"), { type: "core.void", payload: {}, voidsIndex: playIndex }];
        expect(refusalOf(() => fold(voidedAfter, playCfg)), label("the DQ, then its play voided")).toBeNull();
        expectWalkoverLike(voidedAfter, [...pre, start, forfeit("walkover")], "the DQ, then its play voided", playCfg);
        n.voidedAfter++;
      }
    });
    // Anti-vacuity: every sport with a stats model, every declared cfg, each scene counted.
    expect(sports.size).toBe(11);
    expect(n.cfgs).toBeGreaterThanOrEqual(40);
    // X-RS-1 records a disqualification from the Start on: the kernel refuses every one before it.
    expect([n.preRefused, n.preAdmitted]).toEqual([n.cfgs, 0]);
    expect(n.startIsPlayCfgs, "ruling 118's chess cfgs, left to forfeit-ruling-118.test.ts").toBeGreaterThan(0);
    expect(n.bare).toBe(n.cfgs - n.startIsPlayCfgs);
    // Every declared cfg reaches play (chess through its bracket deciders' draw).
    expect([n.played, n.noPlay]).toEqual([n.cfgs, 0]);
    expect(n.voidedBefore).toBe(n.played - n.startIsPlayCfgs);
    expect(n.voidedAfter).toBe(n.played - n.startIsPlayCfgs);
    expect(n.matchesPinned).toBeGreaterThan(0);
    expect(n.perMatchPinned).toBeGreaterThan(0);
    // Measured 2026-10-12: 41 declared cfgs in 11 sports, each refused before the Start and reaching play; 72 nothing-played
    // scenes pinned matches 0 (the sports that count "matches"), 144 pinned every per-match key 0 (all but cricket).
  });
});
