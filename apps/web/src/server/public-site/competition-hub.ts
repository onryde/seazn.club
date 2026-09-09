import "server-only";
// Spectator surface W2, Task 4 — the competition HUB document.
//
// ONE document feeds the competition landing page's server render, its poll
// endpoint and every tab. Every number in it is already formatted and every
// name already resolved: the builder owns the locale, the timezone and the
// sport's vocabulary, and no consumer re-derives any of them
// (`competition-hub-schema.ts`'s own contract).
//
// Two caches sit in front of it, and they are different things: `unstable_cache`
// (below) is Next's tag-based ISR layer for the PAGE, invalidated by
// `revalidateTag`; `pub:v1:hub:{competitionId}` (usecases/public.ts) is the
// Redis layer for the API, invalidated by `cacheDelPattern`. Both keys drop on
// a scoring write AND on a schedule write — see `invalidatePublicCache`
// (usecases/scoring.ts) and `afterScheduleWrite` (usecases/schedule.ts). A hub
// whose matches go stale on a reschedule is the defect this file exists to
// avoid, and the schedule path is the one a first draft missed.
//
// ---------------------------------------------------------------------------
// THE LEDGER IS NEVER READ HERE. `loadMatchCentre` (W1) folds every
// `score_event` for ONE fixture; a competition hub carries every fixture in
// every division, so folding would make a spectator's landing page O(all events
// ever scored). Every header field below is derived from the fixture's own
// persisted `summary` blob — the same `ScoreSummary` the scoring write already
// stored — through the SHARED readers in `lib/public-site.ts` that
// `live-score.tsx` uses. Same for the leader boards, which read
// `player_stat_snapshots` and never call `recomputePlayerStats` (ruling R-L).
// ---------------------------------------------------------------------------
import { unstable_cache } from "next/cache";
import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary, t, type TKey } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import { disambiguatedShorts, matchPhase, matchStrength, setBreakdown } from "@/lib/public-site";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { resolveSlotLabel } from "@/lib/slot-label";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";
import { decidedOutcomeText, playerStatLabel, shootoutScoreFromDetail } from "@/lib/scoring-vocab";
import {
  bucketFixture,
  deriveHubTabs,
  sortHubMatches,
  type MatchBucket,
} from "@/lib/matches-hub";
import { resolveModule } from "@/server/engine-db";
import { publicRegistrationInfo } from "@/server/usecases/registrations";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import type { AnySportModule } from "@seazn/engine/sport";
import {
  competitionTag,
  divisionTag,
  getPublicCompetition,
  getPublicDivision,
  orgTag,
  REVALIDATE_FAST,
  type PublicFixture,
} from "./data";
import { statusOf } from "./match-centre";
import type { MatchCentreHeaderT, SideT } from "./match-centre-schema";
import { buildTableView } from "./standings-view";
import { buildLeaderBoards, type LeaderDivisionConsent } from "./leaders";
import { readLeaderRows } from "./public-leaders";
import { BRACKET_KINDS, divisionChampion } from "./champion";
import { describeFormat } from "./describe-format";
import type {
  CompetitionHubDocT,
  HubDivisionT,
  HubMatchT,
  LeaderBoardT,
  TableViewT,
  TeamCardT,
} from "./competition-hub-schema";

// ---------------------------------------------------------------- liveness

export interface HubLiveness {
  bucket: MatchBucket;
  status: MatchCentreHeaderT["status"];
  live: boolean;
}

