// W5 follow-ups C (owner 2026-11-23, Option A "by round"): the competition hub's Matches tab for a BIG division. The cached hub document
// keeps every match (it is the one source); what a page or a poll is SERVED is windowed here - a division over the paging line keeps the
// matches of its open rounds (Option A's `planRounds`: live, next, the part-played frontier) and every bracket match (a knockout view
// names its fixtures and must find them, `CompetitionHubDoc`'s refinement), and its other rounds go as `roundPages` headers with their
// counts. A folded round's cards are read from the same cached document on a tap (`[divisionSlug]/hub-rounds/route.ts`). Pure.
import { pagesByRound, planRounds, type PlannedRound, type RoundBuckets } from "@/lib/round-paging";
import type { CompetitionHubDocT, HubMatchT } from "@/server/public-site/competition-hub-schema";

/** One round of a paged division, as the Matches tab heads it. `open`: its matches are in the served document. */
export interface HubRoundPage extends PlannedRound {
  divisionId: string;
  divisionSlug: string;
  stageName: string;
  roundNo: number;
  /** The round's role label (`roundRoleLabel`, resolved in the org's locale); null when it has none beyond its number. */
  label: string | null;
}

/** A round's key, stable for a document: the division, the stage's name, the round number. */
export const hubRoundKey = (m: Pick<HubMatchT, "divisionId" | "stageName" | "roundNo">) =>
  JSON.stringify([m.divisionId, m.stageName, m.roundNo]);

/** A round's counts in the planner's buckets: the hub's own bucket already says live / upcoming / completed (a result). */
function hubBuckets(rows: readonly Pick<HubMatchT, "bucket">[]): RoundBuckets {
  const c = { live: 0, upcoming: 0, result: 0 };
  for (const m of rows) c[m.bucket === "completed" ? "result" : m.bucket] += 1;
  return c;
}

/** Every bracket fixture the document's knockout views name - kept whole, never paged. */
function bracketIds(doc: Pick<CompetitionHubDocT, "knockouts">): Set<string> {
  const ids = new Set<string>();
  for (const view of doc.knockouts) {
    for (const round of view.rounds) for (const id of round.fixtureIds) ids.add(id);
    if (view.championFixtureId !== null) ids.add(view.championFixtureId);
  }
  return ids;
}

/** A division's round-stage matches by round, in play order: stages in the order the document first lists them, then round number. */
function roundsOf(matches: readonly HubMatchT[]): { key: string; rows: HubMatchT[] }[] {
  const stageRank = new Map<string, number>();
  const byKey = new Map<string, HubMatchT[]>();
  for (const m of matches) {
    if (!stageRank.has(m.stageName)) stageRank.set(m.stageName, stageRank.size);
    const key = hubRoundKey(m);
    byKey.set(key, [...(byKey.get(key) ?? []), m]);
  }
  return [...byKey.entries()]
    .map(([key, rows]) => ({ key, rows }))
    .sort((a, b) => stageRank.get(a.rows[0]!.stageName)! - stageRank.get(b.rows[0]!.stageName)! || a.rows[0]!.roundNo - b.rows[0]!.roundNo);
}

/** The v1 hub route's query that asks for the page's window (review I3): `?window=rounds`. Without it the route answers every match. */
export const HUB_WINDOW_PARAM = "window";
export const HUB_WINDOW_ROUNDS = "rounds";

/** The document as served: a big division's folded rounds leave `matches` for `roundPages`. A document with no big division is
 *  returned as it is (the same object). */
export function windowHubDoc<D extends Pick<CompetitionHubDocT, "matches" | "knockouts"> & { teams?: CompetitionHubDocT["teams"] }>(
  doc: D,
): D & { roundPages?: HubRoundPage[] } {
  const byDivision = new Map<string, HubMatchT[]>();
  for (const m of doc.matches) byDivision.set(m.divisionId, [...(byDivision.get(m.divisionId) ?? []), m]);
  const big = [...byDivision.values()].filter((matches) => pagesByRound(matches.length));
  // Nothing to page: the document as it is, read no further.
  if (big.length === 0) return doc;
  const brackets = bracketIds(doc);
  const pages: HubRoundPage[] = [];
  const folded = new Set<string>();
  for (const matches of big) {
    const rounds = roundsOf(matches.filter((m) => !brackets.has(m.fixtureId)));
    if (rounds.length === 0) continue;
    // A late entrant's catch-up round never moves the frontier (review C2, `planRounds`).
    const plan = planRounds(rounds.map((r) => ({ key: r.key, buckets: hubBuckets(r.rows), catchUp: r.rows.some((m) => m.catchUp === true) })));
    rounds.forEach((r, i) => {
      const first = r.rows[0]!;
      pages.push({ ...plan[i]!, divisionId: first.divisionId, divisionSlug: first.divisionSlug, stageName: first.stageName, roundNo: first.roundNo, label: first.roundLabel });
      if (!plan[i]!.open) for (const m of r.rows) folded.add(m.fixtureId);
    });
  }
  if (pages.length === 0) return doc;
  const matches = doc.matches.filter((m) => !folded.has(m.fixtureId));
  // Review I4: a team whose every dated match is folded (an odd league's sit-out, when one round is served) keeps its calendar.
  const datedServed = new Set<string>();
  for (const m of matches) if (m.scheduledAt !== null) for (const s of m.header.sides) datedServed.add(s.entrantId);
  const datedFolded = new Set<string>();
  for (const m of doc.matches) {
    if (!folded.has(m.fixtureId) || m.scheduledAt === null) continue;
    for (const s of m.header.sides) if (!datedServed.has(s.entrantId)) datedFolded.add(s.entrantId);
  }
  const teams = doc.teams?.map((t) => (datedFolded.has(t.entrantId) ? { ...t, datedElsewhere: true } : t));
  return { ...doc, matches, roundPages: pages, ...(teams !== undefined ? { teams } : {}) };
}

/** One folded round's cards out of the WHOLE (cached) document; null for a key the document has no round-stage match under. */
export function hubRoundMatches(doc: Pick<CompetitionHubDocT, "matches" | "knockouts">, divisionSlug: string, key: string): HubMatchT[] | null {
  const brackets = bracketIds(doc);
  const rows = doc.matches.filter((m) => m.divisionSlug === divisionSlug && !brackets.has(m.fixtureId) && hubRoundKey(m) === key);
  return rows.length === 0 ? null : rows;
}

/** The chips' totals over the whole competition: the served matches plus every folded round's own counts. */
export function hubBucketTotals(doc: { matches: readonly Pick<HubMatchT, "bucket">[]; roundPages?: readonly HubRoundPage[] }) {
  const counts = { live: 0, upcoming: 0, completed: 0 };
  for (const m of doc.matches) counts[m.bucket] += 1;
  for (const p of doc.roundPages ?? []) {
    if (p.open) continue;
    counts.live += p.live;
    counts.upcoming += p.upcoming;
    counts.completed += p.result;
  }
  return counts;
}
