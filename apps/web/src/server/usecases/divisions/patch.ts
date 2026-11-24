import "server-only";
import type postgres from "postgres";
import { sql, withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  chessIndividualOnlyError,
  entrantsOverrideWidensBeyondIndividual,
  isChessSport,
} from "@/lib/chess-individual-only";
import { requireFeature } from "@/lib/entitlements";
import { EngineError, type StageKind } from "@seazn/engine/core";
import { effectiveEntrantModel, fixtureKeysFor, type TiebreakerKey } from "@seazn/engine/sport";
import { divisionTakesKind } from "@/lib/division-entrant-kinds";
import { ENTRANT_KIND_IN_USE, REGISTRATION_KIND_IN_USE } from "@/lib/entrant-kind-refusal";
import { LIVE_UNSEATED_STATUSES } from "@/lib/registration-status";
import { resolveModule } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  AGE_MAX_BEFORE_MIN,
  AGE_CUTOFF_BOTH_OR_NEITHER,
  AGE_CUTOFF_DAY_INVALID_FOR_MONTH,
  type PatchDivision,
} from "@/server/api-v1/schemas";
// The SAME day-per-month predicate `checkAgeCutoff` validates the request
// body with — imported, never re-implemented, so a change to DAYS_IN_MONTH
// moves both layers together (F12's merge-check below).
import { isValidCutoffDay } from "@/lib/registration-rules";
import { divisionRefusals, lockedStageIdsAmong } from "../rule-locks";
import { refuseInvalidatedOverrides } from "../fixture-override-guards";
import { configWriteIssueList, refuseConfigWriteIssues, refuseInvalidatedStageRules } from "../stage-rules-merge";
import { refuseDivisionTableSave, refuseStrayPointsMapKeys, startedStagesToPin, type KeptPinned } from "../table-rule-guards";
import { pinStageTableRules, tableRulesRowsOf } from "@/server/engine-db/table-rules";
import { reseedStagePresets } from "../stage-preset-reseed";
import { heldAwards, rewriteHeldAwards, type HeldAward } from "../award-rewrite";
import { bumpMovedRules, unfrozenRules, type UnfrozenRules } from "@/server/engine-db/rules-version";
import { RULE_ERROR_STATUS, ruleErrorMessage, type RefusedField } from "@/lib/rule-errors";
import { slugify, withUniqueSlug, SLUG_CONSTRAINT, recordSlugHistory } from "../slugs";
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
import { normalizeTags } from "../venues";
import {
  applyOnlinePlayToConfig,
  assertOnlinePlayValue,
  divisionPlaysOnline,
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
} from "@/server/external-play/camera-policy";
import { anyRoundOpened } from "@/server/external-play/round-open";
import { assertTimeControl } from "@/server/external-play/time-controls";
import type { BoardgameClockInput } from "@/server/external-play/clock";
import { assertOnlinePlayFits, countOnlineHeld, openOnlineCapGuard, readPlanLimit } from "@/server/external-play/online-entrant-cap";
import { onlineChessDisabled, onlineChessOffered } from "../external-play/online-chess-flag";
import {
  applyOnlineSave,
  assertCamerasPaidFor,
  assertOnlineFormat,
  decideOnlineSize,
  derivedCameras,
  prepareOnlineSave,
  promoteWaitlistAfterMoveUp,
  type OnlineSavePrelude,
  type OnlineSaveResult,
} from "../online-package";
import type { OnlineSize } from "@/lib/online-chess-package";
import { audit } from "../audit";
import { type DivisionRow, COLS } from "./types";
import { deriveYouth } from "./helpers";

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
/** `stagesKeptPinned` (W2d Task 10, spec §5.4): the started (pinned) stages whose live table rules this save moved — they
 *  keep their pin, board order. A stage that started with no pin (an ad-hoc match on a pending stage) is pinned by the save
 *  first and listed with them (fix round 1, I1). */
/** `online` (Online Chess, spec 2026-11-23 §7.1/§7.4, review I2): what the save did to the division's package — the capacity
 *  its size write lowered and what its switch-off refund gave back and gave up — `{ capacityLoweredTo: null, refunded: null }`
 *  when it did neither. The row above is the one the tenant callback wrote, BEFORE the package epilogue: a lowered capacity
 *  lives on the registration settings, never on this row, so `capacityLoweredTo` is the only place the save reports it. */
