import "server-only";
// Division use-cases (doc 08 §3, doc 06). Creation snapshots the merged
// variant config and PINS the sport module version (doc 02 §4) so a running
// division always replays under the rules it started with.
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { assertWithinLimit, getLimit, requireFeature, passLockReason } from "@/lib/entitlements";
import { EngineError } from "@seazn/engine/core";
import { effectiveEntrantModel, type EntrantKind } from "@seazn/engine/sport";
import { resolveModule } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  AGE_MAX_BEFORE_MIN,
  AGE_CUTOFF_BOTH_OR_NEITHER,
  type CreateDivision,
  type PatchDivision,
} from "@/server/api-v1/schemas";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
import {
  slugify,
  withUniqueSlug,
  SLUG_CONSTRAINT,
  recordSlugHistory,
  RESERVED_ENTITY_SLUGS,
} from "./slugs";
import { invalidateSlugCache } from "@/server/slug-resolve";
// D5/P8: same trim/lowercase/dedupe/drop-empties rule the courts path uses
// for their own `tags` — one copy, imported, not re-implemented (a court
// tagged "clay" must match a division requiring "Clay").
import { normalizeTags } from "./venues";

export interface DivisionRow {
  id: string;
  competition_id: string;
  name: string;
  slug: string;
  /** Markdown (v3/06 §2), rendered on the public division page. */
  description: string | null;
  sport_key: string;
  variant_key: string;
  config: unknown;
  module_version: string;
  tiebreakers: string[] | null;
  /** V364/V380 first-class eligibility columns — the ONE eligibility
   *  representation (RS007/V380 dropped the jsonb `eligibility` column this
   *  comment used to say "read alongside"); see
   *  registration-eligibility.ts's EligibilityDivision. */
  category: string | null;
  age_min: number | null;
  age_max: number | null;
  /** RS007/V380: both-or-neither (DB CHECK `divisions_age_cutoff_check`).
   *  Null defaults to 1 January of the season-start year
   *  (registration-rules.ts's `ageBandEligibilityIssues`). */
  age_cutoff_month: number | null;
  age_cutoff_day: number | null;
  /** RS007/V380: the retired jsonb "custom rule" note, now a first-class
   *  column the public entry/join pages render as a warning. */
  eligibility_note: string | null;
  status: string;
  officials_hide_names: boolean;
  scheduling_mode: string;
  auto_progress: boolean;
  /** SPEC-2: draft a news post when results land in this division. */
  auto_posts: boolean;
  schedule_locked: boolean;
  archived_at: string | null;
  created_at: string;
  /** Division event-ledger head — the board's optimistic token (gap 10). */
  seq: number;
  /** Youth privacy (v3/11 gap 8): auto from U-age eligibility, overridable. */
  youth: boolean;
  player_name_display: "full" | "first_initial" | null;
  /** Card identity (V274, v8): uploaded logo; null → monogram tile. */
  logo_url: string | null;
  logo_storage_path: string | null;
  /** D5/P8 candidate-court filter (V367): tags ⊇ required_court_tags, empty
   *  = any court. CRUD lives here; the READ path that actually FILTERS a
   *  candidate set is P9 pass 2b's `usecases/court-candidates.ts`
   *  (`resolveCandidateCourts`/`unionRequiredCourtTags`), unioned with
   *  `stages.required_court_tags` (the sibling V367 column, wired the same
   *  pass — CRUD for the stage side still does not exist). */
  required_court_tags: string[];
}

const COLS = [
  "id", "competition_id", "name", "slug", "description", "sport_key", "variant_key", "config",
  "module_version", "tiebreakers", "category", "age_min", "age_max", "age_cutoff_month",
  "age_cutoff_day", "eligibility_note", "status",
  "officials_hide_names", "scheduling_mode", "auto_progress", "auto_posts", "schedule_locked",
  "archived_at", "created_at", "seq", "youth", "player_name_display", "logo_url",
  "logo_storage_path", "required_court_tags",
] as const;

/** Variant choices for the Settings tab's format editor (v8) — system
 *  presets plus this org's own, deduped per key (org's wins). */
export async function listVariantOptions(
  auth: AuthCtx,
  sportKey: string,
): Promise<{ key: string; name: string }[]> {
  return withTenant(auth.orgId, (tx) =>
    tx<{ key: string; name: string }[]>`
      select distinct on (key) key, name from sport_variants
      where sport_key = ${sportKey}
      order by key, org_id nulls last`,
  );
}

