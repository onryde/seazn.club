import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { TAG, apiJson, loginUi, grantCompetitionPassSql, invalidateOrgEntitlements } from "./helpers";

// W2 T13 — the five keys V392 granted the Event Pass, through the REAL HTTP door.
//
// lib/entitlements.ts only consults `competition_passes` when a competition is
// in scope, and eight enforcement sites omitted it — so a Community org bought
// an Event Pass and was refused the features the pricing page had just sold it.
//
// The vitest sibling (server/usecases/__tests__/pass-scope-w2.test.ts) calls the
// usecases directly, and cannot see the route layer: each of these routes
// resolves its own auth and hands the id through, and this whole defect is a
// SEAM — proven only by driving it through its real producer and consumer.
//
// Three of the five keys are driven here, chosen because their routes need no
// scoring data to exercise: the leaderboard (`stats.player`, a bool),
// `stages.per_division.max` and `schedule.checkpoints.max` (both CAPS, where the
// pass moves a number rather than opening a door — a bool-only test would leave
// the `getLimit` call sites unproven at the HTTP layer).
//
// Both directions on the SAME org throughout: a one-sided test stays green if
// the gate leaks org-wide, which is the same paid-for hole in the other
// direction.
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
 *  same local copy pass-scope-officials.spec.ts carries, for the same reason). */
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
 *  holding the LOW side of every key here or the pass is not what is tested. */
async function seedCommunityOrg(): Promise<{ orgId: string; ownerEmail: string }> {
  const tag = hex();
  const ownerEmail = `pw-owner-${TAG}-${tag}@example.com`;
  return withDb(async (sql) => {
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"PW Owner " + tag}, true)
      returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"PW Org " + tag}, ${`pw-org-${TAG}-${tag}`}, 'active', ${ownerId})
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
): Promise<{ competitionId: string; divisionId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `PW ${label} ${TAG} ${hex()}`,
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
  return { competitionId: comp.data!.id, divisionId: div.data!.id };
}

interface GateResult {
  status: number;
  featureKey?: string;
}

/** Status plus the refused key. `feature_key` is pinned rather than the bare
 *  402: this org is on Community quotas throughout, so a status-only check
 *  would pass for a refusal naming an entirely different key. */
async function call(
  request: APIRequestContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<GateResult> {
  const res =
    method === "GET"
      ? await request.get(path)
      : await request.post(path, {
          headers: { "content-type": "application/json" },
          data: JSON.stringify(body ?? {}),
        });
  const json = (await res.json().catch(() => ({}))) as { error?: { feature_key?: string } };
  return { status: res.status(), featureKey: json.error?.feature_key };
}

const stage = (seq: number) => ({ seq, kind: "league", name: `S${seq}`, config: {} });

test.describe("Event Pass grants are reachable over HTTP on the passed competition only", () => {
  test("player stats, the stage cap and the save-point cap all follow the pass", async ({
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

    // --- stats.player (bool: community false, event_pass true) -------------
    // RED before the fix: a 402 naming `stats.player` on the competition the
    // org had just paid to unlock.
    expect(
      await call(page.request, "GET", `/api/v1/divisions/${passed.divisionId}/stats/players`),
    ).toEqual({ status: 200, featureKey: undefined });
    expect(
      await call(page.request, "GET", `/api/v1/divisions/${plain.divisionId}/stats/players`),
    ).toEqual({ status: 402, featureKey: "stats.player" });

    // --- stages.per_division.max (community 2, event_pass 4) ---------------
    // Each division already holds stage seq 1, so the SECOND stage is inside
    // both caps and the THIRD separates them.
    expect(
      await call(page.request, "POST", `/api/v1/divisions/${passed.divisionId}/stages`, stage(2)),
    ).toEqual({ status: 201, featureKey: undefined });
    expect(
      await call(page.request, "POST", `/api/v1/divisions/${passed.divisionId}/stages`, stage(3)),
    ).toEqual({ status: 201, featureKey: undefined });

    expect(
      await call(page.request, "POST", `/api/v1/divisions/${plain.divisionId}/stages`, stage(2)),
    ).toEqual({ status: 201, featureKey: undefined });
    expect(
      await call(page.request, "POST", `/api/v1/divisions/${plain.divisionId}/stages`, stage(3)),
    ).toEqual({ status: 402, featureKey: "stages.per_division.max" });

    // --- schedule.checkpoints.max (community 2, event_pass 5) --------------
    // This cap does not refuse: since #382 a save AT the cap ROLLS the window
    // and evicts the oldest bookmark. So the observable difference is the
    // SURVIVING count after three saves, never a status code — a 402-only
    // assertion here would be green in both directions and prove nothing.
    for (const label of ["one", "two", "three"]) {
      for (const division of [passed.divisionId, plain.divisionId]) {
        const res = await call(
          page.request,
          "POST",
          `/api/v1/divisions/${division}/checkpoints`,
          { label },
        );
        expect(res.status, `checkpoint ${label}`).toBe(201);
      }
    }
    const listed = async (divisionId: string): Promise<string[]> => {
      const res = await apiJson<{ label: string; kind: string }[]>(
        page.request,
        `/api/v1/divisions/${divisionId}/checkpoints`,
        "GET",
      );
      expect(res.status).toBe(200);
      return (res.data ?? []).filter((c) => c.kind === "manual").map((c) => c.label).sort();
    };
    expect(await listed(passed.divisionId)).toEqual(["one", "three", "two"]);
    expect(await listed(plain.divisionId)).toEqual(["three", "two"]);
  });
});
