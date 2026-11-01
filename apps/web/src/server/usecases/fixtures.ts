import "server-only";
// Fixture use-cases (doc 08 §3): schedule/venue/officials PATCH, lineups PUT,
// ledger reads (events since_seq), live state (summary + a body-digest ETag).
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { PatchFixture, PutLineup, ScheduleConflict } from "@/server/api-v1/schemas";
import { type BoardFixtureRow, type FixtureRow } from "./stages";
import { fixtureHasResultSql } from "./fixture-results-sql";
import { activeAbandonReasonSql, hasActiveAbandonSql } from "@/server/engine-db/recorded-abandon";
import { streamUrlSchema } from "@/lib/stream-url";
import { feedsNextMatch, type FeedEdges } from "@/lib/bracket-next-match";
import { fireDivisionRevalidate } from "../public-site/revalidate";
// #14: `courtNamesById` is the venue-qualified label map (via
// `buildCourtDirectory`) — a bare joined `courts.name` can't tell apart two
// venues that legally share one court name.
import { moveFixture, courtNamesById } from "./schedule";
import { subjectToScorerCapabilityGates } from "./scorers";
import { gateRosterEligibility } from "./registration-eligibility";
import { disciplineEnforcedForFixture, gateLineupSuspensions } from "./discipline";
import { resolveFixtureCfg, resolveModule } from "@/server/engine-db";
import { liveCfg, stageForfeitAward } from "@/server/engine-db/fixture-cfg";
import { formatStanding } from "@/server/engine-db/format-standing";
import { LOCKED_FIXTURE_STATUSES, type MatchRulesState } from "@/lib/fixture-status";
import { awardFit, isScoredAward, loadAward, type AwardFitVerdict } from "@/server/engine-db/awarded-state";
import { matchFieldsFor } from "@/lib/rule-scope";
import type { RuleField } from "@/lib/match-rules";
import { benchRefusal, lineupCatalogFor } from "./lineup-catalog";
import { validateLineup, type AnySportModule, type LineupIssue, type PositionCatalog } from "@seazn/engine/sport";
import type { ForfeitAward, Lineup, MatchOutcome, StageKind } from "@seazn/engine/core";
import { log } from "@/server/logger";
import type { Dict } from "@/lib/i18n-constants";
import { formatLineOf } from "@/server/engine-db/rules-version";

/** Doc 13 §7: a device link reads its fixture's scoring surface ONLY — state, events and, since W2c Task 15, the
 *  rules its pad reloads after a correction (`GET /fixtures/{id}/rules`, `getFixtureRules`) — every other fixture
 *  surface (detail, lineups, schedule) is 403 for dl_ tokens. */
function rejectDeviceLink(auth: AuthCtx): void {
  if (auth.via === "device_link") {
    throw new HttpError(403, "Device links can only access their fixture's scoring surface");
  }
}

/** The fixture shape GET/PATCH /fixtures/{id} actually serve (P9 pass
 *  3c-2): court_id/venue_id + derived court_name/venue_name, WITHOUT the
 *  frozen venue/court_label text columns. This is the one fixture read
 *  path that makes a clean break rather than adding alongside — it's the
 *  highest-visibility surface (the published v1 API contract), and #461's
 *  own PatchedFixtureOut precedent already documents this endpoint's result
 *  IS the wire, unmapped. Every other FixtureRow reader (listDivisionFixtures
 *  below, generateStageFixtures, ...) keeps venue/court_label for callers
 *  not yet migrated off them. */
export type FixtureOut = Omit<FixtureRow, "venue" | "court_label">;

export async function getFixture(auth: AuthCtx, id: string): Promise<FixtureOut> {
  rejectDeviceLink(auth);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<Omit<FixtureOut, "court_name">[]>`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.court_id, f.venue_id, ven.name as venue_name,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.id = ${id}`;
    if (!row) throw new HttpError(404, "fixture not found");
    // #14: venue-qualified label (a bare joined `courts.name` can't tell two
    // same-named courts in different venues apart) — see FixtureRow's own
    // doc comment: fall back to the id itself if a lookup somehow misses
    // (should not happen; courts.id is FK-restricted from fixtures.court_id).
    const courtNames = await courtNamesById(tx);
    return {
      ...row,
      court_name: row.court_id !== null ? (courtNames.get(row.court_id) ?? row.court_id) : null,
    };
  });
}

/** Loop-F tidy 2: does this fixture feed a NEXT match? D19's one reading (`feedsNextMatch`, lib/bracket-next-match.ts)
 *  over its two feed edges — false on a final (and on a grand final whose reset is its own rematch) and on a
 *  third-place line. Read by the fixture page for the held block's no-choice sentence; its own read, so the v1
 *  fixture's wire shape (`getFixture`) does not grow the edges. */
export async function fixtureFeedsNextMatch(auth: AuthCtx, fixtureId: string): Promise<boolean> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<FeedEdges[]>`select winner_to_fixture, loser_to_fixture from fixtures where id = ${fixtureId}`;
    if (!row) throw new HttpError(404, "fixture not found");
    return feedsNextMatch(row);
  });
}

/**
 * The config a fixture's SCORING SURFACES must render against (design
 * 2026-09-17 §T4) — the fixture console page and the device-link pad.
 *
 * Both of them used to hand the pad raw `division.config`, which is wrong in
 * two directions. A scored fixture folds against the cfg frozen onto
 * `fixtures.config_snapshot`, so a division edited afterwards made the pad
 * render a format the fold had never used. And a stage's overlay — the
 * `shootout`/`extraTime` deciders, and now a per-stage `rules` fragment — never
 * reached the pad at all, which would have left a per-stage override invisible
 * on the very screen the organiser scores from.
 *
 * This is a LOADER, deliberately separate from `getFixture`: that function's
 * result IS the published `GET /fixtures/{id}` wire, unmapped (see FixtureOut
 * above) and declared as `S.Fixture`, so widening its select would have put two
 * undeclared fields — one of them a whole frozen config — into the public API
 * response. The pages need the cfg, not a wider fixture row.
 *
 * `f.config_snapshot` is selected HERE and nowhere else on this path, and that
 * is the column the whole thing turns on: `hasFrozenCfg` reads `undefined` as
 * absence exactly like `null` (fixture-cfg.ts:53-64), so a caller that joined
 * the stage but dropped the snapshot would serve live config for every scored
 * fixture and raise nothing. One select, one place to get it wrong. The same
 * holds for `f.rules_override` beside it (W2c, V469): dropped, the pad would
 * show the stage's format for a match the organiser changed.
 *
 * No `rejectDeviceLink` guard: this has no route of its own, and the
 * device-link pad is one of the two surfaces that legitimately needs it.
 */
