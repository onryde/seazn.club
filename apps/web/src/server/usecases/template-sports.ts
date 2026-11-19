import "server-only";
// The sport catalogue an any-sport gallery template's sheet chooses from (W5 X-BD-3): every sport with its variants and
// the entrant kinds its module plays, as the new-division page hands the builder. System rows are tenant-readable and an
// org's own presets are scoped by RLS (doc 07); the entrant model comes off the module a create would pin
// (`module_version`), so a sport the sheet offers is one `createFromTemplate` can build on.
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { withTenant } from "@/lib/db";
import { sportOptionsFrom, type VariantRow } from "@/lib/sport-options";
import type { SportOption } from "@/components/v2/division-builder";
import { resolveModule } from "@/server/engine-db";

export async function templateSportOptions(orgId: string): Promise<SportOption[]> {
  return withTenant(orgId, async (tx) => {
    const sportRows = await tx<{ key: string; name: string; module_version: string }[]>`
      select key, name, module_version from sports order by name`;
    const variantRows = await tx<VariantRow[]>`
      select sport_key, key, name, is_system, config from sport_variants order by is_system desc, name`;
    const versionOf = new Map(sportRows.map((r) => [r.key, r.module_version]));
    return sportOptionsFrom(sportRows, variantRows, (key) => {
      const version = versionOf.get(key);
      if (version === undefined) return undefined;
      try {
        const model = effectiveEntrantModel(resolveModule(key, version).entrantModel ?? null, null);
        return { kinds: model.kinds, defaultKind: model.defaultKind };
      } catch {
        // A sport row with no shipped module: it says no kind, and the sheet does not offer it.
        return undefined;
      }
    });
  });
}
