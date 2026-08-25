// Task 5 — POST /api/v1/divisions/{id}/events/import. The route is exercised
// as a REAL handler over a REAL session door (same harness
// merge-route.test.ts established): only `requireUser` (who is signed in) is
// faked; `requireOrgAuth`'s own `getOrgRole` lookup runs for real against a
// REAL `org_members` row.
//
// Deliberately NOT `_rig.ts`'s own `seedOrg()`: that helper (built for
// Tasks 1-4, which call `importEvents` directly as a function) never creates
// a `users`/`org_members` row — its AuthCtx.userId is null — so it cannot
// pass this route's real `requireOrgAuth` door. `_seed.ts`'s `seedOrg()`
// does create both, and is what every other route-level test in this repo
// already uses for exactly this reason. The brief's own test sketch imports
// `seedOrg` from `./_rig` alongside `startedDivisionWithFixture`/
// `decidingStream`; those two are still `_rig.ts`'s (they just need
// `auth.orgId`, and P11's own rig is what Tasks 3/4 already proved works),
// but `seedOrg` here is `_seed.ts`'s — the brief's own caveat says to follow
// the harness a neighbouring route test uses rather than weaken the
// assertions to fit a mismatch.
import { afterAll, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    // No cookie: resolveActiveOrg's fallback is unused here — orgId comes
    // from the division being requested, not from an "active org" cookie.
    getActiveOrgId: async () => null,
  };
});

// resolveActiveOrg repairs the cookie on the fallback path; outside a Next
// request scope cookies() throws, so the jar is a no-op (same as
// merge-route.test.ts).
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { POST } from "@/app/api/v1/divisions/[id]/events/import/route";
import { seedOrg as seedSignedInOrg } from "./_seed";
import { startedDivisionWithFixture, decidingStream } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

/** A signed-in organiser of a fresh community org — import.events carries no
 *  plan_entitlements row on ANY plan during rollout (R6), so community vs.
 *  pro makes no difference to the entitlement gate under test; community
 *  matches every other P11 rig default. */
async function organiser(): Promise<AuthCtx> {
  const { auth } = await seedSignedInOrg("community");
  authState.userId = auth.userId!;
  return auth;
}

/** Grant one boolean feature to an org out-of-plan — the same row
 *  `setBoolEntitlementOverrideSql` writes (apps/web/e2e/helpers.ts:342) and the
 *  only way `import.events` is held during rollout (spec §2.4). */
async function grant(orgId: string, key: string) {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value)
    values (${orgId}, ${key}, true)
    on conflict (org_id, feature_key) do update set bool_value = true`;
}

const call = (divisionId: string, body: unknown, headers: HeadersInit = {}) =>
  POST(
    new Request(`http://localhost/api/v1/divisions/${divisionId}/events/import`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: divisionId }) },
  );

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("POST /divisions/{id}/events/import", () => {
  it("402s an org without the import.events entitlement", async () => {
    const auth = await organiser();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const res = await call(divisionId, {
      import_id: "imp-402",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(res.status).toBe(402);
  });

  it("imports once the entitlement is granted", async () => {
    const auth = await organiser();
    await grant(auth.orgId, "import.events");
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const res = await call(divisionId, {
      import_id: "imp-200",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals).toEqual({ imported: 1, skipped: 0, rejected: 0 });
  });

  it("409s a second call with the same import_id while the first is in flight", async () => {
    const auth = await organiser();
    await grant(auth.orgId, "import.events");
    const { divisionId, fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
    const payload = (fixtureId: string) => ({
      import_id: "imp-concurrent",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    const [a, b] = await Promise.all([
      call(divisionId, payload(fixtureIds[0]!)),
      call(divisionId, payload(fixtureIds[1]!)),
    ]);
    // One wins; the loser is refused rather than interleaving with it.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect((await loser.json()).error.code).toBe("import.concurrent");
  });
});