export async function loadFixturePadCfg(
  auth: AuthCtx,
  fixtureId: string,
): Promise<{ cfg: unknown; stageKind: string | null; rulesVersion: number; forfeitAward?: ForfeitAward }> {
  const { cfg, stageKind, rulesVersion, forfeitAward } = await readPadRules(auth, fixtureId);
  // W2c Task 16b (X-WO-1 B): the stage points rule's walkover award rides beside the cfg (it is not part of it), so the
  // console's forfeit dialog previews the number the table will carry. Absent: the stage has none that reaches this sport.
  return { cfg, stageKind, rulesVersion, ...(forfeitAward === undefined ? {} : { forfeitAward }) };
}

/**
 * W2c Task 15 (X-SR-7, owner P-1 "A") — `GET /api/v1/fixtures/{id}/rules`: the rules a match plays by NOW, as an open
 * scoring pad reloads them after a correction (409 FIXTURE_RULES_CHANGED, or an answer carrying a newer
 * `rules_version`). The same read as `loadFixturePadCfg` — the cfg the fold uses and the version an append is checked
 * against come from ONE select, so a pad can never hold a cfg from one correction and a version from the next — plus
 * the format line in the reader's language (`dict`, the public namespace), null when the describer has none to say.
 */
export async function getFixtureRules(
  auth: AuthCtx,
  fixtureId: string,
  dict: Dict,
): Promise<{ cfg: unknown; rules_version: number; format_line: string | null }> {
  const { cfg, rulesVersion, sportKey, sportModule, stageKind, divisionConfig } = await readPadRules(auth, fixtureId);
  return { cfg, rules_version: rulesVersion, format_line: formatLineOf(sportKey, sportModule, cfg, stageKind, divisionConfig, dict) };
}

async function readPadRules(auth: AuthCtx, fixtureId: string) {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      {
        config_snapshot: unknown;
        rules_override: unknown;
        rules_version: number;
        division_config: unknown;
        sport_key: string;
        module_version: string;
        stage_config: Record<string, unknown> | null;
        stage_kind: string | null;
      }[]
    >`
      select f.config_snapshot, f.rules_override, f.rules_version, d.config as division_config, d.sport_key,
             d.module_version, s.config as stage_config, s.kind as stage_kind
        from fixtures f
        join divisions d on d.id = f.division_id
        left join stages s on s.id = f.stage_id
       where f.id = ${fixtureId}`;
    // `withTenant` scopes the read to this org, so another tenant's fixture is
    // indistinguishable from a missing one — 404, never 403.
    if (!row) throw new HttpError(404, "fixture not found");
    // W2a: the stage KIND too — a bracket fixture's pad must see the sport's deciders (chess's tie-break) the
    // fold will apply, and the pad itself needs the kind (Task 12 threads `stageKind` on to it).
    const sportModule = resolveModule(row.sport_key, row.module_version);
    const stage = { kind: row.stage_kind, config: row.stage_config };
    const cfg = resolveFixtureCfg(row, row.division_config, stage, sportModule);
    return {
      cfg,
      forfeitAward: stageForfeitAward(stage, sportModule),
      stageKind: row.stage_kind,
      rulesVersion: row.rules_version,
      sportKey: row.sport_key,
      sportModule,
      divisionConfig: row.division_config,
    };
  });
}

/**
 * Where a match stands for the block, by the writer's own predicates (`fixture-rules.ts`). `standing` is null for a match the
 * writer refuses first (`LOCKED_FIXTURE_STATUSES`): `locked`. A match decided without play is `decided` when the writer
 * refuses every change to it (FIXTURE_FORMAT_LOCKED, reason decided): a bye (no score to refit), or - batch-6 M-2 - a scored
 * award `awardFit` says is locked (its own fold cannot reproduce it, so there is nothing to fit a correction against).
 * Otherwise `live` once played or decided without play with a scored award a correction refits, else `unstarted`.
 *
 * `award` is `awardFit`'s verdict (`awardRefitVerdict`) and is asked for exactly the scored award decided without play: null
 * for every other match. Any refusal it gives is a lock here - the question is asked of the format the award plays now, for
 * which the corrected-format reasons cannot arise.
 */
export function matchRulesState(
  outcome: MatchOutcome | null,
  standing: { played: boolean; decidedWithoutPlay: boolean } | null,
  award: AwardFitVerdict | null,
): MatchRulesState {
  if (standing === null) return "locked";
  if (standing.decidedWithoutPlay) {
    if (!isScoredAward(outcome)) return "decided";
    if (award === null) throw new Error("matchRulesState: a scored award decided without play needs awardFit's verdict (awardRefitVerdict)");
    if (!award.ok) return "decided";
  }
  return standing.played || standing.decidedWithoutPlay ? "live" : "unstarted";
}

/** Batch-6 M-2: the writer's own question of an award (`fixture-rules.ts` `assertAwardFits`: `loadAward`, then `awardFit`),
 *  asked of the format the award plays NOW (a no-op correction), so only the lock is left to answer: does the award's fold
 *  reproduce it? One reader, so the block never offers a correction the writer will always refuse. */
export async function awardRefitVerdict(tx: postgres.TransactionSql, fixtureId: string): Promise<AwardFitVerdict> {
  const award = await loadAward(tx, fixtureId);
  return awardFit(award.module, award.cfg, award.cfg, award.lineups, award.outcome, { fixtureId, recordedAt: new Date().toISOString() });
}

