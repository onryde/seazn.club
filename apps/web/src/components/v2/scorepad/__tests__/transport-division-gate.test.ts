// S2-4 Task 2: the division gate's WRONG_PHASE is a 422, so it reaches the pad through the transport's PERMANENT refusal
// path, not the 409 terminal one that already carries LEVEL_RESULT_IN_BRACKET's and SETTLE_NOT_APPLICABLE's reasons. Without
// the reason there the pad's copy (refusal-copy.ts → engineErrorLabel) can never read the not-started sentence, however the
// server words it. A file of its own, beside transport.test.ts, because that file is the football branch's to change.
//
// single-sport: none; the gate and the transport are sport-agnostic.
import { describe, expect, it } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";
import { interpolate } from "@/lib/i18n-runtime";
import type { MsgFn } from "@/lib/scoring-vocab";
import type { AppendEventBody } from "../pipeline";
import { refusalText } from "../refusal-copy";
import { deviceLinkTransport, sessionTransport } from "../transport";

const BODY: AppendEventBody = { expected_seq: 0, type: "cricket.toss", payload: { wonBy: "e-home", elected: "bat" }, idempotency_key: "idem-1" };

function respond(status: number, error: Record<string, unknown>): typeof fetch {
  return (async () =>
    ({
      ok: false,
      status,
      headers: { get: () => null },
      json: async () => ({ ok: false, error }),
    }) as unknown as Response) as typeof fetch;
}

const en = ((key: string, vars?: Record<string, string | number>) => interpolate((uiEn as Record<string, string>)[key] ?? "", vars)) as MsgFn;

describe("S2-4 T2: the transport carries the division gate's reason to the pad", () => {
  it("a 422 WRONG_PHASE with reason division_not_started is rejected with that reason, on both transports, and reads the not-started sentence", async () => {
    let checked = 0;
    for (const make of [sessionTransport, (init: { fetchFn: typeof fetch }) => deviceLinkTransport("dl_x", init)]) {
      const outcome = await make({ fetchFn: respond(422, { code: "WRONG_PHASE", message: "nope", reason: "division_not_started" }) }).appendEvent("fx-1", BODY);
      expect(outcome).toEqual({ kind: "rejected", code: "WRONG_PHASE", message: "nope", reason: "division_not_started" });
      if (outcome.kind !== "rejected") throw new Error("premise: rejected");
      expect(refusalText(outcome, en)).toBe(uiEn["engineErrorReason.WRONG_PHASE.division_not_started"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("any other reason, or the reason on another code, is not carried, so the code's own copy stands", async () => {
    const cases: Array<[number, Record<string, unknown>]> = [
      [422, { code: "WRONG_PHASE", message: "nope" }],
      [422, { code: "WRONG_PHASE", message: "nope", reason: "made_up" }],
      [422, { code: "INVALID_EVENT", message: "nope", reason: "division_not_started" }],
    ];
    let checked = 0;
    for (const [status, error] of cases) {
      const outcome = await sessionTransport({ fetchFn: respond(status, error) }).appendEvent("fx-1", BODY);
      expect(outcome, JSON.stringify(error)).toEqual({ kind: "rejected", code: error.code, message: "nope" });
      checked++;
    }
    expect(checked).toBe(cases.length);
    const generic = await sessionTransport({ fetchFn: respond(422, { code: "WRONG_PHASE", message: "nope" }) }).appendEvent("fx-1", BODY);
    if (generic.kind !== "rejected") throw new Error("premise: rejected");
    expect(refusalText(generic, en)).toBe(uiEn["engineError.WRONG_PHASE"]);
  });
});
