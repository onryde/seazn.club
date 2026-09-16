import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PEER_REVALIDATE_MAX_TAGS } from "@/lib/peer-revalidate";
import { POST } from "./route";

afterEach(() => vi.unstubAllEnvs());

const req = (body: unknown, secret?: string) =>
  new NextRequest("http://localhost:3000/api/internal/revalidate", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-cron-secret": secret } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /api/internal/revalidate", () => {
  it("401s without the shared secret (and when none is configured)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(req({ tags: ["t"], mode: "swr" }))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST(req({ tags: ["t"], mode: "swr" }, "wrong"))).status).toBe(401);
  });

  it("400s on malformed bodies", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST(req({ tags: "not-an-array", mode: "swr" }, "s3cret"))).status).toBe(400);
    expect((await POST(req({ tags: ["t"], mode: "purge-everything" }, "s3cret"))).status).toBe(400);
    expect((await POST(req({ tags: Array(PEER_REVALIDATE_MAX_TAGS + 1).fill("t"), mode: "swr" }, "s3cret"))).status).toBe(
      400,
    );
  });

  it("accepts exactly the shared tag cap the broadcaster batches to", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST(req({ tags: Array(PEER_REVALIDATE_MAX_TAGS).fill("t"), mode: "swr" }, "s3cret"))).status).toBe(200);
  });

  it("applies each tag locally and reports ok", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await POST(req({ tags: ["division:d1", "discovery"], mode: "swr" }, "s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
