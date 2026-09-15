import { test, expect } from "@playwright/test";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedMemberIdentity,
  expectGate,
} from "../settings-support";
import { TAG, apiJson } from "../helpers";

/**
 * W3 role-gate matrix (Task 2, register cases 5 and 6): a `viewer` is
 * refused every write the settings UI hides from them, by the ROUTE itself
 * — not by the disabled prop the UI happens to render. Every status here was
 * re-pinned against the actual handler before being asserted (the
 * `/api/orgs/*` family throws `AuthError` -> 401 via `requireOrgRole`; the
 * `/api/v1/orgs/*` family throws `HttpError(403, …)` via `requireOrgAuth`'s
 * scope check — confirmed by reading `lib/auth.ts:488-498` and
 * `server/api-v1/auth.ts:210-226` directly, not assumed from the brief).
 */

const DENIED: {
  label: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: (orgId: string, userId: string) => string;
  body?: unknown;
  status: number;
}[] = [
  // /api/orgs/* — requireOrgRole throws AuthError, which maps to 401
  // (lib/http.ts's `handler`). A viewer is a member (so the "not a member"
  // 401 branch does not fire) but is excluded from every role list below.
  {
    label: "rename the org",
    method: "PATCH",
    path: (o) => `/api/orgs/${o}`,
    body: { name: `${TAG}-nope` },
    status: 401,
  },
  {
    label: "get a logo upload url",
    method: "POST",
    path: (o) => `/api/orgs/${o}/logo-upload-url`,
    status: 401,
  },
  {
    label: "get a content upload url",
    method: "POST",
    path: (o) => `/api/orgs/${o}/content-upload`,
    body: { content_type: "image/png" },
    status: 401,
  },
  {
    label: "mint an invite",
    method: "POST",
    path: (o) => `/api/orgs/${o}/invites`,
    body: { role: "viewer", max_uses: 1 },
    status: 401,
  },
  {
    label: "change a member's role",
    method: "POST",
    path: (o, u) => `/api/orgs/${o}/members/${u}/role`,
    body: { role: "admin" },
    status: 401,
  },
  {
    label: "remove a member",
    method: "DELETE",
    path: (o, u) => `/api/orgs/${o}/members/${u}`,
    status: 401,
  },
  {
    label: "transfer ownership",
    method: "POST",
    path: (o) => `/api/orgs/${o}/transfer-owner`,
    // `requireOrgRole` runs BEFORE `transferOwnerSchema.parse` in this route
    // (transfer-owner/route.ts:17-18), so a viewer 401s before the body is
    // ever read — the target id here is a placeholder, not the real member.
    body: { new_owner_id: "00000000-0000-0000-0000-000000000000" },
    status: 401,
  },
  // /api/v1/orgs/* — requireOrgAuth's scope check throws HttpError(403, …)
  // once membership is established (a viewer is READ_ROLES, not
  // EDITOR_ROLES/write-scoped). Bodies here must satisfy each route's own
  // zod schema: sponsors/sponsor-packages/api-keys POST run `parseBody`
  // BEFORE `requireOrgAuth`, so an invalid body would 400 before the role
  // check ever runs and the row would silently stop testing the gate.
  {
    label: "create a sponsor",
    method: "POST",
    path: (o) => `/api/v1/orgs/${o}/sponsors`,
    body: { name: `${TAG}-s` },
    status: 403,
  },
  {
    label: "create a sponsor package",
    method: "POST",
    path: (o) => `/api/v1/orgs/${o}/sponsor-packages`,
    body: { name: `${TAG}-pkg`, price_cents: 1000 },
    status: 403,
  },
  {
    label: "generate a weekly digest",
    method: "POST",
    path: (o) => `/api/v1/orgs/${o}/posts/digest`,
    status: 403,
  },
  {
    label: "list api keys",
    method: "GET",
    path: (o) => `/api/v1/orgs/${o}/api-keys`,
    status: 403,
  },
  {
    label: "mint an api key",
    method: "POST",
    path: (o) => `/api/v1/orgs/${o}/api-keys`,
    body: { name: `${TAG}-key` },
    status: 403,
  },
];

test("a viewer is refused every write, by the route and not just the UI", async ({
  browser,
  request,
}) => {
  const org = await seedSettingsOrg(request, { label: "w3-role-denied" });
  const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
  try {
    for (const row of DENIED) {
      await expectGate({
        label: row.label,
        request: member.request,
        method: row.method,
        path: row.path(org.orgId, member.userId),
        body: row.body,
        expectStatus: row.status,
      });
    }
  } finally {
    await member.release();
    await releaseSettingsOrg(request, org);
  }
});

