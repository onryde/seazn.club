// R10c m2 — the hub hook's LAST push retry must land after the hub document's
// Redis TTL has run out.
//
// A cache-aside rebuild that read the database before a write, and finished
// after that write's DEL, puts the pre-write document back under
// `pub:v1:hub:{competitionId}` for HUB_TTL_SECONDS (usecases/public.ts). A push
// whose every retry lands inside that window gets the same old copy each time,
// and the page then waits for the 60s safety poll.
//
// The client hook cannot import the TTL: public.ts is `server-only`, and a
// client component must not pull server modules. So the hook keeps a literal,
// and this test, which may import both, keeps the two from drifting apart.
import { describe, expect, it } from "vitest";
import { HUB_TTL_SECONDS } from "@/server/usecases/public";
import { HUB_PUSH_RETRY_MS } from "../use-live-competition";

describe("the hub's last push retry outlives the hub's Redis TTL (R10c m2)", () => {
  it("the TTL is read from the server module, not re-typed here", () => {
    expect(HUB_TTL_SECONDS).toBeGreaterThan(0);
  });

  it("the last retry delay is longer than HUB_TTL_SECONDS", () => {
    const last = HUB_PUSH_RETRY_MS[HUB_PUSH_RETRY_MS.length - 1]!;
    expect(last).toBeGreaterThan(HUB_TTL_SECONDS * 1_000);
  });
});
