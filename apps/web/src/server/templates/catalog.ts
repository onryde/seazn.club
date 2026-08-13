// Template catalog loader (D1a design doc): curated built-ins only — no
// user-generated templates, no sharing (owner ruling 2026-08-13). Every
// entry is zod-parsed at MODULE INIT, so a broken catalog file fails to
// import at all rather than shipping a template that 500s at instantiation.
//
// NOT server-only — see schema.ts's header. The create-competition wizard's
// gallery imports this directly for the launch set's structure (division/
// stage shape, entrant counts), the same way format-gallery.tsx is
// client-safe.
import { CompetitionTemplate } from "./schema";
import slam128 from "./catalog/slam128.json";
import swiss11 from "./catalog/swiss11.json";
import wc32 from "./catalog/wc32.json";
import americanoNight from "./catalog/americano-night.json";
import boxLeague from "./catalog/box-league.json";

const RAW_CATALOG: unknown[] = [slam128, swiss11, wc32, americanoNight, boxLeague];

/** The P4 launch set (5 of the design doc's 8 — the other 3, euro24/
 *  t20-super8/league-playoff, need P7's StageSeeding). Parsed once here;
 *  a malformed entry throws at import time, not at request time. */
export const TEMPLATE_CATALOG: CompetitionTemplate[] = RAW_CATALOG.map((raw) =>
  CompetitionTemplate.parse(raw),
);

export function getTemplate(key: string): CompetitionTemplate | null {
  return TEMPLATE_CATALOG.find((t) => t.key === key) ?? null;
}
