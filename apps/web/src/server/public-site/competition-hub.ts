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
// Redis layer for the API, invalidated by one direct DEL of that literal key
// (`cacheDel`, no keyspace SCAN) from both writers. Both keys drop on
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
import { resolveNameDisplay, resolvePersonDisplayName } from "@/lib/name-display";
import { renderProse } from "@/lib/prose";
import { publicRoundNamer } from "./feeder-slot-label";
import { decidedOutcomeText, playerStatLabel, shootoutScoreFromDetail } from "@/lib/scoring-vocab";
import {
  bucketFixture,
  deriveHubTabs,
  sortHubMatches,
  type MatchBucket,
} from "@/lib/matches-hub";
import { resolveModule } from "@/server/engine-db";
import { publicRegistrationInfo } from "@/server/usecases/registrations";
import { activePublicSuspensionEntries } from "@/server/usecases/discipline";
import { log } from "@/server/logger";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import type { AnySportModule } from "@seazn/engine/sport";
// The LEAF, not the `@seazn/engine/scheduling` barrel: `bracket-layout.ts` has
// zero imports, and the barrel reaches the gRPC placement client.
import { twoSidedBracket } from "@seazn/engine/scheduling/bracket-layout";
import {
  competitionTag,
  divisionTag,
  getPublicCompetition,
  getPublicDivision,
  orgTag,
  readEntrantMemberRefs,
  REVALIDATE_FAST,
  type EntrantMemberRef,
  type PublicDivision,
  type PublicEntrant,
  type PublicFixture,
  type PublicStage,
} from "./data";
import { statusOf } from "./match-centre";
import type { MatchCentreHeaderT, SideT } from "./match-centre-schema";
import { buildTableView } from "./standings-view";
import { buildLeaderBoards, type LeaderDivisionConsent } from "./leaders";
import { readLeaderRows } from "./public-leaders";
import { BRACKET_KINDS, BRACKET_SETTLED, bracketChampion, divisionChampion } from "./champion";
import { describeFormat } from "./describe-format";
import type {
  CompetitionHubDocT,
  HubDivisionT,
  HubMatchT,
  HubMemberT,
  HubSuspensionT,
  KnockoutRoundT,
  KnockoutViewT,
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

/** The slot-label key `stages.ts` (`byeSlotLabel`) stores on a bye's phantom
 *  side. It is the ONLY record of a bye: `hubSides` resolves the label to a
 *  sentence and drops the key, so this must read the fixture, not the side. */
const BYE_SLOT_KEY = "bracket.slot.bye";

/**
 * `HubMatch.byeSides` — `[home, away]`, true where that side is a bye: no
 * entrant AND the stored bye slot label (Knockout fix round 2b). Never decided
 * from the side's name, which is locale copy ("Bye", "Descanso", ...). A side
 * with no entrant and any other label is a slot WAITING on a result, and stays
 * false; an entrant is never a bye, whatever label rides beside it.
 */
export function hubByeSides(
  fixture: Pick<
    PublicFixture,
    "home_entrant_id" | "away_entrant_id" | "home_slot_label" | "away_slot_label"
  >,
): [boolean, boolean] {
  const bye = (entrantId: string | null, label: SlotLabel | null) =>
    entrantId === null && label?.key === BYE_SLOT_KEY;
  return [
    bye(fixture.home_entrant_id, fixture.home_slot_label),
    bye(fixture.away_entrant_id, fixture.away_slot_label),
  ];
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
    // Both null for the same reason `rateLine` is: the hub does not read the
    // ledger. The live over comes off the cricket fold (`card.innings`), and
    // the meta line needs the division's format label and the stage's round —
    // neither of which this builder is given. Null is the schema's own "no
    // such line", not a placeholder for something reachable from here.
    //
    // Nothing on the hub renders either today: the match CARD shows a score
    // and a time, not a scorebug. A future hub scorebug would need the fields
    // plumbed, and would find them null rather than wrong.
    pillNote: null,
    metaLine: null,
    updatedAt: generatedAt,
  };
}

// --------------------------------------------------------------- knockouts

type KnockoutLane = KnockoutRoundT["lane"];

/** A bracket's lanes in reading order: a single-lane bracket (`null`) or the
 *  winners' side first, then the losers' side, then the grand final. */
