// `apiV1` against a REAL socket: node's own `fetch` talking to a local
// `http.Server`, so the abort below travels the same path it does in a
// browser — the signal errors the response BODY stream, and `res.json()`
// rejects with it. A stubbed `fetch` would have to invent that behaviour, and
// the whole defect lives in how this helper reacts to it.
//
// THE DEFECT (G1 review round 1). `apiV1` parses the body with
// `res.json().catch(() => ({}))` — a deliberate default, so a non-JSON error
// page (a proxy's 502) still becomes a typed `ApiV1Error` below. But the same
// catch also swallowed an ABORT that landed after the headers and before the
// body finished: the payload defaulted to `{}`, a 200 passed the `!res.ok`
// check, and the call RESOLVED with `undefined`. A caller that bounds a
// refresh with an `AbortController` (the device pad's and the console's
// `resync`) then wrote `undefined` into its live state and the next render
// threw on `live.summary`. `use-capacity-report.ts` is the third caller that
// passes a signal: a superseded capacity request resolved `undefined` into
// `onResolved` instead of rejecting with the `AbortError` it treats as silent.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiV1, ApiV1Error } from "@/lib/client-v1";

let server: Server | null = null;
const held: ServerResponse[] = [];

/** Start a server whose every response is written by `respond`, and resolve
 *  its base URL. Responses the handler leaves open are tracked so teardown
 *  can end them — an open socket would otherwise keep `server.close()` from
 *  ever settling. */
async function serve(respond: (res: ServerResponse) => void): Promise<string> {
  server = createServer((_req, res) => {
    held.push(res);
    respond(res);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const res of held.splice(0)) res.destroy();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("apiV1 — an abort that lands mid-body", () => {
  it("REJECTS with the abort, never resolves undefined, when the signal fires after the headers", async () => {
    // Headers and the first half of a valid envelope go out; the rest never
    // does. This is the half-open read a bounded refresh exists to cut off.
    let headersSent!: () => void;
    const headersOut = new Promise<void>((resolve) => (headersSent = resolve));
    const base = await serve((res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"ok":true,"data":{"status":"in_pl', () => headersSent());
    });

    const controller = new AbortController();
    // Observe the moment `fetch` itself RESOLVED — i.e. the headers are in and
    // `apiV1` has moved on to reading the body. Aborting before this point
    // would reject inside `fetch` and pass in both builds, proving nothing.
    const realFetch = globalThis.fetch;
    let fetchResolved!: () => void;
    const pastHeaders = new Promise<void>((resolve) => (fetchResolved = resolve));
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const res = await realFetch(...args);
      fetchResolved();
      return res;
    }) as typeof fetch;
    try {
      const call = apiV1<{ status: string }>(`${base}/api/v1/fixtures/f1/state`, { signal: controller.signal });
      // Attach the outcome handlers BEFORE aborting, so a rejection is never
      // momentarily unhandled.
      const outcome = call.then(
        (value) => ({ settled: "resolved" as const, value }),
        (error: unknown) => ({ settled: "rejected" as const, error }),
      );
      await headersOut;
      await pastHeaders;

      controller.abort();

      const result = await outcome;
      expect(
        result,
        "an abort mid-body must reject — resolving hands the caller `undefined` as if it were data",
      ).toMatchObject({ settled: "rejected" });
      // And it rejects with the ABORT, not a parse error: `use-capacity-report
      // .ts` tells a superseded request from a real failure by exactly this
      // name, and stays silent only for it.
      expect((result as { error: Error }).error.name).toBe("AbortError");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("still turns a non-JSON error page into a typed ApiV1Error when nothing was aborted", async () => {
    // The positive pair: the body-parse default is load-bearing for every
    // caller that is NOT aborting — a proxy's HTML 502 must still become an
    // `ApiV1Error` carrying the status, not a JSON SyntaxError. A fix that
    // rethrew every parse failure would break this.
    const base = await serve((res) => {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html><body>Bad gateway</body></html>");
    });

    const failure = await apiV1(`${base}/api/v1/fixtures/f1/state`, {
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiV1Error);
    expect((failure as ApiV1Error).status).toBe(502);
    expect((failure as ApiV1Error).code).toBe("UNKNOWN");
  });
});
