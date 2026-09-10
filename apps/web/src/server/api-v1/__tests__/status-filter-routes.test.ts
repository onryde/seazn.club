// The ROUTES, not the helper.
//
// `http.test.ts` pins `assertOneOf` and `status-enum-drift.test.ts` pins the
// published enums, and BOTH stay green if a route quietly goes back to
//
//     const status = raw && STATUSES.has(raw) ? (raw as PostStatus) : undefined;
//
// which is the shape this work removed. A validator can be perfectly correct
// and never called — the inert-seam class. Nothing else in the fast suite
// reaches these two handlers, so this file drives them.
//
// Both routes live here rather than beside their own handlers because they
// share one seam and one defect; splitting the file would duplicate the whole
// fixture for a second copy of the same four assertions.
//
// Real handlers over a real seeded org; only the session door is faked, the
// same pattern as officials/import/__tests__/route.test.ts.
import { afterAll, describe, expect, it, vi } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;

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

import { PostStatus, SuspensionStatus } from "@/server/api-v1/schemas";
import { seedOrg, seedFutureDivision } from "@/server/usecases/__tests__/_seed";
import { GET as postsGet } from "@/app/api/v1/orgs/[id]/posts/route";
import { GET as suspensionsGet } from "@/app/api/v1/divisions/[id]/suspensions/route";

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>[];
  error?: { code: string; message: string };
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function url(path: string, status?: string): Request {
  const qs = status === undefined ? "" : `?status=${encodeURIComponent(status)}`;
  return new Request(`https://test.local${path}${qs}`);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("?status= is validated by the route, not ignored", () => {
  async function fixture() {
    const { auth } = await seedOrg();
    authState.userId = auth.userId!;
    const { division } = await seedFutureDivision(auth);
    return { orgId: auth.orgId, divisionId: division.id };
  }

  it("GET /orgs/:id/posts 400s a near-miss rather than returning the whole feed", async () => {
    const { orgId } = await fixture();

    // The defect, exactly: "publish" is one character from "published", and
    // the old code answered it with every post the org had — drafts included.
    const bad = await read(await postsGet(url(`/api/v1/orgs/${orgId}/posts`, "publish"), ctx(orgId)));
    expect(bad.status).toBe(400);
    expect(bad.body.ok).toBe(false);
    for (const opt of PostStatus.options) expect(bad.body.error?.message).toContain(opt);

    // The positive half: the refusal is a MEMBER check, not a blanket refusal
    // of the param. Without this a route that 400d everything would pass above.
    for (const opt of PostStatus.options) {
      const ok = await read(await postsGet(url(`/api/v1/orgs/${orgId}/posts`, opt), ctx(orgId)));
      expect(ok.status, opt).toBe(200);
      expect(ok.body.ok, opt).toBe(true);
    }

    // And an ABSENT param still means "no filter" — the one case that must
    // keep falling through, since every console read relies on it.
    const all = await read(await postsGet(url(`/api/v1/orgs/${orgId}/posts`), ctx(orgId)));
    expect(all.status).toBe(200);
  });

  it("GET /divisions/:id/suspensions 400s a near-miss rather than listing every ban", async () => {
    const { divisionId } = await fixture();
    const path = `/api/v1/divisions/${divisionId}/suspensions`;

    const bad = await read(await suspensionsGet(url(path, "pendign"), ctx(divisionId)));
    expect(bad.status).toBe(400);
    expect(bad.body.ok).toBe(false);
    for (const opt of SuspensionStatus.options) expect(bad.body.error?.message).toContain(opt);

    for (const opt of SuspensionStatus.options) {
      const ok = await read(await suspensionsGet(url(path, opt), ctx(divisionId)));
      expect(ok.status, opt).toBe(200);
    }

    const all = await read(await suspensionsGet(url(path), ctx(divisionId)));
    expect(all.status).toBe(200);
  });

  it("an empty ?status= is refused on both routes, and refused the same way", async () => {
    // `?status=` is a member check like any other — only an ABSENT param means
    // no filter. Pinned so nobody reintroduces the `raw && ...` short-circuit
    // that treated an empty string as absent; that short-circuit is half of
    // the original defect.
    const { orgId, divisionId } = await fixture();

    const post = await read(await postsGet(url(`/api/v1/orgs/${orgId}/posts`, ""), ctx(orgId)));
    const susp = await read(
      await suspensionsGet(url(`/api/v1/divisions/${divisionId}/suspensions`, ""), ctx(divisionId)),
    );
    expect(post.status).toBe(400);
    expect(susp.status).toBe(400);
  });
});