function laneRank(lane: KnockoutLane): number {
  return lane === "LB" ? 1 : lane === "GF" ? 2 : 0;
}

/**
 * One bracket stage as a knockout view, or null when the stage has no
 * fixtures yet (an undrawn bracket publishes nothing, and earns no tab).
 *
 * ROUNDS group by `(lane, round_no)` and the round's name (see below), ordered
 * by lane then round, each in
 * `seq_in_round` order. The bronze match (`third_place`) shares the final's
 * `round_no` in the engine (`generateSingleElim`), so it is pulled into a
 * round of its own and placed immediately BEFORE the final round: a spectator
 * reading down the rail meets the play-off for third before the final itself.
 *
 * LABELS are the strings the stage's matches already carry — `labelOf` reads
 * back what the matches loop resolved, so a round and its cards can never name
 * the round differently.
 *
 * DRAWABLE is `twoSidedBracket`'s verdict, and only for a `knockout`: the one
 * authority on a regular single-elimination shape. Every other bracket kind
 * keeps its Rounds view and gets no tree.
 *
 * CHAMPION is `bracketChampion` (`./champion.ts`) — the engine's rule, and the
 * SAME function `divisionChampion` crowns the Table tab and the division page
 * with. A second rule here disagreed with it (a forfeited final, a reset won
 * by forfeit, a decided final beside an unplayed bronze), so there is none.
 */
