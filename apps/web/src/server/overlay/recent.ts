// The surviving ledger tail → `OverlayLiveData.recent` (stream overlay W2
// Task 1, design §3.2). The overlay polls ONE endpoint, so anything the moment
// slab needs has to arrive on that payload or it does not arrive at all.
//
// WHY THIS EXISTS RATHER THAN REUSING THE TIMELINE. `buildTimeline`
// (server/public-site/timeline.ts) already produces a consent-resolved,
// void-resolved ledger projection, and `loadMatchCentre` already runs it on
// this very fixture inside the `publicFixture` call `load.ts` makes. It was
// measured against this need before this file was written and it cannot serve
// it: `TimelineLine` carries no raw event type, `TIMELINE_KEY_FOR` is
// deliberately many-to-one (the three set-based sports share one rally key,
// both hockeys share one goal key) so the key cannot be inverted, and cricket
// has NO entry in that table at all. A moment must tell a six from a four; the
// timeline is built to tell a sentence.
//
// WHAT IS AND IS NOT DONE HERE. This module projects; it never decides what is
// worth showing. Every surviving module event in the window is carried with the
// engine's own type string, including types no projector knows — the moment
// allowlist (`lib/overlay-moments.ts`, Task 2) is the only allowlist, and it
// runs on the client. A projector that silently dropped a type would make that
// allowlist unable to see it.
import "server-only";
import type postgres from "postgres";
import {
  REPLAY_LINEUP_POLICY,
  initSquads,
  isLineupEventType,
  reduceLineupEvent,
  resolveVoids,
  type EventEnvelope,
  type LineupPair,
  type ScoreSummary,
  type SquadState,
} from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { activeInnings, deriveCricketScorecard } from "@seazn/engine/sports/cricket";
import {
  lastClosedOverFromScorecard,
  liveFromScorecard,
  scoringStartedFromScorecard,
  tossFromScorecard,
  type OverlayClosedOver,
  type OverlayCricketLive,
  type OverlayCricketToss,
} from "@/lib/overlay-cricket";
import { servingSide, setBreakdown } from "@/lib/public-site";
import { log } from "@/server/logger";
import { readPublicLineups } from "@/server/public-site/public-lineups";
import {
  OVERLAY_RECENT_WINDOW,
  type RecentDerived,
  type RecentEvent,
  type RecentPayload,
  type RecentPerson,
} from "@/lib/overlay-recent-types";

type Sql = ReturnType<typeof postgres>;

interface ProjectCtx {
  sideOf: (entrantId: unknown) => 0 | 1 | undefined;
  personOf: (id: unknown) => RecentPerson | undefined;
}
type Project = (payload: Record<string, unknown>, ctx: ProjectCtx) => RecentPayload;

/** Drops the keys a projector left `undefined`, so an absent fact is ABSENT on
 *  the wire rather than an explicit `null` the client has to re-test for. */
const strip = (o: RecentPayload): RecentPayload =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as RecentPayload;

/** `CricketBall` / the super-over's identical twin (cricket.ts: both keys share
 *  ONE schema object). It records a striker, a non-striker and a bowler but NO
 *  entrant, so there is no side to name — the batting side is a property of the
 *  innings, not of the delivery, and guessing one here would be a second
 *  authority for it. The person named is the DISMISSED batter: the only one of
 *  the three the moment line is about. */
const ball: Project = (p, ctx) => {
  const bat = (p.runs as { bat?: unknown } | undefined)?.bat;
  const wicket = p.wicket as { kind?: unknown; out?: unknown } | undefined;
  return strip({
    runs: typeof bat === "number" ? bat : undefined,
    boundary: p.boundary === 4 || p.boundary === 6 ? p.boundary : undefined,
    wicketKind: typeof wicket?.kind === "string" ? wicket.kind : undefined,
    person: wicket === undefined ? undefined : ctx.personOf(wicket.out),
  });
};

/** `FootballGoal` and `PeriodGoal` in one projector, because the two schemas
 *  agree on everything this reads except the scorer's key: football calls it
 *  `scorer`, the period kernel calls it `person`. An own goal is football's
 *  `ownGoal: true` OR the period kernel's `kind: "og"` — both are declared, and
 *  `og` is valid there regardless of `cfg.goalKinds` (period/kernel.ts). */
