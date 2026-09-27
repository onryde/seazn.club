import "server-only";
// Spectator surface W1, Task 9 — the ONE loader that turns a public fixture
// row into the `MatchCentreDocT` document, used by BOTH the poll endpoint
// (`GET /api/v1/public/fixtures/{id}`, usecase `publicFixture`) and the page
// data loader (`getPublicFixture`). Kept as a SIBLING of `match-centre.ts`
// rather than folded into it: `buildMatchCentre` is pure (no DB, no clock
// other than `input.now` — see that file's own header comment), and this
// file is the opposite of that on purpose (real queries, real `Date.now()`)
// so the pure builder stays trivially unit-testable without a database.
//
// Deliberately does NOT import from `./data` at the VALUE level (only a
// type-only `PublicFixture` import, erased at compile time) — `data.ts`
// imports `loadMatchCentre` FROM this file, so a value-level import back
// would be a real module cycle. `maskSideNames` below is a small,
// intentional duplicate of `maskPublicEntrantNames`'s non-team branch
// (`data.ts`) for exactly that reason — see its own doc comment.
import type postgres from "postgres";
import { resolveVoids, type EventEnvelope } from "@seazn/engine/core";
import { resolveModule, resolveLatestModule } from "@/server/engine-db/registry";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { resolveVenueTz } from "@/lib/tz";
import { disambiguatedShorts } from "@/lib/public-site";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { resolvePersonDisplayName, anyOptedOut } from "@/lib/name-display";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import { getDictionary, toLocale } from "@/lib/i18n";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { publicRoundNamer } from "./feeder-slot-label";
import { readPublicLineups } from "./public-lineups";
import { buildMatchCentre, type MatchCentreInput } from "./match-centre";
import { rulesLineText } from "@/lib/rules-line";
import { effectiveRulesLine } from "./describe-rules";
import type { MatchCentreDocT, SideT } from "./match-centre-schema";
import type { PublicFixture } from "./data";

type Sql = ReturnType<typeof postgres>;

export interface MatchCentreLoadDivision {
  sportKey: string;
  moduleVersion: string;
  /** T16b fix round 3: both loaders now pass `variantLabel(...)` here — the
   *  dictionary's word for an engine-declared variant, in the org's locale,
   *  the stored catalog name only for a variant the map lacks. The history
   *  below predates that.
   *
   *  2026-09-24: this is the PRESET name, and `loadMatchCentre` uses it only
   *  when the fixture plays the division's own rules. A fixture whose stage
   *  overrides them (or whose frozen snapshot differs) in a way the describer
   *  can SAY is labelled with its effective rules instead
   *  (`describe-rules.ts`), decided in the loader so the page and the poll
   *  cannot disagree.
   *
   *  The division's own variant/format key, printed verbatim as the Info
   *  tab's "format" row (fix round 1 ruling — `match-centre.ts`'s own doc
   *  comment on `MatchCentreInput.formatLabel`). No shared "described
   *  format" labeller exists on the public surface today (grepped
   *  `server/public-site/**`/`components/public-site/**` — nothing named
   *  `describeFormat` or similar; the org-console division chip
   *  (`app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:393`) prints the
   *  SAME raw `variant_key` next to `sport_key`, which is the exact "T20"
   *  bug the contract notes say not to copy — copying its INPUT, not its
   *  bug, since there is nothing richer to draw on). Re-pin for W2's
   *  `describeFormat` if a fuller label (e.g. resolved from the variant's
   *  own config) is ever wanted. */
  formatLabel: string | null;
  /** `schedule_settings.tz` override for this division, or null. */
  tz: string | null;
  youth: boolean;
  playerNameDisplay: string | null;
}

/** The fixture's division and stage rows as the loader needs them for the
 *  config merge (`resolveFixtureCfg`). `undefined` = no such row. */
export interface MatchCentreConfigRows {
  division: { config: unknown } | undefined;
  stage: { config: Record<string, unknown> | null; kind: string } | undefined;
}