/**
 * W2c Task 19 (S2, X-SR-2, X-SR-3, X-SR-5) - what the fixture console's "Match rules" block reads: the format the match's
 * STAGE resolves to, the match's own override over it, the format it plays by now, the fields one match may change, and
 * where the match stands.
 *
 * The console reads the RESOLVED cfg, never a raw stored one: `effective` is `resolveFixtureCfg`'s answer (the frozen
 * snapshot of a started match, else division + stage rules + the match's override), `stageResolved` is the stage's own
 * (`liveCfg`, what the writer bounds an override against). Both run through the sport's schema so a default the stage
 * never wrote (football's extra time, off) is a value the form can open at; a cfg the schema refuses is passed as is.
 *
 * `state` is the WRITER's own reading (`fixture-rules.ts`): `locked` is exactly the statuses it refuses on
 * (`LOCKED_FIXTURE_STATUSES`, step 1); otherwise a match is `live` when it counts as started there (`formatStanding`: played
 * or decided without play, step 7) and `unstarted` when neither. A match decided without play is `decided`, not `live`, when
 * the writer's `awardFit` refuses every change to it (a bye, or a scored award its own fold cannot reproduce: batch-6 M-2).
 *
 * `fields` holds functions (`build`/`read`) and so never crosses to a client component: the page hands the client the
 * serialisable rest, and the block rebuilds the same list from `sportKey`/`stageKind`/`variant` (`matchFieldsFor`).
 * `dict` is the PUBLIC dictionary in the reader's language, for the stage's line in words.
 */
export interface FixtureMatchRules {
  readonly sportKey: string;
  readonly stageKind: StageKind | null;
  readonly variant: string | null;
  readonly stageLine: string;
  readonly override: Record<string, unknown> | null;
  readonly stageResolved: Record<string, unknown>;
  readonly effective: Record<string, unknown>;
  /** The format the match plays (or played) in words: the describer over `effective`, so the frozen snapshot once it has
   *  started. The block states it whenever the match carries its own override (review I2: a finished match with an override
   *  used to show a chip and the STAGE's format, never the one it was played under). */
  readonly effectiveLine: string;
  readonly fields: readonly RuleField[];
  readonly state: MatchRulesState;
  /** Status `cancelled` (the lock sentence says so; `state` is `locked` for it and for `finalized` alike). */
  readonly cancelled: boolean;
}

const isCfgObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A cfg through the sport's schema (defaults in), else as it stands; never a non-object. */
function parsedCfg(m: AnySportModule, cfg: unknown): Record<string, unknown> {
  const parsed = m.configSchema.safeParse(cfg);
  const out = parsed.success ? parsed.data : cfg;
  return isCfgObject(out) ? out : {};
}

/**
 * Match Day C2: the format each of `fixtureIds` plays, in the public line's words — the SAME `effectiveLine` the fixture page's
 * Match format says (`loadFixtureMatchRules` below: the match's own rules over its stage's over its division's, parsed), for the
 * Match Day court's read-only Match format. One query for all of them; a match whose line says nothing is absent. Tenant-scoped
 * by `withTenant`, so another org's id reads nothing.
 */
export async function fixtureFormatLines(auth: AuthCtx, fixtureIds: readonly string[], dict: Dict): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (fixtureIds.length === 0) return out;
  return withTenant(auth.orgId, async (tx) => {
    const rows = await tx<
      {
        id: string;
        config_snapshot: unknown;
        rules_override: unknown;
        division_config: unknown;
        sport_key: string;
        module_version: string;
        stage_config: Record<string, unknown> | null;
        stage_kind: string | null;
      }[]
    >`
      select f.id, f.config_snapshot, f.rules_override, d.config as division_config, d.sport_key, d.module_version,
             s.config as stage_config, s.kind as stage_kind
        from fixtures f
        join divisions d on d.id = f.division_id
        left join stages s on s.id = f.stage_id
       where f.id = any(${fixtureIds as string[]})`;
    for (const row of rows) {
      const sportModule = resolveModule(row.sport_key, row.module_version);
      const effective = parsedCfg(sportModule, resolveFixtureCfg(row, row.division_config, { kind: row.stage_kind, config: row.stage_config }, sportModule));
      const line = formatLineOf(row.sport_key, sportModule, effective, row.stage_kind, row.division_config, dict) ?? "";
      if (line !== "") out.set(row.id, line);
    }
    return out;
  });
}

export async function loadFixtureMatchRules(auth: AuthCtx, fixtureId: string, dict: Dict): Promise<FixtureMatchRules> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      {
        status: string;
        outcome: MatchOutcome | null;
        config_snapshot: unknown;
        rules_override: unknown;
        division_config: unknown;
        sport_key: string;
        module_version: string;
        variant_key: string | null;
        stage_config: Record<string, unknown> | null;
        stage_kind: string | null;
      }[]
    >`
      select f.status, f.outcome, f.config_snapshot, f.rules_override, d.config as division_config, d.sport_key, d.module_version,
             d.variant_key, s.config as stage_config, s.kind as stage_kind
        from fixtures f
        join divisions d on d.id = f.division_id
        left join stages s on s.id = f.stage_id
       where f.id = ${fixtureId}`;
    // `withTenant` scopes the read to this org: another tenant's fixture is indistinguishable from a missing one.
    if (!row) throw new HttpError(404, "fixture not found");
    const sportModule = resolveModule(row.sport_key, row.module_version);
    const stage = { kind: row.stage_kind, config: row.stage_config };
    const stageKind = row.stage_kind as StageKind | null;
    const stageRaw = liveCfg(row.division_config, stage, sportModule);
    const stageResolved = parsedCfg(sportModule, stageRaw);
    const effective = parsedCfg(sportModule, resolveFixtureCfg(row, row.division_config, stage, sportModule));
    const standing = LOCKED_FIXTURE_STATUSES.has(row.status) ? null : await formatStanding(tx, fixtureId);
    const award = standing?.decidedWithoutPlay && isScoredAward(row.outcome) ? await awardRefitVerdict(tx, fixtureId) : null;
    return {
      sportKey: row.sport_key,
      stageKind,
      variant: row.variant_key,
      stageLine: formatLineOf(row.sport_key, sportModule, stageRaw, row.stage_kind, row.division_config, dict) ?? "",
      override: isCfgObject(row.rules_override) ? row.rules_override : null,
      stageResolved,
      effective,
      effectiveLine: formatLineOf(row.sport_key, sportModule, effective, row.stage_kind, row.division_config, dict) ?? "",
      fields: matchFieldsFor({ module: sportModule, stageKind, variant: row.variant_key }),
      state: matchRulesState(row.outcome, standing, award),
      cancelled: row.status === "cancelled",
    };
  });
}

