// Task 8 — the online-play lobby subscriber token. `lobby_fixture_id`, never
// `fixture_id`: V403's paid `fixture:{id}` score-channel policy reads
// `fixture_id`, so the two claim names must never collide (V407 SQL comment,
// `mintExternalPlayLobbyToken`'s own doc comment). `expiresAt` is the
// fixture's own the deadline, not a flat TTL.
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";
import { mintExternalPlayLobbyToken } from "../realtime";

describe("mintExternalPlayLobbyToken", () => {
  it("lobby token carries lobby_fixture_id and NOT fixture_id, expiring at the given deadline", async () => {
    // Force the HS256 shared-secret branch of resolveRealtimeMintKey
    // regardless of what a developer's own .env.local might set — see that
    // function's own doc comment for the SUPABASE_JWT_PRIVATE_KEY /
    // SUPABASE_JWT_SIGNING_KEY_B64 precedence this stubs around.
    vi.stubEnv("SUPABASE_JWT_PRIVATE_KEY", "");
    vi.stubEnv("SUPABASE_JWT_SIGNING_KEY_B64", "");
    vi.stubEnv("SUPABASE_JWT_SECRET", "x".repeat(40));
    vi.stubEnv("SUPABASE_JWT_ALG", "HS256");
    const deadline = new Date(Date.now() + 20 * 60_000);
    const claims = decodeJwt(await mintExternalPlayLobbyToken("f1", "person:p1", deadline));
    expect(claims.lobby_fixture_id).toBe("f1");
    expect("fixture_id" in claims).toBe(false);
    expect(claims.exp).toBe(Math.floor(deadline.getTime() / 1000));
    expect(claims.sub).toBe("person:p1");
  });
});