export interface MatchCentreLoadCtx {
  orgTz: string | null;
  division: MatchCentreLoadDivision;
  locale: string;
  hrefs: { division: string; competition: string; calendar: string | null };
  stage: { name: string; roundLabel: string | null } | null;
  /** Resolves a `{key,params}` slot label to display text for a bye/TBD
   *  side (`schedule.tbd` fallback, same convention as the fixture page's
   *  own `home`/`away` resolution) — a plain callback, not `msgFor`
   *  imported directly, so this module never has to resolve a `Locale`
   *  itself (mirrors `lib/slot-label.ts`'s own reasoning for taking a
   *  lookup callback rather than importing a resolver). */
  slotLabelLookup: SlotLabelLookup;
  /** The division and stage rows, when the caller has ALREADY read them
   *  (`publicFixture`'s context read does) — the loader then reads only the
   *  fixture's own snapshot instead of reading both rows a second time.
   *  Absent: the loader reads all three itself, in one statement. */
  configRows?: MatchCentreConfigRows;
}

/**
 * `entrant.display_name` masking for the two match-centre `sides` — a small,
 * deliberate duplicate of `maskPublicEntrantNames`'s non-team branch
 * (`data.ts`), NOT a call to that function: `data.ts` imports
 * `loadMatchCentre` from this file, so importing `maskPublicEntrantNames`
 * back would be a real value-level module cycle (unlike the `PublicFixture`
 * TYPE import above, which is erased at compile time and costs nothing).
 * Team entrants are never masked (same rule, same reason: a team's own
 * declared name carries no consent axis); individual/pair entrants resolve
 * through the ONE shared `resolvePersonDisplayName`, never a second
 * resolver (global constraint).
 */
async function maskSideNames(
  sql: Sql,
  entrants: { id: string; kind: string; display_name: string }[],
  division: { youth: boolean; playerNameDisplay: string | null },
): Promise<Map<string, string>> {
  const nonTeamIds = entrants.filter((e) => e.kind !== "team").map((e) => e.id);
  const consentRows =
    nonTeamIds.length > 0
      ? await sql<{ entrant_id: string; consent: { public_name?: boolean } | null }[]>`
          select em.entrant_id, p.consent
          from entrant_members em
          join persons p on p.id = em.person_id
          where em.entrant_id in ${sql(nonTeamIds)} and p.merged_into is null`
      : [];
  const consentsByEntrant = new Map<string, ({ public_name?: boolean } | null)[]>();
  for (const r of consentRows) {
    const list = consentsByEntrant.get(r.entrant_id) ?? [];
    list.push(r.consent);
    consentsByEntrant.set(r.entrant_id, list);
  }
  const names = new Map<string, string>();
  for (const e of entrants) {
    if (e.kind === "team") {
      names.set(e.id, e.display_name);
      continue;
    }
    const optedOut = anyOptedOut(consentsByEntrant.get(e.id) ?? []);
    names.set(
      e.id,
      resolvePersonDisplayName(
        e.display_name,
        optedOut ? { public_name: false } : null,
        division.playerNameDisplay,
        division.youth,
      ),
    );
  }
  return names;
}

/**
 * A `Side.short` abbreviation — 3 characters for a TEAM (`teamShortOf`), up to
 * `BADGE_MAX_CHARS` for a PERSON, because the disambiguation tie-break appends
 * an ordinal to a 3-character stem (`AND1`/`AND2`). The Task 6 contract note
 * said "clamped to 3 characters by the BUILDER; the tile has overflow-hidden",
 * and that is no longer true of the person branch: the R11 cosmetic round
 * raised the person ceiling to 4 and made the Timeline/Sets chips size to
 * their content. Any consumer that still budgets 3 and clips is relying on a
 * retired contract — `summary-tab.tsx`'s performer chip was one, and was fixed
 * with this note rather than left to clip if a person-entrant sport ever
 * reaches it. No `short_name` reaches the public surface
 * today: `team_display_v` HAS one (`teams.short_name`/`clubs.short_name`),
 * but `public_entrants_v`'s `team_display` block (V350) selects only
 * `club_id`/`club_name`/`logo_path`/`colors` — never `short_name` — and
 * widening that view is a wider blast radius than this task owns. Derived
 * here from the (already masked) display name instead; re-pin for W2 if a
 * real club/team abbreviation is wanted on the wire.
 *
 * R11 fix round, C9 — a PERSON entrant no longer uses this rule alone: two
 * players ("Player One"/"Player Two") both compacted to "PLA" under it, so
 * both sides read identically on the court card. `disambiguatedShorts`
 * (`@/lib/public-site`) resolves BOTH sides together instead, preferring the
 * surname for a person and widening only as far as needed to differ; team
 * entrants keep this exact rule, unconditionally, per the brief ("team
 * entrants keep today's behaviour where it already disambiguates").
 */
