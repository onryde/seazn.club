// G1 (design §6.6): job and page tokens sign with AUTH_SECRET through jose;
// SUPABASE_JWT_SECRET signs realtime subscriber tokens ONLY. This file is the
// wave's AUTHENTICATION boundary, so every security property below owns a case
// that FAILS when its check is deleted — wrong key, expiry, sid, scope,
// audience, algorithm, a missing exp, and hostile input — and every negative
// carries its positive twin, because a verifier that rejects everything passes
// every negative test in isolation.
//
// This test file NAMES SUPABASE_JWT_SECRET on purpose (the G1 witness signs
// with it). The P3 review probe excludes __tests__ and fails only on a
// production file naming it; the last `it` below pins tokens.ts from the other
// side.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SignJWT, decodeJwt, generateKeyPair } from "jose";
import {
  MAX_ANCHOR_DRIFT_SECONDS,
  mintRelayToken,
  relayTokenExpiry,
  verifyRelayToken,
  type RelayScope,
} from "../tokens";
import {
  MAX_DURATION_MINUTES,
  PROVISION_TIMEOUT_SECONDS,
  REQUESTED_TIMEOUT_SECONDS,
  TOKEN_GRACE_MINUTES,
  WARMING_TIMEOUT_MINUTES,
} from "../config";
import { deadlineOf } from "../domain/expiry";

// Both ≥ 64 bytes so the same literal can sign HS512 as well as HS256 — the
// algorithm-confusion case needs a key long enough for the bigger hash, or it
// fails for the wrong reason.
const AUTH = "auth-secret-for-relay-tokens-test-0123456789-0123456789-0123456789";
const SUPA = "supabase-secret-must-never-sign-relay-0123456789-0123456789-012345";

const saved = { a: process.env.AUTH_SECRET, s: process.env.SUPABASE_JWT_SECRET };
beforeAll(() => {
  process.env.AUTH_SECRET = AUTH;
  process.env.SUPABASE_JWT_SECRET = SUPA;
});
afterAll(() => {
  // `process.env.X = undefined` stores the STRING "undefined" and a later file
  // in this worker then reads a truthy bogus secret (carry C3).
  if (saved.a === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = saved.a;
  if (saved.s === undefined) delete process.env.SUPABASE_JWT_SECRET;
  else process.env.SUPABASE_JWT_SECRET = saved.s;
});

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER_SID = "99999999-2222-4333-8444-555555555555";
const AUDIENCE = "seazn-relay";
const CODE = "RELAY_TOKEN_INVALID";
const JOB = { sid: SID, scope: "relay-job" as RelayScope };
const PAGE = { sid: SID, scope: "relay-page" as RelayScope };
const future = () => new Date(Date.now() + 60_000);

/** Forge a token by hand — the only way to exercise a claim set or an
 *  algorithm that mintRelayToken will never produce. */
function forge(opts: {
  secret?: string;
  key?: CryptoKey;
  alg?: string;
  audience?: string | null;
  expiresIn?: number | null;
  claims?: Record<string, unknown>;
}): Promise<string> {
  let jwt = new SignJWT(opts.claims ?? { sid: SID, scope: "relay-job" })
    .setProtectedHeader({ alg: opts.alg ?? "HS256", typ: "JWT" })
    .setIssuedAt();
  if (opts.expiresIn !== null) jwt = jwt.setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expiresIn ?? 120));
  if (opts.audience !== null) jwt = jwt.setAudience(opts.audience ?? AUDIENCE);
  return jwt.sign(opts.key ?? new TextEncoder().encode(opts.secret ?? AUTH));
}

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** The rejection, or null when the call resolved. */
const refusalOf = async (p: Promise<unknown>): Promise<(Error & { status?: number; code?: string }) | null> =>
  p.then(
    () => null,
    (e: Error & { status?: number; code?: string }) => e,
  );

