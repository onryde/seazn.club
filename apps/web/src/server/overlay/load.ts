// The overlay endpoint's read (design §3.2). Three reads, one authority each:
// the public row from `publicFixture` (cached, the same view the match page
// reads — visibility decided THERE, never here); the venue zone through
// `venueTzForDivision` (the VENUE lane's one query, server/venue-tz.ts); and
// the fold, inside `unstable_cache` keyed on `last_seq`, so N polls at one
// ledger position cost one fold.
//
// Throw nothing new: a 404 from the row read is the 404 the route answers, and
// a fold that cannot run is NOT an error the viewer should see (see
// `cachedFold`'s catch).
import "server-only";
import { unstable_cache } from "next/cache";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { venueTzForDivision } from "@/server/venue-tz";
import { foldFrom, loadFoldInputs, type FoldedFixture } from "@/server/engine-db/fold";
import { publicFixture } from "@/server/usecases/public";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import type { RecentDerived, RecentEvent } from "@/lib/overlay-recent-types";
import type { OverlayCricketLive } from "@/lib/overlay-cricket";
import {
  buildOverlayRecent,
  cricketPersonIdsIn,
  loadRecentPersonOf,
  nameCricketLive,
  overlayCricketLiveIds,
  personIdsIn,
  recentWindow,
  replayDerived,
} from "./recent";
import { projectOverlayLiveData } from "./project";

