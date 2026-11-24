// Realtime push-nudges T0.1 — one mint helper, `mintRealtimeToken`, and one
// thin wrapper per token family. Each family keys its realtime.messages policy
// on ITS OWN claim, never a shared one (the V452 rule, design §1's table):
// a shared claim name would let one family's token join another family's
// topic. Header, `aud` and `role: authenticated` are the same for every
// family, and `exp` is the caller's own deadline, floored to the second.
//
// Every expected sub, claim name and exp below is written from the design's
// table and the frozen clock — never read back from the module.
//
// Sequence cases: a second call (another id carries only its own id); an
// empty input (a division token for no divisions); another surface (a capture
// token carries no fixture claim). After a withdrawal or void: N/A here — a
// mint holds no state, and a token cannot be revoked (its short TTL is the
// bound, design §1); the doors that decide whether to mint are later tasks.
//
// Applies to another sport: N/A (no sport rules).
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, type JWTPayload } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as realtime from "../realtime";

const SECRET = "x".repeat(40);
/** 2026-11-24T10:00:00.123Z — iat at this clock is 1795514400. */
const FROZEN_MS = 1795514400123;
const IAT = 1795514400;
/** 2026-11-24T10:20:00.999Z — floors to 1795515600 (rounding would give …601). */
const EXPIRES_AT = new Date(1795515600999);
const EXP = 1795515600;

type Family = {
  family: string;
  /** The family's one claim (design §1's table; fixture and lobby predate it). */
  claim: string;
  value: unknown;
  sub: string;
  exp: number;
  mint: () => Promise<string>;
};

/** The five families, as the design names them. Written here, never derived. */
const FAMILIES: Family[] = [
  {
    family: "public fixture",
    claim: "fixture_id",
    value: "fx-1",
    sub: "public:fx-1",
    exp: IAT + 3600, // the default TTL, `${ttl}s` from the mint's iat
    mint: () => realtime.mintPublicFixtureToken("fx-1"),
  },
  {
    family: "external-play lobby",
    claim: "lobby_fixture_id",
    value: "fx-1",
    sub: "person:p-1",
    exp: EXP,
    mint: () => realtime.mintExternalPlayLobbyToken("fx-1", "person:p-1", EXPIRES_AT),
  },
  {
    family: "capture",
    claim: "capture_pairing_id",
    value: "pr-1",
    sub: "capture:pr-1",
    exp: EXP,
    mint: () => realtime.mintCaptureToken("pr-1", EXPIRES_AT),
  },
  {
    family: "match day",
    claim: "md_code_id",
    value: "cd-1",
    sub: "md:cd-1",
    exp: EXP,
    mint: () => realtime.mintMatchDayToken("cd-1", EXPIRES_AT),
  },
  {
    family: "division",
    claim: "division_ids",
    value: ["dv-1", "dv-2"],
    sub: "public-competition:cp-1",
    exp: EXP,
    mint: () => realtime.mintDivisionToken("cp-1", ["dv-1", "dv-2"], EXPIRES_AT),
  },
];

/** Claims every family carries; anything else in a payload is a family claim. */
const COMMON = ["aud", "exp", "iat", "role", "sub"];

const verify = async (token: string) =>
  jwtVerify(token, new TextEncoder().encode(SECRET), { audience: "authenticated" });

/** The raw JSON of a token's payload segment, as it goes on the wire. */
const rawPayload = (token: string) => Buffer.from(token.split(".")[1]!, "base64url").toString("utf8");

