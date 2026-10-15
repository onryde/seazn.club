import "server-only";
// Division use-cases (doc 08 §3, doc 06). Creation snapshots the merged
// variant config and PINS the sport module version (doc 02 §4) so a running
// division always replays under the rules it started with.
import type postgres from "postgres";
import { sql, withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { assertWithinLimit, getLimit, requireFeature, passLockReason } from "@/lib/entitlements";
import { EngineError } from "@seazn/engine/core";
import { effectiveEntrantModel, type EntrantKind } from "@seazn/engine/sport";
import { resolveModule } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  AGE_MAX_BEFORE_MIN,
  AGE_CUTOFF_BOTH_OR_NEITHER,
  AGE_CUTOFF_DAY_INVALID_FOR_MONTH,
  type CreateDivision,
  type PatchDivision,
} from "@/server/api-v1/schemas";
// The SAME day-per-month predicate `checkAgeCutoff` validates the request
// body with — imported, never re-implemented, so a change to DAYS_IN_MONTH
// moves both layers together (F12's merge-check below).
import { isValidCutoffDay } from "@/lib/registration-rules";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
import { divisionRefusals } from "./rule-locks";
import { refuseInvalidatedOverrides } from "./fixture-override-guards";
import { refuseInexpressibleStagePoints, refuseInvalidatedStageRules } from "./stage-rules-merge";
import { reseedStagePresets } from "./stage-preset-reseed";
import { heldAwards, rewriteHeldAwards, type HeldAward } from "./award-rewrite";
import { RULE_ERROR_STATUS, ruleErrorMessage, type RefusedField } from "@/lib/rule-errors";
import {
  slugify,
  withUniqueSlug,
  SLUG_CONSTRAINT,
  recordSlugHistory,
  RESERVED_ENTITY_SLUGS,
} from "./slugs";
import { invalidateSlugCache } from "@/server/slug-resolve";
import { retireOrgPlayerMatches } from "@/server/public-site/player-matches-cache-keys";
import {
  dropNamedPublicDocuments,
  expireCompetitionShell,
  fireOrgRevalidate,
  fireDivisionRevalidate,
  fireScoreRevalidate,
} from "@/server/public-site/revalidate";
// D5/P8: same trim/lowercase/dedupe/drop-empties rule the courts path uses
// for their own `tags` — one copy, imported, not re-implemented (a court
// tagged "clay" must match a division requiring "Clay").
import { normalizeTags } from "./venues";
import {
  applyOnlinePlayToConfig,
  assertOnlinePlayValue,
  readOnlinePlay,
  withoutDivisionMetaKeys,
} from "@/server/external-play/online-play";
import {
  assertCameraPolicyForSport,
  assertCameraPolicyValue,
  assertPolicyChange,
  CAMERA_POLICY_CHANGED,
  effectivePolicy,
  readCameraPolicy,
  type CameraPolicy,
} from "@/server/external-play/camera-policy";
import { anyRoundOpened } from "@/server/external-play/round-open";
import { assertTimeControl } from "@/server/external-play/time-controls";
import type { BoardgameClockInput } from "@/server/external-play/clock";
import { assertOnlineChessOffered, onlineChessDisabled, onlineChessOffered } from "./external-play/online-chess-flag";
import { audit } from "./audit";

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
  /** RS007/V380: both-or-neither — enforced by `checkAgeCutoff` (schemas.ts)
   *  on the request body and by `patchDivision`'s merge-check below on the
   *  merged row, NOT by `divisions_age_cutoff_check`, which a one-sided
   *  orphan satisfies (see that merge-check's own comment).
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
  /** V416: publish seed numbers on the public site (`public_entrants_v`
   *  redacts `seed` when false). Admin reads are unaffected. */
  show_seeds: boolean;
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
  /** V451 online-chess camera requirement for this division; null = inherit
   *  the competition's (NOT NULL floor). Resolved per fixture, with the stage
   *  level, by camera-policy.ts's fixtureCameraPolicy. */
  camera_policy: CameraPolicy | null;
}

