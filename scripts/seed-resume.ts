/**
 * Resume helpers for seed-demo.
 *
 * Extracted so they can be tested: seed-demo.ts calls `main()` at import, so
 * nothing inside it is reachable from a spec.
 *
 * The rule they encode: **resume by NAME, checked before creating.** A create
 * that supplies no explicit slug can never 409 — the server generates one and
 * suffixes any collision away (`withUniqueSlug`, apps/web server/usecases/
 * slugs.ts) — so a catch-based resume is unreachable code, and every rerun
 * minted a duplicate with a "-2" slug instead of resuming. Same shape
 * `seedTemplateCompetition` already used; the PLAN loop and the closed-
 * competition seed had drifted from it.
 */

export type ApiCall = (path: string, method?: string, body?: unknown) => Promise<any>;

/** A plan cap is a SKIP for a seed run, not an abort — accounts seeded before
 *  a PLAN change routinely sit at their caps. */
const PLAN_CAP = /cap|limit|payment/i;

/**
 * The competition named `name`, creating it if absent. `null` means the
 * account is at its plan cap and the caller should move on.
 */
export async function findOrCreateCompetition(
  call: ApiCall,
  name: string,
  body: Record<string, unknown>,
): Promise<{ id: string } | null> {
  const list = await call("/api/v1/competitions?limit=100");
  const existing = ((list.items ?? list) as { id: string; name: string }[]).find(
    (c) => c.name === name,
  );
  if (existing) {
    console.log(`${name}: exists, resuming`);
    return { id: existing.id };
  }
  try {
    return (await call("/api/v1/competitions", "POST", { name, ...body })) as { id: string };
  } catch (e) {
    if (PLAN_CAP.test(String(e))) {
      console.log(`${name}: skipped (plan cap on this account)`);
      return null;
    }
    throw e;
  }
}
