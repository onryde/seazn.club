import "server-only";
// Spectator surface W2, Task 14 — one line per match on the public player page:
// the person's own figures, the opponent, and how it ended.
//
// Public surface: takes a bare `Sql` client (no AuthCtx, no tenant scoping),
// the same contract as `readLeaderRows` / `readPublicLineups` beside it. `sql`
// from `@/lib/db` BYPASSES RLS, so the visibility gate is the JOIN: every
// fixture must survive `public_fixtures_v` (competition public/unlisted) AND
// `public_divisions_v` (the same, plus the division not archived). The fixture
// view alone does not hide an archived division; only the division join does.
//
// WHICH FIXTURES ARE AN APPEARANCE. A declared lineup row is the fact where one
// exists: a team member the XI left out did not play. Only a `player` row
// counts — a coach or staff member on the sheet is in the squad, never in a
// playing record (the engine's own ruling, `core/lineup.ts` `SquadRole`) — and
// only a row on an entrant that IS a side of the fixture. A bench row counts
// only by `benchRowIsAppearance` below. Where a side declared NO lineup for the
// fixture, its rostered members stand in for one — the only writer of `lineups`
// is the organiser's `putLineup`, so an individual or pair entrant (badminton,
// tennis, …) almost never has a row, and a lineups-only read would list no
// match at all for those players. Only fixtures that have started count: the
// repo's played set (`COMPLETED_FIXTURE_STATUSES`, which the career rollup's
// match count reads too) plus `in_play`. A pre-match team sheet is not an
// appearance.
//
// CRICKET FIGURES HAVE ONE AUTHORITY: the engine's `deriveCricketScorecard`,
// the fold the match centre renders, over exactly the inputs the server fold
// reads (`loadFoldInputs`: the frozen config, the lineup pair, the ledger).
// This file only ADDS a person's lines up; it never re-derives a cricket rule.
//
// MERGED PEOPLE. A person merge (`person-merge.ts`) repoints lineup and roster
// rows to the survivor but never rewrites the ledger, so a fixture's events keep
// naming the absorbed id. The fold is therefore run under the ids the LEDGER
// recorded (`asRecorded`), its figures stay keyed by those ids, and a person's
// line sums the figures of every id merged into them — resolved at read time,
// outside the per-fixture cache, so a merge needs no cache key of its own.
//
// TWO HALVES, AND WHERE EACH MAY RUN. `readPlayerMatchSeeds` is the relational
// read — which fixtures, which side, the masked opponent, the result — and is
// safe to hold inside the caller's `unstable_cache`. `completePlayerMatchLines`
// adds the cricket figures from a cache of its own, one entry per
// (fixture, last recorded event, config snapshot), and MUST NOT run inside another
// `unstable_cache`: Next skips the cache READ of one nested in another's
// callback (`isNestedUnstableCache`, next/dist/server/web/spec-extension/
// unstable-cache.js), so from in there every render would re-fold every match.
import type postgres from "postgres";
import { unstable_cache } from "next/cache";
import {
  EngineError,
  resolveVoids,
  type EventEnvelope,
  type Lineup,
  type LineupPair,
  type LineupSlot,
} from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { deriveCricketScorecard, type CricketCfg, type CricketScorecard } from "@seazn/engine/sports/cricket";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { getDictionary, t } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { isoDateTime } from "@/lib/public-site";
import { routes } from "@/lib/routes";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import { resolveVenueTz } from "@/lib/tz";
import { loadFoldInputs } from "@/server/engine-db/fold";
import { resolveModule } from "@/server/engine-db/registry";
import { log } from "@/server/logger";
import { COMPLETED_FIXTURE_STATUSES } from "@/server/usecases/player-stats";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { maskPublicEntrantNames, playerCardNameMask, withCourtVenueNames } from "./data";
import { publicRoundNamer, type NamedFixture } from "./feeder-slot-label";

export type Sql = ReturnType<typeof postgres>;

export type PlayerMatchResult = "won" | "lost" | "drawn" | "live";

export interface PlayerMatchLine {
  fixtureId: string;
  /** The fixture's public match centre. */
  href: string;
  divisionName: string;
  divisionSlug: string;
  /** ISO instant, or null when the division has not released its schedule. */
  scheduledAt: string | null;
  /** The VENUE zone (`resolveVenueTz`), for formatting `scheduledAt`. */
  tz: string;
  /** The other side's name through `maskPublicEntrantNames`, never a raw column. */
  opponentName: string;
  /** Cricket: the person's figures. Other sports: the score, their side first. */
  line: string;
  result: PlayerMatchResult | null;
}

/** Everything about a line except the cricket figures — plain JSON, so it can
 *  sit in a serialising cache. */
export interface PlayerMatchSeed extends Omit<PlayerMatchLine, "line"> {
  sportKey: string;
  status: string;
  /** `match_states.last_seq`: which fold of this fixture the figures belong to. */
  lastSeq: number | null;
  /** `fixtures.config_snapshot_at`, as text: a staff re-snapshot rewrites the
   *  config a fixture folds under WITHOUT appending, so `lastSeq` alone would
   *  keep serving figures folded under the discarded config. */
  snapshotAt: string | null;
  /** The person's lineup slot; null when their roster stood in for a sheet. */
  slot: "starting" | "bench" | null;
  /** The score, THEIR side first (`scoreLineFor`) — the line for every sport but cricket. */
  scoreLine: string | null;
}

