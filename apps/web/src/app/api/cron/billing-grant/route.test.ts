// Cron route for the daily AI wallet grant (v17 Task 6). next/headers is mocked so the route runs without a request
// scope, and the sweep is mocked so this stays DB-free — its logic is covered in credits-monthly-cron.test.ts.
//
// The point of this file is the WIRING (billing-quantity/route.test.ts's #332 lesson): a sweep nothing invokes is
// indistinguishable from an absent one, and nothing in the sweep's own suite could notice.
//
// Task 14b review M4 (controller ruling 2026-09-29, amending R3): the stream match credits are NOT granted here. Every
// reader of the stream balance rolls the org's month over itself (stream-credits.ts `ensureMonthlyStreamGrant`), so a
// cron sweep would only write two ledger rows per live org per month for orgs that never stream. The stream-credits
// module is mocked with spies so a re-added sweep is seen both ways: a call, and a `stream` key on the response.
import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const mocks = vi.hoisted(() => ({
  aiSweep: vi.fn(),
  earnAlert: vi.fn(),
}));
const stream = vi.hoisted(() => ({
  ensureMonthlyStreamGrant: vi.fn(),
  grantMonthlyStreamCredits: vi.fn(),
}));
vi.mock("@/lib/credits", () => ({
  grantMonthlyForAllWallets: mocks.aiSweep,
  checkEarnGrantVolumeAlert: mocks.earnAlert,
}));
vi.mock("@/server/usecases/stream-credits", () => stream);

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  for (const m of [...Object.values(mocks), ...Object.values(stream)]) m.mockReset();
});

const authorize = () => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
  mocks.aiSweep.mockResolvedValue({ wallets: 4, granted: 70, failed: 0 });
  mocks.earnAlert.mockResolvedValue(undefined);
};

type Body = { data: Record<string, unknown> };

describe("POST /api/cron/billing-grant", () => {
  it("401s on a missing or wrong x-cron-secret, running nothing", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST()).status).toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST()).status).toBe(401);
    let checked = 0;
    for (const m of Object.values(mocks)) {
      expect(m).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("runs the AI wallet grant and the farm-watch, and returns the AI grant's counts unchanged", async () => {
    authorize();
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mocks.aiSweep).toHaveBeenCalledTimes(1);
    expect(mocks.earnAlert).toHaveBeenCalledTimes(1);
    // billing-grant-stg.yml reads this shape; exact, so an extra key (a re-added stream sweep's counts) reds here.
    expect(((await res.json()) as Body).data).toEqual({ wallets: 4, granted: 70, failed: 0 });
  });

  it("M4: grants NO stream match credits — readers roll the month over themselves", async () => {
    authorize();
    expect((await POST()).status).toBe(200);
    let checked = 0;
    for (const [name, m] of Object.entries(stream)) {
      expect(m, name).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(2);
  });
});
