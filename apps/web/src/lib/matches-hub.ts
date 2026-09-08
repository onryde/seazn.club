// Spectator surface W2 — the pure, client-safe helpers behind the Matches hub
// and the competition landing status line (design §W2). NOTHING here imports
// from `@/server/**`: these functions ride into client components, and the hub
// document that feeds them (`server/public-site/competition-hub-schema.ts`)
// arrives already formatted and already resolved. This file only ever buckets,
// groups, orders and chooses.
//
// It therefore holds no COPY. Every string it returns is an identifier — a
// bucket name, a tab id, a YYYY-MM-DD day key — which the renderer resolves
// through the dictionary. A user-facing sentence written here would be
// untranslatable by construction, because there is no locale in scope.

// ------------------------------------------------------------------ buckets

/** The three lists the Matches hub can show, as a VALUE so an enumeration test
 *  can cross-product over the domain instead of hand-typing it (the same shape
 *  `DIVISION_PHASES` uses in `division-phase.ts`). It is declared here rather
 *  than imported from the hub schema because that module is a `@/server/**`
 *  module: every client import of one in this tree is `import type`, erased at
 *  compile, and a zod VALUE cannot cross that boundary. `MatchBucketSchema`
 *  restates it, and `matches-hub.test.ts` pins the two equal so they cannot
 *  drift apart in silence. */
export const MATCH_BUCKETS = ["live", "upcoming", "completed"] as const;
export type MatchBucket = (typeof MATCH_BUCKETS)[number];

/** The wire statuses that mean "this fixture will not be played again".
 *  `decided`/`finalized` are results; `abandoned`/`forfeited`/`cancelled` are
 *  terminal without one — the hub still LISTS them under Completed, because a
 *  spectator looking for a match that was called off needs to find it saying
 *  so, not to find nothing. */
const TERMINAL = new Set<string>(["decided", "finalized", "abandoned", "forfeited", "cancelled"]);

/**
 * Which list a fixture belongs in, from its v1 wire status (`Fixture.status`,
 * `server/api-v1/schemas.ts:1195`).
 *
 * Deliberately takes a bare `string`, not the enum: the enum is declared inline
 * in that file and is not exported, and — more to the point — an unknown status
 * must be LISTED, never dropped. Anything that is not `in_play` and not
 * terminal is UPCOMING, so a status added to the wire tomorrow appears on the
 * page (in the wrong list, visibly) instead of vanishing from it. The suite's
 * drift guard reads the enum out of `schemas.ts`'s source text and reds when a
 * new member appears, so "wrong list" is a caught bug rather than a shipped one.
 *
 * Note this ladder is NOT the same question as `match-centre.ts`'s `statusOf`,
 * which maps the same vocabulary onto the match-centre HEADER's four states and
 * sends the unknown case to `other`. That one describes one fixture; this one
 * decides which of three lists it is filed under.
 */
export function bucketFixture(status: string): MatchBucket {
  if (status === "in_play") return "live";
  return TERMINAL.has(status) ? "completed" : "upcoming";
}

export type BucketCounts = Record<MatchBucket, number>;

/**
 * Which filter the Matches tab opens on.
 *
 * EMPTY CASE FIRST: a competition with no fixtures at all selects NOTHING and
 * renders its empty state. Without that rung the ladder falls through to
 * `completed`, and a competition whose fixtures have not been drawn yet opens
 * on a "Results" list that is empty for a reason nobody can see.
 *
 * Then live → upcoming → completed. The order is the rule, so both crossings
 * are pinned by an order-differential case in the suite (a set holding all
 * three still picks live; a set with nine completed and one upcoming still
 * picks upcoming).
 */
export function defaultMatchesFilter(c: BucketCounts): MatchBucket | null {
  if (c.live <= 0 && c.upcoming <= 0 && c.completed <= 0) return null;
  if (c.live > 0) return "live";
  if (c.upcoming > 0) return "upcoming";
  return "completed";
}

// -------------------------------------------------------------- day grouping

