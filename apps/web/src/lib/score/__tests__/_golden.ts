// The engine's recorded golden streams, folded prefix by prefix — the corpus machinery Match Day's SSR sweep and the score
// reader's own sweep share (task B3; one corpus, not two). Every summary here is the ENGINE's own fold of a recorded stream:
// no test builds a summary by hand, so the fields a reader is checked against are the engine's declarations.
import {
  EngineError,
  foldMatchWithStoppage,
  outcomeOf,
  summaryOf,
  type EventEnvelope,
  type LineupPair,
} from "@seazn/engine/core";
import { registerBuiltins } from "@seazn/engine/sports";
import { registry, resolvePositions, type AnySportModule, type SportRegistry } from "@seazn/engine/sport";
import { defaultLineupPair, goldenCorpora } from "@seazn/engine/testkit";
import type { MatchDaySummary } from "@/lib/match-day/types";

try {
  registerBuiltins(registry);
} catch (err) {
  // Another suite in this worker already booted the shared default registry.
  if (!EngineError.is(err, "MODULE_DUPLICATE")) throw err;
}

/** The golden corpora (@seazn/engine/testkit): each sport's recorded streams, found by walking the engine's tree. */
export interface GoldenStream {
  config: string;
  lineups?: LineupPair;
  events: { type: string; payload: unknown; voids?: string }[];
}
export interface GoldenCorpus {
  key: string;
  configs: Record<string, unknown>;
  streams: GoldenStream[];
}
export const CORPORA: GoldenCorpus[] = goldenCorpora().map(({ corpus }) => corpus as GoldenCorpus);

/** Every sport the engine registers (never a list typed here: a new sport joins a sweep by registering). */
export const SPORTS: string[] = [];
registerBuiltins({
  register(m: AnySportModule) {
    SPORTS.push(m.key);
  },
  get: () => {
    throw new Error("capture registry: get");
  },
  latest: () => {
    throw new Error("capture registry: latest");
  },
} as SportRegistry);

/** One prefix of one recorded stream, folded: the engine's summary there and whether the match is decided at that point. */
export interface GoldenMoment {
  summary: MatchDaySummary;
  /** The engine's folded STATE at that point (opaque here): the oracles below read the facts a summary only words. */
  state: unknown;
  decided: boolean;
  /** Index of the stream in the corpus and the prefix length — a failing sweep names the moment it failed at. */
  stream: number;
  events: number;
}

function envelopes(stream: GoldenStream): EventEnvelope[] {
  return stream.events.map((e, i) => ({
    id: `e-${i}`,
    fixtureId: "fx-golden",
    seq: i,
    type: e.type,
    payload: e.payload,
    recordedAt: new Date(Date.UTC(2026, 9, 31, 11, 0, i)).toISOString(),
    recordedBy: null,
    ...(e.voids === undefined ? {} : { voids: e.voids }),
  }));
}

/**
 * Every moment of `key`'s recorded streams that the engine folds: each prefix that holds a scoring event (not only `core.*`
 * bookkeeping) and carries a headline. A prefix the fold refuses (a void whose target is cut off) is not a moment of play and is
 * skipped. Empty for a sport with no corpus — a sweep counts those apart, it never invents one.
 */
export function goldenMoments(key: string): GoldenMoment[] {
  const corpus = CORPORA.find((c) => c.key === key);
  if (corpus === undefined) return [];
  const mod = registry.latest(key) as AnySportModule;
  const out: GoldenMoment[] = [];
  corpus.streams.forEach((stream, s) => {
    const cfg = mod.configSchema.parse(corpus.configs[stream.config]);
    const lineups = stream.lineups ?? defaultLineupPair(resolvePositions(mod, cfg));
    const all = envelopes(stream);
    for (let k = 1; k <= all.length; k++) {
      const prefix = all.slice(0, k);
      if (!prefix.some((e) => !e.type.startsWith("core."))) continue;
      let folded: ReturnType<typeof foldMatchWithStoppage>;
      try {
        folded = foldMatchWithStoppage(mod, cfg, lineups, prefix);
      } catch {
        continue;
      }
      const summary = summaryOf(mod, folded) as MatchDaySummary;
      if (!summary.headline) continue;
      out.push({ summary, state: folded.state, decided: outcomeOf(mod, folded) !== null, stream: s, events: k });
    }
  });
  return out;
}