/**
 * THE ONE liveness derivation, and the reason it exists.
 *
 * A hub match carries THREE views of "is this match happening now":
 * `HubMatch.bucket` (which of the three lists it is filed under),
 * `header.status` (the match-centre header's four states) and `header.live`
 * (the boolean the card paints a dot from). Task 1's review recorded them as
 * three competing authorities pinned to no single source, and a document with
 * `bucket: "completed"` beside `live: true` was reachable — not because either
 * ladder is wrong, but because nothing said which one answers.
 *
 * `bucket` answers. `live` is READ OFF IT rather than recomputed, so the two
 * cannot disagree by construction. `status` is W1's own ladder — imported, not
 * restated, because the header's four states are that module's vocabulary —
 * and the two ladders' agreement is not assumed: `competition-hub.test.ts`
 * enumerates the whole `Fixture.status` wire vocabulary plus unknown strings
 * and asserts `live === (status === "in_play")` on every one of them, with the
 * same source-text drift guard `matches-hub.test.ts` uses so a status added to
 * the wire reds this rather than slipping through.
 *
 * The two ladders answer different questions and are both needed: an
 * `abandoned` fixture is `completed` (a spectator looking for a match that was
 * called off must find it saying so) but `other` (there is no result to show),
 * and an UNKNOWN status is `upcoming` but `other`. Neither can be derived from
 * the other's output, which is why this returns all three rather than one.
 */
export function hubLiveness(wireStatus: string): HubLiveness {
  const bucket = bucketFixture(wireStatus);
  return { bucket, status: statusOf(wireStatus), live: bucket === "live" };
}

/**
 * Wire statuses `public.json` carries a `matchCentre.status.<s>` sentence for.
 *
 * DECLARED, not derived, and checked against all four dictionaries by the
 * suite: `t()` renders a missing key as the dotted key itself, so a status
 * outside this set would put `matchCentre.status.postponed_indefinitely` on a
 * spectator's screen. Anything not listed falls back to
 * `matchCentre.status.other` ("Not played"), which is a real sentence for the
 * real case — the fixture will not be played and we cannot say more.
 *
 * `decided`/`finalized`/`in_play`/`scheduled` are deliberately absent: those
 * never reach the `other` branch, and their own statusLine is either a result
 * sentence (`HubMatch.resultLine`) or a time the renderer formats from
 * `scheduledAt` + `tz`.
 */
export const STATUS_LINE_KEYS: ReadonlySet<string> = new Set([
  "abandoned",
  "cancelled",
  "forfeited",
  "postponed",
  "walkover",
]);

// -------------------------------------------------------------------- sides

export interface HubSideCtx {
  /** entrant id → display name, ALREADY masked by `getPublicDivision`. */
  names: Record<string, string>;
  /** entrant id → `entrants.kind`; `team` abbreviates differently from a
   *  person (`disambiguatedShorts`). */
  kinds: Record<string, string>;
  badges: Record<string, string | null>;
  colours: Record<string, string | null>;
  /** `{key,params}` → the org-locale slot sentence for an unfilled side. */
  slot: (label: SlotLabel | null) => string;
}

type SidePre = SideT & { isPerson: boolean };

/**
 * Both sides of a fixture, resolved TOGETHER.
 *
 * The brief specified a one-side-at-a-time `hubSide`; it is a pair here for
 * the reason `match-centre-load.ts` already gives at length: a `short`
 * abbreviation collision can only be SEEN — and broken — by comparing both
 * sides at once ("Player One"/"Player Two" both compact to "PLA"). W1 fixed
 * that with `disambiguatedShorts`, and a per-side builder cannot call it. The
 * hub card shows the same two abbreviations the court card does, so it uses
 * the same resolver rather than a second, colliding rule.
 *
 * A side with no entrant yet (a bye, or a bracket slot waiting on a result)
 * renders its slot sentence as the name and never a blank — `entrantId` is the
 * empty string, which is what W1's `Side` already means by "nobody here yet".
 */
export function hubSides(
  fixture: Pick<
    PublicFixture,
    "home_entrant_id" | "away_entrant_id" | "home_slot_label" | "away_slot_label"
  >,
  ctx: HubSideCtx,
): [SideT, SideT] {
  const pre = (entrantId: string | null, label: SlotLabel | null): SidePre => {
    if (entrantId === null) {
      return {
        entrantId: "",
        name: ctx.slot(label),
        short: "",
        colour: null,
        badgeUrl: null,
        isPerson: false,
      };
    }
    return {
      entrantId,
      // "?" rather than a blank for an entrant the division read no longer
      // returns — the same defensive fallback `loadSides` uses, and for the
      // same reason (a stale reference must never render an empty row).
      name: ctx.names[entrantId] ?? "?",
      short: "",
      colour: ctx.colours[entrantId] ?? null,
      badgeUrl: ctx.badges[entrantId] ?? null,
      isPerson: (ctx.kinds[entrantId] ?? "team") !== "team",
    };
  };
  const home = pre(fixture.home_entrant_id, fixture.home_slot_label);
  const away = pre(fixture.away_entrant_id, fixture.away_slot_label);
  const [homeShort, awayShort] = disambiguatedShorts(home, away);
  const side = (pre_: SidePre, short: string): SideT => ({
    entrantId: pre_.entrantId,
    name: pre_.name,
    short,
    colour: pre_.colour,
    badgeUrl: pre_.badgeUrl,
  });
  return [side(home, homeShort), side(away, awayShort)];
}

