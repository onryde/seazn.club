// Request-context ALS (server/request-context.ts): the carrier both route
// wrappers (api-v1/http.ts's v1(), lib/http.ts's handler()) run inside, and
// that server/logger.ts's mixin reads on every log call. The one property
// that matters is AsyncLocalStorage's usual footgun: two concurrent runs
// must never see each other's store.
import { describe, expect, it } from "vitest";
import { getRequestContext, runRequestContext, setRequestActor } from "../request-context";

describe("request-context", () => {
  it("scopes requestId per run(), with no store outside one", () => {
    expect(getRequestContext()).toEqual({});
  });

  it("does not leak context across concurrent runs", async () => {
    const seen: Record<string, unknown>[] = [];
    await Promise.all([
      runRequestContext("req-a", async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(getRequestContext());
      }),
      runRequestContext("req-b", async () => {
        seen.push(getRequestContext());
      }),
    ]);
    const byId = Object.fromEntries(seen.map((s) => [s.requestId as string, s]));
    expect(byId["req-a"]).toEqual({ requestId: "req-a" });
    expect(byId["req-b"]).toEqual({ requestId: "req-b" });
  });

  it("setRequestActor merges orgId/userId into the active store only", async () => {
    await runRequestContext("req-c", async () => {
      setRequestActor({ orgId: "org-1", userId: "user-1" });
      expect(getRequestContext()).toEqual({ requestId: "req-c", orgId: "org-1", userId: "user-1" });
    });
    // Outside any run(), setRequestActor is a no-op — nothing to leak into.
    setRequestActor({ orgId: "org-2", userId: "user-2" });
    expect(getRequestContext()).toEqual({});
  });

  it("setRequestActor ignores null/undefined fields (keeps whatever was already set)", async () => {
    await runRequestContext("req-d", async () => {
      setRequestActor({ orgId: "org-1" });
      setRequestActor({ orgId: null, userId: undefined });
      expect(getRequestContext()).toEqual({ requestId: "req-d", orgId: "org-1" });
    });
  });
});
