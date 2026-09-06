import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { TAG, apiJson, loginUi, grantCompetitionPassSql, invalidateOrgEntitlements } from "./helpers";

// W2 T6 — `officials.auto` through the REAL HTTP door, competition-scoped.
//
// V393 turns `officials.auto` TRUE on `event_pass`/`event_pass_l` and FALSE on
// `community`. The three officials gates in usecases/officials.ts used to call
// `requireFeature(auth.orgId, "officials.auto")` with no competition, and the
// Event Pass overlay in lib/entitlements.ts only consults `competition_passes`
// when a competition is in scope — so a Free org that had BOUGHT a pass was
// refused auto-officials on the very competition it paid for, with a 402 whose
// `feature_key` named a feature the pricing page had just sold it.
//
// The vitest sibling (server/usecases/__tests__/pass-scope-officials.test.ts)
// calls the usecases directly. This file exists because that one cannot see the
// route layer: `/divisions/{id}/officials/{auto,apply}` and
// `/stages/{id}/officials/source` each resolve their own auth and hand the id
// through, and a seam is only proven by driving it through its real producer
// and consumer. Asserted on all three routes, in BOTH directions — a one-sided
// test stays green if the gate leaks org-wide, which is the other half of the
// bug the pass was invisible to.
//
// Seeds are run-unique and the org is SQL-seeded with its own owner, so nothing
// here touches the shared Pro e2e account or its org budget.

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const hex = () => randomBytes(4).toString("hex");

/** One-shot SQL against the app's schema (helpers.ts keeps withDb private —
 *  same local copy pro-plus-tier.spec.ts carries, for the same reason). */
async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl:
      process.env.DATABASE_SSL === "disable"
        ? false
        : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
          ? false
          : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** A COMMUNITY org with its own owner AND an explicit subscriptions row: an
 *  `organizations` insert alone leaves none, and the plan has to resolve to one
 *  whose `officials.auto` is FALSE or the pass is not what is under test. */
async function seedCommunityOrg(): Promise<{ orgId: string; ownerEmail: string }> {
  const tag = hex();
  const ownerEmail = `po-owner-${TAG}-${tag}@example.com`;
  return withDb(async (sql) => {
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"PO Owner " + tag}, true)
      returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"PO Org " + tag}, ${`po-org-${TAG}-${tag}`}, 'active', ${ownerId})
      returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
    const [group] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${ownerId}, 'community', 'active')
      returning id`;
    await sql`update organizations set subscription_id = ${group.id} where id = ${orgId}`;
    return { orgId, ownerEmail };
  });
}

/** A private competition + generic-score division + one league stage. */
async function seedCompetition(
  request: APIRequestContext,
  label: string,
): Promise<{ competitionId: string; divisionId: string; stageId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `PO ${label} ${TAG} ${hex()}`,
    visibility: "private",
  });
  expect(comp.status, `seed competition ${label}`).toBe(201);
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
  );
  expect(div.status, `seed division ${label}`).toBe(201);
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${div.data!.id}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League", config: {} },
  );
  expect(stage.status, `seed stage ${label}`).toBe(201);
  return { competitionId: comp.data!.id, divisionId: div.data!.id, stageId: stage.data!.id };
}

interface GateResult {
  status: number;
  featureKey?: string;
}

async function post(
  request: APIRequestContext,
  path: string,
  body: unknown,
): Promise<GateResult> {
  const res = await request.post(path, {
    headers: { "content-type": "application/json" },
    data: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { feature_key?: string } };
  return { status: res.status(), featureKey: json.error?.feature_key };
}

const AUTO_BODY = { policy: { roles: ["referee"] } };
const APPLY_BODY = { assignments: [] };
const sourceBody = (stageId: string) => ({
  sources: [{ kind: "rank", fromStage: stageId, take: [{ rank: 1 }] }],
});

test.describe("officials.auto is resolved against the competition being officiated", () => {
  test("an Event Pass unlocks all three officials routes on its own competition only", async ({
    page,
  }: {
    page: Page;
  }) => {
    const { orgId, ownerEmail } = await seedCommunityOrg();
    await loginUi(page, ownerEmail);
    await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);

    const passed = await seedCompetition(page.request, "passed");
    const plain = await seedCompetition(page.request, "plain");
    await grantCompetitionPassSql(orgId, passed.competitionId, "event_pass", page.request);
    await invalidateOrgEntitlements(page.request, orgId);

    // --- the passed competition: every gate opens -------------------------
    // RED before the fix: each of these was a 402 naming `officials.auto`,
    // because the gate never told the resolver which competition it was for.
    expect(
      await post(page.request, `/api/v1/divisions/${passed.divisionId}/officials/auto`, AUTO_BODY),
    ).toEqual({ status: 200, featureKey: undefined });
    expect(
      await post(page.request, `/api/v1/divisions/${passed.divisionId}/officials/apply`, APPLY_BODY),
    ).toEqual({ status: 200, featureKey: undefined });
    expect(
      await post(
        page.request,
        `/api/v1/stages/${passed.stageId}/officials/source`,
        sourceBody(passed.stageId),
      ),
    ).toEqual({ status: 200, featureKey: undefined });

    // --- the org's OTHER competition: every gate still refuses ------------
    // A pass lifts ONE competition. `feature_key` is pinned, not just the 402:
    // this org is also on Community quotas, so a bare status check would pass
    // for a refusal naming an entirely different key.
    expect(
      await post(page.request, `/api/v1/divisions/${plain.divisionId}/officials/auto`, AUTO_BODY),
    ).toEqual({ status: 402, featureKey: "officials.auto" });
    expect(
      await post(page.request, `/api/v1/divisions/${plain.divisionId}/officials/apply`, APPLY_BODY),
    ).toEqual({ status: 402, featureKey: "officials.auto" });
    expect(
      await post(
        page.request,
        `/api/v1/stages/${plain.stageId}/officials/source`,
        sourceBody(plain.stageId),
      ),
    ).toEqual({ status: 402, featureKey: "officials.auto" });
  });
});
