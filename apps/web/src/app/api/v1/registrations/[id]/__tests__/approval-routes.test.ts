// RS005 W1b — new routes: HTTP in front of registration-approval.ts's
// approveRegistration/rejectRegistration/promoteFromWaitlist. The
// transitions themselves are registration-approval.ts's (do-not-touch,
// already tested there) — this suite is about the HTTP wiring: routing,
// authz, the access_token_hash strip, and (for promote specifically) the
// division_id/registration_id override adaptation this route owns.
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

import { sql } from "@/lib/db";
import { putRegistrationSettings } from "@/server/usecases/registrations";
import {
  asOwner,
  makeUser,
  rig,
  seedOrg,
  seedRegistration,
} from "@/server/usecases/__tests__/_registration-fixtures";
import { POST as approveRoute } from "@/app/api/v1/registrations/[id]/approve/route";
import { POST as rejectRoute } from "@/app/api/v1/registrations/[id]/reject/route";
import { POST as promoteRoute } from "@/app/api/v1/registrations/[id]/promote/route";

const SETTINGS = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };
const MANUAL_SETTINGS_INPUT = {
  enabled: true,
  entrant_kind: "individual" as const,
  fee_cents: 0,
  payment_method: "offline" as const,
  form_fields: [],
  approval: "manual" as const,
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function postReq(path: string, body?: unknown): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown> | null;
  error?: { code: string; message: string };
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function signedInOwner() {
  const { orgId, ownerId } = await seedOrg();
  authState.userId = ownerId;
  return { orgId, owner: asOwner(orgId, ownerId) };
}

async function memberWithRole(orgId: string, role: "admin" | "viewer" | "scorer"): Promise<string> {
  const userId = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
  return userId;
}

/** A manual-approval division plus one fresh `pending` registration. */
async function manualDivisionWithPending(owner: ReturnType<typeof asOwner>) {
  const { competition, division } = await rig(owner);
  await putRegistrationSettings(owner, division.id, MANUAL_SETTINGS_INPUT);
  const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });
  return { competition, division, registration };
}