// ------------------------------------------------------------------ header

/**
 * The open set's points, as the header's `subLines`.
 *
 * `match-centre.ts`'s `liveSubLines` does exactly this from the `SetsView` the
 * timeline builder derives; that builder needs the ledger, this does not — the
 * same per-set numbers are already in `summary.detail.sets`, read through the
 * SHARED `setBreakdown` (`lib/public-site.ts`) that `live-score.tsx` uses. The
 * open set is the FIRST entry with `closed: false`, the engine's own record of
 * which column is in progress — never "the last one", which is a sport rule
 * this function has no business assuming (the exact note W1's own comment
 * carries after a re-review caught it doing that).
 *
 * `[null, null]` for cricket (no `sets` array), for the period sports (a
 * period breakdown has no single "current set"), and for any match whose sets
 * are all closed — which is every decided match, so no gate on liveness is
 * needed or wanted.
 */
function openSetSubLines(
  summary: PublicFixture["summary"],
  sportKey: string,
): [string | null, string | null] {
  const breakdown = setBreakdown(summary, sportKey);
  if (breakdown === null) return [null, null];
  const open = breakdown.sets.find((s) => !s.closed);
  if (open === undefined) return [null, null];
  return [`(${open.home})`, `(${open.away})`];
}

/**
 * Which side is batting, for a cricket match in progress.
 *
 * W1 reads this off the folded scorecard's `live.battingSide`; that needs the
 * ledger. The same fact is already published in the summary: cricket's
 * `summary()` writes `detail.innings[]` as `{entrantId, …, closed}` straight
 * off `state.innings`, so the side batting NOW is the last innings not yet
 * closed. Same source of truth, one fold earlier.
 *
 * Shape-gated, not sport-gated: a sport that publishes no `detail.innings`
 * answers null, which is the honest answer for every non-cricket match.
 * Returns null rather than 0 whenever the batting entrant is not one of the
 * two sides — a stale or bye-side reference must not point at the wrong row.
 */
function cricketBattingIndex(
  summary: PublicFixture["summary"],
  sides: [SideT, SideT],
): 0 | 1 | null {
  const detail = summary?.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const innings = (detail as { innings?: unknown }).innings;
  if (!Array.isArray(innings)) return null;
  let batting: string | null = null;
  for (const entry of innings) {
    if (typeof entry !== "object" || entry === null) continue;
    const { entrantId, closed } = entry as { entrantId?: unknown; closed?: unknown };
    if (closed === true || typeof entrantId !== "string") continue;
    batting = entrantId;
  }
  if (batting === null) return null;
  if (sides[0].entrantId === batting) return 0;
  if (sides[1].entrantId === batting) return 1;
  return null;
}

/**
 * A hub card's header — the SAME eleven-field `MatchCentreHeader` W1 declares,
 * filled from the fixture's persisted summary alone.
 *
 * Reusing the schema rather than restating a smaller one is ruling R-A: a hub
 * card and a match-centre header are the same fact at two sizes, and a second
 * declaration is a second thing to drift. Every field is derived — none is
 * hardcoded to a placeholder, because a field nothing can ever populate is an
 * inert seam and Task 7 renders `subLines`, `phase` and `strength`.
 *
 * `statusLine` is null for the three states that have a better carrier:
 * `decided` (the card shows `HubMatch.resultLine`, the resolved result
 * sentence), `scheduled` (the renderer formats `scheduledAt` in `tz`, which no
 * pre-resolved string can do for a viewer's own clock preference) and
 * `in_play` (the score IS the line). `other` is the state with nothing else to
 * say, and it says it.
 */
