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
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { resolvePersonDisplayName, anyOptedOut } from "@/lib/name-display";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { readPublicLineups } from "./public-lineups";
import { buildMatchCentre, type MatchCentreInput } from "./match-centre";
import type { MatchCentreDocT, SideT } from "./match-centre-schema";
import type { PublicFixture } from "./data";

type Sql = ReturnType<typeof postgres>;

export interface MatchCentreLoadDivision {
  sportKey: string;
  moduleVersion: string;
  /** The division's own variant/format key, printed verbatim as the Info
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
 * A `Side.short` abbreviation — 3 characters, clamped (Task 6 contract note:
 * "Side.short is clamped to 3 characters by the BUILDER; the tile has
 * overflow-hidden"). No `short_name` reaches the public surface today:
 * `team_display_v` HAS one (`teams.short_name`/`clubs.short_name`), but
 * `public_entrants_v`'s `team_display` block (V350) selects only
 * `club_id`/`club_name`/`logo_path`/`colors` — never `short_name` — and
 * widening that view is a wider blast radius than this task owns. Derived
 * here from the (already masked) display name instead; re-pin for W2 if a
 * real club/team abbreviation is wanted on the wire.
 */
function shortNameOf(name: string): string {
  const compact = name.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
  return compact.length > 0 ? compact.slice(0, 3) : "?";
}

/** Home/away `Side`s. Handles the bye/TBD case (an entrant id still null —
 *  the same state the fixture page already renders via `resolveSlotLabel`)
 *  without throwing: `buildMatchCentre`'s `MatchCentreHeader.sides` is a
 *  non-nullable tuple, so a scheduled-but-unfilled fixture still needs two
 *  real `Side` objects, never a null program crash. */
async function loadSides(
  sql: Sql,
  fixture: Pick<PublicFixture, "home_entrant_id" | "away_entrant_id" | "home_slot_label" | "away_slot_label">,
  division: { youth: boolean; playerNameDisplay: string | null },
  slotLabelLookup: SlotLabelLookup,
): Promise<[SideT, SideT]> {
  const ids = [fixture.home_entrant_id, fixture.away_entrant_id].filter(
    (id): id is string => id !== null,
  );
  const rows =
    ids.length > 0
      ? await sql<
          {
            id: string;
            kind: string;
            display_name: string;
            badge_url: string | null;
            team_display: { logo_path: string | null; colors: unknown } | null;
          }[]
        >`
          select id, kind, display_name, badge_url, team_display
          from public_entrants_v where id in ${sql(ids)}`
      : [];
  const maskedNames = rows.length > 0 ? await maskSideNames(sql, rows, division) : new Map<string, string>();
  const byId = new Map(rows.map((r) => [r.id, r]));

  const sideOf = (entrantId: string | null, slotLabel: SlotLabel | null): SideT => {
    if (entrantId === null) {
      const name = resolveSlotLabel(slotLabel, slotLabelLookup, "schedule.tbd");
      return { entrantId: "", name, short: shortNameOf(name), colour: null, badgeUrl: null };
    }
    const row = byId.get(entrantId);
    // Defensive fallback (contract notes: "never a blank row") — an
    // entrant a stale ledger/lineup reference names but the view no longer
    // returns (deleted, or its division/competition dropped out of
    // public/unlisted visibility since the fixture was scored).
    if (!row) return { entrantId, name: "?", short: "?", colour: null, badgeUrl: null };
    const name = maskedNames.get(entrantId) ?? row.display_name;
    const colors = row.team_display?.colors as { home_primary?: string } | null | undefined;
    return {
      entrantId,
      name,
      short: shortNameOf(name),
      // Ruling 15 — `team_display_v.colors.home_primary`, never `.primary`
      // (a key nothing writes). Passed through as data; the tile rendering
      // ladder belongs to W2.
      colour: colors?.home_primary ?? null,
      badgeUrl: resolveEntrantBadge({ badge_url: row.badge_url, team_logo_path: row.team_display?.logo_path ?? null }),
    };
  };

  return [sideOf(fixture.home_entrant_id, fixture.home_slot_label), sideOf(fixture.away_entrant_id, fixture.away_slot_label)];
}

/**
 * The one loader both call sites share. Loads (in order): the event ledger
 * (the SAME query `foldFixture` uses, `engine-db/fold.ts:65-68` — `select
 * id, seq, type, payload, recorded_at, recorded_by, voids_event_id from
 * score_events where fixture_id = $1 order by seq`, never a second
 * ordering), the frozen config snapshot (`resolveFixtureCfg`, the same
 * resolver `append-event.ts`/`fold.ts` use — never `configSchema.parse({})`
 * as a fallback, a recorded false premise: it throws), the consent-resolved
 * lineups (`readPublicLineups`, Task 5) and the two `Side`s, then calls the
 * pure `buildMatchCentre`.
 *
 * `resolveVoids` runs ONCE here, before either sport branch sees the
 * stream. `foldMatch` (the fold `foldFixture` itself uses) and
 * `buildTimeline` (the non-cricket branch inside `buildMatchCentre`) both
 * already call `resolveVoids` internally — idempotent on an
 * already-resolved stream, so this is a no-op for them — but
 * `deriveCricketScorecard` (the cricket branch) has NO void resolution of
 * its own (verified by reading `scorecard.ts`: it folds `events` directly
 * through `cricket.apply`, one event at a time, with no `resolveVoids` call
 * anywhere in the function). Resolving here once, before the branch, is the
 * one place that gap can be closed without touching the frozen builder —
 * flagged in the report as a finding for whoever owns that file next.
 */
export async function loadMatchCentre(
  sql: Sql,
  fixture: PublicFixture,
  ctx: MatchCentreLoadCtx,
): Promise<MatchCentreDocT> {
  const eventRows = await sql<
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
    from score_events where fixture_id = ${fixture.id} order by seq`;
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

  const [fixtureRow] = await sql<{ config_snapshot: unknown }[]>`
    select config_snapshot from fixtures where id = ${fixture.id}`;
  const [divisionRow] = await sql<{ config: unknown }[]>`
    select config from divisions where id = ${fixture.division_id}`;
  const [stageRow] = await sql<{ config: Record<string, unknown> | null }[]>`
    select config from stages where id = ${fixture.stage_id}`;
  const rawCfg = resolveFixtureCfg(fixtureRow?.config_snapshot, divisionRow?.config, stageRow?.config);

  const sportModule =
    ctx.division.moduleVersion !== null
      ? resolveModule(ctx.division.sportKey, ctx.division.moduleVersion)
      : resolveLatestModule(ctx.division.sportKey);
  // Resolved module's own configSchema — "the same cfg the pad scored
  // with" (contract notes), normalising a frozen snapshot taken under an
  // older schema version rather than trusting the raw jsonb shape as-is.
  const cfg = sportModule.configSchema.parse(rawCfg);

  const lineups = await readPublicLineups(sql, fixture.id, {
    youth: ctx.division.youth,
    player_name_display: ctx.division.playerNameDisplay,
  });
  const sides = await loadSides(
    sql,
    fixture,
    { youth: ctx.division.youth, playerNameDisplay: ctx.division.playerNameDisplay },
    ctx.slotLabelLookup,
  );
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
    formatLabel: ctx.division.formatLabel,
  };
  return buildMatchCentre(input);
}