/**
 * The engine's summary of a match IN PLAY for `key`: the latest prefix of one of its recorded golden streams that has scored
 * something, folds, is not decided, and satisfies `pick`. Longest streams first, longest prefix first. Null when the sport has
 * no corpus or no such moment — a sweep counts those apart, it never invents one.
 */
export function inPlaySummary(key: string, pick: (s: MatchDaySummary) => boolean = () => true): MatchDaySummary | null {
  const corpus = CORPORA.find((c) => c.key === key);
  if (corpus === undefined) return null;
  const mod = registry.latest(key) as AnySportModule;
  for (const stream of [...corpus.streams].sort((a, b) => b.events.length - a.events.length)) {
    const cfg = mod.configSchema.parse(corpus.configs[stream.config]);
    const lineups = stream.lineups ?? defaultLineupPair(resolvePositions(mod, cfg));
    const all = envelopes(stream);
    for (let k = all.length; k >= 1; k--) {
      const prefix = all.slice(0, k);
      if (!prefix.some((e) => !e.type.startsWith("core."))) break;
      let folded: ReturnType<typeof foldMatchWithStoppage>;
      try {
        folded = foldMatchWithStoppage(mod, cfg, lineups, prefix);
      } catch {
        continue; // a prefix the fold refuses (a void whose target is cut off): not a moment of play
      }
      if (outcomeOf(mod, folded) !== null) continue;
      const summary = summaryOf(mod, folded) as MatchDaySummary;
      if (summary.headline && pick(summary)) return summary;
    }
  }
  return null;
}

/**
 * The engine's fold of `events` under one of `key`'s recorded configs — for a moment the recorded streams stop short of (a stream
 * that ends as a match tie-break begins, say): the events are the corpus's own prefix plus the engine's own event types, and the
 * summary is still the ENGINE's. Throws if the fold refuses, so a wrong extension fails loudly instead of yielding no moment.
 */
export function foldGolden(
  key: string,
  config: string,
  events: GoldenStream["events"],
): { summary: MatchDaySummary; state: unknown; decided: boolean } {
  const corpus = CORPORA.find((c) => c.key === key);
  if (corpus === undefined) throw new Error(`no golden corpus for ${key}`);
  const mod = registry.latest(key) as AnySportModule;
  const cfg = mod.configSchema.parse(corpus.configs[config]);
  const lineups = defaultLineupPair(resolvePositions(mod, cfg));
  const folded = foldMatchWithStoppage(mod, cfg, lineups, envelopes({ config, events }));
  return { summary: summaryOf(mod, folded) as MatchDaySummary, state: folded.state, decided: outcomeOf(mod, folded) !== null };
}

/**
 * Tennis in a MATCH TIE-BREAK with `points` played in it (`"H"` / `"A"` by the entrant who won each). No recorded stream plays a
 * point of one — they stop as it begins — so this takes the corpus's own prefix that ends there (the engine says
 * `gameKind: "matchTiebreak"`) and extends it with the engine's own `tennis.point` events; the summary is the engine's fold.
 */
export function tennisMatchTiebreak(points: readonly ("H" | "A")[]): { summary: MatchDaySummary; state: unknown; decided: boolean } {
  const corpus = CORPORA.find((c) => c.key === "tennis")!;
  const at = goldenMoments("tennis").find((m) => (m.summary.detail as { gameKind?: unknown }).gameKind === "matchTiebreak");
  if (at === undefined) throw new Error("no recorded tennis moment at the start of a match tie-break");
  const stream = corpus.streams[at.stream]!;
  const played = points.map((by) => ({ type: "tennis.point", payload: { by } }));
  return foldGolden("tennis", stream.config, [...stream.events.slice(0, at.events), ...played]);
}

// ---- Oracles: the score's levels read off the engine's OWN summary fields ---------------------------------------------------
// Deliberately not lib/score/levels.ts's path (the open entry of `detail.sets`): a set kernel's live points are its match totals
// less the closed sets, and tennis's levels are `detail.games` / `detail.game`. Never the headline, whose prose cannot tell a
// finished tie-break's "7–6(3)" from a game's live points.

