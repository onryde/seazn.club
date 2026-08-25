// RS005 W1b review follow-up — the six PRE-EXISTING single-registration action
// routes returned the usecase row verbatim, `access_token_hash` included.
//
// Why nothing caught it: `v1()` neither validates nor strips against the
// OpenAPI response schema (`api-v1/http.ts:124-149` serialises whatever the
// handler returns), so `S.Registration` never omitting the field was pure
// documentation, and `tsc` sees an object with one extra string property as
// perfectly assignable. Only an assertion on the SERIALISED body can fail.
//
// The hash is what the registrant's own `?token=` is compared against
// (`tokenMatchesHash`), so it is credential-derived and must not reach an
// organiser session. These routes all now go through `organiserRegistration`.
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
import { asOwner, rig, seedOrg, seedRegistration } from "@/server/usecases/__tests__/_registration-fixtures";
import { POST as confirmRoute } from "@/app/api/v1/registrations/[id]/confirm/route";
import { POST as markPaidRoute } from "@/app/api/v1/registrations/[id]/mark-paid/route";
import { POST as waiveRoute } from "@/app/api/v1/registrations/[id]/waive/route";
import { POST as waitlistRoute } from "@/app/api/v1/registrations/[id]/waitlist/route";
import { POST as withdrawRoute } from "@/app/api/v1/registrations/[id]/withdraw/route";

const SETTINGS = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };
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

async function freshPending(feeCents = 0) {
  const { orgId, ownerId } = await seedOrg();
  authState.userId = ownerId;
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  if (feeCents > 0) {
    // markRegistrationPaidOffline gates on the DIVISION's registration_settings
    // fee (`loadSettings(...).fee_cents <= 0` → 422), not on the entry's own
    // amount_cents — rig() writes no settings row at all, so the fee has to be
    // put there explicitly or the route refuses and the assertion goes vacuous.
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: feeCents,
      payment_method: "offline",
      form_fields: [],
      approval: "auto",
    });
  }
  const { registration } = await seedRegistration(
    competition.id,
    division.id,
    { ...SETTINGS, fee_cents: feeCents },
    { status: "pending", amountCents: feeCents },
  );
  return registration;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// One case per route. Each drives a real 200 — a route that 4xx'd would pass a
// "no access_token_hash" assertion vacuously, so the status is asserted first.
// mark-paid carries a fee on purpose: recording an offline payment against a
// FREE entry is a 422 ("nothing to pay"), which is exactly the vacuous green
// the status assertion above exists to prevent.
const ROUTES: [name: string, feeCents: number, run: (id: string) => Promise<Response>][] = [
  ["confirm", 0, (id) => confirmRoute(postReq(`/registrations/${id}/confirm`), ctx(id))],
  ["mark-paid", 2500, (id) => markPaidRoute(postReq(`/registrations/${id}/mark-paid`), ctx(id))],
  ["waive", 0, (id) => waiveRoute(postReq(`/registrations/${id}/waive`), ctx(id))],
  ["waitlist", 0, (id) => waitlistRoute(postReq(`/registrations/${id}/waitlist`), ctx(id))],
  ["withdraw", 0, (id) => withdrawRoute(postReq(`/registrations/${id}/withdraw`), ctx(id))],
];

describe.skipIf(!HAS_DB)("organiser registration responses carry no access_token_hash", () => {
  it.each(ROUTES)("POST /registrations/:id/%s", async (_name, feeCents, run) => {
    const registration = await freshPending(feeCents);
    const res = await run(registration.id);
    const body = (await res.json()) as Envelope;

    expect(res.status).toBe(200);
    expect(body.data).toBeTruthy();
    expect(body.data).not.toHaveProperty("access_token_hash");

    // The column really is populated on this row — otherwise the assertion
    // above would hold for a reason that has nothing to do with the strip.
    const [row] = await sql<{ hash: string | null }[]>`
      select g.access_token_hash as hash
      from registrations r join registration_groups g on g.id = r.group_id
      where r.id = ${registration.id}`;
    expect(row?.hash).toBeTruthy();
  });
});