/** All fixtures of a division in play order — the organiser console read.
 *
 *  The four `*_to_fixture`/`*_to_slot` columns are FOUR EXTRA COLUMNS on this
 *  one existing select, never a second round trip. They are the bracket feed
 *  edges, and the division page's draw sheet needs them to name an unfilled
 *  knockout seat by its feeder ("Winner of R1·3") instead of "TBD" —
 *  `feedLabels()` (lib/schedule-board.ts) turns them into the same
 *  `{key, params}` the schedule board already renders these very fixtures
 *  with. The stored `*_slot_label` cannot answer for them: the SETUP
 *  progression path leaves a sibling-fed seat's label NULL on purpose,
 *  because `stageOwesDraw`/`awaitsSeedDraw` read "no label ⇒ sibling-fed"
 *  for `timing: "setup"` stages.
 *
 *  They are NOT part of the published v1 `Fixture` contract — GET
 *  /divisions/{id}/fixtures strips them alongside `venue`/`court_label`, the
 *  same projection that route already documents. */
export async function listDivisionFixtures(auth: AuthCtx, divisionId: string): Promise<FixtureRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const rows = await tx<Omit<FixtureRow, "court_name">[]>`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.venue, f.court_label, f.court_id,
             f.venue_id, ven.name as venue_name,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional,
             f.winner_to_fixture, f.winner_to_slot, f.loser_to_fixture, f.loser_to_slot,
             ${hasActiveAbandonSql(tx, "f", { expunge: true })} as expunged,
             ${activeAbandonReasonSql(tx, "f")} as abandon_reason,
             ${hasActiveAbandonSql(tx, "f")} as has_active_abandon,
             -- Rebase ruling D3: that abandon is the organiser's online No result (the settle; the line is not held).
             ${hasActiveAbandonSql(tx, "f", { noResult: true })} as no_result,
             -- W2c Task 19 (S4): the match plays a format of its own (the run sheet's "Format changed" chip).
             f.rules_override is not null as format_changed
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.division_id = ${divisionId}
      order by f.stage_id, f.round_no, f.seq_in_round`;
    // #14: venue-qualified label, same fallback convention as getFixture above.
    const courtNames = await courtNamesById(tx);
    return rows.map((r) => ({
      ...r,
      court_name: r.court_id !== null ? (courtNames.get(r.court_id) ?? r.court_id) : null,
    }));
  });
}

/** The schedule board's fixture read (F1 follow-up, payload budget "gap
 *  15" — board-v3.spec.ts). Same query as listDivisionFixtures above, but
 *  projected onto BOARD_FIXTURE_COLS. Callers that need every row's `ext_key`
 *  (the division page's bracket/stages panel) keep using listDivisionFixtures.
 *
 *  `lane`/`is_final`/`third_place`/`conditional` ARE read now — the card's
 *  knockout round code is computed from them (board/round-codes.ts,
 *  2026-09-23), and `is_final` is what tells a stage generated before V368
 *  (no role metadata, keeps R{n}) from one generated since — but each is put
 *  on a row only when it differs from its column default (lane null, flag
 *  false). Every round-robin row, i.e. nearly every row on the 5x66 budget
 *  board, carries none of the four keys and costs exactly what it did before;
 *  a single-elimination bracket pays for its final's flag and its bronze
 *  match's, a double elimination for its lanes and its grand-final flags.
 *  Absent means default — `BoardFixture` declares all four optional for
 *  exactly that reading.
 *
 *  `ext_key` is sent on the same terms, narrower (board playoff codes,
 *  2026-09-23): only when it is a page-playoff key (`pp-*` —
 *  `generatePagePlayoff`'s ids), the one thing that tells Qualifier 1 from the
 *  Eliminator. Four keys per page playoff; every other row's generator id
 *  ("r1-m1", "sl-g0", …) stays off, so no other board pays a byte for it. */
export async function listDivisionFixturesForBoard(
  auth: AuthCtx,
  divisionId: string,
): Promise<BoardFixtureRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // P9: IDENTITY ONLY. The board resolves a court's display name client-side
    // from the venues prop (`resolveCourtNames`, which covers every org court
    // including archived), so shipping `court_name`/`venue_name` on every row
    // duplicated data the client already holds — and `court_label`/`venue` are
    // the frozen legacy columns nothing writes. Six court/venue fields per row
    // across ~330 fixtures is what put this page 33KB over its RSC payload
    // budget (board-v3.spec.ts:287); the calendar trim before it was the wrong
    // suspect and saved 583 bytes.
    //
    // `venue_id` is not sent either: a court BELONGS to a venue, so court_id
    // already determines it, and measured across this database every one of
    // 10,681 fixtures has it null — it was pure weight on every row.
    const rows = await tx<
      (BoardFixtureRow & {
        ext_key: string | null;
        lane: "WB" | "LB" | "GF" | null;
        is_final: boolean;
        third_place: boolean;
        conditional: boolean;
        held: boolean;
      })[]
    >`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.court_id,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional,
             -- held (review 4 of #857): a scheduled row every board write
             -- refuses to move. The status test comes first, so the evidence
             -- lookups run for scheduled rows only.
             (f.status = 'scheduled' and ${fixtureHasResultSql(tx)}) as held
      from fixtures f
      where f.division_id = ${divisionId}
      order by f.stage_id, f.round_no, f.seq_in_round`;
    // Omitted, not nulled: the RSC flight serialises an undefined value as
    // "$undefined" and a null/false as the key plus its value — only a key
    // that is not there costs nothing.
    return rows.map(({ ext_key, lane, is_final, third_place, conditional, held, ...row }) => ({
      ...row,
      ...(held ? { held: true as const } : {}),
      ...(ext_key !== null && ext_key.startsWith("pp-") ? { ext_key } : {}),
      ...(lane !== null ? { lane } : {}),
      ...(is_final ? { is_final } : {}),
      ...(third_place ? { third_place } : {}),
      ...(conditional ? { conditional } : {}),
    }));
  });
}

/** The PATCH response (#461): the fixture, plus the conflicts the move was
 *  judged against. Declared as its own type because this endpoint's result IS
 *  the wire — the route returns it unmapped — so widening `FixtureRow` here
 *  would have widened GET too, where there is no move and nothing to report.
 *  Mirrored by `PatchedFixture` in `api-v1/schemas.ts`, which is what the
 *  published spec is generated from. */
export type PatchedFixtureOut = FixtureOut & { conflicts: ScheduleConflict[] };