/** One person's match figures. Present in a fixture's map only for someone who
 *  batted or bowled in a main innings. */
export interface PersonFigures {
  batting: { runs: number; balls: number } | null;
  bowling: { wickets: number; runs: number } | null;
}

/** Every figure-bearing person in one fixture, keyed by person id. A plain
 *  object, not a Map: `unstable_cache` serialises its value, and a Map crosses
 *  that boundary as `{}`. */
export type FixtureFigures = Record<string, PersonFigures>;

/** A line with nothing to say. Punctuation, not copy: identical in every locale. */
const NO_FIGURES = "—";

/** The started statuses: played (the career count's own set) or in play. */
const APPEARANCE_STATUSES: readonly string[] = [...COMPLETED_FIXTURE_STATUSES, "in_play"];

/**
 * Is a BENCH row an appearance?
 *
 * OWNER RULING, 2026-09-16: a bench row counts only when the cricket fold shows
 * the person batted or bowled; a coach or staff row never counts (that half is
 * the `l.role = 'player'` filter in `readPlayerMatchSeeds`). The whole bench
 * policy lives in this one function. In cricket, figures mean a replacement or
 * a community sub rule brought the player properly on (Law 24 lets an ordinary
 * substitute field only); a bench player with no figures sat it out. Other
 * sports record no per-person figures on this page, so nothing shows a bench
 * player came on — they are left out. A starting row and a roster stand-in are
 * never asked.
 *
 * Only a lineup event brings a bench player on. The scorecard fold reads the
 * kernel's `core.lineup.*` events (fix/cricket-scorecard-core-events), so a
 * bench player who came on and batted or bowled has figures and is listed
 * (the "BENCH (cricket): a bench player who came on and bowled" test).
 *
 * The `sportKey` test is belt-and-braces TODAY: no other sport produces
 * `figures`, so it changes no answer until one does.
 */
export function benchRowIsAppearance(sportKey: string, figures: PersonFigures | undefined): boolean {
  return sportKey === "cricket" && figures !== undefined;
}

/**
 * How the fixture ended FOR THIS PERSON'S SIDE.
 *
 * A winner is carried by `win` and by `award` (a forfeit or walkover). `draw`
 * and `tie` have none and read "drawn" — the page has no separate tie word.
 * `no_result` is not a draw (nothing was decided), and a settled fixture with
 * no outcome at all has no verdict to show: both are null.
 */
export function playerMatchResult(status: string, outcome: unknown, myEntrantId: string): PlayerMatchResult | null {
  if (status === "in_play") return "live";
  if (outcome === null || typeof outcome !== "object") return null;
  const { kind, winner } = outcome as { kind?: unknown; winner?: unknown };
  if (typeof winner === "string") return winner === myEntrantId ? "won" : "lost";
  if (kind === "draw" || kind === "tie") return "drawn";
  return null;
}

/**
 * Every person's match figures off a scorecard the engine folded, summed over
 * every MAIN innings — so a two-innings match reads as the match's figures
 * rather than the first innings alone. Super-over innings are left out: a super
 * over is a tiebreak and its runs and wickets are not part of a player's match
 * figures. `isSuperOver` is the fold's own flag.
 */
export function figuresByPerson(card: CricketScorecard): FixtureFigures {
  // No prototype: a key is a person id and nothing else.
  const figures: FixtureFigures = Object.create(null);
  const of = (person: string): PersonFigures => (figures[person] ??= { batting: null, bowling: null });
  for (const innings of card.innings) {
    if (innings.isSuperOver) continue;
    for (const line of innings.batting) {
      const mine = of(line.person);
      mine.batting = { runs: (mine.batting?.runs ?? 0) + line.runs, balls: (mine.batting?.balls ?? 0) + line.balls };
    }
    for (const line of innings.bowling) {
      const mine = of(line.person);
      mine.bowling = {
        wickets: (mine.bowling?.wickets ?? 0) + line.wickets,
        runs: (mine.bowling?.runs ?? 0) + line.runs,
      };
    }
  }
  return figures;
}

/** runs (balls) batting, wickets/runs bowling, joined by `player.line.cricket`
 *  when the person did both; "—" when they did neither. */
export function cricketLine(figures: PersonFigures | undefined, dict: Dict): string {
  const batting = figures?.batting ? t(dict, "player.line.batting", figures.batting) : null;
  const bowling = figures?.bowling ? t(dict, "player.line.bowling", figures.bowling) : null;
  if (batting !== null && bowling !== null) return t(dict, "player.line.cricket", { batting, bowling });
  return batting ?? bowling ?? NO_FIGURES;
}

/** The same person's figures under several ids (a survivor and everyone merged
 *  into them), summed. Undefined when none of the ids batted or bowled. */
export function figuresFor(all: FixtureFigures | null, people: readonly string[]): PersonFigures | undefined {
  if (all === null) return undefined;
  let sum: PersonFigures | undefined;
  for (const id of people) {
    if (!Object.hasOwn(all, id)) continue;
    const { batting, bowling } = all[id]!;
    const acc: PersonFigures = sum ?? { batting: null, bowling: null };
    if (batting) {
      acc.batting = { runs: (acc.batting?.runs ?? 0) + batting.runs, balls: (acc.batting?.balls ?? 0) + batting.balls };
    }
    if (bowling) {
      acc.bowling = {
        wickets: (acc.bowling?.wickets ?? 0) + bowling.wickets,
        runs: (acc.bowling?.runs ?? 0) + bowling.runs,
      };
    }
    sum = acc;
  }
  return sum;
}

