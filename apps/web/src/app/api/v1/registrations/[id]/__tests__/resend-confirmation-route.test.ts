// RS005 W4 — POST /registrations/:id/resend-confirmation. HTTP wiring over
// registrations.ts's resendRegistrationConfirmation: routing/authz here
// (same harness approval-routes.test.ts established), the cart-shaped mail
// content itself is email-builders.test.ts's job.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The resend queues the cart's confirmation on the email outbox (kind `registration_confirmation`, ref `registration_group/<group id>`)
// and attempts it at once. Only the outbox's network seam is replaced; the rows, the claim and the render are the real ones.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

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
import { idempotencyKey } from "@/server/email-outbox/constants";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";

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

async function memberWithRole(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const userId = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
  return userId;
}

beforeEach(() => {
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_rc_${randomUUID()}` }));
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type ConfirmationRow = { id: string; kind: string; ref_type: string; recipient: string; subject: string; status: string; attempts: number };

/** The cart's confirmation rows, oldest first. */
const confirmationRows = (groupId: string) =>
  sql<ConfirmationRow[]>`
    select id, kind, ref_type, recipient, subject, status, attempts from email_outbox
     where kind = 'registration_confirmation' and ref_type = 'registration_group' and ref_id = ${groupId}
     order by created_at, id`;

/** What the provider was handed under one of these rows. */
const providerSaw = (rows: { id: string }[]) => {
  const keys = new Set(rows.map((r) => idempotencyKey(r.id)));
  return transport.deliver.mock.calls
    .map((c) => c[0] as { to: string; subject: string; html: string; text: string; idempotencyKey: string })
    .filter((m) => keys.has(m.idempotencyKey));
};

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("POST /registrations/:id/resend-confirmation", () => {
  it("owner: 200, sent:true, the confirmation queued for the cart's contact and sent", async () => {
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
    const rows = await confirmationRows(registration.group_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "registration_confirmation", ref_type: "registration_group", recipient: "rep@test.local", status: "sent" });
    expect(rows[0]!.subject).toBe(dictionarySubject("en", "registration.subject", { competitionName: competition.name }));
    const saw = providerSaw(rows);
    expect(saw).toHaveLength(1);
    expect(saw[0]!.to).toBe("rep@test.local");
  });

  // The notice the organiser reads when sent is false (reg.hub.registrants.detail.actions.resendNotSent): the mail is queued and the
  // outbox is retrying, so the answer is 200 {sent:false} and NOT an error. The row is what the retry worker finishes.
  it("the provider is down: 200, sent:false, and the confirmation stays queued for the retry", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {
      contactEmail: "later@test.local",
      refCode: `SZ-RS${randomUUID().slice(0, 6).toUpperCase()}`,
    });
    transport.deliver.mockReset().mockImplementation(async () => ({ ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" }));

    const { status, body } = await read(
      await resendRoute(postReq(`/registrations/${registration.id}/resend-confirmation`), ctx(registration.id)),
    );
    expect(status).toBe(200);
    expect(body.data).toEqual({ sent: false });
    const rows = await confirmationRows(registration.group_id);
    expect(rows).toMatchObject([{ recipient: "later@test.local", status: "queued", attempts: 1 }]);
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
    const rows = await confirmationRows(first.group_id);
    expect(rows, "one mail for the whole cart").toHaveLength(1);
    const saw = providerSaw(rows);
    expect(saw).toHaveLength(1);
    expect(saw[0]!.text).toContain("First Entry");
    expect(saw[0]!.text).toContain("Second Entry");
  });

  it("does not mint a fresh checkout — the resent mail carries no pay link", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    // A card cart that still owes money: the one shape whose mail WOULD carry a pay link if a checkout were minted.
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 1500, currency: "gbp", payment_method: "stripe" },
      { refCode: `SZ-RS${randomUUID().slice(0, 6).toUpperCase()}` },
    );

    const { status } = await read(
      await resendRoute(postReq(`/registrations/${registration.id}/resend-confirmation`), ctx(registration.id)),
    );
    expect(status).toBe(200);
    const saw = providerSaw(await confirmationRows(registration.group_id));
    expect(saw).toHaveLength(1);
    // Positive: the mail does ask for the fee; negative: it offers no pay button (the dictionary's own label).
    expect(saw[0]!.text).toContain(dictionarySubject("en", "registration.textFeeContactOrganiser", { amount: "£15.00" }));
    expect(saw[0]!.html).not.toContain(dictionarySubject("en", "registration.payNow", { amount: "£15.00" }));
  });

  it("authz: owner and admin allowed; viewer denied", async () => {
    const { orgId, owner } = await signedInOwner();
    const adminId = await memberWithRole(orgId, "admin");
    const viewerId = await memberWithRole(orgId, "viewer");
    const { competition, division } = await rig(owner);
    const { registration: untouched } = await seedRegistration(competition.id, division.id, SETTINGS, {
      refCode: `SZ-RS${randomUUID().slice(0, 6).toUpperCase()}`,
    });

    authState.userId = viewerId;
    expect(
      (await resendRoute(postReq(`/registrations/${untouched.id}/resend-confirmation`), ctx(untouched.id))).status,
    ).toBe(403);
    expect(await confirmationRows(untouched.group_id), "a denied resend queues nothing").toHaveLength(0);
    expect(transport.deliver).not.toHaveBeenCalled();

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

      const { status, body } = await read(
        await resendRoute(
          postReq(`/registrations/${registration.id}/resend-confirmation`),
          ctx(registration.id),
        ),
      );

      expect(status).toBe(422);
      expect(body.error?.message).toContain(terminalStatus);
      expect(await confirmationRows(registration.group_id), "nothing is queued").toHaveLength(0);
      expect(transport.deliver, "nothing may reach the registrant's inbox").not.toHaveBeenCalled();
    },
  );

  it("still resends for a live entry — this narrows the action, it does not remove it", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {
      displayName: "Still In",
    });

    const { status, body } = await read(
      await resendRoute(
        postReq(`/registrations/${registration.id}/resend-confirmation`),
        ctx(registration.id),
      ),
    );
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ sent: true });
    expect(await confirmationRows(registration.group_id)).toHaveLength(1);
    expect(transport.deliver).toHaveBeenCalledTimes(1);
  });
});
