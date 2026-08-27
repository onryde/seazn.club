// Staff alert for a registration refund that FAILS (RS006 follow-up task):
// money the organiser owes a registrant that never moved. The audit event
// (`registration.refund_failed`) was already written at all three real
// sites — confirmPaidRegistration's late/duplicate refund path,
// withdrawCore's pre-lock auto-refund, and rejectRegistration's
// refund-on-reject — but read nowhere outside tests, so a failed refund was
// invisible until a registrant complained.
//
// `maybeAlertRegistrationRefundFailed` mirrors maybeAlertOrgRepriceFailed
// (billing-events.ts) / maybeAlertOrgAllowance (extra-orgs.ts): never
// throws, gated on STAFF_ALERT_EMAIL before anything else, awaited (not
// fire-and-forget), exported so the never-throws contract is testable
// DIRECTLY rather than through a caller's own catch, which would hide a
// missing wrapper. Goes to the PLATFORM OPERATOR only (owner ruling) — never
// the organiser or registrant: the usual causes (a restricted connected
// account, a reversed transfer with no headroom, a disconnected
// destination) are Connect/platform-level and not something an organiser
// can act on.
//
// This file covers the helper directly — it has no DB queries of its own,
// so no DATABASE_URL / HAS_DB gate is needed. The three real call sites are
// covered where their DB fixtures already live: registrations.test.ts
// (confirmPaidRegistration, withdrawCore) and registration-approval.test.ts
// (rejectRegistration).
import { afterEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendRegistrationRefundFailedAlertEmail: sendMock };
});

import { log } from "@/server/logger";
import { sendRegistrationRefundFailedAlertEmail } from "@/lib/email";
import { maybeAlertRegistrationRefundFailed } from "../registrations";

const baseOpts = {
  registrationId: "reg-test-1",
  orgId: "org-test-1",
  competitionId: "comp-test-1",
  amountCents: 1234,
  currency: "gbp",
  paymentIntentId: "pi_test_abc123",
  reason: "card declined",
};

afterEach(() => {
  vi.mocked(sendRegistrationRefundFailedAlertEmail).mockClear();
  delete process.env.STAFF_ALERT_EMAIL;
  // CAUTION (found during this task): vi.spyOn on the shared `log` singleton
  // leaks call history across tests in the same file without this — the
  // never-throws test below spies on log.error, so this file must restore.
  vi.restoreAllMocks();
});

describe("maybeAlertRegistrationRefundFailed", () => {
  it("returns without sending when STAFF_ALERT_EMAIL is unset", async () => {
    delete process.env.STAFF_ALERT_EMAIL;
    await expect(maybeAlertRegistrationRefundFailed(baseOpts)).resolves.toBeUndefined();
    expect(sendRegistrationRefundFailedAlertEmail).not.toHaveBeenCalled();
  });

  it("sends to STAFF_ALERT_EMAIL with the full opts when set", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    await maybeAlertRegistrationRefundFailed(baseOpts);
    expect(sendRegistrationRefundFailedAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendRegistrationRefundFailedAlertEmail).toHaveBeenCalledWith({
      to: "ops@seazn.test",
      ...baseOpts,
    });
  });

  it("never throws — a send failure is swallowed and logged", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    vi.mocked(sendRegistrationRefundFailedAlertEmail).mockRejectedValueOnce(new Error("boom"));
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => undefined as never);

    await expect(maybeAlertRegistrationRefundFailed(baseOpts)).resolves.toBeUndefined();

    // The send really was attempted — otherwise this would pass vacuously
    // without ever entering the catch.
    expect(sendRegistrationRefundFailedAlertEmail).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [meta] = errSpy.mock.calls[0]!;
    expect((meta as { registrationId: string }).registrationId).toBe(baseOpts.registrationId);
  });
});
