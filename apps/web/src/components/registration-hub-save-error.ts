// Registration hub config panel — maps a failed save to the field it
// belongs against (RS004 W3c). The panel writes through TWO endpoints
// (PATCH /divisions/{id}, PUT .../registration-settings) and their 422s
// arrive in two different shapes:
//
//   - a zod validation failure (400 VALIDATION, e.g. PatchDivision's
//     checkAgeBand superRefine when BOTH age_min and age_max are patched
//     together) carries `extra.issues[]`, each with a `path` array;
//   - a usecase-level `HttpError(422, "...")` (the age-band check when
//     only ONE side is sent against a stored value on the other,
//     allow_free_agents/capacity/fee/date-order guards) carries nothing
//     but a message string — no path, no field code.
//
// This is the one place that reconciles both into { field, message }, so
// the panel's error-rendering never has to know which shape it got.
import type { ApiV1Error } from "@/lib/client-v1";

/** Every field this panel writes, across both endpoints. */
export type ConfigFieldKey =
  | "category"
  | "age_min"
  | "age_max"
  | "enabled"
  | "entrant_kind"
  | "opens_at"
  | "closes_at"
  | "capacity"
  | "fee_cents"
  | "refund_lock_at"
  | "form_fields"
  | "payment_method"
  | "payment_instructions"
  | "approval"
  | "allow_free_agents";

const KNOWN_FIELDS: ReadonlySet<string> = new Set<ConfigFieldKey>([
  "category",
  "age_min",
  "age_max",
  "enabled",
  "entrant_kind",
  "opens_at",
  "closes_at",
  "capacity",
  "fee_cents",
  "refund_lock_at",
  "form_fields",
  "payment_method",
  "payment_instructions",
  "approval",
  "allow_free_agents",
]);

export interface SaveErrorInfo {
  /** Which field to show the message against; null renders as a banner. */
  field: ConfigFieldKey | null;
  message: string;
}

interface ZodIssueLike {
  path?: unknown;
  message?: unknown;
}

/** Plain-message usecase 422s (registrations.ts/divisions.ts), matched by
 *  a stable prefix/substring of the exact strings those `HttpError` calls
 *  throw today. Checked in order; first match wins. A dynamic suffix (the
 *  capacity limit's number) is deliberately left out of the pattern. */
const MESSAGE_FIELD_PATTERNS: readonly [RegExp, ConfigFieldKey][] = [
  [/age_max must be greater than or equal to age_min/i, "age_max"],
  [/allow_free_agents requires entrant_kind/i, "allow_free_agents"],
  [/before choosing card payments/i, "payment_method"],
  [/card entry fees must be at least/i, "fee_cents"],
  [/capacity exceeds your plan/i, "capacity"],
  [/closes_at must be after opens_at/i, "closes_at"],
  [/duplicate form field keys/i, "form_fields"],
];

export function mapSaveError(err: unknown): SaveErrorInfo {
  const message = err instanceof Error ? err.message : String(err);
  const extra = (err as Partial<ApiV1Error>)?.extra;
  const issues = extra?.issues;
  if (Array.isArray(issues)) {
    for (const raw of issues) {
      const issue = raw as ZodIssueLike;
      const issueMessage = typeof issue.message === "string" ? issue.message : message;
      const path = Array.isArray(issue.path) ? issue.path : [];
      const head = typeof path[0] === "string" ? path[0] : undefined;
      if (head && KNOWN_FIELDS.has(head)) {
        return { field: head as ConfigFieldKey, message: issueMessage };
      }
      // No usable path on this issue (e.g. a whole-object superRefine like
      // "duplicate form field keys") — try its OWN message against the
      // pattern table before giving up on it; the outer ApiV1Error message
      // is only ever the generic "Invalid input" for a 400 VALIDATION.
      for (const [pattern, field] of MESSAGE_FIELD_PATTERNS) {
        if (pattern.test(issueMessage)) return { field, message: issueMessage };
      }
    }
  }
  for (const [pattern, field] of MESSAGE_FIELD_PATTERNS) {
    if (pattern.test(message)) return { field, message };
  }
  return { field: null, message };
}
