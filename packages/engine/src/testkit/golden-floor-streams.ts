// The golden floor's APPEND path (GF-1): the streams `EXTEND_GOLDEN=1` writes so that `floorHoles` comes back empty.
//
// WHY A SECOND BUILDER. `extendCorpus` appends the fewest generator walks that cover a missing tier type or optional
// field; a module's `arbitraryEvent` never emits `core.void`, a suspension, a note, an award, a finalize, a lineup change,
// a `withdrew` forfeit or a double walkover (chess aside), so no walk of it can reach the floor. These scenarios build the
// sequences a scorer really produces, each one a short, valid, named story, from the module's OWN generator plus the
// kernel events spliced in at points the fold itself confirms are live. Nothing here is a hand-typed score line.
//
//  undo       — a wrong tap undone mid-match (`core.void` of an event that did occur), then a late correction: an
//               earlier point struck from the ledger after the fact. The fold of a ledger with a void equals the
//               fold of the ledger without the target; both halves are asserted by the test that owns this file.
//  stoppage   — suspend, a note while stopped, resume; after the decision an award and the finalize. These events are
//               kernel-only, so the module walk underneath is the generator's own and keeps its natural outcome (which
//               is how a drawn football match, a tied cricket match are found: by the walk's seed, then dressed).
//  abandon    — play, a suspension that is never lifted, then the abandon.
//  walkover / double walkover / retired / disqualified / withdrew — a `core.forfeit` of each reason the kernel's phase
//               guard admits, after the play that reason needs. The withdrawal also carries the lineup changes (a
//               retirement, an entry, a substitution, a position change, an exempt replacement where the policy has
//               one), since a side that loses people then withdraws is a plain story.
//
// A scenario is attempted only for a sport whose floor still has a hole it serves, and only appends a stream that
// actually reduces the holes. Existing streams are never touched.
import { foldMatch, foldMatchWithStoppage, outcomeOf, playRecorded, type EventEnvelope } from "../core/events.ts";
import { EngineError } from "../core/errors.ts";
import { mulberry32, type Rng } from "../core/rng.ts";
import type { LineupPair } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { recomputeStream, slimStream, type GoldenCorpus, type GoldenEvent, type GoldenStream } from "./golden.ts";
import { eventToken, floorHoles, lineupOffers, outcomeToken, outcomeTokenOf, standingToken, STANDING_KERNEL, undoToken, UNDOABLE_KERNEL, type FloorToken } from "./golden-floor.ts";
import { buildWalk, defaultLineupPair, makeEnvelope } from "./helpers.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

/** A floor stream's `seed` is `scenarioIndex * FLOOR_SEED_STRIDE + generatorSeed`: unique per scenario inside a corpus
 *  (the epoch guard keys a stream by `config#seed`), never colliding with a plain generator seed, and still readable. */
export const FLOOR_SEED_STRIDE = 100_000;
/** How far a scenario searches generator seeds per config. A `tie` in cricket turns up around seed 460. */
const SEED_BUDGET = 3_000;
/** The longest walk a scenario will record. */
const WALK_MAX = 120;

const ev = (type: string, payload: unknown = {}): GoldenEvent => ({ type, payload });
const voidOf = (index: number): GoldenEvent => ({ type: "core.void", payload: {}, voids: `e-${index}` });

export interface Ctx {
  readonly module: AnySportModule;
  readonly corpus: GoldenCorpus;
  readonly cfgNames: readonly string[];
  readonly holes: ReadonlySet<FloorToken>;
}

export interface Built {
  readonly config: string;
  readonly seed: number;
  readonly lineups?: LineupPair;
  readonly events: GoldenEvent[];
}

const parsed = (ctx: Ctx, cfgName: string): unknown => ctx.module.configSchema.parse(ctx.corpus.configs[cfgName]) as unknown;
const defaultLineups = (ctx: Ctx, cfg: unknown): LineupPair => defaultLineupPair(resolvePositions(ctx.module, cfg));
const toGolden = (envelopes: readonly EventEnvelope[]): GoldenEvent[] => envelopes.map((e) => ({ type: e.type, payload: e.payload }));
const isTerminalCore = (type: string): boolean => type === "core.forfeit" || type === "core.abandon";

