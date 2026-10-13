import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import {
  PLAY_SCOPES,
  assertLichessConsentForPlay,
  getLichessAccessToken,
  getLichessLink,
  personHasLichessLink,
  unlinkLichess,
  upsertLichessLink,
} from "../external-accounts";
import { startLichessFixtureServer } from "../../../../e2e/lichess-fixture-server";
import { backendPid, pollWaitersBehind } from "../external-play/__tests__/_lock-waiters";

const HAS_DB = !!process.env.DATABASE_URL;
/** A Lichess id nobody else can hold. `(provider, external_user_id)` is
 *  globally unique in V439, so a fixed literal here passes once and then
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
// The error channel is spied on in every case, so a path that should stay
// quiet is asserted quiet — the positive pair of every "it was reported".
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("LICHESS_TOKEN_KEK", randomBytes(32).toString("hex"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every argument every log.error call received, as one string — the
 *  haystack a "never the token" assertion searches. */
const loggedText = (): string => JSON.stringify(errorSpy.mock.calls);

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
    expect(row!.scopes).toEqual(["board:play", "challenge:write", "challenge:read"]);
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
      scopes: ["board:play", "challenge:write", "challenge:read"],
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

  // Review T2-I3: the gate demanded the literal "board:play", so a consented
  // grant WITHOUT challenge:write passed — although White's token must create
  // the challenge (design §3.3) — and a PLAY_SCOPES that grew would never ask
  // anyone to re-consent. The scope list here is typed, not read from
  // PLAY_SCOPES: it is the grant an older consent screen would have produced.
  it("a consented row carrying board:play but NOT challenge:write still owes re-consent", async () => {
    const userId = await newUser("halfgrant");
    await upsertLichessLink(userId, {
      externalUserId: lid("lid-halfgrant"), username: "Half",
      scopes: ["board:play"], token: "lio_half",
    });
    const link = await getLichessLink(userId);
    expect(link!.scopes).toEqual(["board:play"]);
    expect(link!.consentedAt).not.toBeNull();
    await expect(assertLichessConsentForPlay(userId)).rejects.toMatchObject({
      status: 422, code: "LICHESS_RECONSENT_REQUIRED",
    });
  });

  // Spec §3.1 amended 2026-10-10 (Task 9 fix round 1): crash recovery lists
  // White's outgoing challenges, which needs `challenge:read`. Every link made
  // before the amendment carries exactly the two scopes below — typed, not
  // read from PLAY_SCOPES, because it is what the earlier consent screen
  // granted. It must be asked again, not let through to a recovery that 403s.
  it("a consented row carrying board:play + challenge:write but NOT challenge:read (the pre-amendment grant) owes re-consent", async () => {
    const userId = await newUser("preread");
    await upsertLichessLink(userId, {
      externalUserId: lid("lid-preread"), username: "PreRead",
      scopes: ["board:play", "challenge:write"], token: "lio_preread",
    });
    const link = await getLichessLink(userId);
    expect(link!.scopes).toEqual(["board:play", "challenge:write"]);
    expect(link!.consentedAt).not.toBeNull();
    await expect(assertLichessConsentForPlay(userId)).rejects.toMatchObject({
      status: 422, code: "LICHESS_RECONSENT_REQUIRED",
    });
  });

  // ...and the positive pair: the full grant, consented, plays.
  it("a consented row carrying the full grant passes the play gate", async () => {
    const userId = await newUser("fullgrant");
    await upsertLichessLink(userId, {
      externalUserId: lid("lid-fullgrant"), username: "Full",
      scopes: ["board:play", "challenge:write", "challenge:read"], token: "lio_full",
    });
    await expect(assertLichessConsentForPlay(userId)).resolves.toBeUndefined();
  });

  // The OTHER half of the same `if`, which the legacy row above cannot reach:
  // scopes that look right with NO consent stamp — and therefore, by V439's
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
    // A clean revoke is not an incident.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a revoke that FAILS still deletes the row — an orphaned grant is not a reason to keep ours", async () => {
    const userId = await newUser("revokefail");
    await upsertLichessLink(userId, {
      externalUserId: lid("lid-revokefail"), username: "Failer",
      scopes: [...PLAY_SCOPES], token: "lio_unreachable_token",
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(unlinkLichess(userId)).resolves.toBeUndefined();
    expect(await getLichessLink(userId)).toBeNull();
    // Review T2-I2: the grant is still live at Lichess — say so, by user id.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toEqual({ userId, reason: "revoke_unreachable" });
    expect(loggedText()).not.toContain("lio_unreachable_token");
  });

  it("a revoke Lichess REFUSES (non-2xx) still deletes the row, and is reported with its status", async () => {
    const userId = await newUser("revoke400");
    await upsertLichessLink(userId, {
      externalUserId: lid("lid-revoke400"), username: "Refused",
      scopes: [...PLAY_SCOPES], token: "lio_refused_token",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 400 })));
    await expect(unlinkLichess(userId)).resolves.toBeUndefined();
    expect(await getLichessLink(userId)).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toEqual({ userId, reason: "revoke_rejected", status: 400 });
    expect(loggedText()).not.toContain("lio_refused_token");
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
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("PLAY_SCOPES is what the design asks for, and the OAuth start sends exactly it", () => {
    // Spec §3.1 (amended 2026-10-10): move, create White's challenge, and
    // list White's challenges for crash recovery (Task 9, I2).
    expect([...PLAY_SCOPES]).toEqual(["board:play", "challenge:write", "challenge:read"]);
  });
});