/**
 * The positive pair. A sweep of refusals passes in full against an identity
 * that is simply broken — a context with no session refuses everything too.
 * These two rows pin that this IS a real, working viewer membership: its own
 * org's member list (ORG_ROLES, includes viewer — members/route.ts:13) and a
 * `read`-scoped v1 route (READ_ROLES, includes viewer —
 * server/api-v1/auth.ts:217). Self-contained (own org, own member,
 * own finally) rather than sharing state with the DENIED test above.
 */
test("the same viewer is ALLOWED what a viewer may do", async ({ browser, request }) => {
  const org = await seedSettingsOrg(request, { label: "w3-role-allowed" });
  const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
  try {
    await expectGate({
      label: "read the member list",
      request: member.request,
      method: "GET",
      path: `/api/orgs/${org.orgId}/members`,
      expectStatus: 200,
    });
    await expectGate({
      label: "read sponsors",
      request: member.request,
      method: "GET",
      path: `/api/v1/orgs/${org.orgId}/sponsors`,
      expectStatus: 200,
    });
  } finally {
    await member.release();
    await releaseSettingsOrg(request, org);
  }
});

/**
 * Case 6: the role select is owner-only-and-not-self in the UI
 * (`isOwner && m.user_id !== currentUserId`, org-team.tsx:191), but
 * `members/[userId]/role/route.ts` compares nothing to the caller — so an
 * owner CAN demote themselves via the API, provided another owner exists
 * (the route's own last-owner guard, role/route.ts:35-41, is the only thing
 * that would stop it).
 *
 * `POST /api/orgs/{id}/invites` cannot mint an "owner" invite directly
 * (`createInviteSchema` only accepts admin/viewer — lib/types.ts), so
 * the second owner is minted by inviting an admin, then promoting them via
 * the same role route this test is exercising — verified as a real,
 * assertable precondition, not just setup.
 */
test("an owner can demote itself via the API, once a second owner exists", async ({
  browser,
  request,
}) => {
  const org = await seedSettingsOrg(request, { label: "w3-role-selfdemote" });
  const coOwner = await seedMemberIdentity(browser, request, org.orgId, "admin");
  let originalOwnerId: string | undefined;
  try {
    const me = await apiJson<{ id: string }>(request, "/api/users/me");
    originalOwnerId = me.data!.id;

    // Precondition: promote the co-owner to owner. Asserted, not just
    // performed — if this doesn't actually work the rest of the test proves
    // nothing.
    const promote = await apiJson(
      request,
      `/api/orgs/${org.orgId}/members/${coOwner.userId}/role`,
      "POST",
      { role: "owner" },
    );
    expect(promote.status, "promoting the second member to owner failed").toBe(200);

    // The original owner demotes ITSELF to admin. No self-guard on the
    // route — assert the route's answer...
    const demote = await apiJson(
      request,
      `/api/orgs/${org.orgId}/members/${originalOwnerId}/role`,
      "POST",
      { role: "admin" },
    );
    expect(demote.status, "self-demotion via the API was refused").toBe(200);

    // ...AND the row, because a 200 that changed nothing satisfies the
    // status assertion on its own.
    const after = await apiJson<{ user_id: string; role: string }[]>(
      request,
      `/api/orgs/${org.orgId}/members`,
    );
    const originalOwnerRow = after.data!.find((m) => m.user_id === originalOwnerId);
    expect(
      originalOwnerRow?.role,
      "the route answered 200 but the original owner's row did not actually move",
    ).toBe("admin");
  } finally {
    // Restore the original owner (via the co-owner, who is still `owner`)
    // so `coOwner.release()`'s own DELETE — issued as `request`, which is
    // the org's `owner` argument to seedMemberIdentity — still has owner
    // privileges to run with, and releaseSettingsOrg's single-owner cleanup
    // finds the row it expects. Guarded: if the demote assertion above threw
    // before `originalOwnerId` resolved, there is nothing to restore.
    if (originalOwnerId) {
      await apiJson(
        coOwner.request,
        `/api/orgs/${org.orgId}/members/${originalOwnerId}/role`,
        "POST",
        { role: "owner" },
      ).catch(() => {});
    }
    await coOwner.release();
    await releaseSettingsOrg(request, org);
  }
});
