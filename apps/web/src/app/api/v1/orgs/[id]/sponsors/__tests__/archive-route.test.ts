// Archive a sponsor, Task 3 (spec docs/superpowers/specs/2026-11-11-sponsor-archive-design.md §6.3, D12, D13, D26): the v1 routes
// over the REAL handlers, the REAL session door and the REAL tables (on-stream.test.ts's rig).
//   GET  /orgs/{id}/sponsors                       rows with archived_at null only; `?archived=1` every row; any other value as the default
//   POST /orgs/{id}/sponsors/{sponsorId}/archive   200 Sponsor, stamped; a second call keeps the first stamp; 409 while a deal holds it
//   DELETE …/archive                              200 Sponsor, archived_at null; idempotent
//   PATCH {archived_at: null}                      400 (the key is stripped: no back door)
//   who: editors only (owner, admin); a viewer is 403 and nothing changes
// Expected values come from §6.3's table, typed here. Sport-agnostic: no sport sweep (archiving reads no sport).
import { afterAll, describe, expect, it, vi } from "vitest";

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
import { Sponsor } from "@/server/api-v1/schemas";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { GET as listRoute, POST as createRoute } from "../route";
import { PATCH } from "../[sponsorId]/route";
import { DELETE as unarchiveRoute, POST as archiveRoute } from "../[sponsorId]/archive/route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } };
type Row = { id: string; archived_at: string | null };
const base = (orgId: string) => `http://localhost/api/v1/orgs/${orgId}/sponsors`;
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const create = (orgId: string, body: unknown) => createRoute(new Request(base(orgId), json("POST", body)), { params: Promise.resolve({ id: orgId }) });
const list = (orgId: string, query = "") => listRoute(new Request(`${base(orgId)}${query}`), { params: Promise.resolve({ id: orgId }) });
const archive = (orgId: string, sponsorId: string) =>
  archiveRoute(new Request(`${base(orgId)}/${sponsorId}/archive`, { method: "POST" }), { params: Promise.resolve({ id: orgId, sponsorId }) });
const unarchive = (orgId: string, sponsorId: string) =>
  unarchiveRoute(new Request(`${base(orgId)}/${sponsorId}/archive`, { method: "DELETE" }), { params: Promise.resolve({ id: orgId, sponsorId }) });
const patch = (orgId: string, sponsorId: string, body: unknown) =>
  PATCH(new Request(`${base(orgId)}/${sponsorId}`, json("PATCH", body)), { params: Promise.resolve({ id: orgId, sponsorId }) });

async function organiser() {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  return { orgId: auth.orgId, ownerId: auth.userId! };
}
async function sponsorOf(orgId: string, name: string): Promise<string> {
  const res = await create(orgId, { name });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}
const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as Envelope).data as T;
const listed = async (orgId: string, query = ""): Promise<Row[]> => {
  const res = await list(orgId, query);
  expect(res.status, `GET ${query || "(default)"}`).toBe(200);
  return dataOf<Row[]>(res);
};
const storedAt = async (id: string): Promise<string | null> => {
  const at = (await sql<{ archived_at: Date | null }[]>`select archived_at from sponsors where id = ${id}`)[0]?.archived_at ?? null;
  return at === null ? null : at.toISOString();
};