// Review T2-I2: a row that HOLDS a token we cannot open — the KEK unset,
// rotated, or the ciphertext damaged — is a different fact from a row with no
// token. Each case below seals under key A and then reaches the open with the
// key changed, so the decrypt genuinely fails; nothing is mocked in crypto.
// Final review M-2: re-linking overwrote the sealed token and left the replaced grant live at Lichess — a move-capable
// token nobody holds any more. The re-link now revokes it, best effort, AFTER its own write commits: a re-link that
// fails (409 below) revokes nothing, so the grant still stored keeps working.
describe.skipIf(!HAS_DB)("external-accounts — a re-link revokes the grant it replaces (M-2)", () => {
  type Call = [string, RequestInit];
  const deletes = (): Call[] =>
    (fetch as unknown as { mock: { calls: Call[] } }).mock.calls.filter(([, i]) => i.method === "DELETE");
  const bearerOf = (c: Call) => new Headers(c[1].headers).get("authorization");
  const link = (userId: string, externalUserId: string, token: string) =>
    upsertLichessLink(userId, { externalUserId, username: "R", scopes: [...PLAY_SCOPES], token });

  it("revokes the OLD token at Lichess, once, after the new one is stored — and says nothing when it worked", async () => {
    const userId = await newUser("m2-relink");
    const account = lid("lid-m2");
    await link(userId, account, "lio_m2_old");
    expect(deletes(), "premise: a first link revokes nothing").toEqual([]);
    const storedAtRevoke: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      storedAtRevoke.push(await getLichessAccessToken(userId));
      return new Response(null, { status: 204 });
    }));
    await link(userId, account, "lio_m2_new");
    expect(deletes().map(bearerOf)).toEqual(["Bearer lio_m2_old"]);
    expect(deletes()[0]![0]).toBe("https://lichess.org/api/token");
    expect(storedAtRevoke, "the revoke runs after the new token is committed").toEqual(["lio_m2_new"]);
    expect(await getLichessAccessToken(userId)).toBe("lio_m2_new");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a re-link to a DIFFERENT Lichess account revokes the old account's grant too", async () => {
    const userId = await newUser("m2-other");
    await link(userId, lid("lid-m2a"), "lio_m2_a");
    await link(userId, lid("lid-m2b"), "lio_m2_b");
    expect(deletes().map(bearerOf)).toEqual(["Bearer lio_m2_a"]);
  });

  it("the SAME token re-stored is never revoked — it is the grant we keep", async () => {
    const userId = await newUser("m2-same");
    const account = lid("lid-m2s");
    await link(userId, account, "lio_m2_same");
    await link(userId, account, "lio_m2_same");
    expect(deletes()).toEqual([]);
    expect(await getLichessAccessToken(userId)).toBe("lio_m2_same");
  });

  it("a legacy identity-only row has no token to revoke: the re-link sends no DELETE", async () => {
    const userId = await newUser("m2-legacy");
    const account = lid("lid-m2l");
    await sql`
      insert into user_external_accounts (user_id, provider, external_user_id, username)
      values (${userId}, 'lichess', ${account}, 'Legacy')`;
    await link(userId, account, "lio_m2_fresh");
    expect(deletes()).toEqual([]);
    expect(await getLichessAccessToken(userId)).toBe("lio_m2_fresh");
  });

  it("a re-link REFUSED (the account is someone else's) revokes nothing: the grant still stored keeps working", async () => {
    const owner = await newUser("m2-owner");
    const shared = lid("lid-m2-shared");
    await link(owner, shared, "lio_m2_owner");
    const other = await newUser("m2-claimant");
    await link(other, lid("lid-m2-own"), "lio_m2_claimant_old");
    await expect(link(other, shared, "lio_m2_claimant_new")).rejects.toMatchObject({ code: "LICHESS_ALREADY_LINKED" });
    expect(deletes()).toEqual([]);
    expect(await getLichessAccessToken(other)).toBe("lio_m2_claimant_old");
  });

  it("a revoke that fails never blocks the re-link, and is reported by user id with its reason — never the token", async () => {
    const outcomes: [string, () => Promise<Response>, Record<string, unknown>][] = [
      ["unreachable", async () => { throw new Error("network down"); }, { reason: "revoke_unreachable" }],
      ["refused", async () => new Response(null, { status: 400 }), { reason: "revoke_rejected", status: 400 }],
    ];
    let checked = 0;
    for (const [tag, answer, logged] of outcomes) {
      errorSpy.mockClear();
      const userId = await newUser(`m2-${tag}`);
      const account = lid(`lid-m2-${tag}`);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
      await link(userId, account, `lio_m2_${tag}_old`);
      vi.stubGlobal("fetch", vi.fn(answer));
      await expect(link(userId, account, `lio_m2_${tag}_new`), tag).resolves.toBeUndefined();
      expect(await getLichessAccessToken(userId), tag).toBe(`lio_m2_${tag}_new`);
      expect(errorSpy, tag).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]![0], tag).toEqual({ userId, ...logged });
      expect(loggedText(), tag).not.toContain(`lio_m2_${tag}_old`);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("through the Lichess fixture (LICHESS_BASE_URL, as e2e runs): the re-link's revoke kills the old grant there and the new one plays; unlink then kills the new one", async () => {
    vi.unstubAllGlobals(); // the real fetch, to a real server
    const fx = await startLichessFixtureServer(0);
    try {
      vi.stubEnv("LICHESS_BASE_URL", fx.url);
      const userId = await newUser("m2-fixture");
      const account = lid("lid-m2-fx");
      fx.registerToken("lio_fx_old", account);
      fx.registerToken("lio_fx_new", account);
      const playing = async (token: string) =>
        (await fetch(`${fx.url}/api/account/playing`, { headers: { Authorization: `Bearer ${token}` } })).status;
      await link(userId, account, "lio_fx_old");
      expect([await playing("lio_fx_old"), await playing("lio_fx_new")], "premise: both grants live").toEqual([200, 200]);
      await link(userId, account, "lio_fx_new");
      expect(fx.calls.filter((c) => c.method === "DELETE").map((c) => [c.path, c.token])).toEqual([["/api/token", "lio_fx_old"]]);
      expect([await playing("lio_fx_old"), await playing("lio_fx_new")]).toEqual([401, 200]);
      await unlinkLichess(userId);
      expect(await playing("lio_fx_new"), "unlink revokes through the same base").toBe(401);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      await fx.close();
    }
  });

  it("two re-links at once each revoke the grant THEY replaced (the row lock): every token but the one left stored is revoked, none twice", async () => {
    const userId = await newUser("m2-race");
    const account = lid("lid-m2-race");
    await link(userId, account, "lio_race_0");
    // Staged, never raced at t=0: a holder takes the row lock, both re-links queue behind it, then it lets go.
    const holder = await sql.reserve();
    try {
      await holder`begin`;
      await holder`select 1 from user_external_accounts where user_id = ${userId} and provider = 'lichess' for update`;
      const holderPid = await backendPid(holder);
      let done = 0;
      const both = Promise.all(["lio_race_1", "lio_race_2"].map((t) => link(userId, account, t).finally(() => (done += 1))));
      expect(await pollWaitersBehind(holderPid, { atLeast: 2, finished: () => done > 0 }), "premise: both re-links wait on the holder").toBe(2);
      await holder`rollback`;
      await both;
    } finally {
      holder.release();
    }
    const stored = await getLichessAccessToken(userId);
    const revoked = deletes().map(bearerOf);
    expect(revoked, "one revoke per replaced grant").toHaveLength(2);
    expect(new Set(revoked).size, `none revoked twice: ${JSON.stringify(revoked)}`).toBe(2);
    expect(new Set([...revoked, `Bearer ${stored}`])).toEqual(new Set(["Bearer lio_race_0", "Bearer lio_race_1", "Bearer lio_race_2"]));
  });

  it("an old token we cannot open (KEK rotated) is reported, not sent: the re-link still stores the new one", async () => {
    const userId = await newUser("m2-rotated");
    const account = lid("lid-m2-rot");
    await link(userId, account, "lio_m2_rot_old");
    vi.stubEnv("LICHESS_TOKEN_KEK", randomBytes(32).toString("hex"));
    await link(userId, account, "lio_m2_rot_new");
    expect(deletes()).toEqual([]);
    expect(await getLichessAccessToken(userId)).toBe("lio_m2_rot_new");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toEqual({ userId, reason: "decrypt_failed" });
    expect(loggedText()).not.toContain("lio_m2_rot");
  });
});