const goal: Project = (p, ctx) =>
  strip({
    side: ctx.sideOf(p.by),
    person: ctx.personOf(p.scorer ?? p.person),
    kind: typeof p.kind === "string" ? p.kind : undefined,
    ownGoal: p.ownGoal === true || p.kind === "og",
    penalty: p.penalty === true,
  });

const card: Project = (p, ctx) =>
  strip({
    side: ctx.sideOf(p.by),
    person: ctx.personOf(p.person),
    colour: typeof p.color === "string" ? p.color : undefined,
  });

const suspension: Project = (p, ctx) =>
  strip({
    side: ctx.sideOf(p.by),
    person: ctx.personOf(p.person),
    class: typeof p.class === "string" ? p.class : undefined,
  });

/** `NestedPoint` — `meta.kind` is the SHOT type ("ace", "double_fault",
 *  "winner", "ue"), not the point's outcome. */
const point: Project = (p, ctx) => {
  const kind = (p.meta as { kind?: unknown } | undefined)?.kind;
  return strip({
    side: ctx.sideOf(p.by),
    person: ctx.personOf(p.scorer),
    kind: typeof kind === "string" ? kind : undefined,
  });
};

/** `SetBasedRally` — the side is `wonBy`, NOT `by`. `server` is a PersonId and
 *  is deliberately not read: the moment is about who won the rally. */
const rally: Project = (p, ctx) =>
  strip({ side: ctx.sideOf(p.wonBy), person: ctx.personOf(p.scorer) });

/**
 * Keyed by the ENGINE'S OWN recorded type string, never by a module's declared
 * `eventSchemas` — only eight of the eleven modules declare that record at all,
 * so a table derived from the declarations would silently cover part of the
 * catalogue (the same reasoning `lib/timeline-keys.ts` states for its table).
 *
 * A type ABSENT here is not dropped: it is carried with an empty payload (see
 * `projectRecent`), because the allowlist lives in the moment layer.
 */
export const RECENT_PROJECT: Readonly<Record<string, Project>> = {
  "cricket.ball": ball,
  "cricket.superover.ball": ball,
  "football.goal": goal,
  "football.card": card,
  "hockey.goal": goal,
  "hockey.suspension.start": suspension,
  "icehockey.goal": goal,
  "icehockey.suspension.start": suspension,
  "tennis.point": point,
  "badminton.rally": rally,
  "tabletennis.rally": rally,
  "volleyball.rally": rally,
};

/**
 * The surviving module events the overlay carries, oldest first.
 *
 * `resolveVoids` runs HERE even though the caller's usual source
 * (`FoldedFixture.active`) is already resolved. Resolving twice is a no-op —
 * nothing references a void once the pair is gone — and the alternative is a
 * projection whose correctness depends on a property of its argument that
 * nothing checks. A struck goal reaching the overlay would be announced on air.
 *
 * `core.*` and the five `core.lineup.*` types are excluded: a void, a note, a
 * suspension of play or a substitution is not a moment, and `core.void` in
 * particular must never be carried (it is what removed something).
 */
export function recentWindow(
  active: readonly EventEnvelope[],
  window = OVERLAY_RECENT_WINDOW,
): EventEnvelope[] {
  return resolveVoids(active)
    .filter((e) => !e.type.startsWith("core.") && !isLineupEventType(e.type))
    .slice(-window);
}

function projectRecent(
  window: readonly EventEnvelope[],
  sides: readonly [string, string],
  personOf: (id: unknown) => RecentPerson | undefined,
  derived?: ReadonlyMap<number, RecentDerived>,
): RecentEvent[] {
  const sideOf = (id: unknown): 0 | 1 | undefined =>
    id === sides[0] ? 0 : id === sides[1] ? 1 : undefined;
  return window.map((e) => {
    const project = RECENT_PROJECT[e.type];
    const payload = project
      ? project((e.payload ?? {}) as Record<string, unknown>, { sideOf, personOf })
      : {};
    const d = derived?.get(e.seq);
    return { seq: e.seq, type: e.type, at: e.recordedAt, payload, ...(d ? { derived: d } : {}) };
  });
}

