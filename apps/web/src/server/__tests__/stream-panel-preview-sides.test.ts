// I3 (PR #987 review, routed to R2006): the organiser's style-grid thumbnails must name the sides as the overlay AIRS
// them. The panel used to hand the preview bare names, so `shortCode` re-coded every pair as teams — Lee Chong Wei v
// Viktor Axelsen previewed LEE/VIK and aired WEI/AXE (a person pair's codes are surnames, `disambiguatedShorts`).
// Since #987 the model resolves codes for the PAIR (`overlaySideCodes`): a producer's `short` wins, and a side handed
// without one is resolved as a seated TEAM — exactly what the old preview's bare names got.
//
// The expected value is read off the AIRED path — the overlay page's own loader (`relayOverlayPageFacts`, the composed
// session's door; the public door masks and disambiguates by the same rules, page-facts.ts header) — never off the
// preview, and never typed here. The premise is pinned too: for these names the aired codes really do differ from the
// old re-coding, so the test cannot pass on a pair where both rules happen to agree.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { overlaySideCodes, type OverlaySideInput } from "@/lib/overlay-model";
import { relayOverlayPageFacts } from "@/server/overlay/page-facts";
import { overlayPreviewSides } from "../stream-panel-context";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** A started division's one fixture, its two individual entrants renamed. */
async function personFixture(names: [string, string]) {
  const { auth } = await seedOrg();
  const { fixtureIds } = await divisionRig(auth, { entrants: 2 });
  const fixtureId = fixtureIds[0]!;
  const [f] = await sql<{ home: string; away: string }[]>`
    select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
  await sql`update entrants set display_name = ${names[0]} where id = ${f!.home}`;
  await sql`update entrants set display_name = ${names[1]} where id = ${f!.away}`;
  return { auth, fixtureId };
}

describe.skipIf(!HAS_DB)("I3: the panel's preview sides ARE the aired sides", () => {
  // Two person pairs: one whose surnames differ (the reported case), one whose surnames collide in their first three
  // letters and must widen (Harlow / Harrow). Since #987 a pair like "Ann Smith" / "Anna Smith" widens to the same codes
  // under both rules, so it witnesses nothing — the premise below is what refuses such a pair.
  const PAIRS: [string, string][] = [
    ["Lee Chong Wei", "Viktor Axelsen"],
    ["John Harlow", "Jane Harrow"],
  ];

  /** The codes the bug airs for a pair of sides — the model's own pair rule, never a table typed here. */
  const codesOf = (sides: readonly [OverlaySideInput, OverlaySideInput]) => overlaySideCodes(sides);
  /** What the old preview aired: the same names handed WITHOUT a code, so the model re-codes them as teams. */
  const bareNames = (sides: readonly [OverlaySideInput, OverlaySideInput]): [OverlaySideInput, OverlaySideInput] =>
    [{ ...sides[0], short: null }, { ...sides[1], short: null }];

  it.each(PAIRS)("%s v %s: the preview's codes and names are the overlay page's own, not the names re-coded as teams", async (home, away) => {
    const { auth, fixtureId } = await personFixture([home, away]);
    const aired = await relayOverlayPageFacts(fixtureId);
    expect(aired, "premise: the overlay page's loader reads this fixture").not.toBeNull();
    const airedCodes = codesOf(aired!.sides);
    // The premise that makes this a witness: the old preview (bare names, re-coded by the team rule) would differ.
    expect(airedCodes, "premise: a person pair airs codes the team rule would not").not.toEqual(codesOf(bareNames(aired!.sides)));

    const preview = await overlayPreviewSides(auth.orgId, [fixtureId]);
    expect(Object.keys(preview)).toEqual([fixtureId]);
    expect(codesOf(preview[fixtureId]!), "the thumbnail's codes").toEqual(airedCodes);
    expect(preview[fixtureId]!.map((s) => s.name), "the thumbnail's names (masked as aired)").toEqual(aired!.sides.map((s) => s.name));
    expect(preview[fixtureId], "the very sides the page airs").toEqual(aired!.sides);
  });

  it("another org's fixture is never previewed (the overlay page's relay door is unfiltered, so the org is checked here); no ids reads nothing", async () => {
    const mine = await personFixture(["Lee Chong Wei", "Viktor Axelsen"]);
    const theirs = await personFixture(["Kento Momota", "Viktor Axelsen"]);
    const got = await overlayPreviewSides(mine.auth.orgId, [mine.fixtureId, theirs.fixtureId]);
    expect(Object.keys(got), "only the org's own fixture").toEqual([mine.fixtureId]);
    // The positive pair: the other org reads its own.
    expect(Object.keys(await overlayPreviewSides(theirs.auth.orgId, [theirs.fixtureId]))).toEqual([theirs.fixtureId]);
    expect(await overlayPreviewSides(mine.auth.orgId, [])).toEqual({});
  });
});
