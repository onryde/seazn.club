// Spectator W2, Task 14 — `retireOrgPlayerMatches`, the ONE helper every person
// writer calls after commit so the public player page's cached match lines stop
// naming a person the organiser or the player just hid (consent, name, dob).
//
// Mocked one layer down: `@/lib/db` (the org's competitions), `@/lib/cache`
// (the DEL) and the logger. The writers' own wiring is proven over real rows in
// `usecases/__tests__/person-writes-player-matches-cache.test.ts` and
// `me-consent-player-matches-cache.test.ts`; this file pins the helper's
// contract — one DEL of every generation key in the org, and a write that can
// never be failed by it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ sql }));
const cacheDel = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cache", () => ({ cacheDel }));
const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { playerMatchesGenKey, retireOrgPlayerMatches } from "../player-matches-cache-keys";

const DELETE_FAILED = "consent: a public Redis delete failed (the write stands)";
const LIST_FAILED = "consent: the org's competitions could not be listed for a public Redis delete (the write stands)";

beforeEach(() => {
  vi.resetAllMocks();
  sql.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
  // A fresh promise per call: a `vi.fn`'s own returned promise is marked handled.
  cacheDel.mockImplementation(() => Promise.resolve());
});

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("retireOrgPlayerMatches", () => {
  it("deletes the generation token of EVERY competition in the org, in ONE DEL", async () => {
    await retireOrgPlayerMatches("org-1", { person: "p1" });
    expect(cacheDel).toHaveBeenCalledTimes(1);
    expect(cacheDel.mock.calls[0]).toEqual(["pub:v1:player-matches-gen:c1", "pub:v1:player-matches-gen:c2"]);
    expect(playerMatchesGenKey("c1")).toBe("pub:v1:player-matches-gen:c1");
    // The org is the scope, read by id.
    expect(sql.mock.calls[0]!.slice(1)).toEqual(["org-1"]);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it("a DEL that fails is logged with the keys, never rejects, and leaves nothing unhandled", async () => {
    const failure = new Error("simulated Redis failure");
    cacheDel.mockImplementation(() => Promise.reject(failure));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(retireOrgPlayerMatches("org-1", { person: "p1" })).resolves.toBeUndefined();
      await macrotask();
      expect(logMock.error).toHaveBeenCalledWith(
        { err: failure, person: "p1", keys: ["pub:v1:player-matches-gen:c1", "pub:v1:player-matches-gen:c2"] },
        DELETE_FAILED,
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a competition read that fails is logged and never rejects — the write it follows has already committed", async () => {
    const failure = new Error("simulated Postgres failure");
    sql.mockRejectedValue(failure);
    await expect(retireOrgPlayerMatches("org-1", { mergeId: "m1" })).resolves.toBeUndefined();
    expect(cacheDel).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledWith({ err: failure, orgId: "org-1", mergeId: "m1" }, LIST_FAILED);
  });

  it("does not wait on the DEL: a Redis that never answers cannot hold the write's response", async () => {
    cacheDel.mockImplementation(() => new Promise(() => {}));
    await expect(retireOrgPlayerMatches("org-1", { person: "p1" })).resolves.toBeUndefined();
    expect(cacheDel).toHaveBeenCalledTimes(1);
  });
});
