// The 402 a client reads when an organisation has no credit left to stream names them "Seazn credits" (owner ruling
// 2026-11-23). Three sites build that sentence: the ledger's NoCreditsError, the stream-session refusal table, and the
// phone start's mapping of the ledger's error. Pure: no database. The phone case is driven through the REAL producer
// (NoCreditsError) into the real consumer (phoneStartRefusal), not through a hand-built HttpError.
import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { phoneStartRefusal } from "../capture-phone";
import { NoCreditsError } from "../stream-credits";
import { refuse } from "../stream-sessions/refusals";

const NEW_NAME = /\bSeazn credits\b/;
const OLD_NAME = /match credit/i;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("the no-credits 402 names Seazn credits", () => {
  it("at every site that builds it (counted)", () => {
    const ledger = new NoCreditsError("org-1");
    const session = thrown(() => refuse({ ok: false, refusal: "no_credits" }, 0));
    const phone = phoneStartRefusal(ledger);

    expect(ledger).toBeInstanceOf(HttpError);
    expect([ledger.status, ledger.code]).toEqual([402, "no_credits"]);
    expect(session).toBeInstanceOf(HttpError);
    expect([(session as HttpError).status, (session as HttpError).code]).toEqual([402, "no_credits"]);
    expect(phone).toBeInstanceOf(CaptureRefusalError);
    expect([(phone as CaptureRefusalError).status, (phone as CaptureRefusalError).code]).toEqual([402, "no_credit"]);

    const messages = [ledger.message, (session as HttpError).message, (phone as CaptureRefusalError).message];
    expect(messages.length, "anti-vacuity: three sites").toBe(3);
    for (const m of messages) {
      expect(m).toMatch(NEW_NAME);
      expect(m).not.toMatch(OLD_NAME);
    }
  });
});