function buildKnockoutView(a: {
  stage: Pick<PublicStage, "id" | "name" | "kind">;
  division: { id: string; slug: string; name: string };
  fixtures: readonly PublicFixture[];
  labelOf: (fixtureId: string) => string | null;
}): KnockoutViewT | null {
  if (a.fixtures.length === 0) return null;
  const bySeq = (x: PublicFixture, y: PublicFixture) => x.seq_in_round - y.seq_in_round;

  // A round is its lane, its `round_no` AND its name. For every bracket kind
  // but one, the name is the same across a `(lane, round_no)`, so this groups
  // exactly as `(lane, round_no)` alone did. A page playoff is the exception:
  // Qualifier 1 and the Eliminator share round one (fix round 1, M3), and one
  // chip named for whichever match came first would hide the other round.
  const groups = new Map<string, { key: string; lane: KnockoutLane; roundNo: number; fixtures: PublicFixture[] }>();
  const bronze: PublicFixture[] = [];
  for (const f of a.fixtures) {
    if (f.third_place === true) {
      bronze.push(f);
      continue;
    }
    const lane = f.lane ?? null;
    const key = `${lane ?? "main"}-${f.round_no}`;
    const identity = JSON.stringify([key, a.labelOf(f.id)]);
    const group = groups.get(identity) ?? { key, lane, roundNo: f.round_no, fixtures: [] };
    group.fixtures.push(f);
    groups.set(identity, group);
  }
  const ordered = [...groups.values()];
  for (const group of ordered) group.fixtures.sort(bySeq);
  ordered.sort(
    (x, y) =>
      laneRank(x.lane) - laneRank(y.lane) ||
      x.roundNo - y.roundNo ||
      x.fixtures[0]!.seq_in_round - y.fixtures[0]!.seq_in_round,
  );
  // Keys stay `{lane}-{round_no}`. Only rounds that SHARE one take their first
  // match's seq as a suffix, so every other bracket's keys — and the URLs and
  // test ids built from them — are unchanged.
  const sharing = new Map<string, number>();
  for (const group of ordered) sharing.set(group.key, (sharing.get(group.key) ?? 0) + 1);
  for (const group of ordered) {
    if ((sharing.get(group.key) ?? 0) > 1) group.key = `${group.key}-${group.fixtures[0]!.seq_in_round}`;
  }

  const rounds = [...ordered];
  if (bronze.length > 0) {
    bronze.sort(bySeq);
    rounds.splice(Math.max(rounds.length - 1, 0), 0, {
      key: "third-place",
      lane: bronze[0]!.lane ?? null,
      roundNo: bronze[0]!.round_no,
      fixtures: bronze,
    });
  }

  const champion = bracketChampion(a.fixtures);

  // THE RESET NOBODY OWES leaves the rail (Task 2 fix round 1, ruling 2). Once
  // a champion is crowned, a round made only of CONDITIONAL fixtures that never
  // settled is a double-elimination reset the result made unnecessary: the
  // winners' champion took the first grand final, and nothing in production
  // voids the reset row, so it reads `scheduled` for ever. Left on the rail it
  // is a "Grand final (reset)" chip nobody will play — the one unfinished round
  // of a finished bracket. Its MATCH stays in `doc.matches` (a fixture in no
  // round is valid), so its own page still resolves.
  //
  // "The crowning fixture is not the reset" needs no clause of its own:
  // `bracketChampion` only crowns a SETTLED final, so a reset that crowned is
  // settled and the settled test below already keeps its round. A separate
  // clause could never change an answer, and a guard no test can kill is
  // decoration (AGENTS.md 3).
  //
  // A reset that has STARTED stays (Task 2 fix round 2): unowed or not, a live
  // match dropped from the rail cannot be reached from it, and the tab opens
  // on a live round first. Liveness is `hubLiveness`'s, the one derivation.
  const shownRounds = champion
    ? rounds.filter(
        (g) =>
          g.fixtures.some((f) => hubLiveness(f.status).live) ||
          !g.fixtures.every((f) => f.conditional === true && !BRACKET_SETTLED.has(f.status)),
      )
    : rounds;

  return {
    id: `${a.division.slug}-${a.stage.id}`,
    divisionId: a.division.id,
    divisionSlug: a.division.slug,
    divisionName: a.division.name,
    stageId: a.stage.id,
    stageName: a.stage.name,
    // `BRACKET_KINDS` chose this stage, and `KnockoutKind` restates that set
    // exactly (pinned by the schema suite).
    kind: a.stage.kind as KnockoutViewT["kind"],
    rounds: shownRounds.map((g) => ({
      key: g.key,
      // Unreachable fallback: a view only exists for a stage the division
      // read returned, and every fixture of a known stage got a label.
      label: a.labelOf(g.fixtures[0]!.id) ?? "",
      lane: g.lane,
      fixtureIds: g.fixtures.map((f) => f.id),
    })),
    drawable:
      a.stage.kind === "knockout" &&
      twoSidedBracket(
        a.fixtures.map((f) => ({ id: f.id, round_no: f.round_no, seq_in_round: f.seq_in_round })),
      ).ok,
    championFixtureId: champion?.fixtureId ?? null,
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

  // ONE discipline read for every division, beside the details, and a READ:
  // no detection, no serving pass, no email — a hub rebuild has no
  // single-flight, and `refreshDiscipline` serves bans on the write path. A
  // failure is an empty list, never a hub-down: bans are a line on a squad,
  // not the page.
  const [details, allBans] = await Promise.all([
    Promise.all(divisions.map(async (d) => ({ d, detail: await getPublicDivision(orgSlug, compSlug, d.slug) }))),
    activePublicSuspensionEntries(divisions.map((d) => d.id)).catch((err: unknown): HubBan[] => {
      log.warn(
        { competitionId: competition.id, err: err instanceof Error ? err.message : String(err) },
        "competition-hub: the suspension read failed; bans and Suspended marks are absent",
      );
      return [];
    }),
  ]);
  const bansByDivision = new Map<string, HubBan[]>();
  for (const b of allBans) (bansByDivision.get(b.divisionId) ?? bansByDivision.set(b.divisionId, []).get(b.divisionId)!).push(b);

  const matches: HubMatchT[] = [];
  const tables: TableViewT[] = [];
  const knockouts: KnockoutViewT[] = [];
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
    const bans = bansByDivision.get(d.id) ?? [];
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
    const divHref = `${base}/${d.slug}`;
    const squads = await divisionSquads({ division: d, entrants, bans, names, base });

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
      // Sanitised by THE prose pipeline here, once, so no renderer holds raw
      // organiser Markdown. Blank prose is no prose.
      description: d.description ? (await renderProse(d.description)) || null : null,
      suspensions: squads.suspensions,
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
    // Every fixture's round name and every unfilled side's text, from the ONE
    // public namer (`feeder-slot-label.ts`). The match centre builds its names
    // through the same function, so a waiting side cannot read one way on a hub
    // card and another in the match centre, and its `{round}` is the rail chip's
    // own string. The namer ranks each fixture within its OWN stage — why that
    // matters (a league pooled with a knockout printed "Semi-finals" on the
    // final) is on the function — and keeps each name, so a knockout round
    // below reuses the exact string its matches carry.
    const namer = publicRoundNamer({
      ui,
      dict,
      fixtures,
      stageKind: (stageId) => stageById.get(stageId)?.kind,
    });
    for (const f of fixtures) {
      const sides = hubSides(f, { names, kinds, badges, colours, slot: (label) => namer.slot(f.stage_id, label) });
      const stage = stageById.get(f.stage_id);
      if (f.venue_name) venues.add(f.venue_name);
      const { bucket } = hubLiveness(f.status);
      const winner = f.outcome?.winner ?? null;
      const roundLabel = namer.roundLabel(f.id);
      matches.push({
        fixtureId: f.id,
        divisionId: d.id,
        divisionSlug: d.slug,
        divisionName: d.name,
        sportKey: d.sport_key,
        stageName: stage?.name ?? "",
        roundNo: f.round_no,
        roundLabel,
        bucket,
        tz,
        scheduledAt: f.scheduled_at,
        venueName: f.venue_name,
        courtName: f.court_name,
        href: `${divHref}/fixtures/${f.id}`,
        header: hubHeader(f, sides, d.sport_key, generatedAt),
        byeSides: hubByeSides(f),
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
            entrantColours: colours,
            championId,
            updatedAt: snap.updated_at,
            msg,
          }),
        );
      }
    }

    // Knockouts in stage `seq` order — the "relevance" sort above is the
    // TABLES' reading order; a bracket's place in the programme is its seq.
    // Division order is this loop's own.
    const bracketStages = stages
      .filter((s) => BRACKET_KINDS.has(s.kind))
      .sort((a, b) => a.seq - b.seq);
    for (const stage of bracketStages) {
      const view = buildKnockoutView({
        stage,
        division: { id: d.id, slug: d.slug, name: d.name },
        fixtures: fixtures.filter((f) => f.stage_id === stage.id),
        labelOf: (id) => namer.roundLabel(id),
      });
      if (view) knockouts.push(view);
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
        members: squads.membersByEntrant.get(e.id) ?? [],
        // The division's own .ics route, filtered to this entrant
        // (`calendar.ics/route.ts` reads `?entrant=`).
        calendarHref: `${divHref}/calendar.ics?entrant=${encodeURIComponent(e.id)}`,
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
    knockouts,
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
      knockouts: knockouts.length,
      leaderRows: leaders.reduce((n, board) => n + board.rows.length, 0),
      teams: teams.length,
    }),
  };
}