/**
 * The score as the person's OWN side reads it — rendered by the ENGINE, never
 * re-rendered here.
 *
 * HOME reads the stored headline verbatim: it is home-first already.
 *
 * AWAY reads the module's own `summary()` of the stored state with the two
 * sides exchanged: every `home`/`away` key and every "home"/"away" value
 * swapped, the entrants with them — the same match, seen with the away entrant
 * at home. Whatever a sport's headline carries (set-based ", " games and the
 * open game's points, tennis' "6–7(5)" / "[8–10]" / " · 2–1 (30–15)", carrom's
 * games won, "(OT)", "(GWS 0–1)", "(5–4 pens)", a board game's "vs") comes out
 * of the one function that wrote the home headline, so the two cannot drift.
 *
 * Why the stored state and not a second fold with the lineups swapped: that
 * fold re-attributes every POSITIONAL payload (a set summary's `{home, away}`,
 * generic's `{p1Score, p2Score}`) to the wrong entrant, and it costs a ledger
 * load and a fold per fixture. The exchange is one walk over the stored state
 * and one `summary()` call, with no fold.
 *
 * The exchange is a naming convention every kernel's state follows (sides are
 * `home`/`away` keys or values, entrants are ids); the tests hold it to the
 * swapped-lineup fold over every shipped module's golden ledgers. `null` when
 * the state is missing; a module that cannot summarise the exchanged state
 * throws, and the caller degrades that line to no score.
 */
export function scoreLineFor(
  stored: { summary: MatchRow["summary"]; state: unknown },
  myEntrantId: string,
  homeEntrantId: string | null,
  module: Pick<AnySportModule, "summary">,
): string | null {
  const headline = typeof stored.summary?.headline === "string" ? stored.summary.headline : null;
  if (myEntrantId === homeEntrantId) return headline;
  if (stored.state === null || stored.state === undefined) return null;
  return (module.summary(sidesExchanged(stored.state)) as { headline: string }).headline;
}

/** A folded state with its two sides exchanged (see `scoreLineFor`). */
function sidesExchanged(value: unknown): unknown {
  if (value === "home") return "away";
  if (value === "away") return "home";
  if (Array.isArray(value)) return value.map(sidesExchanged);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key === "home" ? "away" : key === "away" ? "home" : key] = sidesExchanged(inner);
  }
  return out;
}

/** The away side's line for one seed row; a module that cannot render it costs
 *  that line its score, and nothing else. */
function ownSideScoreLine(r: MatchRow): string | null {
  if (r.my_entrant_id === r.home_entrant_id) {
    return typeof r.summary?.headline === "string" ? r.summary.headline : null;
  }
  try {
    return scoreLineFor(
      { summary: r.summary, state: r.away_state },
      r.my_entrant_id,
      r.home_entrant_id,
      resolveModule(r.sport_key, r.module_version),
    );
  } catch (err) {
    log.warn(
      { fixtureId: r.id, err: err instanceof Error ? err.message : String(err) },
      "player matches: could not render this fixture's score from the away side, the line shows none",
    );
    return null;
  }
}

/** One person's line straight off a scorecard. */
export function cricketLineFor(card: CricketScorecard, personId: string, dict: Dict): string {
  const figures = figuresByPerson(card);
  return cricketLine(figuresFor(figures, [personId]), dict);
}

interface MatchRow {
  id: string;
  status: string;
  outcome: unknown;
  scheduled_at: unknown;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  summary: { headline?: string; perSide?: { entrantId: string; line: string }[]; detail?: unknown } | null;
  /** The stored folded state — selected for the AWAY side only (`ownSideScoreLine`). */
  away_state: unknown;
  module_version: string;
  last_seq: number | null;
  snapshot_at: string | null;
  division_id: string;
  division_name: string;
  division_slug: string;
  sport_key: string;
  youth: boolean;
  player_name_display: string | null;
  division_tz: string | null;
  org_tz: string | null;
  my_entrant_id: string;
  my_slot: "starting" | "bench" | null;
}

type MatchArgs = { personId: string; competitionId: string; orgSlug: string; compSlug: string; locale: Locale };

/**
 * Every started fixture the person appeared in within one competition, newest
 * first, each with its line, the opponent and the result. Empty → [].
 */
export async function readPlayerMatchLines(sql: Sql, args: MatchArgs): Promise<PlayerMatchLine[]> {
  const seeds = await readPlayerMatchSeeds(sql, args);
  return completePlayerMatchLines(sql, seeds, { personId: args.personId, locale: args.locale });
}

/**
 * The relational half: every started fixture the person is placed in, newest
 * first. Cacheable — the result is plain JSON and folds nothing.
 */