/**
 * The person ids this window will actually PUBLISH — collected by running the
 * projectors themselves with a resolver that records what it is asked for.
 *
 * Deliberately not a list of payload keys. A hand-maintained
 * `["scorer", "person", "striker", …]` drifts from the projectors in both
 * directions, and both are defects: too many ids is a privacy floor breached
 * (a cricket ball names a striker, a non-striker and a bowler, and only the
 * dismissed batter is ever spoken), too few is a moment that silently loses its
 * name. Running the real projectors makes the two impossible to disagree.
 */
export function personIdsIn(
  window: readonly EventEnvelope[],
  sides: readonly [string, string],
): string[] {
  const asked = new Set<string>();
  projectRecent(window, sides, (id) => {
    if (typeof id === "string") asked.add(id);
    return undefined;
  });
  return [...asked];
}

export function buildOverlayRecent(args: {
  active: readonly EventEnvelope[];
  sides: readonly [string, string];
  personOf: (id: unknown) => RecentPerson | undefined;
  window?: number;
  /** From `replayDerived`. Omitted for a sport with no sets, and for any caller
   *  that only needs the recorded facts. */
  derived?: ReadonlyMap<number, RecentDerived>;
}): RecentEvent[] {
  return projectRecent(
    recentWindow(args.active, args.window),
    args.sides,
    args.personOf,
    args.derived,
  );
}

// ---------------------------------------------------------------------------
// `derived` — the two facts the ledger does not record (W2 Task 1 Step 7).
//
// "Set point" is not an event at any fidelity band anyone streams at (W2-F4),
// so the only honest way to know one is to ASK THE MODULE what would happen if
// the next point went each way. That keeps every set rule, tiebreak length and
// deciding-set variation inside the engine, where they already live and are
// already tested — this file contains no scoring rule of any sport.
//
// The replay's SHAPE is `buildTimeline`'s derived pass, deliberately: one
// incremental walk applying each event once, diffing `module.summary`, and
// degrading by STOPPING where the module refuses rather than throwing. A
// per-prefix `foldMatch` would be O(n²) over the same ledger and would have no
// way to report where it gave up.
// ---------------------------------------------------------------------------

/** The synthetic "next point for this side", per kernel that records one. A
 *  sport absent here has no point to probe, and that is the whole answer for
 *  it — football's goal is not a point in this sense. */
const PROBE_POINT: Readonly<Record<string, (by: string) => { type: string; payload: Record<string, unknown> }>> = {
  tennis: (by) => ({ type: "tennis.point", payload: { by } }),
  badminton: (by) => ({ type: "badminton.rally", payload: { wonBy: by } }),
  tabletennis: (by) => ({ type: "tabletennis.rally", payload: { wonBy: by } }),
  volleyball: (by) => ({ type: "volleyball.rally", payload: { wonBy: by } }),
};

const closedCount = (summary: unknown, sportKey: string): number =>
  (setBreakdown(summary, sportKey)?.sets ?? []).filter((set) => set.closed).length;

/** Tennis only: `detail.games` is the running GAME score within the set, which
 *  is what a break is measured in (nested/kernel.ts). */
const gamesOf = (summary: unknown): { home: number; away: number } | null => {
  const detail = (summary as { detail?: unknown } | null)?.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const games = (detail as { games?: unknown }).games;
  if (typeof games !== "object" || games === null) return null;
  const { home, away } = games as Record<string, unknown>;
  return typeof home === "number" && typeof away === "number" ? { home, away } : null;
};

/**
 * The set this event CLOSED, if any.
 *
 * Reads `setBreakdown` rather than `summary.detail.sets` directly, so the
 * overlay, the timeline, the Sets tab and the live score all agree on what
 * counts as a set for a given sport — `GAME_UNIT_SPORTS` lives there and
 * nowhere else.
 *
 * `home >= away` credits a drawn set to home, which is `derivedLines`'s own
 * convention in `timeline.ts`. A closed set cannot be level in any sport that
 * carries one, so the branch is unreachable; the two surfaces agreeing matters
 * more than picking a different unreachable answer.
 */
