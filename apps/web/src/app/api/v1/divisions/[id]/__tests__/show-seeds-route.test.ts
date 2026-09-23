// PATCH /api/v1/divisions/{id} carries `show_seeds` (V416) — through the real
// route handler, the real `PatchDivision` schema and the real use-case, then
// read back out of the PUBLIC side.
//
// The column alone is an inert seam: `PatchDivision` is a plain `z.object`, so
// a key it does not declare is STRIPPED, not refused — `{ show_seeds: false }`
// would parse to `{}`, 400 as an empty patch, and the organiser's toggle would
// do nothing. And a use-case whose `COLS` omit the column would write it and
// answer without it, so the Settings checkbox would snap back on the refresh.
// So every case here goes in through the route and comes out through
// `public_entrants_v`, the one reader every public surface shares
// (`server/public-site/__tests__/public-entrants-show-seeds.test.ts` proves
// each surface reads it).
//
// Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

// Outside a Next request there is no incrementalCache; the use-case already
// swallows that, and a passthrough keeps the route's own reads honest.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { seedFutureDivision, seedOrg } from "@/server/usecases/__tests__/_seed";
import { createApiKey } from "@/server/usecases/api-keys";
import { GET, PATCH } from "@/app/api/v1/divisions/[id]/route";

const HAS_DB = !!process.env.DATABASE_URL;

/** `pro` carries `api.access` but not `api.write` — the same override the
 *  sibling route suites use to mint a manage key. */
async function allowApiWrite(auth: AuthCtx): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${auth.orgId}, 'api.write', true, 'test')
    on conflict (org_id, feature_key) do update set bool_value = true`;
  await invalidateOrgEntitlements(auth.orgId);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function keyed(method: "GET" | "PATCH", divisionId: string, secret: string, body?: unknown): Request {
  return new Request(`https://test.local/api/v1/divisions/${divisionId}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Envelope = { data?: { show_seeds?: unknown }; error?: { code: string } };

async function rig() {
  const { auth } = await seedOrg("pro");
  const { division } = await seedFutureDivision(auth);
  await allowApiWrite(auth);
  const { secret } = await createApiKey(auth, { name: "manager", scopes: ["manage"] });
  /** What a spectator is served: the seeds of this division's public rows,
   *  in the view's own name order so the four rows line up run to run. */
  const publicSeeds = async () =>
    (
      await sql<{ seed: number | null }[]>`
        select seed from public_entrants_v where division_id = ${division.id} order by display_name`
    ).map((r) => r.seed);
  const storedSeeds = async () =>
    (
      await sql<{ seed: number | null }[]>`
        select seed from entrants where division_id = ${division.id} order by display_name`
    ).map((r) => r.seed);
  return { division, secret, publicSeeds, storedSeeds };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("PATCH /api/v1/divisions/{id} — show_seeds", () => {
  it("a new division answers show_seeds: true, and its seeds are public", async () => {
    const { division, secret, publicSeeds, storedSeeds } = await rig();
    const res = await GET(keyed("GET", division.id, secret), ctx(division.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Envelope).data?.show_seeds).toBe(true);
    const stored = await storedSeeds();
    expect(stored.every((s) => s !== null), "premise: every seeded entrant has a seed").toBe(true);
    expect(await publicSeeds()).toEqual(stored);
  });

  it("OFF then ON again: the response, a fresh GET and the public rows all follow, and the stored seeds never move", async () => {
    const { division, secret, publicSeeds, storedSeeds } = await rig();
    const stored = await storedSeeds();

    const off = await PATCH(keyed("PATCH", division.id, secret, { show_seeds: false }), ctx(division.id));
    expect(off.status).toBe(200);
    expect(((await off.json()) as Envelope).data?.show_seeds).toBe(false);
    const read = await GET(keyed("GET", division.id, secret), ctx(division.id));
    expect(((await read.json()) as Envelope).data?.show_seeds).toBe(false);
    expect(await publicSeeds(), "the public rows after OFF").toEqual(stored.map(() => null));
    expect(await storedSeeds(), "the organiser's seeds after OFF").toEqual(stored);

    const on = await PATCH(keyed("PATCH", division.id, secret, { show_seeds: true }), ctx(division.id));
    expect(on.status).toBe(200);
    expect(((await on.json()) as Envelope).data?.show_seeds).toBe(true);
    expect(await publicSeeds(), "the public rows after ON").toEqual(stored);
  });

  it("a non-boolean show_seeds is a 400 VALIDATION, and nothing changes", async () => {
    const { division, secret, publicSeeds, storedSeeds } = await rig();
    for (const bad of ["no", null, 0]) {
      const res = await PATCH(keyed("PATCH", division.id, secret, { show_seeds: bad }), ctx(division.id));
      expect(res.status, `show_seeds: ${JSON.stringify(bad)}`).toBe(400);
      expect(((await res.json()) as Envelope).error?.code).toBe("VALIDATION");
    }
    const [{ show_seeds }] = await sql<{ show_seeds: boolean }[]>`
      select show_seeds from divisions where id = ${division.id}`;
    expect(show_seeds).toBe(true);
    expect(await publicSeeds()).toEqual(await storedSeeds());
  });
});