describe("relay tokens", () => {
  it("valid → claims (sid, scope, exp), for both scopes", async () => {
    const job = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: future() });
    const c = await verifyRelayToken(job, JOB);
    expect(c.sid).toBe(SID);
    expect(c.scope).toBe("relay-job");
    expect(c.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const page = await mintRelayToken({ sid: OTHER_SID, scope: "relay-page", expiresAt: future() });
    expect(await verifyRelayToken(page, { sid: OTHER_SID, scope: "relay-page" })).toMatchObject({
      sid: OTHER_SID,
      scope: "relay-page",
    });
  });

  it("a minted token carries exactly { aud, exp, iat, scope, sid } under alg HS256 — no secret, no spare claim", async () => {
    const t = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: future() });
    const payload = decodeJwt(t);
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "scope", "sid"]);
    expect(payload).toMatchObject({ sid: SID, scope: "relay-job", aud: AUDIENCE });
    // The wire format the Machine and the relay page receive: header pinned too,
    // so a mint that quietly moved to another algorithm is visible here.
    expect(JSON.parse(Buffer.from(t.split(".")[0]!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(t).not.toContain(AUTH);
  });

  it("tampered signature → 401 RELAY_TOKEN_INVALID (r4)", async () => {
    const t = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: future() });
    const [h, p, sig] = t.split(".");
    const bad = `${h}.${p}.${sig!.slice(0, -2)}${sig!.endsWith("AA") ? "BB" : "AA"}`;
    expect(bad).not.toBe(t);
    await expect(verifyRelayToken(bad, JOB)).rejects.toMatchObject({ status: 401, code: CODE });
    // Positive pair: the untampered token from the same mint still verifies.
    await expect(verifyRelayToken(t, JOB)).resolves.toMatchObject({ sid: SID });
  });

  it("expired → 401 (r4)", async () => {
    const t = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: new Date(Date.now() - 1000) });
    await expect(verifyRelayToken(t, JOB)).rejects.toMatchObject({ status: 401, code: CODE });
  });

  it("the expiry boundary: one second of life still verifies, and the instant exp arrives it does not", async () => {
    // jose refuses on `exp <= now` with zero clock tolerance (jwt_claims_set.js:154),
    // so the boundary is exact — and only deterministic on a frozen clock.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-13T10:00:00.000Z"));
      const t = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: new Date(Date.now() + 1000) });
      await expect(verifyRelayToken(t, JOB)).resolves.toMatchObject({ sid: SID });
      vi.setSystemTime(new Date("2026-09-13T10:00:01.000Z"));
      await expect(verifyRelayToken(t, JOB)).rejects.toMatchObject({ status: 401, code: CODE });
    } finally {
      vi.useRealTimers();
    }
  });

  it("wrong sid → 401: a token for session A cannot drive session B (r4)", async () => {
    const t = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: future() });
    await expect(verifyRelayToken(t, { sid: OTHER_SID, scope: "relay-job" })).rejects.toMatchObject({
      status: 401,
      code: CODE,
    });
    await expect(verifyRelayToken(t, JOB)).resolves.toMatchObject({ sid: SID });
  });

  it("wrong scope → 401 in BOTH directions (a page token cannot beat a heartbeat) (r4)", async () => {
    const page = await mintRelayToken({ sid: SID, scope: "relay-page", expiresAt: future() });
    await expect(verifyRelayToken(page, JOB)).rejects.toMatchObject({ status: 401, code: CODE });
    await expect(verifyRelayToken(page, PAGE)).resolves.toMatchObject({ scope: "relay-page" });

    const job = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: future() });
    await expect(verifyRelayToken(job, PAGE)).rejects.toMatchObject({ status: 401, code: CODE });
    await expect(verifyRelayToken(job, JOB)).resolves.toMatchObject({ scope: "relay-job" });
  });

  it("the G1 witness, three cases: another HMAC secret → 401, an ASYMMETRIC signer → 401, AUTH_SECRET → pass (r4)", async () => {
    // (a) the other signer that exists in this repo today. SUPABASE_JWT_SECRET
    //     signs realtime subscriber tokens ONLY.
    const supa = await forge({ secret: process.env.SUPABASE_JWT_SECRET });
    expect(process.env.SUPABASE_JWT_SECRET).not.toBe(process.env.AUTH_SECRET);
    await expect(verifyRelayToken(supa, JOB)).rejects.toMatchObject({ status: 401, code: CODE });

    // (b) a token whose `alg` this seam never expected, signed by a key we
    //     generate here — this case names no env var, so it survives #782
    //     moving the realtime token to an ES256/RS256 private key, and it is
    //     the one that would witness algorithm confusion.
    const { privateKey } = await generateKeyPair("ES256");
    const es = await forge({ alg: "ES256", key: privateKey });
    const err = await refusalOf(verifyRelayToken(es, JOB));
    expect(err).toMatchObject({ status: 401, code: CODE });

    // (c) the positive pair: without it, "reject everything" passes (a) and (b).
    const auth = await forge({ secret: process.env.AUTH_SECRET });
    await expect(verifyRelayToken(auth, JOB)).resolves.toMatchObject({ sid: SID, scope: "relay-job" });
  });

  it("algorithm confusion → 401: `alg: none` and an HS512 token signed with the REAL secret are both refused", async () => {
    const claims = { sid: SID, scope: "relay-job", aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 120 };
    const none = `${b64u({ alg: "none", typ: "JWT" })}.${b64u(claims)}.`;
    await expect(verifyRelayToken(none, JOB)).rejects.toMatchObject({ status: 401, code: CODE });

    const hs512 = await forge({ alg: "HS512" });
    await expect(verifyRelayToken(hs512, JOB)).rejects.toMatchObject({ status: 401, code: CODE });
    // Positive pair: the identical claims under HS256 pass, so the refusals
    // above are about the ALGORITHM and not about the claim set.
    await expect(verifyRelayToken(await forge({ alg: "HS256" }), JOB)).resolves.toMatchObject({ sid: SID });
  });

  it("wrong audience → 401: a token minted for another seam cannot be replayed here", async () => {
    await expect(verifyRelayToken(await forge({ audience: "authenticated" }), JOB)).rejects.toMatchObject({
      status: 401,
      code: CODE,
    });
    await expect(verifyRelayToken(await forge({ audience: null }), JOB)).rejects.toMatchObject({ status: 401 });
    await expect(verifyRelayToken(await forge({ audience: AUDIENCE }), JOB)).resolves.toMatchObject({ sid: SID });
  });

  it("no `exp` claim → 401: jose only checks an exp that is PRESENT, so a never-expiring token must die here", async () => {
    await expect(verifyRelayToken(await forge({ expiresIn: null }), JOB)).rejects.toMatchObject({
      status: 401,
      code: CODE,
    });
    await expect(verifyRelayToken(await forge({ expiresIn: 120 }), JOB)).resolves.toMatchObject({ sid: SID });
  });

  it("an unexpected claim shape → 401, never a partial accept (deny by default)", async () => {
    const shapes: Record<string, unknown>[] = [
      {},
      { scope: "relay-job" },
      { sid: SID },
      { sid: 12345, scope: "relay-job" },
      { sid: [SID], scope: "relay-job" },
      { sid: SID, scope: ["relay-job"] },
      { sid: SID, scope: "relay-admin" },
      { sid: `${SID} `, scope: "relay-job" },
    ];
    for (const claims of shapes) {
      const err = await refusalOf(verifyRelayToken(await forge({ claims }), JOB));
      expect(err, `claims ${JSON.stringify(claims)} must be refused`).toMatchObject({ status: 401, code: CODE });
    }
    await expect(verifyRelayToken(await forge({ claims: { sid: SID, scope: "relay-job" } }), JOB)).resolves.toMatchObject(
      { sid: SID },
    );
  });

  it("malformed / truncated / empty input → 401, never a crash or a 500", async () => {
    const good = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: future() });
    const hostile: string[] = [
      "",
      "   ",
      "abc",
      "a.b",
      "a.b.c",
      "..",
      "....",
      `${b64u({ alg: "HS256", typ: "JWT" })}.not-base64-json.${"A".repeat(43)}`,
      good.split(".").slice(0, 2).join("."),
      good.slice(0, 12),
      `${good}trailing`,
      good.replace(/\./g, ""),
      undefined as unknown as string,
      null as unknown as string,
      12345 as unknown as string,
    ];
    for (const token of hostile) {
      const err = await refusalOf(verifyRelayToken(token, JOB));
      expect(err, `input ${JSON.stringify(token)} must be refused`).toMatchObject({ status: 401, code: CODE });
    }
    await expect(verifyRelayToken(good, JOB)).resolves.toMatchObject({ sid: SID });
  });

  it("a refusal says the same thing every time and carries neither the token nor the secret", async () => {
    const good = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: future() });
    const expiredToken = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: new Date(Date.now() - 1000) });
    const refusals = await Promise.all([
      refusalOf(verifyRelayToken(expiredToken, JOB)),
      refusalOf(verifyRelayToken(good, { sid: OTHER_SID, scope: "relay-job" })),
      refusalOf(verifyRelayToken(good, PAGE)),
      refusalOf(verifyRelayToken(await forge({ secret: SUPA }), JOB)),
      refusalOf(verifyRelayToken("a.b.c", JOB)),
    ]);
    expect(refusals.every((e) => e !== null)).toBe(true);
    // One sentence for every class: a verifier that says WHICH check failed is
    // an oracle (carry C2).
    expect(new Set(refusals.map((e) => e!.message)).size).toBe(1);
    for (const err of refusals) {
      const text = `${err!.message} ${JSON.stringify(err)} ${err!.stack ?? ""}`;
      expect(text).not.toContain(AUTH);
      expect(text).not.toContain(SUPA);
      expect(text).not.toContain(good);
      expect(text).not.toContain(expiredToken);
    }
  });

  it("without AUTH_SECRET it refuses to sign or verify — and that refusal is NOT a 401", async () => {
    const good = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: future() });
    const restore = process.env.AUTH_SECRET;
    try {
      for (const bad of [undefined, ""]) {
        if (bad === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = bad;
        await expect(mintRelayToken({ sid: SID, scope: "relay-job", expiresAt: future() })).rejects.toThrow(
          /AUTH_SECRET/,
        );
        const err = await refusalOf(verifyRelayToken(good, JOB));
        expect(err).toBeInstanceOf(Error);
        // A missing secret is OUR fault, not a bad token: it must not be
        // disguised as a 401, or a config outage reads as "everyone's token
        // expired".
        expect(err!.status).toBeUndefined();
        expect(err!.code).toBeUndefined();
      }
    } finally {
      if (restore === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = restore;
    }
    await expect(verifyRelayToken(good, JOB)).resolves.toMatchObject({ sid: SID });
  });

  it("relayTokenExpiry = the session's OWN deadline + the token grace, agreeing with domain deadlineOf", () => {
    // The literals below are only legitimate while these two hold.
    expect(TOKEN_GRACE_MINUTES).toBe(30);
    expect(MAX_DURATION_MINUTES).toBe(300);
    const createdAt = new Date("2026-09-13T10:00:00.000Z");
    const unstarted = (maxDurationMinutes: number) => ({ createdAt, startedAt: null, maxDurationMinutes });
    expect(relayTokenExpiry(unstarted(300)).toISOString()).toBe("2026-09-13T15:30:00.000Z");
    // A 90-minute booking: the differential that kills "always the constant".
    expect(relayTokenExpiry(unstarted(90)).toISOString()).toBe("2026-09-13T12:00:00.000Z");
    // 0 is not "no time": deadlineOf reads a falsy max_duration as the default
    // (expiry.ts:28), and a token that expires before its own session's hard
    // stop kills a paid stream mid-flight.
    expect(relayTokenExpiry(unstarted(0)).toISOString()).toBe("2026-09-13T15:30:00.000Z");
    for (const maxDurationMinutes of [300, 90, 1, 0]) {
      expect(relayTokenExpiry(unstarted(maxDurationMinutes)).getTime(), `max_duration ${maxDurationMinutes}`).toBe(
        deadlineOf(unstarted(maxDurationMinutes)).getTime() + TOKEN_GRACE_MINUTES * 60_000,
      );
    }
  });

  it("the anchor is startedAt, NOT createdAt — a started session's token is minted off the start (I1)", () => {
    const createdAt = new Date("2026-09-13T10:00:00.000Z");
    const startedAt = new Date("2026-09-13T10:14:00.000Z");
    const started = { createdAt, startedAt, maxDurationMinutes: 300 };
    const asIfUnstarted = { ...started, startedAt: null };

    // The right answer DIFFERS from the wrong one's value, so this cannot be
    // satisfied by "a Date came back": anchoring on createdAt says 15:30, and
    // that token dies 14 minutes BEFORE the session it belongs to.
    expect(relayTokenExpiry(started).toISOString()).toBe("2026-09-13T15:44:00.000Z");
    expect(relayTokenExpiry(asIfUnstarted).toISOString()).toBe("2026-09-13T15:30:00.000Z");
    expect(relayTokenExpiry(started).getTime() - relayTokenExpiry(asIfUnstarted).getTime()).toBe(14 * 60_000);

    // …and whichever anchor applies, the gap to that session's own hard stop is
    // exactly the grace — derived from deadlineOf, not from the literals above.
    for (const s of [started, asIfUnstarted]) {
      expect(relayTokenExpiry(s).getTime() - deadlineOf(s).getTime()).toBe(TOKEN_GRACE_MINUTES * 60_000);
    }
  });

  it("the grace absorbs the whole admission→warming anchor drift, derived from config (failure class 20)", () => {
    // Derived from the constants, never a number typed here: raising any leg of
    // the ladder moves this test with it instead of leaving it asserting
    // yesterday's margin.
    expect(MAX_ANCHOR_DRIFT_SECONDS).toBe(
      REQUESTED_TIMEOUT_SECONDS + PROVISION_TIMEOUT_SECONDS + WARMING_TIMEOUT_MINUTES * 60,
    );
    // The margin itself, from the constants: the grace must cover the drift.
    expect(TOKEN_GRACE_MINUTES * 60).toBeGreaterThanOrEqual(MAX_ANCHOR_DRIFT_SECONDS);

    // Driven, not merely asserted. A job token is minted at `requested`, when
    // startedAt is still null, so it anchors on created_at — while the SAME
    // session's final deadline will anchor on started_at, up to the full drift
    // later. The token must still outlive it.
    const createdAt = new Date("2026-09-13T10:00:00.000Z");
    const atRequested = { createdAt, startedAt: null, maxDurationMinutes: 300 };
    const token = relayTokenExpiry(atRequested);
    const startedAsLateAsLegal = {
      ...atRequested,
      startedAt: new Date(createdAt.getTime() + MAX_ANCHOR_DRIFT_SECONDS * 1000),
    };
    expect(token.getTime()).toBeGreaterThanOrEqual(deadlineOf(startedAsLateAsLegal).getTime());

    // The boundary is real, not slack: one second past the grace is NOT covered.
    const startedPastTheGrace = {
      ...atRequested,
      startedAt: new Date(createdAt.getTime() + (TOKEN_GRACE_MINUTES * 60 + 1) * 1000),
    };
    expect(token.getTime()).toBeLessThan(deadlineOf(startedPastTheGrace).getTime());
  });

  it("a token minted at its own expiry is already dead — relayTokenExpiry feeds mint end to end", async () => {
    const expiresAt = relayTokenExpiry({ createdAt: new Date(), startedAt: null, maxDurationMinutes: 300 });
    const t = await mintRelayToken({ sid: SID, scope: "relay-job", expiresAt });
    const c = await verifyRelayToken(t, JOB);
    // 300 + 30 minutes of life, measured from the claims themselves.
    expect(c.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(329 * 60);
    expect(c.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(330 * 60);
  });

  it("tokens.ts never names SUPABASE_JWT_SECRET (P3, every review)", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../tokens.ts"), "utf8");
    expect(src).not.toContain("SUPABASE_JWT_SECRET");
    expect(src).toContain("AUTH_SECRET"); // present twin
  });
});