interface SidePre {
  entrantId: string;
  name: string;
  colour: string | null;
  badgeUrl: string | null;
  isPerson: boolean;
}

interface SideRow {
  id: string;
  kind: string;
  display_name: string;
  badge_url: string | null;
  team_display: { logo_path: string | null; colors: unknown } | null;
}

/** The two sides' entrant rows and their masked names — the database half of
 *  the sides, read beside the loader's other reads (T4); {@link buildSides}
 *  is the rest. */
async function readSides(
  sql: Sql,
  fixture: Pick<PublicFixture, "home_entrant_id" | "away_entrant_id">,
  division: { youth: boolean; playerNameDisplay: string | null },
): Promise<{ rows: SideRow[]; maskedNames: Map<string, string> }> {
  const ids = [fixture.home_entrant_id, fixture.away_entrant_id].filter(
    (id): id is string => id !== null,
  );
  const rows =
    ids.length > 0
      ? await sql<SideRow[]>`
          select id, kind, display_name, badge_url, team_display
          from public_entrants_v where id in ${sql(ids)}`
      : [];
  const maskedNames = rows.length > 0 ? await maskSideNames(sql, rows, division) : new Map<string, string>();
  return { rows, maskedNames };
}

/** Home/away `Side`s (minus `short`, resolved together below). Handles the
 *  bye/TBD case (an entrant id still null) without throwing: its name is
 *  `slot(label)` — the feeder's round for a side waiting on a match
 *  (`feeder-slot-label.ts`), else the board's `resolveSlotLabel` text. A
 *  bye/TBD slot has no real entrant kind to disambiguate by, so it is treated
 *  as a team for the abbreviation rule, same as before this fix. */
function buildSides(
  fixture: Pick<PublicFixture, "home_entrant_id" | "away_entrant_id" | "home_slot_label" | "away_slot_label">,
  { rows, maskedNames }: { rows: SideRow[]; maskedNames: Map<string, string> },
  slot: (label: SlotLabel | null, seat: "home" | "away") => string,
): [SideT, SideT] {
  const byId = new Map(rows.map((r) => [r.id, r]));

  const sideOf = (
    entrantId: string | null,
    slotLabel: SlotLabel | null,
    seat: "home" | "away",
  ): SidePre => {
    if (entrantId === null) {
      const name = slot(slotLabel, seat);
      return { entrantId: "", name, colour: null, badgeUrl: null, isPerson: false };
    }
    const row = byId.get(entrantId);
    // Defensive fallback (contract notes: "never a blank row") — an
    // entrant a stale ledger/lineup reference names but the view no longer
    // returns (deleted, or its division/competition dropped out of
    // public/unlisted visibility since the fixture was scored).
    if (!row) return { entrantId, name: "?", colour: null, badgeUrl: null, isPerson: false };
    const name = maskedNames.get(entrantId) ?? row.display_name;
    const colors = row.team_display?.colors as { home_primary?: string } | null | undefined;
    return {
      entrantId,
      name,
      // Ruling 15 — `team_display_v.colors.home_primary`, never `.primary`
      // (a key nothing writes). Passed through as data; the tile rendering
      // ladder belongs to W2.
      colour: colors?.home_primary ?? null,
      badgeUrl: resolveEntrantBadge({ badge_url: row.badge_url, team_logo_path: row.team_display?.logo_path ?? null }),
      isPerson: row.kind !== "team",
    };
  };

  const home = sideOf(fixture.home_entrant_id, fixture.home_slot_label, "home");
  const away = sideOf(fixture.away_entrant_id, fixture.away_slot_label, "away");
  // R11 fix round, C9 — resolved TOGETHER, not independently: a collision
  // can only be seen — and broken — by comparing both sides at once.
  const [homeShort, awayShort] = disambiguatedShorts(home, away);

  return [
    { entrantId: home.entrantId, name: home.name, short: homeShort, colour: home.colour, badgeUrl: home.badgeUrl },
    { entrantId: away.entrantId, name: away.name, short: awayShort, colour: away.colour, badgeUrl: away.badgeUrl },
  ];
}

