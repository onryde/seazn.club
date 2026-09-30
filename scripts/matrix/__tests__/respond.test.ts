// Review Focus 4: every browser action resolves on the product's OWN answer to
// the request the UI made, and a non-2xx becomes the same RefusedCall
// HttpDriver throws. Proven against a structural fake page (no browser): it
// implements only waitForResponse(pred, {timeout}), which is all actAndAwait
// may use, with Playwright's semantics — a response that arrives before the
// wait is registered is never seen.
import { afterEach, describe, expect, it } from "vitest";
import { BadBudget } from "../lib/browser/budget.ts";
import { NoProductResponse, actAndAwait } from "../lib/browser/respond.ts";
import { unwrapEnvelope } from "../lib/driver/envelope.ts";
import { RefusedCall, nextMatchFixtureId } from "../lib/driver/types.ts";
import { nextMatchStartedText } from "./product-text.ts";

interface FakeResponse { request(): { method(): string }; url(): string; status(): number; json(): Promise<unknown> }

const BASE = "http://localhost:3999";
function resp(method: string, path: string, status: number, body: unknown, opts: { badJson?: boolean } = {}): FakeResponse {
  return {
    request: () => ({ method: () => method }),
    url: () => `${BASE}${path}`,
    status: () => status,
    json: () => (opts.badJson ? Promise.reject(new SyntaxError("Unexpected token < in JSON")) : Promise.resolve(body)),
  };
}

// The two rejections a real waitForResponse gives, as measured against
// Playwright's chromium (fix round 1): its budget running out is an error NAMED
// "TimeoutError" (class TimeoutError); a page, context or browser closing under
// the wait is a plain "Error" (class TargetClosedError).
function playwrightTimeout(ms: number): Error {
  const e = new Error(`page.waitForResponse: Timeout ${ms}ms exceeded while waiting for event "response"`);
  e.name = "TimeoutError";
  return e;
}
const TARGET_CLOSED = "page.waitForResponse: Target page, context or browser has been closed";