describe.skipIf(!HAS_DB)("external-accounts — a stored token we cannot open", () => {
  const otherKey = (): string => randomBytes(32).toString("hex");

  async function linkedUnderKeyA(tag: string, token: string): Promise<string> {
    const userId = await newUser(tag);
    await upsertLichessLink(userId, {
      externalUserId: lid(`lid-${tag}`), username: tag,
      scopes: [...PLAY_SCOPES], token,
    });
    return userId;
  }

  // Play path: fail CLOSED, under its own code — never "re-link", which would
  // send a player round an OAuth trip that cannot fix an operator's key.
  it("play path, KEK ROTATED: refuses with LICHESS_TOKEN_UNAVAILABLE and reports decrypt_failed", async () => {
    const userId = await linkedUnderKeyA("rotated", "lio_rotated_secret");
    vi.stubEnv("LICHESS_TOKEN_KEK", otherKey());
    const err = await getLichessAccessToken(userId).then(
      () => { throw new Error("resolved — the accessor treated an unopenable token as playable"); },
      (e: unknown) => e as { status?: number; code?: string; message?: string },
    );
    expect(err).toMatchObject({ status: 503, code: "LICHESS_TOKEN_UNAVAILABLE" });
    expect(err.message).not.toMatch(/re-?link/i);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toEqual({ userId, reason: "decrypt_failed" });
    expect(loggedText()).not.toContain("lio_rotated_secret");
  });

  it("play path, KEK UNSET: refuses with LICHESS_TOKEN_UNAVAILABLE and reports key_unavailable", async () => {
    const userId = await linkedUnderKeyA("unset", "lio_unset_secret");
    vi.stubEnv("LICHESS_TOKEN_KEK", "");
    await expect(getLichessAccessToken(userId)).rejects.toMatchObject({
      status: 503, code: "LICHESS_TOKEN_UNAVAILABLE",
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toEqual({ userId, reason: "key_unavailable" });
    expect(loggedText()).not.toContain("lio_unset_secret");
  });

  // The link itself is untouched by a refused open: the row stays, so fixing
  // the key restores play without the player doing anything.
  it("play path: the refusal leaves the link in place, and the right key opens it again", async () => {
    const key = randomBytes(32).toString("hex");
    vi.stubEnv("LICHESS_TOKEN_KEK", key);
    const userId = await linkedUnderKeyA("restore", "lio_restore_secret");
    vi.stubEnv("LICHESS_TOKEN_KEK", otherKey());
    await expect(getLichessAccessToken(userId)).rejects.toMatchObject({ code: "LICHESS_TOKEN_UNAVAILABLE" });
    vi.stubEnv("LICHESS_TOKEN_KEK", key);
    expect(await getLichessAccessToken(userId)).toBe("lio_restore_secret");
  });

  // Unlink path: honour the unlink — delete our row — but do not do it
  // silently: the grant could not be revoked and is still live at Lichess.
  it("unlink path, KEK ROTATED: deletes the row, sends no revoke, and reports it by user id", async () => {
    const userId = await linkedUnderKeyA("unlinkrot", "lio_unlink_rotated");
    vi.stubEnv("LICHESS_TOKEN_KEK", otherKey());
    await expect(unlinkLichess(userId)).resolves.toBeUndefined();
    expect(await getLichessLink(userId)).toBeNull();
    const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls;
    expect(calls).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toEqual({ userId, reason: "decrypt_failed" });
    expect(loggedText()).not.toContain("lio_unlink_rotated");
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

  // Fix round 1 (review): V439's SECOND unique constraint,
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
