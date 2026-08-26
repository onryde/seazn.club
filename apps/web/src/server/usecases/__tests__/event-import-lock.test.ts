// Fix round 1 (Task 5 review, findings #1/#3) — pure unit tests, no DB.
// `withLock` is a plain function over injected callbacks specifically so
// this file can prove the release-failure guarantee without touching
// Postgres: a release failure must never replace a real result, and
// release is skipped when the lock was never taken.
//
// Fix round 2 (owner ruling — the session advisory lock was retired for a
// row lock, design doc §5.1): `withAdvisoryLock` is renamed `withLock` and
// generalised (acquire now returns the acquired LOCK TOKEN or null, not a
// bare boolean, since the row lock's holder has to reach both `fn` and
// `release`) — the four tests below are the SAME four tests, edited to the
// new signature, not new tests; the intent each one proves is unchanged.
// `withReserveTimeout`'s three tests are DELETED, not edited: that
// function no longer exists at all (the row lock reserves nothing, so
// there is nothing left to time out), and a test that only described a
// deleted mechanism has nothing left to describe.
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { withLock } from "../event-import";

const refuse = (): never => {
  throw new HttpError(409, "another import with this import_id is already running", "import.concurrent");
};

describe("withLock", () => {
  it("finding #1: a release failure never replaces fn's real (successful) result", async () => {
    const release = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const result = await withLock(
      async () => "token",
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
      withLock(
        async () => "token",
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
      withLock(async () => null, release, refuse, async () => "unreachable"),
    ).rejects.toMatchObject({ status: 409, code: "import.concurrent" });
    expect(release).not.toHaveBeenCalled();
  });

  it("release DOES run after a normal success, and runs before returning", async () => {
    const order: string[] = [];
    await withLock(
      async () => "token",
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
