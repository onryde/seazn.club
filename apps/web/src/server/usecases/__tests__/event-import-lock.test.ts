// Fix round 1 (Task 5 review, findings #1/#2/#3) — pure unit tests, no DB.
// `withAdvisoryLock` and `withReserveTimeout` are both plain functions over
// injected callbacks specifically so this file can prove the guarantees
// without touching Postgres: a release failure must never replace a real
// result, release is skipped when the lock was never taken, and a
// `reserve()` that never resolves must still produce a prompt 409 rather
// than hang.
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { withAdvisoryLock, withReserveTimeout } from "../event-import";

const refuse = (): never => {
  throw new HttpError(409, "another import with this import_id is already running", "import.concurrent");
};

describe("withAdvisoryLock", () => {
  it("finding #1: a release failure never replaces fn's real (successful) result", async () => {
    const release = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const result = await withAdvisoryLock(
      async () => true,
      release,
      refuse,
      async () => ({ imported: 1 }),
    );
    expect(result).toEqual({ imported: 1 });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("finding #1: a legitimate rejection from fn still propagates when release ALSO fails", async () => {
    const tooLarge = new HttpError(413, "too many events", "import.too_large");
    const release = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(
      withAdvisoryLock(
        async () => true,
        release,
        refuse,
        async () => {
          throw tooLarge;
        },
      ),
    ).rejects.toBe(tooLarge); // the ORIGINAL error, not something from release()
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("finding #3: release is skipped entirely when the lock was never acquired", async () => {
    const release = vi.fn(async () => {});
    await expect(
      withAdvisoryLock(async () => false, release, refuse, async () => "unreachable"),
    ).rejects.toMatchObject({ status: 409, code: "import.concurrent" });
    expect(release).not.toHaveBeenCalled();
  });

  it("release DOES run after a normal success, and runs before returning", async () => {
    const order: string[] = [];
    await withAdvisoryLock(
      async () => true,
      async () => {
        order.push("release");
      },
      refuse,
      async () => {
        order.push("fn");
        return "ok";
      },
    );
    expect(order).toEqual(["fn", "release"]);
  });
});

describe("withReserveTimeout", () => {
  it("finding #2: import.concurrent's the call when no connection can be reserved in time", async () => {
    const neverResolves = () => new Promise<{ release(): void }>(() => {});
    await expect(withReserveTimeout(neverResolves, 30)).rejects.toMatchObject({
      status: 409,
      code: "import.concurrent",
    });
  });

  it("returns the connection normally when reserve wins the race", async () => {
    const conn = { release: vi.fn() };
    await expect(withReserveTimeout(async () => conn, 1_000)).resolves.toBe(conn);
    expect(conn.release).not.toHaveBeenCalled(); // caller owns release, not the helper
  });

  it("releases a late-arriving connection once the timeout has already won", async () => {
    const conn = { release: vi.fn() };
    const slowReserve = () => new Promise<typeof conn>((resolve) => setTimeout(() => resolve(conn), 60));
    await expect(withReserveTimeout(slowReserve, 10)).rejects.toMatchObject({
      status: 409,
      code: "import.concurrent",
    });
    expect(conn.release).not.toHaveBeenCalled(); // not yet — slowReserve hasn't settled
    await new Promise((r) => setTimeout(r, 100)); // let slowReserve's setTimeout fire
    expect(conn.release).toHaveBeenCalledTimes(1); // now it has, and nothing else leaked it
  });
});