/**
 * U-anything eligibility (age_max below 18) marks a division youth. RS007/
 * V380 repoints this at the first-class `age_max` column — the ONE place
 * `youth` derives from now, replacing three prior derivations (this
 * function's old jsonb-scanning body, its INSERT-time call below, and its
 * PATCH-time re-derive) plus a fourth, independent raw-SQL recompute in
 * `settings/page.tsx` that now just reads the `youth` column directly.
 */
export function deriveYouth(ageMax: number | null): boolean {
  return ageMax != null && ageMax < 18;
}

export async function listDivisions(
  auth: AuthCtx,
  competitionId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<DivisionRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx`select 1 from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    // Archived divisions are hidden from the console (v3/09 §4) — only the
    // competition-settings "Archived divisions" list asks for them.
    return tx<DivisionRow[]>`
      select ${tx(COLS)} from divisions
      where competition_id = ${competitionId}
      ${opts.includeArchived ? tx`` : tx`and archived_at is null`}
      order by created_at, id`;
  });
}

/**
 * A finished competition does not grow (#376 branch, part D).
 *
 * `assertCompetitionNotFrozen` checks the over-quota freeze and says nothing
 * about status, so a completed or archived competition accepted new divisions.
 * Not a quota leak — the per-competition cap still binds — but it made
 * "completed" mean nothing, and it contradicted the same competition being
 * refused an Event Pass.
 *
 * TERMINAL ONLY. `past_ends_on` must keep accepting writes: that arm is
 * routinely a stale end date on a competition still being played, which is why
 * the pass chip points that organiser at the settings form. The pass line and
 * the write line share a vocabulary, not a threshold.
 *
 * Takes the CALLER'S tx: the status it refuses on must be the one the insert
 * would have run against, and a read outside the transaction could see a
 * different snapshot.
 */
async function assertCompetitionNotEnded(tx: postgres.TransactionSql, competitionId: string) {
  const [comp] = await tx<{ status: string; ends_on: Date | string | null }[]>`
    select status, ends_on from competitions where id = ${competitionId}`;
  if (comp && passLockReason(comp.status, comp.ends_on) === "terminal") {
    throw new HttpError(
      409,
      "This competition is finished, so no new divisions can be added to it",
      "COMPETITION_ENDED",
    );
  }
}

/** Activation funnel (feature 1): step after competition_created. Exported
 *  so createFromTemplate (usecases/templates.ts, D1a) can fire the SAME
 *  event, with the SAME shape, after ITS OWN transaction commits — see
 *  fireCompetitionCreated's comment in usecases/competitions.ts for why this
 *  needs to exist at all (P4 review 2026-08-13 finding 1). */
export async function fireDivisionCreated(
  auth: AuthCtx,
  sportKey: string,
  competitionId: string,
): Promise<void> {
  await captureServer({
    event: EVENTS.DIVISION_CREATED,
    distinctId: auth.userId ?? `org:${auth.orgId}`,
    orgId: auth.orgId,
    properties: { sport_key: sportKey, competition_id: competitionId },
  });
}

export async function createDivision(
  auth: AuthCtx,
  competitionId: string,
  input: CreateDivision,
): Promise<DivisionRow> {
  // OUTSIDE the transaction: the freeze lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. An unknown competition is never a
  // member of the frozen set, so the entity's own 404 still fires first.
  await assertCompetitionNotFrozen(auth.orgId, competitionId);
  // The plan LOOKUP is resolved out here; the COUNT stays inside the
  // transaction with the insert (doc 10 §2 rule 1). `getLimit` queries the
  // pooled `sql` proxy, and `withTenant` pins a pooled connection for its whole
  // callback — see `assertWithinLimit` in lib/entitlements.ts.
  const divisionCap = await getLimit(
    auth.orgId,
    "divisions.per_competition.max",
    competitionId,
  );

  const row = await withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx`select 1 from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    await assertCompetitionNotEnded(tx, competitionId);

    // Doc 10 §1: `divisions.per_competition.max` (Community's real bite: 4 —
    // V270 set 2, V319 raised it). Counted in the same tx as the insert
    // (doc 10 §2 rule 1).
    //
    // An archived division still counts once it has RECORDED RESULTS. Archiving
    // used to free the slot unconditionally, which made create → play → archive
    // → create an unlimited-divisions loop inside one competition: archive was
    // a delete that skipped delete's own DIVISION_HAS_RESULTS guard and got the
    // slot back as well. An UNPLAYED division archived still frees its slot, so
    // fixing a division configured with the wrong sport stays free.
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from divisions d
      where d.competition_id = ${competitionId}
        and (d.archived_at is null
             or (division_has_results(d.id) and d.slot_waived_at is null))`;
    assertWithinLimit(divisionCap, "divisions.per_competition.max", n + 1);

    // Sport catalog carries the latest shipped module version; the division
    // pins it now and forever (doc 02 §4).
    const [sport] = await tx<{ module_version: string }[]>`
      select module_version from sports where key = ${input.sport_key}`;
    if (!sport) throw new HttpError(422, `unknown sport '${input.sport_key}'`);

    // Variant preset: system (org_id null) or this org's own (RLS scopes it).
    const [variant] = await tx<{ config: Record<string, unknown> }[]>`
      select config from sport_variants
      where sport_key = ${input.sport_key} and key = ${input.variant_key}
      order by org_id nulls last limit 1`;
    if (!variant) {
      throw new HttpError(422, `unknown variant '${input.variant_key}' for ${input.sport_key}`);
    }

    // Merge preset + overrides, then validate the snapshot through the pinned
    // module's own schema — an invalid config never reaches the DB.
    const sportModule = resolveModule(input.sport_key, sport.module_version);
    const merged = { ...variant.config, ...input.config };
    const parsed = sportModule.configSchema.safeParse(merged);
    if (!parsed.success) {
      throw new EngineError("CONFIG_INVALID", `invalid ${input.sport_key} config`, {
        issues: parsed.error.issues,
      });
    }

    // Shared by both slug paths so the generated one can be RETRIED against
    // the unique index — `q` is the savepoint, and replaces `tx` inside it.
    const insert = async (slug: string, q: postgres.TransactionSql): Promise<DivisionRow> => {
      // RS007/V380: category/age_min/age_max/age_cutoff_month/age_cutoff_day/
      // eligibility_note are writable at create time now — the division-
      // creation wizard's Eligibility tab writes them directly (see
      // schemas.ts's CreateDivision; the registration hub config panel still
      // edits the SAME columns via PATCH, which stays the only path for an
      // already-created division). `??`, not the schema's own `undefined`,
      // because postgres.js sends a bound JS `undefined` as literal SQL
      // `undefined`, not `null` — every other create-time column here already
      // follows this rule (e.g. `input.tiebreakers ? ... : null` two lines
      // below). `deriveYouth` reads the effective age_max from THIS request —
      // the SAME single derivation patchDivision re-runs on an age_max PATCH,
      // not a second copy (deriveYouth's own doc comment).
      const ageMax = input.age_max ?? null;
      const [row] = await q<DivisionRow[]>`
        insert into divisions (competition_id, name, slug, sport_key, variant_key, config,
                               module_version, tiebreakers, category, age_min, age_max,
                               age_cutoff_month, age_cutoff_day, eligibility_note, youth)
        values (${competitionId}, ${input.name}, ${slug}, ${input.sport_key}, ${input.variant_key},
                ${q.json(parsed.data as never)}, ${sport.module_version},
                ${input.tiebreakers ? q.json(input.tiebreakers as never) : null},
                ${input.category ?? null}, ${input.age_min ?? null}, ${ageMax},
                ${input.age_cutoff_month ?? null}, ${input.age_cutoff_day ?? null},
                ${input.eligibility_note ?? null}, ${deriveYouth(ageMax)})
        returning ${q(COLS)}`;
      return row!;
    };
    // Explicit slugs 409 on collision; generated ones dedupe with "-2"
    // suffixes and skip the reserved "new" (static /d/new route).
    if (input.slug) {
      if (RESERVED_ENTITY_SLUGS.has(input.slug)) {
        throw new HttpError(422, `slug '${input.slug}' is reserved`);
      }
      const [dupe] = await tx`
        select 1 from divisions where competition_id = ${competitionId} and slug = ${input.slug}`;
      if (dupe) {
        throw new HttpError(409, `slug '${input.slug}' is already in use in this competition`);
      }
      return insert(input.slug, tx);
    }
    return withUniqueSlug(
      tx,
      {
        base: slugify(input.name),
        constraint: SLUG_CONSTRAINT.divisions,
        taken: async (s) => {
          const [taken] = await tx`
            select 1 from divisions where competition_id = ${competitionId} and slug = ${s}`;
          return !!taken;
        },
      },
      insert,
    );
  });
  // Activation funnel (feature 1): step after competition_created.
  await fireDivisionCreated(auth, input.sport_key, competitionId);
  return row;
}

export async function getDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<DivisionRow[]>`select ${tx(COLS)} from divisions where id = ${id}`;
    if (!row) throw new HttpError(404, "division not found");
    return row;
  });
}

// ---------------------------------------------------------------------------
// Delete / archive / restore — v3/09 §4 (PROMPT-38). Graduated
// destructiveness: setup divisions hard-delete; started/resulted divisions
// archive (hidden + restorable); archived divisions purge after a 30-day
// cool-off. Owner/admin only (the route enforces the role).
// ---------------------------------------------------------------------------

const PURGE_COOL_OFF_DAYS = 30;

interface DeleteTarget {
  id: string;
  competition_id: string;
  name: string;
  slug: string;
  sport_key: string;
  status: string;
  archived_at: string | null;
}

async function auditCompetition(
  tx: postgres.TransactionSql,
  competitionId: string,
  type: string,
  payload: Record<string, unknown>,
  actorId: string | null,
): Promise<void> {
  await tx`
    insert into competition_events (competition_id, type, payload, actor_id)
    values (${competitionId}, ${type}, ${tx.json(payload as never)}, ${actorId})`;
}

// Open registration blocks delete AND archive: registrants could still be
// paying into a division that is about to vanish (v3/09 §4).
async function assertRegistrationClosed(
  tx: postgres.TransactionSql,
  divisionId: string,
  action: "delete" | "archive",
): Promise<void> {
  const [settings] = await tx<{ enabled: boolean; closes_at: string | null }[]>`
    select enabled, closes_at from registration_settings where division_id = ${divisionId}`;
  const open =
    settings?.enabled === true &&
    (settings.closes_at === null || new Date(settings.closes_at).getTime() > Date.now());
  if (open) {
    throw new HttpError(
      409,
      `Registration is open for this division — close registration first, then ${action} it`,
      "REGISTRATION_OPEN",
    );
  }
}

/**
 * DELETE semantics: setup division (never started, nothing decided) → hard
 * delete; archived ≥30 days → purge (hard delete); anything else → 409
 * DIVISION_HAS_RESULTS with the `{archive: true}` hint. Frozen competitions
 * are NOT blocked: deleting reduces usage, which is the honest way out of an
 * over-quota freeze.
 */
export async function deleteDivision(auth: AuthCtx, id: string): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<DeleteTarget[]>`
      select id, competition_id, name, slug, sport_key, status, archived_at
      from divisions where id = ${id}`;
    if (!division) throw new HttpError(404, "division not found");
    await assertRegistrationClosed(tx, id, "delete");

    // Money records must outlive mistakes (spec 2026-07-12 issue #10): a hard
    // delete cascades the registrations away, so block it while any card
    // payment on this division is not fully refunded. Archive stays open.
    const [{ live_payments }] = await tx<{ live_payments: number }[]>`
      select count(*)::int as live_payments from registrations r
      join registration_groups g on g.id = r.group_id
      where r.division_id = ${id} and g.payment_intent_id is not null
        and g.refunded_cents < g.amount_cents`;
    if (live_payments > 0) {
      throw new HttpError(
        409,
        "Registrations here hold card payments — refund them before deleting, or archive instead",
        "REGISTRATION_PAYMENTS",
        { archive: true },
      );
    }

    // ONE definition of "has recorded results", shared with the quota count in
    // createDivision (V354). The two ask different questions of it — delete
    // refuses, the quota charges — but they must never disagree about the
    // answer, and this repo's recurring defect is exactly a forked copy of one
    // rule. The audit payload keeps a real count, which is not the same
    // question and stays a count.
    const [{ has_results }] = await tx<{ has_results: boolean }[]>`
      select division_has_results(${id}) as has_results`;

    if (division.archived_at !== null) {
      // Purge path: archived divisions hard-delete after the cool-off.
      const ageMs = Date.now() - new Date(division.archived_at).getTime();
      const coolOffMs = PURGE_COOL_OFF_DAYS * 24 * 60 * 60 * 1000;
      if (ageMs < coolOffMs) {
        const daysLeft = Math.ceil((coolOffMs - ageMs) / (24 * 60 * 60 * 1000));
        throw new HttpError(
          409,
          `An archived division can be purged ${PURGE_COOL_OFF_DAYS} days after archiving — ${daysLeft} day(s) to go`,
          "ARCHIVE_COOL_OFF",
        );
      }
    } else if (division.status !== "setup" || has_results) {
      // Broader than the SLOT rule (V354) deliberately: this destroys data, so
      // a division that merely LEFT setup is protected too. The slot rule
      // charges only for real results, because publishing a misconfigured
      // division and archiving it is a mistake, not usage.
      throw new HttpError(
        409,
        "This division has started or has recorded results — archive it instead (restorable), or purge it 30 days after archiving",
        "DIVISION_HAS_RESULTS",
        { archive: true },
      );
    }

    const [{ entrants }] = await tx<{ entrants: number }[]>`
      select count(*)::int as entrants from entrants where division_id = ${id}`;
    const [{ fixtures }] = await tx<{ fixtures: number }[]>`
      select count(*)::int as fixtures from fixtures where division_id = ${id}`;
    // Audit fidelity, not a guard: how MANY results died with the row. The
    // guard's question ("any at all?") is division_has_results above — this is
    // a different question, so it stays a count.
    const [{ decided }] = await tx<{ decided: number }[]>`
      select count(*)::int as decided from fixtures
      where division_id = ${id} and status in ('decided', 'finalized', 'forfeited')`;

    // The division ledger dies with the row (ON DELETE CASCADE); the audit
    // fact lives on the competition ledger, which survives (v3/09 §4).
    // Persons/teams/clubs are org-level rows — untouched by design.
    await auditCompetition(
      tx,
      division.competition_id,
      division.archived_at !== null ? "division_purged" : "division_deleted",
      {
        division_id: id,
        name: division.name,
        slug: division.slug,
        sport_key: division.sport_key,
        entrants,
        fixtures,
        decided_fixtures: decided,
      },
      auth.userId,
    );
    await tx`delete from divisions where id = ${id}`;
  });
}

/** Archive: hide from console/public/quota, restorable. Idempotent. */
export async function archiveDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<DivisionRow[]>`
      select ${tx(COLS)} from divisions where id = ${id}`;
    if (!existing) throw new HttpError(404, "division not found");
    if (existing.archived_at !== null) return existing;
    await assertRegistrationClosed(tx, id, "archive");

    const [row] = await tx<DivisionRow[]>`
      update divisions set archived_at = now() where id = ${id} returning ${tx(COLS)}`;
    await auditCompetition(
      tx,
      existing.competition_id,
      "division_archived",
      { division_id: id, name: existing.name, slug: existing.slug },
      auth.userId,
    );
    return row as DivisionRow;
  });
}

/** Restore an archived division. Re-checks the divisions quota — restoring
 *  must not smuggle a competition back over its plan limit. */
export async function restoreDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  // The competition id, ahead of the transaction, ONLY to scope the plan lookup
  // below — an Event Pass lifts this cap for one competition, so dropping the
  // scope would change the answer. Authorisation is unaffected: the row itself
  // is read under RLS inside the transaction, which 404s for a foreign org.
  const [ref] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${id}`;
  // The plan LOOKUP is resolved out here; the COUNT stays inside the
  // transaction with the insert (doc 10 §2 rule 1). `getLimit` queries the
  // pooled `sql` proxy, and `withTenant` pins a pooled connection for its whole
  // callback — see `assertWithinLimit` in lib/entitlements.ts.
  const divisionCap = await getLimit(
    auth.orgId,
    "divisions.per_competition.max",
    ref?.competition_id,
  );
  return withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<DivisionRow[]>`
      select ${tx(COLS)} from divisions where id = ${id}`;
    if (!existing) throw new HttpError(404, "division not found");
    if (existing.archived_at === null) return existing;
    // Un-archiving is a create in every way that matters to the lifecycle: a
    // finished competition must not grow back either.
    await assertCompetitionNotEnded(tx, existing.competition_id);

    // Identical predicate to createDivision's (V354) — restoring must not
    // smuggle a competition past a limit a create would have refused. The row
    // being restored is EXCLUDED and re-added as the `+ 1` below: it is
    // archived, so under the old `archived_at is null` count it was never in
    // `n`, but a resulted archived division now IS, and counting it twice would
    // refuse a restore that fits.
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from divisions d
      where d.competition_id = ${existing.competition_id}
        and d.id <> ${id}
        and (d.archived_at is null
             or (division_has_results(d.id) and d.slot_waived_at is null))`;
    assertWithinLimit(divisionCap, "divisions.per_competition.max", n + 1);

    const [row] = await tx<DivisionRow[]>`
      update divisions set archived_at = null where id = ${id} returning ${tx(COLS)}`;
    await auditCompetition(
      tx,
      existing.competition_id,
      "division_restored",
      { division_id: id, name: existing.name, slug: existing.slug },
      auth.userId,
    );
    return row as DivisionRow;
  });
}

// Structural comparison for the format-lock exemption below. Sorts object keys
// so two configs compare equal regardless of insertion order (pragmatic
// deep-equal — no shared helper exists). Arrays keep their order.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}

function withoutEntrants(config: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) if (k !== "entrants") rest[k] = v;
  return rest;
}

// Keys on the constraint NAME, not just the Postgres 23514 code — divisions
// also carries divisions_category_check, which shares the code but means a
// different failure. Backstop for the age-band merge-and-validate guard in
// patchDivision below (RS004 review finding 1); same precedent as
// apps/web/src/lib/credits.ts's isCheckViolation.
const AGE_BAND_CHECK_CONSTRAINT = "divisions_age_band_check";
function isAgeBandCheckViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23514" &&
    (err as { constraint_name?: string }).constraint_name === AGE_BAND_CHECK_CONSTRAINT
  );
}

// Same precedent, for the RS007/V380 cutoff columns' own CHECK
// (divisions_age_cutoff_check — both age_cutoff_month/age_cutoff_day or
// neither). checkAgeCutoff (schemas.ts) catches the common single-request
// case; this is the READ COMMITTED race backstop, same role
// isAgeBandCheckViolation plays for the age band above.
const AGE_CUTOFF_CHECK_CONSTRAINT = "divisions_age_cutoff_check";
function isAgeCutoffCheckViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23514" &&
    (err as { constraint_name?: string }).constraint_name === AGE_CUTOFF_CHECK_CONSTRAINT
  );
}

export async function patchDivision(
  auth: AuthCtx,
  id: string,
  patch: PatchDivision,
): Promise<DivisionRow> {
  // Jul3/08 §8: auto-advance is part of the advanced-formats Pro layer (or
  // an Event Pass on this division's competition, v3/07 §3).
  if (patch.auto_progress === true) {
    const [d] = await sql<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${id}`;
    await requireFeature(auth.orgId, "formats.advanced", d?.competition_id);
  }
  // SPEC-2: turning auto-drafted news ON is Pro `news.auto` (402 PlusReveal);
  // turning it off is always allowed (a downgraded org can quiet its toggle).
  if (patch.auto_posts === true) {
    await requireFeature(auth.orgId, "news.auto");
  }
  let previousSlug: string | null = null;
  let previousCompetitionId: string | null = null;
  const row = await withTenant(auth.orgId, async (tx) => {
    const effective: Record<string, unknown> = { ...patch };
    // RS004 review finding 1: checkAgeBand (schemas.ts) only compares
    // age_min/age_max when BOTH are present in the SAME patch body — a
    // single-field PATCH (e.g. only age_min) used to reach here untouched
    // even when it would violate the STORED value of the side it left
    // alone, and divisions_age_band_check (V364) then rejected the write
    // with a raw postgres 23514 that fell through to the generic 500
    // handler, leaking constraint text instead of the documented 422.
    // Merge against the current row before deciding — the `.catch` around
    // this transaction below is a race-condition backstop, not the primary
    // fix; this is what makes 422 the common path.
    if (patch.age_min !== undefined || patch.age_max !== undefined) {
      const [currentBand] = await tx<{ age_min: number | null; age_max: number | null; youth: boolean }[]>`
        select age_min, age_max, youth from divisions where id = ${id}`;
      if (!currentBand) throw new HttpError(404, "division not found");
      const mergedMin = patch.age_min !== undefined ? patch.age_min : currentBand.age_min;
      const mergedMax = patch.age_max !== undefined ? patch.age_max : currentBand.age_max;
      if (mergedMin != null && mergedMax != null && mergedMax < mergedMin) {
        throw new HttpError(422, AGE_MAX_BEFORE_MIN);
      }
      // Youth re-derives from age_max alone (v3/11 gap 8; RS007/V380 repoints
      // this from the retired jsonb-only eligibilityIsYouth — see
      // deriveYouth's own comment). Gated on age_max specifically (age_min
      // does not feed youth), and on the MERGED value fetched above — this
      // fetch is shared with the age-band check, not a second query — so a
      // single-field PATCH that only touches age_min leaves youth alone, and
      // one that touches age_max compares against ITS OWN new value rather
      // than a stale read. An explicit `patch.youth` in the SAME request
      // always wins (organiser override).
      //
      // REGRESSION FIX (review, RS007): an override set by an EARLIER
      // request must survive THIS one too — CreateDivision has no `youth`
      // field (deriveYouth's own comment), so a PATCH naming `youth` on its
      // own is the ONLY way an override is ever created, and
      // toDivisionPatchBody (registration-hub-config-state.ts) sends
      // age_max on EVERY hub Save, whatever the organiser actually touched,
      // while never sending `youth` at all (no such control exists in the
      // hub UI). Without this guard every hub Save silently re-derived over
      // an override set through the API. `deriveYouth` is the only thing
      // that ever writes `youth` on its own, so a STORED value that
      // disagrees with what it would compute from the CURRENT (pre-patch)
      // age_max can only be there because some earlier request explicitly
      // set it — that is what "explicit override always wins over the
      // derivation" (above) means in practice, not just same-request
      // precedence. This flag governs player_name_display (safeguarding:
      // whether children's names publish in full), so re-deriving over an
      // active override by accident is the wrong default.
      const currentIsOverride = currentBand.youth !== deriveYouth(currentBand.age_max);
      if (patch.age_max !== undefined && patch.youth === undefined && !currentIsOverride) {
        effective.youth = deriveYouth(mergedMax);
      }
    }
    // Format edits (v8 spec §2): allowed only while no stage owns fixtures,
    // then re-validated exactly like create — variant preset merged with the
    // override and parsed by the PINNED module's schema.
    if (patch.variant_key !== undefined || patch.config !== undefined) {
      const [current] = await tx<
        {
          sport_key: string;
          module_version: string;
          variant_key: string;
          config: Record<string, unknown> | null;
        }[]
      >`select sport_key, module_version, variant_key, config from divisions where id = ${id}`;
      if (!current) throw new HttpError(404, "division not found");
      const variantKey = patch.variant_key ?? current.variant_key;
      const [variant] = await tx<{ config: Record<string, unknown> }[]>`
        select config from sport_variants
        where sport_key = ${current.sport_key} and key = ${variantKey}
        order by org_id nulls last limit 1`;
      if (!variant) {
        throw new HttpError(422, `unknown variant '${variantKey}' for ${current.sport_key}`);
      }
      // Format lock (v8 spec §2): once a stage owns fixtures the format is
      // immutable — the ONE exception is an entrants-only settings save
      // (entrant shapes are not format; the ENTRANT_KIND_IN_USE guard below
      // covers the dangerous narrowing). The lock keeps its original
      // precedence: any variant_key touch, any config that doesn't parse, or
      // any non-entrants config change 409s BEFORE other validation — the v8
      // contract tests assert 409, never 422, while locked.
      const [{ locked }] = await tx<{ locked: boolean }[]>`
        select exists(
          select 1 from fixtures f
          join stages s on s.id = f.stage_id
          where s.division_id = ${id}
        ) as locked`;
      const formatLocked = () =>
        new HttpError(409, "Format is locked — fixtures exist", "FORMAT_LOCKED");
      // ANY variant_key in the patch is format intent — even re-sending the
      // current one resets config to the preset, and a "no-op" that only holds
      // because schema defaults reconstruct the stored config must not soften
      // the contract. The entrants-only door is config-shaped saves alone.
      if (locked && patch.variant_key !== undefined) throw formatLocked();
      const sportModule = resolveModule(current.sport_key, current.module_version);
      const merged = { ...variant.config, ...(patch.config ?? {}) };
      const parsed = sportModule.configSchema.safeParse(merged);
      if (!parsed.success) {
        if (locked) throw formatLocked();
        throw new EngineError("CONFIG_INVALID", `invalid ${current.sport_key} config`, {
          issues: parsed.error.issues,
        });
      }
      // The entrant-shape override (spec 2026-07-18) rides in `config.entrants`
      // but is NOT part of the sport's configSchema, which strips unknown keys —
      // so carry it through the parse explicitly. Absent from the incoming
      // config → the override is cleared back to the module default.
      const finalConfig = parsed.data as Record<string, unknown>;
      const incomingEntrants = (patch.config as { entrants?: unknown } | undefined)?.entrants;
      if (incomingEntrants != null && typeof incomingEntrants === "object") {
        finalConfig.entrants = incomingEntrants;
      }
      if (locked) {
        const nonEntrantsChanged =
          canonicalJson(withoutEntrants(finalConfig)) !==
          canonicalJson(withoutEntrants((current.config ?? {}) as Record<string, unknown>));
        if (nonEntrantsChanged) throw formatLocked();
      }
      // Narrowing the allowed kinds must not orphan entrants that already exist:
      // an active entrant of a kind the new model no longer accepts would become
      // unschedulable. Reject with 422 ENTRANT_KIND_IN_USE — withdraw first.
      const nextModel = effectiveEntrantModel(sportModule.entrantModel ?? null, finalConfig);
      const inUse = await tx<{ kind: string }[]>`
        select distinct kind from entrants
        where division_id = ${id} and status not in ('withdrawn', 'disqualified')`;
      for (const { kind } of inUse) {
        if (!nextModel.kinds.includes(kind as EntrantKind)) {
          throw new HttpError(
            422,
            `entrants of kind '${kind}' already exist — withdraw them first`,
            "ENTRANT_KIND_IN_USE",
          );
        }
      }
      effective.variant_key = variantKey;
      effective.config = tx.json(finalConfig as never);
    }
    // Rename regenerates the slug (v3/01 §2); old slug keeps redirecting.
    let before: { name: string; slug: string; competition_id: string } | undefined;
    if (patch.name) {
      [before] = await tx<{ name: string; slug: string; competition_id: string }[]>`
        select name, slug, competition_id from divisions where id = ${id}`;
      if (!before) throw new HttpError(404, "division not found");
    }
    const regenerating = !!patch.name && !!before && patch.name !== before.name;

    // The slug write is retryable, so the history row it implies belongs in
    // the SAME savepoint — a redirect must never outlive the update it names.
    const update = async (
      eff: Record<string, unknown>,
      q: postgres.TransactionSql,
    ): Promise<DivisionRow> => {
      if (eff.slug && before && eff.slug !== before.slug) {
        await recordSlugHistory(q, "division", before.competition_id, before.slug, id);
        previousSlug = before.slug;
        previousCompetitionId = before.competition_id;
      }
      const cols = Object.keys(eff);
      const values = {
        ...eff,
        ...(patch.tiebreakers ? { tiebreakers: q.json(patch.tiebreakers as never) } : {}),
        // `required_court_tags` is a real `text[]` column (V367, not jsonb —
        // q.array, not q.json), normalised on write with the SAME helper the
        // courts path uses. Truthy-checked like tiebreakers above: an
        // explicit `[]` (clearing the requirement back to "any court") is
        // still a truthy array and takes this branch correctly.
        // (age_cutoff_month/age_cutoff_day/eligibility_note need no such
        // special-casing — plain scalar columns flow through `...eff`
        // unchanged, same as category/age_min/age_max already do.)
        ...(patch.required_court_tags
          ? { required_court_tags: q.array(normalizeTags(patch.required_court_tags)) }
          : {}),
      };
      const [row] = await q<DivisionRow[]>`
        update divisions set ${q(values as never, ...(cols as never[]))}
        where id = ${id} returning ${q(COLS)}`;
      if (!row) throw new HttpError(404, "division not found");
      return row;
    };
    if (!regenerating) return update(effective, tx);
    return withUniqueSlug(
      tx,
      {
        base: slugify(patch.name!),
        constraint: SLUG_CONSTRAINT.divisions,
        taken: async (s) => {
          const [taken] = await tx`
            select 1 from divisions
            where competition_id = ${before!.competition_id} and slug = ${s} and id <> ${id}`;
          return !!taken;
        },
      },
      (slug, sp) => {
        // Cleared per attempt: a retry can land back on the division's current
        // slug, and bookkeeping left over from the failed attempt would bust
        // the slug cache for a rename that did not happen.
        previousSlug = null;
        previousCompetitionId = null;
        return update(slug === before!.slug ? effective : { ...effective, slug }, sp);
      },
    );
  }).catch((err: unknown) => {
    // Race backstop only — READ COMMITTED means two concurrent PATCHes can
    // each pass the merge-and-validate guard above against a stale read,
    // then both write; whichever commits second still hits this CHECK. Must
    // not leak the raw constraint text either way.
    if (isAgeBandCheckViolation(err)) throw new HttpError(422, AGE_MAX_BEFORE_MIN);
    if (isAgeCutoffCheckViolation(err)) throw new HttpError(422, AGE_CUTOFF_BOTH_OR_NEITHER);
    throw err;
  });
  // A rename busts the cached slug resolution (old + new key) — outside the
  // tx, matching the pattern in patchCompetition.
  if (previousSlug) {
    await invalidateSlugCache("division", previousCompetitionId, previousSlug, row.slug);
  }
  return row;
}