type SetRow = { home: number; away: number; closed: boolean };
const detail = (s: MatchDaySummary): Record<string, unknown> =>
  typeof s.detail === "object" && s.detail !== null ? (s.detail as Record<string, unknown>) : {};

/** The engine's set table; empty for a sport without one. */
export const setTable = (s: MatchDaySummary): SetRow[] => (Array.isArray(detail(s).sets) ? (detail(s).sets as SetRow[]) : []);
/** Whether a set is in progress: the engine's table has an entry it marks `closed: false`. */
export const hasOpenSet = (s: MatchDaySummary): boolean => setTable(s).some((x) => !x.closed);

/** The live level: tennis's game line (`detail.game`: "40–Ad", "TB 3–2", "MTB 5–3") while a set is open; a set kernel's open set,
 *  its match totals (`detail.points`) less the closed sets. Null between sets, before the first point and once every set closed. */
export function liveOf(s: MatchDaySummary): string | null {
  if (!hasOpenSet(s)) return null;
  const d = detail(s);
  if (typeof d.game === "string") return d.game;
  const points = d.points as { home: number; away: number };
  const closed = setTable(s).filter((x) => x.closed);
  return `${points.home - closed.reduce((n, x) => n + x.home, 0)}–${points.away - closed.reduce((n, x) => n + x.away, 0)}`;
}

/** Tennis's middle level: the games of the set in play (`detail.games`); none for a set kernel or a match tie-break. */
export function midOf(s: MatchDaySummary): string | null {
  const d = detail(s);
  if (typeof d.game !== "string" || !hasOpenSet(s) || d.gameKind === "matchTiebreak") return null;
  const games = d.games as { home: number; away: number };
  return `${games.home}–${games.away}`;
}

/** ITF Rule 5(a): a standard game's points won, 0 to 3, are called 0, 15, 30, 40 — the rulebook's, typed here on purpose. */
const POINT_CALLS = ["0", "15", "30", "40"] as const;

/**
 * The live level's score PER SIDE, home then away — read off the engine's folded STATE (`state.points`, `state.games` is not
 * needed), never off the `detail.game` string the reader under test splits. Tennis: a standard game in the rulebook's calls
 * (deuce is 40–40, advantage "Ad" against the other's "40"), a tie-break (set or match) in plain points. A set kernel: its match
 * totals less the closed sets. Null while no set is open.
 */
export function liveSidesOf(m: { summary: MatchDaySummary; state: unknown }): [string, string] | null {
  if (!hasOpenSet(m.summary)) return null;
  const d = detail(m.summary);
  if (typeof d.game === "string") {
    const p = (m.state as { points: { kind: string; home: number; away: number; advantage?: "home" | "away" } }).points;
    if (p.kind !== "standard") return [String(p.home), String(p.away)];
    if (p.home === 3 && p.away === 3) return [p.advantage === "home" ? "Ad" : "40", p.advantage === "away" ? "Ad" : "40"];
    return [POINT_CALLS[p.home]!, POINT_CALLS[p.away]!];
  }
  const points = d.points as { home: number; away: number };
  const closed = setTable(m.summary).filter((x) => x.closed);
  return [String(points.home - closed.reduce((n, x) => n + x.home, 0)), String(points.away - closed.reduce((n, x) => n + x.away, 0))];
}

/**
 * What a court card's small per-side figures must read at `m` — the documented format, from the engine's own fields: a set
 * sport's open set "(12)"; tennis in play "(games) points" ("(3) 40"); tennis not in play (a match stopped mid-set) just
 * "(games)"; a match tie-break "(points)". Games are `detail.games`, points are `liveSidesOf` (the folded state), so neither is
 * the open entry or the label the reader under test reads. `[null, null]` while no set is open.
 */
export function courtSubLinesOracle(m: { summary: MatchDaySummary; state: unknown }, inPlay: boolean): [string | null, string | null] {
  const sides = liveSidesOf(m);
  if (sides === null) return [null, null];
  const d = detail(m.summary);
  if (typeof d.game !== "string" || d.gameKind === "matchTiebreak") return [`(${sides[0]})`, `(${sides[1]})`];
  const games = d.games as { home: number; away: number };
  return inPlay
    ? [`(${games.home}) ${sides[0]}`, `(${games.away}) ${sides[1]}`]
    : [`(${games.home})`, `(${games.away})`];
}
