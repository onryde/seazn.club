// Template catalog loader (D1a design doc): curated built-ins only — no
// user-generated templates, no sharing (owner ruling 2026-08-13). Every
// entry is zod-parsed at MODULE INIT, so a broken catalog file fails to
// import at all rather than shipping a template that 500s at instantiation.
//
// `server-only`, corrected from an earlier "client-safe, like format-
// gallery.tsx" design (e2e caught it, not tsc/vitest): this module
// VALUE-imports schema.ts's CompetitionTemplate, which VALUE-imports
// StageKind from api-v1/schemas.ts, which imports HardConstraint from
// @seazn/engine/scheduling — a barrel that also reaches the gRPC placement
// client (@grpc/grpc-js, Node-only). A Server Component can still import
// this fine (it never ships to the browser); the wizard's gallery client
// island receives the parsed catalog as a PROP from the page instead — see
// components/v2/template-gallery.tsx's header.
import "server-only";
import { CompetitionTemplate } from "./schema";
import slam128 from "./catalog/slam128.json";
import swiss11 from "./catalog/swiss11.json";
import wc32 from "./catalog/wc32.json";
import americanoNight from "./catalog/americano-night.json";
import boxLeague from "./catalog/box-league.json";
import euro24 from "./catalog/euro24.json";
import t20Super8 from "./catalog/t20-super8.json";
import leaguePlayoff from "./catalog/league-playoff.json";

const RAW_CATALOG: unknown[] = [
  slam128,
  swiss11,
  wc32,
  americanoNight,
  boxLeague,
  euro24,
  t20Super8,
  leaguePlayoff,
];

/** The full 8-template design-doc catalog: P4's 5 (slam128/swiss11/wc32/
 *  americano-night/box-league) plus P7's 3 (euro24/t20-super8/
 *  league-playoff), the ones that needed D4's StageSeeding (schema.ts) to
 *  express cross-stage qualification. Parsed once here; a malformed entry
 *  throws at import time, not at request time. */
export const TEMPLATE_CATALOG: CompetitionTemplate[] = RAW_CATALOG.map((raw) =>
  CompetitionTemplate.parse(raw),
);

export function getTemplate(key: string): CompetitionTemplate | null {
  return TEMPLATE_CATALOG.find((t) => t.key === key) ?? null;
}