export function hubHeader(
  fixture: PublicFixture,
  sides: [SideT, SideT],
  sportKey: string,
  generatedAt: string,
): MatchCentreHeaderT {
  const { status, live } = hubLiveness(fixture.status);
  const perSide = fixture.summary?.perSide ?? [];
  const lineOf = (entrantId: string): string | null =>
    entrantId === "" ? null : (perSide.find((p) => p.entrantId === entrantId)?.line ?? null);

  return {
    live,
    status,
    sides,
    scoreLines: [lineOf(sides[0].entrantId), lineOf(sides[1].entrantId)],
    subLines: openSetSubLines(fixture.summary, sportKey),
    battingIndex: live ? cricketBattingIndex(fixture.summary, sides) : null,
    statusLine:
      status === "other"
        ? {
            key: `matchCentre.status.${STATUS_LINE_KEYS.has(fixture.status) ? fixture.status : "other"}`,
          }
        : null,
    // Cricket's run rate needs the fold; the hub does not read the ledger, so
    // there is no honest value here. Null is the schema's own "no rate line",
    // not a placeholder for something this builder could compute and does not.
    rateLine: null,
    // Both gated on live for the reason `live-score.tsx:122` gates
    // `matchStrength`: the engine leaves each stale in `detail` after the
    // final whistle, so a finished match would keep announcing a power play.
    phase: live ? matchPhase(fixture.summary) : null,
    strength: live ? matchStrength(fixture.summary) : null,
    updatedAt: generatedAt,
  };
}

// ------------------------------------------------------------ the document

/** `team_display_v.colors.home_primary` — never `.primary`, a key nothing
 *  writes (ruling 15, and `match-centre-load.ts` says the same). */
function primaryColour(colors: unknown): string | null {
  if (typeof colors !== "object" || colors === null) return null;
  const primary = (colors as { home_primary?: unknown }).home_primary;
  return typeof primary === "string" && primary !== "" ? primary : null;
}

function resolveModuleOrNull(sportKey: string, moduleVersion: string): AnySportModule | null {
  try {
    return resolveModule(sportKey, moduleVersion);
  } catch {
    // A division pinned to a module version this build no longer registers
    // still has a page: it loses its metric columns and its format line, not
    // its fixtures.
    return null;
  }
}

/**
 * The competition hub document — uncached. `null` when the org, the
 * competition or its visibility does not admit a spectator (the shell 404s).
 *
 * `now` is injectable so a test can pin a clock; nothing else in here reads
 * one.
 */