export async function readPlayerMatchSeeds(sql: Sql, args: MatchArgs): Promise<PlayerMatchSeed[]> {
  const { personId, competitionId, orgSlug, compSlug } = args;

  // `mine` is the person's side of each fixture: their `player` lineup row on
  // one of its two sides where one exists (precedence 0), else their roster
  // membership of a side that declared no lineup for this fixture (precedence
  // 1). An inner lateral join, so a fixture with neither is not a row at all.
  // Someone placed on BOTH sides resolves the same way every read: lineup
  // before roster, then home before away. (`is_home` is a column because a
  // UNION's ORDER BY may name output columns only.)
  //
  // Newest first by when the fixture was scheduled, or — never scheduled — by
  // when its ledger was last written (`match_states.updated_at`, stamped by
  // every append; the digest's "happened this week" reads the same column).
  const rows = await sql<MatchRow[]>`
    select f.id, f.status, f.outcome, f.scheduled_at, f.home_entrant_id, f.away_entrant_id,
           f.summary, f.last_seq, fx.config_snapshot_at::text as snapshot_at,
           d.id as division_id, d.name as division_name, d.slug as division_slug, d.sport_key, dv.module_version,
           dv.youth, dv.player_name_display,
           ss.tz as division_tz, o.timezone as org_tz,
           mine.entrant_id as my_entrant_id, mine.slot as my_slot,
           case when mine.entrant_id is distinct from f.home_entrant_id then ms.state end as away_state
    from public_fixtures_v f
    join public_divisions_v d on d.id = f.division_id
    join divisions dv on dv.id = d.id
    join fixtures fx on fx.id = f.id
    left join match_states ms on ms.fixture_id = f.id
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations o on o.id = dv.org_id
    join lateral (
      select l.entrant_id, l.slot, 0 as precedence, l.entrant_id = f.home_entrant_id as is_home
      from lineups l
      where l.fixture_id = f.id and l.person_id = ${personId}
        and l.role = 'player'
        and l.entrant_id in (f.home_entrant_id, f.away_entrant_id)
      union all
      select em.entrant_id, null::text as slot, 1 as precedence, em.entrant_id = f.home_entrant_id as is_home
      from entrant_members em
      where em.person_id = ${personId}
        and em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
        and not exists (select 1 from lineups dl where dl.fixture_id = f.id and dl.entrant_id = em.entrant_id)
      order by precedence, is_home desc
      limit 1
    ) mine on true
    where d.competition_id = ${competitionId}
      and f.status in ${sql(APPEARANCE_STATUSES as string[])}
    order by coalesce(f.scheduled_at, ms.updated_at) desc nulls last, f.id`;
  if (rows.length === 0) return [];

  const opponentNames = await maskedOpponentNames(sql, rows);
  return rows.map((r) => {
    const opponentId = r.my_entrant_id === r.home_entrant_id ? r.away_entrant_id : r.home_entrant_id;
    return {
      fixtureId: r.id,
      href: routes.sharedFixture(orgSlug, compSlug, r.division_slug, r.id),
      divisionName: r.division_name,
      divisionSlug: r.division_slug,
      scheduledAt: isoDateTime(r.scheduled_at),
      tz: resolveVenueTz(r.division_tz, r.org_tz),
      opponentName: (opponentId !== null ? opponentNames.get(opponentId) : undefined) ?? NO_FIGURES,
      result: playerMatchResult(r.status, r.outcome, r.my_entrant_id),
      sportKey: r.sport_key,
      status: r.status,
      lastSeq: r.last_seq,
      snapshotAt: r.snapshot_at,
      slot: r.my_slot,
      scoreLine: ownSideScoreLine(r),
    };
  });
}

/**
 * The figures half: each cricket fixture's figures from the per-fixture cache,
 * the bench policy, and the line text. Fixtures are folded one at a time, in
 * the seeds' order, each in its own short transaction — a fixture that cannot
 * be folded, for any reason including a database error, costs that line its
 * figures and nothing else. NOT inside another `unstable_cache` (file header).
 */
export async function completePlayerMatchLines(
  sql: Sql,
  seeds: readonly PlayerMatchSeed[],
  args: { personId: string; locale: Locale },
): Promise<PlayerMatchLine[]> {
  if (seeds.length === 0) return [];
  const dict = await getDictionary(args.locale, "public");
  // Everyone merged into this person. A merge flattens inbound tombstones onto
  // the new survivor, so one hop is the invariant; the bounded walk is the belt
  // to that, the same belt `player-stats.ts`'s `liveSurvivor` wears.
  const absorbed = await sql<{ id: string }[]>`
    with recursive absorbed(id, depth) as (
      select id, 1 from persons where merged_into = ${args.personId}
      union all
      select p.id, a.depth + 1 from persons p join absorbed a on p.merged_into = a.id where a.depth < 16
    )
    select distinct id from absorbed`;
  const people = [args.personId, ...absorbed.map((row) => row.id)];
  return composePlayerMatchLines(seeds, people, dict, (seed) => fixtureFigures(sql, seed));
}

/**
 * Seeds to lines, given where a cricket fixture's figures come from and every id
 * the person's figures may be recorded under (`people`, the person first): the bench
 * policy and the line text, one fixture at a time in the seeds' order.
 * `figuresOf` is asked about cricket fixtures only, and answers null for one it
 * could not fold. Split from `completePlayerMatchLines` so the policy can be
 * driven with figures the engine cannot produce today (see the bench tests).
 */