interface PublicRow {
  id: string;
  division_id: string;
  status: string;
  summary: OverlayLiveData["summary"];
  outcome: OverlayLiveData["outcome"];
  last_seq: number | null;
  /** Nullable on the view: a bye/TBD slot, or an entrant deleted after scoring
   *  (`on delete set null`). Both mean the ledger cannot be attributed to a
   *  side — see `recentOrEmpty`. */
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

/** Folds once per (fixture, last_seq). The fold reads the whole ledger and
 *  every module the fixture pins; at ~1 event / 36 s per T20 that is once
 *  per ledger advance, and never once per 15 s poll across every viewer.
 *
 *  `unstable_cache` inside a Route Handler is an established pattern in this
 *  app — `calendar.ics/route.ts` calls `getPublicDivision`, which is wrapped
 *  the same way (`public-site/data.ts`). It has no incremental cache OUTSIDE
 *  the Next server runtime, so a plain vitest process gets
 *  `Invariant: incrementalCache missing`; the DB-backed route test therefore
 *  stubs `next/cache` passthrough, exactly as this repo's other
 *  `unstable_cache` tests do. */
/** What one cache entry holds: the fold, and the replay's set-won / point-state
 *  annotations for the window.
 *
 *  `derived` is a plain OBJECT keyed by the sequence number as a string, not
 *  the `Map` `replayDerived` returns. `unstable_cache` SERIALISES its value,
 *  and a Map crosses that boundary as `{}` — silently, and invisibly to every
 *  test in this repo, because they all double `unstable_cache` with a
 *  passthrough that preserves it. */
interface CachedOverlay {
  folded: FoldedFixture | null;
  derived: Record<string, RecentDerived>;
  /** W2 Task 3 — the crease, WITHOUT names: every `name` field carries a PERSON
   *  ID at this point. The scorecard is the expensive half and changes only
   *  when the ledger does, so it belongs inside the cache; the NAMES do not,
   *  because consent can change with no event to invalidate on. `nameCricketLive`
   *  swaps ids for consent-resolved names on the other side. */
  cricketLive: OverlayCricketLive | null;
}

/** Folds once per (fixture, last_seq), and derives in the SAME pass. The fold
 *  reads the whole ledger and every module the fixture pins; at ~1 event / 36 s
 *  per T20 that is once per ledger advance, and never once per 15 s poll across
 *  every viewer.
 *
 *  The derivation shares this boundary rather than taking one of its own for
 *  two reasons: it needs the module, the cfg and the line-up pair, which
 *  `loadFoldInputs` has just read and which `FoldedFixture` cannot carry
 *  through a serialising cache; and a second cached call would be a second read
 *  of the same ledger.
 *
 *  `unstable_cache` inside a Route Handler is an established pattern in this
 *  app — `calendar.ics/route.ts` calls `getPublicDivision`, which is wrapped
 *  the same way (`public-site/data.ts`). It has no incremental cache OUTSIDE
 *  the Next server runtime, so a plain vitest process gets
 *  `Invariant: incrementalCache missing`; the DB-backed route test therefore
 *  stubs `next/cache` passthrough, exactly as this repo's other
 *  `unstable_cache` tests do.
 *
 *  The key is `overlay-fold-v2`: the VALUE's shape changed here, and a live
 *  entry written under the old key would deserialise as a `FoldedFixture`
 *  where this now expects a `CachedOverlay`. */
function cachedFold(fixtureId: string, lastSeq: number): () => Promise<CachedOverlay> {
  return unstable_cache(
    async () =>
      sql.begin(async (tx) => {
        const inputs = await loadFoldInputs(tx, fixtureId);
        if (inputs === null) return { folded: null, derived: {}, cricketLive: null };
        const folded = foldFrom(fixtureId, inputs);
        const { bySeq } = replayDerived({
          sportKey: inputs.sportKey,
          module: inputs.module,
          cfg: inputs.cfg,
          lineups: inputs.lineups,
          active: folded.active,
        });
        return {
          folded,
          derived: Object.fromEntries([...bySeq].map(([seq, d]) => [String(seq), d])),
          cricketLive: overlayCricketLiveIds(inputs, folded.active),
        };
      }) as Promise<CachedOverlay>,
    ["overlay-fold-v2", fixtureId, String(lastSeq)],
    { revalidate: 300 },
  );
}

/**
 * Review 2026-09-09 (I5) — the fold is BEST EFFORT, and its failure must never
 * reach the wire.
 *
 * `loadFoldInputs` throws `EngineError("WRONG_PHASE")` for a fixture with an
 * unassigned entrant (reachable whenever an entrant is deleted after scoring —
 * the FK is `on delete set null`), and `resolveModule` can throw
 * `MODULE_NOT_FOUND` for a pinned module version this build no longer ships.
 * `v1()` maps any `EngineError` through `ENGINE_HTTP` (422 by default), so
 * without this catch the overlay would go DARK mid-broadcast on a fixture
 * whose sibling endpoint `/public/fixtures/{id}` still answers 200 — it does
 * not fold at all.
 *
 * Falling through to `null` is not silent: it is logged at error level, and
 * `projectOverlayLiveData` still returns the row's own snapshot fields, so the
 * scorebug keeps showing the score and simply loses the clock / innings block.
 * A wrong clock on air is worse than no clock; a blank overlay is worse still.
 */
async function foldOrNull(fixtureId: string, lastSeq: number): Promise<CachedOverlay> {
  try {
    return await cachedFold(fixtureId, lastSeq)();
  } catch (err) {
    log.error({ err, fixtureId, lastSeq }, "overlay: fold failed, serving the row without it");
    return { folded: null, derived: {}, cricketLive: null };
  }
}

/**
 * W2 — the moment window, off the stream the fold ALREADY void-resolved
 * (`FoldedFixture.active`). No second ledger read: the events are in hand, and
 * a second `select … from score_events` would be a second authority for what
 * survived.
 *
 * BEST EFFORT, exactly like the fold above it. A missing name or an unreadable
 * line-up must cost the overlay its moments, never its scorebug — a club is on
 * air.
 *
 * The person read is SKIPPED ENTIRELY when the window names nobody, which is
 * the ordinary case at fidelity bands 0 and 1 (a goal records its side and
 * nothing else). `personIdsIn` answers that by running the real projectors, so
 * it cannot drift from what is actually published.
 */
async function recentOrEmpty(row: PublicRow, bundle: CachedOverlay): Promise<RecentEvent[]> {
  const { folded } = bundle;
  if (!folded) return [];
  const { home_entrant_id: home, away_entrant_id: away } = row;
  // Not a degrade: `foldFixture` itself throws WRONG_PHASE for an unassigned
  // entrant, so reaching here with one is impossible today. Stated rather than
  // assumed, because `sideOf` would otherwise match `undefined === undefined`
  // and credit every event to the home side.
  if (!home || !away) return [];
  try {
    const ids = personIdsIn(recentWindow(folded.active), [home, away]);
    const personOf = await loadRecentPersonOf(sql, row.id, row.division_id, ids);
    const derived = new Map(Object.entries(bundle.derived).map(([seq, d]) => [Number(seq), d]));
    return buildOverlayRecent({ active: folded.active, sides: [home, away], personOf, derived });
  } catch (err) {
    log.error({ err, fixtureId: row.id }, "overlay: recent window failed, serving without it");
    return [];
  }
}

/**
 * The crease band's NAMES (W2 Task 3), resolved outside the cache.
 *
 * The scorecard itself rides in the cached entry — it is the expensive half and
 * changes only when the ledger does. The names do not: consent can change with
 * no event to invalidate on, and a player who withdraws their name should stop
 * appearing on air at the next poll rather than at the next ball.
 *
 * This used to re-derive the whole scorecard here, and a second
 * `loadFoldInputs` with it, on EVERY poll for every viewer — which quietly made
 * this file's own "N polls at one ledger position cost one fold" promise false
 * for cricket, the one sport whose default theme is the bar. Now the only work
 * left outside the cache is one query for at most three names.
 */
async function cricketLiveOrNull(
  row: PublicRow,
  bundle: CachedOverlay,
): Promise<OverlayCricketLive | null> {
  const ids = cricketPersonIdsIn(bundle.cricketLive);
  if (bundle.cricketLive === null) return null;
  if (ids.length === 0) return nameCricketLive(bundle.cricketLive, () => undefined);
  try {
    const personOf = await loadRecentPersonOf(sql, row.id, row.division_id, ids);
    return nameCricketLive(bundle.cricketLive, personOf);
  } catch (err) {
    log.error({ err, fixtureId: row.id }, "overlay: crease names failed, serving the band unnamed");
    return nameCricketLive(bundle.cricketLive, () => undefined);
  }
}

export async function loadOverlayLiveData(fixtureId: string): Promise<OverlayLiveData> {
  const row = (await publicFixture(fixtureId)) as PublicRow;
  const venueTz = await venueTzForDivision(row.division_id);
  const bundle: CachedOverlay =
    row.last_seq === null
      ? { folded: null, derived: {}, cricketLive: null }
      : await foldOrNull(fixtureId, row.last_seq);
  const recent = await recentOrEmpty(row, bundle);
  const cricketLive = await cricketLiveOrNull(row, bundle);
  return projectOverlayLiveData({ row, folded: bundle.folded, venueTz, recent, cricketLive });
}