/**
 * The VENUE-local calendar date (YYYY-MM-DD) of an instant — the day a match is
 * played on where it is played, so a 23:30 fixture does not slide onto the
 * next or previous day for a viewer in another zone. `en-CA` is the trick that
 * gives ISO ordering natively, the same one `components/public-site/
 * schedule.tsx`'s private `dayKey` and `lib/division-phase.ts`'s
 * `localDateKey` already use.
 *
 * Neither of those two was reusable here and that is worth stating rather than
 * leaving as an apparent third copy. `schedule.tsx`'s has exactly this
 * contract but lives module-private inside a `.tsx` component, so importing it
 * would pull React into a module that must stay pure; `localDateKey` takes a
 * non-null `iso`, returns `""` rather than null when it cannot parse one, and
 * THROWS a RangeError on a zone ICU does not know.
 *
 * The contract here is the one the grouping needs:
 *   • no instant (`null`), or one that will not parse → `null`, i.e. the caller
 *     files it as unscheduled rather than under an empty-string day;
 *   • a zone ICU rejects → fall back to UTC rather than throw. A competition
 *     with a typo in its timezone renders a slightly wrong day heading; it does
 *     not fail to render.
 */
export function dayKeyInZone(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(ms);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(ms);
  }
}

/** The group key for fixtures with no time yet. A literal rather than an empty
 *  string so a renderer can branch on it, and so it sorts by identity instead
 *  of by accident. */
export const UNSCHEDULED_KEY = "unscheduled";

export interface DayGroup<T> {
  /** `YYYY-MM-DD`, or `UNSCHEDULED_KEY`. */
  key: string;
  /** The zone of the group's FIRST item. Meaningful for the common case (one
   *  competition, one zone) and only that; the key itself is already the
   *  answer for a day heading, and each item carries its own `tz` for a time. */
  tz: string;
  items: T[];
}

/**
 * Fixtures by venue day, days ascending, unscheduled LAST.
 *
 * Each item's day is computed in that item's OWN zone, so a competition running
 * across zones files each match on the day it is played locally — two fixtures
 * at the same instant can legitimately land in different groups. Within a group
 * input order is preserved; `sortHubMatches` is what puts the list in order
 * first when the caller wants that.
 */
export function groupByDay<T extends { scheduledAt: string | null; tz: string }>(
  items: readonly T[],
): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>();
  for (const it of items) {
    const key = dayKeyInZone(it.scheduledAt, it.tz) ?? UNSCHEDULED_KEY;
    const g = groups.get(key) ?? { key, tz: it.tz, items: [] };
    g.items.push(it);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === UNSCHEDULED_KEY) return b.key === UNSCHEDULED_KEY ? 0 : 1;
    if (b.key === UNSCHEDULED_KEY) return -1;
    return a.key.localeCompare(b.key);
  });
}

// ------------------------------------------------------------------ ordering

const RANK: Record<MatchBucket, number> = { live: 0, upcoming: 1, completed: 2 };

/** The instant to order by, or `null` when there is not one to order by. A
 *  string that will not parse counts as absent: `Date.parse` returns NaN, and
 *  NaN in a comparator makes every comparison false, which V8 is free to turn
 *  into any order at all. */
function instantOf(x: { scheduledAt: string | null }): number | null {
  if (!x.scheduledAt) return null;
  const ms = Date.parse(x.scheduledAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The hub's one canonical order: live first, then upcoming soonest-first, then
 * completed most-recent-first. Returns a new array; the input is never mutated,
 * because callers hold the document's own `matches` array.
 *
 * Undated fixtures sort LAST inside whichever bucket they are in — including
 * `completed`, which is the case worth being explicit about. The obvious
 * implementation gives a missing time `+Infinity` and subtracts, which puts an
 * undated match last while ascending and FIRST while descending: an
 * unscheduled abandoned fixture would head the results list. Handling absence
 * before the subtraction avoids that, and avoids `Infinity - Infinity` (NaN)
 * when two undated fixtures meet.
 */
export function sortHubMatches<T extends { bucket: MatchBucket; scheduledAt: string | null }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => {
    if (RANK[a.bucket] !== RANK[b.bucket]) return RANK[a.bucket] - RANK[b.bucket];
    const av = instantOf(a);
    const bv = instantOf(b);
    if (av === null || bv === null) {
      if (av === bv) return 0; // both undated — Array#sort is stable, so input order holds
      return av === null ? 1 : -1; // undated last, in every bucket
    }
    // Results read newest first; everything else reads by when it happens.
    return a.bucket === "completed" ? bv - av : av - bv;
  });
}

