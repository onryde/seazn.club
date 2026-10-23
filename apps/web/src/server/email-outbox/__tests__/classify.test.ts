// The outbox's retry schedule and its reading of a send result. Spec: docs/superpowers/specs/2026-10-19-email-outbox-design.md
// ("Goals" for the schedule, "Sending" for the result table, including the 409 split) and rulings R5/R8.
//
// The schedule literal below is typed from the spec, never from constants.ts. Every derived bound further down reads
// the constants, so a change to the schedule moves the bound with it instead of leaving it asserting yesterday's numbers.
import { describe, expect, it } from "vitest";
import type { SendResult } from "@/lib/email";
import { classifyResult, nextAttemptAt, type Verdict } from "../classify";
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  RESEND_IDEMPOTENCY_TTL_MS,
  RETRY_DELAYS_MS,
  SEND_TIMEOUT_MS,
  STG_TICK_MS,
  idempotencyKey,
} from "../constants";

const T = new Date("2026-10-23T12:00:00.000Z");
const MINUTE = 60_000;

describe("the retry schedule (constants.ts)", () => {
  it("RETRY_DELAYS_MS is the spec's schedule: 1 min, 5 min, 15 min, 1 h, 6 h", () => {
    expect([...RETRY_DELAYS_MS]).toEqual([1, 5, 15, 60, 360].map((m) => m * MINUTE));
  });

  it("MAX_ATTEMPTS is 6 (spec: '6 attempts in all')", () => {
    expect(MAX_ATTEMPTS).toBe(6);
  });

  it("the Resend key life is 24 h (spec: 'Resend's idempotency key lives 24 h')", () => {
    expect(RESEND_IDEMPOTENCY_TTL_MS).toBe(24 * 60 * MINUTE);
  });

  it("the idempotency key is 'email-outbox/<id>' (spec), and fits Resend's 256-char limit for a uuid", () => {
    const id = "0b7a5d62-3f0e-4a56-9d3e-5c1f8a2b9c10";
    expect(idempotencyKey(id)).toBe(`email-outbox/${id}`);
    expect(idempotencyKey(id).length).toBeLessThanOrEqual(256);
  });

  it("the whole retry span stays under half Resend's 24 h key life, worst case (spec: 'well under')", () => {
    const worst = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + MAX_ATTEMPTS * (SEND_TIMEOUT_MS + LEASE_MS + STG_TICK_MS);
    // Anti-vacuity: the sum really was built from the five delays plus six attempts' slack.
    expect(RETRY_DELAYS_MS.length).toBe(MAX_ATTEMPTS - 1);
    expect(worst).toBeGreaterThan(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    expect(worst).toBeLessThan(RESEND_IDEMPOTENCY_TTL_MS / 2);
  });
});

describe("nextAttemptAt", () => {
  it("after attempt n waits RETRY_DELAYS_MS[n-1]; after MAX_ATTEMPTS there is none", () => {
    let checked = 0;
    for (let n = 1; n < MAX_ATTEMPTS; n++) {
      expect(nextAttemptAt(n, T)?.getTime(), `after attempt ${n}`).toBe(T.getTime() + RETRY_DELAYS_MS[n - 1]!);
      checked++;
    }
    expect(nextAttemptAt(MAX_ATTEMPTS, T)).toBeNull();
    expect(checked).toBe(MAX_ATTEMPTS - 1);
  });

  it("past MAX_ATTEMPTS there is still none (a row that somehow reached attempt 9 is not given a 10th)", () => {
    expect(nextAttemptAt(MAX_ATTEMPTS + 1, T)).toBeNull();
    expect(nextAttemptAt(MAX_ATTEMPTS + 3, T)).toBeNull();
  });

  it("refuses a count that is not an attempt number (0, negative, fractional, NaN) instead of dating a retry NaN", () => {
    let refused = 0;
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => nextAttemptAt(bad, T), String(bad)).toThrow(RangeError);
      refused++;
    }
    expect(refused).toBe(4);
  });

  it("does not mutate the date it was given", () => {
    const from = new Date(T);
    nextAttemptAt(1, from);
    expect(from.getTime()).toBe(T.getTime());
  });
});

const http = (status: number, errorName: string | null): SendResult => ({ ok: false, reason: "http", status, errorName, detail: "ignored" });

describe("classifyResult follows the spec's result table", () => {
  it("every row of the table (and none is vacuous)", () => {
    const table: [string, SendResult, Verdict][] = [
      // spec: "2xx -> sent with provider_id". R8: a 2xx whose body carried no id is still sent.
      ["2xx with an id", { ok: true, providerId: "re_1" }, "sent"],
      ["2xx without an id (R8)", { ok: true, providerId: null }, "sent"],
      // spec: "429, 5xx, timeout, network error -> back to queued"
      ["429", http(429, "rate_limit_exceeded"), "retry"],
      ["500", http(500, "internal_server_error"), "retry"],
      ["502", http(502, null), "retry"],
      ["503", http(503, null), "retry"],
      ["504", http(504, null), "retry"],
      ["network", { ok: false, reason: "network", detail: "fetch failed (ECONNRESET)" }, "retry"],
      ["timeout", { ok: false, reason: "network", detail: "timeout" }, "retry"],
      // spec: "400 / 403 / 422 -> dead at once (retrying cannot help)"
      ["400", http(400, "validation_error"), "dead"],
      ["403", http(403, "validation_error"), "dead"],
      ["422", http(422, "validation_error"), "dead"],
      // spec: the 409 split on Resend's error name
      ["409 concurrent_idempotent_requests", http(409, "concurrent_idempotent_requests"), "retry"],
      ["409 invalid_idempotent_request", http(409, "invalid_idempotent_request"), "dead"],
      // not in the spec's table: any other 4xx cannot be fixed by retrying, any other 409 is not the 'dead' name
      ["401 (other 4xx)", http(401, "missing_api_key"), "dead"],
      ["409 with a name we do not know", http(409, "something_new"), "retry"],
      ["409 with no name at all", http(409, null), "retry"],
      // the gate (R5): nothing was sent
      ["no_api_key", { ok: false, reason: "no_api_key" }, "dead"],
      ["suppressed", { ok: false, reason: "suppressed" }, "suppressed"],
    ];
    let checked = 0;
    for (const [label, r, v] of table) {
      expect(classifyResult(r), label).toBe(v);
      checked++;
    }
    expect(checked).toBe(table.length);
    expect(table.length).toBe(19);
    // the table reaches every verdict (a table that only ever said "retry" would not witness the others)
    expect(new Set(table.map(([, , v]) => v))).toEqual(new Set<Verdict>(["sent", "retry", "dead", "suppressed"]));
  });

  it("sweeps every http status 400-599 once: 429 and 5xx retry, the rest of 4xx die (409 aside)", () => {
    let checked = 0;
    for (let status = 400; status <= 599; status++) {
      if (status === 409) continue; // the split, pinned by name above
      const expected: Verdict = status === 429 || status >= 500 ? "retry" : "dead";
      expect(classifyResult(http(status, null)), String(status)).toBe(expected);
      checked++;
    }
    expect(checked).toBe(599 - 400 + 1 - 1);
  });
});

describe("the verdict never depends on Resend's free-text detail", () => {
  it("the same status and name with different detail text classify the same", () => {
    const a: SendResult = { ok: false, reason: "http", status: 500, errorName: null, detail: "oops" };
    const b: SendResult = { ok: false, reason: "http", status: 500, errorName: null, detail: "invalid_idempotent_request" };
    expect(classifyResult(a)).toBe("retry");
    expect(classifyResult(b)).toBe("retry");
  });
});
