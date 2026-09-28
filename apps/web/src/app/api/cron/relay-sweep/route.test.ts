// Cron route auth for the DAILY relay sweep (streaming R1 Task 12): the same x-cron-secret / CRON_SECRET contract as
// /api/cron/registrations and /api/cron/billing-events. next/headers is mocked so the route runs without a request
// scope; the sweep and its deps factory are mocked so this stays DB-free (the sweep itself is relay-sweep.test.ts).
//
// The ORDER is the claim, not just the two codes: an UNSET secret answers 503 whatever header arrives — including a
// header equal to the empty string the unset variable would compare against — so a missing secret can never read as
// "no auth required". A request that reaches the sweep calls it with the production deps ALONE: `orgIds` is a
// test-only scope, and a route that passed one would sweep a subset of the database every night.
import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const m = vi.hoisted(() => ({ sweep: vi.fn(), deps: vi.fn(), sentinel: { drivers: "the production drivers" } }));
vi.mock("@/server/usecases/relay-sweep", () => ({ sweepStreamSessions: m.sweep }));
vi.mock("@/server/usecases/stream-sessions", () => ({ defaultDeps: m.deps }));

import { POST } from "./route";

const req = () => new Request("http://internal:3000/api/cron/relay-sweep", { method: "POST", headers: { "x-forwarded-host": "app.example" } });

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  m.sweep.mockReset();
  m.deps.mockReset();
});

describe("POST /api/cron/relay-sweep", () => {
  it("503 when CRON_SECRET is unset — BEFORE the header is judged: no header, a wrong one, and an empty one all read 503, and the sweep never runs", async () => {
    vi.stubEnv("CRON_SECRET", "");
    let checked = 0;
    for (const given of [null, "wrong", ""]) {
      hdrs.store = given === null ? new Headers() : new Headers({ "x-cron-secret": given });
      expect((await POST(req())).status, `header ${JSON.stringify(given)}`).toBe(503);
      checked++;
    }
    expect(checked).toBe(3);
    expect(m.sweep).not.toHaveBeenCalled();
  });

  it("401 with a missing or wrong x-cron-secret once the secret IS set, never running the sweep", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST(req())).status).toBe(401);
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST(req())).status).toBe(401);
    let nearMisses = 0;
    for (const given of ["s3cre", "s3cret-and-more", "S3CRET"]) {   // no prefix match, no case folding
      hdrs.store = new Headers({ "x-cron-secret": given });
      expect((await POST(req())).status, given).toBe(401);
      nearMisses++;
    }
    expect(nearMisses).toBe(3);
    expect(m.sweep).not.toHaveBeenCalled();
  });

  it("the right secret runs the sweep ONCE with the production deps alone (no test scope) built from the request's base url, and returns its summary", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("OAUTH_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
    hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
    m.deps.mockReturnValue(m.sentinel);
    const summary = { backstop: { candidates: 3, visited: 3 }, machinesListed: 1, videosListed: 7 };
    m.sweep.mockResolvedValue(summary);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: summary });
    expect(m.deps).toHaveBeenCalledTimes(1);
    expect(m.deps).toHaveBeenCalledWith("https://app.example");
    expect(m.sweep).toHaveBeenCalledTimes(1);
    expect(m.sweep.mock.calls[0]).toEqual([m.sentinel]);   // exactly one argument: no `orgIds`, no options
  });
});

// PR #902 CI: `next build` collects this route's config by EVALUATING its module graph in a process with no
// DATABASE_URL. stream-sessions.ts built a `sql` fragment at module scope — which opens the pooled client — and the
// build died "Failed to collect configuration for /api/cron/relay-sweep"; every unit shard without a database failed
// to COLLECT the four suites that import it. The mocks above hide exactly that, so this loads the two REAL modules the
// route imports, with no database configured and no client cached.
describe("the route's module graph evaluates with NO database (next build collects its config without one)", () => {
  it("stream-sessions and relay-sweep load — and the probe is live: a query built on `sql` in the same state throws", async () => {
    vi.stubEnv("DATABASE_URL", "");
    expect((globalThis as { _sql?: unknown })._sql, "a cached client would mask a module-scope query").toBeUndefined();
    const loaded: string[] = [];
    const ss = await vi.importActual<typeof import("@/server/usecases/stream-sessions")>("@/server/usecases/stream-sessions");
    expect(typeof ss.defaultDeps).toBe("function");
    loaded.push("stream-sessions");
    const rs = await vi.importActual<typeof import("@/server/usecases/relay-sweep")>("@/server/usecases/relay-sweep");
    expect(typeof rs.sweepStreamSessions).toBe("function");
    loaded.push("relay-sweep");
    expect(loaded).toEqual(["stream-sessions", "relay-sweep"]);
    // The positive twin: this state DOES refuse a query built on `sql`, so the loads above prove the modules build none.
    const { sql } = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
    expect(() => sql`select 1`).toThrow(/DATABASE_URL is not set/);
  });
});
