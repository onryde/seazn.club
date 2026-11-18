// W5 app-A Task 23 (RB5-W2; B5 merge finding): the hub's Matches card of a leaver's EXPUNGED line — driven through the real producer
// (the organiser's own door, `withdrawEntrantCascade`, under half: her lines are expunged) and the real consumer (`loadCompetitionHub`
// parsed by the wire schema, painted by `MatchCard`). Expected: exactly her lines carry `expunged` and read "Abandoned" (the match
// centre's own word, en public.json), every other line does not — the empty case (nobody left) first.
//
// differential: before this task `HubMatch` declared no `expunged`, so the parse dropped it and her cards read "Ended" / a time.
// Single-sport (badminton): the flag is the ledger's, read sport-blind (`hasActiveAbandonSql`); the public schedule's own sweep is
// 27eddf373f's.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));

import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { sql } from "@/lib/db";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { MatchCard } from "@/components/public-site/matches-hub/match-card";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { loadCompetitionHub } from "../competition-hub";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const ABANDONED = t(en as unknown as Dict, "matchCentre.status.abandoned");

describe.runIf(HAS_DB)("RB5-W2 the hub card of a leaver's expunged line (real producer, real consumer)", () => {
  it("nobody left: no card is expunged; she withdraws under half: exactly her lines are, and read 'Abandoned'", async () => {
    const m = builtinModules.find((x) => x.key === "badminton")!;
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T23 " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
    const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: Object.keys(m.variants)[0]!, config: {} });
    const es = await createEntrants(auth, d.id, Array.from({ length: 5 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
    await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: {}, progression: null });
    await startDivision(auth, d.id);
    const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
    const matches = async () => CompetitionHubDoc.parse(await loadCompetitionHub(orgSlug!, comp.slug, new Date(), { uncached: true })).matches;

    const before = await matches();
    expect(before.length, "premise: the league's ten matches are on the hub").toBe(10);
    expect(before.filter((x) => x.expunged === true)).toEqual([]);

    const her = es[0]!.id;
    const herLines = (await sql<{ id: string }[]>`select id from fixtures where division_id = ${d.id} and ${her} in (home_entrant_id, away_entrant_id)`).map((r) => r.id).sort();
    expect(herLines.length, "premise: she plays four").toBe(4);
    await withdrawEntrantCascade(auth, her);

    const after = await matches();
    const struck = after.filter((x) => x.expunged === true);
    expect(struck.map((x) => x.fixtureId).sort()).toEqual(herLines);
    let checked = 0;
    for (const x of after) {
      const html = renderToStaticMarkup(createElement(MatchCard, { match: x, dict: en as unknown as Dict, locale: "en", now: 0 }));
      const isHers = herLines.includes(x.fixtureId);
      expect(html.includes('data-testid="mh-match-expunged"'), x.fixtureId).toBe(isHers);
      if (isHers) expect(html).toContain(`>${ABANDONED}<`);
      checked++;
    }
    expect(checked).toBe(10);
  });
});
