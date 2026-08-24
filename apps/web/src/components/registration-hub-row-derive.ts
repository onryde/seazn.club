// Registration hub — Settings tab row derivations (RS004 W3, design §5):
// the window label, the capacity meter, and the category/age badges. Pure
// and dependency-light (only lib/format's Intl wrappers) so every boundary
// is unit-testable without a DB row.
import { fmtDateTime, fmtZoneAbbrev } from "@/lib/format";

// Mirrors `DivisionCategory` (server/api-v1/schemas.ts's
// `z.enum(["open","mens","womens","mixed"])`) as a plain literal union —
// deliberately not imported from there: this is a presentational derivation
// and has no business depending on the zod schema module.
export type DivisionCategoryValue = "open" | "mens" | "womens" | "mixed";

// ---------------------------------------------------------------------------
// Window — rendered in the ORG timezone (never browser/server-local; that
// was the deleted form's bug). Returns DATA, not a finished sentence: the
// caller picks the i18n template by `kind` so the phrasing stays
// translatable instead of being baked into English here.
// ---------------------------------------------------------------------------

export type RegistrationWindowKind = "none" | "opens" | "closes" | "range";

export interface RegistrationWindowLabel {
  kind: RegistrationWindowKind;
  /** Formatted in `orgTz`, e.g. "15 Jan 2026, 15:30". Present for "opens"/"range". */
  opens?: string;
  /** Formatted in `orgTz`. Present for "closes"/"range". */
  closes?: string;
  /** Short zone label at the relevant instant, e.g. "IST", "BST" — always
   *  set (even for "none", so a caller can still show "no window (IST)" if
   *  it wants to), derived from whichever bound exists, or now(). */
  zone: string;
}

export function formatRegistrationWindow(
  opensAt: Date | string | null,
  closesAt: Date | string | null,
  orgTz: string,
): RegistrationWindowLabel {
  const zoneAt = opensAt ?? closesAt ?? new Date();
  const zone = fmtZoneAbbrev(orgTz, zoneAt);
  if (opensAt && closesAt) {
    return { kind: "range", opens: fmtDateTime(orgTz, opensAt), closes: fmtDateTime(orgTz, closesAt), zone };
  }
  if (opensAt) return { kind: "opens", opens: fmtDateTime(orgTz, opensAt), zone };
  if (closesAt) return { kind: "closes", closes: fmtDateTime(orgTz, closesAt), zone };
  return { kind: "none", zone };
}

// ---------------------------------------------------------------------------
// Capacity meter — count/capacity. `capacity` is nullable (unlimited) both
// when explicitly unset and when the division has no registration_settings
// row yet; a non-positive capacity (the DB CHECK forbids it, but a LEFT
// JOIN default must not trust that) is treated the same way defensively.
// ---------------------------------------------------------------------------

export interface CapacityMeterView {
  count: number;
  capacity: number | null;
  /** 0-100, clamped; null when there is no capacity to measure against —
   *  never NaN, never a divide-by-zero. */
  percent: number | null;
}

export function deriveCapacityMeter(count: number, capacity: number | null): CapacityMeterView {
  if (capacity === null || capacity <= 0) return { count, capacity, percent: null };
  const percent = Math.min(100, Math.round((count / capacity) * 100));
  return { count, capacity, percent };
}

// ---------------------------------------------------------------------------
// Category badge — `divisions.category` (DivisionCategory: open|mens|womens|
// mixed). Null means "no restriction set", which reads the same as the
// enum's own explicit "open" — never the literal word "null".
// ---------------------------------------------------------------------------

export function resolveDivisionCategory(
  category: DivisionCategoryValue | null,
): DivisionCategoryValue {
  return category ?? "open";
}

// ---------------------------------------------------------------------------
// Age badge — `divisions.age_min`/`age_max`. Either bound alone is a valid,
// meaningful one-sided band (a floor with no ceiling, or vice versa).
// ---------------------------------------------------------------------------

export type AgeBandView =
  | { kind: "none" }
  | { kind: "min"; min: number }
  | { kind: "max"; max: number }
  | { kind: "range"; min: number; max: number };

export function deriveAgeBand(ageMin: number | null, ageMax: number | null): AgeBandView {
  if (ageMin !== null && ageMax !== null) return { kind: "range", min: ageMin, max: ageMax };
  if (ageMin !== null) return { kind: "min", min: ageMin };
  if (ageMax !== null) return { kind: "max", max: ageMax };
  return { kind: "none" };
}
