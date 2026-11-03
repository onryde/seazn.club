// The new-division page's sport catalog as the builder takes it (`SportOption`): each sport with its variants, and each
// variant with its PRESET (`sport_variants.config`, which `sync:sports` writes from the engine's `variants`). Pure and
// client-safe, so the mapping the page does on its rows can be tested; the page keeps the SQL.
import type { SportOption } from "@/components/v2/division-builder";
import type { EntrantChoice } from "@/lib/division-builder/model";

export interface SportRow {
  key: string;
  name: string;
}
export interface VariantRow {
  sport_key: string;
  key: string;
  name: string;
  is_system: boolean;
  /** The variant's preset; null on a row that stores none. */
  config: Record<string, unknown> | null;
}

/**
 * W2e Task 8c (owner D19): the builder needs a variant's preset to count cricket overs in the variant's own over length
 * (`ruleContextFor`). A row with no preset carries none (`config` left off, never `{}`), so "no preset" and "an empty
 * preset" stay different things.
 */
export function sportOptionsFrom(
  sports: readonly SportRow[],
  variants: readonly VariantRow[],
  /** Match Day C9: the sport's entrant model as the engine declares it, read off the module the create will pin (the
   *  page resolves it). Undefined for a sport the page could not resolve: the builder then does not ask. */
  entrantsOf: (sportKey: string) => EntrantChoice | undefined = () => undefined,
): SportOption[] {
  return sports.map((s) => ({
    key: s.key,
    name: s.name,
    ...((e) => (e === undefined ? {} : { entrants: e }))(entrantsOf(s.key)),
    variants: variants
      .filter((v) => v.sport_key === s.key)
      .map((v) => ({ key: v.key, name: v.name, system: v.is_system, ...(v.config === null ? {} : { config: v.config }) })),
  }));
}
