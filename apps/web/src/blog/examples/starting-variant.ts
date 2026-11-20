// The variant a NEW division of a sport starts on, read from the code the builder uses: the new-division page lists a
// sport's variants `order by is_system desc, name` (page.tsx), maps them with `sportOptionsFrom`, and the builder opens
// on `pickVariant(sport.key, sport.variants)`. So the pick is the sport's preferred variant where it has one (cricket,
// tennis, ice hockey, hockey, badminton) and otherwise the first variant BY NAME - which is why a new volleyball
// division starts on Beach and a new generic one on Score. This file rebuilds the page's variant rows the way
// `sync:sports` writes them (`titleCase(key)` as the name) and hands them to the builder's own two functions; the
// ordering and the naming are pinned to their sources by blog-examples.test.ts, which reads the page and the script.
import type { AnySportModule } from "@seazn/engine/sport";
import { pickVariant } from "@/lib/preferred-variant";
import { sportOptionsFrom, type VariantRow } from "@/lib/sport-options";

/** scripts/sync-sports.ts `titleCase`, as it is written there (the test compares the source text). */
export function syncedVariantName(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The `sport_variants` rows the page reads for a module, in the page's order (`is_system desc, name`; all are system rows). */
export function pageVariantRows(module: AnySportModule): VariantRow[] {
  return Object.entries(module.variants)
    .map(([key, config]) => ({
      sport_key: module.key,
      key,
      name: syncedVariantName(key),
      is_system: true,
      config: (config ?? {}) as Record<string, unknown>,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The variant key a new division of this sport starts on. */
export function startingVariantKey(module: AnySportModule): string {
  const [option] = sportOptionsFrom([{ key: module.key, name: module.key }], pageVariantRows(module));
  return pickVariant(module.key, option!.variants);
}