export function diffClosedSets(
  before: unknown,
  after: unknown,
  sportKey: string,
): RecentDerived["setWon"] | undefined {
  const b = setBreakdown(before, sportKey)?.sets ?? [];
  const a = setBreakdown(after, sportKey)?.sets ?? [];
  for (let i = 0; i < a.length; i++) {
    const set = a[i]!;
    if (!set.closed || b[i]?.closed === true) continue;
    return { set: i + 1, winner: set.home >= set.away ? 0 : 1, home: set.home, away: set.away };
  }
  return undefined;
}

type PointState = Omit<NonNullable<RecentDerived["pointState"]>, "fresh">;
const RANK: Record<PointState["kind"], number> = { match: 3, set: 2, break: 1 };

function probePointState(args: {
  sportKey: string;
  module: AnySportModule;
  state: unknown;
  squads: SquadState;
  sides: readonly [string, string];
  after: EventEnvelope;
}): PointState | undefined {
  const { sportKey, module, state, squads, sides, after } = args;
  const make = PROBE_POINT[sportKey];
  if (!make) return undefined;
  // A decided match is at no point state: the slab must not announce a match
  // point after the handshake.
  if (module.outcome(state) !== null) return undefined;

  const now = module.summary(state);
  const closedNow = closedCount(now, sportKey);
  const serving = servingSide(now);
  const gamesNow = gamesOf(now);

  let best: PointState | undefined;
  for (const side of [0, 1] as const) {
    const probe = make(sides[side]!);
    // DERIVED FROM THE MODULE'S OWN DECLARATIONS. Only eight of the eleven
    // modules declare `eventSchemas` at all, and a probe of a type a module
    // never declared is a fabricated event — `apply` may accept it and fold
    // something meaningless.
    if (!(probe.type in (module.eventSchemas ?? {}))) return undefined;
    const env: EventEnvelope = {
      id: "overlay-probe",
      fixtureId: after.fixtureId,
      seq: after.seq + 1,
      type: probe.type,
      payload: probe.payload,
      recordedAt: after.recordedAt,
      recordedBy: null,
    };
    let next: unknown;
    try {
      next = module.apply(state as never, env as never, { strict: false, squads });
    } catch {
      // This side cannot legally take the next point from here (a tennis
      // game-award state, an expedite rule). Not a failure — just no answer.
      continue;
    }
    const then = module.summary(next as never);
    let kind: PointState["kind"] | undefined;
    if (module.outcome(next as never)?.kind === "win") kind = "match";
    else if (closedCount(then, sportKey) > closedNow) kind = "set";
    else if (
      sportKey === "tennis" &&
      serving !== null &&
      serving !== (side === 0 ? "home" : "away") &&
      gamesNow !== null
    ) {
      const key = side === 0 ? "home" : "away";
      if ((gamesOf(then)?.[key] ?? 0) > gamesNow[key]) kind = "break";
    }
    if (kind && (best === undefined || RANK[kind] > RANK[best.kind])) best = { kind, side };
  }
  return best;
}

/**
 * The dismissed batter's figures, read off the state AFTER the ball that got
 * them — so the dismissal delivery is counted, which is how a scorecard reads.
 *
 * `activeInnings` is the engine's own public mirror of "which innings is being
 * played" (exported for exactly this reason), so a super-over dismissal reads
 * the super over's innings rather than the main card's last one.
 *
 * `fine` is null on a COARSE innings, and `undefined` is then the whole answer:
 * a band-0 or band-1 ledger records no per-batter tally, and `0 (0)` on air
 * would be a fabricated score rather than a missing one.
 */
function batterFigures(
  sportKey: string,
  state: unknown,
  payload: unknown,
): { runs: number; balls: number } | undefined {
  if (sportKey !== "cricket") return undefined;
  const out = (payload as { wicket?: { out?: unknown } } | null)?.wicket?.out;
  if (typeof out !== "string") return undefined;
  const s = state as { innings?: unknown; superOver?: unknown } | null;
  if (typeof s !== "object" || s === null || !Array.isArray(s.innings)) return undefined;
  const innings = activeInnings(s as Parameters<typeof activeInnings>[0]).list.at(-1) as
    | { fine?: { batterRuns?: Record<string, number>; batterBalls?: Record<string, number> } | null }
    | undefined;
  const fine = innings?.fine;
  if (!fine) return undefined;
  return { runs: fine.batterRuns?.[out] ?? 0, balls: fine.batterBalls?.[out] ?? 0 };
}