/** The fixture's config snapshot beside its division and stage rows — what
 *  `resolveFixtureCfg` merges. Where the caller already read the division and
 *  stage rows (`configRows`), only the snapshot is read; otherwise all three
 *  come back from ONE statement (they were three before T4). The left joins
 *  hang off a one-row seed so a missing row is `undefined` on its own, exactly
 *  as three separate lookups left it. */
async function readConfigRows(
  sql: Sql,
  fixture: Pick<PublicFixture, "id" | "division_id" | "stage_id">,
  preread: MatchCentreConfigRows | undefined,
): Promise<MatchCentreConfigRows & { fixture: { config_snapshot: unknown } | undefined }> {
  if (preread) {
    const [fixtureRow] = await sql<{ config_snapshot: unknown }[]>`
      select config_snapshot from fixtures where id = ${fixture.id}`;
    return { fixture: fixtureRow, ...preread };
  }
  const [row] = await sql<
    {
      fixture_row: string | null;
      config_snapshot: unknown;
      division_row: string | null;
      division_config: unknown;
      stage_row: string | null;
      stage_config: Record<string, unknown> | null;
      stage_kind: string | null;
    }[]
  >`
    select f.id as fixture_row, f.config_snapshot,
           d.id as division_row, d.config as division_config,
           s.id as stage_row, s.config as stage_config, s.kind as stage_kind
    from (select 1) as seed
    left join fixtures f  on f.id = ${fixture.id}
    left join divisions d on d.id = ${fixture.division_id}
    left join stages s    on s.id = ${fixture.stage_id}`;
  return {
    fixture: row?.fixture_row == null ? undefined : { config_snapshot: row.config_snapshot },
    division: row?.division_row == null ? undefined : { config: row.division_config },
    stage: row?.stage_row == null ? undefined : { config: row.stage_config, kind: row.stage_kind! },
  };
}

/** A stage's rows, as the feeder namer reads them. */
interface FeederRow {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  lane: "WB" | "LB" | "GF" | null;
  is_final: boolean | null;
  third_place: boolean | null;
  conditional: boolean | null;
  ext_key: string | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
}

/**
 * The one loader both call sites share. Reads the event ledger (the SAME
 * query `foldFixture` uses, `engine-db/fold.ts:65-68` — `select id, seq, type,
 * payload, recorded_at, recorded_by, voids_event_id from score_events where
 * fixture_id = $1 order by seq`, never a second ordering), the frozen config
 * snapshot (`resolveFixtureCfg`, the same resolver `append-event.ts`/`fold.ts`
 * use — never `configSchema.parse({})` as a fallback, a recorded false premise:
 * it throws), the consent-resolved lineups (`readPublicLineups`, Task 5), the
 * stage's rows when a seat must be named, and the two `Side`s' entrant rows,
 * then calls the pure `buildMatchCentre`.
 *
 * Those reads do not depend on one another, so they run AT ONCE (T4): one
 * round trip plus the sides' consent read, where there were up to eight in a
 * row, and never more than five pooled connections held (prod runs 12 a
 * machine).
 *
 * `resolveVoids` runs ONCE here, before either sport branch sees the
 * stream. `foldMatch` (the fold `foldFixture` itself uses), `buildTimeline`
 * (the non-cricket branch inside `buildMatchCentre`) and
 * `deriveCricketScorecard` (the cricket branch) all resolve voids
 * internally — idempotent on an already-resolved stream, so this is a no-op
 * for each. It was NOT always so: the scorecard used to replay `events`
 * through `cricket.apply` itself, with no `resolveVoids` call (and threw on
 * every kernel-owned event), and this line was written to close that gap.
 * The scorecard now rides `foldMatch` (`FoldOptions.onFolded`); the call
 * stays because it is free and keeps every branch reading one stream.
 */