describe.skipIf(!HAS_DB)("the archive routes (spec §6.3)", () => {
  it("POST archives and answers the Sponsor shape; a second POST keeps the first archived_at; DELETE answers it unarchived, twice", async () => {
    const o = await organiser();
    const id = await sponsorOf(o.orgId, "Harbour Physio");

    const first = await archive(o.orgId, id);
    expect(first.status).toBe(200);
    const archived = Sponsor.parse(await dataOf(first));
    const at = await storedAt(id);
    expect(at, "stored").not.toBeNull();
    expect(archived.archived_at === null ? null : new Date(archived.archived_at).toISOString(), "the answer's stamp is the stored one").toBe(at);

    await new Promise((r) => setTimeout(r, 20));
    const second = Sponsor.parse(await dataOf(await archive(o.orgId, id)));
    expect(second.archived_at, "idempotent: the first stamp").toBe(archived.archived_at);
    expect(await storedAt(id)).toBe(at);

    const back = await unarchive(o.orgId, id);
    expect(back.status).toBe(200);
    expect(Sponsor.parse(await dataOf(back)).archived_at).toBeNull();
    expect(await storedAt(id)).toBeNull();
    const again = await unarchive(o.orgId, id);
    expect(again.status, "idempotent").toBe(200);
    expect(Sponsor.parse(await dataOf(again)).archived_at).toBeNull();
  });

  it("GET omits archived rows by default; ?archived=1 includes them, stamped; ?archived=0 and ?archived=yes omit them (count reported)", async () => {
    const o = await organiser();
    const gone = await sponsorOf(o.orgId, "Old Mill");
    const kept = await sponsorOf(o.orgId, "New Quay");
    expect((await archive(o.orgId, gone)).status).toBe(200);
    const at = await storedAt(gone);

    const CASES: [string, boolean][] = [["", false], ["?archived=1", true], ["?archived=0", false], ["?archived=yes", false]];
    let checked = 0;
    for (const [query, includes] of CASES) {
      const rows = await listed(o.orgId, query);
      for (const r of rows) Sponsor.parse(r);
      expect(rows.map((r) => r.id), `${query || "(default)"}: the unarchived row is always listed`).toContain(kept);
      expect(rows.some((r) => r.id === gone), `${query || "(default)"}: the archived row`).toBe(includes);
      if (includes) expect(new Date(rows.find((r) => r.id === gone)!.archived_at!).toISOString()).toBe(at);
      expect(rows.find((r) => r.id === kept)!.archived_at).toBeNull();
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });

  it("a sponsor a deal holds: POST is 409 sponsor_has_current_deal through the envelope, and it stays unarchived", async () => {
    const o = await organiser();
    const id = await sponsorOf(o.orgId, "Live Co");
    const [{ id: packageId }] = await sql<{ id: string }[]>`
      insert into sponsor_packages (org_id, name, price_cents, currency, tier) values (${o.orgId}, 'Partner', 25000, 'gbp', 'partner')
      returning id`;
    await sql`
      insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, amount_cents, currency, status, deal_status,
                                  payment_method, go_live, tier, includes_on_stream, package_name, live_at)
      values (${o.orgId}, ${packageId}, ${id}, 'Live Co', 25000, 'gbp', 'pending', 'live', 'offline', 'immediate', 'partner', false,
              'Partner', now())`;
    const res = await archive(o.orgId, id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Envelope).error?.code).toBe("sponsor_has_current_deal");
    expect(await storedAt(id)).toBeNull();
  });

  it("PATCH {archived_at: null} is 400 (the key is in no write schema), and the sponsor stays archived", async () => {
    const o = await organiser();
    const id = await sponsorOf(o.orgId, "Back Door Ltd");
    await archive(o.orgId, id);
    const at = await storedAt(id);
    const res = await patch(o.orgId, id, { archived_at: null });
    expect(res.status).toBe(400);
    expect(await storedAt(id), "still archived, same stamp").toBe(at);
  });

  it("D26, the granted AND the denied pair: an admin archives and unarchives; a viewer is 403 on both and nothing changes", async () => {
    const o = await organiser();
    const id = await sponsorOf(o.orgId, "Who May");
    const member = async (role: "admin" | "viewer") => {
      const u = await makeUser(role);
      await sql`insert into org_members (org_id, user_id, role) values (${o.orgId}, ${u.id}, ${role})`;
      return u.id;
    };
    const adminId = await member("admin");
    const viewerId = await member("viewer");

    authState.userId = viewerId;
    expect((await archive(o.orgId, id)).status, "viewer archive").toBe(403);
    expect(await storedAt(id)).toBeNull();
    authState.userId = adminId;
    expect((await archive(o.orgId, id)).status, "admin archive").toBe(200);
    const at = await storedAt(id);
    expect(at).not.toBeNull();
    authState.userId = viewerId;
    expect((await unarchive(o.orgId, id)).status, "viewer unarchive").toBe(403);
    expect(await storedAt(id)).toBe(at);
    authState.userId = adminId;
    expect((await unarchive(o.orgId, id)).status, "admin unarchive").toBe(200);
    expect(await storedAt(id)).toBeNull();
  });
});
