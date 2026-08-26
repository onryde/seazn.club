// RS005 W4 — POST /registrations/:id/resend-confirmation. HTTP wiring over
// registrations.ts's resendRegistrationConfirmation: routing/authz here
// (same harness approval-routes.test.ts established), the cart-shaped mail
// content itself is email-builders.test.ts's job.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

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

const emailMock = vi.hoisted(() => ({ sendRegistrationEmail: vi.fn(
    // Typed to the REAL signature. `vi.fn(async () => true)` declares a
    // zero-parameter spy, so `mock.calls[0][0]` indexes an empty tuple and
    // tsc rejects every assertion about what was actually sent — errors
    // vitest never surfaces, because it does not typecheck test files.
    async (_opts: Parameters<typeof import("@/lib/email").sendRegistrationEmail>[0]) => true,
  ) }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendRegistrationEmail: emailMock.sendRegistrationEmail };
});

import { sql } from "@/lib/db";
import {
  asOwner,
  makeUser,
  rig,
  seedOrg,
  seedSecondEntry,
  seedRegistration,
} from "@/server/usecases/__tests__/_registration-fixtures";
import { POST as resendRoute } from "@/app/api/v1/registrations/[id]/resend-confirmation/route";

const HAS_DB = !!process.env.DATABASE_URL;

const SETTINGS = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function postReq(path: string): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
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

beforeEach(() => {
  emailMock.sendRegistrationEmail.mockReset().mockResolvedValue(true);
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("POST /registrations/:id/resend-confirmation", () => {
  it("owner: 200, sent:true, mailer called with the cart's contact", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {
      contactEmail: "rep@test.local",
      refCode: `SZ-RS${randomUUID().slice(0, 6).toUpperCase()}`,
    });

    const { status, body } = await read(
      await resendRoute(postReq(`/registrations/${registration.id}/resend-confirmation`), ctx(registration.id)),
    );
    expect(status).toBe(200);
    expect(body.data).toEqual({ sent: true });
    expect(emailMock.sendRegistrationEmail).toHaveBeenCalledTimes(1);
    expect(emailMock.sendRegistrationEmail.mock.calls[0]![0].to).toBe("rep@test.local");
  });

  // The whole point of a cart-shaped resend: hitting it from ANY entry in a
  // multi-entry cart resends every entry, not just the one named in the URL.
  it("resends the WHOLE cart, not just the one entry named in the URL", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration: first } = await seedRegistration(competition.id, division.id, SETTINGS, {
      displayName: "First Entry",
      contactEmail: "cart-rep@test.local",
      refCode: `SZ-RS${randomUUID().slice(0, 6).toUpperCase()}`,
    });
    await seedSecondEntry(first.group_id, division.id, 0, "Second Entry", "waitlisted");

    const { status, body } = await read(
      await resendRoute(postReq(`/registrations/${first.id}/resend-confirmation`), ctx(first.id)),
    );
    expect(status).toBe(200);
    expect(body.data).toEqual({ sent: true });
    const sent = emailMock.sendRegistrationEmail.mock.calls[0]![0];
    expect(sent.entries).toHaveLength(2);
    const names = (sent.entries as { displayName: string }[]).map((e) => e.displayName).sort();
    expect(names).toEqual(["First Entry", "Second Entry"]);
  });

  it("does not mint a fresh checkout — payUrl is always null on resend", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {
      refCode: `SZ-RS${randomUUID().slice(0, 6).toUpperCase()}`,
    });

    await resendRoute(postReq(`/registrations/${registration.id}/resend-confirmation`), ctx(registration.id));
    expect(emailMock.sendRegistrationEmail.mock.calls[0]![0].payUrl).toBeNull();
  });

  it("authz: owner and admin allowed; viewer and scorer denied", async () => {
    const { orgId, owner } = await signedInOwner();
    const adminId = await memberWithRole(orgId, "admin");
    const viewerId = await memberWithRole(orgId, "viewer");
    const scorerId = await memberWithRole(orgId, "scorer");
    const { competition, division } = await rig(owner);
    const { registration: untouched } = await seedRegistration(competition.id, division.id, SETTINGS, {
      refCode: `SZ-RS${randomUUID().slice(0, 6).toUpperCase()}`,
    });

    authState.userId = viewerId;
    expect(
      (await resendRoute(postReq(`/registrations/${untouched.id}/resend-confirmation`), ctx(untouched.id))).status,
    ).toBe(403);
    authState.userId = scorerId;
    expect(
      (await resendRoute(postReq(`/registrations/${untouched.id}/resend-confirmation`), ctx(untouched.id))).status,
    ).toBe(403);
    expect(emailMock.sendRegistrationEmail).not.toHaveBeenCalled();

    const { registration: ownerCase } = await seedRegistration(competition.id, division.id, SETTINGS, {
      refCode: `SZ-RS${randomUUID().slice(0, 6).toUpperCase()}`,
    });
    authState.userId = owner.userId!;
    expect(
      (await resendRoute(postReq(`/registrations/${ownerCase.id}/resend-confirmation`), ctx(ownerCase.id))).status,
    ).toBe(200);

    const { registration: adminCase } = await seedRegistration(competition.id, division.id, SETTINGS, {
      refCode: `SZ-RS${randomUUID().slice(0, 6).toUpperCase()}`,
    });
    authState.userId = adminId;
    expect(
      (await resendRoute(postReq(`/registrations/${adminCase.id}/resend-confirmation`), ctx(adminCase.id))).status,
    ).toBe(200);
  });

  it("audits the resend", async () => {
    const { owner, orgId } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {
      refCode: `SZ-RS${randomUUID().slice(0, 6).toUpperCase()}`,
    });

    await resendRoute(postReq(`/registrations/${registration.id}/resend-confirmation`), ctx(registration.id));
    const [audit] = await sql`
      select 1 from competition_events
      where type = 'registration.confirmation_resent'
        and org_id = ${orgId}
        and payload->>'registration_id' = ${registration.id}`;
    expect(audit).toBeDefined();
  });
});