const COLS = [
  "id", "competition_id", "name", "slug", "description", "sport_key", "variant_key", "config",
  "module_version", "tiebreakers", "category", "age_min", "age_max", "age_cutoff_month",
  "age_cutoff_day", "eligibility_note", "status",
  "officials_hide_names", "scheduling_mode", "auto_progress", "auto_posts", "show_seeds", "schedule_locked",
  "archived_at", "created_at", "seq", "youth", "player_name_display", "logo_url",
  "logo_storage_path", "required_court_tags", "camera_policy",
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
  // T20: a division created online STARTS online play, so the club must be offered it (the PostHog flag
  // `online-chess`). Asked only when online play is asked for, and out here for the same reason as the reads above:
  // it is a remote call, never made while a tenant transaction holds a pooled connection.
  if ((input.config as Record<string, unknown> | undefined)?.onlinePlay === "lichess") {
    await assertOnlineChessOffered(auth);
  }

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
    const finalConfig = parsed.data as Record<string, unknown>;
    const inputCfg = input.config as Record<string, unknown>;
    const onlinePlay =
      inputCfg && "onlinePlay" in inputCfg
        ? assertOnlinePlayValue(input.sport_key, inputCfg.onlinePlay)
        : readOnlinePlay(null);
    applyOnlinePlayToConfig(finalConfig, onlinePlay);
    const incomingEntrants = inputCfg?.entrants;
    if (incomingEntrants != null && typeof incomingEntrants === "object") {
      finalConfig.entrants = incomingEntrants;
    }
    // T6: a column, not a config key — absent ⇒ null ⇒ inherit, exactly like
    // every division created before the column existed. No round can be open
    // on a division that does not exist yet, so there is nothing to gate and
    // nothing changed to audit.
    const cameraPolicy = assertCameraPolicyValue(input.camera_policy);
    assertCameraPolicyForSport(input.sport_key, cameraPolicy);
    // T5-I1/T6 (M12): a division played online must have a clock the Board
    // API will actually play, and the organiser learns that HERE, at setup —
    // a 1+0 is CREATED by Lichess and then every move is refused, so a later
    // check would only fire at round open. Over-the-board chess is untouched.
    if (readOnlinePlay(finalConfig) === "lichess") {
      assertTimeControl(finalConfig.clock as BoardgameClockInput | undefined);
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
                               age_cutoff_month, age_cutoff_day, eligibility_note, youth,
                               camera_policy)
        values (${competitionId}, ${input.name}, ${slug}, ${input.sport_key}, ${input.variant_key},
                ${q.json(finalConfig as never)}, ${sport.module_version},
                ${input.tiebreakers ? q.json(input.tiebreakers as never) : null},
                ${input.category ?? null}, ${input.age_min ?? null}, ${ageMax},
                ${input.age_cutoff_month ?? null}, ${input.age_cutoff_day ?? null},
                ${input.eligibility_note ?? null}, ${deriveYouth(ageMax)},
                ${cameraPolicy})
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
  await expireCompetitionShell(auth.orgId, { competitionId, divisionId: row.id });
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
  const deleted = await withTenant(auth.orgId, async (tx) => {
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
    return division;
  });
  // A purge removes a division the shell stopped listing when it was archived.
  if (deleted.archived_at === null) {
    await expireCompetitionShell(auth.orgId, { competitionId: deleted.competition_id, divisionId: id });
  }
}

/** Archive: hide from console/public/quota, restorable. Idempotent. */
export async function archiveDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  let archived = false;
  const result = await withTenant(auth.orgId, async (tx) => {
    archived = false;
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
    archived = true;
    return row as DivisionRow;
  });
  if (archived) await expireCompetitionShell(auth.orgId, { competitionId: result.competition_id, divisionId: id });
  return result;
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
  let restored = false;
  const result = await withTenant(auth.orgId, async (tx) => {
    restored = false;
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
    restored = true;
    return row as DivisionRow;
  });
  if (restored) await expireCompetitionShell(auth.orgId, { competitionId: result.competition_id, divisionId: id });
  return result;
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

// The top-level config keys whose value differs between two configs — the unit the W2c lock reasons in (X-SR-4). A key
// either side lacks reads as `undefined`, so an added or a dropped key is a change. The division meta keys never count
// (`withoutDivisionMetaKeys`, the format lock's two doors): the entrant-shape override is not format, and its own guard
// (ENTRANT_KIND_IN_USE) covers the dangerous narrowing; online play is a division setting with its own gates (the
// online-chess flag and the clock, below).
function changedConfigKeys(next: Record<string, unknown>, current: Record<string, unknown>): string[] {
  const a = withoutDivisionMetaKeys(next);
  const b = withoutDivisionMetaKeys(current);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => canonicalJson(a[k]) !== canonicalJson(b[k]));
}

// Put `key` back to what `from` holds: a key `from` lacks is removed from `target` rather than set to undefined.
function restoreKey(target: Record<string, unknown>, from: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(from, key)) target[key] = from[key];
  else delete target[key];
}

/** What a division save answers: the stored row, plus every field the save did NOT apply and the started stage that
 *  depends on it (`[]` when nothing was refused). */
export type PatchDivisionResult = DivisionRow & { refused: RefusedField[] };

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