export async function composePlayerMatchLines(
  seeds: readonly PlayerMatchSeed[],
  people: readonly string[],
  dict: Dict,
  figuresOf: (seed: PlayerMatchSeed) => Promise<FixtureFigures | null>,
): Promise<PlayerMatchLine[]> {
  const lines: PlayerMatchLine[] = [];
  for (const seed of seeds) {
    const { sportKey, slot, scoreLine } = seed;
    const figures = figuresFor(sportKey === "cricket" ? await figuresOf(seed) : null, people);
    if (slot === "bench" && !benchRowIsAppearance(sportKey, figures)) continue;
    lines.push({
      fixtureId: seed.fixtureId,
      href: seed.href,
      divisionName: seed.divisionName,
      divisionSlug: seed.divisionSlug,
      scheduledAt: seed.scheduledAt,
      tz: seed.tz,
      opponentName: seed.opponentName,
      line: sportKey === "cricket" ? cricketLine(figures, dict) : (scoreLine ?? NO_FIGURES),
      result: seed.result,
    });
  }
  return lines;
}

/** Seconds an in-play fixture's figures entry is served before it is re-folded.
 *  The key moves on every ball anyway, so this is a staleness bound only. */
const LIVE_FIGURES_REVALIDATE = 300;

/**
 * One fixture's figures, folded at most once per (fixture, last recorded event,
 * config snapshot) — `overlay/load.ts` folds its scorebug on the first two; the
 * third catches a staff re-snapshot, which rewrites the config without
 * appending — and shared by every person and every page that asks.
 *
 * GROWTH. `revalidate` does not evict: it only marks an entry stale. Every
 * ledger advance and every re-snapshot writes a NEW key and leaves the old one
 * in the data cache, so storage grows by one entry per `last_seq` change (a
 * T20 is ~250 of them) and per re-snapshot, per fixture anyone viewed. A settled
 * fixture's entry never goes stale; an in-play one is re-folded after
 * `LIVE_FIGURES_REVALIDATE` if its key has not already moved on.
 *
 * WHAT IS CACHED. Figures, keyed by the ids the ledger recorded (so a later
 * merge needs no re-fold: the read-time sum picks it up), and `null` for a
 * fixture the ENGINE refuses (its config schema or its reducer): that verdict
 * cannot change until the ledger or the snapshot does, both of which move the
 * key. NOT cached, thrown out of the cached function, logged here, and tried
 * again on the next read: a database error, and a refusal while the ledger
 * names a merged person `asRecorded` could not seat.
 *
 * THE KEY'S VERSION ("-v2") IS A PROMISE ABOUT ENGINE OUTPUT, not just shape:
 * nothing else in the key moves when a deploy changes what the same ledger
 * folds to, and a settled fixture's entry never goes stale. Bump it with ANY
 * change to `FixtureFigures`' shape, to `deriveCricketScorecard`'s batting or
 * bowling figures, or to what the fold refuses.
 *
 * "-v2": the cricket core-event fix (fix/cricket-scorecard-core-events) turned
 * a ledger with a `core.lineup.*` event from a refusal into figures, and
 * changed `didNotBat`, which nothing here reads. W2 introduces this key, so no
 * "-v1" entry was ever served in production: the bump keeps the rule above
 * (a fold change moves the version), it does not retire a deployed entry.
 */
async function fixtureFigures(sql: Sql, seed: PlayerMatchSeed): Promise<FixtureFigures | null> {
  const { fixtureId, lastSeq, snapshotAt, status } = seed;
  try {
    return await unstable_cache(
      () => foldFixtureFigures(sql, fixtureId),
      // "-v2": bump with any change to the scorecard fold's figures or refusals (above).
      ["pub-player-figures-v2", fixtureId, String(lastSeq), snapshotAt ?? "no-snapshot"],
      { revalidate: status === "in_play" ? LIVE_FIGURES_REVALIDATE : false },
    )();
  } catch (err) {
    log.warn(
      { fixtureId, lastSeq, err: err instanceof Error ? err.message : String(err) },
      "player matches: could not load a cricket fixture's figures, the line shows none this time",
    );
    return null;
  }
}

/** A refusal FROM THE FOLD — the engine judged the config or the ledger. Zod is
 *  matched by name: the engine's schemas may come from another zod copy. */
function isFoldRefusal(err: unknown): boolean {
  return EngineError.is(err) || (err instanceof Error && err.name === "ZodError");
}

/**
 * The engine's scorecard for one fixture, reduced to per-person figures. The
 * config MUST be parsed — `loadFoldInputs` carries it raw, and the scorecard
 * fold throws on the raw value. The scorecard fold resolves voids itself now
 * (it rides `foldMatch`, which calls `resolveVoids`), and `resolveVoids` is
 * idempotent, so resolving the ledger first here is free; it stays so this
 * read and `loadMatchCentre` fold one stream. Its own transaction, opened and
 * closed here: a statement Postgres refuses aborts this fixture's transaction
 * and no other's.
 *
 * Only the pure half sits inside the refusal guard. Everything that reads the
 * database — including `loadFoldInputs`' own refusals of a fixture it cannot
 * load (a missing entrant, an unknown module) — stays outside it and throws
 * uncached, as `admin-fixture-config.ts` treats the same failures.
 */