export async function loadCompetitionHub(
  orgSlug: string,
  compSlug: string,
  now: Date = new Date(),
): Promise<CompetitionHubDocT | null> {
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;
  const { org, competition, divisions } = shell;

  const locale = toLocale(org.default_locale);
  const dict = await getDictionary(locale, "public");
  const msg = (key: TKey, vars?: Record<string, string | number>) => t(dict, key, vars);
  const ui = (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars);
  const base = `/shared/${org.slug}/${competition.slug}`;
  const generatedAt = now.toISOString();

  // BOTH entitlement reads go through the pooled `hasFeature`, with the
  // competition in scope and the key as a STRING LITERAL. The competition
  // matters (an Event Pass lifts ONE competition, and `lib/entitlements.ts`
  // only consults `competition_passes` when one is in scope); the literal
  // matters because `lib/__tests__/pass-scoping-guard.test.ts` parses this
  // file's AST and only recognises a literal second argument — a key threaded
  // through a variable makes the call invisible to the standing guard.
  //
  // Resolved HERE, before anything else, and never inside a transaction:
  // `resolve()` queries the pooled proxy, and asking for a second connection
  // while a tenant transaction pins the first is the self-deadlock `lib/db.ts`
  // guards against (`draftPostsForDecidedFixture`'s own note says the same).
  const realtime = await hasFeature(org.id, "realtime", competition.id);
  // `stats.player`, the SAME key and the same per-competition resolution
  // `publicDivisionStats` uses. Without it the hub would publish leader boards
  // an org's own signed-in read is denied — the public seeing MORE than the
  // organiser, which is the inversion W3-A closed on the stats endpoint. The
  // gate has to live here because `readLeaderRows` takes no org id (its
  // visibility gate is the `public_divisions_v` join, which is a different
  // question).
  const statsAllowed = await hasFeature(org.id, "stats.player", competition.id);

  // Never throws the hub down: a competition with no registration settings at
  // all is a 404 from this reader, and that is not an error for a hub.
  const registration = await publicRegistrationInfo(orgSlug, compSlug).catch(() => null);

  const details = await Promise.all(
    divisions.map(async (d) => ({ d, detail: await getPublicDivision(orgSlug, compSlug, d.slug) })),
  );

  const matches: HubMatchT[] = [];
  const tables: TableViewT[] = [];
  const teams: TeamCardT[] = [];
  const hubDivisions: HubDivisionT[] = [];
  const venues = new Set<string>();
  const leaderDivisions: (LeaderDivisionConsent & {
    slug: string;
    name: string;
    sportKey: string;
    moduleVersion: string;
  })[] = [];
  const modules = new Map<string, AnySportModule | null>();

  for (const { d, detail } of details) {
    if (!detail) continue;
    const { stages, pools, fixtures, standings, entrants, tz } = detail;
    const module_ = resolveModuleOrNull(d.sport_key, d.module_version);
    modules.set(d.id, module_);

    const names: Record<string, string> = {};
    const kinds: Record<string, string> = {};
    const badges: Record<string, string | null> = {};
    const colours: Record<string, string | null> = {};
    for (const e of entrants) {
      // Already through `maskPublicEntrantNames` inside `getPublicDivision`
      // (RS008) — never re-masked here, and never read from a second query.
      names[e.id] = e.display_name;
      kinds[e.id] = e.kind;
      badges[e.id] = resolveEntrantBadge({
        badge_url: e.badge_url,
        team_logo_path: e.team_display?.logo_path ?? null,
      });
      colours[e.id] = primaryColour(e.team_display?.colors);
    }
    const slot = (label: SlotLabel | null) => resolveSlotLabel(label, ui, "schedule.tbd");
    const divHref = `${base}/${d.slug}`;

    hubDivisions.push({
      id: d.id,
      slug: d.slug,
      name: d.name,
      sportKey: d.sport_key,
      sportName: d.sport_name,
      status: d.status,
      tz,
      entrantCount: d.entrant_count,
      formatLine: describeFormat(d.sport_key, module_, d.config),
      variantKey: d.variant_key,
      href: divHref,
    });
    leaderDivisions.push({
      id: d.id,
      slug: d.slug,
      name: d.name,
      sportKey: d.sport_key,
      moduleVersion: d.module_version,
      youth: d.youth,
      player_name_display: d.player_name_display,
    });

    const stageById = new Map(stages.map((s) => [s.id, s]));
    // PER STAGE, and that is the whole point of this map.
    //
    // `laneRoundRank` (`lib/round-role-label.ts`) filters by LANE only, and
    // `lane` is null for a league AND for a single-elimination bracket
    // (`data.ts`: "null for single-lane brackets and non-bracket stages"). So a
    // list pooled across the division puts a league's rounds and a knockout's
    // rounds in one sorted sequence, and `lastRoundInLane` comes off the union
    // — a knockout FINAL in a division whose league ran more rounds resolves as
    // `semi_final` and the page prints "Semi-finals" on the final. `is_final`
    // does not rescue it: `round-role.ts` never reads `isFinal`, the role is
    // `lastRoundInLane - roundInLane`. Measured, on the ordinary
    // league-then-knockout shape.
    //
    // Every other caller of this helper in the repo is stage-scoped
    // (`stages-panel.tsx`'s parameter is literally `stageFixtures`;
    // `stage-court-tags.ts` selects `where stage_id = $1`; a public bracket IS
    // one stage). The hub was the only pooling caller.
    const laneByStage = new Map<string, { round_no: number; lane: "WB" | "LB" | "GF" | null }[]>();
    for (const f of fixtures) {
      const inStage = laneByStage.get(f.stage_id) ?? [];
      inStage.push({ round_no: f.round_no, lane: f.lane ?? null });
      laneByStage.set(f.stage_id, inStage);
    }
    for (const f of fixtures) {
      const sides = hubSides(f, { names, kinds, badges, colours, slot });
      const stage = stageById.get(f.stage_id);
      if (f.venue_name) venues.add(f.venue_name);
      const { bucket } = hubLiveness(f.status);
      const winner = f.outcome?.winner ?? null;
      matches.push({
        fixtureId: f.id,
        divisionId: d.id,
        divisionSlug: d.slug,
        divisionName: d.name,
        sportKey: d.sport_key,
        stageName: stage?.name ?? "",
        roundNo: f.round_no,
        // `roundRoleFor` answers for EVERY stage kind — a non-bracket stage's
        // rounds are a dense ordinal sequence and come back as `plain_round`
        // (`round-role.ts` says so outright: its display consumers "each used
        // to keep their own copy of this set purely as a GUARD in front of a
        // call this function could not safely take"). So no BRACKET_KINDS
        // guard here, and the ordinal is the fixture's rank within its own
        // lane rather than a raw `round_no` a sparse bracket numbering would
        // print wrong.
        //
        // Dropping that guard does NOT mean dropping the stage scoping: the
        // ranking list is this fixture's OWN stage. See `laneByStage` above.
        roundLabel: stage
          ? roundRoleLabel(
              ui,
              roundRoleFor(
                laneByStage.get(f.stage_id) ?? [],
                {
                  round_no: f.round_no,
                  lane: f.lane ?? null,
                  is_final: f.is_final === true,
                  third_place: f.third_place === true,
                  conditional: f.conditional === true,
                },
                stage.kind,
                null,
              ),
            )
          : null,
        bucket,
        tz,
        scheduledAt: f.scheduled_at,
        venueName: f.venue_name,
        courtName: f.court_name,
        href: `${divHref}/fixtures/${f.id}`,
        header: hubHeader(f, sides, d.sport_key, generatedAt),
        winnerIndex:
          winner === null
            ? null
            : winner === f.home_entrant_id
              ? 0
              : winner === f.away_entrant_id
                ? 1
                : null,
        // Keyed on the ONE status ladder, not on a second list of raw wire
        // strings. `sportKey` is passed so a hockey shoot-out reads "in the
        // shootout" rather than football's "on penalties".
        resultLine:
          hubLiveness(f.status).status === "decided"
            ? decidedOutcomeText(
                f.outcome,
                names,
                ui,
                shootoutScoreFromDetail(f.summary?.detail),
                d.sport_key,
              )
            : null,
      });
    }

    const championId = divisionChampion(stages, fixtures, standings);
    const poolName = new Map(pools.map((p) => [p.id, p.name]));
    // Live stage first — the same "relevance" order the division page already
    // sorts its standings panel by, so the two agree about which table reads
    // first.
    const orderedStages = [...stages].sort(
      (a, b) =>
        (a.status === "complete" ? 1 : 0) - (b.status === "complete" ? 1 : 0) || a.seq - b.seq,
    );
    for (const stage of orderedStages) {
      if (BRACKET_KINDS.has(stage.kind)) continue;
      const snapshots = standings
        .filter((s) => s.stage_id === stage.id)
        .sort((a, b) => (a.pool_id ?? "").localeCompare(b.pool_id ?? ""));
      for (const snap of snapshots) {
        tables.push(
          buildTableView({
            id: `${d.slug}-${stage.id}-${snap.pool_id ?? "overall"}`,
            division: { id: d.id, slug: d.slug, name: d.name },
            caption: snap.pool_id
              ? `${stage.name} — ${poolName.get(snap.pool_id) ?? msg("table.pool")}`
              : stage.name,
            fullHref: `${divHref}?tab=standings`,
            rows: snap.rows,
            metricSpecs: module_?.metrics ?? [],
            cascade: d.tiebreakers ?? module_?.defaultTiebreakers ?? [],
            entrantNames: names,
            entrantLogos: badges,
            championId,
            updatedAt: snap.updated_at,
            msg,
          }),
        );
      }
    }

    for (const e of entrants) {
      teams.push({
        entrantId: e.id,
        divisionId: d.id,
        divisionSlug: d.slug,
        divisionName: d.name,
        name: e.display_name,
        badgeUrl: badges[e.id] ?? null,
        colour: colours[e.id] ?? null,
        seed: e.seed,
        href: `${divHref}?tab=entrants`,
      });
    }
  }

  // EMPTY IS A FIRST-CLASS STATE, not an error and not an empty shell.
  // `player_stat_snapshots` is largely a recompute-on-read cache — its only
  // writer runs from the two stats endpoints, a person merge and an auto-posts
  // path that fires only for a division with `auto_posts` in an org holding
  // `news.auto` — so a division nobody has opened stats for holds ZERO rows.
  // That is the COMMON case. It yields no boards, and `deriveHubTabs` then
  // offers no Stats tab, which is exactly right: a tab that opens on nothing
  // is worse than no tab.
  const leaders: LeaderBoardT[] = statsAllowed
    ? buildLeaderBoards({
        divisions: leaderDivisions,
        rows: await readLeaderRows(sql, leaderDivisions),
        modelFor: (d) => modules.get(d.id)?.playerStats,
        // `LeaderSpec.labelKey` does not exist — Task 3 dropped it (it would
        // have been permanently null) for `engineLabel`, the module's own
        // declared English. The label goes through the ONE shared
        // `playerStatLabel`, the same resolver `labelPlayerStats` uses for the
        // player card: `stat.<sportKey>.<statKey>` already covers every sport
        // in all four locales, and `engineLabel` is the documented fallback
        // for a metric whose dictionary entry has not landed yet. A parallel
        // `leaders.*` family would be a second set of words for the same
        // counters (`leaders.ts`'s own ruling).
        label: (spec, division) =>
          playerStatLabel(division.sportKey, spec.key, ui, spec.engineLabel),
        personHref: (personId) => `${base}/players/${personId}`,
      })
    : [];

  const sorted = sortHubMatches(matches);
  return {
    competitionId: competition.id,
    orgSlug: org.slug,
    competitionSlug: competition.slug,
    name: competition.name,
    orgName: org.name,
    branded: org.branded,
    realtime,
    locale,
    generatedAt,
    divisions: hubDivisions,
    matches: sorted,
    tables,
    leaders,
    teams,
    info: {
      startsOn: competition.starts_on,
      endsOn: competition.ends_on,
      venues: [...venues].sort(),
      registrationOpen: registration?.divisions.some((x) => x.open) ?? false,
      registerHref: `${base}/register`,
      calendars: hubDivisions.map((d) => ({
        divisionName: d.name,
        href: `${d.href}/calendar.ics`,
      })),
      presentHref: `${base}/present`,
    },
    // DERIVED, never hand-assembled — `CompetitionHubDoc`'s refinement refuses
    // a document whose tabs are not exactly this.
    tabs: deriveHubTabs({
      matches: sorted.length,
      tables: tables.length,
      leaderRows: leaders.reduce((n, board) => n + board.rows.length, 0),
      teams: teams.length,
    }),
  };
}

/**
 * The ISR-cached hub, for the page render.
 *
 * The shell is fetched OUTSIDE the cached callback because the tag list
 * depends on ids only the shell knows — `unstable_cache` needs its tags at
 * call time, not from inside. That read is itself cached (`getPublicCompetition`
 * is `unstable_cache` on `orgTag`), so it costs one memoised hit, not a query.
 */
export async function getPublicCompetitionHub(
  orgSlug: string,
  compSlug: string,
): Promise<CompetitionHubDocT | null> {
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;
  return unstable_cache(() => loadCompetitionHub(orgSlug, compSlug), ["pub-hub-v1", shell.competition.id], {
    tags: [
      orgTag(orgSlug),
      competitionTag(shell.competition.id),
      ...shell.divisions.map((d) => divisionTag(d.id)),
    ],
    revalidate: REVALIDATE_FAST,
  })();
}