async function status(regId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${regId}`;
  return row!.status;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("POST /registrations/:id/approve", () => {
  it("on an auto-approval division: 422, the real approveRegistration rule (nothing to approve manually)", async () => {
    const { owner } = await signedInOwner();
    // rig() leaves NO registration_settings row — same as a real 'auto'
    // division for approveRegistration's own loadApprovalSettings read.
    const { competition, division } = await rig(owner);
    const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {
      status: "pending",
    });

    const { status: httpStatus, body } = await read(
      await approveRoute(postReq(`/registrations/${registration.id}/approve`), ctx(registration.id)),
    );
    expect(httpStatus).toBe(422);
    expect(body.error?.message).toMatch(/automatic approval/i);
    expect(await status(registration.id)).toBe("pending"); // untouched
  });

  it("on a manual-approval division: confirms and materialises the entrant, no access_token_hash", async () => {
    const { owner } = await signedInOwner();
    const { registration } = await manualDivisionWithPending(owner);

    const { status: httpStatus, body } = await read(
      await approveRoute(postReq(`/registrations/${registration.id}/approve`), ctx(registration.id)),
    );
    expect(httpStatus).toBe(200);
    expect(body.data!.status).toBe("confirmed");
    expect(body.data!.entrant_id).toEqual(expect.any(String));
    expect(body.data).not.toHaveProperty("access_token_hash");
  });

  it("authz: owner and admin allowed; viewer and scorer denied", async () => {
    const { orgId, owner } = await signedInOwner();
    const adminId = await memberWithRole(orgId, "admin");
    const viewerId = await memberWithRole(orgId, "viewer");
    const scorerId = await memberWithRole(orgId, "scorer");
    const untouched = (await manualDivisionWithPending(owner)).registration;

    authState.userId = viewerId;
    expect(
      (await approveRoute(postReq(`/registrations/${untouched.id}/approve`), ctx(untouched.id))).status,
    ).toBe(403);
    authState.userId = scorerId;
    expect(
      (await approveRoute(postReq(`/registrations/${untouched.id}/approve`), ctx(untouched.id))).status,
    ).toBe(403);
    expect(await status(untouched.id)).toBe("pending"); // neither denial mutated it

    const ownerCase = (await manualDivisionWithPending(owner)).registration;
    authState.userId = owner.userId!;
    expect(
      (await approveRoute(postReq(`/registrations/${ownerCase.id}/approve`), ctx(ownerCase.id))).status,
    ).toBe(200);

    const adminCase = (await manualDivisionWithPending(owner)).registration;
    authState.userId = adminId;
    expect(
      (await approveRoute(postReq(`/registrations/${adminCase.id}/approve`), ctx(adminCase.id))).status,
    ).toBe(200);
  });
});

describe.skipIf(!HAS_DB)("POST /registrations/:id/reject", () => {
  it("is terminal: rejects, then a follow-up approve on the SAME row 422s", async () => {
    const { owner } = await signedInOwner();
    const { registration } = await manualDivisionWithPending(owner);

    const rejected = await read(
      await rejectRoute(postReq(`/registrations/${registration.id}/reject`), ctx(registration.id)),
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.data!.status).toBe("rejected");
    expect(rejected.body.data).not.toHaveProperty("access_token_hash");

    const approveAfter = await read(
      await approveRoute(postReq(`/registrations/${registration.id}/approve`), ctx(registration.id)),
    );
    expect(approveAfter.status).toBe(422);
    expect(approveAfter.body.error?.message).toMatch(/rejected/i);
    expect(await status(registration.id)).toBe("rejected"); // still terminal, not silently confirmed
  });

  it("authz: owner and admin allowed; viewer and scorer denied", async () => {
    const { orgId, owner } = await signedInOwner();
    const adminId = await memberWithRole(orgId, "admin");
    const viewerId = await memberWithRole(orgId, "viewer");
    const scorerId = await memberWithRole(orgId, "scorer");
    const untouched = (await manualDivisionWithPending(owner)).registration;

    authState.userId = viewerId;
    expect((await rejectRoute(postReq(`/registrations/${untouched.id}/reject`), ctx(untouched.id))).status).toBe(
      403,
    );
    authState.userId = scorerId;
    expect((await rejectRoute(postReq(`/registrations/${untouched.id}/reject`), ctx(untouched.id))).status).toBe(
      403,
    );
    expect(await status(untouched.id)).toBe("pending");

    const ownerCase = (await manualDivisionWithPending(owner)).registration;
    authState.userId = owner.userId!;
    expect((await rejectRoute(postReq(`/registrations/${ownerCase.id}/reject`), ctx(ownerCase.id))).status).toBe(
      200,
    );

    const adminCase = (await manualDivisionWithPending(owner)).registration;
    authState.userId = adminId;
    expect((await rejectRoute(postReq(`/registrations/${adminCase.id}/reject`), ctx(adminCase.id))).status).toBe(
      200,
    );
  });
});

describe.skipIf(!HAS_DB)("POST /registrations/:id/promote", () => {
  it("defaults to oldest-first in the URL id's division, ignoring which row the URL id names", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration: oldest } = await seedRegistration(competition.id, division.id, SETTINGS, {
      status: "waitlisted",
    });
    const { registration: middle } = await seedRegistration(competition.id, division.id, SETTINGS, {
      status: "waitlisted",
    });
    const { registration: newest } = await seedRegistration(competition.id, division.id, SETTINGS, {
      status: "waitlisted",
    });
    await sql`update registrations set created_at = now() - interval '3 hours' where id = ${oldest.id}`;
    await sql`update registrations set created_at = now() - interval '2 hours' where id = ${middle.id}`;
    await sql`update registrations set created_at = now() - interval '1 hour' where id = ${newest.id}`;

    // URL id is the NEWEST row — proves the default path reads "id's
    // division", not "promote id itself".
    const { status: httpStatus, body } = await read(
      await promoteRoute(postReq(`/registrations/${newest.id}/promote`, {}), ctx(newest.id)),
    );
    expect(httpStatus).toBe(200);
    expect(body.data!.id).toBe(oldest.id);
    expect(body.data!.status).toBe("pending");
    expect(body.data).not.toHaveProperty("access_token_hash");
    expect(await status(middle.id)).toBe("waitlisted");
    expect(await status(newest.id)).toBe("waitlisted");
  });

  it("an explicit registration_id overrides the default, skipping the actual oldest", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration: older } = await seedRegistration(competition.id, division.id, SETTINGS, {
      status: "waitlisted",
    });
    const { registration: newer } = await seedRegistration(competition.id, division.id, SETTINGS, {
      status: "waitlisted",
    });
    await sql`update registrations set created_at = now() - interval '2 hours' where id = ${older.id}`;
    await sql`update registrations set created_at = now() - interval '1 hour' where id = ${newer.id}`;

    const { status: httpStatus, body } = await read(
      await promoteRoute(
        postReq(`/registrations/${older.id}/promote`, { registration_id: newer.id }),
        ctx(older.id),
      ),
    );
    expect(httpStatus).toBe(200);
    expect(body.data!.id).toBe(newer.id); // NOT older, which is the actual oldest
    expect(await status(older.id)).toBe("waitlisted"); // left alone by the override
  });

  it("returns null when nothing is waitlisted in the id's division (default path)", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });

    const { status: httpStatus, body } = await read(
      await promoteRoute(postReq(`/registrations/${registration.id}/promote`, {}), ctx(registration.id)),
    );
    expect(httpStatus).toBe(200);
    expect(body.data).toBeNull();
  });

  it("authz: owner and admin allowed; viewer and scorer denied", async () => {
    const { orgId, owner } = await signedInOwner();
    const adminId = await memberWithRole(orgId, "admin");
    const viewerId = await memberWithRole(orgId, "viewer");
    const scorerId = await memberWithRole(orgId, "scorer");
    const { competition, division } = await rig(owner);
    const { registration: untouched } = await seedRegistration(competition.id, division.id, SETTINGS, {
      status: "waitlisted",
    });

    authState.userId = viewerId;
    expect(
      (await promoteRoute(postReq(`/registrations/${untouched.id}/promote`, {}), ctx(untouched.id))).status,
    ).toBe(403);
    authState.userId = scorerId;
    expect(
      (await promoteRoute(postReq(`/registrations/${untouched.id}/promote`, {}), ctx(untouched.id))).status,
    ).toBe(403);
    expect(await status(untouched.id)).toBe("waitlisted");

    const ownerRig = await rig(owner);
    const { registration: ownerReg } = await seedRegistration(ownerRig.competition.id, ownerRig.division.id, SETTINGS, {
      status: "waitlisted",
    });
    authState.userId = owner.userId!;
    expect(
      (await promoteRoute(postReq(`/registrations/${ownerReg.id}/promote`, {}), ctx(ownerReg.id))).status,
    ).toBe(200);

    const adminRig = await rig(owner);
    const { registration: adminReg } = await seedRegistration(adminRig.competition.id, adminRig.division.id, SETTINGS, {
      status: "waitlisted",
    });
    authState.userId = adminId;
    expect(
      (await promoteRoute(postReq(`/registrations/${adminReg.id}/promote`, {}), ctx(adminReg.id))).status,
    ).toBe(200);
  });
});
