import { afterEach, describe, expect, it, vi } from "vitest";

// The receiving side of a peer POST is the REAL route handler; only Next's
// `revalidateTag` is recorded, so "applied on the peer" is observable.
const applied = vi.hoisted(() => [] as Array<{ tag: string; profile: unknown }>);
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  revalidateTag: (tag: string, profile: unknown) => {
    applied.push({ tag, profile });
  },
}));
const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/internal/revalidate/route";
import { broadcastRevalidate, PEER_REVALIDATE_MAX_TAGS as LIMIT } from "@/lib/peer-revalidate";

afterEach(() => {
  vi.unstubAllEnvs();
  applied.length = 0;
  for (const fn of Object.values(logMock)) fn.mockClear();
});

function arm() {
  vi.stubEnv("PEER_REVALIDATE", "1");
  vi.stubEnv("FLY_APP_NAME", "seazn-club-prod");
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("FLY_PRIVATE_IP", "fdaa::3");
}

describe("broadcastRevalidate", () => {
  it("no-ops when PEER_REVALIDATE is not enabled", async () => {
    const fetchFn = vi.fn();
    await broadcastRevalidate(["division:d1"], "swr", { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs tags to every peer except itself, with the secret header", async () => {
    arm();
    const fetchFn = vi.fn(async () => new Response("{}"));
    await broadcastRevalidate(["division:d1", "competition:c1"], "swr", {
      resolveIps: async () => ["fdaa::3", "fdaa::4", "fdaa::5"],
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(String(url)).toBe("http://[fdaa::4]:3000/api/internal/revalidate");
    expect(init.headers["x-cron-secret"]).toBe("s3cret");
    expect(JSON.parse(init.body)).toEqual({ tags: ["division:d1", "competition:c1"], mode: "swr" });
  });

  it("swallows resolver and fetch failures (fail-open)", async () => {
    arm();
    await expect(
      broadcastRevalidate(["division:d1"], "swr", {
        resolveIps: async () => {
          throw new Error("dns down");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("broadcastRevalidate — more tags than one peer POST may carry", () => {
  const tags = (n: number) => Array.from({ length: n }, (_, i) => `division:d${i}`);
  type Outcome = number | "network error";

  /** Peers whose every POST goes through the real route handler, unless
   *  `refuse` answers for that body first. Records each attempt. */
  function peers(refuse: (ip: string, tags: string[]) => Outcome | undefined = () => undefined) {
    const posts: Array<{ ip: string; tags: string[]; outcome: Outcome }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const ip = /\[(.+)\]/.exec(String(url))![1]!;
      const body = JSON.parse(String(init!.body)) as { tags: string[] };
      const refused = refuse(ip, body.tags);
      if (refused === "network error") {
        posts.push({ ip, tags: body.tags, outcome: refused });
        throw new TypeError("fetch failed");
      }
      const res =
        refused === undefined
          ? await POST(new NextRequest(String(url), init as ConstructorParameters<typeof NextRequest>[1]))
          : new Response(null, { status: refused });
      posts.push({ ip, tags: body.tags, outcome: res.status });
      return res;
    }) as typeof fetch;
    return { posts, fetchFn };
  }

  it.each([
    ["exactly the limit", LIMIT, 1, "swr", "max"],
    ["the limit plus one", LIMIT + 1, 2, "swr", "max"],
    ["twice the limit plus one", 2 * LIMIT + 1, 3, "expire", { expire: 0 }],
  ] as const)(
    "%s (%i tags) goes to every peer in %i POST(s) the route accepts, and every tag is applied there",
    async (_label, count, batches, mode, profile) => {
      arm();
      const sent = tags(count);
      const { posts, fetchFn } = peers();

      await broadcastRevalidate(sent, mode, { resolveIps: async () => ["fdaa::3", "fdaa::4", "fdaa::5"], fetchFn });

      for (const ip of ["fdaa::4", "fdaa::5"]) {
        const mine = posts.filter((p) => p.ip === ip);
        expect(mine.map((p) => p.outcome), `${ip}: one accepted POST per batch`).toEqual(Array(batches).fill(200));
        expect(mine.flatMap((p) => p.tags).sort(), `${ip}: every tag, once`).toEqual([...sent].sort());
      }
      expect(applied.map((a) => a.tag).sort()).toEqual([...sent, ...sent].sort());
      expect(applied.every((a) => JSON.stringify(a.profile) === JSON.stringify(profile))).toBe(true);
      expect(logMock.warn).not.toHaveBeenCalled();
    },
  );

  it("failed batches — a network error, or a peer refusing one — log ONE warning per peer (batch count, first error), and every other batch is still sent and applied", async () => {
    arm();
    const sent = tags(2 * LIMIT + 1);
    const [first, second, third] = [sent.slice(0, LIMIT), sent.slice(LIMIT, 2 * LIMIT), sent.slice(2 * LIMIT)];
    const { posts, fetchFn } = peers((ip, batch) => {
      if (ip === "fdaa::4" && batch.includes(first[0]!)) return "network error";
      if (ip === "fdaa::4" && batch.includes(second[0]!)) return 503;
      if (ip === "fdaa::5" && batch.includes(second[0]!)) return "network error";
      return undefined;
    });

    await expect(
      broadcastRevalidate(sent, "swr", { resolveIps: async () => ["fdaa::3", "fdaa::4", "fdaa::5"], fetchFn }),
    ).resolves.toBeUndefined();

    expect(posts.length, "every batch was attempted to every peer").toBe(6);
    expect(applied.map((a) => a.tag).sort()).toEqual([...third, ...first, ...third].sort());
    expect(logMock.warn).toHaveBeenCalledTimes(2);
    expect(logMock.warn).toHaveBeenCalledWith(
      { peer: "fdaa::4", mode: "swr", failedBatches: 2, batches: 3, err: expect.any(TypeError), tags: first },
      expect.any(String),
    );
    expect(logMock.warn).toHaveBeenCalledWith(
      { peer: "fdaa::5", mode: "swr", failedBatches: 1, batches: 3, err: expect.any(TypeError), tags: second },
      expect.any(String),
    );
  });

  it("a peer refusing its only failed batch logs the refusal's status as the first error", async () => {
    arm();
    const sent = tags(LIMIT + 1);
    const { fetchFn } = peers((_ip, batch) => (batch.includes(sent[LIMIT]!) ? 503 : undefined));

    await broadcastRevalidate(sent, "expire", { resolveIps: async () => ["fdaa::4"], fetchFn });

    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn).toHaveBeenCalledWith(
      { peer: "fdaa::4", mode: "expire", failedBatches: 1, batches: 2, status: 503, tags: [sent[LIMIT]] },
      expect.any(String),
    );
  });
});
