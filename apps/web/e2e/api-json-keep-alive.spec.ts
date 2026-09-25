import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test, expect } from "@playwright/test";
import { apiJson } from "./helpers";

/**
 * `apiJson` against a server that reaps keep-alive sockets.
 *
 * CI run 35966856075 (competition-desk "K1 sibling"): the test's FIRST call —
 * `activeOrg` → `apiJson(page.request, "/api/orgs")` — died 2.9ms after it was
 * sent with `read ECONNRESET`, before the product was asked anything. The
 * mechanism, reproduced against this repo's pins (Playwright 1.61.1, Node 26):
 *
 * - Every APIRequestContext in a worker process sends through ONE
 *   process-global keep-alive agent (`new HttpHappyEyeballsAgent({ keepAlive:
 *   true })`), so a socket parked by one test is handed to the next test on
 *   the same worker — `page.request`, the `request` fixture and every
 *   `newContext()` alike. (`--repeat-each` cannot show this: each repeat gets
 *   its own worker.)
 * - That agent has no `timeout`, and Node's `keepSocketAlive` only honours the
 *   server's `Keep-Alive: timeout=5` hint when it is SHORTER than the agent's
 *   own timeout — which, at 0, it never is. A parked socket is kept forever.
 * - The standalone server reaps an idle socket at 6s (`keepAliveTimeout` 5s +
 *   Node's `keepAliveTimeoutBuffer` 1s). If its event loop is busy across that
 *   deadline, a request that has already landed on the socket is destroyed
 *   unread and the kernel answers with RST. In the CI run the previous test on
 *   that worker (ai-architect's 390px happy flow) seeded over the API first
 *   and drove the browser for the rest of its 6.2s.
 *
 * The rig below does not wait out a real deadline. `expireParked()` marks
 * every connection that is open at that moment — each one idle in the
 * client's pool, since every call here is awaited — as past the server's
 * deadline, so the next request to land on one of them is reset unread. The
 * race is not a race here, and no test sleeps.
 */
async function reapingServer() {
  const open = new Set<Socket>();
  const expired = new WeakSet<Socket>();
  const processed: string[] = [];
  let connections = 0;
  let resets = 0;
  const server = http.createServer((req, res) => {
    const socket = req.socket;
    if (expired.has(socket)) {
      // The idle deadline fired with this request unread in the buffer.
      resets++;
      socket.resetAndDestroy();
      return;
    }
    req.resume();
    req.on("end", () => {
      processed.push(`${req.method} ${req.url}`);
      if (req.url === "/applied-then-reset") {
        // The server acted on the request, then the connection died before
        // the answer got out. A client cannot tell this apart from the reap.
        resets++;
        socket.resetAndDestroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, data: { url: req.url } }));
    });
  });
  server.on("connection", (socket: Socket) => {
    connections++;
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    expireParked: () => {
      for (const socket of open) expired.add(socket);
    },
    stats: () => ({ connections, resets, processed: [...processed] }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test.describe("apiJson and the worker's shared keep-alive pool", () => {
  test("the CI shape: the next test's first GET follows a probe onto a new connection when the parked socket is reaped", async ({
    playwright,
  }) => {
    const rig = await reapingServer();
    const ctx = await playwright.request.newContext({ baseURL: rig.url });
    try {
      expect((await apiJson(ctx, "/api/competitions")).status).toBe(200);
      rig.expireParked();
      expect((await apiJson(ctx, "/api/orgs")).status).toBe(200);
      // The probe took the reset. The request itself went once, on the
      // connection the probe's retry opened.
      expect(rig.stats()).toEqual({
        connections: 2,
        resets: 1,
        processed: ["GET /api/health", "GET /api/competitions", "GET /api/health", "GET /api/orgs"],
      });
    } finally {
      await ctx.dispose();
      await rig.close();
    }
  });

  // #867's repeat run: `read ECONNRESET` on `POST /api/orgs`, twice. A POST
  // cannot be retried (next test), so it must never be the request that lands
  // on a reaped socket.
  test("a POST never lands on a parked socket: the probe takes it, and the POST is applied once", async ({
    playwright,
  }) => {
    const rig = await reapingServer();
    const ctx = await playwright.request.newContext({ baseURL: rig.url });
    try {
      expect((await apiJson(ctx, "/api/competitions")).status).toBe(200);
      rig.expireParked();
      expect((await apiJson(ctx, "/api/orgs", "POST", { name: "x" })).status).toBe(200);
      expect(rig.stats()).toEqual({
        connections: 2,
        resets: 1,
        processed: ["GET /api/health", "GET /api/competitions", "GET /api/health", "POST /api/orgs"],
      });
    } finally {
      await ctx.dispose();
      await rig.close();
    }
  });

  // `maxRetries` resends on ANY ECONNRESET, including one that arrives after
  // the server acted. A replayed POST applies twice: a second entrant, a
  // second score event, or a Stripe call that answers "Idempotent Key
  // in-progress". Failing loudly is the only safe answer, for every method.
  test("a request the server already applied is never sent a second time", async ({ playwright }) => {
    const rig = await reapingServer();
    const ctx = await playwright.request.newContext({ baseURL: rig.url });
    const methods = ["POST", "PATCH", "PUT", "DELETE", "GET"] as const;
    try {
      for (const method of methods) {
        await expect(apiJson(ctx, "/applied-then-reset", method, method === "GET" ? undefined : {})).rejects.toThrow(
          /ECONNRESET|socket hang up/,
        );
      }
      expect(rig.stats()).toEqual({
        connections: methods.length,
        resets: methods.length,
        processed: methods.flatMap((method) => ["GET /api/health", `${method} /applied-then-reset`]),
      });
    } finally {
      await ctx.dispose();
      await rig.close();
    }
  });

  // The cost guard. Against an IPv4-only server — CI's standalone server binds
  // 0.0.0.0, seazn-env's binds 127.0.0.1 — a new connection to `localhost`
  // dials ::1 first, is refused, and Playwright's connector still waits out
  // its full 300ms attempt delay before it tries 127.0.0.1. PR #864's first
  // cut sent `Connection: close`, which paid that on every call: the parallel
  // 2/2 shard went from 8.4m to 15.6m and 17.1m, and a third run hit the
  // 20-minute job timeout. One connection for a run of calls is the property
  // that keeps the suite at main's speed.
  test("a run of calls, of every method, shares one connection", async ({ playwright }) => {
    const rig = await reapingServer();
    const ctx = await playwright.request.newContext({ baseURL: rig.url });
    try {
      expect((await apiJson(ctx, "/a")).status).toBe(200);
      expect((await apiJson(ctx, "/b", "POST", {})).status).toBe(200);
      expect((await apiJson(ctx, "/c", "PATCH", {})).status).toBe(200);
      expect((await apiJson(ctx, "/d", "PUT", {})).status).toBe(200);
      expect((await apiJson(ctx, "/e", "DELETE")).status).toBe(200);
      expect((await apiJson(ctx, "/f")).status).toBe(200);
      expect(rig.stats().connections).toBe(1);
      expect(rig.stats().resets).toBe(0);
    } finally {
      await ctx.dispose();
      await rig.close();
    }
  });
});
