// The new-division page's sport catalog as the builder takes it (`SportOption`): each sport with its variants, and each
// variant with its PRESET (`sport_variants.config`, which `sync:sports` writes from the engine's `variants`). Pure and
// client-safe, so the mapping the page does on its rows can be tested; the page keeps the SQL.
import type { SportOption } from "@/components/v2/division-builder";

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
export function sportOptionsFrom(sports: readonly SportRow[], variants: readonly VariantRow[]): SportOption[] {
  return sports.map((s) => ({
    key: s.key,
    name: s.name,
    variants: variants
      .filter((v) => v.sport_key === s.key)
      .map((v) => ({ key: v.key, name: v.name, system: v.is_system, ...(v.config === null ? {} : { config: v.config }) })),
  }));
}
