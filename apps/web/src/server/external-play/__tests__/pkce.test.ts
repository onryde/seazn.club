// PKCE (RFC 7636) S256 challenge derivation — the Lichess OAuth flow is a
// public client (no client_secret), so the code_challenge/code_verifier pair
// is the only proof the token exchange is bound to the same party that
// started the /authorize redirect.
import { describe, expect, it } from "vitest";
import { pkceChallenge, pkceVerifier } from "../pkce";

describe("PKCE S256", () => {
  it("matches RFC 7636 Appendix B", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("verifier is 43+ url-safe chars and random", () => {
    const a = pkceVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pkceVerifier()).not.toBe(a);
  });
});