describe("realtime token families", () => {
  beforeEach(() => {
    // Force the HS256 shared-secret branch whatever a developer's env holds
    // (resolveRealtimeMintKey's own precedence).
    vi.stubEnv("SUPABASE_JWT_PRIVATE_KEY", "");
    vi.stubEnv("SUPABASE_JWT_SIGNING_KEY_B64", "");
    vi.stubEnv("SUPABASE_JWT_SECRET", SECRET);
    vi.stubEnv("SUPABASE_JWT_ALG", "HS256");
    vi.stubEnv("SUPABASE_JWT_KID", "");
    vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_MS });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each(FAMILIES)("$family: sub, its one claim, aud, role, iat and exp — and nothing else", async (f) => {
    const { payload, protectedHeader } = await verify(await f.mint());
    expect(protectedHeader).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload).toStrictEqual({
      role: "authenticated",
      sub: f.sub,
      [f.claim]: f.value,
      iat: IAT,
      exp: f.exp,
      aud: "authenticated",
    });
  });

  it("claim-overlap sweep: each family keys on its own claim, and no two share one", async () => {
    const owners = new Map<string, string[]>();
    let checked = 0;
    for (const f of FAMILIES) {
      const { payload } = await verify(await f.mint());
      const own = Object.keys(payload).filter((k) => !COMMON.includes(k));
      expect(own, f.family).toEqual([f.claim]);
      for (const claim of own) owners.set(claim, [...(owners.get(claim) ?? []), f.family]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: all five families minted").toBe(5);
    expect(owners.size, "five families, five distinct claims").toBe(5);
    for (const [claim, families] of owners) expect(families, claim).toHaveLength(1);
    // The two claims that predate the table stay with their owners.
    expect(owners.get("fixture_id")).toEqual(["public fixture"]);
    expect(owners.get("lobby_fixture_id")).toEqual(["external-play lobby"]);
  });

  it("another surface: a capture token carries no fixture claim of either kind", async () => {
    const { payload } = await verify(await realtime.mintCaptureToken("pr-1", EXPIRES_AT));
    expect("fixture_id" in payload).toBe(false);
    expect("lobby_fixture_id" in payload).toBe(false);
  });

  it("division_ids is a JSON array on the wire — also for one division", async () => {
    const two = await realtime.mintDivisionToken("cp-1", ["dv-1", "dv-2"], EXPIRES_AT);
    expect(rawPayload(two)).toContain('"division_ids":["dv-1","dv-2"]');
    const one = await realtime.mintDivisionToken("cp-1", ["dv-1"], EXPIRES_AT);
    const { payload } = await verify(one);
    // V556's `?` operator matches only inside a jsonb ARRAY; a scalar would read nothing.
    expect(Array.isArray(payload.division_ids)).toBe(true);
    expect(payload.division_ids).toEqual(["dv-1"]);
  });

  it("empty input: a division token for no divisions is an empty array (it authorises no topic)", async () => {
    const { payload } = await verify(await realtime.mintDivisionToken("cp-1", [], EXPIRES_AT));
    expect(payload.division_ids).toEqual([]);
    expect(rawPayload(await realtime.mintDivisionToken("cp-1", [], EXPIRES_AT))).toContain('"division_ids":[]');
  });

  it("a second call for another id carries only its own id", async () => {
    const a = (await verify(await realtime.mintMatchDayToken("cd-1", EXPIRES_AT))).payload;
    const b = (await verify(await realtime.mintMatchDayToken("cd-2", EXPIRES_AT))).payload;
    expect([a.sub, a.md_code_id]).toEqual(["md:cd-1", "cd-1"]);
    expect([b.sub, b.md_code_id]).toEqual(["md:cd-2", "cd-2"]);
  });

  it("mintPublicFixtureToken keeps its `${ttl}s` lifetime: exp − iat is the ttl", async () => {
    const ttl60 = (await verify(await realtime.mintPublicFixtureToken("fx-1", 60))).payload as Required<JWTPayload>;
    expect([ttl60.iat, ttl60.exp]).toEqual([IAT, IAT + 60]);
    const dflt = (await verify(await realtime.mintPublicFixtureToken("fx-1"))).payload as Required<JWTPayload>;
    expect(dflt.exp - dflt.iat).toBe(3600);
  });

  it("an asymmetric key puts its kid in the header for a new family too", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk = { ...(await exportJWK(privateKey)), kid: "kid-capture", alg: "ES256" };
    const pub = { ...(await exportJWK(publicKey)), kid: "kid-capture", alg: "ES256" };
    vi.stubEnv("SUPABASE_JWT_PRIVATE_KEY", JSON.stringify(jwk));
    const token = await realtime.mintCaptureToken("pr-1", EXPIRES_AT);
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet({ keys: [pub] }), {
      audience: "authenticated",
    });
    expect(protectedHeader).toEqual({ alg: "ES256", typ: "JWT", kid: "kid-capture" });
    expect(payload.capture_pairing_id).toBe("pr-1");
  });

  // Review m2 (T1.1): a blank id names no pairing, code or division, and `'capture:' || ''` would bind a token to the
  // bare `capture:` topic. Each family refuses one — in its topic builder AND its mint — with a plain Error that names
  // the family, never a token.
  const BLANK = ["", " ", "\t\n"];
  const GUARDED: { family: string; topic: (id: string) => string; mint: (id: string) => Promise<string> }[] = [
    { family: "capture", topic: (id) => realtime.captureTopic(id), mint: (id) => realtime.mintCaptureToken(id, EXPIRES_AT) },
    { family: "match day", topic: (id) => realtime.matchDayTopic(id), mint: (id) => realtime.mintMatchDayToken(id, EXPIRES_AT) },
    {
      family: "division",
      topic: (id) => realtime.divisionTopic(id),
      mint: (id) => realtime.mintDivisionToken("cp-1", ["dv-1", id], EXPIRES_AT),
    },
  ];

  it.each(GUARDED)("$family: a blank id is refused by the topic builder and by the mint, naming the family", async (g) => {
    const named = new RegExp(`^Realtime ${g.family}: `);
    let checked = 0;
    for (const id of BLANK) {
      expect(() => g.topic(id), JSON.stringify(id)).toThrow(named);
      const err = await g.mint(id).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, `${JSON.stringify(id)} minted a token`).toBeInstanceOf(Error);
      expect((err as Error).message, JSON.stringify(id)).toMatch(named);
      expect((err as Error).message, "never a token").not.toMatch(/eyJ/);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every blank shape").toBe(BLANK.length);
    // The positive pair: a real id still builds and mints.
    expect(g.topic("x-1")).toMatch(/:x-1$/);
    await expect(g.mint("x-1")).resolves.toMatch(/^eyJ/);
  });

  it("a family claim may never set a claim the mint owns (role, sub, aud, the times, iss, jti)", async () => {
    // RFC 7519 §4.1's registered claims, plus `role` (what Supabase authorises on).
    const OWNED = ["role", "sub", "aud", "exp", "iat", "nbf", "iss", "jti"];
    let checked = 0;
    for (const claim of OWNED) {
      await expect(
        realtime.mintRealtimeToken({ sub: "s", claims: { [claim]: "service_role" }, expiresAt: EXPIRES_AT }),
        claim,
      ).rejects.toThrow(new RegExp(`claims may not set ${claim}\\b`));
      checked += 1;
    }
    expect(checked, "anti-vacuity: every owned claim").toBe(8);
  });
});
