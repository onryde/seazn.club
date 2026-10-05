// v1 kernel: envelope, EngineError→HTTP map, cursor pagination (doc 08 §1/§4).
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EngineError, EngineErrorCode } from "@seazn/engine/core";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";
import { getRequestContext } from "@/server/request-context";
import { setRateLimitInfo } from "../context";
import { log } from "@/server/logger";
import {
  ENGINE_HTTP,
  v1,
  reply,
  parseBody,
  encodeCursor,
  decodeCursor,
  listQuery,
  page,
  assertOneOf,
} from "../http";

// Only `captureException` is used by the kernel; the spy is what proves a 422
// does not page anyone.
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("v1 envelope", () => {
  it("wraps success as { ok, data, requestId }", async () => {
    const res = await v1(async () => ({ hello: "world" }));
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({ hello: "world" });
    expect(typeof json.requestId).toBe("string");
  });

  // server/request-context.ts: the requestId every log line for this
  // request carries (via server/logger.ts's mixin) must be the SAME id the
  // client sees in the response envelope, not an independently-generated one.
  it("runs the handler inside the request-context ALS with the response's requestId", async () => {
    let seenDuringHandler: string | undefined;
    const res = await v1(async () => {
      seenDuringHandler = getRequestContext().requestId;
      return { ok: true };
    });
    const json = await body(res);
    expect(seenDuringHandler).toBeDefined();
    expect(seenDuringHandler).toBe(json.requestId);
  });

  it("honours reply() status and headers", async () => {
    const res = await v1(async () => reply(201, { id: 1 }, { ETag: '"seq-3"' }));
    expect(res.status).toBe(201);
    expect(res.headers.get("etag")).toBe('"seq-3"');
  });

  // spec 03 §7 / doc 08 §4 — the central code→HTTP map.
  it.each([
    ["SEQ_CONFLICT", 409],
    ["INVALID_EVENT", 422],
    ["LINEUP_INVALID", 422],
    ["ELIGIBILITY", 422],
    ["ALREADY_DECIDED", 422],
    ["STAGE_NOT_READY", 422],
    ["CONFIG_INVALID", 422],
    // W4a (#425) §7 — the core time model's four codes, all 422. UNKNOWN_PHASE
    // was a 500 on the reasoning that a phase order is an internal invariant no
    // client can reach. It is not: `at.period` is a free string on the payload,
    // so an unrecognised period is reachable from any pad that sends one, and a
    // 500 answers it by paging the on-call with nothing the scorer can act on.
    // The write gate rejects a client's unknown period as INVALID_EVENT first
    // (core/events.ts); what is left here is a module whose declared order and
    // whose `apply()` order disagree — still a rejected event, still not a page.
    ["NON_MONOTONIC_TIME", 422],
    ["EXPEDITE_WRONG_WINNER", 422],
    ["SUB_WINDOW_EXCEEDED", 422],
    ["UNKNOWN_PHASE", 422],
    // S5 (#431) — tennis game-penalty award refused mid-tie-break.
    ["GAME_AWARD_DURING_TIEBREAK", 422],
  ] as const)("maps EngineError %s → %d", async (code, status) => {
    const res = await v1(async () => {
      throw new EngineError(code, "boom");
    });
    expect(res.status).toBe(status);
    const json = await body(res);
    expect(json.ok).toBe(false);
    expect((json.error as { code: string }).code).toBe(code);
  });

  // The `?? 422` fallback in v1Inner means a code missing from ENGINE_HTTP
  // still answers 200-something plausible, so nothing at runtime notices the
  // omission — and the exhaustive Record only fails `tsc`, which is PR-only
  // for this workspace. Assert the map covers the enum here too.
  it("maps EVERY EngineErrorCode explicitly — no code rides the ?? 422 fallback", () => {
    const unmapped = EngineErrorCode.options.filter((code) => ENGINE_HTTP[code] === undefined);
    expect(unmapped).toEqual([]);
  });

  // W4a (#425) — the reason UNKNOWN_PHASE moved off 500. `at.period` is a free
  // string on the payload, so a scorer's typo used to raise a Sentry issue and
  // wake someone, for an input the scorer could have retyped. The status
  // assertion above does not catch that on its own: what pages is the
  // `status >= 500` capture branch, so the capture is asserted separately.
  it("does not page the on-call for a period the scorer can retype", async () => {
    sentry.captureException.mockClear();
    const res = await v1(async () => {
      throw new EngineError("UNKNOWN_PHASE", 'period "SO" is not in the declared phase order');
    });
    expect(res.status).toBe(422);
    expect(sentry.captureException).not.toHaveBeenCalled();
    // ...and the branch still fires for a code that really is ours to fix.
    const dup = await v1(async () => {
      throw new EngineError("MODULE_DUPLICATE", "two modules claim icehockey@1.0.0");
    });
    expect(dup.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  // A 500 must be BOTH paged (Sentry) and queryable (pino) — one tool alerts
  // a human, the other is what they search once alerted. A 4xx the caller can
  // fix (retype a period, retry a rate limit) pages/logs neither.
  it("log.error fires alongside Sentry.captureException on every 500 path, and only 500s", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    try {
      await v1(async () => {
        throw new EngineError("UNKNOWN_PHASE", "not our bug — 422");
      });
      expect(logged).not.toHaveBeenCalled();

      await v1(async () => {
        throw new EngineError("MODULE_DUPLICATE", "two modules claim icehockey@1.0.0");
      });
      expect(logged).toHaveBeenCalledTimes(1);

      await v1(async () => {
        throw new HttpError(500, "db is down");
      });
      expect(logged).toHaveBeenCalledTimes(2);

      await v1(async () => {
        throw new Error("unhandled");
      });
      expect(logged).toHaveBeenCalledTimes(3);
    } finally {
      logged.mockRestore();
    }
  });

  it("SEQ_CONFLICT carries current_seq (doc 08 §4)", async () => {
    const res = await v1(async () => {
      throw new EngineError("SEQ_CONFLICT", "stale", { expectedSeq: 3, actualSeq: 7 });
    });
    expect(res.status).toBe(409);
    const json = await body(res);
    expect((json.error as { current_seq: number }).current_seq).toBe(7);
  });

  // F2a (P7 follow-up, 2026-08-14): the seeded-path analogue of
  // group_too_few_entrants (stages.ts generateSeededStageFixtures) — the
  // detail carries groups/qualifiers/required/stranded, and it must flow
  // through the JSON body's `error` object, not just live on the thrown
  // EngineError's `.data`, or the client never sees it.
  it("STAGE_NOT_READY reason=seeded_pool_too_few_qualifiers forwards groups/qualifiers/required/stranded (F2a)", async () => {
    const res = await v1(async () => {
      throw new EngineError(
        "STAGE_NOT_READY",
        "not enough qualifiers to fill 4 groups — each group needs at least 2 (have 6, need 8); 2 would never receive a fixture",
        { stageId: "s1", reason: "seeded_pool_too_few_qualifiers", groups: 4, qualifiers: 6, required: 8, stranded: 2 },
      );
    });
    expect(res.status).toBe(422);
    const json = await body(res);
    const err = json.error as {
      reason?: string;
      groups?: number;
      qualifiers?: number;
      required?: number;
      stranded?: number;
    };
    expect(err.reason).toBe("seeded_pool_too_few_qualifiers");
    expect(err.groups).toBe(4);
    expect(err.qualifiers).toBe(6);
    expect(err.required).toBe(8);
    expect(err.stranded).toBe(2);
  });

  // An `on_complete` progression stage pressed Generate before its source
  // stage finished (stages.ts generateStageFixtures' pre-flight). The desk
  // names BOTH stages in an amber notice, so the two ids have to reach the
  // JSON body — on the thrown EngineError alone they never left the server,
  // and the organiser got the raw English `message` in a red banner.
  it("STAGE_NOT_READY reason=previous_stage_incomplete forwards stageId/previousStageId", async () => {
    const res = await v1(async () => {
      throw new EngineError(
        "STAGE_NOT_READY",
        "this stage draws its entrants from the previous stage's final table — complete the previous stage first",
        { stageId: "s2", previousStageId: "s1", reason: "previous_stage_incomplete" },
      );
    });
    expect(res.status).toBe(422);
    const json = await body(res);
    expect(json.error).toEqual({
      code: "STAGE_NOT_READY",
      message:
        "this stage draws its entrants from the previous stage's final table — complete the previous stage first",
      reason: "previous_stage_incomplete",
      stageId: "s2",
      previousStageId: "s1",
    });
  });

  // The empty case of the block above: every OTHER STAGE_NOT_READY (Swiss
  // round guards, "need at least 2 active entrants", departed qualifiers…)
  // carries no reason and must keep forwarding nothing but code + message —
  // not even an id that happens to sit on its `.data`.
  it("STAGE_NOT_READY without a known reason forwards only code + message", async () => {
    const res = await v1(async () => {
      throw new EngineError("STAGE_NOT_READY", "need at least 2 active entrants to generate", {
        stageId: "s9",
        previousStageId: "s8",
        entrants: 1,
      });
    });
    expect(res.status).toBe(422);
    const json = await body(res);
    expect(json.error).toEqual({ code: "STAGE_NOT_READY", message: "need at least 2 active entrants to generate" });
  });

  it("maps PaymentRequiredError → 402 with code PAYMENT_REQUIRED and feature_key", async () => {
    // G5 (bench B03 product-gaps, 2026-09-02): PaymentRequiredError extends
    // HttpError, and its dedicated branch in http.ts sits ABOVE the generic
    // `instanceof HttpError` branch (subclass check must come first). Reorder
    // them and every contextual paywall degrades to a generic HttpError
    // response — same 402 status, but `code` reverts to undefined and
    // `feature_key` disappears, so <UpgradeGate> silently stops rendering.
    // This asserts the fields ONLY the specific branch produces, not just the
    // status the generic branch would also produce.
    const res = await v1(async () => {
      throw new PaymentRequiredError("api.access");
    });
    expect(res.status).toBe(402);
    const json = await body(res);
    const error = json.error as { code: string; feature: string; feature_key: string };
    expect(error.code).toBe("PAYMENT_REQUIRED");
    expect(error.feature).toBe("api.access");
    expect(error.feature_key).toBe("api.access");
  });

  it("maps AuthError → 401 and HttpError → its status", async () => {
    expect((await v1(async () => { throw new AuthError("no"); })).status).toBe(401);
    expect((await v1(async () => { throw new HttpError(404, "gone"); })).status).toBe(404);
    expect((await v1(async () => { throw new HttpError(429, "slow"); })).status).toBe(429);
  });

  // A15 / R4: v1() MERGES HttpError.headers with its own rate-limit headers — neither replaces the other.
  it("a 429 carrying BOTH an HttpError Retry-After and the request's X-RateLimit-* keeps both", async () => {
    const res = await v1(async () => {
      setRateLimitInfo({ limit: 60, remaining: 0, reset: 1_790_000_060 });
      throw new HttpError(429, "slow", undefined, undefined, { "Retry-After": "23" });
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("23");
    expect(res.headers.get("x-ratelimit-limit")).toBe("60");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(res.headers.get("x-ratelimit-reset")).toBe("1790000060");
    // The positive pair: with no rate-limit info, the error's own header still rides alone.
    const alone = await v1(async () => { throw new HttpError(429, "slow", undefined, undefined, { "Retry-After": "5" }); });
    expect(alone.headers.get("retry-after")).toBe("5");
    expect(alone.headers.get("x-ratelimit-limit")).toBeNull();
  });

  it("maps ZodError → 400 with issues", async () => {
    const res = await v1(async () => z.object({ n: z.number() }).parse({ n: "x" }));
    expect(res.status).toBe(400);
    const json = await body(res);
    expect((json.error as { code: string }).code).toBe("VALIDATION");
    expect((json.error as { issues: unknown[] }).issues).toBeInstanceOf(Array);
  });
});

describe("parseBody", () => {
  const schema = z.object({ name: z.string() });

  it("parses valid JSON", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({ name: "a" }) });
    expect(await parseBody(req, schema)).toEqual({ name: "a" });
  });

  it("400s malformed JSON", async () => {
    const req = new Request("http://x/", { method: "POST", body: "{nope" });
    await expect(parseBody(req, schema)).rejects.toMatchObject({ status: 400 });
  });
});

describe("assertOneOf", () => {
  const STATUSES = ["draft", "published", "archived"] as const;

  it("accepts a member and accepts null (absent = no filter)", () => {
    expect(() => assertOneOf("published", STATUSES, "status")).not.toThrow();
    expect(() => assertOneOf(null, STATUSES, "status")).not.toThrow();
  });

  it("400s a near-miss instead of silently dropping the filter", () => {
    // The whole point. `?status=publish` used to fall through to `undefined`
    // on the posts and suspensions routes, which returned EVERY row while the
    // caller believed they had filtered — drafts served as published.
    expect(() => assertOneOf("publish", STATUSES, "status")).toThrowError(HttpError);
    let status = 0;
    try {
      assertOneOf("publish", STATUSES, "status");
    } catch (e) {
      status = (e as HttpError).status;
    }
    expect(status).toBe(400);
  });

  it("names the field and every accepted value, so the 400 is actionable", () => {
    expect(() => assertOneOf("nope", STATUSES, "status")).toThrowError(
      "status must be one of draft, published, archived",
    );
  });

  it("400s an empty value — `?status=` is a member check like any other", () => {
    // Deliberate, and matches what the registration list has always done:
    // only an ABSENT param means "no filter". Asserted so a future reader
    // does not quietly re-add the `raw && ...` short-circuit that treated an
    // empty string as absent.
    expect(() => assertOneOf("", STATUSES, "status")).toThrowError(HttpError);
  });

  it("is case-sensitive — `Published` is not `published`", () => {
    expect(() => assertOneOf("Published", STATUSES, "status")).toThrowError(HttpError);
  });
});

describe("cursor pagination", () => {
  it("round-trips a cursor opaquely", () => {
    const cursor = encodeCursor("2026-07-04T00:00:00.000Z", "abc");
    expect(cursor).not.toContain("2026"); // opaque
    expect(decodeCursor(cursor)).toEqual({ createdAt: "2026-07-04T00:00:00.000Z", id: "abc" });
  });

  it("rejects garbage cursors with 400", () => {
    expect(() => decodeCursor("!!!not-base64!!!")).toThrowError(HttpError);
  });

  it("listQuery clamps limit and rejects non-integers", () => {
    expect(listQuery(new Request("http://x/?limit=5000")).limit).toBe(200);
    expect(listQuery(new Request("http://x/")).limit).toBe(50);
    expect(() => listQuery(new Request("http://x/?limit=abc"))).toThrowError(HttpError);
    expect(() => listQuery(new Request("http://x/?limit=0"))).toThrowError(HttpError);
  });

  it("page() trims the over-fetch row and mints nextCursor from the last kept row", () => {
    const rows = [1, 2, 3].map((n) => ({
      id: `id-${n}`,
      created_at: `2026-07-0${n}T00:00:00.000Z`,
    }));
    const result = page(rows, 2);
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
    expect(decodeCursor(result.nextCursor as string).id).toBe("id-2");
    expect(page(rows, 3).nextCursor).toBeNull();
  });
});