describe.skipIf(!HAS_DB)("POST /registrations/:id/resend-confirmation — terminal entries get nothing", () => {
  // Observed live by the owner: a WITHDRAWN entry rendered Resend, the click
  // succeeded, and the row reported "Confirmation email sent". So someone who
  // had pulled out received an email confirming their registration — and
  // because the mail is cart-shaped, it re-stated their whole cart to them as
  // though nothing had happened.
  //
  // The button gate is a courtesy; this is the rule. The route is reachable
  // directly with a session or an API key, so the refusal lives in the
  // usecase and is asserted here at the HTTP edge.
  it.each(["withdrawn", "rejected", "expired"] as const)(
    "refuses a %s entry with a 422 and sends nothing",
    async (terminalStatus) => {
      const { owner } = await signedInOwner();
      const { competition, division } = await rig(owner);
      const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {
        displayName: `Gone (${terminalStatus})`,
      });
      await sql`update registrations set status = ${terminalStatus} where id = ${registration.id}`;
      emailMock.sendRegistrationEmail.mockClear();

      const { status, body } = await read(
        await resendRoute(
          postReq(`/registrations/${registration.id}/resend-confirmation`),
          ctx(registration.id),
        ),
      );

      expect(status).toBe(422);
      expect(body.error?.message).toContain(terminalStatus);
      expect(
        emailMock.sendRegistrationEmail,
        "nothing may reach the registrant's inbox",
      ).not.toHaveBeenCalled();
    },
  );

  it("still resends for a live entry — this narrows the action, it does not remove it", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {
      displayName: "Still In",
    });
    emailMock.sendRegistrationEmail.mockClear();

    const { status, body } = await read(
      await resendRoute(
        postReq(`/registrations/${registration.id}/resend-confirmation`),
        ctx(registration.id),
      ),
    );
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ sent: true });
    expect(emailMock.sendRegistrationEmail).toHaveBeenCalledTimes(1);
  });
});
