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
import { isLineupEventType, resolveVoids, type EventEnvelope } from "@seazn/engine/core";
import { readPublicLineups } from "@/server/public-site/public-lineups";
import {
  OVERLAY_RECENT_WINDOW,
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
): RecentEvent[] {
  const sideOf = (id: unknown): 0 | 1 | undefined =>
    id === sides[0] ? 0 : id === sides[1] ? 1 : undefined;
  return window.map((e) => {
    const project = RECENT_PROJECT[e.type];
    const payload = project
      ? project((e.payload ?? {}) as Record<string, unknown>, { sideOf, personOf })
      : {};
    return { seq: e.seq, type: e.type, at: e.recordedAt, payload };
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
}): RecentEvent[] {
  return projectRecent(recentWindow(args.active, args.window), args.sides, args.personOf);
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
