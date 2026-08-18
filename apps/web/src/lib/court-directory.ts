// The court-name disambiguation rule — CLIENT-SAFE on purpose. Built for the
// schedule-ai pack (P9 pass 3d) so the model could speak court NAMES again
// after the uuid cutover; lifted out of schedule-ai.ts (P9 pass 4d) so the
// schedule board (schedule-board.tsx, a "use client" tree) can render the
// SAME "Name (Venue)" rule for its column headers / swap button / captions
// instead of re-deriving a second one — schedule-ai.ts imports "server-only"
// at its top (DB pool, credits, rate-limit, ...), so nothing in this repo's
// client bundle can import that file directly. Same split capacity-input.ts's
// own header documents for capacityInputForFixtures/capacity-guard.ts: one
// implementation, re-exported by the server-only usecase rather than copied.
//
// schedule-ai.ts re-exports `buildCourtDirectory`/`PackCourtInfo` from here
// verbatim — every existing server-side caller (buildSchedulePack,
// buildCompetitionPack, competition-schedule-ai.ts, and both golden-pack
// tests) keeps importing from "./schedule-ai" unchanged.

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** P9 pass 3d: what a consumer gets to know about a court beyond its id —
 *  `label` is the disambiguated display text; `venue`/`tags` ride alongside
 *  it for callers that want them (the AI pack's courtDetails). */
export interface PackCourtInfo {
  label: string;
  venue: string;
  tags: string[];
}

/**
 * Builds a display label for every court, venue-qualifying a bare name
 * shared by courts in different venues so no consumer is ever shown two
 * candidates it cannot tell apart (a venue's own courts are unique by name —
 * V367's `courts_venue_name_active_idx` — but nothing stops two DIFFERENT
 * venues from each naming one "Court 1").
 *
 * Deterministic on (name, venue name) alone. An id breaks a tie only as an
 * ultimate, stable last resort — for the residual case of an archived and an
 * active court sharing both a venue and a name (the unique index frees a
 * name once its court is archived) — never as the primary rule: this session
 * traced five separate defects back to "resolve by uuid ordering", and a
 * per-seed-random label would make the result non-reproducible across
 * reseeds of an otherwise identical board.
 */
export function buildCourtDirectory(
  rows: readonly { id: string; name: string; venue_name: string; tags: readonly string[] }[],
): Map<string, PackCourtInfo> {
  const countByName = new Map<string, number>();
  for (const r of rows) countByName.set(r.name, (countByName.get(r.name) ?? 0) + 1);
  const seenLabel = new Set<string>();
  const out = new Map<string, PackCourtInfo>();
  const ordered = [...rows].sort(
    (a, b) => cmp(a.name, b.name) || cmp(a.venue_name, b.venue_name) || cmp(a.id, b.id),
  );
  for (const r of ordered) {
    let label = (countByName.get(r.name) ?? 0) > 1 ? `${r.name} (${r.venue_name})` : r.name;
    while (seenLabel.has(label)) label = `${label} #${r.id.slice(0, 8)}`;
    seenLabel.add(label);
    out.set(r.id, { label, venue: r.venue_name, tags: [...r.tags] });
  }
  return out;
}
