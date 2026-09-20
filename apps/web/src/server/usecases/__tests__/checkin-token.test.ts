// PROMPT-53 check-in token lifecycle: round-trip, expiry, tamper resistance,
// and the typ gate (a session JWT must never open the check-in door). Pure —
// no DB needed.
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { mintCheckinToken, verifyCheckinToken } from "../checkin-token";

const FIXTURE = "3b1a8dc4-9f10-4d5e-b0c7-0e6f6a2f9a11";

describe("check-in tokens (PROMPT-53)", () => {
  it("round-trips the fixture id", async () => {
    const token = await mintCheckinToken(FIXTURE, new Date(Date.now() + 60_000));
    await expect(verifyCheckinToken(token)).resolves.toBe(FIXTURE);
  });

  it("expired → 401 CHECKIN_EXPIRED", async () => {
    const token = await mintCheckinToken(FIXTURE, new Date(Date.now() - 1_000));
    await expect(verifyCheckinToken(token)).rejects.toMatchObject({
      status: 401,
      code: "CHECKIN_EXPIRED",
    });
  });

  it("tampered or garbage → CHECKIN_INVALID", async () => {
    const token = await mintCheckinToken(FIXTURE, new Date(Date.now() + 60_000));
    await expect(verifyCheckinToken(token.slice(0, -4) + "AAAA")).rejects.toMatchObject({
      code: "CHECKIN_INVALID",
    });
    await expect(verifyCheckinToken("not-a-jwt")).rejects.toMatchObject({
      code: "CHECKIN_INVALID",
    });
  });

  // Whole-branch review m1: the verify pinned `typ` but no `algorithms` list, so a token signed HS384/HS512 with the
  // same AUTH_SECRET verified. Not exploitable (nobody without the secret can sign) — raised because this was the last
  // of the three verify sites in the tree without the pin. The negative case with its positive pair, because a pin
  // that refused everything would pass the negative row on its own.
  it("m1: a token signed with a DIFFERENT HMAC algorithm on the same secret is refused, though its typ and claims are correct; the HS256 twin still verifies", async () => {
    // The module's OWN key rule (AUTH_SECRET, or the dev fallback when it is unset). Hard-coding the fallback would
    // make every row below pass on a bad signature whenever the environment has a real AUTH_SECRET — which is how the
    // positive twin first failed here, and is exactly the vacuous shape this test exists to avoid.
    const key = new TextEncoder().encode(process.env.AUTH_SECRET ?? "dev-insecure-secret-change-me");
    const claims = { fid: FIXTURE };
    for (const alg of ["HS384", "HS512"] as const) {
      const wrongAlg = await new SignJWT(claims)
        .setProtectedHeader({ alg, typ: "seazn-checkin" })
        .setExpirationTime("1h")
        .sign(key);
      await expect(verifyCheckinToken(wrongAlg), alg).rejects.toMatchObject({ status: 401, code: "CHECKIN_INVALID" });
    }
    // The positive pair, minted by hand rather than through mintCheckinToken so it differs from the row above in the
    // ALGORITHM alone — same key, same typ, same claims.
    const right = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "seazn-checkin" })
      .setExpirationTime("1h")
      .sign(key);
    await expect(verifyCheckinToken(right)).resolves.toBe(FIXTURE);
  });

  it("a session-shaped JWT (no typ) is rejected", async () => {
    const key = new TextEncoder().encode("dev-insecure-secret-change-me");
    const sessionish = await new SignJWT({ uid: "someone", fid: FIXTURE })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(key);
    await expect(verifyCheckinToken(sessionish)).rejects.toMatchObject({
      code: "CHECKIN_INVALID",
    });
  });
});
