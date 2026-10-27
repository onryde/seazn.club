// Staff alert for a registration refund that FAILS (RS006 follow-up task):
// money the organiser owes a registrant that never moved. The audit event
// (`registration.refund_failed`) is written at all four real sites —
// confirmPaidRegistration's late/duplicate refund path, withdrawCore's
// pre-lock auto-refund, the sweep's pool-deadline refund and
// rejectRegistration's refund-on-reject — but read nowhere outside tests, so a
// failed refund was invisible until a registrant complained.
//
// `maybeAlertRegistrationRefundFailed` queues the alert on the email outbox
// through `queueStaffAlert` (phase 3 wave 5, kind
// `staff_registration_refund_failed`): to STAFF_ALERT_EMAIL, no org, no
// account, once per registration, mode and amount (P-W5-7), and it never
// throws (Q1). Goes to the PLATFORM OPERATOR only (owner ruling) — never the
// organiser or registrant.
//
// This file drives the helper directly against the real writer and a real
// database (the rows are what it asserts); the four real call sites are
// covered where their fixtures live: registrations.test.ts
// (confirmPaidRegistration, withdrawCore) and registration-approval.test.ts
// (rejectRegistration). Expected subjects are a frozen literal typed from the
// sender's source (`Registration refund failed — <money> still owed
// (registration <id>)`, `money` = en-GB currency format). Sport: not
// applicable (no staff alert names a sport).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The builder, observed: every call reaches the real one unless a test makes it throw.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, registrationRefundFailedAlertEmail: vi.fn(actual.registrationRefundFailedAlertEmail) };
});
// Sentry's issue capture, observed (call-through): a dropped alert opens an issue.
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn(actual.captureError) };
});

import { sql } from "@/lib/db";
import { registrationRefundFailedAlertEmail } from "@/lib/email";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { maybeAlertRegistrationRefundFailed } from "../registrations";
import { STAFF_ALERT_QUEUE_FAILED } from "../staff-alert";
import { staffAlertDrops, staffRows } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `rra-${randomUUID().slice(0, 8)}`;
const KIND = "staff_registration_refund_failed";
const staffAddress = (tag: string): string => `staff-${RUN}-${tag}@x.test`;

const optsFor = (registrationId: string) => ({
  registrationId,
  orgId: randomUUID(),
  competitionId: randomUUID(),
  amountCents: 1234,
  currency: "gbp",
  paymentIntentId: "pi_test_abc123",
  reason: "card declined",
  mode: "auto" as const,
});
/** The sender's subject, typed from its source: `money(1234, "gbp")` is en-GB currency. */
const subjectFor = (registrationId: string) => `Registration refund failed — £12.34 still owed (registration ${registrationId})`;

beforeEach(() => {
  vi.mocked(captureError).mockClear();
  vi.mocked(registrationRefundFailedAlertEmail).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where kind = ${KIND} and lower(recipient) like ${`staff-${RUN}-%`}`;
});

describe.skipIf(!HAS_DB)("maybeAlertRegistrationRefundFailed (DB)", () => {
  it("queues one staff row keyed by registration, mode and amount; the same failure again pages once, another mode pages again", async () => {
    const to = staffAddress("once");
    vi.stubEnv("STAFF_ALERT_EMAIL", to);
    const errors = vi.spyOn(log, "error");
    const regId = randomUUID();

    const first = await maybeAlertRegistrationRefundFailed(optsFor(regId));
    const again = await maybeAlertRegistrationRefundFailed(optsFor(regId));

    expect(first, "the first failure is queued").toEqual(expect.any(String));
    expect(again, "the same unmoved refund failing again is the same incident").toBeNull();
    expect(await staffRows(KIND, "registration", regId)).toEqual([
      { ref_id: `${regId}:auto:1234`, dedupe_key: `${regId}:auto:1234`, status: "queued", recipient: to, subject: subjectFor(regId) },
    ]);
    // The key carries the mode: the same registration failing on another path is another incident.
    const rejected = await maybeAlertRegistrationRefundFailed({ ...optsFor(regId), mode: "reject" });
    expect(rejected, "a different mode pages again").toEqual(expect.any(String));
    expect((await staffRows(KIND, "registration", regId)).map((r) => r.ref_id)).toEqual([`${regId}:auto:1234`, `${regId}:reject:1234`]);
    expect(staffAlertDrops(errors, vi.mocked(captureError)), "nothing was dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("unset or blank STAFF_ALERT_EMAIL queues nothing and is not an error; set, the same call queues", async () => {
    const errors = vi.spyOn(log, "error");
    const regId = randomUUID();
    let checked = 0;
    for (const value of ["", "   "]) {
      vi.stubEnv("STAFF_ALERT_EMAIL", value);
      await expect(maybeAlertRegistrationRefundFailed(optsFor(regId)), `STAFF_ALERT_EMAIL=${JSON.stringify(value)}`).resolves.toBeNull();
      checked++;
    }
    expect(checked, "anti-vacuity: empty and blank were each driven").toBe(2);
    expect(await staffRows(KIND, "registration", regId), "no row, to any recipient").toHaveLength(0);
    expect(registrationRefundFailedAlertEmail, "nothing was rendered").not.toHaveBeenCalled();

    // The positive pair: the very same call, with an address, is queued.
    const to = staffAddress("unset");
    vi.stubEnv("STAFF_ALERT_EMAIL", to);
    expect(await maybeAlertRegistrationRefundFailed(optsFor(regId))).toEqual(expect.any(String));
    expect(await staffRows(KIND, "registration", regId)).toMatchObject([{ recipient: to, status: "queued" }]);
    expect(staffAlertDrops(errors, vi.mocked(captureError)), "unset is not a drop").toEqual({ logged: 0, issues: 0 });
  });

  it("never throws: a render that throws is logged, opens a Sentry issue and writes nothing; the next call queues", async () => {
    const to = staffAddress("throws");
    vi.stubEnv("STAFF_ALERT_EMAIL", to);
    const errors = vi.spyOn(log, "error");
    const regId = randomUUID();
    vi.mocked(registrationRefundFailedAlertEmail).mockImplementationOnce(() => {
      throw new Error("the alert builder failed");
    });

    await expect(maybeAlertRegistrationRefundFailed(optsFor(regId))).resolves.toBeNull();

    expect(registrationRefundFailedAlertEmail, "the render really was reached").toHaveBeenCalledTimes(1);
    expect(staffAlertDrops(errors, vi.mocked(captureError)), "one drop: one log line, one Sentry issue").toEqual({ logged: 1, issues: 1 });
    const drop = errors.mock.calls.find((c) => c[1] === STAFF_ALERT_QUEUE_FAILED)!;
    expect(drop[0]).toMatchObject({ kind: KIND, refType: "registration" });
    expect(await staffRows(KIND, "registration", regId), "nothing was written").toHaveLength(0);

    // The positive pair: the builder works again, and the same incident is queued (a drop holds no key).
    expect(await maybeAlertRegistrationRefundFailed(optsFor(regId))).toEqual(expect.any(String));
    expect(await staffRows(KIND, "registration", regId)).toMatchObject([{ ref_id: `${regId}:auto:1234`, recipient: to }]);
  });
});