export async function patchFixture(
  auth: AuthCtx,
  id: string,
  patch: PatchFixture,
): Promise<PatchedFixtureOut> {
  // Schedule-touching fields go through the scheduling console's move path
  // (doc 12 §4): conflict validation (court clashes / direct-feed order
  // violations block), schedule_edited ledger event, board realtime refresh.
  const { officials, ...move } = patch;
  // ALWAYS an array, never undefined (#461): an officials-only patch evaluates
  // no slot, and "nothing wrong" is the honest answer for it — a client should
  // not have to tell "no conflicts" from "not evaluated" by key absence.
  let conflicts: ScheduleConflict[] = [];
  if (Object.keys(move).length > 0) {
    conflicts = await moveFixture(auth, id, move);
  }
  return withTenant(auth.orgId, async (tx) => {
    if (officials) {
      await tx`
        update fixtures set officials = ${tx.json(officials as never)} where id = ${id}`;
    }
    const [row] = await tx<Omit<FixtureOut, "court_name">[]>`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.court_id, f.venue_id, ven.name as venue_name,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.id = ${id}`;
    if (!row) throw new HttpError(404, "fixture not found");
    // #14: venue-qualified label, same fallback convention as getFixture above.
    const courtNames = await courtNamesById(tx);
    return {
      ...row,
      court_name: row.court_id !== null ? (courtNames.get(row.court_id) ?? row.court_id) : null,
      conflicts,
    };
  });
}

/** The row `PUT /fixtures/{id}/stream` returns and the panel reads back. */
export interface FixtureStreamOut {
  id: string;
  stream_url: string | null;
}

/**
 * Set or clear a fixture's public broadcast link (stream overlay W1).
 *
 * Validated HERE as well as at the route, against the SAME schema the panel
 * uses (`@/lib/stream-url`, R16) — a usecase that trusts its caller is one
 * `parseBody` refactor away from writing an unvalidated host into a public
 * anchor. `withTenant` scopes the write; a fixture belonging to another org is
 * simply not found, which is also the answer for an id that does not exist.
 *
 * The revalidation is `fireDivisionRevalidate` (revalidate.ts:14), NOT
 * `broadcastRevalidate` — the latter is the peer primitive that helper calls
 * internally. It is what busts the `["pub-fixture-v10", fixtureId]` cache entry
 * tagged `divisionTag(division.id)` (`getPublicFixture`, data.ts), which is the
 * entry the public match page reads the link from.
 */
export async function setFixtureStreamUrl(
  auth: AuthCtx,
  id: string,
  streamUrl: string | null,
): Promise<FixtureStreamOut> {
  const { id: fixtureId, stream_url } = await writeStreamUrl(auth, id, streamUrl, false);
  return { id: fixtureId, stream_url };
}

/** The YouTube end step's write (YouTube Connect, F-m3): the SAME path as `setFixtureStreamUrl` (validation, tenant scope, the same
 *  revalidation), but the column is filled only while it is EMPTY, and that is decided by the UPDATE itself (`where stream_url is
 *  null`), never by a read before it - a club link saved between the end step's decision and its write is not overwritten. `written`
 *  says which happened; `stream_url` is what is stored afterwards (the winner's, when another write got there first).
 *
 *  The pages are expired either way: a replay part that just completed is on the match page's parts list whether or not it also took
 *  the link, and a later part would otherwise show only when the cache window ran out (T16). */
export async function setFixtureStreamUrlIfEmpty(
  auth: AuthCtx,
  id: string,
  streamUrl: string,
): Promise<FixtureStreamOut & { written: boolean }> {
  const { id: fixtureId, stream_url, written } = await writeStreamUrl(auth, id, streamUrl, true);
  return { id: fixtureId, stream_url, written };
}

/** The ONE stream-link write. `onlyIfEmpty` adds the `stream_url is null` condition to the UPDATE; a row that condition refused is
 *  read back (same transaction) so "taken" is told apart from "no such fixture", which is a 404 either way a write is asked for. */
async function writeStreamUrl(
  auth: AuthCtx,
  id: string,
  streamUrl: string | null,
  onlyIfEmpty: boolean,
): Promise<FixtureStreamOut & { written: boolean }> {
  rejectDeviceLink(auth);
  const parsed = streamUrlSchema.safeParse(streamUrl);
  if (!parsed.success) throw new HttpError(422, "invalid stream link");
  const value = parsed.data;
  type Row = { id: string; stream_url: string | null; division_id: string; competition_id: string };
  const out = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<Row[]>`
      update fixtures f
         set stream_url = ${value}
        from divisions d
       where f.id = ${id} and d.id = f.division_id ${onlyIfEmpty ? sql`and f.stream_url is null` : sql``}
      returning f.id, f.stream_url, f.division_id, d.competition_id`;
    if (row) return { ...row, written: true };
    if (!onlyIfEmpty) throw new HttpError(404, "fixture not found");
    const [taken] = await tx<Row[]>`
      select f.id, f.stream_url, f.division_id, d.competition_id
        from fixtures f join divisions d on d.id = f.division_id
       where f.id = ${id}`;
    if (!taken) throw new HttpError(404, "fixture not found");
    return { ...taken, written: false };
  });
  fireDivisionRevalidate(out.division_id, out.competition_id);
  return { id: out.id, stream_url: out.stream_url, written: out.written };
}

export interface LineupOut {
  fixture_id: string;
  entrant_id: string;
  slots: unknown[];
}

/** R8 branch review, finding 2 — the lineup check's own outcome, DISCRIMINATED
 *  on `checked`. Before this the check was fail-OPEN and silent about it: the
 *  `catch` in `checkStoredLineup` returns no warnings, so `warnings: []` meant
 *  EITHER "validated, nothing wrong" OR "validation threw and we swallowed
 *  it", and the two were indistinguishable on the wire. A caller that wanted
 *  to fail closed — refuse to start a fixture on an unvalidated lineup, say —
 *  had nothing to branch on. `checked: false` says so explicitly; `warnings`
 *  stays present on both branches so every existing reader keeps working. */
export type LineupCheck =
  | { checked: true; warnings: string[] }
  | { checked: false; warnings: string[]; reason: string };

/** R7-15/R8 WS-F: the PUT response, `LineupOut` plus the outcome of checking
 *  the lineup just saved. A separate type from `LineupOut` rather than
 *  widening it — same reasoning as `PatchedFixtureOut` above: GET never
 *  validates, so these fields would be a lie on every read. */
export type PutLineupOut = LineupOut & LineupCheck;

/** One row of `readLineup`'s SQL, named so the validation below can be driven
 *  from what was actually STORED rather than from the request that asked for
 *  it (finding 3). `slot` is `text` in the DDL but carries
 *  `check (slot in ('starting','bench'))` (V215), so the narrowing where it is
 *  read is the database's guarantee, not an assumption. */
