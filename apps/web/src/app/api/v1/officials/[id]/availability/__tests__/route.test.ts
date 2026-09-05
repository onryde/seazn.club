// G2 (bench B03 product-gaps, 2026-09-02): before this route existed, an
// organiser told "I can't do the 14th" by an official had no way to record
// it — V284 granted app_user SELECT ONLY on official_availability, so every
// write went through /me (superuser connection, self-service, fans the date
// out across every org linked to that person). V391 grants insert/update/
// delete scoped by the table's existing tenant RLS policy; this route and
// its usecase functions (setOfficialBlackout/deleteOfficialBlackout) are the
// first callers.
//
// Real handlers over a real session — mocking `requireResourceAuth` would
// delete the very thing under test here, which is tenant isolation: org B
// must not be able to write org A's official's blackout row. Only the
// session door is faked (`requireUser`), same pattern as
// persons/__tests__/merge-route.test.ts; `requireResourceAuth` and the
// RLS-scoped `withTenant` write are both real.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { sql } from "@/lib/db";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { createOfficial, listOfficialBlackouts } from "@/server/usecases/officials";
import { GET, POST, DELETE } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

function postReq(body: unknown): Request {
  return new Request("https://test.local/api/v1/officials/x/availability", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteReq(date?: string | null): Request {
  const url = new URL("https://test.local/api/v1/officials/x/availability");
  if (date !== undefined && date !== null) url.searchParams.set("date", date);
  return new Request(url, { method: "DELETE" });
}

function getReq(): Request {
  return new Request("https://test.local/api/v1/officials/x/availability", { method: "GET" });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  await globalForDb._sql?.end();
});

describe.skipIf(!HAS_DB)("POST/DELETE /officials/{id}/availability (G2)", () => {
  beforeEach(() => {
    authState.userId = "";
  });

  it("records and clears a blackout on this org's own official", async () => {
    const { auth } = await seedOrg();
    authState.userId = auth.userId!;
    const official = await createOfficial(auth, {
      display_name: "Ref One",
      role_keys: ["referee"],
    });

    const created = await POST(postReq({ date: "2030-06-14", note: "family event" }), {
      params: Promise.resolve({ id: official.id }),
    });
    const { status, body } = await read(created);
    expect(status).toBe(201);
    expect(body.data).toEqual({ date: "2030-06-14", note: "family event" });

    const rows = await listOfficialBlackouts(auth);
    expect(rows).toEqual([{ official_id: official.id, date: "2030-06-14", note: "family event" }]);

    const cleared = await DELETE(deleteReq("2030-06-14"), { params: Promise.resolve({ id: official.id }) });
    expect(cleared.status).toBe(200);
    expect((await listOfficialBlackouts(auth)).length).toBe(0);

    // Idempotent: clearing an already-clear date is not an error.
    const again = await DELETE(deleteReq("2030-06-14"), { params: Promise.resolve({ id: official.id }) });
    expect(again.status).toBe(200);
  });

  it("upserts on note (same conflict target as /me's self-service write)", async () => {
    const { auth } = await seedOrg();
    authState.userId = auth.userId!;
    const official = await createOfficial(auth, { display_name: "Ref Two", role_keys: ["referee"] });

    await POST(postReq({ date: "2030-07-01", note: "first" }), { params: Promise.resolve({ id: official.id }) });
    await POST(postReq({ date: "2030-07-01", note: "updated" }), { params: Promise.resolve({ id: official.id }) });

    const rows = await listOfficialBlackouts(auth);
    expect(rows).toEqual([{ official_id: official.id, date: "2030-07-01", note: "updated" }]);
  });

  it("rejects a malformed ?date on DELETE before touching the DB", async () => {
    const { auth } = await seedOrg();
    authState.userId = auth.userId!;
    const official = await createOfficial(auth, { display_name: "Ref Three", role_keys: ["referee"] });

    const res = await DELETE(deleteReq("not-a-date"), { params: Promise.resolve({ id: official.id }) });
    expect(res.status).toBe(400);
  });

  it("blocks org B from writing org A's official's blackout, and writes nothing", async () => {
    const { auth: authA } = await seedOrg();
    const { auth: authB } = await seedOrg();
    const officialA = await createOfficial(authA, { display_name: "Org A Ref", role_keys: ["referee"] });

    authState.userId = authB.userId!;
    const res = await POST(postReq({ date: "2030-08-01", note: "org B trying" }), {
      params: Promise.resolve({ id: officialA.id }),
    });
    expect([401, 403, 404]).toContain(res.status);

    // Superuser check: no row landed for officialA regardless of which side
    // (auth or RLS) refused it.
    const rows = await sql<{ id: string }[]>`
      select id from official_availability where official_id = ${officialA.id}`;
    expect(rows.length).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("GET /officials/{id}/availability (G9)", () => {
  beforeEach(() => {
    authState.userId = "";
  });

  it("reads back exactly what POST wrote — scoped to this official, not the org-wide console list", async () => {
    const { auth } = await seedOrg();
    authState.userId = auth.userId!;
    const official = await createOfficial(auth, { display_name: "Ref Four", role_keys: ["referee"] });
    const other = await createOfficial(auth, { display_name: "Ref Five", role_keys: ["referee"] });

    await POST(postReq({ date: "2030-09-01", note: "wedding" }), { params: Promise.resolve({ id: official.id }) });
    await POST(postReq({ date: "2030-09-10", note: null }), { params: Promise.resolve({ id: official.id }) });
    // A second official's blackout must never leak into the first's read.
    await POST(postReq({ date: "2030-09-01", note: "other person's date" }), {
      params: Promise.resolve({ id: other.id }),
    });

    const { status, body } = await read(await GET(getReq(), { params: Promise.resolve({ id: official.id }) }));
    expect(status).toBe(200);
    expect(body.data).toEqual([
      { date: "2030-09-01", note: "wedding" },
      { date: "2030-09-10", note: null },
    ]);
  });

  it("returns an empty list, not a 404, for an official with no blackouts", async () => {
    const { auth } = await seedOrg();
    authState.userId = auth.userId!;
    const official = await createOfficial(auth, { display_name: "Ref Six", role_keys: ["referee"] });

    const { status, body } = await read(await GET(getReq(), { params: Promise.resolve({ id: official.id }) }));
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("blocks org B from reading org A's official's blackouts", async () => {
    const { auth: authA } = await seedOrg();
    const { auth: authB } = await seedOrg();
    const officialA = await createOfficial(authA, { display_name: "Org A Ref 2", role_keys: ["referee"] });
    await POST(postReq({ date: "2030-10-01", note: "secret" }), { params: Promise.resolve({ id: officialA.id }) });

    authState.userId = authB.userId!;
    const res = await GET(getReq(), { params: Promise.resolve({ id: officialA.id }) });
    expect([401, 403, 404]).toContain(res.status);
  });
});