// ---------------------------------------------------------------------- tabs

/** Every tab id the competition hub can show, in the order they are shown.
 *  `CompetitionHubTabId` in the hub schema restates this as a zod enum for the
 *  same client/server reason `MATCH_BUCKETS` does, and the suite pins the two
 *  equal. `gallery` is W4's reserved slot: it is a member of the union so the
 *  type is stable when W4 lands, and `deriveHubTabs` never emits it. */
export const HUB_TAB_IDS = [
  "overview",
  "matches",
  "table",
  "stats",
  "teams",
  "gallery",
  "info",
] as const;
export type HubTabId = (typeof HUB_TAB_IDS)[number];

export interface HubTabCounts {
  matches: number;
  tables: number;
  /** Leader ROWS, not boards. A sport whose leaderboards exist but are all
   *  empty has nothing to show, and a Stats tab that opens on nothing is worse
   *  than no Stats tab. */
  leaderRows: number;
  teams: number;
}

/**
 * The hub's tabs, by PRESENCE: a tab exists when there is something behind it.
 * Overview and Info always exist — Overview is the landing itself, and Info
 * carries the competition's dates and venues, which exist before any fixture
 * does.
 */
export function deriveHubTabs(c: HubTabCounts): HubTabId[] {
  const tabs: HubTabId[] = ["overview"];
  if (c.matches > 0) tabs.push("matches");
  if (c.tables > 0) tabs.push("table");
  if (c.leaderRows > 0) tabs.push("stats");
  if (c.teams > 0) tabs.push("teams");
  tabs.push("info");
  return tabs;
}

// ------------------------------------------------------------ landing status

/** What the Overview's status line is SAYING. A discriminated union of facts,
 *  never a sentence: the renderer turns each into copy through the dictionary,
 *  so `n`, `at`, `tz` and the dates travel as data. */
export type LandingStatus =
  | { kind: "empty" }
  | { kind: "live"; n: number }
  | { kind: "next"; at: string; tz: string }
  | { kind: "finished" }
  | { kind: "dates"; startsOn: string | null; endsOn: string | null };

export interface LandingStatusInput {
  matches: readonly { bucket: MatchBucket; scheduledAt: string | null; tz: string }[];
  /** How many divisions the competition has — NOT how many have fixtures. */
  divisions: number;
  startsOn: string | null;
  endsOn: string | null;
  now: Date;
}

/**
 * ORDER IS THE RULE: empty → live → next → finished → dates.
 *
 * The empty rung states itself FIRST and outranks everything, which is the
 * competition-desk amendment this repeats: a competition with no divisions
 * answers "no" to every contains-style question below it, so without an
 * explicit empty case it lands on whatever the last rung is and announces
 * itself as finished before it has begun. The same trap shipped three separate
 * vacuous "Finished" defects in one desk wave.
 *
 * `next` is the earliest upcoming fixture still AHEAD of `now`; a fixture whose
 * start time has passed but which has not been marked in play is overdue, not
 * next, and the competition falls through to its dates rather than claiming a
 * kickoff that is already behind us. `finished` needs every fixture completed
 * AND at least one to exist, so an overdue upcoming fixture cannot be mistaken
 * for a finished competition.
 */
export function landingStatus(a: LandingStatusInput): LandingStatus {
  if (a.divisions === 0) return { kind: "empty" };

  const live = a.matches.filter((m) => m.bucket === "live").length;
  if (live > 0) return { kind: "live", n: live };

  const nowMs = a.now.getTime();
  const upcoming: { at: number; iso: string; tz: string }[] = [];
  for (const m of a.matches) {
    if (m.bucket !== "upcoming" || m.scheduledAt === null) continue;
    const at = instantOf(m);
    if (at === null || at < nowMs) continue;
    upcoming.push({ at, iso: m.scheduledAt, tz: m.tz });
  }
  upcoming.sort((x, y) => x.at - y.at);
  const next = upcoming[0];
  if (next) return { kind: "next", at: next.iso, tz: next.tz };

  if (a.matches.length > 0 && a.matches.every((m) => m.bucket === "completed")) {
    return { kind: "finished" };
  }
  return { kind: "dates", startsOn: a.startsOn, endsOn: a.endsOn };
}
