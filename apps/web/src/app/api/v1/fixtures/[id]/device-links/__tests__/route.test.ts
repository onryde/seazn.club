// Scorer sheets §4.2 over HTTP: the two device-link mint doors, driven through
// their real handlers over a real session (`requireResourceAuth` unmocked, same
// pattern as divisions/[id]/fixtures/__tests__/route.test.ts). The use-case
// suite proves ensure/reissue semantics; this file proves the ROUTES carry them:
//   - POST …/device-links is ensure: 201 when it mints, 200 when it re-shows the
//     SAME secret — the status is the only thing that tells a caller which;
//   - POST …/device-links/reissue is Revoke & reissue: 201, fresh secret, the
//     printed QR dies;
//   - both spend the ONE per-IP mint bucket (a reissue IS a mint);
//   - a server without DEVICE_LINK_KEK says so on the wire (503 with the code
//     the panel reads), never a bare 500 (owner ruling Q1).
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes as kekBytes } from "node:crypto";

const authState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

// The real limit constant, a recording limiter: what is asserted is WHICH bucket
// each door spends, not Redis.
const rateLimit = vi.hoisted(() => vi.fn<(key: string, cfg: unknown) => Promise<void>>(async () => {}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit };
});

import { DEVICE_LINK_MINT_LIMIT } from "@/lib/rate-limit";
import { CreatedDeviceLink } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { resolveDeviceLinkToken } from "@/server/usecases/device-links";
import { seedOrg, GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { POST as ensurePost } from "../route";
import { POST as reissuePost } from "../reissue/route";

// Every mint seals now (scorer sheets §4.1). A throwaway key of this file's own,
// never the developer's .env.local one: CI's unit job has no DEVICE_LINK_KEK at
// all. Never printed; restored in afterAll.
vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));

const HAS_DB = !!process.env.DATABASE_URL;
const IP = "203.0.113.9";

interface Link {
  id: string;
  fixture_id: string;
  label: string | null;
  expires_at: string | null;
  secret: string;
}
interface Envelope {
  ok: boolean;
  data?: Link;
  error?: { code: string; message: string };
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

function req(body: Record<string, unknown> = {}): Request {
  return new Request("https://test.local/api/v1/fixtures/x/device-links", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${IP}, 10.0.0.1` },
    body: JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function seedFixture(): Promise<string> {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Sheets " + Math.random().toString(36).slice(2, 8),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return fixtures[0]!.id;
}

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("POST /fixtures/{id}/device-links[/reissue] (scorer sheets §4.2)", () => {
  beforeEach(() => {
    authState.userId = "";
    rateLimit.mockClear();
  });

  it("the mint bucket is the one the route always had: 10 a minute per IP", () => {
    expect(DEVICE_LINK_MINT_LIMIT).toEqual({ max: 10, windowSeconds: 60 });
  });

  it("POST ensures: 201 when it mints, then 200 with the SAME link — both on the mint bucket", async () => {
    const fixtureId = await seedFixture();

    const first = await read(await ensurePost(req({ label: "Court 3 phone" }), ctx(fixtureId)));
    expect(first.status, JSON.stringify(first.body.error)).toBe(201);
    expect(first.body.data).toMatchObject({ fixture_id: fixtureId, label: "Court 3 phone", expires_at: null });
    expect(first.body.data!.secret).toMatch(/^dl_/);
    // The published contract describes the payload the route really sends —
    // nothing applies S.CreatedDeviceLink at runtime, so only this can see a
    // schema that still says `expires_at` is always a string.
    expect(CreatedDeviceLink.safeParse(first.body.data).error).toBeUndefined();

    const again = await read(await ensurePost(req(), ctx(fixtureId)));
    expect(again.status, JSON.stringify(again.body.error)).toBe(200);
    expect(again.body.data!.secret).toBe(first.body.data!.secret);
    expect(again.body.data!.id).toBe(first.body.data!.id);
    // The re-shown secret still opens the scoring door.
    await expect(resolveDeviceLinkToken(again.body.data!.secret)).resolves.toMatchObject({
      id: first.body.data!.id,
    });

    expect(rateLimit.mock.calls).toEqual([
      [`dlmint:${IP}`, DEVICE_LINK_MINT_LIMIT],
      [`dlmint:${IP}`, DEVICE_LINK_MINT_LIMIT],
    ]);
  });

  it("POST …/reissue: 201 with a fresh secret, the printed QR dies, and ensure then re-shows the reissued one", async () => {
    const fixtureId = await seedFixture();
    const printed = await read(await ensurePost(req(), ctx(fixtureId)));
    expect(printed.status).toBe(201);
    rateLimit.mockClear();

    const reissued = await read(await reissuePost(req({ label: "Court 3 spare" }), ctx(fixtureId)));
    expect(reissued.status, JSON.stringify(reissued.body.error)).toBe(201);
    expect(reissued.body.data).toMatchObject({ fixture_id: fixtureId, label: "Court 3 spare", expires_at: null });
    expect(reissued.body.data!.secret).not.toBe(printed.body.data!.secret);
    await expect(resolveDeviceLinkToken(printed.body.data!.secret)).rejects.toMatchObject({
      code: "LINK_REVOKED",
    });
    // A reissue IS a mint: the same bucket, not a free second door.
    expect(rateLimit.mock.calls).toEqual([[`dlmint:${IP}`, DEVICE_LINK_MINT_LIMIT]]);

    const shown = await read(await ensurePost(req(), ctx(fixtureId)));
    expect(shown.status).toBe(200);
    expect(shown.body.data!.secret).toBe(reissued.body.data!.secret);
  });

  it("a server without DEVICE_LINK_KEK answers 503 DEVICE_LINK_KEK_MISSING on both doors, and the live link survives (Q1)", async () => {
    const fixtureId = await seedFixture();
    const live = await read(await ensurePost(req(), ctx(fixtureId)));
    expect(live.status).toBe(201);
    const keep = process.env.DEVICE_LINK_KEK;
    try {
      delete process.env.DEVICE_LINK_KEK;
      for (const post of [ensurePost, reissuePost]) {
        const refused = await read(await post(req(), ctx(fixtureId)));
        expect(refused.status).toBe(503);
        expect(refused.body.error?.code).toBe("DEVICE_LINK_KEK_MISSING");
      }
    } finally {
      process.env.DEVICE_LINK_KEK = keep;
    }
    await expect(resolveDeviceLinkToken(live.body.data!.secret)).resolves.toMatchObject({
      id: live.body.data!.id,
    });
  });
});