/** Whether this ledger folds, strictly (the write path). */
function folds(ctx: Ctx, cfg: unknown, lineups: LineupPair, events: readonly GoldenEvent[]): boolean {
  try {
    foldMatch(ctx.module as never, cfg as never, lineups, events.map((e, i) => makeEnvelope(i, e, e.voids)), STRICT_ALL);
    return true;
  } catch {
    return false;
  }
}

/** The MODULE's outcome of a state — what the corpora record (GOLDEN-POLICY), the one bare read in this file. No floor
 *  stream carries `core.settle` (it is exempt, `FLOOR_EXEMPTIONS`), so a settle that would move it cannot occur. */
function moduleOutcome(ctx: Ctx, state: unknown): ReturnType<AnySportModule["outcome"]> {
  return ctx.module.outcome(state);
}

function outcomeAfter(ctx: Ctx, cfg: unknown, lineups: LineupPair, events: readonly GoldenEvent[]): { state: unknown; token: string | null } {
  const state: unknown = foldMatch(ctx.module as never, cfg as never, lineups, events.map((e, i) => makeEnvelope(i, e, e.voids)), STRICT_ALL);
  const outcome = moduleOutcome(ctx, state);
  return { state, token: outcome === null ? null : outcomeTokenOf(JSON.stringify(outcome)) };
}

/** The EFFECTIVE outcome token of a ledger — the kernel's reading, so a forfeit, an abandon and a settle count, which the
 *  module's own outcome does not see. Null while the match is live. */
function effectiveToken(ctx: Ctx, cfg: unknown, lineups: LineupPair, events: readonly GoldenEvent[]): string | null {
  const folded = foldMatchWithStoppage(ctx.module as never, cfg as never, lineups, events.map((e, i) => makeEnvelope(i, e, e.voids)), STRICT_ALL);
  const outcome = outcomeOf(ctx.module as never, folded as never);
  return outcome === null ? null : outcomeTokenOf(JSON.stringify(outcome));
}

/** The per-side score lines of a state, as one comparable string: what a scorer sees move when a point is struck. */
const scoreLines = (ctx: Ctx, state: unknown): string => JSON.stringify(ctx.module.summary(state as never).perSide.map((side) => side.line));

/** One draw of a module-owned event from the generator at `state` (a forfeit or an abandon is not play). */
function drawSport(ctx: Ctx, state: unknown, rng: Rng): GoldenEvent | null {
  for (let i = 0; i < 25; i++) {
    const next = ctx.module.arbitraryEvent?.call(ctx.module, state as never, rng) ?? null;
    if (next === null) return null;
    if (!next.type.startsWith("core.")) return { type: next.type, payload: next.payload };
  }
  return null;
}

/** The sport events the corpus already records, each distinct `{type, payload}` once, in recorded order. A module whose
 *  generator only ever draws the deciding event (a board game's result) still has non-deciding events a real match
 *  records (the pairing card); the corpus knows them, the generator at the start state does not offer them. */
function recordedSportEvents(corpus: GoldenCorpus): GoldenEvent[] {
  const seen = new Set<string>();
  const out: GoldenEvent[] = [];
  for (const stream of corpus.streams) {
    for (const event of stream.events) {
      if (event.type.startsWith("core.") || event.voids !== undefined) continue;
      const key = JSON.stringify([event.type, event.payload]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: event.type, payload: event.payload });
    }
  }
  return out;
}

/** `[core.start, k module events]`, each drawn from the generator at the state the fold reaches (or, when the generator
 *  offers nothing that leaves the match live, a recorded non-deciding sport event); fewer than `k` if both run dry, and
 *  null when the match is decided before the prefix ends (a live prefix is the point). */