interface StoredLineupSlot {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  slot: string;
  position_key: string | null;
  order_no: number | null;
  roles: string[];
  role: string | null;
  pair_order: number | null;
}

/** Human-readable rendering of one `validateLineup` issue (catalog.ts) for the
 *  PUT response + logs. Server-side only, English (no server i18n — AGENTS.md)
 *  — these are machine strings riding a warning list, not rendered copy; a
 *  future component that surfaces them to a user owes its own i18n work. */
function formatLineupIssue(issue: LineupIssue): string {
  switch (issue.kind) {
    case "starting_size":
      return `Starting lineup has ${issue.actual} player(s), expected ${issue.expected}`;
    case "bench_size":
      return `Bench has ${issue.actual} player(s), maximum is ${issue.max}`;
    case "duplicate_person":
      return `Person ${issue.personId} appears more than once in the lineup`;
    case "unknown_position":
      return `Person ${issue.personId} is assigned an unknown position "${issue.positionKey}"`;
    case "role_unknown":
      return `Person ${issue.personId} is assigned an unknown role "${issue.roleKey}"`;
    case "role_duplicate":
      return `Role "${issue.roleKey}" is held by more than one person (${issue.personIds.join(", ")})`;
    case "role_missing":
      return `Required role "${issue.roleKey}" is not filled by a starting player`;
    case "group_min":
      return `Position group "${issue.groupKey}" has ${issue.actual} starting player(s), minimum is ${issue.min}`;
    case "group_max":
      return `Position group "${issue.groupKey}" has ${issue.actual} starting player(s), maximum is ${issue.max}`;
  }
}

/** R7-15/R8 WS-F — `validateLineup`'s first production caller. WARNING ONLY:
 *  a lineup that fails validation still saves; the issues ride the PUT
 *  response as strings and are logged. Never throws: a registry/config
 *  problem resolving the catalog must not turn a working lineup save into a
 *  500 — the same "best effort, never blocks the write" posture
 *  `lineupCatalogFor` already documents for its own config-parse fallback.
 *
 *  R8 branch review, finding 3 — takes the rows `readLineup` gives back, NOT
 *  the request that asked for them. Validating `input.slots` described what
 *  the caller ASKED FOR: any normalisation, reordering or dropping the write
 *  applied was invisible to the warnings, which is the wrong answer to
 *  "is the lineup I now have valid?". Observable today in issue ORDER —
 *  `validateLineup` emits issues in slot-walk order and the read-back is
 *  ordered by `order_no nulls last, full_name`, so a request sent in some
 *  other order produced a list in the request's order, about rows stored in
 *  a different one.
 *
 *  Finding 2 — returns a DISCRIMINATED `LineupCheck` rather than a bare
 *  string[], so the `catch` below is no longer indistinguishable from a
 *  clean run. */
function checkStoredLineup(
  fixtureId: string,
  entrantId: string,
  sport: { sport_key: string; module_version: string; config: unknown },
  stored: readonly StoredLineupSlot[],
): LineupCheck {
  try {
    const sportModule = resolveModule(sport.sport_key, sport.module_version);
    const catalog = lineupCatalogFor(sportModule, sport.config);
    const lineup: Lineup = {
      entrantId,
      slots: stored.map((s, i) => ({
        personId: s.person_id,
        // V215's own check constraint is what makes this narrowing safe.
        slot: s.slot === "bench" ? "bench" : "starting",
        orderNo: s.order_no ?? i + 1,
        ...(s.position_key ? { positionKey: s.position_key } : {}),
        ...(Array.isArray(s.roles) && s.roles.length > 0 ? { roles: s.roles } : {}),
      })),
    };
    const issues = validateLineup(catalog, lineup);
    if (issues.length === 0) return { checked: true, warnings: [] };
    // IDs, kinds and keys only — never a payload/free-text value (case K5,
    // engine-db/append-event.ts's own logging convention).
    log.warn(
      { fixtureId, entrantId, sportKey: sport.sport_key, issues },
      "lineup saved with validateLineup warnings",
    );
    return { checked: true, warnings: issues.map(formatLineupIssue) };
  } catch (err) {
    log.error(
      { fixtureId, entrantId, sportKey: sport.sport_key, err },
      "lineup validation crashed — save proceeded UNCHECKED",
    );
    // The error's KIND, never its message: a message can carry config or
    // payload text, and this string rides the HTTP response (same convention
    // as the log fields above).
    return { checked: false, warnings: [], reason: err instanceof Error ? err.name : "unknown" };
  }
}

/** The catalog that governs this fixture's division, or `null` when its sport module cannot be resolved.
 *  `null` means "no benchMax to refuse against", so the save goes ahead UNCHECKED; `checkStoredLineup` resolves the
 *  same module after the write, fails the same way, logs it and reports `checked: false`, which is what keeps
 *  this from being a silent skip. */
function catalogForFixture(sport: { sport_key: string; module_version: string; config: unknown }): PositionCatalog | null {
  try {
    return lineupCatalogFor(resolveModule(sport.sport_key, sport.module_version), sport.config);
  } catch {
    return null;
  }
}

/** Replace an entrant's lineup for a fixture (idempotent PUT, doc 08 §3).
 *
 *  Everything `validateLineup` finds is a WARNING on the response, with one exception: a bench row for a sport whose
 *  catalog declares `benchMax: 0` (boardgame, carrom, generic) is REFUSED, 422 `LINEUP_BENCH_NOT_SUPPORTED`, before
 *  anything is written. Such a sport declares no bench, `validateLineup` only ever warned about the row, and the
 *  engine never uses it. Reads (`getLineup`) are unchanged: a bench row saved before this rule still reads. */
