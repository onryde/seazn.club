import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  PLAY_SCOPES,
  assertLichessConsentForPlay,
  getLichessAccessToken,
  getLichessLink,
  personHasLichessLink,
  unlinkLichess,
  upsertLichessLink,
} from "../external-accounts";

const HAS_DB = !!process.env.DATABASE_URL;
/** A Lichess id nobody else can hold. `(provider, external_user_id)` is
 *  globally unique in V432, so a fixed literal here passes once and then
 *  collides with the row the previous run left behind. */
const lid = (tag: string): string => `${tag}-${randomUUID().slice(0, 8)}`;
const newUser = async (tag: string): Promise<string> => {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${tag}-${randomUUID()}@test.local`}, 'T2 User', true) returning id`;
  return u!.id;
};

// Every case here seals a token, so every case needs the key; unlink revokes
// at Lichess, so every case stubs that call and the assertions below check it
// was (or was not) made with the OPENED token.
beforeEach(() => {
  vi.stubEnv("LICHESS_TOKEN_KEK", randomBytes(32).toString("hex"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("external-accounts — token at rest", () => {
  it("stores the token sealed, and the column never holds the plaintext", async () => {
    const userId = await newUser("seal");
    await upsertLichessLink(userId, {
      externalUserId: lid("lid-seal"), username: "Sealer",
      scopes: [...PLAY_SCOPES], token: "lio_plaintext_token",
    });
    const [row] = await sql<{ access_token_enc: Uint8Array; scopes: string[] }[]>`
      select access_token_enc, scopes from user_external_accounts where user_id = ${userId}`;
    expect(Buffer.from(row!.access_token_enc).includes("lio_plaintext_token")).toBe(false);
    expect(row!.scopes).toEqual(["board:play", "challenge:write"]);
    expect(await getLichessAccessToken(userId)).toBe("lio_plaintext_token");
  });

  it("records consent at link time, so a fresh link owes no re-consent", async () => {
    const userId = await newUser("consent");
    const externalUserId = lid("lid-consent");
    await upsertLichessLink(userId, {
      externalUserId, username: "Consenter",
      scopes: [...PLAY_SCOPES], token: "lio_t",
    });
    const link = await getLichessLink(userId);
    expect(link).toMatchObject({
      externalUserId, username: "Consenter",
      scopes: ["board:play", "challenge:write"],
    });
    expect(link!.consentedAt).toBeInstanceOf(Date);
    await expect(assertLichessConsentForPlay(userId)).resolves.toBeUndefined();
  });

  // Review Focus / §3.1: every player linked under the identity-only flow.
  it("a legacy identity-only row reads as consent-owed, and refuses play", async () => {
    const userId = await newUser("legacy");
    await sql`
      insert into user_external_accounts (user_id, provider, external_user_id, username)
      values (${userId}, 'lichess', ${`lid-legacy-${randomUUID().slice(0, 8)}`}, 'Legacy')`;
    const link = await getLichessLink(userId);
    expect(link!.consentedAt).toBeNull();
    expect(link!.scopes).toEqual([]);
    expect(await getLichessAccessToken(userId)).toBeNull();
    await expect(assertLichessConsentForPlay(userId)).rejects.toMatchObject({
      status: 422, code: "LICHESS_RECONSENT_REQUIRED",
    });
  });

  // A grant that predates board:play — linked, consented, wrong scopes. The
  // wrong answer differs from the right one by letting a move submission reach
  // Lichess and 401 mid-game instead of asking first.
  it("a consented row MISSING board:play still owes re-consent", async () => {
    const userId = await newUser("narrow");
    await upsertLichessLink(userId, {
      externalUserId: lid("lid-narrow"), username: "Narrow",
      scopes: ["challenge:write"], token: "lio_narrow",
    });
    await expect(assertLichessConsentForPlay(userId)).rejects.toMatchObject({
      status: 422, code: "LICHESS_RECONSENT_REQUIRED",
    });
  });

  // The OTHER half of the same `if`, which the legacy row above cannot reach:
  // scopes that look right with NO consent stamp — and therefore, by V432's
  // consent_token CHECK, no token to submit with either. Mutating the gate
  // proved it: dropping `consentedAt === null` left every other case green,
  // because a legacy row's empty scopes satisfied the second condition on its
  // own. Two guards covering for each other are each untested.
  it("a row carrying board:play with NO consent stamp still owes re-consent", async () => {
    const userId = await newUser("noconsent");
    await sql`
      insert into user_external_accounts (user_id, provider, external_user_id, username, scopes)
      values (${userId}, 'lichess', ${lid("lid-noconsent")}, 'NoConsent', ${["board:play"]})`;
    const link = await getLichessLink(userId);
    expect(link!.scopes).toEqual(["board:play"]);
    expect(link!.consentedAt).toBeNull();
    // No consent stamp means no stored token, so there is nothing to play with.
    expect(await getLichessAccessToken(userId)).toBeNull();
    await expect(assertLichessConsentForPlay(userId)).rejects.toMatchObject({
      status: 422, code: "LICHESS_RECONSENT_REQUIRED",
    });
  });

  it("no link at all refuses with the LINK code, not the re-consent code", async () => {
    const userId = await newUser("nolink");
    await expect(assertLichessConsentForPlay(userId)).rejects.toMatchObject({
      status: 422, code: "LICHESS_LINK_REQUIRED",
    });
    await expect(assertLichessConsentForPlay(null)).rejects.toMatchObject({
      status: 422, code: "LICHESS_LINK_REQUIRED",
    });
  });

  it("re-linking replaces the token and moves consent forward", async () => {
    const userId = await newUser("relink");
    const externalUserId = lid("lid-relink");
    await upsertLichessLink(userId, {
      externalUserId, username: "A",
      scopes: [...PLAY_SCOPES], token: "lio_first",
    });
    const first = (await getLichessLink(userId))!.consentedAt!;
    await new Promise((r) => setTimeout(r, 5));
    await upsertLichessLink(userId, {
      externalUserId, username: "A",
      scopes: [...PLAY_SCOPES], token: "lio_second",
    });
    expect(await getLichessAccessToken(userId)).toBe("lio_second");
    expect((await getLichessLink(userId))!.consentedAt!.getTime())
      .toBeGreaterThan(first.getTime());
  });

  it("unlink REVOKES at Lichess with the opened token, then deletes the row", async () => {
    const userId = await newUser("unlink");
    await upsertLichessLink(userId, {
      externalUserId: lid("lid-unlink"), username: "Leaver",
      scopes: [...PLAY_SCOPES], token: "lio_revoke_me",
    });
    await unlinkLichess(userId);
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const revoke = calls.find(([, i]) => i.method === "DELETE");
    expect(revoke, "no DELETE /api/token was sent").toBeDefined();
    expect(revoke![0]).toBe("https://lichess.org/api/token");
    expect(new Headers(revoke![1].headers).get("authorization")).toBe("Bearer lio_revoke_me");
    expect(await getLichessLink(userId)).toBeNull();
  });

  it("a revoke that FAILS still deletes the row — an orphaned grant is not a reason to keep ours", async () => {
    const userId = await newUser("revokefail");
    await upsertLichessLink(userId, {
      externalUserId: lid("lid-revokefail"), username: "Failer",
      scopes: [...PLAY_SCOPES], token: "lio_t",
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(unlinkLichess(userId)).resolves.toBeUndefined();
    expect(await getLichessLink(userId)).toBeNull();
  });

  it("unlinking a legacy row with no token sends no revoke at all", async () => {
    const userId = await newUser("legacyunlink");
    await sql`
      insert into user_external_accounts (user_id, provider, external_user_id, username)
      values (${userId}, 'lichess', ${`lid-lu-${randomUUID().slice(0, 8)}`}, 'Legacy')`;
    await unlinkLichess(userId);
    const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls;
    expect(calls).toEqual([]);
    expect(await getLichessLink(userId)).toBeNull();
  });

  it("unlinking a user with no link is a no-op, not a throw", async () => {
    await expect(unlinkLichess(await newUser("absent"))).resolves.toBeUndefined();
  });

  it("PLAY_SCOPES is what the design asks for, and the OAuth start sends exactly it", () => {
    expect([...PLAY_SCOPES]).toEqual(["board:play", "challenge:write"]);
  });
});

// The four claims this suite carried before the token landed, on the new
// signatures. They are not about the token, and they must keep holding.
describe.skipIf(!HAS_DB)("external-accounts — link identity", () => {
  it("upserts, gets, and unlinks a Lichess link", async () => {
    const suffix = randomUUID().slice(0, 8);
    const userId = await newUser(`lichess-${suffix}`);

    expect(await getLichessLink(userId)).toBeNull();

    await upsertLichessLink(userId, {
      externalUserId: `lid-${suffix}`,
      username: `Player${suffix}`,
      scopes: [...PLAY_SCOPES],
      token: "lio_t",
    });

    const linked = await getLichessLink(userId);
    expect(linked).toMatchObject({
      externalUserId: `lid-${suffix}`,
      username: `Player${suffix}`,
    });

    await upsertLichessLink(userId, {
      externalUserId: `lid-${suffix}`,
      username: `Renamed${suffix}`,
      scopes: [...PLAY_SCOPES],
      token: "lio_t",
    });
    expect((await getLichessLink(userId))?.username).toBe(`Renamed${suffix}`);

    await unlinkLichess(userId);
    expect(await getLichessLink(userId)).toBeNull();
  });

  it("personHasLichessLink is false when person has no user_id", async () => {
    const suffix = randomUUID().slice(0, 8);
    const userId = await newUser(`plh-${suffix}`);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${"PLH " + suffix}, ${"plh-" + suffix}, ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name)
      values (${orgId}, ${"Unlinked Person"}) returning id`;

    expect(await personHasLichessLink(orgId, personId)).toBe(false);
  });

  it("personHasLichessLink is true when linked user has Lichess", async () => {
    const suffix = randomUUID().slice(0, 8);
    const userId = await newUser(`plh2-${suffix}`);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${"PLH2 " + suffix}, ${"plh2-" + suffix}, ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${orgId}, ${"Linked Person"}, ${userId}) returning id`;

    expect(await personHasLichessLink(orgId, personId)).toBe(false);
    await upsertLichessLink(userId, {
      externalUserId: `lid2-${suffix}`,
      username: `U${suffix}`,
      scopes: [...PLAY_SCOPES],
      token: "lio_t",
    });
    expect(await personHasLichessLink(orgId, personId)).toBe(true);
  });

  // Fix round 1 (review): V432's SECOND unique constraint,
  // (provider, external_user_id) — a Lichess account can only ever be linked
  // to ONE Seazn user. Without a typed catch this surfaced as a raw,
  // uncaught 23505 (constraint user_external_accounts_provider_external_user_id_key).
  it("rejects linking an already-claimed Lichess account to a different user, and leaves the first link unchanged", async () => {
    const suffix = randomUUID().slice(0, 8);
    const userA = await newUser(`lichess-a-${suffix}`);
    const userB = await newUser(`lichess-b-${suffix}`);

    await upsertLichessLink(userA, {
      externalUserId: `shared-${suffix}`, username: "Shared",
      scopes: [...PLAY_SCOPES], token: "lio_a",
    });

    await expect(
      upsertLichessLink(userB, {
        externalUserId: `shared-${suffix}`, username: "Stolen",
        scopes: [...PLAY_SCOPES], token: "lio_b",
      }),
    ).rejects.toMatchObject({ code: "LICHESS_ALREADY_LINKED" });

    // First link untouched by the rejected attempt.
    expect(await getLichessLink(userA)).toMatchObject({
      externalUserId: `shared-${suffix}`,
      username: "Shared",
    });
    expect(await getLichessLink(userB)).toBeNull();
  });

  it("re-linking the SAME Lichess account to the SAME user stays idempotent", async () => {
    const suffix = randomUUID().slice(0, 8);
    const userId = await newUser(`lichess-idem-${suffix}`);

    await upsertLichessLink(userId, {
      externalUserId: `same-${suffix}`, username: "Same",
      scopes: [...PLAY_SCOPES], token: "lio_t",
    });
    await expect(
      upsertLichessLink(userId, {
        externalUserId: `same-${suffix}`, username: "SameRenamed",
        scopes: [...PLAY_SCOPES], token: "lio_t",
      }),
    ).resolves.toBeUndefined();

    expect((await getLichessLink(userId))?.username).toBe("SameRenamed");
  });
});