export type PatchDivisionResult = DivisionRow & { refused: RefusedField[]; stagesKeptPinned: KeptPinned[]; online: OnlineSaveResult };

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
  // The gate below resolves against THIS division's competition: V396 made
  // `news.auto` pass-lifted (false on Free, granted on both Event Pass rungs).
  // On the pooled proxy and BEFORE `withTenant` opens — `requireFeature` is a
  // pooled read and issuing one inside a tenant transaction is the pool
  // self-deadlock (lib/db.ts).
  //
  // `auto_progress` used to ask for `formats.advanced` here (Jul3/08 §8). The
  // owner's "all stages are free" ruling (2026-10-20, V471) made auto-advance
  // free on every plan, so turning it ON needs no plan at all.
  const competitionId =
    patch.auto_posts === true
      ? (
          await sql<{ competition_id: string }[]>`
            select competition_id from divisions where id = ${id}`
        )[0]?.competition_id
      : undefined;
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
  // The online switch judges the places held against min(plan cap, 256) (cap-256 review m1): the plan's limit is an entitlement
  // read, asked out here like the flag above and only when the patch names 'lichess'. undefined for a sport that cannot play online.
  // Online Chess (spec 2026-11-23 §7.1, §7.3): a size the patch names is judged against the same plan limit, read here too.
  const onlineCapGuard =
    (patch.config as Record<string, unknown> | undefined)?.onlinePlay === "lichess" || patch.online_size !== undefined
      ? await openOnlineCapGuard(id)
      : undefined;
  // Online Chess (spec 2026-11-23 §7.1, §7.3, §7.4): a save that names online play or a size carries the division's package
  // with it — turned on, an unpaid row (at the size named, else the smallest that holds the places held); turned off, the row
  // refunded (paid), deleted (unpaid) or left (frozen); a size named, an unpaid row moved. Read and locked in the privileged
  // prelude (`division:` lock, then the money lock when there is money to return), judged in the tenant callback, written in
  // the privileged epilogue: the package table is sealed. A save that names neither touches no package. Never flag-gated.
  const onlinePatch = patch.config as Record<string, unknown> | undefined;
  const onlineNamed = (onlinePatch !== undefined && "onlinePlay" in onlinePatch) || patch.online_size !== undefined;
  const turnsOnlineOff = onlinePatch !== undefined && "onlinePlay" in onlinePatch && onlinePatch.onlinePlay !== "lichess";
  let onlinePrelude: OnlineSavePrelude | null = null;
  let onlineSize: OnlineSize | null = null;
  // Out of the epilogue through this closure (it returns void): the response's `online`.
  let onlineSaved: OnlineSaveResult = { capacityLoweredTo: null, refunded: null };
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
  // W2d Task 10 (spec §5.4): the pinned stages this save did not reach (their live layers moved, their pin did not).
  let stagesKeptPinned: KeptPinned[] = [];
  // W2c Task 11 (carry (b) of the batch-3 re-review): whether this save re-wrote a stored walkover score. Set in the
  // transaction, read after it commits.
  let rewroteAwards = false;
  // Batch-5 m-1: whether this save stored a format that is not the one it replaced (the config or the variant). Set in the
  // transaction, read after it commits - the public pages print the division's format, whichever match it moved. A variant
  // change that re-seeded a stage's rules (W2c Task 12 R-T12-2) is one: the re-seed runs only for an applied variant.
  let formatMoved = false;
  const cameraGate = async (ptx: Tx) => {
    await ptx`select pg_advisory_xact_lock(hashtext(${"division:" + id}))`;
    roundOpened = await anyRoundOpened(ptx, id, new Date());
  };
  const row = await withTenant(auth.orgId, async (tx) => {
    // Online Chess camera gate (P9, P19): set where a camera policy CHANGES (null = this save changes none): whether the division had
    // cameras before the write. Read again after the UPDATE, where a turn-on of a paid package that did not pay for them is refused.
    let camerasBefore: boolean | null = null;
    // W2c batch-3 I1: the walkovers no event records, read before a format write (`award-rewrite.ts`); none otherwise.
    let held: HeldAward[] = [];
    // W2c Task 15 fix round 1 (I-1): what every unstarted match resolves to before a format write (`rules-version.ts`);
    // undefined when the save writes no format.
    let rulesBefore: UnfrozenRules | undefined;
    const effective: Record<string, unknown> = { ...patch };
    // Not a column: the package row's (the epilogue below).
    delete effective.online_size;
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
    // W2c Task 15 (Task 2 I-1) — the format freeze's lock, EXCLUSIVE. An unstarted match freezes its format on its first
    // append (`append-event.ts`), which resolves the division config and snapshots it under a FIXTURE lock — never this
    // division's — so without this a variant or config save and a first tap interleave: the save reads no started stage
    // and commits, while the tap snapshots the OLD config, and the stage the save just reshaped is now locked to a format
    // it no longer declares. The append takes this key SHARED (only while unsnapshotted), so first taps never wait on each
    // other, only on a format save — and a format save waits for every in-flight first tap to commit before it reads
    // whether a stage has started. Global order: `division:` → stage seats → `fixture:` → `division-config:` → rows. A
    // holder of this X lock takes no stage-seat or fixture lock after it.
    if (formatEdit) {
      await tx`select pg_advisory_xact_lock(hashtext(${"division-config:" + id}))`;
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
        // Online Chess (P9, P19): what the division's stages and policies said BEFORE this write, so that after it a save that turns
        // cameras ON is asked whether the package paid for them (below, after the UPDATE).
        camerasBefore = await derivedCameras(tx, id);
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
    // RS004 review finding 1: checkAgeBand (api-v1/schemas/divisions.ts) only compares
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
    // `checkAgeCutoff` (api-v1/schemas/divisions.ts) is a `superRefine` on the request
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
    //   3. tiebreakers joined the lock in W2c (Q3), and left it in W2d (Task 10, spec §5.4): a started stage is pinned, so
    //      a division order reaches only unpinned stages, validated against each (`refuseDivisionTableSave` below).
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
        // W2e (spec §5.5, E15; VB-CF-1, TT-CF-1, TN-CF-1): the engine's write-door refusals, after its schema. Asked again
        // below of what the lock leaves, which can pair a kept value with a saved one (a kept best of 1, a saved match
        // tie-break).
        refuseConfigWriteIssues(sportModule, current.sport_key, nextConfig);
        // W2d Task 10 (Task 8 carry): a points-table key that is not a set score, refused at write — a key this save adds
        // (one already stored is the read path's to tolerate, never a reason to refuse an unrelated edit).
        refuseStrayPointsMapKeys(nextConfig, currentConfig);
        const incomingEntrants = (patch.config as { entrants?: unknown } | undefined)?.entrants;
        if (incomingEntrants != null && typeof incomingEntrants === "object") {
          // Chess is individual-only (owner ruling 2026-10-26). A chess division saved BEFORE the ruling may still hold
          // a widened override, and the Settings page re-sends the whole stored config on every save (format, entrants,
          // online play…): an override that arrives exactly as it is stored is carried, not SET, and refusing it would
          // leave a legacy division unable to save anything. Anything else that widens is a new write: refused.
          if (
            isChessSport(current.sport_key) &&
            entrantsOverrideWidensBeyondIndividual(incomingEntrants) &&
            canonicalJson(incomingEntrants) !== canonicalJson(currentConfig.entrants ?? null)
          ) {
            throw chessIndividualOnlyError();
          }
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
        tx, id, { configKeys, variant: variantChanged },
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
          // W2e (TN-CF-1, VB-CF-1, TT-CF-1): and the engine's write-door refusals of that mix, in the same shape.
          const written = configWriteIssueList(sportModule, reparsed.data);
          if (written.length > 0) {
            throw new EngineError(
              "CONFIG_INVALID",
              `invalid ${current.sport_key} config once ${refused.map((r) => r.field).join(", ")} stay as stored`,
              { issues: written, refused },
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
      // A tiebreakers change that is in the patch and differs from what is stored is written (`effective.tiebreakers`; W2d:
      // never refused by the lock), so it counts exactly as `otherColumn` and `configApplied` do.
      // A VARIANT change needs no such term: the lock refuses it on the first started stage, and every other refusal also
      // needs a started stage, so once anything is refused a changed variant was refused with it.
      const lockable = new Set(["variant_key", "config", "tiebreakers"]);
      const otherColumn = Object.entries(patch).some(([k, v]) => v !== undefined && !lockable.has(k));
      // W2d Task 10: no stage locks the order any more (a started stage is pinned), so a changed order always lands.
      const tiebreakersApplied = tiebreakersChanged;
      if (refused.length > 0 && !otherColumn && !configApplied && !tiebreakersApplied) {
        const first = refused[0]!;
        // Final review M2: the format-lock sentence sends the organiser to change individual unstarted matches - advice
        // only a stage whose matches take a format of their own can follow. Read off the sport's declaration for that
        // stage's kind and the division's variant (`fixtureKeysFor`: no match-scope key, chess today, means none), and
        // said to a client as `match_edits`.
        let matchEdits: boolean | undefined;
        if (first.code === "DIVISION_FORMAT_LOCKED") {
          const [lockedStage] = await tx<{ kind: StageKind }[]>`select kind from stages where id = ${first.stageId}`;
          const module_ = sportModule ?? resolveModule(current.sport_key, current.module_version);
          matchEdits = fixtureKeysFor(module_, lockedStage?.kind ?? null, current.variant_key).length > 0;
        }
        throw new HttpError(
          RULE_ERROR_STATUS[first.code],
          ruleErrorMessage(first.code, { stage: first.stageName, field: first.field, matchEdits }),
          first.code,
          matchEdits === undefined ? { refused } : { refused, match_edits: matchEdits },
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
        // Online Chess runs Swiss and knockout only (spec 2026-11-23 §7.6, P16): a division holding a league, a group, a ladder or an
        // americano cannot turn online play on, 422 ONLINE_FORMAT_NOT_SUPPORTED naming the first such stage by seq. The same off ->
        // lichess transition as the two gates around it, so a legacy online division holding a league stays readable and saves.
        if (readOnlinePlay(nextConfig) === "lichess" && readOnlinePlay(currentConfig) !== "lichess") {
          const stored = await tx<{ kind: string }[]>`select kind from stages where division_id = ${id} order by seq`;
          assertOnlineFormat(stored.map((s) => s.kind));
        }
        // Owner ruling 2026-11-21 (256 since 2026-11-23): an online chess division holds at most min(plan cap, 256) entrants (the plan
        // asked since cap-256 review m1), so a division already holding more cannot be turned online. Only the same off -> lichess transition (a re-send of a stored 'lichess' or turning it off is never gated, for a division
        // saved before the cap must still save), counted as every online-cap door counts: the places the division HOLDS - live entrants
        // plus sign-ups already let in (review C1: 200 pending sign-ups and no entrants used to pass, then materialise made 200). The
        // `division:` lock is held here (the config save and the camera gate both took it above), so the count cannot move under it.
        if (readOnlinePlay(nextConfig) === "lichess" && readOnlinePlay(currentConfig) !== "lichess") {
          // Fails closed when the plan was never read (re-review n2): an unread plan is not an unlimited one.
          assertOnlinePlayFits(await countOnlineHeld(tx, id), readPlanLimit(onlineCapGuard));
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
          if (!divisionTakesKind(nextModel.kinds, kind)) {
            throw new HttpError(
              422,
              `entrants of kind '${kind}' already exist — withdraw them first`,
              ENTRANT_KIND_IN_USE,
              { kind },
            );
          }
        }
        // FU1 fix round 1 (I1, owner 2026-11-04): nor may it strand LIVE registrations of the kind it takes out. Since FU1
        // the doors that seat an entry (approve, mark paid, promote, the checkout webhook) refuse a kind the division no
        // longer takes, so a paid entry of a removed kind would sit captured with no seat. Live = pending, paid or
        // waitlisted, or a confirmed solo sign-up (no entrant yet). Asked only of a kind this save REMOVES (the stored
        // model takes it, the next does not): a division already holding a mismatched setting - legacy data, m5 - must
        // not be refused an unrelated save, since every Entrants and format save re-sends the whole config. No settings
        // row ⇒ no registration was ever submitted (submit needs an enabled row), so there is nothing to strand.
        const [settings] = await tx<{ entrant_kind: string }[]>`
          select entrant_kind from registration_settings where division_id = ${id}`;
        if (settings !== undefined) {
          const kind = settings.entrant_kind;
          const currentModel = effectiveEntrantModel(sportModule.entrantModel ?? null, currentConfig);
          if (divisionTakesKind(currentModel.kinds, kind) && !divisionTakesKind(nextModel.kinds, kind)) {
            const [{ count }] = await tx<{ count: number }[]>`
              select count(*)::int as count from registrations
              where division_id = ${id}
                and (status in ${tx([...LIVE_UNSEATED_STATUSES])} or (status = 'confirmed' and entrant_id is null))`;
            if (count > 0) {
              throw new HttpError(
                422,
                `${count} live registration(s) of kind '${kind}' are still waiting — withdraw or reject them first`,
                REGISTRATION_KIND_IN_USE,
                { kind, count },
              );
            }
          }
        }
        effective.variant_key = variantRefusal ? current.variant_key : (patch.variant_key ?? current.variant_key);
        effective.config = tx.json(nextConfig as never);
        // W2c Task 11 (batch-1 I-A): no stage that carries its own rules may be left invalid by this config - asked
        // only when the save really moves the config (an unchanged one leaves every stage exactly as it was valid) or the
        // variant (Task 12, M1: the keys a stage may carry are the variant's, so a stored one can stop being settable).
        const variantApplied = variantChanged && variantRefusal === undefined;
        formatMoved = configApplied || variantApplied;
        // W2c batch-3 I1: the walkovers no event records, as they resolve BEFORE this save's first write (the re-seed
        // below is one) — re-written after it.
        held = await heldAwards(tx, tx`division_id = ${id}`);
        // W2c Task 15 fix round 1 (I-1): read at the same point, under this save's `division-config:` EXCLUSIVE lock, so no
        // first event freezes between it and the bump after the write.
        rulesBefore = await unfrozenRules(tx, { divisionId: id });
        // W2c Task 12 fix round 1 (R-T12-2): a variant change re-seeds the presets its unstarted stages still store
        // (`stage-preset-reseed.ts`), BEFORE the stages are re-asked below, so only a key the organiser chose meets the
        // new variant's allowlist. A refusal below rolls the re-seed back with the rest of the save.
        if (variantApplied) {
          await reseedStagePresets(tx, {
            divisionId: id, module: sportModule, fromVariant: current.variant_key, toVariant: effective.variant_key as string, actorId: auth.userId,
          });
        }
        if (configApplied || variantApplied) {
          await refuseInvalidatedStageRules(tx, id, nextConfig, sportModule, current.sport_key, variantApplied ? (effective.variant_key as string) : null);
        }
        // W2c Task 14 (I-A one layer up): no unstarted match's own format may be left invalid by this config.
        await refuseInvalidatedOverrides(tx, id, nextConfig, sportModule, effective.variant_key as string);
      }
      // W2d Task 10 (spec §5.4, §5.5; D8, D9; X-TB-5, FB-TB-4): the order and config this save leaves, asked of every stage
      // of the division as the loader reads it (`tableRulesOf`) — a new order against the sport, then each UNPINNED table
      // stage's order on its own kind (a football `fairPlay` flip re-asks them all), and every stage's points against what
      // its matches can now reach. A pinned stage is not reached: it is listed in `stagesKeptPinned`. Asked only when the
      // save really moves the config or the order (an unchanged one leaves every stage as it stood).
      //
      // Fix round 1 (I1): a stage that STARTED without a pin (an ad-hoc match scored on a pending table stage) and that
      // this save reaches is pinned FIRST, with the rules it reads now, in this transaction and under this save's locks —
      // the division row is written further down, so the pin reads the stored layers — and is then a pinned stage like
      // any other: not asked, and listed in `stagesKeptPinned`. A refusal below rolls the pin back with the save.
      if (configApplied || tiebreakersChanged) {
        const module_ = sportModule ?? resolveModule(current.sport_key, current.module_version);
        const nextOrder = (patch.tiebreakers !== undefined ? patch.tiebreakers : current.tiebreakers) as TiebreakerKey[] | null;
        const leaves = { config: configApplied && nextConfig !== undefined ? nextConfig : currentConfig, tiebreakers: nextOrder };
        const rows = await tableRulesRowsOf(tx, { divisionId: id });
        const unpinned = rows.filter((s) => s.row.pin === null || s.row.pin === undefined).map((s) => s.row.stageId);
        const toPin = startedStagesToPin(module_, rows, await lockedStageIdsAmong(tx, unpinned), leaves);
        for (const s of toPin) await pinStageTableRules(tx, s.row.stageId);
        const stages = toPin.length === 0 ? rows : await tableRulesRowsOf(tx, { divisionId: id });
        stagesKeptPinned = refuseDivisionTableSave(module_, stages, { ...leaves, orderSaved: tiebreakersChanged });
      }
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
    // Online Chess (spec 2026-11-23 §7.6, P9, P19): a camera policy that TURNS cameras ON for a division whose package is paid
    // without them is refused 422 ONLINE_CAMERAS_NEED_UPGRADE, the write rolling back with it. Judged on the derived state after the
    // write (a stage's own policy counts), only on a transition off -> on (a save that leaves cameras on, or turns them off, is
    // never asked), and only while the package is unfrozen. The division lock was taken by the camera prelude.
    // Not asked of a save that turns online play OFF (fix round 1, M-1): switching off is never refused, the package is refunded in
    // the epilogue, and a camera policy stored alongside it has no package left to be priced against.
    if (camerasBefore === false && !turnsOnlineOff) await assertCamerasPaidFor(tx, [id]);
    // batch-3 I1: under the format the division now plays, in this transaction (`award-rewrite.ts`).
    rewroteAwards = (await rewriteHeldAwards(tx, held)).length > 0;
    // W2c Task 15 fix round 1 (I-1): every unstarted match whose format this save moved gets a new version, so a pad open
    // on it before the save is refused on its first tap (409 FIXTURE_RULES_CHANGED) and reloads the format it will play.
    if (rulesBefore !== undefined) await bumpMovedRules(tx, rulesBefore);
    if (onlineNamed) {
      // Judged on the division as written (a refused or re-sent onlinePlay lands as stored), under the prelude's lock.
      const onlineAfter = divisionPlaysOnline(written);
      onlineSize = await decideOnlineSize(tx, {
        divisionId: id,
        onlineBefore: onlinePrelude!.storedOnline,
        onlineAfter,
        requested: patch.online_size,
        // Fails closed (readPlanLimit): asked only of a size named for a division that plays online, whose guard was read.
        planCap: patch.online_size !== undefined && onlineAfter ? readPlanLimit(onlineCapGuard) : null,
      });
    }
    return written;
  }, {
    ...(cameraPolicyNamed || onlineNamed
      ? {
          privilegedPrelude: async (ptx: Tx) => {
            if (cameraPolicyNamed) await cameraGate(ptx);
            if (onlineNamed) onlinePrelude = await prepareOnlineSave(ptx, { orgId: auth.orgId, divisionId: id, turnsOff: turnsOnlineOff });
          },
        }
      : {}),
    ...(onlineNamed
      ? {
          privilegedEpilogue: async (etx: Tx, written: DivisionRow) => {
            onlineSaved = await applyOnlineSave(etx, { orgId: auth.orgId, division: written, prelude: onlinePrelude!, size: onlineSize });
          },
        }
      : {}),
  }).catch((err: unknown) => {
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
  // P18 (Online Chess credits): an unpaid size moved UP by this save made room, so the waitlist is promoted into it - after the
  // commit, best-effort, and only for a division that already had a live size (turning online play on with a default size is not a
  // move). `onlinePrelude.liveSize` is the size read under the division lock before the write.
  // (Both are assigned inside the write's closures, which control-flow analysis cannot see: read back through their declared types.)
  const priorSize = (onlinePrelude as OnlineSavePrelude | null)?.liveSize ?? null;
  const decidedSize = onlineSize as OnlineSize | null;
  if (decidedSize !== null && priorSize !== null && decidedSize > priorSize) await promoteWaitlistAfterMoveUp(row.id, auth.userId);
  // W2c Task 11 (carry (b) of the batch-3 re-review): a format save that re-wrote a walkover's stored score must reach
  // the public pages now, not after their cache expires (15-300 s) - the same tags `putStageRules` fires after its own
  // re-write. Synchronous and after the commit, like that one (Next flushes a request's revalidations once).
  // A variant change that re-seeded a stage's rules moved the format its public pages print (R-T12-2): the same tags.
  // Batch-5 m-1: and so does ANY stored format change - a config-only save that re-wrote no walkover and re-seeded no
  // stage still moved the hub's format line, the stage chips and the match centre; `putStageRules` and the per-match
  // writer always fire, this door fired only on the two cases above. The re-seed is covered by `formatMoved`.
  if (formatMoved || rewroteAwards) fireDivisionRevalidate(row.id, row.competition_id);
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
    // `pub-div-v5`. A merely stale entry is served to a route handler while it
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
  return { ...row, refused, stagesKeptPinned, online: onlineSaved };
}
