/**
 * The demo's last step: publish the competitions it seeded.
 *
 * Extracted from seed-demo.ts so it can be tested (seed-demo calls `main()`
 * at import, see seed-resume.ts).
 *
 * `POST /api/v1/competitions` ignores `status`, so everything the seed creates
 * is a DRAFT. Since the owner decision of 2026-09-27 a draft is listed nowhere
 * — not on the org home, the sitemap, Discover or another competition's
 * player card — so a demo that never publishes shows an empty org home.
 *
 * Call it LAST. Starting a division promotes a PUBLISHED competition to
 * `live` (schedule.ts) and never a draft, and the seed starts divisions in
 * every step before this one (the PLAN loop, `seedAdvancedFormats`,
 * `seedArchivedSlotHolder`). Publishing after them leaves each competition
 * `published` — the same "Upcoming" chip the draft showed on the org home
 * before drafts were unlisted — instead of turning every played one live.
 *
 * Only a DRAFT is touched: a completed, live or archived competition keeps its
 * status, and a rerun is a no-op. A plan cap is a skip, like
 * `findOrCreateCompetition`.
 */
import type { ApiCall } from "./seed-resume.ts";

const PLAN_CAP = /cap|limit|payment/i;

/** Publishes each named competition that is still a draft; returns the names it published. */
export async function publishDrafts(call: ApiCall, names: string[]): Promise<string[]> {
  const list = await call("/api/v1/competitions?limit=100");
  const rows = ((list as { items?: unknown }).items ?? list) as { id: string; name: string; status: string }[];
  const published: string[] = [];
  for (const name of names) {
    const row = rows.find((r) => r.name === name);
    if (!row || row.status !== "draft") continue;
    try {
      await call(`/api/v1/competitions/${row.id}`, "PATCH", { status: "published" });
      published.push(name);
    } catch (e) {
      if (PLAN_CAP.test(String(e))) {
        console.log(`${name}: left as a draft (plan cap on this account)`);
        continue;
      }
      throw e;
    }
  }
  return published;
}
