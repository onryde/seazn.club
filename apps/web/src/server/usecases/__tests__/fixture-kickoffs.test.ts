// The division page's read of each live match's actual start (owner ruling 2026-11-26). `kickoffsOf` itself is pinned
// against a database by the competition desk's tests; this pins what is asked of it and what comes back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";

const db = vi.hoisted(() => ({ withTenant: vi.fn(async (_orgId: string, fn: (tx: unknown) => unknown) => fn("tx")) }));
const kickoff = vi.hoisted(() => ({ kickoffsOf: vi.fn() }));
vi.mock("@/lib/db", () => db);
vi.mock("@/server/engine-db/kickoff", () => kickoff);

import { listFixtureKickoffs } from "../fixture-kickoffs";
import type { AuthCtx } from "@/server/api-v1/auth";

const AUTH = { orgId: "org-1" } as AuthCtx;

describe("listFixtureKickoffs", () => {
  beforeEach(() => {
    db.withTenant.mockClear();
    kickoff.kickoffsOf.mockReset().mockResolvedValue(new Map());
  });

  it("empty case: no fixtures, or none in play, answers {} and reads nothing", async () => {
    expect(await listFixtureKickoffs(AUTH, [])).toEqual({});
    const idle = FIXTURE_STATUSES.filter((s) => s !== "in_play").map((status) => ({ id: status, status }));
    expect(idle.length, "anti-vacuity: statuses swept").toBeGreaterThan(3);
    expect(await listFixtureKickoffs(AUTH, idle)).toEqual({});
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it("asks only for the live matches, in the caller's tenant, and answers each start as an ISO instant", async () => {
    kickoff.kickoffsOf.mockResolvedValue(new Map([["a", { at: new Date("2026-11-26T10:00:00.000Z") }]]));
    const out = await listFixtureKickoffs(AUTH, [
      { id: "a", status: "in_play" },
      { id: "b", status: "scheduled" },
      // Live with no active start: absent, so the row falls back to its slot.
      { id: "c", status: "in_play" },
    ]);
    expect(out).toEqual({ a: "2026-11-26T10:00:00.000Z" });
    expect(db.withTenant.mock.calls.map((c) => c[0])).toEqual(["org-1"]);
    expect(kickoff.kickoffsOf.mock.calls).toEqual([["tx", ["a", "c"]]]);
  });
});