export async function loadMatchCentre(
  sql: Sql,
  fixture: PublicFixture,
  ctx: MatchCentreLoadCtx,
): Promise<MatchCentreDocT> {
  // Fix round N1 — a side waiting on a match names that match's ROUND the way
  // the hub's Knockout rail does ("Winner of Semi-finals, match 2", or "Winner
  // of Grand final" when that round holds one match), never the organiser
  // board's "R1·2" short code. The words come from `publicRoundNamer`, the SAME
  // namer the hub builds its cards and rail with, over THIS fixture's stage's
  // rows; anything that is not a feeder label, or names no match of the stage,
  // keeps today's text. `ext_key` is read the way `getPublicDivision` reads it
  // (a page playoff's rounds are told apart by it — fix round 1, M3).
  //
  // Fix round 1, M7: the sides name only a side whose entrant is still null,
  // so a fixture with both entrants set (every live and finished match) reads
  // neither the stage's rows nor the dictionary; its `slot` is today's text,
  // never asked for.
  const seatToName = fixture.home_entrant_id === null || fixture.away_entrant_id === null;
  const readFeeders = async () =>
    Promise.all([
      // The feed edges, by the same rule as ext_key: not columns of the view,
      // read off fixtures by the VIEW row's own id, in one fenced LATERAL
      // probe per row (see readPublicDivisionDetail, data.ts, on the offset
      // 0). This read is stage-scoped, which is enough for the shape that
      // needs it — a setup bracket's final, fed by its own semis.
      // (No backticks in here: this is inside a tagged template.)
      sql<FeederRow[]>`
        select v.id, v.stage_id, v.round_no, v.seq_in_round, v.lane, v.is_final, v.third_place, v.conditional,
               e.ext_key, e.winner_to_fixture, e.winner_to_slot, e.loser_to_fixture, e.loser_to_slot
        from public_fixtures_v v
        left join lateral (
          select x.ext_key, x.winner_to_fixture, x.winner_to_slot, x.loser_to_fixture, x.loser_to_slot
          from fixtures x where x.id = v.id
          offset 0
        ) e on true
        where v.stage_id = ${fixture.stage_id}`,
      getDictionary(toLocale(ctx.locale), "public"),
    ]);
  const [eventRows, configRows, lineups, feeders, sideRead] = await Promise.all([
    sql<
      {
        id: string;
        seq: number;
        type: string;
        payload: unknown;
        recorded_at: Date;
        recorded_by: string | null;
        voids_event_id: string | null;
      }[]
    >`
      select id, seq, type, payload, recorded_at, recorded_by, voids_event_id
      from score_events where fixture_id = ${fixture.id} order by seq`,
    readConfigRows(sql, fixture, ctx.configRows),
    readPublicLineups(sql, fixture.id, {
      youth: ctx.division.youth,
      player_name_display: ctx.division.playerNameDisplay,
    }),
    seatToName ? readFeeders() : null,
    readSides(sql, fixture, { youth: ctx.division.youth, playerNameDisplay: ctx.division.playerNameDisplay }),
  ]);

  const envelopes: EventEnvelope[] = eventRows.map((r) => ({
    id: r.id,
    fixtureId: fixture.id,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    recordedAt: r.recorded_at.toISOString(),
    recordedBy: r.recorded_by,
    ...(r.voids_event_id ? { voids: r.voids_event_id } : {}),
  }));
  const events = resolveVoids(envelopes);

  const rawCfg = resolveFixtureCfg(
    configRows.fixture?.config_snapshot,
    configRows.division?.config,
    configRows.stage?.config,
  );

  const sportModule =
    ctx.division.moduleVersion !== null
      ? resolveModule(ctx.division.sportKey, ctx.division.moduleVersion)
      : resolveLatestModule(ctx.division.sportKey);
  // Resolved module's own configSchema — "the same cfg the pad scored
  // with" (contract notes), normalising a frozen snapshot taken under an
  // older schema version rather than trusting the raw jsonb shape as-is.
  //
  // safeParse, NOT parse, and the difference is a 500 on a public page.
  // `parse` here was STRICTER THAN THE PRODUCTION READ PATH: `fold.ts`
  // hands `resolveFixtureCfg`'s output to `foldMatch` unparsed, and
  // `module.init` takes the raw cfg, so every module already tolerates a
  // config this schema rejects. `fixture-cfg.ts` says so outright — "`{}`
  // is a legitimate config for several modules" — and a division row whose
  // `config` is `{}` (no `resultMode`, no `allowDraws`) reaches exactly
  // that. Throwing took down the WHOLE `publicFixture` response, not just
  // the match centre, because this loader runs inside it.
  //
  // Found by the task-16 gate: `public-court-venue-names.test.ts` passed on
  // `origin/main` and failed here, and it failed because Task 9 wired this
  // loader into `usecases/public.ts` — the test's own division is a plain
  // `'{}'` insert it has always used. Falling back to `rawCfg` is not a
  // shrug: it is precisely what the read fold does with the same value, so
  // the worst case is parity with the rest of the app rather than a crash.
  const parsedCfg = sportModule.configSchema.safeParse(rawCfg);
  const cfg = parsedCfg.success ? parsedCfg.data : rawCfg;

  // Per-stage match rules (brief 2026-09-24): the division's preset name is the
  // wrong label for a fixture whose STAGE overrides the format — prod printed
  // "Short (11 points)" over a Best-of-1 to 15. Decided HERE, from the same
  // `rawCfg` the fixture is scored against, because both loaders (the page's
  // `getPublicFixture` and the poll's `publicFixture`) flow through this one
  // function; deciding it in either caller would let the two disagree on every
  // poll. When the effective rules match the division's, the caller's preset
  // name stands unchanged. The line is resolved in the ORG's locale
  // (`ctx.locale`), exactly as the preset name it replaces is — through the
  // PUBLIC dictionary, where the describer's keys live so the hub can resolve
  // the same clauses client-side — and joined by the one `rulesLineText`.
  const rulesLine = effectiveRulesLine(ctx.division.sportKey, sportModule, rawCfg, configRows.division?.config);
  const formatLabel =
    rulesLine === null
      ? ctx.division.formatLabel
      : rulesLineText(await getDictionary(toLocale(ctx.locale), "public"), rulesLine);

  // Annotated rather than inferred so the fallback can simply IGNORE the seat
  // (a narrower function is assignable) instead of naming a parameter it never
  // reads, which lint calls out.
  let slot: (label: SlotLabel | null, seat: "home" | "away") => string = (label) =>
    resolveSlotLabel(label, ctx.slotLabelLookup, "schedule.tbd");
  if (feeders) {
    const [stageRows, dict] = feeders;
    const namer = publicRoundNamer({
      ui: ctx.slotLabelLookup,
      dict,
      fixtures: stageRows,
      // The stage row exists for every fixture (a foreign key); undefined only
      // when the read found none, and then nothing is named.
      stageKind: () => configRows.stage?.kind,
    });
    // `seat`, not `slot` — see `publicRoundNamer.seat`. The match centre is
    // where a spectator lands from a share link, so a bracket seat reading
    // "TBD" here is the most visible copy of this defect.
    slot = (label, seat) => namer.seat(fixture.id, seat, label);
  }
  const sides = buildSides(fixture, sideRead, slot);
  const venueTz = resolveVenueTz(ctx.division.tz, ctx.orgTz);

  const input: MatchCentreInput = {
    fixture,
    sportKey: ctx.division.sportKey,
    cfg,
    events,
    lineups,
    sides,
    venueTz,
    locale: ctx.locale,
    now: new Date(),
    hrefs: ctx.hrefs,
    stage: ctx.stage,
    moduleVersion: ctx.division.moduleVersion,
    formatLabel,
  };
  return buildMatchCentre(input);
}
