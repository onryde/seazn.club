import { resolvePositions } from "@seazn/engine/sport";
import type { AnySportModule, PositionCatalog } from "@seazn/engine/sport";

/**
 * The position catalog that governs THIS division's fixtures.
 *
 * R7 B2. `resolvePositions` (`packages/engine/src/sport/catalog.ts`, W4/#407)
 * is the engine's single resolution point — "no caller should read
 * `.positions` once it has a parsed config in hand" — and until this it had
 * zero production callers. Every page bootstrap read `sportModule.positions`
 * directly, so the per-config half never ran in the product, and it is the
 * only half a competition can move:
 *
 *   * football's small-sided codes field fewer than eleven (`Cfg.teamSize`);
 *   * cricket's `playersPerSide` moves the starting count;
 *   * hockey and ice hockey drop the keeper group's `min` to 0 when the
 *     competition declares `goalkeeper: "optional"` (FIH Rule 4 — a side may
 *     play out with no goalkeeper at all).
 *
 * `divisions.config` (and a device-link fixture's own `config` column) is
 * already the resolved, schema-parsed variant cfg — `usecases/divisions.ts`
 * materialises every `.default()` at write time — so the parse below
 * ordinarily succeeds. It is re-parsed rather than trusted because
 * `positionsFor` is handed straight to a sport module, and a stale row must
 * not reach it half-shaped.
 *
 * Never throws: a page that cannot parse its own stored config falls back to
 * the static catalog and renders, exactly as `resolveScorePadBootstrap`
 * returns `null` rather than 500 the page for the same reason.
 */
export function lineupCatalogFor(module: AnySportModule, rawConfig: unknown): PositionCatalog {
  try {
    return resolvePositions(module, module.configSchema.parse(rawConfig));
  } catch {
    return module.positions;
  }
}