export interface DerivedReplay {
  bySeq: Map<number, RecentDerived>;
  /** False when the module refused the ledger part-way: annotations beyond that
   *  point are ABSENT, not proven not to exist.
   *
   *  PRODUCTION REPORTS IT THROUGH THE `log.warn` BELOW, not through this
   *  field: `load.ts` destructures `{ bySeq }` and nothing reads `complete` off
   *  a live request. It is here for the TESTS, which assert the refusal is
   *  detected at all — an empty catch would make a fixture that loses every
   *  set-won annotation indistinguishable from one that had none to lose, and
   *  a warn line is not something a unit test can hold on to. Stated plainly
   *  rather than left reading as a production signal it is not. */
  complete: boolean;
}

export function replayDerived(args: {
  sportKey: string;
  module: AnySportModule;
  cfg: unknown;
  lineups: LineupPair;
  active: readonly EventEnvelope[];
  window?: number;
}): DerivedReplay {
  const { sportKey, module, cfg, lineups } = args;
  // The probe's entrant ids come from the LINE-UP PAIR, which is the same
  // authority the fold itself was given — not from the fixture row read
  // separately, which could disagree with what was folded.
  const sides: readonly [string, string] = [lineups.home.entrantId, lineups.away.entrantId];
  const bySeq = new Map<number, RecentDerived>();
  const active = resolveVoids(args.active);
  const inWindow = new Set(recentWindow(active, args.window).map((e) => e.seq));
  if (inWindow.size === 0) return { bySeq, complete: true };
  // The probe is the expensive half (one `apply` per side per event), and it is
  // only needed inside the window — plus ONE event before it, so the window's
  // first entry knows whether its point state is a transition or a continuation.
  const firstWindowIndex = active.findIndex((e) => inWindow.has(e.seq));
  const probeFrom = Math.max(0, firstWindowIndex - 1);

  let complete = true;
  let failedAt: number | null = null;
  try {
    let state: unknown = module.init(cfg as never, lineups);
    let squads: SquadState = initSquads(lineups);
    if (module.onLineup !== undefined) state = module.onLineup(state as never, squads);
    let previous: ScoreSummary = module.summary(state as never);
    let prevPoint: PointState | undefined;

    for (let i = 0; i < active.length; i++) {
      const event = active[i]!;
      failedAt = event.seq;
      // The three families `foldMatch` never hands to a module.
      if (event.type === "core.suspend" || event.type === "core.resume") continue;
      if (isLineupEventType(event.type)) {
        const reduced = reduceLineupEvent(squads, event, REPLAY_LINEUP_POLICY);
        if (reduced.ok) {
          squads = reduced.squads;
          if (module.onLineup !== undefined) state = module.onLineup(state as never, squads);
        }
        continue;
      }
      state = module.apply(state as never, event as never, { strict: false, squads });
      const summary = module.summary(state as never);

      const point =
        i >= probeFrom
          ? probePointState({ sportKey, module, state, squads, sides, after: event })
          : undefined;

      if (inWindow.has(event.seq)) {
        const derived: RecentDerived = {};
        const setWon = diffClosedSets(previous, summary, sportKey);
        if (setWon) derived.setWon = setWon;
        const batter = batterFigures(sportKey, state, event.payload);
        if (batter) derived.batter = batter;
        if (point) {
          const fresh = !(prevPoint && prevPoint.kind === point.kind && prevPoint.side === point.side);
          derived.pointState = { ...point, fresh };
        }
        if (Object.keys(derived).length > 0) bySeq.set(event.seq, derived);
      }
      previous = summary;
      prevPoint = point;
    }
    failedAt = null;
  } catch (err) {
    complete = false;
    log.warn(
      { sportKey, seq: failedAt, err: err instanceof Error ? err.message : String(err) },
      "overlay: derived replay stopped; set-won and point-state beyond this seq are absent",
    );
  }
  return { bySeq, complete };
}