// The RS007/V380 cutoff columns' own CHECK (divisions_age_cutoff_check).
// NOT the same role isAgeBandCheckViolation plays above, and the difference
// matters: when exactly one half is NULL and the PRESENT half is in range,
// that constraint's second disjunct is NULL, and `false OR NULL` SATISFIES a
// CHECK — so a one-sided orphan of valid values passes it and this predicate
// can never fire on the both-or-neither rule at all.
//
// What it CAN catch is any PRESENT half outside its own range, one-sided
// included: `false and NULL` is FALSE, not NULL, so an out-of-range present
// half collapses the second disjunct rather than nulling it. Verified against
// the live constraint definition — `(13, null)` and `(null, 32)` refused,
// `(9, null)` and `(null, 5)` satisfied, `(2, 31)` satisfied (it does not do
// day-per-month either). PatchDivision's `.min`/`.max` bound every half
// before it can be sent, so nothing reaches it over /api/v1.
//
// Kept as a leak guard on the raw constraint text, not as a race backstop —
// both-or-neither has no database invariant underneath it (W8/F12).
// The 422 it raises carries AGE_CUTOFF_BOTH_OR_NEITHER, which is the wrong
// sentence for a range violation; unreachable over /api/v1, so left alone.
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
): Promise<PatchDivisionResult> {
  // Both gates below resolve against THIS division's competition, so one
  // lookup serves them: `formats.advanced` has always been pass-lifted, and
  // V396 made `news.auto` pass-lifted too (false on Free, granted on both
  // Event Pass rungs). On the pooled proxy and BEFORE `withTenant` opens —
  // `requireFeature` is a pooled read and issuing one inside a tenant
  // transaction is the pool self-deadlock (lib/db.ts).
  const needsCompetition = patch.auto_progress === true || patch.auto_posts === true;
  const competitionId = needsCompetition
    ? (
        await sql<{ competition_id: string }[]>`
          select competition_id from divisions where id = ${id}`
      )[0]?.competition_id
    : undefined;
  // Jul3/08 §8: auto-advance is part of the advanced-formats Pro layer (or
  // an Event Pass on this division's competition, v3/07 §3).
  if (patch.auto_progress === true) {
    await requireFeature(auth.orgId, "formats.advanced", competitionId);
  }
  // SPEC-2: turning auto-drafted news ON is Pro `news.auto` — or an Event Pass
  // on this competition since V396; turning it off is always allowed (a
  // downgraded org can quiet its toggle).
  if (patch.auto_posts === true) {
    await requireFeature(auth.orgId, "news.auto", competitionId);
  }
  // T20: turning online play ON starts online play, so the club must be offered it (the PostHog flag `online-chess`).
  // Asked out here — a remote call, never made inside the tenant transaction — and only when the patch names
  // 'lichess', the one value that can turn it on. Whether it DOES turn it on (the stored value was not 'lichess') is
  // judged inside, on the row; `null` ⇒ not asked, and a patch that turns it on without an answer is refused.
  const onlineOffered =
    (patch.config as Record<string, unknown> | undefined)?.onlinePlay === "lichess"
      ? await onlineChessOffered(auth)
      : null;
  // T6 / D9: the camera requirement. Validated before anything is read. The
  // round-open question is asked INSIDE the write's own transaction (review
  // M9, fix round 1), in withTenant's privileged prelude: stage_round_opens is
  // sealed, so as app_user the read is refused 42501 (round-open.ts), and a
  // pooled read inside the tenant transaction is the pool self-deadlock
  // above. The prelude first takes the division lock openRound takes, so an
  // open and this gate are serialised: an open that commits first is seen
  // here, and one that starts later waits for this write to commit. Read
  // before the transaction (as it was), a tightening could commit just after
  // an open had.
  const cameraPolicyNamed = patch.camera_policy !== undefined;
  const incomingCamera = cameraPolicyNamed ? assertCameraPolicyValue(patch.camera_policy) : null;
  let roundOpened = false;
  let previousSlug: string | null = null;
  let previousCompetitionId: string | null = null;
  // The public player page masks each opponent's name by their division's
  // `youth` and `player_name_display` (public-player-matches.ts), and caches
  // the result under a generation token it re-reads only on a miss — so a
  // change to either must retire the tokens (after commit, below). This is
  // the one runtime writer of both columns on an existing row: `youth` set
  // directly or re-derived from `age_max`. Compared stored-before against the
  // returned row rather than on which fields the body NAMES, because the
  // registration hub re-sends `age_max` on every Save. `for no key update` pins the
  // "before" to what this write replaces: without it a concurrent PATCH could
  // commit between the read and the update, and a masking change would
  // compare equal to the stale read and retire nothing. NO KEY: a plain
  // `for update` would also block the KEY SHARE locks FK inserts take, so every
  // Save would queue behind (and stall) approvals and fixture generation.
  // The same stored-before read also decides the privacy hotfix's public-page
  // expiry below: one read, one lock, one comparison for both.
  let maskingBefore: { youth: boolean; player_name_display: string | null } | undefined;
  // V416: the stored `show_seeds` this write replaces, read under the same
  // `for no key update` for the same reason — the public expiry below fires
  // only when the STORED value actually flips, never on a re-send.
  let seedsBefore: boolean | undefined;
  // The stored name a rename replaces: a changed name moves the division in the
  // public competition shell (`expireCompetitionShell`), a re-sent one does not.
  let nameBefore: string | undefined;
  // W2c X-SR-4: the fields this save did not apply because a started stage depends on them. Assigned inside the
  // transaction and returned beside the row; `[]` when nothing was refused.
  let refused: RefusedField[] = [];
  // W2c Task 11 (carry (b) of the batch-3 re-review): whether this save re-wrote a stored walkover score. Set in the
  // transaction, read after it commits.
  let rewroteAwards = false;
  // W2c Task 12 fix round 1 (R-T12-2): the stages a variant change re-seeded, set in the transaction, read after it.
  let reseededStages: string[] = [];
  const cameraGate = async (ptx: Tx) => {
    await ptx`select pg_advisory_xact_lock(hashtext(${"division:" + id}))`;
    roundOpened = await anyRoundOpened(ptx, id, new Date());
  };
  const row = await withTenant(auth.orgId, async (tx) => {
    // W2c batch-3 I1: the walkovers no event records, read before a format write (`award-rewrite.ts`); none otherwise.
    let held: HeldAward[] = [];
    const effective: Record<string, unknown> = { ...patch };
    // Batch 4 re-review N1: ONE lock order everywhere — the division advisory lock FIRST, then any row lock on `divisions`.
    // The stage writers (`insertStageBatch`, which `createStages` and `replaceStages` share) take the advisory lock and
    // only then reopen a completed division (`update divisions`, a row lock); this save used to read the row `for no key
    // update` (the two reads below) and take the advisory lock after it, so on a completed division the two each held
    // what the other wanted and Postgres broke the tie with 40P01. Taken here, before the first row lock, whenever the
    // body can touch the format or the stages (a format edit or tiebreakers, both below). Not taken unconditionally: the
    // lock is also held by the schedule build, a restore and every stage generator, and a plain Save (a rename, the
    // registration hub's `age_max` re-send) has no need to queue behind one of them.
    const formatEdit = patch.variant_key !== undefined || patch.config !== undefined;
    const touchesFormat = formatEdit || patch.tiebreakers !== undefined;
    if (touchesFormat) {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + id}))`;
    }
    // The camera block below takes a row lock (`for no key update of d`), so it comes AFTER the advisory locks (N1's
    // order: advisory locks first, rows last). When it runs, withTenant's prelude (`cameraGate`) has already taken
    // `division:`; taking it again above, in the same transaction, never waits.
    if (cameraPolicyNamed) {
      // The stored value this write replaces, under the same `for no key
      // update` the masking/seeds reads below use, plus the competition floor
      // it inherits when it is null.
      const [cur] = await tx<
        {
          sport_key: string;
          competition_id: string;
          camera_policy: string | null;
          competition_policy: string;
        }[]
      >`
        select d.sport_key, d.competition_id, d.camera_policy,
               c.camera_policy as competition_policy
          from divisions d
          join competitions c on c.id = d.competition_id
         where d.id = ${id}
           for no key update of d`;
      if (!cur) throw new HttpError(404, "division not found");
      assertCameraPolicyForSport(cur.sport_key, incomingCamera);
      const storedCamera = readCameraPolicy(cur.camera_policy);
      // Only a real CHANGE of the stored value is gated and audited: a re-send
      // of the current value must never 409 or leave a row.
      if (incomingCamera !== storedCamera) {
        // The gate judges what PLAYERS get (the division-level effective
        // policy), not the stored values: clearing 'off' to inherit a
        // 'required' competition is a tightening even though null has no rank.
        const floor = readCameraPolicy(cur.competition_policy);
        const effectiveFrom = effectivePolicy({ stage: null, division: storedCamera, competition: floor });
        const effectiveTo = effectivePolicy({ stage: null, division: incomingCamera, competition: floor });
        assertPolicyChange({ from: effectiveFrom, to: effectiveTo, windowOpened: roundOpened });
        // Same transaction as the write it describes (ruling Q2: one row in
        // competition_events per change), so a refused or rolled-back change
        // can never leave a row saying it happened.
        await audit(
          tx,
          cur.competition_id,
          auth.orgId,
          CAMERA_POLICY_CHANGED,
          {
            divisionId: id,
            stageId: null,
            from: storedCamera,
            to: incomingCamera,
            effectiveFrom,
            effectiveTo,
            roundOpened,
          },
          auth.userId,
        );
      }
      effective.camera_policy = incomingCamera;
    }
    if (patch.youth !== undefined || patch.player_name_display !== undefined || patch.age_max !== undefined) {
      [maskingBefore] = await tx<{ youth: boolean; player_name_display: string | null }[]>`
        select youth, player_name_display from divisions where id = ${id} for no key update`;
    }
    if (patch.show_seeds !== undefined) {
      const [stored] = await tx<{ show_seeds: boolean }[]>`
        select show_seeds from divisions where id = ${id} for no key update`;
      seedsBefore = stored?.show_seeds;
    }
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
    // Settings walkthrough F12 — the same merge-and-validate the age band
    // above gets, for the cutoff pair, and for the same reason.
    //
    // `checkAgeCutoff` (api-v1/schemas.ts) is a `superRefine` on the request
    // BODY, and its `(month != null) !== (day != null)` cannot tell a field
    // the request OMITTED from one it set to an explicit `null` — `!= null`
    // is true of both. So `PATCH { age_cutoff_day: null }` against a stored
    // `age_cutoff_month = 9` read `false !== false`, passed, and wrote the
    // orphan half the pair is supposed to make impossible (witnessed against
    // a running server, W7 T2 probe 2026-09-07, in BOTH directions).
    //
    // `divisions_age_cutoff_check` (V380) does not backstop it either, which
    // is what makes this the enforcement point rather than a nicety: with one
    // side NULL the CHECK's second disjunct evaluates to NULL, and
    // `false OR NULL` SATISFIES a CHECK. `isAgeCutoffCheckViolation` below
    // therefore only ever fires on the constraint's RANGE half.
    //
    // Note `!== undefined`, not `??`: `??` would collapse an explicit `null`
    // back onto the stored value and quietly reinstate exactly this bug.
    if (patch.age_cutoff_month !== undefined || patch.age_cutoff_day !== undefined) {
      const [currentCutoff] = await tx<
        { age_cutoff_month: number | null; age_cutoff_day: number | null }[]
      >`select age_cutoff_month, age_cutoff_day from divisions where id = ${id}`;
      if (!currentCutoff) throw new HttpError(404, "division not found");
      const mergedMonth =
        patch.age_cutoff_month !== undefined ? patch.age_cutoff_month : currentCutoff.age_cutoff_month;
      const mergedDay =
        patch.age_cutoff_day !== undefined ? patch.age_cutoff_day : currentCutoff.age_cutoff_day;
      if ((mergedMonth != null) !== (mergedDay != null)) {
        throw new HttpError(422, AGE_CUTOFF_BOTH_OR_NEITHER);
      }
      // Day-for-month on the MERGED pair. Unreachable over /api/v1 as the
      // schema stands — every body that survives `checkAgeCutoff` with both
      // merged halves non-null carried both halves itself, and was therefore
      // already day-validated there — so this is a guard for the OTHER caller
      // shape: `patchDivision` is an exported use-case, and a direct caller
      // (a server action, a script, a future route) gets no zod pass at all.
      // Proven rather than assumed, and it is not decoration: it is killed by
      // `division-settings.test.ts`'s "an impossible day-for-month is refused
      // even when zod never ran", which calls this function directly.
      if (mergedMonth != null && mergedDay != null && !isValidCutoffDay(mergedMonth, mergedDay)) {
        throw new HttpError(422, AGE_CUTOFF_DAY_INVALID_FOR_MONTH);
      }
    }
    // Format edits (v8 spec §2) and the standings cascade, re-validated exactly like create — variant preset merged
    // with the override and parsed by the PINNED module's schema.
    //
    // W2c X-SR-4 (owner P-2 "A", 2026-10-13): the lock is no longer "any fixture exists". A field is refused only while
    // a STARTED stage that INHERITS it exists (rule-locks.ts `divisionRefusals`), and it is refused BY NAME — the save
    // still applies every other field. Three things follow:
    //   1. the config is built as before, then every refused key is put back to its stored value;
    //   2. because that restore can produce a mix nobody validated (a restored `setTo` beside a saved `cap`), the config
    //      left over is parsed AGAIN, and an invalid mix is the same 422 CONFIG_INVALID, with nothing written;
    //   3. tiebreakers join the lock — they were never locked before W2c (Q3).
    // An unparseable config is 422 whether or not anything has started: the old "409 beats 422 while locked" order
    // belonged to the division-wide lock, which is gone.
    if (touchesFormat) {
      // Under the division advisory lock every format writer takes (`stage-rules.ts`, `fixture-rules.ts`), taken at the
      // top of this transaction (N1): a format edit re-writes the walkovers no event records (batch-3 I1, below), and a
      // per-match correction of one of them must not interleave with it.
      const [current] = await tx<
        {
          sport_key: string;
          module_version: string;
          variant_key: string;
          config: Record<string, unknown> | null;
          tiebreakers: string[] | null;
        }[]
      >`select sport_key, module_version, variant_key, config, tiebreakers from divisions where id = ${id}`;
      if (!current) throw new HttpError(404, "division not found");
      const currentConfig = (current.config ?? {}) as Record<string, unknown>;

      let nextConfig: Record<string, unknown> | undefined;
      let sportModule: ReturnType<typeof resolveModule> | undefined;
      let configKeys: string[] = [];
      // Only a DIFFERENT variant key is a variant change.
      const variantChanged = patch.variant_key !== undefined && patch.variant_key !== current.variant_key;
      // Re-sending the CURRENT variant with no config asks for nothing: the same variant, the config as stored. (Before
      // W2c it reset every customised key to the preset. No caller relied on that — division-settings.tsx always sends
      // `config` with its variant — and a reset nobody asked for is a surprise, so it is a true no-op now.)
      const variantResend = patch.variant_key !== undefined && !variantChanged && patch.config === undefined;
      if (formatEdit && !variantResend) {
        const variantKey = patch.variant_key ?? current.variant_key;
        const [variant] = await tx<{ config: Record<string, unknown> }[]>`
          select config from sport_variants
          where sport_key = ${current.sport_key} and key = ${variantKey}
          order by org_id nulls last limit 1`;
        if (!variant) {
          throw new HttpError(422, `unknown variant '${variantKey}' for ${current.sport_key}`);
        }
        sportModule = resolveModule(current.sport_key, current.module_version);
        const merged = { ...variant.config, ...(patch.config ?? {}) };
        const parsed = sportModule.configSchema.safeParse(merged);
        if (!parsed.success) {
          throw new EngineError("CONFIG_INVALID", `invalid ${current.sport_key} config`, {
            issues: parsed.error.issues,
          });
        }
        // The entrant-shape override (spec 2026-07-18) rides in `config.entrants`
        // but is NOT part of the sport's configSchema, which strips unknown keys —
        // so carry it through the parse explicitly. Absent from the incoming
        // config → the override is cleared back to the module default.
        nextConfig = parsed.data as Record<string, unknown>;
        const incomingEntrants = (patch.config as { entrants?: unknown } | undefined)?.entrants;
        if (incomingEntrants != null && typeof incomingEntrants === "object") {
          nextConfig.entrants = incomingEntrants;
        }
        // Online play rides in config too and the parse strips it: the patch's value when it names one, else the
        // stored one (a save that does not mention it never switches it).
        const patchCfg = patch.config as Record<string, unknown> | undefined;
        if (patchCfg && "onlinePlay" in patchCfg) {
          applyOnlinePlayToConfig(
            nextConfig,
            assertOnlinePlayValue(current.sport_key, patchCfg.onlinePlay),
          );
        } else {
          applyOnlinePlayToConfig(nextConfig, readOnlinePlay(current.config));
        }
        configKeys = changedConfigKeys(nextConfig, currentConfig);
      }
      const tiebreakersChanged =
        patch.tiebreakers !== undefined && canonicalJson(patch.tiebreakers) !== canonicalJson(current.tiebreakers);

      refused = await divisionRefusals(
        tx, id, { configKeys, variant: variantChanged, tiebreakers: tiebreakersChanged },
        { module: sportModule ?? resolveModule(current.sport_key, current.module_version), variantKey: current.variant_key, divisionConfig: currentConfig },
      );
      const refusedFields = new Set(refused.map((r) => r.field));
      const variantRefusal = refused.find((r) => r.field === "variant_key");

      let configApplied = false;
      if (nextConfig !== undefined && sportModule !== undefined) {
        const finalConfig = nextConfig;
        // Every key a refusal covers goes back to what is stored: the keys refused one by one, and — when the variant is
        // refused — every CHANGED key the patch did not set itself. The variant stays as stored, so nothing the
        // requested variant would have changed may land either (review I1): a preset applied without its variant is a
        // config that belongs to no variant. "Changed" is read off the built config against the stored one, so it
        // covers a key the switch REMOVES (an optional key with no default, absent from the parsed preset) as well as
        // one it sets (review M-a). Keys the patch sets ITSELF are not the variant's to drop: they were judged above,
        // one by one.
        const explicit = (patch.config ?? {}) as Record<string, unknown>;
        for (const k of configKeys) {
          const viaVariant = variantRefusal !== undefined && !Object.hasOwn(explicit, k) ? variantRefusal : undefined;
          if (!refusedFields.has(k) && viaVariant === undefined) continue;
          restoreKey(finalConfig, currentConfig, k);
          if (viaVariant !== undefined && !refusedFields.has(k)) {
            refusedFields.add(k);
            refused.push({ field: k, code: "DIVISION_FORMAT_LOCKED", stageId: viaVariant.stageId, stageName: viaVariant.stageName });
          }
        }
        // A save that names no config carries no entrants, which the parse above reads as "clear the override". A
        // refused variant must not clear it (nothing of the variant may land); an ACCEPTED change of variant keeps its
        // pre-W2c reset. (A re-send of the current variant never gets here: it is `variantResend`, a no-op.)
        if (patch.config === undefined && variantRefusal !== undefined) {
          restoreKey(finalConfig, currentConfig, "entrants");
        }
        if (refused.length > 0) {
          const reparsed = sportModule.configSchema.safeParse(finalConfig);
          // Same shape as the first parse (EngineError CONFIG_INVALID with `issues`), plus the locked fields that were
          // kept as stored: without them the organiser sees a config error about a value they did not send.
          if (!reparsed.success) {
            throw new EngineError(
              "CONFIG_INVALID",
              `invalid ${current.sport_key} config once ${refused.map((r) => r.field).join(", ")} stay as stored`,
              { issues: reparsed.error.issues, refused },
            );
          }
        }
        configApplied = canonicalJson(finalConfig) !== canonicalJson(currentConfig);
      }

      // Nothing the save can apply is left, and something was refused: that is a refusal, not a success that did
      // nothing. A save that also renames, keeps part of its config, or carries a tiebreakers (or variant) change the
      // lock let through still lands with `refused` beside the row: the patch is applied PER FIELD (owner P-2 "A"),
      // so only a patch from which NOTHING lands is a 409, and a 409 never hides a field it did not refuse.
      //
      // What lands is read off what will be WRITTEN, not off "was anything refused". The lock now judges each change
      // by the stages that inherit it, so a refusal of one field says nothing about another: a started knockout has
      // no table, hence refuses a changed `setTo` and accepts a changed `tiebreakers` in the same patch (review I1).
      // A tiebreakers change that is in the patch, differs from what is stored, and is not in `refused` is written
      // (`effective.tiebreakers`, deleted only when refused), so it counts exactly as `otherColumn` and `configApplied` do.
      // A VARIANT change needs no such term: the lock refuses it on the first started stage, and every other refusal also
      // needs a started stage, so once anything is refused a changed variant was refused with it.
      const lockable = new Set(["variant_key", "config", "tiebreakers"]);
      const otherColumn = Object.entries(patch).some(([k, v]) => v !== undefined && !lockable.has(k));
      const tiebreakersApplied = tiebreakersChanged && !refusedFields.has("tiebreakers");
      if (refused.length > 0 && !otherColumn && !configApplied && !tiebreakersApplied) {
        const first = refused[0]!;
        throw new HttpError(
          RULE_ERROR_STATUS[first.code],
          ruleErrorMessage(first.code, { stage: first.stageName, field: first.field }),
          first.code,
          { refused },
        );
      }

      if (nextConfig !== undefined && sportModule !== undefined) {
        // T5-I1/T6 (M12): the setup gate for an online clock, as on create.
        // AFTER the lock so a locked division keeps answering 409 for any
        // format change, never 400. Judged on the FINAL config, and only when
        // the clock or online play CHANGES against the stored row: a save that
        // re-sends both as stored (the Entrants save re-sends the whole config
        // through one of the format lock's two doors — withoutDivisionMetaKeys
        // lets `entrants` AND `onlinePlay` change on a locked division) must not
        // be refused for a clock saved before this gate existed: on a locked
        // division the only repair, changing the clock, is itself 409, so that
        // save would be refused for good (review T6-I1). The other door is why
        // this is not simply `!locked`: online play switched ON over a stored
        // pre-gate clock on a locked division must still be judged (N-1).
        // Under W2c's per-field lock (X-SR-4), "after the lock" is after the refusals: the config judged here is the one
        // left once every refused key is back to its stored value.
        // T20: only the off → lichess transition starts online play. A re-send of a stored 'lichess' (every Entrants
        // and format save re-sends the whole config) and turning it off are never gated, so a club whose flag goes
        // off can still save, and switch online play off, on a division already online. After the lock (409 keeps
        // its precedence for a format change), before the clock (the feature is not offered at all).
        if (
          readOnlinePlay(nextConfig) === "lichess" &&
          readOnlinePlay(currentConfig) !== "lichess" &&
          onlineOffered !== true
        ) {
          throw onlineChessDisabled();
        }
        const clockOrOnlineChanged =
          canonicalJson(nextConfig.clock ?? null) !== canonicalJson(currentConfig.clock ?? null) ||
          readOnlinePlay(nextConfig) !== readOnlinePlay(currentConfig);
        if (clockOrOnlineChanged && readOnlinePlay(nextConfig) === "lichess") {
          assertTimeControl(nextConfig.clock as BoardgameClockInput | undefined);
        }
        // Narrowing the allowed kinds must not orphan entrants that already exist:
        // an active entrant of a kind the new model no longer accepts would become
        // unschedulable. Reject with 422 ENTRANT_KIND_IN_USE — withdraw first.
        const nextModel = effectiveEntrantModel(sportModule.entrantModel ?? null, nextConfig);
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
        effective.variant_key = variantRefusal ? current.variant_key : (patch.variant_key ?? current.variant_key);
        effective.config = tx.json(nextConfig as never);
        // W2c Task 11 (batch-1 I-A): no stage that carries its own rules may be left invalid by this config - asked
        // only when the save really moves the config (an unchanged one leaves every stage exactly as it was valid) or the
        // variant (Task 12, M1: the keys a stage may carry are the variant's, so a stored one can stop being settable).
        const variantApplied = variantChanged && variantRefusal === undefined;
        // W2c batch-3 I1: the walkovers no event records, as they resolve BEFORE this save's first write (the re-seed
        // below is one) — re-written after it.
        held = await heldAwards(tx, tx`division_id = ${id}`);
        // W2c Task 12 fix round 1 (R-T12-2): a variant change re-seeds the presets its unstarted stages still store
        // (`stage-preset-reseed.ts`), BEFORE the stages are re-asked below, so only a key the organiser chose meets the
        // new variant's allowlist. A refusal below rolls the re-seed back with the rest of the save.
        if (variantApplied) {
          reseededStages = await reseedStagePresets(tx, {
            divisionId: id, module: sportModule, fromVariant: current.variant_key, toVariant: effective.variant_key as string, actorId: auth.userId,
          });
        }
        if (configApplied || variantApplied) {
          await refuseInvalidatedStageRules(tx, id, nextConfig, sportModule, current.sport_key, variantApplied ? (effective.variant_key as string) : null);
          // W2c Task 13 (Q1): no unstarted stage may be left with its own points over a division whose points they cannot
          // express (a variant or `points` edit that splits them) — the question the stage PUT asked when they were saved.
          await refuseInexpressibleStagePoints(tx, id, currentConfig, nextConfig, sportModule);
        }
        // W2c Task 14 (I-A one layer up): no unstarted match's own format may be left invalid by this config.
        await refuseInvalidatedOverrides(tx, id, nextConfig, sportModule, effective.variant_key as string);
      }
      if (refusedFields.has("tiebreakers")) delete effective.tiebreakers;
    }
    // Rename regenerates the slug (v3/01 §2); old slug keeps redirecting.
    let before: { name: string; slug: string; competition_id: string } | undefined;
    if (patch.name) {
      [before] = await tx<{ name: string; slug: string; competition_id: string }[]>`
        select name, slug, competition_id from divisions where id = ${id}`;
      if (!before) throw new HttpError(404, "division not found");
      nameBefore = before.name;
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
      if (cols.length === 0) {
        // An empty save (or one whose every field was refused alongside nothing else, which throws above before
        // reaching here) has no column to SET — `update … set  where` is a syntax error. Answer with the stored row.
        const [stored] = await q<DivisionRow[]>`select ${q(COLS)} from divisions where id = ${id}`;
        if (!stored) throw new HttpError(404, "division not found");
        return stored;
      }
      const values = {
        ...eff,
        ...(eff.tiebreakers ? { tiebreakers: q.json(eff.tiebreakers as never) } : {}),
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
    const written = !regenerating ? await update(effective, tx) : await withUniqueSlug(
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
    // batch-3 I1: under the format the division now plays, in this transaction (`award-rewrite.ts`).
    rewroteAwards = (await rewriteHeldAwards(tx, held)).length > 0;
    return written;
  }, cameraPolicyNamed ? { privilegedPrelude: cameraGate } : {}).catch((err: unknown) => {
    // Race backstop for the AGE BAND — READ COMMITTED means two concurrent
    // PATCHes can each pass the merge-and-validate guard above against a
    // stale read, then both write; whichever commits second still hits
    // divisions_age_band_check. Must not leak the raw constraint text.
    //
    // The cutoff line below does NOT buy the same thing: a one-sided orphan
    // satisfies divisions_age_cutoff_check (`false OR NULL`), so the same
    // race on the cutoff pair commits an orphan and reaches neither line.
    // That residual is known and accepted (W8/F12) — closing it needs a
    // constraint that can see the case, e.g. `num_nulls(...) <> 1`.
    if (isAgeBandCheckViolation(err)) throw new HttpError(422, AGE_MAX_BEFORE_MIN);
    if (isAgeCutoffCheckViolation(err)) throw new HttpError(422, AGE_CUTOFF_BOTH_OR_NEITHER);
    throw err;
  });
  // W2c Task 11 (carry (b) of the batch-3 re-review): a format save that re-wrote a walkover's stored score must reach
  // the public pages now, not after their cache expires (15-300 s) - the same tags `putStageRules` fires after its own
  // re-write. Synchronous and after the commit, like that one (Next flushes a request's revalidations once).
  // A variant change that re-seeded a stage's rules moved the format its public pages print (R-T12-2): the same tags.
  if (rewroteAwards || reseededStages.length > 0) fireDivisionRevalidate(row.id, row.competition_id);
  // A rename busts the cached slug resolution (old + new key) — outside the
  // tx, matching the pattern in patchCompetition.
  if (previousSlug) {
    await invalidateSlugCache("division", previousCompetitionId, previousSlug, row.slug);
  }
  const maskingChanged =
    !!maskingBefore &&
    (maskingBefore.youth !== row.youth || maskingBefore.player_name_display !== row.player_name_display);
  // Fail-open: the helper logs a failed list or DEL and never throws, so the
  // organiser's committed write stands (player-matches-cache-keys.ts).
  if (maskingChanged) {
    await retireOrgPlayerMatches(auth.orgId, { division: id });
    // Privacy hotfix (2026-09-16): a name-policy change must reach public pages
    // now, not after their TTL. The player card reads every division the person
    // plays in across the org, so it is tagged with the org, and only an org tag
    // reaches it. Only when the STORED policy changed: an org bust rebuilds the
    // org's whole public tree.
    //
    // After the retire above, so a page rebuilt by this expiry reads the match
    // lines under the NEW generation, never the old one. Fired synchronously
    // before this use-case resolves, never behind a `void`: Next flushes a
    // request's revalidations once, when the handler resolves, and drops any
    // that arrive later.
    //
    // The division tag EXPIRES here, not 'max' (final review I2): the public
    // Redis documents below are dropped, and a route rebuilding one reads
    // `pub-div-v4`. A merely stale entry is served to a route handler while it
    // refreshes in the background, which would bake the old names straight
    // back into Redis for another TTL. `fireScoreRevalidate` is exactly that
    // pair — competition 'max', then division expiry — and the org expiry
    // follows it. A policy change is rare, so the first reader rebuilding is
    // cheap.
    const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
    const fixtures = await sql<{ id: string }[]>`select id from fixtures where division_id = ${row.id}`;
    const peersExpired = fireScoreRevalidate(row.id, row.competition_id);
    if (org) fireOrgRevalidate(org.slug);
    // Every public Redis document printing this division's names: its
    // competition's hub, its schedule, standings and entrants, and each of its
    // fixtures' match-centre documents (final review I2). Dropped again in the
    // after-window once the division expiry has flushed here and reached the
    // peers (review r2-m1).
    dropNamedPublicDocuments(
      { competitionIds: [row.competition_id], divisionIds: [row.id], fixtureIds: fixtures.map((f) => f.id) },
      { divisionId: row.id },
      peersExpired,
    );
  }
  // A rename changes the name the shell lists and, with it, the slug every
  // public page of this division is found by. The name-policy block above has
  // already expired the org tag when it ran.
  if (nameBefore !== undefined && nameBefore !== row.name && !maskingChanged) {
    await expireCompetitionShell(auth.orgId, { competitionId: row.competition_id, divisionId: row.id });
  }
  // V416: seeds on or off must reach the public site now, not after a TTL —
  // turning them OFF is the organiser saying "take these numbers down". The
  // seed reaches spectators only through this division's own documents (the
  // hub's Teams cards, the division page, its entrants document; no player
  // card, org page or match centre prints one), so the division tag EXPIRES
  // with the competition tag revalidated — `fireScoreRevalidate`'s pair, for
  // the reason the name-policy block above gives — and the org tag is left
  // alone. The hub and this division's Redis documents are dropped by name.
  // Synchronous, never behind a `void`, for the same flush reason.
  if (seedsBefore !== undefined && seedsBefore !== row.show_seeds) {
    const peersExpired = fireScoreRevalidate(row.id, row.competition_id);
    dropNamedPublicDocuments(
      { competitionIds: [row.competition_id], divisionIds: [row.id], fixtureIds: [] },
      { divisionId: row.id },
      peersExpired,
    );
  }
  return { ...row, refused };
}