async function foldFixtureFigures(sql: Sql, fixtureId: string): Promise<FixtureFigures | null> {
  return (await sql.begin(async (tx) => {
    const inputs = await loadFoldInputs(tx, fixtureId);
    if (inputs === null) return null;
    const { lineups, unresolved } = await asRecorded(tx, inputs.lineups, inputs.envelopes);
    try {
      const cfg = inputs.module.configSchema.parse(inputs.cfg) as CricketCfg;
      return figuresByPerson(deriveCricketScorecard({ events: resolveVoids(inputs.envelopes), cfg, lineups }));
    } catch (err) {
      // A refusal is cached as no figures — but not while the ledger names a
      // merged person this read could not seat: that refusal is this reader's
      // gap, not the fixture's, and is thrown (uncached) to be tried again.
      if (!isFoldRefusal(err) || unresolved.length > 0) throw err;
      log.warn(
        { fixtureId, err: err instanceof Error ? err.message : String(err) },
        "player matches: the engine refused this cricket fixture's config or ledger, cached as no figures",
      );
      return null;
    }
  })) as FixtureFigures | null;
}

/**
 * The lineup pair as the LEDGER knows it.
 *
 * A merge repoints a lineup row to the survivor — and, where both people were
 * on the same sheet, DELETES the absorbed person's row — while every recorded
 * event keeps naming the id it was recorded under. Folding the repointed sheet
 * would refuse the first ball an absorbed id faced or bowled. So every merged
 * id the ledger names gets a slot of its own on its survivor's side:
 *  - the survivor's slot stays the survivor's when the ledger names the
 *    survivor too; otherwise the first absorbed id takes it over;
 *  - each further id is APPENDED to that side (next `orderNo`, same slot kind
 *    and role), so no other player's place in the batting order moves.
 * The figures come out keyed by each recorded id, and the read-time merge in
 * `completePlayerMatchLines` sums them for the survivor.
 *
 * `unresolved`: merged ids the ledger names whose survivor is on neither sheet
 * — nothing to seat them beside. A refusal with any of those is not cached.
 */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function asRecorded(
  tx: postgres.TransactionSql,
  lineups: LineupPair,
  envelopes: readonly EventEnvelope[],
): Promise<{ lineups: LineupPair; unresolved: string[] }> {
  const recorded = JSON.stringify(envelopes.map((envelope) => envelope.payload));
  const named = [...new Set((recorded.match(UUID_PATTERN) ?? []).map((id) => id.toLowerCase()))];
  if (named.length === 0) return { lineups, unresolved: [] };
  const merged = await tx<{ id: string; merged_into: string }[]>`
    select id, merged_into from persons where id in ${tx(named)} and merged_into is not null`;
  if (merged.length === 0) return { lineups, unresolved: [] };

  const absorbedBySurvivor = new Map<string, string[]>();
  for (const { id, merged_into } of merged) {
    absorbedBySurvivor.set(merged_into, [...(absorbedBySurvivor.get(merged_into) ?? []), id]);
  }
  const seated = new Set<string>();
  const seat = (lineup: Lineup): Lineup => {
    let lastOrderNo = Math.max(0, ...lineup.slots.map((slot) => slot.orderNo));
    const slots: LineupSlot[] = [];
    const appended: LineupSlot[] = [];
    for (const slot of lineup.slots) {
      const absorbed = (absorbedBySurvivor.get(slot.personId) ?? []).filter((id) => !seated.has(id));
      if (absorbed.length === 0) {
        slots.push(slot);
        continue;
      }
      for (const id of absorbed) seated.add(id);
      const ids = named.includes(slot.personId) ? [slot.personId, ...absorbed] : absorbed;
      slots.push({ ...slot, personId: ids[0]! });
      for (const id of ids.slice(1)) {
        lastOrderNo += 1;
        appended.push({ personId: id, slot: slot.slot, orderNo: lastOrderNo, ...(slot.role ? { role: slot.role } : {}) });
      }
    }
    return { ...lineup, slots: [...slots, ...appended] };
  };
  return {
    lineups: { home: seat(lineups.home), away: seat(lineups.away) },
    unresolved: merged.map((row) => row.id).filter((id) => !seated.has(id)),
  };
}

/** The six fields the masking pass reads — a Matches seed row and an Upcoming
 *  row both carry them, so both go through the ONE masking decision. */
type OpponentPolicyRow = Pick<
  MatchRow,
  "my_entrant_id" | "home_entrant_id" | "away_entrant_id" | "division_id" | "youth" | "player_name_display"
>;

/** Opponent display names through the shared masking pass, one division at a
 *  time — the pass takes that division's own youth / name-display policy. */
