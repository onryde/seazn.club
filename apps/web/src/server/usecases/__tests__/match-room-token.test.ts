// Task 5 (chess external-play, spec §12.1): personal match-room link token —
// round-trip, round-open + 24h expiry (T14, M4: bound to the round's OPEN,
// not the schedule — a NULL-time board must resolve), not mint time, with its
// positive pair one second before the deadline, the typ gate against the QR
// check-in token family, missing-claim refusals, and tamper resistance.
// Pure — no DB. The room resolver owns the "other pid" / "other open"
// comparisons against a fixture row; this file only proves verify hands
// claims back verbatim.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { mintMatchRoomToken, verifyMatchRoomToken } from "../match-room-token";
import { mintCheckinToken } from "../checkin-token";
import { authSecretKey } from "../signing-key";
import { MATCH_ROOM_TOKEN_TTL_MS } from "@/server/external-play/window";

const claims = {
  fixtureId: "f1",
  personId: "p1",
  roundOpenId: "ro1",
  roundOpenedAt: "2026-10-01T19:00:00.000Z",
};

describe("match room token", () => {
  // The token expires round-open + 24h, so a fixed open against the real
  // clock turns every test into a time bomb (this file went red on
  // 2026-10-02). Pin "now" to the open; expiry tests move it themselves.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(claims.roundOpenedAt));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips fid/pid/rid/oat", async () => {
    expect(await verifyMatchRoomToken(await mintMatchRoomToken(claims))).toEqual(claims);
  });

  it("is still valid one second before round-open + 24h", async () => {
    vi.useFakeTimers();
    const token = await mintMatchRoomToken(claims);
    vi.setSystemTime(Date.parse(claims.roundOpenedAt) + MATCH_ROOM_TOKEN_TTL_MS - 1000);
    await expect(verifyMatchRoomToken(token)).resolves.toEqual(claims);
    vi.useRealTimers();
  });

  it("expires round-open + 24h (not from mint time)", async () => {
    vi.useFakeTimers();
    // Minted an hour AFTER the open (a resend): the expiry does not move.
    vi.setSystemTime(Date.parse(claims.roundOpenedAt) + 60 * 60_000);
    const token = await mintMatchRoomToken(claims);
    vi.setSystemTime(Date.parse(claims.roundOpenedAt) + MATCH_ROOM_TOKEN_TTL_MS + 1000);
    await expect(verifyMatchRoomToken(token)).rejects.toMatchObject({ status: 401, code: "MATCH_ROOM_EXPIRED" });
    vi.useRealTimers();
  });

  it("refuses a QR check-in token (different typ)", async () => {
    const qr = await mintCheckinToken("f1", new Date(Date.now() + 60_000));
    await expect(verifyMatchRoomToken(qr)).rejects.toMatchObject({ code: "MATCH_ROOM_INVALID" });
  });

  it("refuses a token with valid fid/pid/rid/oat claims but the wrong typ", async () => {
    // Isolates the typ guard from the claims-shape guard below: this token's
    // claims are otherwise perfectly valid, so only a real typ check can
    // reject it (the QR-token test above coincidentally also fails the
    // claims-shape check, since QR tokens don't carry pid/sat at all).
    const wrongTyp = await new SignJWT({ fid: "f1", pid: "p1", rid: "ro1", oat: claims.roundOpenedAt })
      .setProtectedHeader({ alg: "HS256", typ: "seazn-checkin" })
      .setExpirationTime("1h")
      .sign(authSecretKey());
    await expect(verifyMatchRoomToken(wrongTyp)).rejects.toMatchObject({ code: "MATCH_ROOM_INVALID" });
  });

  it("refuses a token missing any one claim — each refused alone, with its full twin verifying", async () => {
    const full = { fid: "f1", pid: "p1", rid: "ro1", oat: claims.roundOpenedAt };
    const sign = (body: Record<string, string>) =>
      new SignJWT(body).setProtectedHeader({ alg: "HS256", typ: "seazn-match-room" }).setExpirationTime("1h").sign(authSecretKey());
    await expect(verifyMatchRoomToken(await sign(full))).resolves.toEqual(claims);
    let checked = 0;
    for (const drop of Object.keys(full)) {
      const partial = Object.fromEntries(Object.entries(full).filter(([k]) => k !== drop));
      await expect(verifyMatchRoomToken(await sign(partial)), drop).rejects.toMatchObject({ code: "MATCH_ROOM_INVALID" });
      checked += 1;
    }
    expect(checked, "anti-vacuity: claims dropped one at a time").toBe(4);
  });

  it("an old schedule-bound token (fid/pid/sat, T5's shape) no longer verifies", async () => {
    const legacy = await new SignJWT({ fid: "f1", pid: "p1", sat: claims.roundOpenedAt })
      .setProtectedHeader({ alg: "HS256", typ: "seazn-match-room" })
      .setExpirationTime("1h")
      .sign(authSecretKey());
    await expect(verifyMatchRoomToken(legacy)).rejects.toMatchObject({ code: "MATCH_ROOM_INVALID" });
  });

  it("refuses a token signed with a different secret (tampered)", async () => {
    const otherKey = new TextEncoder().encode("some-other-secret-entirely");
    const forged = await new SignJWT({ fid: "f1", pid: "p1", rid: "ro1", oat: claims.roundOpenedAt })
      .setProtectedHeader({ alg: "HS256", typ: "seazn-match-room" })
      .setExpirationTime("1h")
      .sign(otherKey);
    await expect(verifyMatchRoomToken(forged)).rejects.toMatchObject({ code: "MATCH_ROOM_INVALID" });
  });

  it("refuses a token with valid typ and claims but signed HS384 with the real secret (algorithm confusion)", async () => {
    const hs384 = await new SignJWT({ fid: "f1", pid: "p1", rid: "ro1", oat: claims.roundOpenedAt })
      .setProtectedHeader({ alg: "HS384", typ: "seazn-match-room" })
      .setExpirationTime("1h")
      .sign(authSecretKey());
    await expect(verifyMatchRoomToken(hs384)).rejects.toMatchObject({ code: "MATCH_ROOM_INVALID" });
  });

  it("mintMatchRoomToken rejects an unparseable roundOpenedAt", async () => {
    await expect(mintMatchRoomToken({ ...claims, roundOpenedAt: "not-a-date" })).rejects.toThrow(
      "mintMatchRoomToken: invalid roundOpenedAt",
    );
  });
});