export async function putLineup(
  auth: AuthCtx,
  fixtureId: string,
  entrantId: string,
  input: PutLineup,
): Promise<PutLineupOut> {
  rejectDeviceLink(auth); // doc 13 §7: no lineups via device link
  // B05: resolved HERE, not inside the transaction. `hasFeature` queries the
  // pooled `sql` proxy and `withTenant` pins a pooled connection for its whole
  // callback — asking inside is the self-deadlock `lib/db.ts`'s nesting guard
  // exists to catch. The boolean rides in instead.
  const disciplineEnforced = await disciplineEnforcedForFixture(auth.orgId, fixtureId);
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<
      {
        division_id: string;
        competition_id: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        status: string;
        scorer_can_enter_lineups: boolean;
        sport_key: string;
        module_version: string;
        config: unknown;
      }[]
    >`
      select f.division_id, f.home_entrant_id, f.away_entrant_id, f.status, d.scorer_can_enter_lineups,
             d.sport_key, d.module_version, d.config, d.competition_id
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    // Lineup entry is config-gated for non-editors (accepted officials).
    // Coverage was proven at the door.
    if (subjectToScorerCapabilityGates(auth) && !fixture.scorer_can_enter_lineups) {
      throw new HttpError(403, "Lineup entry is restricted to organisers in this division");
    }
    if (fixture.home_entrant_id !== entrantId && fixture.away_entrant_id !== entrantId) {
      throw new HttpError(422, "entrant is not a side of this fixture");
    }
    if (fixture.status !== "scheduled") {
      throw new HttpError(422, `lineup is locked once a fixture is ${fixture.status}`);
    }
    // A catalog that declares no bench takes no bench row. The limit is the catalog's own `benchMax` (lineup-catalog.ts
    // `benchRefusal`), checked before the eligibility gates and before the delete below, so a refusal does no writes
    // at all and leaves the lineup already on file as it was (the transaction would roll a later throw back as well;
    // checking first just spends nothing on it).
    const catalog = catalogForFixture(fixture);
    const benchRefused = catalog === null ? null : benchRefusal(catalog, input.slots);
    if (benchRefused !== null) {
      throw new HttpError(
        422,
        `This sport has no bench, so a lineup cannot include bench rows (${benchRefused.benchRows} sent)`,
        "LINEUP_BENCH_NOT_SUPPORTED",
        { bench_max: 0, bench_rows: benchRefused.benchRows },
      );
    }
    const ids = [...new Set(input.slots.map((s) => s.person_id))];
    if (ids.length !== input.slots.length) {
      throw new HttpError(422, "duplicate person in lineup");
    }
    if (ids.length > 0) {
      const members = await tx<{ person_id: string }[]>`
        select person_id from entrant_members
        where entrant_id = ${entrantId} and person_id in ${tx(ids)}`;
      if (members.length !== ids.length) {
        throw new HttpError(422, "lineup contains a person who is not a member of the entrant");
      }
    }
    // RS011: catches a pre-feature roster — a person entered before this
    // gate existed (or added on a still-ungated path) can reach a lineup
    // without ever having been checked. Same evaluator, same 422 code, as
    // every other organiser roster-write gate.
    await gateRosterEligibility(tx, {
      divisionId: fixture.division_id,
      personIds: ids,
      context: "put_lineup",
      override: input.eligibility_override,
      actorId: auth.userId,
    });
    // B05: and the discipline gate, on the same override field. A confirmed
    // ban ('active') was recorded, shown on the pad banner and on the public
    // strip, and then accepted onto the sheet anyway — this is the one place
    // that read was owed. `eligibility_override.reason` lets an organiser
    // proceed on the record, against a ledger row.
    await gateLineupSuspensions(tx, {
      divisionId: fixture.division_id,
      competitionId: fixture.competition_id,
      orgId: auth.orgId,
      fixtureId,
      personIds: ids,
      enforced: disciplineEnforced,
      override: input.eligibility_override,
      actorId: auth.userId,
    });
    await tx`delete from lineups where fixture_id = ${fixtureId} and entrant_id = ${entrantId}`;
    for (const [i, s] of input.slots.entries()) {
      await tx`
        insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role, pair_order)
        values (${fixtureId}, ${entrantId}, ${s.person_id}, ${s.slot},
                ${s.position_key ?? null}, ${s.order_no ?? i + 1}, ${tx.json(s.roles as never)},
                ${s.role ?? "player"}, ${s.pair_order ?? null})`;
    }
    // Finding 3: read back FIRST, then validate what was actually stored.
    const lineup = await readLineup(tx, fixtureId, entrantId);
    const check = checkStoredLineup(
      fixtureId,
      entrantId,
      { sport_key: fixture.sport_key, module_version: fixture.module_version, config: fixture.config },
      lineup.slots,
    );
    return { ...lineup, ...check };
  });
}

/** Read an entrant's lineup for a fixture. */
export async function getLineup(auth: AuthCtx, fixtureId: string, entrantId: string): Promise<LineupOut> {
  rejectDeviceLink(auth); // doc 13 §7: no reads beyond fixture state/events
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx`select 1 from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    return readLineup(tx, fixtureId, entrantId);
  });
}

async function readLineup(
  tx: postgres.TransactionSql,
  fixtureId: string,
  entrantId: string,
): Promise<{ fixture_id: string; entrant_id: string; slots: StoredLineupSlot[] }> {
  // Jul3/07 §5 (9 Sep ×4): shirt numbers ride the lineup read model so every
  // scorer picker can render "#7 — Name".
  const slots = await tx<StoredLineupSlot[]>`
    select l.person_id, p.full_name, em.squad_number, l.slot, l.position_key, l.order_no, l.roles, l.role, l.pair_order
    from lineups l
    join persons p on p.id = l.person_id
    left join entrant_members em on em.entrant_id = l.entrant_id and em.person_id = l.person_id
    where l.fixture_id = ${fixtureId} and l.entrant_id = ${entrantId}
    order by l.order_no nulls last, p.full_name`;
  return { fixture_id: fixtureId, entrant_id: entrantId, slots };
}

export interface EventOut {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: string;
  recorded_by: string | null;
  voids_event_id: string | null;
  /** Doc 13 §7 attribution rider — lets the pad offer undo-own only. */
  device_link_id: string | null;
}

