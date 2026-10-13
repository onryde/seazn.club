// Design review I-1 / M-1 (audit 3.1 beyond the web hosts) — a double walkover credits nobody, but its summary carries
// a 0 / 0, and every host that reads `match_states.summary` straight from the database painted it: the organiser's
// slideshow. Each host now asks the one predicate (`creditsNobody`, lib/forfeit-tag.ts).
//
// ONE real scene through the real write path (`scoreEvent`): a 4-entrant knockout whose first semi is a double
// walkover and whose second is a one-sided walkover (the pair, which keeps its credited score). The premise — the
// double walkover's stored summary really carries a headline — is asserted first.
//
// Single-sport (badminton): the hosts read stored rows and never look at the sport; the registry sweeps live in the
// pure tests (public-slides, double-walkover-score-lines).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { msgFor } from "@/lib/messages-i18n";
import type { AuthCtx } from "@/server/api-v1/auth";
import { buildDivisionSlides, type FixtureSlideItem } from "@/server/slideshow-data";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, post } from "@/server/engine-db/__tests__/helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("a double walkover's 0 / 0 on the hosts that read the stored summary (review I-1, M-1)", () => {
  let auth: AuthCtx;
  let divisionId: string;
  let dwId: string;
  let woId: string;
  let woHeadline: string;
  const names: Record<string, string> = {};
  const TAG = msgFor("en", "forfeit.tag.doubleWalkover");

  beforeAll(async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    auth = s.auth;
    divisionId = s.divisionId;
    if (s.fixtureIds.length !== 2) throw new Error(`rig: ${s.fixtureIds.length} semi-finals, wanted 2`);
    const dw = await fixtureRow(s.fixtureIds[0]!);
    const wo = await fixtureRow(s.fixtureIds[1]!);
    dwId = dw.id;
    woId = wo.id;
    const dwOut = await post(auth, dwId, "core.forfeit", { by: "both", reason: "walkover" });
    expect([dwOut.status, dwOut.outcome], "rig: the double walkover is recorded").toEqual(["forfeited", { kind: "double_walkover" }]);
    const woOut = await post(auth, woId, "core.forfeit", { by: wo.away_entrant_id, reason: "walkover" });
    expect(woOut.status, "rig: the one-sided walkover is recorded").toBe("forfeited");
    for (const r of await sql<{ id: string; display_name: string }[]>`select id, display_name from entrants where division_id = ${divisionId}`) {
      names[r.id] = r.display_name;
    }
    const heads = await sql<{ fixture_id: string; headline: string | null }[]>`
      select fixture_id, summary->>'headline' as headline from match_states where fixture_id in (${dwId}, ${woId})`;
    const headOf = (id: string) => heads.find((h) => h.fixture_id === id)?.headline ?? null;
    expect(headOf(dwId), "premise: the double walkover's stored summary carries a headline to hide").toMatch(/\d/);
    expect(headOf(woId), "premise: the walkover's stored summary carries its credited score").toMatch(/\d/);
    woHeadline = headOf(woId)!;
  }, 120_000);

  it("the organiser's slideshow: the results and bracket slides carry the tag, not the 0 / 0; the walkover keeps its score", async () => {
    const slides = await buildDivisionSlides(auth, divisionId, "Open");
    const [dw] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${dwId}`;
    const [wo] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${woId}`;
    const items = slides.flatMap((sl) => (sl.kind === "fixtures" ? sl.items : [])) as FixtureSlideItem[];
    const dwItems = items.filter((i) => i.home === names[dw!.home_entrant_id]);
    const woItems = items.filter((i) => i.home === names[wo!.home_entrant_id]);
    expect(dwItems.length, "the double walkover is on a results slide").toBeGreaterThan(0);
    expect(woItems.length, "the walkover is on a results slide").toBeGreaterThan(0);
    for (const i of dwItems) expect([i.line, i.tag], "results slide: the double walkover").toEqual([null, TAG]);
    for (const i of woItems) expect([i.line, i.tag ?? null], "results slide: the walkover keeps its score").toEqual([woHeadline, null]);
    const nodes = slides.flatMap((sl) => (sl.kind === "bracket" ? sl.fixtures : []));
    const node = (id: string) => nodes.find((n) => n.id === id);
    expect(node(dwId), "the bracket slide has the double walkover's node").toBeDefined();
    expect([node(dwId)!.line, node(dwId)!.tag], "bracket slide: the double walkover").toEqual([null, TAG]);
    expect([node(woId)!.line, node(woId)!.tag ?? null], "bracket slide: the walkover keeps its score").toEqual([woHeadline, null]);
  });
});