function livePrefix(ctx: Ctx, cfg: unknown, lineups: LineupPair, seed: number, k: number): GoldenEvent[] | null {
  const rng = mulberry32(seed);
  const events: GoldenEvent[] = [ev("core.start")];
  if (!folds(ctx, cfg, lineups, events)) return null;
  const pool = recordedSportEvents(ctx.corpus);
  for (let i = 0; i < k; i++) {
    const { state, token } = outcomeAfter(ctx, cfg, lineups, events);
    if (token !== null) return null;
    const drawn = drawSport(ctx, state, rng);
    const candidates = drawn === null ? pool : [drawn, ...pool];
    const next = candidates.find((candidate) => {
      const grown = [...events, candidate];
      return folds(ctx, cfg, lineups, grown) && outcomeAfter(ctx, cfg, lineups, grown).token === null;
    });
    if (next === undefined) break;
    events.push(next);
  }
  return outcomeAfter(ctx, cfg, lineups, events).token === null ? events : null;
}

/** A natural walk of the generator: decided, and free of the forfeits and abandons it sometimes draws (those are other
 *  scenarios' stories). */
function naturalWalk(ctx: Ctx, cfg: unknown, lineups: LineupPair, seed: number): { events: GoldenEvent[]; states: unknown[]; token: string } | null {
  let walk;
  try {
    walk = buildWalk(ctx.module, cfg, lineups, seed, WALK_MAX);
  } catch {
    return null;
  }
  if (walk.events.length < 3 || walk.events.some((e) => isTerminalCore(e.type))) return null;
  const last: unknown = walk.states[walk.states.length - 1];
  const outcome = moduleOutcome(ctx, last);
  if (outcome === null) return null;
  const token = outcomeTokenOf(JSON.stringify(outcome));
  if (token === null) return null;
  return { events: toGolden(walk.events), states: walk.states, token };
}

// ---------------------------------------------------------------------------------------------------------- undo

/** One kernel event a phone can mis-tap, and how the FOLD says it took effect. */
export interface KernelStrike {
  readonly type: (typeof UNDOABLE_KERNEL)[number];
  readonly event: GoldenEvent;
  /** The forfeit must follow recorded play (a retirement is a player leaving a match under way). */
  readonly needsPlay: boolean;
  /** True while the event is in force in `events`: the fold's own reading, never this file's. */
  inForce(ctx: Ctx, cfg: unknown, lineups: LineupPair, events: readonly GoldenEvent[]): boolean;
}

/** A forfeit decides the match: the effective outcome stops being null. */
const forfeitInForce: KernelStrike["inForce"] = (ctx, cfg, lineups, events) => effectiveToken(ctx, cfg, lineups, events) !== null;

/** An abandon decides nothing the module can see, but it ENDS play: while it is active the kernel refuses a forfeit with
 *  ABANDONED_SETTLE_OR_VOID ("settle it to decide it, or void the abandon first"). A void of the abandon clears that. */
const abandonInForce: KernelStrike["inForce"] = (ctx, cfg, lineups, events) => {
  try {
    effectiveToken(ctx, cfg, lineups, [...events, ev("core.forfeit", { by: lineups.home.entrantId, reason: "retired" })]);
    return false;
  } catch (error) {
    return error instanceof EngineError && error.code === "ABANDONED_SETTLE_OR_VOID";
  }
};

/** The kernel events a ledger strikes, in the order `buildUndo` splices them: the mis-tapped retirement, then the
 *  mis-tapped abandon. Each is `UNDOABLE_KERNEL`'s, and a sport that cannot take one is not given a stream without it. */
export function kernelStrikes(lineups: LineupPair): readonly KernelStrike[] {
  return [
    { type: "core.forfeit", event: ev("core.forfeit", { by: lineups.home.entrantId, reason: "retired" }), needsPlay: true, inForce: forfeitInForce },
    { type: "core.abandon", event: ev("core.abandon", { reason: "rain: the ground is waterlogged, called off, then play resumed" }), needsPlay: false, inForce: abandonInForce },
  ];
}

/** Records the strike's event at a point of `ledger` where the match is live and the kernel admits it, strikes it with
 *  `core.void` at once, and lets the ledger's remaining events play on to the result they always had. Only a point at or
 *  after `atLeast` is tried, nearest the middle first, so an earlier splice is never disturbed. Asserted by the fold before
 *  a splice is returned: the event TAKES EFFECT (`inForce`), the void CLEARS it and leaves the module state exactly as it
 *  was, and the whole ledger — every prefix of it — folds strictly to the result the unspliced ledger had. */