/** One active ban as the hub's single discipline read returns it. */
type HubBan = Awaited<ReturnType<typeof activePublicSuspensionEntries>>[number];

/**
 * One division's squads (per entrant) and its list of active bans.
 *
 * Members are the MASKED lines `getPublicDivision` already produced — never
 * re-read, never re-masked. A line links to the player page only where the
 * view published an id (consent + player-profile entitlement) AND the
 * division shows full names: a masked name with a link is the full name one
 * click away. The id is withheld on exactly the same terms.
 *
 * A ban is matched to a line by PERSON, never by name (two players can share
 * one), by zipping `readEntrantMemberRefs`'s internal rows onto the view's
 * lines by position. The lines come from `getPublicDivision`'s cache while the
 * rows are read fresh, and a roster write does not revalidate that cache, so
 * a renumber or a swap between the two reads shifts who sits at index i
 * without changing the count. The zip is therefore trusted for a team only
 * when EVERY row agrees with its line (`squadRowsMatchLines`): same count,
 * same squad number, same position, the same name once the row's full name
 * is masked by the division's own policy, the same person wherever the view
 * published an id, and no two rows the view's sort cannot order. Any
 * disagreement marks nobody on that team — marking the wrong person
 * "Suspended" is worse than marking no one, and the ban still lists on Info.
 * The team-sheet gate is division-scoped, so a person is marked on any team
 * of the division, with their longest remaining ban. The internal read runs
 * only when the division has a ban at all.
 */
