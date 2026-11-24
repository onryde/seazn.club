import "server-only";
import type postgres from "postgres";
import { withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  chessIndividualOnlyError,
  entrantsOverrideWidensBeyondIndividual,
  isChessSport,
} from "@/lib/chess-individual-only";
import { assertWithinLimit, getLimit } from "@/lib/entitlements";
import { EngineError } from "@seazn/engine/core";
import { resolveModule } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateDivision } from "@/server/api-v1/schemas";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { assertCompetitionNotFrozen } from "../entitlement-freeze";
import { refuseConfigWriteIssues } from "../stage-rules-merge";
import { refuseCascadeForSport, refuseStrayPointsMapKeys } from "../table-rule-guards";
import { slugify, withUniqueSlug, SLUG_CONSTRAINT, RESERVED_ENTITY_SLUGS } from "../slugs";
import { expireCompetitionShell } from "@/server/public-site/revalidate";
import {
  applyOnlinePlayToConfig,
  assertOnlinePlayValue,
  divisionPlaysOnline,
  readOnlinePlay,
} from "@/server/external-play/online-play";
import {
  assertCameraPolicyForSport,
  assertCameraPolicyValue,
} from "@/server/external-play/camera-policy";
import { assertTimeControl } from "@/server/external-play/time-controls";
import type { BoardgameClockInput } from "@/server/external-play/clock";
import { assertOnlineChessOffered } from "../external-play/online-chess-flag";
import { decideOnlineSize, lockCompetitionDivisions, writeOnlineSize } from "../online-package";
import type { OnlineSize } from "@/lib/online-chess-package";
import { type DivisionRow, COLS } from "./types";
import { deriveYouth, assertCompetitionNotEnded } from "./helpers";

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
  const onlineAsked = (input.config as Record<string, unknown> | undefined)?.onlinePlay === "lichess";
  if (onlineAsked) {
    await assertOnlineChessOffered(auth);
  }
  // Online Chess (spec 2026-11-23 §7.1, P14, P17): a division created online gets its unpaid package row, at the size the
  // request names (judged against the plan's per-division cap, read out here for the same pooled-connection reason) or at 16.
  // The row is sealed, so it is written in the privileged epilogue; the size is judged in the tenant callback.
  const onlinePlanCap =
    onlineAsked && input.online_size !== undefined ? await getLimit(auth.orgId, "entrants.per_division.max", competitionId) : null;
  let onlineSize: OnlineSize | null = null;

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
    // W2e (spec §5.5, E15; VB-CF-1, TT-CF-1, TN-CF-1): the engine's write-door refusals, after its schema.
    refuseConfigWriteIssues(sportModule, input.sport_key, finalConfig);
    // W2d Task 10 (spec §5.5; Task 8 carry): a points table keyed by anything but a set score is refused at write, and
    // the division's own tie-break order is validated against the sport (`validateCascade`'s kind-independent rules:
    // every stage created under it is then asked its own kind's, `createStages`). `[]` is an order too: refused, empty.
    refuseStrayPointsMapKeys(finalConfig);
    if (input.tiebreakers !== undefined && input.tiebreakers !== null) refuseCascadeForSport(sportModule, finalConfig, input.tiebreakers);
    const inputCfg = input.config as Record<string, unknown>;
    const onlinePlay =
      inputCfg && "onlinePlay" in inputCfg
        ? assertOnlinePlayValue(input.sport_key, inputCfg.onlinePlay)
        : readOnlinePlay(null);
    applyOnlinePlayToConfig(finalConfig, onlinePlay);
    const incomingEntrants = inputCfg?.entrants;
    if (incomingEntrants != null && typeof incomingEntrants === "object") {
      // Chess is individual-only (owner ruling 2026-10-26): the entrant-shape
      // override may not widen it to pairs or teams. Nothing is stored yet, so
      // there is no legacy value to tolerate here (patchDivision does).
      if (isChessSport(input.sport_key) && entrantsOverrideWidensBeyondIndividual(incomingEntrants)) {
        throw chessIndividualOnlyError();
      }
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
      // api-v1/schemas/divisions.ts's CreateDivision; the registration hub config panel still
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
    }
    const created = input.slug
      ? await insert(input.slug, tx)
      : await withUniqueSlug(
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
    onlineSize = await decideOnlineSize(tx, {
      divisionId: created.id,
      onlineBefore: false,
      onlineAfter: divisionPlaysOnline(created),
      requested: input.online_size,
      planCap: onlinePlanCap,
    });
    return created;
  }, {
    // Review m1: SHARED, held to the commit, so a competition delete (EXCLUSIVE, its prelude's first statement) never misses a
    // division created behind its read of the list: this create commits before that read, or waits and meets no competition.
    // Every create, online or not: an over-the-board division can be switched on and paid before the delete's cascade.
    privilegedPrelude: async (ptx) => {
      await lockCompetitionDivisions(ptx, competitionId, "shared");
    },
    ...(onlineAsked || input.online_size !== undefined
      ? {
          privilegedEpilogue: async (etx: Tx, created: DivisionRow) => {
            if (onlineSize !== null) {
              await writeOnlineSize(etx, { orgId: auth.orgId, divisionId: created.id, divisionName: created.name, size: onlineSize });
            }
          },
        }
      : {}),
  });
  await expireCompetitionShell(auth.orgId, { competitionId, divisionId: row.id });
  // Activation funnel (feature 1): step after competition_created.
  await fireDivisionCreated(auth, input.sport_key, competitionId);
  return row;
}
