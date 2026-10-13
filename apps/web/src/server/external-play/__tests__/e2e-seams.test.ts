// Task 17 — the two things the e2e runner must forge by hand, proven against
// the product's OWN readers, so a walkthrough can never green on a token the
// server would not accept (failure class 1: a fixture on both ends proves the
// fixture).
//
// 1. A player's Lichess token, sealed under LICHESS_TOKEN_KEK. The runner
//    cannot import relay/crypto.ts (`server-only`), so e2e/lichess-token-seal.ts
//    writes the envelope itself; the server opens it with `openPlayerToken`
//    before every Lichess call. The T14 kit's one-byte token is deliberately
//    unopenable — right for specs that must never reach Lichess, wrong for the
//    walkthrough, whose whole point is that the server does.
// 2. The personal match-room link. The invite email cannot be captured (no
//    mail provider in e2e), so e2e/match-room-link.ts mints it as invite.ts →
//    mintMatchRoomToken does, bound to the ROUND'S OPEN (T14), and the
//    product's `verifyMatchRoomToken` is the judge.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sealLichessTokenForE2e } from "../../../../e2e/lichess-token-seal";
import { mintMatchRoomLink } from "../../../../e2e/match-room-link";
import { verifyMatchRoomToken } from "@/server/usecases/match-room-token";
import { openPlayerToken } from "../secrets";
import { MATCH_ROOM_TOKEN_TTL_MS } from "../window";

afterEach(() => {
  vi.unstubAllEnvs();
});

const hexKek = () => randomBytes(32).toString("hex");

describe("e2e sealer — the server's openPlayerToken opens what the runner sealed", () => {
  it("round-trips through the product's reader, under the product's key name", async () => {
    const kek = hexKek();
    vi.stubEnv("LICHESS_TOKEN_KEK", kek);
    let checked = 0;
    for (const plain of ["lio_e2e_white", "lio_" + "x".repeat(64), "tok-ünïcødé"]) {
      const sealed = sealLichessTokenForE2e(plain);
      // The column is bytea: the row holds the raw envelope; the reader is
      // handed base64 (external-accounts.ts getLichessAccessToken).
      expect(await openPlayerToken(sealed.toString("base64")), plain).toBe(plain);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a different key cannot open it — the runner and server must share LICHESS_TOKEN_KEK", async () => {
    vi.stubEnv("LICHESS_TOKEN_KEK", hexKek());
    const sealed = sealLichessTokenForE2e("lio_e2e_white");
    vi.stubEnv("LICHESS_TOKEN_KEK", hexKek());
    await expect(openPlayerToken(sealed.toString("base64"))).rejects.toThrow();
  });

  it("two seals of the same token differ (fresh IVs and DEK), and both open", async () => {
    vi.stubEnv("LICHESS_TOKEN_KEK", hexKek());
    const a = sealLichessTokenForE2e("same");
    const b = sealLichessTokenForE2e("same");
    expect(a.equals(b)).toBe(false);
    expect(await openPlayerToken(a.toString("base64"))).toBe("same");
    expect(await openPlayerToken(b.toString("base64"))).toBe("same");
  });

  it("refuses to seal without a usable key, naming the variable — never a silent unopenable row", () => {
    for (const bad of ["", "abc", "z".repeat(64)]) {
      vi.stubEnv("LICHESS_TOKEN_KEK", bad);
      expect(() => sealLichessTokenForE2e("x"), JSON.stringify(bad)).toThrow(/LICHESS_TOKEN_KEK/);
    }
  });
});

describe("e2e room link — the product's verifier accepts what the runner minted", () => {
  const claims = () => ({ fixtureId: randomUUID(), personId: randomUUID(), roundOpenId: randomUUID() });

  it("verifies to the same claims, bound to the round open", async () => {
    vi.stubEnv("AUTH_SECRET", "e2e-seam-secret-0123456789");
    const c = claims();
    const openedAt = new Date(Date.now() - 60_000);
    const token = await mintMatchRoomLink({ ...c, openedAt });
    expect(await verifyMatchRoomToken(token)).toEqual({ ...c, roundOpenedAt: openedAt.toISOString() });
  });

  it("expires on the round open's clock, not on mint time", async () => {
    vi.stubEnv("AUTH_SECRET", "e2e-seam-secret-0123456789");
    const openedAt = new Date(Date.now() - MATCH_ROOM_TOKEN_TTL_MS - 60_000);
    const token = await mintMatchRoomLink({ ...claims(), openedAt });
    await expect(verifyMatchRoomToken(token)).rejects.toMatchObject({ code: "MATCH_ROOM_EXPIRED" });
  });

  it("a runner on a different AUTH_SECRET mints a link the server refuses", async () => {
    vi.stubEnv("AUTH_SECRET", "runner-secret-aaaaaaaaaaaa");
    const token = await mintMatchRoomLink({ ...claims(), openedAt: new Date() });
    vi.stubEnv("AUTH_SECRET", "server-secret-bbbbbbbbbbbb");
    await expect(verifyMatchRoomToken(token)).rejects.toMatchObject({ code: "MATCH_ROOM_INVALID" });
  });
});