async function divisionSquads(args: {
  division: PublicDivision;
  entrants: PublicEntrant[];
  bans: HubBan[];
  names: Record<string, string>;
  base: string;
}): Promise<{ membersByEntrant: Map<string, HubMemberT[]>; suspensions: HubSuspensionT[] }> {
  const { division, entrants, bans, names, base } = args;
  const linkable = resolveNameDisplay(division.player_name_display, division.youth ?? false) === "full";
  const membersByEntrant = new Map<string, HubMemberT[]>();
  for (const e of entrants) {
    membersByEntrant.set(
      e.id,
      (e.members ?? []).map((m) => {
        const publicId = linkable && m.person_id ? m.person_id : null;
        return {
          personId: publicId,
          name: m.name,
          squadNumber: m.squad_number ?? null,
          position: m.position ?? null,
          playerHref: publicId ? `${base}/players/${publicId}` : null,
          suspendedRemaining: null,
        };
      }),
    );
  }

  const publicIdByPerson = new Map<string, string | null>();
  if (bans.length > 0) {
    const longest = new Map<string, number>();
    for (const b of bans) longest.set(b.personId, Math.max(longest.get(b.personId) ?? 0, b.remaining));
    const withSquads = entrants.filter((e) => (e.members?.length ?? 0) > 0);
    const refs: Record<string, EntrantMemberRef[]> =
      withSquads.length > 0
        ? await readEntrantMemberRefs(withSquads.map((e) => e.id)).catch((err: unknown) => {
            log.warn(
              { divisionId: division.id, err: err instanceof Error ? err.message : String(err) },
              "competition-hub: the squad member read failed; Suspended marks are absent",
            );
            return {};
          })
        : {};
    for (const e of withSquads) {
      const rows = refs[e.id] ?? [];
      if (!squadRowsMatchLines(rows, e.members!, division)) continue;
      const lines = membersByEntrant.get(e.id)!;
      rows.forEach((r, i) => {
        const line = lines[i]!;
        const remaining = longest.get(r.personId);
        if (remaining !== undefined) line.suspendedRemaining = remaining;
        if (line.personId) publicIdByPerson.set(r.personId, line.personId);
      });
    }
  }

  const suspensions: HubSuspensionT[] = bans
    .map((b) => {
      const entrantId = b.entrantId !== null && b.entrantId in names ? b.entrantId : null;
      return {
        personId: publicIdByPerson.get(b.personId) ?? null,
        name: b.name,
        entrantId,
        entrantName: entrantId ? names[entrantId]! : null,
        remaining: b.remaining,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { membersByEntrant, suspensions };
}

/**
 * May this team's fresh internal rows be zipped onto its cached squad lines by
 * position? Only when every row provably describes its line — checked for ALL
 * rows before any is used, so one moved player voids the whole team's marks.
 */
function squadRowsMatchLines(
  rows: EntrantMemberRef[],
  lines: PublicEntrant["members"],
  division: PublicDivision,
): boolean {
  if (rows.length !== lines.length) return false;
  return rows.every((r, i) => {
    const line = lines[i]!;
    // Same full name, same number: `public_entrants_v` sorts by
    // `squad_number nulls last, full_name`, so their relative order is
    // Postgres's choice, not a promise — either row could be either line.
    const unorderable = rows.some((o, j) => j !== i && o.fullName === r.fullName && o.squadNumber === r.squadNumber);
    return (
      !unorderable &&
      r.squadNumber === (line.squad_number ?? null) &&
      r.positionKey === (line.position ?? null) &&
      resolvePersonDisplayName(r.fullName, r.consent, division.player_name_display ?? null, division.youth ?? false) ===
        line.name &&
      // The view publishes a person id only with consent + entitlement; where
      // it did, it must be this row's person.
      (line.person_id == null || line.person_id === r.personId)
    );
  });
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
  // v2 since the Knockout tab added `knockouts`; v3 since squads, bans and
  // division prose (division-page parity, 2026-09-16). The page renders this
  // cached document WITHOUT re-parsing it (unlike `usecases/public.ts`, whose
  // Redis hit goes back through `CompetitionHubDoc.safeParse`), so an older
  // entry must never reach a renderer that reads the new fields. Bump again on
  // any shape change a cached hit cannot satisfy.
  return unstable_cache(() => loadCompetitionHub(orgSlug, compSlug), ["pub-hub-v3", shell.competition.id], {
    tags: [
      orgTag(orgSlug),
      competitionTag(shell.competition.id),
      ...shell.divisions.map((d) => divisionTag(d.id)),
    ],
    revalidate: REVALIDATE_FAST,
  })();
}
