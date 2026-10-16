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

/** What `benchRefusal` reports: how many bench rows the sheet carried. */
export interface BenchRefusal {
  benchRows: number;
}

/**
 * Does this catalog refuse the bench rows a lineup carries? Only a catalog that
 * DECLARES `benchMax: 0` does (boardgame, carrom, generic): it is saying the sport
 * has no bench at all, so a bench row is never a substitute the engine will use,
 * only a row the stats folds used to credit with a match nobody played. The limit
 * is read off the resolved catalog (`lineupCatalogFor`), never off a sport name.
 *
 * Owner scope, 2026-10-16: ZERO only. A bench over a POSITIVE `benchMax` stays the
 * soft `bench_size` warning `validateLineup` raises (an organiser may knowingly name
 * a longer bench), and an undeclared `benchMax` is no limit at all. Widening this to
 * `benchRows > benchMax` is a separate decision.
 *
 * Counts every `slot: "bench"` row whatever its role, the same way `validateLineup`
 * counts them when it warns.
 */
export function benchRefusal(catalog: PositionCatalog, slots: readonly { slot: string }[]): BenchRefusal | null {
  if (catalog.lineup.benchMax !== 0) return null;
  const benchRows = slots.filter((slot) => slot.slot === "bench").length;
  return benchRows > 0 ? { benchRows } : null;
}
