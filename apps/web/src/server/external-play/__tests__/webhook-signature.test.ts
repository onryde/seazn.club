import { describe, expect, it } from "vitest";
import {
  signLichessWebhook,
  verifyLichessWebhookSignature,
} from "../webhook-signature";

const secret = "sign-key-test";
const body = JSON.stringify({ gameId: "g1" });
const now = 1_700_000_000;

describe("lichess webhook HMAC sign key", () => {
  it("accepts a signature over the exact raw body and timestamp", () => {
    const header = signLichessWebhook({ secret, timestamp: now, rawBody: body });
    expect(
      verifyLichessWebhookSignature({ secret, header, rawBody: body, nowSec: now }),
    ).toEqual({ ok: true });
  });

  it("rejects a rewritten body that reuses a captured signature", () => {
    const header = signLichessWebhook({ secret, timestamp: now, rawBody: body });
    const forged = JSON.stringify({
      gameId: "g1",
      game: { id: "g1", status: "mate", winner: "white" },
    });
    expect(
      verifyLichessWebhookSignature({ secret, header, rawBody: forged, nowSec: now }).ok,
    ).toBe(false);
  });

  it("rejects a wrong key, a stale timestamp, and a missing header", () => {
    const header = signLichessWebhook({ secret, timestamp: now, rawBody: body });
    expect(
      verifyLichessWebhookSignature({
        secret: "other",
        header,
        rawBody: body,
        nowSec: now,
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
    expect(
      verifyLichessWebhookSignature({
        secret,
        header,
        rawBody: body,
        nowSec: now + 301,
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      verifyLichessWebhookSignature({ secret, header: null, rawBody: body, nowSec: now }),
    ).toEqual({ ok: false, reason: "missing" });
  });
});