async function maskedOpponentNames(sql: Sql, rows: readonly OpponentPolicyRow[]): Promise<Map<string, string>> {
  const opponentIds = new Set<string>();
  for (const r of rows) {
    const id = r.my_entrant_id === r.home_entrant_id ? r.away_entrant_id : r.home_entrant_id;
    if (id !== null) opponentIds.add(id);
  }
  const names = new Map<string, string>();
  if (opponentIds.size === 0) return names;

  type OpponentRow = { id: string; kind: string; display_name: string; division_id: string };
  const entrants = await sql<OpponentRow[]>`
    select id, kind, display_name, division_id from public_entrants_v where id in ${sql([...opponentIds])}`;
  const byDivision = new Map<string, OpponentRow[]>();
  for (const e of entrants) {
    const list = byDivision.get(e.division_id) ?? [];
    list.push(e);
    byDivision.set(e.division_id, list);
  }
  for (const [divisionId, list] of byDivision) {
    const policy = rows.find((r) => r.division_id === divisionId)!;
    const masked = await maskPublicEntrantNames(
      list.map(({ id, kind, display_name }) => ({ id, kind, display_name })),
      { youth: policy.youth, player_name_display: policy.player_name_display },
    );
    for (const e of masked) names.set(e.id, e.display_name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// UPCOMING — docs/superpowers/specs/2026-09-23-player-profile-upcoming-matches-design.md
//
// The person's next SCHEDULED fixtures across every public competition of the
// card's org, plus the card's own competition whatever its visibility (R2: an
// unlisted sibling on another card would publish its link; private is already
// gone from the views). The visibility gate is the JOIN, as in the reader
// above: `public_fixtures_v` AND `public_divisions_v` (the fixture view alone
// keeps an archived division). A finished place is not upcoming (plan D1): a
// completed/archived competition or a completed division contributes nothing,
// or its undated leftovers would read "Time TBD" forever. A person whose card
// is NAME-MASKED (youth policy, `playerCardNameMask`) gets the card's own
// competition only (owner 2026-09-23).
//
// Membership is the ROSTER (`entrant_members` of a registered/confirmed
// entrant): a future fixture is nobody's by lineup yet. V412 moved the status
// filter out of `public_entrants_v`, so it is applied to `entrants` here.
//
// Court and venue are the NAMES behind `court_id`/`venue_id`, through
// `withCourtVenueNames` (data.ts) — the one derivation the hub, the match
// centre, the calendar and the embeds share, with its org-wide "Name (Venue)"
// disambiguation and its setup redaction. The view's `court_label`/`venue` are
// the retired free-text columns, frozen since the P9 cutover: nothing writes
// them, so reading them showed no court for any fixture placed since.
//
// Plain JSON and folds nothing. The caller (`getPublicPlayerUpcoming`) holds no
// cache of it: see plan D3.
// ---------------------------------------------------------------------------

/** One scheduled fixture on the player card's Upcoming list. */
export interface PlayerUpcomingRow {
  fixtureId: string;
  /** The fixture's public match centre, under ITS OWN competition's slug. */
  href: string;
  /** ISO instant; null when undated or its division has not released its schedule. */
  scheduledAt: string | null;
  /** The VENUE zone (`resolveVenueTz`), for formatting `scheduledAt`. */
  tz: string;
  /** The venue's NAME (from `venue_id`); null when unassigned or its division is in setup. */
  venue: string | null;
  /** The court's display label (from `court_id`, venue-qualified only when its
   *  bare name is ambiguous in the org); null when unassigned or in setup. */
  courtLabel: string | null;
  /** The other side: its masked public name, else its seat's public label, else the localised TBD. */
  opponentLabel: string;
  competitionName: string;
  competitionSlug: string;
  divisionName: string;
  divisionSlug: string;
  /** True when the fixture belongs to a competition other than the card's. */
  isOtherCompetition: boolean;
}

export type UpcomingArgs = {
  orgId: string;
  orgSlug: string;
  personId: string;
  /** The competition whose card is being rendered (R2's exception). */
  currentCompetitionId: string;
  /** The ORG's locale — seat labels are rendered in it, like every word on the card. */
  locale: Locale;
  now: Date;
};

/** A scheduled fixture whose slot passed this long ago without being scored is not "upcoming". */
export const UPCOMING_STALE_AFTER_MS = 3 * 60 * 60 * 1000;
/** A safety cap on the read. The five-row cut is the component's. */
export const UPCOMING_SAFETY_CAP = 50;

/**
 * The slot-label key `stages.ts` stores on a bye's phantom side — the ONLY
 * record of a bye (`competition-hub.ts`' `hubByeSides` reads the same key). A
 * bye is nobody's next match, but a bye line can sit `scheduled` with no
 * outcome: every line generated before 2026-09-17, and a seeded or dead-feeder
 * bye until `awardSeededByes` settles it. Matched with its seat EMPTY, never by
 * "one side is null", which is also every seat still waiting on a feeder. The
 * `coalesce` keeps an unlabelled empty seat (a null key) from turning the
 * whole `not (...)` null and dropping the row.
 */
const BYE_SLOT_KEY = "bracket.slot.bye";

interface UpcomingDbRow {
  id: string;
  stage_id: string;
  scheduled_at: unknown;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  division_id: string;
  division_name: string;
  division_slug: string;
  youth: boolean;
  player_name_display: string | null;
  division_tz: string | null;
  org_tz: string | null;
  competition_id: string;
  competition_name: string;
  competition_slug: string;
  my_entrant_id: string;
}

/** Every scheduled fixture the person is rostered into across the org, soonest
 *  first, undated last. Empty → []. */
export async function readPlayerUpcoming(sql: Sql, args: UpcomingArgs): Promise<PlayerUpcomingRow[]> {
  const { orgId, orgSlug, personId, currentCompetitionId, locale, now } = args;
  const cutoff = new Date(now.getTime() - UPCOMING_STALE_AFTER_MS);
  // Owner 2026-09-23: a person whose CARD is name-masked is listed on this
  // card's competition only — no other competition's rows at all, so a young
  // player's card is not an itinerary across the org. The decision is the
  // card's own (`playerCardNameMask`: any youth or name-display policy across
  // the org's rosters), never a second rule. Adults are unchanged.
  const ownOnly = (await playerCardNameMask(personId, orgId)) !== null;
  const rows = await sql<UpcomingDbRow[]>`
    with mine as (
      select e.id
      from entrant_members em
      join entrants e on e.id = em.entrant_id
      where em.person_id = ${personId}
        and e.status in ('registered','confirmed')
    )
    select f.id, f.stage_id, f.scheduled_at,
           f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
           d.id as division_id, d.name as division_name, d.slug as division_slug,
           dv.youth, dv.player_name_display,
           ss.tz as division_tz, o.timezone as org_tz,
           c.id as competition_id, c.name as competition_name, c.slug as competition_slug,
           case when f.home_entrant_id in (select id from mine) then f.home_entrant_id
                else f.away_entrant_id end as my_entrant_id
    from public_fixtures_v f
    join public_divisions_v d    on d.id = f.division_id
    join divisions dv            on dv.id = d.id
    join public_competitions_v c on c.id = d.competition_id
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations o      on o.id = c.org_id
    where (f.home_entrant_id in (select id from mine) or f.away_entrant_id in (select id from mine))
      and c.org_id = ${orgId}
      -- Another competition's rows only when it is LISTED: public and past
      -- draft (owner decision 2026-09-27, lib/competition-listing.ts). The
      -- card's own competition is the direct link, so it lists its own rows
      -- whatever its status or visibility.
      and ((c.visibility = 'public' and c.status <> 'draft') or c.id = ${currentCompetitionId})
      and (not ${ownOnly}::boolean or c.id = ${currentCompetitionId})
      and c.status not in ('completed','archived')
      and d.status <> 'completed'
      and f.status = 'scheduled'
      and not (f.home_entrant_id is null and coalesce(f.home_slot_label->>'key', '') = ${BYE_SLOT_KEY})
      and not (f.away_entrant_id is null and coalesce(f.away_slot_label->>'key', '') = ${BYE_SLOT_KEY})
      and (f.scheduled_at is null or f.scheduled_at >= ${cutoff.toISOString()})
    order by f.scheduled_at asc nulls last, f.round_no, f.seq_in_round, f.id
    limit ${UPCOMING_SAFETY_CAP}`;
  if (rows.length === 0) return [];

  const names = await maskedOpponentNames(sql, rows);
  const seatOf = await opponentSeatNamer(sql, rows, locale);
  // P9: names from `court_id`/`venue_id`, null while the division is in setup.
  const located = await withCourtVenueNames(rows);
  return located.map((r) => {
    const mineHome = r.my_entrant_id === r.home_entrant_id;
    const opponentId = mineHome ? r.away_entrant_id : r.home_entrant_id;
    const named = opponentId !== null ? names.get(opponentId) : undefined;
    return {
      fixtureId: r.id,
      href: routes.sharedFixture(orgSlug, r.competition_slug, r.division_slug, r.id),
      scheduledAt: isoDateTime(r.scheduled_at),
      tz: resolveVenueTz(r.division_tz, r.org_tz),
      venue: r.venue_name,
      courtLabel: r.court_name,
      opponentLabel: named ?? seatOf(r, mineHome ? "away" : "home"),
      competitionName: r.competition_name,
      competitionSlug: r.competition_slug,
      divisionName: r.division_name,
      divisionSlug: r.division_slug,
      isOtherCompetition: r.competition_id !== currentCompetitionId,
    };
  });
}

/**
 * A waiting seat's PUBLIC text: the match centre's rule (`match-centre-load.ts`,
 * fix round N1), which is `publicRoundNamer(...).seat()` over the seat's own
 * stage rows. That gives "Winner of Semi-finals, match 2", never the organiser
 * board's "R1·2", with the `schedule.tbd` fallback. Stage rows are read only
 * for fixtures that actually have an empty seat.
 */
async function opponentSeatNamer(
  sql: Sql,
  rows: readonly UpcomingDbRow[],
  locale: Locale,
): Promise<(row: UpcomingDbRow, seat: "home" | "away") => string> {
  const ui: SlotLabelLookup = (key, vars) => msgFor(locale, key, vars);
  const stored = (r: UpcomingDbRow, seat: "home" | "away") => (seat === "home" ? r.home_slot_label : r.away_slot_label);
  const waiting = rows.filter((r) => r.home_entrant_id === null || r.away_entrant_id === null);
  if (waiting.length === 0) return (r, seat) => resolveSlotLabel(stored(r, seat), ui, "schedule.tbd");
  const stageIds = [...new Set(waiting.map((r) => r.stage_id))];
  const stageRows = await sql<NamedFixture[]>`
    select f.id, f.stage_id, f.round_no, f.seq_in_round, f.lane, f.is_final, f.third_place, f.conditional,
           x.ext_key, x.winner_to_fixture, x.winner_to_slot, x.loser_to_fixture, x.loser_to_slot
    from public_fixtures_v f
    join fixtures x on x.id = f.id
    where f.stage_id in ${sql(stageIds)}`;
  const kinds = await sql<{ id: string; kind: string }[]>`select id, kind from stages where id in ${sql(stageIds)}`;
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  const namer = publicRoundNamer({
    ui,
    dict: await getDictionary(locale, "public"),
    fixtures: stageRows,
    stageKind: (id) => kindOf.get(id),
  });
  return (r, seat) => namer.seat(r.id, seat, stored(r, seat));
}
