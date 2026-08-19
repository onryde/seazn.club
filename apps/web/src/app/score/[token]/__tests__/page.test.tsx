// P9 pass 3c-3 site 3: the live scoring page (highest-traffic surface in the
// cutover debt ledger) SELECTed raw fixtures.venue/court_label directly —
// both frozen since pass 3a, so any fixture scheduled post-cutover showed a
// blank court to a scorer opening the pad. Now derives court_label/venue via
// courts/venues joined on court_id/venue_id (same pattern as usecases/me.ts).
// Real Postgres required; skipped without DATABASE_URL. No-jsdom tree walk —
// same convention as officials-fixture-locale.test.tsx / the
// server-component-page-test memory: an async server component returns an
// element TREE, so no renderToStaticMarkup is needed to read what it handed
// a named child.
import { afterAll, describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { sql } from "@/lib/db";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { createDeviceLink } from "@/server/usecases/device-links";
import { seedCourts, seedOrg } from "@/server/usecases/__tests__/_seed";
import { DeviceScorePad } from "@/components/v2/device-score-pad";
import ScorePadPage from "../page";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return find((node.props as { children?: ReactNode }).children, type);
}

async function seedScorableFixture(): Promise<{
  auth: Awaited<ReturnType<typeof seedOrg>>["auth"];
  courtId: string;
  fixtureId: string;
}> {
  const { auth } = await seedOrg("pro");
  const [courtId] = await seedCourts(auth.orgId, 1);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Score " + Math.random().toString(36).slice(2, 8),
    visibility: "public",
    branding: {},
  });
  const div = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await createEntrants(
    auth,
    div.id,
    ["A", "B"].map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, div.id, { seq: 1, kind: "league", name: "L", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { auth, courtId: courtId!, fixtureId: fixtures[0]!.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("ScorePadPage (P9 cutover)", () => {
  it("renders the court_id's live name, not a stale fixtures.court_label", async () => {
    const { auth, courtId, fixtureId } = await seedScorableFixture();
    await sql`
      update fixtures set court_label = 'Stale Court', court_id = ${courtId}
      where id = ${fixtureId}`;
    const link = await createDeviceLink(auth, fixtureId, null);

    const tree = await ScorePadPage({ params: Promise.resolve({ token: link.secret }) });
    const pad = find(tree, DeviceScorePad);
    expect(pad).not.toBeNull();
    const fixtureProp = (pad!.props as { fixture: { court_label: string | null; venue: string | null } }).fixture;
    expect(fixtureProp.court_label).toBe("Court 1");
    expect(fixtureProp.court_label).not.toBe("Stale Court");
  });

  it("archived court still renders its name, never blank", async () => {
    const { auth, courtId, fixtureId } = await seedScorableFixture();
    await sql`update fixtures set court_id = ${courtId} where id = ${fixtureId}`;
    await sql`update courts set archived_at = now() where id = ${courtId}`;
    const link = await createDeviceLink(auth, fixtureId, null);

    const tree = await ScorePadPage({ params: Promise.resolve({ token: link.secret }) });
    const pad = find(tree, DeviceScorePad);
    const fixtureProp = (pad!.props as { fixture: { court_label: string | null } }).fixture;
    expect(fixtureProp.court_label).toBe("Court 1");
  });

  it("no court assigned renders null, never a bare uuid or the fixture id", async () => {
    const { auth, fixtureId } = await seedScorableFixture();
    const link = await createDeviceLink(auth, fixtureId, null);

    const tree = await ScorePadPage({ params: Promise.resolve({ token: link.secret }) });
    const pad = find(tree, DeviceScorePad);
    const fixtureProp = (pad!.props as { fixture: { court_label: string | null } }).fixture;
    expect(fixtureProp.court_label).toBeNull();
  });
});
