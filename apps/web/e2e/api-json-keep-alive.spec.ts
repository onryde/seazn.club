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
 * The server below makes the deadline land on EVERY reused connection, so the
 * race is not a race here: a request on a reused connection is always reset.
 */
async function reapingServer() {
  const reused = new WeakSet<Socket>();
  const processed: string[] = [];
  let connections = 0;
  let resets = 0;
  const server = http.createServer((req, res) => {
    if (reused.has(req.socket)) {
      // The idle deadline fired with this request unread in the buffer.
      resets++;
      req.socket.resetAndDestroy();
      return;
    }
    reused.add(req.socket);
    processed.push(`${req.method} ${req.url}`);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: { url: req.url } }));
  });
  server.on("connection", () => {
    connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stats: () => ({ connections, resets, processed: [...processed] }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test.describe("apiJson and the worker's shared keep-alive pool", () => {
  test("the CI shape: one test's apiJson call, then the next test's first apiJson call", async ({ playwright }) => {
    const rig = await reapingServer();
    const ctx = await playwright.request.newContext({ baseURL: rig.url });
    try {
      expect((await apiJson(ctx, "/api/v1/stages/x/complete", "POST", {})).status).toBe(200);
      expect((await apiJson(ctx, "/api/orgs")).status).toBe(200);
      expect(rig.stats()).toEqual({
        connections: 2,
        resets: 0,
        processed: ["POST /api/v1/stages/x/complete", "GET /api/orgs"],
      });
    } finally {
      await ctx.dispose();
      await rig.close();
    }
  });

  // Isolates `Connection: close`. The consumer is a BARE call with no retry of
  // its own — like the direct `request.get`/`post` calls elsewhere in this
  // suite — so it only survives if apiJson never parked its socket.
  test("apiJson leaves no pooled socket behind for the next request to inherit", async ({ playwright }) => {
    const rig = await reapingServer();
    const ctx = await playwright.request.newContext({ baseURL: rig.url });
    try {
      expect((await apiJson(ctx, "/first")).status).toBe(200);
      expect((await ctx.get("/second")).status()).toBe(200);
      expect(rig.stats()).toEqual({ connections: 2, resets: 0, processed: ["GET /first", "GET /second"] });
    } finally {
      await ctx.dispose();
      await rig.close();
    }
  });

  // Isolates `maxRetries`. A `Connection: close` request still TAKES a parked
  // socket when one is there, and a bare call parks one. The reset is asserted
  // too — without it this test would pass on a rig that never reaped anything.
  test("apiJson survives a parked socket the server reaps as the request lands, and it is applied once", async ({
    playwright,
  }) => {
    const rig = await reapingServer();
    const ctx = await playwright.request.newContext({ baseURL: rig.url });
    try {
      expect((await ctx.get("/parks-a-socket")).status()).toBe(200);
      expect((await apiJson(ctx, "/lands-on-it", "POST", { n: 1 })).status).toBe(200);
      // One reset, and the reset request was never processed: the retry is
      // the only time the server acted on the POST.
      expect(rig.stats()).toEqual({
        connections: 2,
        resets: 1,
        processed: ["GET /parks-a-socket", "POST /lands-on-it"],
      });
    } finally {
      await ctx.dispose();
      await rig.close();
    }
  });
});
