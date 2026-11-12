import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUICK_MATCH_SYSTEM_ORG_ID, QUICK_MATCH_SYSTEM_USER_ID } from "@/lib/quick-match-constants";

// Quick match (pre-flight D11): the guest create runs the organizer use cases under the system org, and each fires its
// organizer analytics (competition_created, division_created, schedule_generated, later result_entered from scoring).
// Those would read as one club's runaway funnel, so `captureServer` drops every event for the system org except the one
// quick match event, `quick_match_created`.
//
// PostHog CONFIGURED here, with the SDK mocked: the harness of posthog-server.test.ts, which runs unconfigured. The key is
// read at module load, so each case re-imports the module after setting it.

const OLD_ENV = { ...process.env };
const capture = vi.fn();

beforeEach(() => {
  vi.resetModules();
  capture.mockClear();
  process.env.POSTHOG_KEY = "phc_test";
  vi.doMock("posthog-node", () => ({
    PostHog: class {
      capture = capture;
      flush = async () => {};
    },
  }));
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe("captureServer and the quick match system org (D11)", () => {
  it("drops every organizer event for the system org and passes quick_match_created", async () => {
    const { captureServer } = await import("@/lib/posthog-server");
    const { EVENTS } = await import("@/lib/analytics-events");
    const organizer = [EVENTS.COMPETITION_CREATED, EVENTS.DIVISION_CREATED, EVENTS.SCHEDULE_GENERATED, EVENTS.RESULT_ENTERED];
    for (const event of organizer) {
      await captureServer({ event, distinctId: QUICK_MATCH_SYSTEM_USER_ID, orgId: QUICK_MATCH_SYSTEM_ORG_ID });
    }
    expect(capture).not.toHaveBeenCalled();
    await captureServer({ event: EVENTS.QUICK_MATCH_CREATED, distinctId: QUICK_MATCH_SYSTEM_USER_ID, orgId: QUICK_MATCH_SYSTEM_ORG_ID });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0]).toMatchObject({ event: "quick_match_created" });
  });

  it("passes quick_match_saved too (plan 3 pre-flight D10), and still drops an organizer event beside it", async () => {
    const { captureServer } = await import("@/lib/posthog-server");
    const { EVENTS } = await import("@/lib/analytics-events");
    const saver = randomUUID();
    await captureServer({ event: EVENTS.COMPETITION_CREATED, distinctId: saver, orgId: QUICK_MATCH_SYSTEM_ORG_ID });
    await captureServer({
      event: EVENTS.QUICK_MATCH_SAVED,
      distinctId: saver,
      orgId: QUICK_MATCH_SYSTEM_ORG_ID,
      properties: { quick_match_id: randomUUID(), via: "button" },
    });
    expect(capture).toHaveBeenCalledTimes(1);
    // The plan's event name, typed here (Amend T4 [D10]): a rename in analytics-events.ts reds this case.
    expect(capture.mock.calls[0]![0]).toMatchObject({ event: "quick_match_saved", distinctId: saver });
  });

  it("passes quick_match_deleted too (controller ruling 2026-11-12), and still drops an organizer event beside it", async () => {
    const { captureServer } = await import("@/lib/posthog-server");
    const { EVENTS } = await import("@/lib/analytics-events");
    await captureServer({ event: EVENTS.COMPETITION_CREATED, distinctId: QUICK_MATCH_SYSTEM_USER_ID, orgId: QUICK_MATCH_SYSTEM_ORG_ID });
    await captureServer({
      event: EVENTS.QUICK_MATCH_DELETED,
      distinctId: QUICK_MATCH_SYSTEM_USER_ID,
      orgId: QUICK_MATCH_SYSTEM_ORG_ID,
      properties: { via: "expiry", sport_key: "badminton", kind: "pair" },
    });
    expect(capture).toHaveBeenCalledTimes(1);
    // The ruling's event name, typed here: a rename in analytics-events.ts reds this case.
    expect(capture.mock.calls[0]![0]).toMatchObject({ event: "quick_match_deleted" });
  });

  it("passes the same organizer event for any other org (the negative pair)", async () => {
    const { captureServer } = await import("@/lib/posthog-server");
    const { EVENTS } = await import("@/lib/analytics-events");
    await captureServer({ event: EVENTS.COMPETITION_CREATED, distinctId: randomUUID(), orgId: randomUUID() });
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