/**
 * The consent-resolved name resolver for one fixture's window.
 *
 * Goes through `readPublicLineups`, which is the single caller of
 * `resolvePersonDisplayName` on this surface — never a second masking
 * convention, and never the raw `full_name`.
 *
 * Someone the LINE-UP never named gets no name at all. That is a stale ledger
 * reference or a line-up gap, and the match centre's own resolver answers "?"
 * there because it must render a scorecard row; an overlay has no such
 * obligation, and an unnamed moment ("GOAL") reads correctly on air while a
 * "?" does not.
 *
 * Returns `undefined` WITHOUT querying when the window names nobody — the
 * common case at fidelity band 0/1, where a goal records only its side.
 */
export async function loadRecentPersonOf(
  sql: Sql,
  fixtureId: string,
  divisionId: string,
  ids: readonly string[],
): Promise<(id: unknown) => RecentPerson | undefined> {
  if (ids.length === 0) return () => undefined;
  const [division] = await sql<{ youth: boolean | null; player_name_display: string | null }[]>`
    select youth, player_name_display from divisions where id = ${divisionId}`;
  const lineups = await readPublicLineups(sql, fixtureId, {
    youth: division?.youth ?? false,
    player_name_display: division?.player_name_display ?? null,
  });
  const byId = new Map<string, RecentPerson>();
  for (const list of Object.values(lineups)) {
    for (const person of list) byId.set(person.personId, { name: person.name, masked: person.masked });
  }
  return (id: unknown) => (typeof id === "string" ? byId.get(id) : undefined);
}

/** Cricket overlay block cached WITHOUT consent names (ids stand in for names). */
export type OverlayCricketBundleIds = {
  live: OverlayCricketLive | null;
  toss: OverlayCricketToss | null;
  lastClosedOver: OverlayClosedOver | null;
  scoringStarted: boolean;
};

/**
 * The cricket bar's second band (W2 Task 3) — the batters at the crease and the
 * bowler's analysis, through `deriveCricketScorecard`: the ENGINE'S own public
 * spectator seam, already used by the match centre.
 *
 * Returns the block WITHOUT names, carrying PERSON IDS, because the two halves
 * belong on opposite sides of the cache. The scorecard is the expensive half
 * and changes only when the ledger does, so it rides INSIDE the cached fold;
 * names do not, because consent can change with no event to invalidate on and a
 * player who withdraws theirs should stop appearing at the next poll rather
 * than at the next ball. An earlier shape had this whole function running per
 * poll — a second `loadFoldInputs` plus a full scorecard derivation for every
 * viewer, which made the file's own "N polls at one ledger position cost one
 * fold" promise false for cricket.
 *
 * THE CONFIG MUST BE PARSED. Measured 2026-09-11: handed the raw
 * `resolveFixtureCfg` output — which is exactly what `loadFoldInputs` carries,
 * because `foldMatch` takes it unparsed — `deriveCricketScorecard` throws
 * `Cannot read properties of undefined (reading 'enabled')`. `loadMatchCentre`
 * hit the same wall and answered it with `safeParse` plus a fallback to the raw
 * value; the fallback is NOT available here, because raw is precisely what
 * throws. So a config this module's schema rejects yields NO band rather than a
 * 500 on a live broadcast.
 *
 * Best effort throughout, like everything else on this path: a club is on air,
 * and a missing second band is a smaller loss than a dark overlay.
 *
 * Also projects toss / lastClosedOver / scoringStarted for match openers and
 * the end-of-over card (2026-09-12 design) from the SAME scorecard — one fold.
 */