/** Ledger read: events after `sinceSeq` (the 409-recovery resync, doc 08 §4). */
export async function listEvents(auth: AuthCtx, fixtureId: string, sinceSeq: number): Promise<EventOut[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx`select 1 from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    return tx<EventOut[]>`
      select id, seq, type, payload, recorded_at, recorded_by, voids_event_id, device_link_id
      from score_events
      where fixture_id = ${fixtureId} and seq > ${sinceSeq}
      order by seq`;
  });
}

/** Activity attribution: recorded_by → display name for a fixture's ledger.
 *  The ids come from the tenant-scoped ledger read; `users` has no org RLS,
 *  so the name lookup runs on the root client (same pattern as the org
 *  members list). */
export async function eventRecorderNames(
  auth: AuthCtx,
  fixtureId: string,
): Promise<Record<string, string>> {
  const ids = await withTenant(
    auth.orgId,
    (tx) => tx<{ recorded_by: string }[]>`
      select distinct recorded_by from score_events
      where fixture_id = ${fixtureId} and recorded_by is not null`,
  );
  if (ids.length === 0) return {};
  const users = await sql<{ id: string; display_name: string | null; email: string }[]>`
    select id, display_name, email from users
    where id in ${sql(ids.map((r) => r.recorded_by))}`;
  return Object.fromEntries(users.map((u) => [u.id, u.display_name ?? u.email]));
}

export interface FixtureStateOut {
  fixture_id: string;
  status: string;
  last_seq: number;
  summary: unknown;
  state: unknown;
  outcome: unknown;
}

/** The `/state` ETag: a digest of the body the route serves (scorer sheets,
 *  Task 6). It was the ledger seq alone, and a body change that appends no
 *  event — a status flip, an outcome, a re-folded summary — then revalidated
 *  to `304`, so the browser's HTTP cache kept handing the pad the stale body.
 *  Hashing the body itself means nothing the client can read moves without the
 *  validator moving too, and nobody has to remember to list a new field here.
 *  The body is built field by field in `getFixtureState` and jsonb columns
 *  parse to a stable key order, so equal bodies serialise identically. */
export function fixtureStateEtag(state: FixtureStateOut): string {
  return `"st-${createHash("sha256").update(JSON.stringify(state)).digest("base64url").slice(0, 27)}"`;
}

/** Live state: fold cache summary + status + outcome (ETag: `fixtureStateEtag`). */
export async function getFixtureState(auth: AuthCtx, fixtureId: string): Promise<FixtureStateOut> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      { status: string; outcome: unknown; last_seq: number | null; state: unknown; summary: unknown }[]
    >`
      select f.status, f.outcome, m.last_seq, m.state, m.summary
      from fixtures f left join match_states m on m.fixture_id = f.id
      where f.id = ${fixtureId}`;
    if (!row) throw new HttpError(404, "fixture not found");
    // `CricketState.margin` is `{ kind, value? }` in every stored fold (greenfield:
    // no legacy English margins are stored), so the rows are served as they are.
    return {
      fixture_id: fixtureId,
      status: row.status,
      last_seq: row.last_seq ?? 0,
      summary: row.summary ?? null,
      state: row.state ?? null,
      outcome: row.outcome,
    };
  });
}

/** PROMPT-62 — ScoreSummary.headline per fixture (from match_states) for the
 *  bracket panel's node scores. One query per division render. */
export async function listFixtureHeadlines(
  auth: AuthCtx,
  divisionId: string,
): Promise<Record<string, string>> {
  const rows = await withTenant(auth.orgId, (tx) =>
    tx<{ fixture_id: string; headline: string | null }[]>`
      select ms.fixture_id, ms.summary->>'headline' as headline
      from match_states ms
      join fixtures f on f.id = ms.fixture_id
      where f.division_id = ${divisionId}`,
  );
  return Object.fromEntries(
    rows.filter((r) => r.headline !== null).map((r) => [r.fixture_id, r.headline as string]),
  );
}

// ---------------------------------------------------------------------------
// Signed per-match audit ledger (PROMPT-63). score_events is append-only and
// hash-chained per fixture (V226: trg_zhash BEFORE INSERT sets prev_hash /
// row_hash; verify_score_events_chain(fixture) returns the first tampered row
// id or NULL). This read surfaces the WHOLE stream with the chain columns +
// the verifier verdict; the route signs head_hash (audit-sign.ts).
// ---------------------------------------------------------------------------

/** The exact V226 canonical recipe, documented so an independent verifier can
 *  re-walk the chain (payload::text must be the stored Postgres serialisation;
 *  the Ed25519 signature is the primary cross-system proof). */
export const AUDIT_CANONICAL_SPEC =
  "row_hash = sha256(coalesce(prev_hash,'') || '|' || concat_ws('|', id, fixture_id, seq, type, payload::text, coalesce(voids_event_id::text,''), coalesce(recorded_by::text,''), recorded_at))";

export interface AuditLedgerEvent {
  seq: number;
  type: string;
  payload: unknown;
  recorded_by: string | null;
  recorded_at: string;
  voids_event_id: string | null;
  prev_hash: string | null;
  row_hash: string;
}

export interface AuditLedger {
  fixture: {
    id: string;
    division_id: string;
    fixture_no: number | null;
    home: string | null;
    away: string | null;
    status: string;
  };
  canonical_spec: string;
  events: AuditLedgerEvent[];
  head_hash: string | null;
  verified: boolean;
  first_tampered_seq: number | null;
}

export async function readAuditLedger(auth: AuthCtx, fixtureId: string): Promise<AuditLedger> {
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<
      {
        id: string; division_id: string; fixture_no: number | null; status: string;
        home_entrant_id: string | null; away_entrant_id: string | null;
      }[]
    >`
      select id, division_id, fixture_no, status, home_entrant_id, away_entrant_id
      from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    const names = await tx<{ id: string; display_name: string }[]>`
      select id, display_name from entrants
      where id in (${fixture.home_entrant_id ?? null}, ${fixture.away_entrant_id ?? null})`;
    const nameById = new Map(names.map((n) => [n.id, n.display_name]));
    const events = await tx<AuditLedgerEvent[]>`
      select seq, type, payload, recorded_by, recorded_at, voids_event_id, prev_hash, row_hash
      from score_events where fixture_id = ${fixtureId} order by seq`;
    const [{ bad }] = await tx<{ bad: string | null }[]>`
      select verify_score_events_chain(${fixtureId})::text as bad`;
    let firstTamperedSeq: number | null = null;
    if (bad !== null) {
      const [row] = await tx<{ seq: number }[]>`
        select seq from score_events where id = ${bad}`;
      firstTamperedSeq = row?.seq ?? null;
    }
    return {
      fixture: {
        id: fixture.id,
        division_id: fixture.division_id,
        fixture_no: fixture.fixture_no,
        home: fixture.home_entrant_id ? (nameById.get(fixture.home_entrant_id) ?? null) : null,
        away: fixture.away_entrant_id ? (nameById.get(fixture.away_entrant_id) ?? null) : null,
        status: fixture.status,
      },
      canonical_spec: AUDIT_CANONICAL_SPEC,
      events,
      head_hash: events.length > 0 ? events[events.length - 1]!.row_hash : null,
      verified: bad === null,
      first_tampered_seq: firstTamperedSeq,
    };
  });
}