export function strikeKernelEvent(ctx: Ctx, cfg: unknown, lineups: LineupPair, ledger: readonly GoldenEvent[], strike: KernelStrike, atLeast: number): GoldenEvent[] | null {
  const result = effectiveToken(ctx, cfg, lineups, ledger);
  const mid = Math.floor((atLeast + ledger.length) / 2);
  const points: number[] = [];
  for (let q = atLeast; q < ledger.length; q++) points.push(q);
  points.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
  for (const q of points) {
    const head = ledger.slice(0, q);
    const tail = ledger.slice(q);
    // A tail void would point at a place the splice moves: the splice does not rewrite ids, it declines.
    if (tail.some((e) => e.voids !== undefined)) continue;
    if (strike.needsPlay && !playRecorded(head.map((e, i) => makeEnvelope(i, e, e.voids)), {})) continue;
    const decided = [...head, strike.event];
    const reopened = [...decided, voidOf(q)];
    const full = [...reopened, ...tail];
    try {
      // (The match being live where it is struck needs no guard of its own: a forfeit or an abandon after a decision is
      // refused by the fold - ALREADY_DECIDED - and the throw lands in the catch below.)
      if (!strike.inForce(ctx, cfg, lineups, decided)) continue;
      if (strike.inForce(ctx, cfg, lineups, reopened)) continue;
      if (JSON.stringify(outcomeAfter(ctx, cfg, lineups, reopened).state) !== JSON.stringify(outcomeAfter(ctx, cfg, lineups, head).state)) continue;
      if (effectiveToken(ctx, cfg, lineups, full) !== result) continue;
      for (let i = 1; i <= full.length; i++) effectiveToken(ctx, cfg, lineups, full.slice(0, i));
    } catch {
      continue;
    }
    return full;
  }
  return null;
}

