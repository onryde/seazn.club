// The overlay endpoint's read (design §3.2). Three reads, one authority each:
// the public row from `publicFixture` (cached, the same view the match page
// reads — visibility decided THERE, never here); the venue zone through
// `resolveVenueTz` (the VENUE lane, lib/tz.ts:44); and the fold, inside
// `unstable_cache` keyed on `last_seq`, so N polls at one ledger position
// cost one fold. Fire-and-forget nothing; throw nothing new — a 404 from the
// row read is the 404 the route answers.
import "server-only";
import { unstable_cache } from "next/cache";
import { sql } from "@/lib/db";
import { resolveVenueTz } from "@/lib/tz";
import { foldFixture, type FoldedFixture } from "@/server/engine-db/fold";
import { publicFixture } from "@/server/usecases/public";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import { projectOverlayLiveData } from "./project";

interface PublicRow {
  id: string;
  division_id: string;
  status: string;
  summary: OverlayLiveData["summary"];
  outcome: OverlayLiveData["outcome"];
  last_seq: number | null;
}

/** Folds once per (fixture, last_seq). The fold reads the whole ledger and
 *  every module the fixture pins; at ~1 event / 36 s per T20 that is once
 *  per ledger advance, and never once per 15 s poll across every viewer. */
function cachedFold(fixtureId: string, lastSeq: number): () => Promise<FoldedFixture | null> {
  return unstable_cache(
    async () => sql.begin(async (tx) => foldFixture(tx, fixtureId)) as Promise<FoldedFixture | null>,
    ["overlay-fold", fixtureId, String(lastSeq)],
    { revalidate: 300 },
  );
}

export async function loadOverlayLiveData(fixtureId: string): Promise<OverlayLiveData> {
  const row = (await publicFixture(fixtureId)) as PublicRow;
  const [zone] = await sql<{ division_tz: string | null; org_tz: string | null }[]>`
    select ss.tz as division_tz, o.timezone as org_tz
    from divisions d
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations o on o.id = d.org_id
    where d.id = ${row.division_id}`;
  const venueTz = resolveVenueTz(zone?.division_tz, zone?.org_tz);
  const folded = row.last_seq === null ? null : await cachedFold(fixtureId, row.last_seq)();
  return projectOverlayLiveData({ row, folded, venueTz });
}
