// Cron route for the daily monthly grants: the AI wallet sweep (v17 Task 6) and, since Task 14b (R3c), the stream
// match-credit sweep beside it. next/headers is mocked so the route runs without a request scope, and both sweeps are
// mocked so this stays DB-free — their logic is covered in credits-monthly-cron.test.ts and
// stream-credits-monthly.test.ts.
//
// The point of this file is the WIRING (billing-quantity/route.test.ts's #332 lesson): a sweep nothing invokes is
// indistinguishable from an absent one, and nothing in the sweep's own suite could notice. And the stream sweep is a
// SECOND product on the AI grant's schedule, so its failure must never turn the AI grant's response into an error.
import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const mocks = vi.hoisted(() => ({
  aiSweep: vi.fn(),
  earnAlert: vi.fn(),
  streamSweep: vi.fn(),
}));
vi.mock("@/lib/credits", () => ({
  grantMonthlyForAllWallets: mocks.aiSweep,
  checkEarnGrantVolumeAlert: mocks.earnAlert,
}));
vi.mock("@/server/usecases/stream-credits", () => ({
  ensureMonthlyStreamGrantsForAllOrgs: mocks.streamSweep,
}));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  for (const m of Object.values(mocks)) m.mockReset();
});

const authorize = () => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
  mocks.aiSweep.mockResolvedValue({ wallets: 4, granted: 70, failed: 0 });
  mocks.earnAlert.mockResolvedValue(undefined);
  mocks.streamSweep.mockResolvedValue({ orgs: 3, granted: 7, failed: 0 });
};

type Body = { data: { wallets?: number; granted?: number; failed?: number; stream?: unknown } };

describe("POST /api/cron/billing-grant", () => {
  it("401s on a missing or wrong x-cron-secret, running neither sweep", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST()).status).toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST()).status).toBe(401);
    let checked = 0;
    for (const m of Object.values(mocks)) {
      expect(m).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("Task 14b (R3c): runs the stream match-credit sweep, UNSCOPED (every org), and returns its counts beside the AI grant's", async () => {
    authorize();
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mocks.aiSweep).toHaveBeenCalledTimes(1);
    expect(mocks.streamSweep).toHaveBeenCalledTimes(1);
    // No `orgIds`: the scope exists for tests; the cron must reach every org.
    const arg = mocks.streamSweep.mock.calls[0]![0] as { orgIds?: unknown } | undefined;
    expect(arg?.orgIds).toBeUndefined();
    const body = (await res.json()) as Body;
    // The AI grant's top-level shape is unchanged (billing-grant-stg.yml reads it), and the stream counts ride beside it.
    expect(body.data).toMatchObject({ wallets: 4, granted: 70, failed: 0, stream: { orgs: 3, granted: 7, failed: 0 } });
  });

  it("a stream sweep that THROWS is logged and reported, never a failed AI grant response", async () => {
    authorize();
    mocks.streamSweep.mockRejectedValue(new Error("stream ledger unavailable"));
    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.data).toMatchObject({ wallets: 4, granted: 70, failed: 0, stream: { error: true } });
    expect(mocks.earnAlert, "the farm-watch still runs").toHaveBeenCalledTimes(1);
  });
});