function buildUndo(ctx: Ctx): Built | null {
  let fallback: { rank: number; built: Built } | null = null;
  for (const cfgName of ctx.cfgNames) {
    const cfg = parsed(ctx, cfgName);
    const lineups = defaultLineups(ctx, cfg);
    for (let seed = 1; seed <= 300; seed++) {
      const walk = naturalWalk(ctx, cfg, lineups, seed);
      if (walk === null) continue;
      const n = walk.events.length;
      // (1) A wrong tap, undone at the point the match is half over: an alternative event the generator offers at that
      // state is recorded, then voided, and the real walk carries on exactly as it would have.
      const j = Math.max(1, Math.floor(n / 2));
      const before: unknown = j === 0 ? ctx.module.init(cfg, lineups) : walk.states[j - 1];
      if (moduleOutcome(ctx, before) !== null) continue;
      // The wrong tap is a point (an event that moves the score line) whenever the generator offers one at this state.
      const lineBefore = scoreLines(ctx, before);
      let wrong: GoldenEvent | null = null;
      for (let t = 1; t <= 24 && wrong === null; t++) {
        const draw = drawSport(ctx, before, mulberry32(seed * 7919 + t));
        if (draw === null || !folds(ctx, cfg, lineups, [...walk.events.slice(0, j), draw])) continue;
        if (scoreLines(ctx, outcomeAfter(ctx, cfg, lineups, [...walk.events.slice(0, j), draw]).state) !== lineBefore) wrong = draw;
      }
      wrong ??= drawSport(ctx, before, mulberry32(seed * 7919 + 1));
      if (wrong === null || !folds(ctx, cfg, lineups, [...walk.events.slice(0, j), wrong])) continue;
      const tapped: GoldenEvent[] = [...walk.events.slice(0, j), wrong, voidOf(j), ...walk.events.slice(j)];
      if (!folds(ctx, cfg, lineups, tapped)) continue;
      // The void changed nothing: the ledger folds to the same state as the walk without the wrong tap.
      if (JSON.stringify(outcomeAfter(ctx, cfg, lineups, tapped).state) !== JSON.stringify(outcomeAfter(ctx, cfg, lineups, walk.events).state)) continue;
      // (1b) The decisive KERNEL events a phone can mis-tap, each struck and play resumed: a retirement, then an abandon.
      let spliced: GoldenEvent[] | null = tapped;
      let from = j + 2;
      for (const strike of kernelStrikes(lineups)) {
        spliced = strikeKernelEvent(ctx, cfg, lineups, spliced, strike, from);
        if (spliced === null) break;
        from = spliced.findIndex((e, i) => i >= from && e.type === strike.type) + 2;
      }
      if (spliced === null) continue;
      // (2) A late correction: an event struck AFTER later play, so the void is not adjacent to its target. The ledger
      // minus that event must still fold, and must differ from the ledger with it. Preference, best first: (a) an earlier
      // POINT (the score line a scorer reads moves), (b) an earlier event that moves the state (a toss, a pairing card:
      // the only earlier events a board game or a carrom match can lose without the later ones refusing), (c) the last
      // point, (d) the last event that moves the state. (c) and (d) are an immediate correction, kept only as a last resort.
      const base = outcomeAfter(ctx, cfg, lineups, spliced);
      const targets: number[] = [];
      for (let i = Math.floor(spliced.length * 0.6); i >= 0; i--) targets.push(i);
      targets.push(spliced.length - 1);
      const best: (GoldenEvent[] | null)[] = [null, null, null, null];
      for (const i of targets) {
        const target = spliced[i];
        if (target === undefined || target.type.startsWith("core.") || target.voids !== undefined) continue;
        if (spliced.some((e) => e.voids === `e-${i}`)) continue; // already struck
        const corrected: GoldenEvent[] = [...spliced, voidOf(i)];
        if (!folds(ctx, cfg, lineups, corrected)) continue;
        const after = outcomeAfter(ctx, cfg, lineups, corrected).state;
        if (JSON.stringify(after) === JSON.stringify(base.state)) continue;
        const point = scoreLines(ctx, after) !== scoreLines(ctx, base.state);
        const late = i < spliced.length - 1;
        const rank = (late ? 0 : 2) + (point ? 0 : 1);
        best[rank] ??= corrected;
      }
      const rank = best.findIndex((candidate) => candidate !== null && candidate !== undefined);
      if (rank < 0) continue;
      const built: Built = { config: cfgName, seed: 1 * FLOOR_SEED_STRIDE + seed, events: best[rank]! };
      if (rank <= 1) return built; // an EARLIER event struck after later play: nothing better to search for
      // Only an immediate correction on this walk: keep it, but go on looking (another config or seed may offer a late one).
      if (fallback === null || rank < fallback.rank) fallback = { rank, built };
    }
  }
  return fallback === null ? null : fallback.built;
}

// ----------------------------------------------------------------------------------------------------- stoppage

const NATURAL_PREFERENCE = ["draw", "tie", "no_result"] as const;

