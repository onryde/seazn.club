// Unit coverage for the registration BROWSER driver's PURE parts (B03r
// tasks 9+10, design §9: "browser drivers have no meaningful unit test (no
// jsdom rule) — this is their floor"). Nothing here launches Chromium or
// touches a `Page`/`BrowserContext` — nothing in this file could, since
// `browserOrganiser`/`browserCaptain`/`browserPlayer`'s own DOM-driving
// bodies (`configureRegistrationViaApi`, `actViaHub`, `enterViaStepper`,
// `payViaCheckout`, `joinViaForm`) are not exported and need a real `Page`.
// What IS exported and genuinely pure is covered exhaustively: the hub/
// division-builder selector builders, the submit-status mapping, the
// paid-status predicate, the poll loop (fetcher injected), and the
// failure-artefact path builder — same DI-for-testability shape
// `dls-gate.ts`/`seed.ts` already use elsewhere in this bench.
import { describe, expect, it, vi } from "vitest";
import {
  divisionBuilderCategorySelector,
  failureArtefactPaths,
  hubAssignActionSelector,
  hubAssignTargetSelector,
  hubRegistrantActionSelector,
  hubRegistrantRowSelector,
  isPaidStatus,
  mapSubmitStatus,
  pollUntilPaid,
  type PollResult,
} from "../browser.ts";

describe("hub selector builders", () => {
  it("hubRegistrantRowSelector: the boolean marker AND the id, both required", () => {
    expect(hubRegistrantRowSelector("reg-1")).toBe(
      '[data-registration-hub-registrant-row][data-registration-id="reg-1"]',
    );
  });

  it("hubRegistrantActionSelector: scoped INSIDE the row selector, never a bare global match", () => {
    const selector = hubRegistrantActionSelector("reg-1", "approve");
    expect(selector.startsWith(hubRegistrantRowSelector("reg-1"))).toBe(true);
    expect(selector).toContain('[data-registration-hub-registrant-action="approve"]');
  });

  it("hubRegistrantActionSelector: a DIFFERENT registrationId produces a DIFFERENT selector — proves it is not a constant string with the action interpolated blind", () => {
    expect(hubRegistrantActionSelector("reg-1", "approve")).not.toBe(hubRegistrantActionSelector("reg-2", "approve"));
    expect(hubRegistrantActionSelector("reg-1", "approve")).not.toBe(hubRegistrantActionSelector("reg-1", "reject"));
  });

  it("hubAssignActionSelector: also scoped to the row, both 'open' and 'unassign'", () => {
    expect(hubAssignActionSelector("reg-1", "open")).toBe(
      `${hubRegistrantRowSelector("reg-1")} [data-registration-hub-assign-action="open"]`,
    );
    expect(hubAssignActionSelector("reg-1", "unassign")).toContain('data-registration-hub-assign-action="unassign"');
  });

  it("hubAssignTargetSelector: NOT row-scoped (the assign-picker dialog renders outside the row's own subtree)", () => {
    const selector = hubAssignTargetSelector("team-9");
    expect(selector).toBe('[data-registration-hub-assign-target="team-9"]');
    expect(selector.startsWith("[data-registration-hub-registrant-row]")).toBe(false);
  });

  it("divisionBuilderCategorySelector: the label, never the underlying sr-only radio", () => {
    expect(divisionBuilderCategorySelector("mixed")).toBe('label[data-category="mixed"]');
  });
});

describe("mapSubmitStatus — the exact submit-time vocabulary (registration-submit.ts:739,850-851)", () => {
  it("waitlisted -> waitlisted", () => {
    expect(mapSubmitStatus("waitlisted")).toBe("waitlisted");
  });
  it("confirmed -> approved (the wire spells auto-approval 'confirmed'; this driver's own vocabulary calls it 'approved')", () => {
    expect(mapSubmitStatus("confirmed")).toBe("approved");
  });
  it("pending -> pending", () => {
    expect(mapSubmitStatus("pending")).toBe("pending");
  });
  it("paid -> pending: a pay-up-front entry reaches the status page ALREADY paid, and paid is not approved", () => {
    // This test asserted the opposite until a live paid run proved it wrong.
    // The vocabulary was enumerated from the free path, where the status page
    // can only say waitlisted/pending/confirmed. On a `payment_method: "stripe"`
    // division the stepper redirects to hosted Checkout and only returns here
    // once the row has settled — so the FIRST successful live payment ended in
    // this function throwing on its own success.
    //
    // "pending", not "approved": the money moved, the organiser has not acted.
    // Under `approval: "manual"` a paid entry still waits for a human.
    expect(mapSubmitStatus("paid")).toBe("pending");
  });
  it("throws on any OTHER value rather than guessing — 'rejected'/'withdrawn'/'expired' are not submit-time statuses", () => {
    expect(() => mapSubmitStatus("rejected")).toThrow(/unrecognised submit-time registration status "rejected"/);
    expect(() => mapSubmitStatus("withdrawn")).toThrow();
    expect(() => mapSubmitStatus("")).toThrow();
  });
});

