import "server-only";
// Pure helpers: token prefix and hash, fee math, #402 link policy, form answers (see ./index.ts).
import { createHash } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getLimit } from "@/lib/entitlements";
import { platformFeeDefault } from "@/lib/platform-settings";
import type { RegistrationFormField } from "@/server/api-v1/schemas";
import { ageAt, isMinor, requiresDob } from "../registration-eligibility";

// ---------------------------------------------------------------------------
// Pure helpers — fee math, form validation, #402 submit-linking policy
// (unit-tested directly). Eligibility itself (age/gender rules, first-class
// category/age columns, roster composition) lives in
// `./registration-eligibility` — re-exported below, verbatim, for every
// existing importer.
// ---------------------------------------------------------------------------

export const REGISTRATION_TOKEN_PREFIX = "rg_";

/** The platform cut for THIS org + competition (v3/07 §2 fee row), resolved in
 *  order: per-org override → the plan's `registration.fee_percent` entitlement
 *  → the admin-set platform default (spec §1).
 *
 *  No rate is written here on purpose. The ladder lives in `plan_entitlements`
 *  and this function reads it, so a number in this comment is a copy that can
 *  only drift — and had: it read "pro 2, event-pass 5" from V310 until V398
 *  re-cut the ladder underneath it. To learn the live rates, query that table
 *  or read the newest migration that writes `registration.fee_percent`.
 *
 *  `<= 0` falls through to the default alongside `null` on purpose: a plan row
 *  of 0 means "this plan sets no rate", never "this plan is free" — the same
 *  reading `effectiveFeePercentFor` below depends on for its lock check. */
export async function feePercentFor(orgId: string, competitionId?: string): Promise<number> {
  const pct = await getLimit(orgId, "registration.fee_percent", competitionId);
  return pct == null || pct <= 0 ? platformFeeDefault() : pct;
}

/**
 * The rate a charge in THIS competition must use (V312).
 *
 * Once a competition has taken a paid entry its rate is locked
 * (`competitions.fee_percent`) and every later entry pays that same rate, immune
 * to any plan change or group detach that happens mid-competition. Until then
 * the rate is live, so an organiser can still fix their plan before sales open.
 *
 * The lock can be 0 in only one impossible case (a plan row of 0), which
 * `feePercentFor` already treats as "unset"; a locked rate is always a real
 * charged percent, so `> 0` is the correct guard for "is it locked".
 */
export async function effectiveFeePercentFor(
  competitionId: string,
  orgId: string,
): Promise<number> {
  const [c] = await sql<{ fee_percent: number | null }[]>`
    select fee_percent from competitions where id = ${competitionId}`;
  if (c?.fee_percent != null && c.fee_percent > 0) return c.fee_percent;
  return feePercentFor(orgId, competitionId);
}

/** application_fee_amount for a destination charge. Never exceeds the fee. */
export function applicationFeeCents(feeCents: number, percent: number): number {
  return Math.min(feeCents, Math.round((feeCents * percent) / 100));
}

export function hashRegistrationToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * #402 — the session captured onto `registrations.user_id`, or null.
 *
 * The session is captured ONLY under an explicit affirmation, from a registrant
 * whose own dob proves them an ADULT, with no guardian field filled in. Each
 * clause is load-bearing:
 *
 *  - Affirmation, because a guardian, a spouse and a team captain are all
 *    signed in too; being signed in is never enough on its own.
 *  - A PRESENT dob, because `dob` is nullish: a parent entering two children
 *    with no dob triggers no guardian requirement anywhere, so an affirmation
 *    alone would link both siblings to one account and fuse them into one
 *    persons row — the exact harm `contact_email` was rejected for.
 *  - ADULT, because a minor's date of birth is guardian territory whether or
 *    not the guardian fields were filled in. `submitRegistration` also refuses
 *    that submission with a 422, but the invariant must not depend on that
 *    refusal staying where it is.
 *
 * The veto lives server-side so a forged request cannot reach the person
 * resolver; the schema's matching rule is only the useful error message.
 *
 * Orphaned by the RS001 registration demolition — its only caller,
 * `submitRegistration`, is deleted (the public submit route is gone until
 * RS003). Kept, with its schema coupling removed, because the #402 rule
 * itself is unchanged and RS002/RS003 need it verbatim for the new
 * group-shaped submit flow.
 */
export function deriveLinkUserId(
  sessionUserId: string | null,
  input: {
    registering_self?: boolean;
    guardian_name?: string | null;
    guardian_consent?: boolean;
    dob?: string | null;
  },
  now: Date,
): string | null {
  if (!sessionUserId) return null;
  if (!input.registering_self) return null;
  if (!input.dob || isMinor(input.dob, now)) return null;
  if (input.guardian_name || input.guardian_consent) return null;
  return sessionUserId;
}

// `ageAt`, `isMinor`, `requiresDob` moved to `./registration-eligibility`
// (RS002 wave 2) — imported above for local use (`isMinor` by
// `deriveLinkUserId`, `requiresDob` by `publicRegistrationInfo` below) and
// re-exported here verbatim so every existing importer of this file keeps
// compiling unchanged. The legacy `eligibilityIssues` string[] wrapper that
// used to be part of this trio was deleted at its source (RS002 W5
// whole-branch review — zero production callers repo-wide); nothing here
// re-exports it any more.
export { ageAt, isMinor, requiresDob };

/** Validate answers against the bounded form definition; returns the kept
 *  subset (unknown keys dropped — the form is the contract). */
export function validateAnswers(
  fields: RegistrationFormField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const f of fields) {
    const v = answers[f.key];
    const empty = v === undefined || v === null || v === "";
    if (f.required && (empty || v === false)) {
      throw new HttpError(422, `"${f.label}" is required`);
    }
    if (empty) continue;
    if (f.kind === "checkbox") {
      if (typeof v !== "boolean") throw new HttpError(422, `"${f.label}" must be true/false`);
      kept[f.key] = v;
    } else if (f.kind === "select") {
      if (typeof v !== "string" || !(f.options ?? []).includes(v)) {
        throw new HttpError(422, `"${f.label}" must be one of the offered options`);
      }
      kept[f.key] = v;
    } else {
      if (typeof v !== "string" || v.length > 1000) {
        throw new HttpError(422, `"${f.label}" must be text (max 1000 chars)`);
      }
      kept[f.key] = v;
    }
  }
  return kept;
}