export function overlayCricketBundleIds(
  inputs: { sportKey: string; module: AnySportModule; cfg: unknown; lineups: LineupPair },
  active: readonly EventEnvelope[],
): OverlayCricketBundleIds {
  const empty: OverlayCricketBundleIds = {
    live: null,
    toss: null,
    lastClosedOver: null,
    scoringStarted: false,
  };
  if (inputs.sportKey !== "cricket") return empty;
  const parsed = inputs.module.configSchema.safeParse(inputs.cfg);
  if (!parsed.success) {
    log.warn({ sportKey: inputs.sportKey }, "overlay: cricket cfg did not parse, serving no crease band");
    return empty;
  }
  try {
    const scorecard = deriveCricketScorecard({
      events: active as never,
      cfg: parsed.data as never,
      lineups: inputs.lineups,
    });
    // The id IS the name at this stage; `nameOf` below swaps them for the
    // consent-resolved ones once the cache has been crossed.
    const idAsName = (id: string) => id;
    const sides: [string, string] = [inputs.lineups.home.entrantId, inputs.lineups.away.entrantId];
    return {
      live: liveFromScorecard(scorecard, idAsName),
      toss: tossFromScorecard(scorecard, sides),
      lastClosedOver: lastClosedOverFromScorecard(scorecard, idAsName),
      scoringStarted: scoringStartedFromScorecard(scorecard),
    };
  } catch (err) {
    log.warn({ err }, "overlay: cricket scorecard failed, serving no crease band");
    return empty;
  }
}

/** @deprecated Prefer `overlayCricketBundleIds` — kept as a thin alias for call sites that only need live. */
export function overlayCricketLiveIds(
  inputs: { sportKey: string; module: AnySportModule; cfg: unknown; lineups: LineupPair },
  active: readonly EventEnvelope[],
): OverlayCricketLive | null {
  return overlayCricketBundleIds(inputs, active).live;
}

/**
 * The names, applied OUTSIDE the cache — see `overlayCricketBundleIds`.
 *
 * A person the line-up never named loses their name and keeps their figures,
 * exactly as `liveFromScorecard` decides: the crease is a fact, the name is
 * consent.
 */
export function nameCricketLive(
  live: OverlayCricketLive | null,
  personOf: (id: unknown) => RecentPerson | undefined,
): OverlayCricketLive | null {
  if (live === null) return null;
  const named = (id: string | undefined) => (id === undefined ? undefined : personOf(id)?.name);
  return {
    batters: live.batters.map((b) => {
      const name = named(b.name);
      return { ...(name === undefined ? {} : { name }), runs: b.runs, balls: b.balls, onStrike: b.onStrike };
    }),
    ...(live.bowler === undefined
      ? {}
      : (() => {
          const name = named(live.bowler.name);
          return name === undefined ? {} : { bowler: { ...live.bowler, name } };
        })()),
    thisOver: live.thisOver,
  };
}

function nameClosedOver(
  closed: OverlayClosedOver | null,
  personOf: (id: unknown) => RecentPerson | undefined,
): OverlayClosedOver | null {
  if (closed === null) return null;
  const liveNamed = nameCricketLive(
    { batters: closed.batters, bowler: closed.bowler, thisOver: closed.glyphs },
    personOf,
  );
  const { bowler: _omit, ...rest } = closed;
  if (!liveNamed) {
    return { ...rest, batters: [] };
  }
  return {
    ...rest,
    batters: liveNamed.batters,
    ...(liveNamed.bowler === undefined ? {} : { bowler: liveNamed.bowler }),
  };
}

export function nameCricketBundle(
  bundle: OverlayCricketBundleIds,
  personOf: (id: unknown) => RecentPerson | undefined,
): OverlayCricketBundleIds {
  return {
    live: nameCricketLive(bundle.live, personOf),
    toss: bundle.toss,
    lastClosedOver: nameClosedOver(bundle.lastClosedOver, personOf),
    scoringStarted: bundle.scoringStarted,
  };
}

/** The person ids the cricket band will publish — the two at the crease and the
 *  bowler. Read off the id-carrying block itself, so the lookup cannot drift
 *  from what is rendered. */
export function cricketPersonIdsIn(live: OverlayCricketLive | null): string[] {
  if (live === null) return [];
  const ids = [...live.batters.map((b) => b.name), live.bowler?.name];
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

export function cricketBundlePersonIdsIn(bundle: OverlayCricketBundleIds): string[] {
  const ids = new Set(cricketPersonIdsIn(bundle.live));
  if (bundle.lastClosedOver) {
    for (const id of cricketPersonIdsIn({
      batters: bundle.lastClosedOver.batters,
      bowler: bundle.lastClosedOver.bowler,
      thisOver: bundle.lastClosedOver.glyphs,
    })) {
      ids.add(id);
    }
  }
  return [...ids];
}