function fakePage() {
  type Waiter = { pred: (r: FakeResponse) => boolean; resolve: (r: FakeResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
  const waiters: Waiter[] = [];
  const timeouts: number[] = [];
  const drop = (w: Waiter) => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
  const page = {
    waitForResponse(pred: (r: FakeResponse) => boolean, o: { timeout: number }): Promise<FakeResponse> {
      timeouts.push(o.timeout);
      return new Promise((resolve, reject) => {
        const w: Waiter = { pred, resolve, reject, timer: setTimeout(() => { drop(w); reject(playwrightTimeout(o.timeout)); }, o.timeout) };
        waiters.push(w);
      });
    },
  };
  return {
    page: page as unknown as Parameters<typeof actAndAwait>[0],
    timeouts,
    pending: () => waiters.length,
    emit(...rs: FakeResponse[]) {
      for (const r of rs) for (const w of [...waiters]) if (w.pred(r)) { clearTimeout(w.timer); drop(w); w.resolve(r); }
    },
    /** The page (or its context, or the browser) goes away under every wait. */
    close() {
      for (const w of [...waiters]) { clearTimeout(w.timer); drop(w); w.reject(new Error(TARGET_CLOSED)); }
    },
  };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ok = (data: unknown) => ({ ok: true, data });
const POST_ENTRANTS = { method: "POST", path: /^\/api\/v1\/divisions\/[^/]+\/entrants$/ };

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => { unhandled.push(e); };
afterEach(() => { process.off("unhandledRejection", onUnhandled); unhandled.length = 0; });

describe("actAndAwait resolves on the product's own response", () => {
  it("resolves with the data of the FIRST matching response the act provokes, and its path", async () => {
    const f = fakePage();
    const out = await actAndAwait<{ id: string }[]>(f.page, POST_ENTRANTS, async () => {
      f.emit(resp("POST", "/api/v1/divisions/d1/entrants", 201, ok([{ id: "e1" }])), resp("POST", "/api/v1/divisions/d1/entrants", 201, ok([{ id: "e2" }])));
    }, 1000);
    expect(out).toEqual({ data: [{ id: "e1" }], path: "/api/v1/divisions/d1/entrants" });
    expect(f.timeouts).toEqual([1000]);
  });

  it("registers the wait BEFORE acting: a response the click provokes synchronously is still seen", async () => {
    const f = fakePage();
    let acted = 0;
    const out = await actAndAwait<string>(f.page, POST_ENTRANTS, async () => {
      acted++;
      expect(f.pending(), "the wait must exist when the act runs").toBe(1);
      f.emit(resp("POST", "/api/v1/divisions/d1/entrants", 200, ok("seen")));
    }, 200);
    expect([acted, out.data]).toEqual([1, "seen"]);
  });

  it("a response that arrived before the call is never the answer", async () => {
    const f = fakePage();
    f.emit(resp("POST", "/api/v1/divisions/d1/entrants", 200, ok("stale")));
    const out = await actAndAwait<string>(f.page, POST_ENTRANTS, async () => { f.emit(resp("POST", "/api/v1/divisions/d1/entrants", 200, ok("fresh"))); }, 200);
    expect(out.data).toBe("fresh");
  });

  it("ignores a matching GET when POST was asked, and another path, and a query string is not part of the path", async () => {
    const f = fakePage();
    const out = await actAndAwait<string>(f.page, POST_ENTRANTS, async () => {
      f.emit(
        resp("GET", "/api/v1/divisions/d1/entrants", 200, ok("the list read")),
        resp("POST", "/api/v1/divisions/d1/stages", 200, ok("another path")),
        resp("POST", "/api/v1/divisions/d1/entrants?x=1", 200, ok("the post")),
      );
    }, 500);
    expect(out).toEqual({ data: "the post", path: "/api/v1/divisions/d1/entrants" });
  });

  it("a second call is judged afresh, even with a global (stateful) RegExp", async () => {
    const f = fakePage();
    const want = { method: "POST", path: /\/api\/v1\/stages\/[^/]+\/generate$/g };
    const a = await actAndAwait<string>(f.page, want, async () => { f.emit(resp("POST", "/api/v1/stages/s1/generate", 200, ok("first"))); }, 200);
    const b = await actAndAwait<string>(f.page, want, async () => { f.emit(resp("POST", "/api/v1/stages/s2/generate", 200, ok("second"))); }, 200);
    expect([a.data, b.data, b.path]).toEqual(["first", "second", "/api/v1/stages/s2/generate"]);
  });

  it("throws the RefusedCall unwrapEnvelope builds for a 422: code and message intact, extra carried", async () => {
    const f = fakePage();
    const body = { ok: false, error: { code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS", message: "acknowledge the warnings", warnings: [{ kind: "overlap" }] } };
    const e = await actAndAwait(f.page, { method: "POST", path: /\/start$/ }, async () => { f.emit(resp("POST", "/api/v1/divisions/d1/start", 422, body)); }, 200).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RefusedCall);
    const r = e as RefusedCall;
    expect([r.method, r.path, r.status, r.code]).toEqual(["POST", "/api/v1/divisions/d1/start", 422, "SCHEDULE_UNACKNOWLEDGED_WARNINGS"]);
    expect(r.message).toContain("acknowledge the warnings");
    expect(r.extra).toEqual({ warnings: [{ kind: "overlap" }] });
    // The same answer, read the way HttpDriver reads it, is the same refusal.
    const same = (() => { try { unwrapEnvelope("POST", "/api/v1/divisions/d1/start", 422, body); } catch (x) { return x as RefusedCall; } return null; })();
    expect(same && [same.message, same.code, same.extra]).toEqual([r.message, r.code, r.extra]);
  });

  it("the product's NEXT_MATCH_STARTED refusal names the fed fixture, as it does over HTTP (W1b carry c)", async () => {
    const next = nextMatchStartedText();
    const f = fakePage();
    const body = { ok: false, error: { code: next.code, message: "m", [next.wire.key]: { [next.wire.idField]: "f-9", round: 2, seq: 1 } } };
    const e = await actAndAwait(f.page, { method: "POST", path: /\/events$/ }, async () => { f.emit(resp("POST", "/api/v1/fixtures/f1/events", next.status, body)); }, 200).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RefusedCall);
    expect([(e as RefusedCall).status, (e as RefusedCall).code]).toEqual([next.status, next.code]);
    expect(nextMatchFixtureId(e as RefusedCall)).toBe("f-9");
  });

  it("a 2xx with no data, or a body that is not JSON, is refused — never an undefined result", async () => {
    const f = fakePage();
    const noData = await actAndAwait(f.page, POST_ENTRANTS, async () => { f.emit(resp("POST", "/api/v1/divisions/d1/entrants", 200, { ok: true })); }, 200).catch((x: unknown) => x);
    expect([(noData as RefusedCall).status, (noData as RefusedCall).code]).toEqual([200, "NO_DATA"]);
    const html = await actAndAwait(f.page, POST_ENTRANTS, async () => { f.emit(resp("POST", "/api/v1/divisions/d1/entrants", 200, null, { badJson: true })); }, 200).catch((x: unknown) => x);
    expect([(html as RefusedCall).status, (html as RefusedCall).code]).toEqual([200, "NO_DATA"]);
    const crash = await actAndAwait(f.page, POST_ENTRANTS, async () => { f.emit(resp("POST", "/api/v1/divisions/d1/entrants", 502, null, { badJson: true })); }, 200).catch((x: unknown) => x);
    expect(crash).toBeInstanceOf(RefusedCall);
    expect([(crash as RefusedCall).status, (crash as RefusedCall).code]).toEqual([502, null]);
  });

  it("no matching response within the budget: a named NoProductResponse, never undefined", async () => {
    const f = fakePage();
    const e = await actAndAwait(f.page, POST_ENTRANTS, async () => { f.emit(resp("GET", "/api/v1/divisions/d1/entrants", 200, ok([]))); }, 30).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NoProductResponse);
    expect((e as Error).message).toContain("POST");
    expect((e as Error).message).toContain(POST_ENTRANTS.path.source);
    expect((e as Error).message).toContain("30 ms");
    expect(f.timeouts).toEqual([30]);
  });

  // M-5: three different failures, three different headlines. Only an act that
  // FINISHED with no request behind it is "the click reached nothing"; a budget
  // spent while the act was still running (a control that never became
  // actionable — the fold at 320, a selector miss) and a page that went away
  // are other stories, and a run report must not tell them as that one.
  it("the act finished and no request followed: reason no-response, 'the click reached nothing'", async () => {
    const f = fakePage();
    const e = await actAndAwait(f.page, POST_ENTRANTS, async () => undefined, 30).catch((x: unknown) => x) as NoProductResponse;
    expect(e).toBeInstanceOf(NoProductResponse);
    expect(e.reason).toBe("no-response");
    expect(e.message).toContain("the action finished");
    expect(e.message).toContain("the click reached nothing");
  });

  it("the budget ran out while the act was still running: reason act-pending, never 'the click reached nothing'", async () => {
    const f = fakePage();
    const e = await actAndAwait(f.page, POST_ENTRANTS, () => sleep(80), 20).catch((x: unknown) => x) as NoProductResponse;
    expect(e).toBeInstanceOf(NoProductResponse);
    expect(e.reason).toBe("act-pending");
    expect(e.message).toContain("while the action was still running");
    expect(e.message).not.toContain("the click reached nothing");
    expect(e.message).toContain("20 ms");
  });

  it("the page went away under the wait: reason wait-failed, the cause named, never 'the click reached nothing'", async () => {
    const f = fakePage();
    const e = await actAndAwait(f.page, POST_ENTRANTS, async () => { f.close(); }, 5000).catch((x: unknown) => x) as NoProductResponse;
    expect(e).toBeInstanceOf(NoProductResponse);
    expect(e.reason).toBe("wait-failed");
    expect(e.message).toContain("Target page, context or browser has been closed");
    expect(e.message).not.toContain("the click reached nothing");
  });

  // C-1: the budget expiring while act() is still pending rejects the wait
  // before anything awaits it. Without a handler attached at creation that is
  // an unhandled rejection, which crash-exit.ts turns into exit 3 for the WHOLE
  // run instead of one red case. Both orderings are driven: the act resolving
  // after the budget, and the act rejecting after it.
  it("C-1: an act that RESOLVES after the budget expired is one case's NoProductResponse, and nothing is unhandled", async () => {
    process.on("unhandledRejection", onUnhandled);
    const f = fakePage();
    const e = await actAndAwait(f.page, POST_ENTRANTS, () => sleep(80), 20).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NoProductResponse);
    await sleep(20);
    expect(unhandled).toEqual([]);
  });

  it("C-1: an act that REJECTS after the budget expired rejects with the act's own error, and nothing is unhandled", async () => {
    process.on("unhandledRejection", onUnhandled);
    const f = fakePage();
    const boom = new Error("locator.click: Timeout 80ms exceeded (the control never became actionable)");
    const e = await actAndAwait(f.page, POST_ENTRANTS, async () => { await sleep(80); throw boom; }, 20).catch((x: unknown) => x);
    // Precedence: the act's own error beats the expired wait — it names the
    // control that failed, which is the more specific cause.
    expect(e).toBe(boom);
    await sleep(20);
    expect(unhandled).toEqual([]);
  });

  it("an act that throws rejects with ITS error, and the abandoned wait never surfaces as an unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    const f = fakePage();
    const boom = new Error("locator.click: element is not attached");
    const e = await actAndAwait(f.page, POST_ENTRANTS, async () => { throw boom; }, 20).catch((x: unknown) => x);
    expect(e).toBe(boom);
    // Outlive the abandoned wait's own timeout, then look.
    await new Promise((r) => setTimeout(r, 60));
    expect(unhandled).toEqual([]);
  });

  it("refuses a budget that is not a finite number of ms above 0 (Playwright reads 0 as no bound)", async () => {
    const f = fakePage();
    let acted = 0;
    for (const b of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(actAndAwait(f.page, POST_ENTRANTS, async () => { acted++; }, b), String(b)).rejects.toThrow(BadBudget);
    }
    expect([acted, f.timeouts.length]).toEqual([0, 0]);
  });
});