describe("isPaidStatus — the two-terminal-states rule (register.ts's own PAID_STATUSES)", () => {
  it("'paid' (manual-approval, still awaiting approveRegistration) counts", () => {
    expect(isPaidStatus("paid")).toBe(true);
  });
  it("'confirmed' (auto-approval, already materialised) ALSO counts — accepting only one would red every division of the other approval mode", () => {
    expect(isPaidStatus("confirmed")).toBe(true);
  });
  it("every other status does not", () => {
    for (const s of ["pending", "waitlisted", "rejected", "withdrawn", "expired", ""]) {
      expect(isPaidStatus(s)).toBe(false);
    }
  });
});

describe("failureArtefactPaths", () => {
  it("namespaces by runTag, and sanitises an unsafe label into a filesystem-safe slug (each disallowed char, incl. adjacent ones, becomes its own '-')", () => {
    const paths = failureArtefactPaths("run-42", "entry ext/key #1");
    expect(paths.screenshotPath).toBe("bench-report/registration-failures/run-42/entry-ext-key--1.png");
    expect(paths.tracePath).toBe("bench-report/registration-failures/run-42/entry-ext-key--1.trace.zip");
  });

  it("two different labels under the SAME runTag never collide", () => {
    const a = failureArtefactPaths("run-1", "reg-cap1");
    const b = failureArtefactPaths("run-1", "reg-cap2");
    expect(a.screenshotPath).not.toBe(b.screenshotPath);
    expect(a.tracePath).not.toBe(b.tracePath);
  });
});

// ---------------------------------------------------------------------------
// pollUntilPaid — the ONLY genuinely stateful pure logic in this file, DI'd
// over an injected `fetchStatus` (never a real Page/network call) so its
// retry-until-terminal and its timeout-is-a-wrong-STATE behaviour are both
// directly testable. Uses vitest's fake timers so a 60s default timeout
// test runs instantly rather than actually waiting — no real wall-clock
// assertion is made anywhere (`_RULES.md` §1's load-sensitive-timing rule);
// `intervalMs`/`timeoutMs` are passed explicitly and small here purely to
// keep the fake-timer bookkeeping simple, never asserted as a performance
// budget.
// ---------------------------------------------------------------------------

describe("pollUntilPaid", () => {
  it("returns immediately once the FIRST poll is already paid/confirmed — no interval wait at all", async () => {
    const fetchStatus = vi.fn(async (): Promise<PollResult> => ({ status: "paid" }));
    const result = await pollUntilPaid(fetchStatus, { intervalMs: 5, timeoutMs: 1000 });
    expect(result).toEqual({ status: "paid" });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("retries on a non-terminal status until one arrives, waiting intervalMs between polls", async () => {
    let calls = 0;
    const fetchStatus = vi.fn(async (): Promise<PollResult> => {
      calls += 1;
      return { status: calls < 3 ? "pending" : "confirmed" };
    });
    const result = await pollUntilPaid(fetchStatus, { intervalMs: 1, timeoutMs: 1000 });
    expect(result).toEqual({ status: "confirmed" });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  // MUTATION CHECK (reported in this session's final message): deleting the
  // `if (isPaidStatus(...)) return last;` line inside `pollUntilPaid`
  // reddens BOTH tests above (the first would then always hit the timeout
  // path instead of returning after one call) — the guard is not a no-op
  // that a mutant survives.
  it("times out and throws when the status NEVER reaches paid/confirmed — a wrong STATE, not a slow one (design §5.3)", async () => {
    const fetchStatus = vi.fn(async (): Promise<PollResult> => ({ status: "pending" }));
    await expect(pollUntilPaid(fetchStatus, { intervalMs: 1, timeoutMs: 5 })).rejects.toThrow(
      /never reached paid\/confirmed within 5ms — last observed status "pending"/,
    );
    // At least one poll happened before the deadline check fired — proves
    // this isn't a timeout that fires before ever calling fetchStatus at
    // all (which would make the "last observed status" message meaningless).
    expect(fetchStatus.mock.calls.length).toBeGreaterThan(0);
  });

  it("the error message names the ACTUAL last-observed status, not a generic 'timed out' — an operator reading the report sees what the entry was stuck at", async () => {
    const fetchStatus = vi.fn(async (): Promise<PollResult> => ({ status: "waitlisted" }));
    await expect(pollUntilPaid(fetchStatus, { intervalMs: 1, timeoutMs: 3 })).rejects.toThrow(/"waitlisted"/);
  });
});
