// A run id names the report directory (<report-dir>/<id>/), the owner's email
// and every case's org slug (`m-<id>-<n>`), so it must be slug-safe and short
// enough that no slug is ever cut — a cut slug would drop the case number and
// collide. run.ts's slug, moved verbatim into a leaf (W1d Task 4) so
// merge-shards.ts, run-sample.ts and the workflow tests can name it without
// loading the runner.
//
// run.ts writes <report-dir>/<slugRunId(--run-id)>/, so EVERY caller that later
// reads that directory must pass an id that is already its own slug
// (`slugRunId(id) === id`): `ci-1-1-L3-s1` lands in `ci-1-1-l3-s1/` (review C1).

export const RUN_ID_MAX = 40;

/** The lowercase `[a-z0-9-]` id `raw` slugs to, or null when the result is
 *  empty or longer than RUN_ID_MAX (the length is judged before the edge
 *  dashes are trimmed — run.ts's rule, kept as it was). */
export function slugRunId(raw: string): string | null {
  const slugged = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const runId = slugged.length > RUN_ID_MAX ? "" : slugged.replace(/^-+|-+$/g, "");
  return runId === "" ? null : runId;
}