function buildStoppage(ctx: Ctx): Built | null {
  // Prefer the walk that ends on an outcome the floor is still missing: a stoppage does not touch module state.
  const wanted = NATURAL_PREFERENCE.find((t) => ctx.holes.has(outcomeToken(t)));
  for (const cfgName of ctx.cfgNames) {
    const cfg = parsed(ctx, cfgName);
    const lineups = defaultLineups(ctx, cfg);
    const person = lineups.home.slots[0]?.personId ?? "H-p1";
    for (let seed = 1; seed <= SEED_BUDGET; seed++) {
      const walk = naturalWalk(ctx, cfg, lineups, seed);
      if (walk === null) continue;
      if (wanted !== undefined && walk.token !== wanted) continue;
      const n = walk.events.length;
      const j = Math.max(1, Math.floor(n / 2));
      const before: unknown = walk.states[j - 1];
      if (moduleOutcome(ctx, before) !== null) continue;
      const events: GoldenEvent[] = [
        ...walk.events.slice(0, j),
        ev("core.suspend", { reason: "floodlight failure" }),
        ev("core.note", { text: "play stopped: the floodlights failed; teams stay on the pitch" }),
        ev("core.resume"),
        ...walk.events.slice(j),
        ev("core.award", { person, key: "motm" }),
        ev("core.finalize"),
      ];
      if (!folds(ctx, cfg, lineups, events)) continue;
      // The kernel-only events leave the module's story untouched: the match ends on the outcome the bare walk reached.
      // (Not on an equal STATE: `core.finalize` and `core.award` are folded by the module, which may record them.)
      if (outcomeAfter(ctx, cfg, lineups, events).token !== walk.token) continue;
      return { config: cfgName, seed: 2 * FLOOR_SEED_STRIDE + seed, events };
    }
    if (wanted === undefined) break; // any walk will do: the first config's first decided walk
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------ abandon

function buildAbandon(ctx: Ctx): Built | null {
  for (const cfgName of ctx.cfgNames) {
    const cfg = parsed(ctx, cfgName);
    const lineups = defaultLineups(ctx, cfg);
    for (let seed = 1; seed <= 40; seed++) {
      for (const k of [4, 2, 0]) {
        const prefix = livePrefix(ctx, cfg, lineups, seed, k);
        if (prefix === null) continue;
        const events: GoldenEvent[] = [
          ...prefix,
          ev("core.suspend", { reason: "thunderstorm" }),
          ev("core.abandon", { reason: "thunderstorm: lightning within ten miles, match abandoned" }),
        ];
        if (!folds(ctx, cfg, lineups, events)) continue;
        return { config: cfgName, seed: 3 * FLOOR_SEED_STRIDE + seed, events };
      }
    }
  }
  return null;
}

// ----------------------------------------------------------------------------------------------------- forfeits

/** `play`: the forfeit must follow recorded play. A retirement is a player leaving a match that was under way: the
 *  migration of ruling 113 reads a retired forfeit with nothing played before it as a walkover, so a retired stream
 *  without play would be a walkover stream wearing the wrong word. */
type ForfeitStory = { index: number; reason: string; by: "home" | "away" | "both"; ks: readonly number[]; lineup?: boolean; play?: boolean };

const FORFEIT_STORIES: Readonly<Record<string, ForfeitStory>> = {
  walkover: { index: 4, reason: "walkover", by: "away", ks: [0] },
  double_walkover: { index: 5, reason: "walkover", by: "both", ks: [0] },
  retired: { index: 6, reason: "retired", by: "home", ks: [5, 3, 1], play: true },
  disqualified: { index: 7, reason: "disqualified", by: "away", ks: [5, 3, 1, 0] },
  withdrew: { index: 8, reason: "withdrew", by: "home", ks: [4, 2, 0], lineup: true },
};

function buildForfeit(ctx: Ctx, story: ForfeitStory): Built | null {
  // The withdrawal story carries lineup changes when the floor still wants them, in the config whose policy accepts the
  // most types (cricket's `mutable`, football's `concussed`, volleyball's libero default).
  const wantsLineup = story.lineup === true && [...ctx.holes].some((t) => t.startsWith("event:core.lineup."));
  const offers = wantsLineup ? lineupOffers(ctx.module, ctx.corpus) : [];
  const best = offers.reduce<(typeof offers)[number] | null>((a, o) => (a === null || o.plan.accepted.length > a.plan.accepted.length ? o : a), null);
  const cfgNames = best === null ? ctx.cfgNames : [best.cfgName];
  for (const cfgName of cfgNames) {
    const cfg = parsed(ctx, cfgName);
    const lineups = best?.lineups ?? defaultLineups(ctx, cfg);
    const side = (which: "home" | "away" | "both"): string => (which === "both" ? "both" : lineups[which].entrantId);
    const payload = { by: side(story.by), reason: story.reason };
    for (const k of story.ks) {
      // Each story starts its seed search elsewhere, so the stories of one sport do not all replay the same first minutes.
      for (let seed = story.index; seed < story.index + 40; seed++) {
        const prefix = livePrefix(ctx, cfg, lineups, seed, k);
        if (prefix === null) continue;
        const events: GoldenEvent[] = [...prefix, ...(best === null ? [] : best.plan.events), ev("core.forfeit", payload)];
        if (!folds(ctx, cfg, lineups, events)) continue;
        // The forfeit's own prefix (everything before it) must read as play when the story says so — the kernel's reading.
        if (story.play === true && !playRecorded(prefix.map((e, i) => makeEnvelope(i, e, e.voids)), {})) continue;
        return { config: cfgName, seed: story.index * FLOOR_SEED_STRIDE + seed, ...(best === null ? {} : { lineups }), events };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------ driver

export interface Scenario {
  readonly id: string;
  /** The tokens this scenario exists to supply; it runs only while one of them is a hole. */
  serves(ctx: Ctx): FloorToken[];
  build(ctx: Ctx): Built | null;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "undo",
    serves: () => [eventToken("core.void"), ...UNDOABLE_KERNEL.map(undoToken)],
    build: buildUndo,
  },
  {
    id: "stoppage",
    serves: () => [
      ...["core.suspend", "core.resume", "core.note", "core.award", "core.finalize"].map(eventToken),
      ...NATURAL_PREFERENCE.map(outcomeToken),
    ],
    build: buildStoppage,
  },
  { id: "abandon", serves: () => [eventToken("core.abandon"), ...STANDING_KERNEL.map(standingToken)], build: buildAbandon },
  { id: "walkover", serves: () => [outcomeToken("award:walkover")], build: (c) => buildForfeit(c, FORFEIT_STORIES.walkover!) },
  { id: "double_walkover", serves: () => [outcomeToken("double_walkover")], build: (c) => buildForfeit(c, FORFEIT_STORIES.double_walkover!) },
  { id: "retired", serves: () => [outcomeToken("award:retired")], build: (c) => buildForfeit(c, FORFEIT_STORIES.retired!) },
  { id: "disqualified", serves: () => [outcomeToken("award:disqualified")], build: (c) => buildForfeit(c, FORFEIT_STORIES.disqualified!) },
  {
    id: "withdrew",
    serves: (c) => [outcomeToken("award:withdrew"), ...[...c.holes].filter((t) => t.startsWith("event:core.lineup."))],
    build: (c) => buildForfeit(c, FORFEIT_STORIES.withdrew!),
  },
];

export interface FloorExtension {
  readonly corpus: GoldenCorpus;
  /** `scenario config:seed` of every stream appended, in order. */
  readonly appended: string[];
  /** The holes no scenario could close. */
  readonly stillMissing: FloorToken[];
}

/** Appends the streams that close a sport's floor holes. Existing streams, configs and keys are carried over untouched;
 *  an unchanged corpus comes back unchanged (a second call appends nothing). */
export function extendFloor(module: AnySportModule, existing: GoldenCorpus, scenarios: readonly Scenario[] = SCENARIOS): FloorExtension {
  const corpus: GoldenCorpus = { ...existing, configs: { ...existing.configs }, streams: [...existing.streams] };
  const appended: string[] = [];
  const cfgNames = Object.keys(corpus.configs);
  let holes = new Set(floorHoles(module, corpus));
  for (const scenario of scenarios) {
    const ctx: Ctx = { module, corpus, cfgNames, holes };
    if (!scenario.serves(ctx).some((t) => holes.has(t))) continue;
    const built = scenario.build(ctx);
    if (built === null) continue;
    const used = corpus.streams.some((s) => s.config === built.config && s.seed === built.seed);
    if (used) throw new Error(`golden floor: ${module.key} already has a stream ${built.config}#${built.seed}; the epoch guard keys streams by that identity`);
    const raw = corpus.configs[built.config];
    const stream: GoldenStream = {
      config: built.config,
      seed: built.seed,
      ...(built.lineups === undefined ? {} : { lineups: built.lineups }),
      events: built.events,
      ...recomputeStream(module, raw, built.events, built.lineups),
    };
    const grown: GoldenCorpus = { ...corpus, streams: [...corpus.streams, slimStream(module, corpus, stream)] };
    const after = new Set(floorHoles(module, grown));
    // A stream that closes nothing is noise: do not keep it.
    if (after.size >= holes.size && [...holes].every((h) => after.has(h))) continue;
    corpus.streams = grown.streams;
    holes = after;
    appended.push(`${scenario.id} ${built.config}:${built.seed}`);
  }
  return { corpus, appended, stillMissing: [...holes] };
}
