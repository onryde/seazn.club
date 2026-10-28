// v1 kernel: envelope, EngineError→HTTP map, cursor pagination (doc 08 §1/§4).
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EngineError, EngineErrorCode, FORFEIT_REASONS, foldMatch, foldMatchWithStoppage, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope, onePlayEvent, sportCases } from "@seazn/engine/testkit";
import uiEn from "@/dictionaries/en/ui.json";
import { interpolate } from "@/lib/i18n-runtime";
import { scoringErrorText } from "@/lib/scoring-vocab";
import { LEVEL_RESULT_REASON } from "@/lib/level-result-reason";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";
import { featureReason } from "@/lib/feature-copy";
import { ApiV1Error } from "@/lib/client-v1";
import { LOCALIZED_CONFIG_ISSUES, settingsSaveErrorText } from "@/lib/config-issue-copy";
import { SHARE_NEEDS_DRAWN_GAME, SHARE_NEEDS_DRAWS } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
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

const enMsg = (k: string, v?: Record<string, string | number>) => interpolate((uiEn as Record<string, string>)[k] ?? k, v);

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
    ["LINEUP_NOT_SUPPORTED", 422],
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
    // W2a — the four codes and the statuses the design's §7 error table gives
    // them (docs/superpowers/specs/2026-10-08-format-matrix-w2a-design.md §7).
    ["SETTLE_NOT_APPLICABLE", 409],
    ["TIEBREAK_NOT_APPLICABLE", 409],
    ["LEVEL_RESULT_IN_BRACKET", 409],
    ["LEVEL_RESULT_SEATED", 500], // an assertion: only reachable through a bug
    ["TIEBREAK_COLOUR_REQUIRED", 422], // W2c D7: an Armageddon that names no Black
    ["GOAL_KIND_REQUIRED", 422], // W2d T18 (PS-7d): a hockey goal without its type
    ["ENDING_SANCTION_PENDING", 422], // W2e X-SE-1: scoring after a match-ending sanction before its ending
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

  // W2c P-7 / X-AB-5 (fix round 1, I2): the next Swiss round is refused while an abandoned board has no result, and the
  // refusal NAMES the boards. They lived on the thrown error's `.data` and never left the server - the desk showed the
  // generic sentence. Read at the wire: the body an API client (and the desk) actually receives.
  it("I2: STAGE_NOT_READY reason=swiss_abandoned_boards forwards the named boards in order (and nothing else from .data)", async () => {
    const abandoned = [
      { fixtureId: "f-3", round: 1, board: 3 },
      { fixtureId: "f-7", round: 2, board: 1 },
    ];
    const res = await v1(async () => {
      throw new EngineError("STAGE_NOT_READY", "current swiss round has undecided fixtures - settle the abandoned boards first", {
        stageId: "s1",
        reason: "swiss_abandoned_boards",
        abandoned,
      });
    });
    expect(res.status).toBe(422);
    expect((await body(res)).error).toEqual({
      code: "STAGE_NOT_READY",
      message: "current swiss round has undecided fixtures - settle the abandoned boards first",
      reason: "swiss_abandoned_boards",
      abandoned,
    });
  });

  it("I2 empty/negative cases: no reason, no boards, or a malformed board forwards code + message only", async () => {
    const good = { fixtureId: "f-3", round: 1, board: 3 };
    const cases: [string, unknown][] = [
      ["boards but no reason (the bare refusal)", { stageId: "s1", abandoned: [good] }],
      ["the reason with no boards", { stageId: "s1", reason: "swiss_abandoned_boards" }],
      ["the reason with an empty list", { stageId: "s1", reason: "swiss_abandoned_boards", abandoned: [] }],
      ["a board without a fixture id", { reason: "swiss_abandoned_boards", abandoned: [{ round: 1, board: 3 }] }],
      ["a fractional round", { reason: "swiss_abandoned_boards", abandoned: [{ ...good, round: 1.5 }] }],
      ["a zero board", { reason: "swiss_abandoned_boards", abandoned: [{ ...good, board: 0 }] }],
      ["one good board and one malformed", { reason: "swiss_abandoned_boards", abandoned: [good, { fixtureId: "x", round: "1", board: 2 }] }],
      ["boards under a reason nobody names", { reason: "made_up", abandoned: [good] }],
    ];
    let checked = 0;
    for (const [why, data] of cases) {
      const res = await v1(async () => {
        throw new EngineError("STAGE_NOT_READY", "m", data);
      });
      expect((await body(res)).error, why).toEqual({ code: "STAGE_NOT_READY", message: "m" });
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  // W2c X-AB-5 (fix round 2, N2): the explicit Complete of a table stage is refused by NAME while a match is held for the
  // settle. Same envelope as the Swiss boards, another reason: read at the wire.
  it("N2: STAGE_NOT_READY reason=abandoned_matches forwards the held matches in order (the stage's own data stays out)", async () => {
    const abandoned = [
      { fixtureId: "f-2", round: 1, board: 2 },
      { fixtureId: "f-9", round: 3, board: 1 },
    ];
    const res = await v1(async () => {
      throw new EngineError("STAGE_NOT_READY", "stage has matches abandoned without a result - settle them first", {
        stageId: "s1",
        reason: "abandoned_matches",
        abandoned,
      });
    });
    expect(res.status).toBe(422);
    expect((await body(res)).error).toEqual({
      code: "STAGE_NOT_READY",
      message: "stage has matches abandoned without a result - settle them first",
      reason: "abandoned_matches",
      abandoned,
    });
  });

  it("N2 empty/negative cases: no list, an empty list, a malformed entry, or the Swiss reason's shape under the wrong reason forwards code + message only", async () => {
    const good = { fixtureId: "f-2", round: 1, board: 2 };
    const cases: [string, unknown][] = [
      ["the reason with no matches", { stageId: "s1", reason: "abandoned_matches" }],
      ["the reason with an empty list", { stageId: "s1", reason: "abandoned_matches", abandoned: [] }],
      ["an entry without a fixture id", { reason: "abandoned_matches", abandoned: [{ round: 1, board: 2 }] }],
      ["a fractional round", { reason: "abandoned_matches", abandoned: [{ ...good, round: 1.5 }] }],
      ["one good entry and one malformed", { reason: "abandoned_matches", abandoned: [good, { fixtureId: "x", round: 1, board: 0 }] }],
      ["matches under a reason nobody names", { reason: "made_up", abandoned: [good] }],
    ];
    let checked = 0;
    for (const [why, data] of cases) {
      const res = await v1(async () => {
        throw new EngineError("STAGE_NOT_READY", "m", data);
      });
      expect((await body(res)).error, why).toEqual({ code: "STAGE_NOT_READY", message: "m" });
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  // W2c P-5 (fix round 1): CONFIG_INVALID carries the PROBLEM in `data.issues` (zod's issue list - the rule's own
  // sentence, e.g. the carrom share refinement), not in the generic message. http.ts did not forward it, so a refused
  // setting told the organiser nothing about what to change.
  it("P-5: CONFIG_INVALID forwards the issue messages (path and message), and only those", async () => {
    const issues = [
      { code: "custom", path: ["abandonPolicy"], message: "Sharing the points needs a drawn game to be possible", input: "secret", extra: 1 },
      { code: "custom", path: [], message: "second problem" },
    ];
    const res = await v1(async () => {
      throw new EngineError("CONFIG_INVALID", "invalid carrom config", { issues });
    });
    expect(res.status).toBe(422);
    expect((await body(res)).error).toEqual({
      code: "CONFIG_INVALID",
      message: "invalid carrom config",
      issues: [
        { path: ["abandonPolicy"], message: "Sharing the points needs a drawn game to be possible" },
        { path: [], message: "second problem" },
      ],
    });
  });

  it("P-5 end to end: the REAL refusal of generic and carrom (their own schemas) reaches the organiser's screen as the localized sentence", async () => {
    // The producer is the sport's configSchema (zod's own issue objects, `input` and all), the consumer is the settings
    // form's reader - the wire between them is the thing under test, not a fixture on either end.
    const sports: [string, Record<string, unknown>, string][] = [
      ["generic", { allowDraws: false, abandonPolicy: "share" }, SHARE_NEEDS_DRAWS],
      ["carrom", { tieBoard: "extra", abandonPolicy: "share" }, SHARE_NEEDS_DRAWN_GAME],
    ];
    let checked = 0;
    for (const [key, cfg, sentence] of sports) {
      const mod = builtinModules.find((m) => m.key === key)!;
      const parsed = mod.configSchema.safeParse({ ...mod.variants[Object.keys(mod.variants)[0]!], ...cfg });
      expect(parsed.success, `${key}: the rig must be refused by the schema`).toBe(false);
      if (parsed.success) continue;
      const res = await v1(async () => {
        throw new EngineError("CONFIG_INVALID", `invalid ${key} config`, { issues: parsed.error.issues });
      });
      expect(res.status).toBe(422);
      const { code, message, ...extra } = (await body(res)).error as { code: string; message: string } & Record<string, unknown>;
      expect(extra, `${key}: only path and message go out`).toEqual({ issues: [{ path: ["abandonPolicy"], message: sentence }] });
      const shown = settingsSaveErrorText(new ApiV1Error(message, 422, code, extra), enMsg as never, "fallback");
      expect(shown, key).not.toBe(message); // not the generic "invalid <sport> config"
      expect(shown, key).toBe(uiEn[LOCALIZED_CONFIG_ISSUES.get(sentence)!]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  // W2c Task 12 (Task 2 review): the division save's CONFIG_INVALID after a per-field refusal names the fields it kept as
  // stored (`data.refused`, divisions.ts) — forwarded beside `issues`, well-formed entries only, their four keys only.
  it("CONFIG_INVALID forwards `refused` beside `issues`: well-formed entries, four keys each; a malformed one is dropped", async () => {
    const kept = { field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageId: "6f1c5c9e-1111-4c1d-9b0e-000000000001", stageName: "Pool A" };
    const table = { field: "tiebreakers", code: "DIVISION_TABLE_RULES_LOCKED", stageId: "6f1c5c9e-1111-4c1d-9b0e-000000000002", stageName: "Pool B" };
    const refused = [
      { ...kept, secret: 1 },
      table,
      { ...kept, code: "STAGE_FORMAT_LOCKED" }, // not a division refusal
      { field: "cap", code: "DIVISION_FORMAT_LOCKED", stageId: 3, stageName: "x" },
      "setTo",
    ];
    const res = await v1(async () => {
      throw new EngineError("CONFIG_INVALID", "invalid badminton config once setTo stay as stored", {
        issues: [{ code: "custom", path: ["cap"], message: "cap must be ≥ the set target" }],
        refused,
      });
    });
    expect(res.status).toBe(422);
    expect((await body(res)).error).toEqual({
      code: "CONFIG_INVALID",
      message: "invalid badminton config once setTo stay as stored",
      issues: [{ path: ["cap"], message: "cap must be ≥ the set target" }],
      refused: [kept, table],
    });
    // Each half alone: `refused` without issues still goes out; neither leaves code + message.
    const alone = await v1(async () => {
      throw new EngineError("CONFIG_INVALID", "m", { refused: [kept] } as never);
    });
    expect((await body(alone)).error).toEqual({ code: "CONFIG_INVALID", message: "m", refused: [kept] });
    const neither = await v1(async () => {
      throw new EngineError("CONFIG_INVALID", "m", { refused: [{ field: 1 }] } as never);
    });
    expect((await body(neither)).error).toEqual({ code: "CONFIG_INVALID", message: "m" });
  });

  it("P-5 empty cases: no issues, an empty list, or entries without a message forward code + message only", async () => {
    const cases: [string, unknown][] = [
      ["no data", undefined],
      ["no issues", { fixtureId: "f1" }],
      ["an empty list", { issues: [] }],
      ["entries with no message", { issues: [{ path: ["a"] }, { message: 3 }] }],
      ["a non-list", { issues: "oops" }],
    ];
    let checked = 0;
    for (const [why, data] of cases) {
      const res = await v1(async () => {
        throw new EngineError("CONFIG_INVALID", "m", data as never);
      });
      expect((await body(res)).error, why).toEqual({ code: "CONFIG_INVALID", message: "m" });
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  // W2a fix round 1 (review M-1): LEVEL_RESULT_IN_BRACKET has two emitters asking for different things, so its
  // reason reaches the wire — and only a reason this codebase names (lib/level-result-reason.ts).
  it("M-1: LEVEL_RESULT_IN_BRACKET forwards each named reason, and nothing else from .data", async () => {
    let checked = 0;
    for (const reason of Object.values(LEVEL_RESULT_REASON)) {
      const res = await v1(async () => {
        throw new EngineError("LEVEL_RESULT_IN_BRACKET", "m", { fixtureId: "f1", stage: "knockout", reason });
      });
      expect(res.status, reason).toBe(409);
      expect((await body(res)).error, reason).toEqual({ code: "LEVEL_RESULT_IN_BRACKET", message: "m", reason });
      checked++;
    }
    expect(checked).toBe(2);
    // The empty case: no reason, or one this codebase does not name, forwards code + message only.
    for (const data of [{ fixtureId: "f1" }, { fixtureId: "f1", reason: "made_up" }]) {
      const res = await v1(async () => {
        throw new EngineError("LEVEL_RESULT_IN_BRACKET", "m", data);
      });
      expect((await body(res)).error).toEqual({ code: "LEVEL_RESULT_IN_BRACKET", message: "m" });
    }
  });

  // W2a ruling D-R8: a settle or a decider naming a withdrawn winner (C17, D-R7) is refused SETTLE_NOT_APPLICABLE
  // with reason "withdrawn", and that reason reaches the wire so the copy can say so — the code's own copy ("it isn't
  // level, or it's already settled") is false for it.
  it("D-R8: SETTLE_NOT_APPLICABLE forwards reason withdrawn, and nothing else from .data", async () => {
    const res = await v1(async () => {
      throw new EngineError("SETTLE_NOT_APPLICABLE", "m", { fixtureId: "f1", reason: "withdrawn", winner: "e1" });
    });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toEqual({ code: "SETTLE_NOT_APPLICABLE", message: "m", reason: "withdrawn" });
    // The positive pair: every other SETTLE_NOT_APPLICABLE (the not-a-bracket refusal, the kernel's own precondition
    // with no reason) keeps forwarding code + message only, so it keeps the code's own copy.
    let checked = 0;
    for (const data of [{ fixtureId: "f1", reason: "not_bracket", stage: "league" }, { fixtureId: "f1" }, { reason: "made_up" }]) {
      const r = await v1(async () => {
        throw new EngineError("SETTLE_NOT_APPLICABLE", "m", data);
      });
      expect((await body(r)).error, JSON.stringify(data)).toEqual({ code: "SETTLE_NOT_APPLICABLE", message: "m" });
      checked++;
    }
    expect(checked).toBe(3);
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
    const error = json.error as { code: string; feature: string; feature_key: string; reason: unknown };
    expect(error.code).toBe("PAYMENT_REQUIRED");
    expect(error.feature).toBe("api.access");
    expect(error.feature_key).toBe("api.access");
    // Batch-6 T18-1: the upgrade-moment contract's human sentence (`<UpgradeGate>` shows it) is on the envelope, a string,
    // and the one `featureReason` says for that feature.
    expect(typeof error.reason, "the envelope carries a reason").toBe("string");
    expect((error.reason as string).length, "and it is not empty").toBeGreaterThan(0);
    expect(error.reason).toBe(featureReason("api.access"));
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

// W2b loop-F review M-4 (plan D3): FORFEIT_REASON_WRONG_PHASE names the phase it judged and the reasons that phase
// admits. Driven through the REAL engine fold for every sport (the refusal's data is the engine's, never typed here),
// then the real v1 envelope, then the copy. The expected list is the rulebook's (spec X-RS-1 as amended by rulings 112
// and 113): a walkover only in the module's declared walkover phases (default "pre", R2) — and the phase reads "pre" for
// a walkover while nothing is played after the start —, a disqualification only once play started (R4), a retirement
// only once something is played (ruling 113), a withdrawal in any phase (R5) — in FORFEIT_REASONS order. Ruling 118: a
// module that declares `startIsPlay` (chess) has played from its Start, so its bare start is "played".
// Engine lineup fix (owner ruling 2026-10-15, option 1): a sport that declares no `lineupPolicy` takes no `core.lineup.*` event.
// This is the WRITE path exactly as `appendEventInTx` runs it - the candidate folded on top of the ledger with
// `strictFromSeq: candidate.seq` - carried through `v1` to the wire, for every sport. The append path itself (a real ledger, a
// real transaction) is in `engine-db/__tests__/append-event.test.ts`.
describe("LINEUP_NOT_SUPPORTED: a sport that declares no lineupPolicy answers a lineup event with a 422 and a copy of its own", () => {
  const LINEUP_TYPES = ["core.lineup.substitution", "core.lineup.replacement", "core.lineup.position", "core.lineup.retirement", "core.lineup.entry"] as const;
  const enM = (k: string, v?: Record<string, string | number>) => interpolate((uiEn as Record<string, string>)[k]!, v);

  /** The write path of `appendEventInTx`: the candidate on top of the ledger, strict from the candidate's seq. */
  const append = (mod: unknown, cfg: unknown, lineups: ReturnType<typeof defaultLineupPair>, prior: EventEnvelope[], candidate: EventEnvelope) =>
    foldMatchWithStoppage(mod as never, cfg as never, lineups, [...prior, candidate], { strictFromSeq: candidate.seq });
  const refusal = (fn: () => unknown): EngineError | null => {
    try {
      fn();
      return null;
    } catch (e) {
      if (e instanceof EngineError) return e;
      throw e;
    }
  };

  it("every sport, first event / after a start / mid-match / after a void, every lineup type: the declaring sports are not refused for it, the others are, as a 422 with the code's own copy", async () => {
    let refused = 0;
    let admitted = 0;
    let declaring = 0;
    let declining = 0;
    for (const { key, module: mod } of sportCases()) {
      const first = mod.configSchema.parse(mod.variants[Object.keys(mod.variants)[0]!] ?? {});
      const lineups = defaultLineupPair(mod.positions);
      const starter = lineups.home.slots.find((sl) => sl.slot === "starting")!;
      const start = makeEnvelope(1, { type: "core.start", payload: {} });
      // ruling 112's scene: the first cfg under which the module's own generator draws a sport event after the start (boardgame's
      // one event decides a plain game, so under its bracket deciders a draw is held instead)
      const scene = [first, mod.configSchema.parse({ ...(first as object), ...mod.bracketDeciders(first as never) })]
        .map((c) => ({ cfg: c, played: onePlayEvent(mod, c, lineups, [start]) }))
        .find((x) => x.played !== null);
      if (scene === undefined) throw new Error(`${key}: its generator draws no sport event after the start`);
      const { cfg } = scene;
      const played = scene.played!;
      // the module's own declaration decides which side of the sweep a sport is on (never a list of sport names)
      const declares = mod.lineupPolicy !== undefined;
      if (declares) declaring++;
      else declining++;
      const ledgers: Array<[string, EventEnvelope[]]> = [
        ["first event", []],
        ["after a start", [start]],
        ["mid-match", [start, played]],
        ["after a void", [start, played, makeEnvelope(3, { type: "core.void", payload: {} }, played.id)]],
      ];
      for (const [at, prior] of ledgers) {
        for (const type of LINEUP_TYPES) {
          // a retirement is the one type that needs only a starter, so it is the one the declaring sports can be shown to ADMIT
          const payload = type === "core.lineup.retirement" ? { side: lineups.home.entrantId, personId: starter.personId } : { side: lineups.home.entrantId };
          const candidate = makeEnvelope(prior.length + 1, { type, payload });
          const label = `${key} ${at} ${type}`;
          const err = refusal(() => append(mod, cfg, lineups, prior, candidate));
          if (!declares) {
            // The gate sits right after the payload check: a payload that does not parse is INVALID_EVENT, so the retirement is the
            // one whose refusal proves the gate. The other types, carrying a bare side, parse-fail first, which is asserted too.
            if (type === "core.lineup.retirement") {
              expect(err, label).toBeInstanceOf(EngineError);
              expect(err!.code, label).toBe("LINEUP_NOT_SUPPORTED");
              const res = await v1(async () => {
                throw err;
              });
              expect(res.status, label).toBe(422);
              const error = (await body(res)).error as Record<string, unknown>;
              expect(error, label).toEqual({ code: "LINEUP_NOT_SUPPORTED", message: err!.message });
              expect(scoringErrorText(error.code as string, error.message as string, enM as never, "score.failed", error), label).toBe(enM("engineError.LINEUP_NOT_SUPPORTED"));
              refused++;
            } else {
              expect(err?.code, `${label}: a malformed payload is INVALID_EVENT, whatever the sport`).toBe("INVALID_EVENT");
            }
          } else if (type === "core.lineup.retirement") {
            expect(err?.code ?? null, `${label}: a sport that declares a policy is never refused for lacking one`).not.toBe("LINEUP_NOT_SUPPORTED");
            // and where the match is live the reducer takes it: the same event the declining sports refuse is a ledger row here
            if (at === "after a start" || at === "mid-match") expect(err, `${label}: a live match takes the retirement of a starter`).toBeNull();
            admitted++;
          }
        }
      }
      // the next legal event folds after a refusal (the ledger was never touched), and a second refusal is the same refusal
      if (!declares) {
        const retire = (n: number) => makeEnvelope(n, { type: "core.lineup.retirement", payload: { side: lineups.home.entrantId, personId: starter.personId } });
        expect(refusal(() => append(mod, cfg, lineups, [start, played], retire(3)))?.code, `${key}: first refusal`).toBe("LINEUP_NOT_SUPPORTED");
        expect(refusal(() => append(mod, cfg, lineups, [start, played], retire(3)))?.code, `${key}: second refusal`).toBe("LINEUP_NOT_SUPPORTED");
        expect(() => append(mod, cfg, lineups, [start], played), `${key}: the play that followed the refusal folds`).not.toThrow();
      }
    }
    // anti-vacuity: both sides of the declaration were reached, and every cell was counted
    expect(declining, "sports that decline").toBeGreaterThan(0);
    expect(declaring, "sports that declare").toBeGreaterThan(0);
    expect(declaring + declining).toBe(sportCases().length);
    expect(refused, "refusals through the wire").toBe(declining * 4);
    expect(admitted, "declaring sports shown not refused for lacking a policy").toBe(declaring * 4);
  });

  it("the replay path stays lenient: a ledger that already holds a lineup event folds without `strictFromSeq`, in a sport that now refuses it", () => {
    let replayed = 0;
    for (const { key, module: mod } of sportCases()) {
      if (mod.lineupPolicy !== undefined) continue;
      const cfg = mod.configSchema.parse(mod.variants[Object.keys(mod.variants)[0]!] ?? {});
      const lineups = defaultLineupPair(mod.positions);
      const starter = lineups.home.slots.find((sl) => sl.slot === "starting")!;
      const ledger = [
        makeEnvelope(1, { type: "core.start", payload: {} }),
        makeEnvelope(2, { type: "core.lineup.retirement", payload: { side: lineups.home.entrantId, personId: starter.personId } }),
      ];
      expect(() => foldMatchWithStoppage(mod as never, cfg as never, lineups, ledger), `${key}: replay`).not.toThrow();
      expect(refusal(() => foldMatchWithStoppage(mod as never, cfg as never, lineups, ledger, { strictFromSeq: 2 }))?.code, `${key}: the write path`).toBe("LINEUP_NOT_SUPPORTED");
      replayed++;
    }
    expect(replayed, "refusing sports replayed").toBeGreaterThan(0);
  });
});

describe("M-4: FORFEIT_REASON_WRONG_PHASE carries its phase and allowed reasons to the wire and the copy", () => {
  const rulebookAllowed = (phase: string, walkoverPhases: readonly string[], played: boolean) =>
    FORFEIT_REASONS.filter((r) =>
      r === "walkover" ? walkoverPhases.includes(played ? phase : "pre") : r === "withdrew" ? true : r === "retired" ? played && phase !== "pre" : phase !== "pre",
    );
  // Ruling 113: the phase reads "play" from the Start, but with nothing played the sentence must not say "once play has
  // started" — the refusal's `played` picks the words.
  const phaseWord = (phase: string, played: boolean) => (phase === "play" && !played ? "forfeit.phase.nothingPlayed" : `forfeit.phase.${phase}`);
  // Spec PF-2: `withdrew` is recorded by the withdrawal cascade alone; every writer this refusal reaches is refused it,
  // so the wire and the sentence never offer it (loop-F R-3).
  const PF2_CASCADE_ONLY: readonly string[] = ["withdrew"];
  const enM = (k: string, v?: Record<string, string | number>) => interpolate((uiEn as Record<string, string>)[k]!, v);

  it("every sport, before the start, after a bare start and once something is played: the refusal's phase, reasons and `played` reach the wire and the sentence", async () => {
    let refused = 0;
    let refusedAfterPlay = 0;
    let refusedBare = 0;
    let nothingToRefuse = 0;
    let onlyCascade = 0;
    for (const { key, module: mod } of sportCases()) {
      const first = mod.configSchema.parse(mod.variants[Object.keys(mod.variants)[0]!] ?? {});
      const lineups = defaultLineupPair(mod.positions);
      const walkoverPhases = mod.walkoverPhases ?? ["pre"];
      const start = makeEnvelope(1, { type: "core.start", payload: {} });
      // Ruling 112's "something is played": the module's own generator draws it (chess's one event decides a plain game,
      // so under its bracket deciders a draw is held instead).
      const scene = [first, mod.configSchema.parse({ ...(first as object), ...mod.bracketDeciders(first as never) })]
        .map((cfg) => ({ cfg, played: onePlayEvent(mod, cfg, lineups, [start]) }))
        .find((x) => x.played !== null);
      if (scene === undefined) throw new Error(`${key}: its generator draws no sport event after the start`);
      for (const at of ["before", "bare start", "played"] as const) {
        const cfg = at === "played" ? scene.cfg : first;
        const head = at === "before" ? [] : at === "bare start" ? [start] : [start, scene.played!];
        const phase = mod.forfeitPhase(foldMatch(mod as never, cfg, lineups, head) as never);
        // Ruling 118: the module's own declaration, never this test's guess, says whether a bare Start is play.
        const played = at === "played" || (at === "bare start" && mod.startIsPlay === true);
        const engineAllowed = rulebookAllowed(phase, walkoverPhases, played);
        const allowed = engineAllowed.filter((r) => !PF2_CASCADE_ONLY.includes(r));
        const reason = FORFEIT_REASONS.find((r) => !engineAllowed.includes(r));
        if (reason === undefined) {
          nothingToRefuse++;
          continue;
        }
        const label = `${key} ${at} ${phase} ${reason}`;
        let caught: unknown = null;
        try {
          foldMatch(mod as never, cfg, lineups, [...head, makeEnvelope(head.length + 1, { type: "core.forfeit", payload: { by: "e-home", reason } })]);
        } catch (e) {
          caught = e;
        }
        expect(caught, label).toBeInstanceOf(EngineError);
        expect((caught as EngineError).code, label).toBe("FORFEIT_REASON_WRONG_PHASE");
        const res = await v1(async () => {
          throw caught;
        });
        expect(res.status, label).toBe(409);
        expect((caught as EngineError).data, `${label}: the engine itself lists the cascade's reason`).toMatchObject({ allowed: engineAllowed });
        const error = (await body(res)).error as Record<string, unknown>;
        if (allowed.length === 0) {
          // Only the cascade's reason fits this phase: nothing a writer may record, so the code's own copy.
          expect(error, label).toEqual({ code: "FORFEIT_REASON_WRONG_PHASE", message: (caught as EngineError).message });
          onlyCascade++;
          continue;
        }
        expect(error, label).toEqual({ code: "FORFEIT_REASON_WRONG_PHASE", message: (caught as EngineError).message, phase, allowed, both: false, played });
        // Design audit 1.5: the reasons are a list in the reader's language — the platform's own English list, not ", ".
        const words = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(allowed.map((r) => enM(`forfeit.reason.${r}`)));
        expect(scoringErrorText(error.code as string, error.message as string, enM as never, "score.failed", error), label).toBe(
          enM("engineErrorReason.FORFEIT_REASON_WRONG_PHASE.named", { phase: enM(phaseWord(phase, played)), allowed: words }),
        );
        refused++;
        if (at === "played") refusedAfterPlay++;
        if (at === "bare start") refusedBare++;
      }
    }
    // Every sport refuses a retirement before the start (R4), so at least one refusal per sport; and once something is
    // played, every sport whose walkover phases stop at "pre" refuses the walkover (ruling 112).
    expect(refused, `refused (nothing to refuse in ${nothingToRefuse}, only the cascade's reason in ${onlyCascade} sport×phase cases)`).toBeGreaterThanOrEqual(sportCases().length);
    expect(refusedAfterPlay, "walkovers refused once something is played").toBe(sportCases().filter(({ module: m }) => m.walkoverPhases === undefined).length);
    expect(refusedAfterPlay).toBeGreaterThan(0);
    // Ruling 113 as amended by 118: every sport refuses a retirement after a bare start, save one whose Start is play.
    const startIsPlay = sportCases().filter(({ module: m }) => m.startIsPlay === true).length;
    expect(startIsPlay, "ruling 118's carve-out is reached (chess)").toBeGreaterThan(0);
    expect(refusedBare, "retirements refused after a bare start").toBe(sportCases().length - startIsPlay);
  });

  it("the empty case: an unreadable shape forwards code + message only, and the copy is the code's own", async () => {
    let checked = 0;
    for (const data of [
      undefined,
      { phase: "pre" },
      { phase: "over", allowed: ["withdrew"], both: false },
      { phase: "pre", allowed: [], both: false },
      { phase: "pre", allowed: ["made_up"], both: false },
      { phase: "pre", allowed: ["withdrew"] },
      // R-3: the phase admits only the cascade's reason — nothing this writer may record, so nothing is named.
      { phase: "pre", allowed: ["withdrew"], both: false },
      // Ruling 113's `played`, present but not a boolean, is no shape this codebase reads.
      { phase: "play", allowed: ["walkover", "disqualified"], both: false, played: "no" },
    ]) {
      const res = await v1(async () => {
        throw new EngineError("FORFEIT_REASON_WRONG_PHASE", "m", data);
      });
      const error = (await body(res)).error as Record<string, unknown>;
      expect(error, JSON.stringify(data)).toEqual({ code: "FORFEIT_REASON_WRONG_PHASE", message: "m" });
      expect(scoringErrorText("FORFEIT_REASON_WRONG_PHASE", "m", enM as never, "score.failed", error)).toBe(enM("engineError.FORFEIT_REASON_WRONG_PHASE"));
      checked++;
    }
    expect(checked).toBe(8);
  });
});
