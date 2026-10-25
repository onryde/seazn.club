import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, withTenant, type Tx } from "@/lib/db";
import { log } from "@/server/logger";
import {
  LICHESS_TOKEN_TEST_TIMEOUT_MS,
  PLAY_SCOPES,
  assertLichessConsentForPlay,
  assertPersonIdsLinkedForOnlinePlay,
  getLichessAccessToken,
  getLichessLink,
  lichessGrantDowngraded,
  lichessGrantPlays,
  lichessLinkStatesByPerson,
  type LichessLinkState,
  unlinkLichess,
  upsertLichessLink,
} from "../external-accounts";
import { startLichessFixtureServer } from "../../../../e2e/lichess-fixture-server";
import { backendPid, pollWaitersBehind } from "../external-play/__tests__/_lock-waiters";
import { LICHESS_TIMEOUT_MS } from "@/server/external-play/window";

const HAS_DB = !!process.env.DATABASE_URL;
/** A Lichess id nobody else can hold. `(provider, external_user_id)` is
 *  globally unique in V451, so a fixed literal here passes once and then
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
  // scopes that look right with NO consent stamp — and therefore, by V451's
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

// Final review P10: a grant the player narrowed or revoked AT lichess.org is unknown to our row until an act spends
// it. The room asks Lichess once per page load (POST /api/token/test) and shows the re-link screen at once. Through the
// Lichess fixture, as e2e runs (LICHESS_BASE_URL, the real fetch).
describe.skipIf(!HAS_DB)("external-accounts — Lichess's word on a stored grant (P10)", () => {
  let fx: Awaited<ReturnType<typeof startLichessFixtureServer>>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    vi.unstubAllGlobals(); // the real fetch, to a real server
    fx = await startLichessFixtureServer(0);
    vi.stubEnv("LICHESS_BASE_URL", fx.url);
    warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await fx.close();
  });
  const tokenTests = () => fx.calls.filter((c) => c.path === "/api/token/test");
  async function linked(tag: string, token: string, scopes: readonly string[] = PLAY_SCOPES): Promise<string> {
    const userId = await newUser(tag);
    const account = lid(`lid-${tag}`);
    await upsertLichessLink(userId, { externalUserId: account, username: tag, scopes: [...scopes], token });
    fx.registerToken(token, account);
    return userId;
  }

  it("the grant as Lichess holds it: every play scope ⇒ not downgraded; one scope narrowed away at lichess.org, or the token revoked there ⇒ downgraded — one ask each, no bearer, the token in the body", async () => {
    const cases: [string, (token: string) => void, boolean][] = [
      ["intact", () => undefined, false],
      ["board:play narrowed away", (t) => fx.setTokenScopes(t, PLAY_SCOPES.filter((x) => x !== "board:play")), true],
      ["challenge:read narrowed away", (t) => fx.setTokenScopes(t, PLAY_SCOPES.filter((x) => x !== "challenge:read")), true],
      ["revoked at Lichess", (t) => fx.revokeToken(t), true],
    ];
    let checked = 0;
    for (const [label, narrow, downgraded] of cases) {
      const token = `lio_p10_${checked}_${randomUUID().slice(0, 6)}`;
      const userId = await linked(`p10-${checked}`, token);
      narrow(token);
      const before = tokenTests().length;
      expect(await lichessGrantDowngraded(userId), label).toBe(downgraded);
      const asked = tokenTests().slice(before);
      expect(asked.map((c) => [c.method, c.token]), label).toEqual([["POST", null]]);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
    expect(PLAY_SCOPES.length, "premise: the scopes swept above are the grant's").toBe(3);
  });

  it("our row already refuses (no link, a grant short of a scope) or no user: false, and Lichess is not asked — the seat and the act refuse those by name", async () => {
    const unlinked = await newUser("p10-none");
    const short = await linked("p10-short", `lio_p10_short_${randomUUID().slice(0, 6)}`, ["board:play"]);
    let checked = 0;
    for (const userId of [null, unlinked, short]) {
      expect(await lichessGrantDowngraded(userId), String(userId)).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(3);
    expect(tokenTests()).toEqual([]);
  });

  it("Lichess does not answer (unreachable, a 5xx, a 429, a body without the token): false — never a re-link screen on a hiccup — and logged without the token", async () => {
    const token = `lio_p10_down_${randomUUID().slice(0, 6)}`;
    const userId = await linked("p10-down", token);
    const answers: [string, () => Promise<Response>][] = [
      ["unreachable", async () => { throw new TypeError("fetch failed"); }],
      ["503", async () => new Response("down", { status: 503 })],
      ["429", async () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 })],
      ["no entry", async () => new Response(JSON.stringify({}), { status: 200 })],
      ["not json", async () => new Response("<html>", { status: 200 })],
    ];
    let checked = 0;
    for (const [label, answer] of answers) {
      vi.stubGlobal("fetch", vi.fn(answer));
      warnSpy.mockClear();
      expect(await lichessGrantDowngraded(userId), label).toBe(false);
      expect(warnSpy, label).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0], label).toMatchObject({ userId });
      expect(JSON.stringify(warnSpy.mock.calls), label).not.toContain(token);
      checked += 1;
    }
    expect(checked).toBe(answers.length);
  });

  // Final re-review N-3: the room page waits on this check as it renders, so a Lichess that does not answer may hold
  // it for 2 s at most (the ruling's cap), never the 10 s every other Lichess call is given. On the cap it reads
  // false — the room renders as before P10, and the first act learns the truth.
  it("N-3: a Lichess that goes silent — before the headers, or after them mid-body — is waited on for 2 s at most, then reads false, logged as a timeout", async () => {
    expect(LICHESS_TOKEN_TEST_TIMEOUT_MS, "the ruling: a 2 s cap").toBe(2_000);
    expect(LICHESS_TIMEOUT_MS, "premise: the cap is shorter than every other Lichess call's").toBeGreaterThan(LICHESS_TOKEN_TEST_TIMEOUT_MS);
    const token = `lio_p10_silent_${randomUUID().slice(0, 6)}`;
    const userId = await linked("p10-silent", token);
    /** Rejects with the signal's reason when it aborts, and never settles otherwise. */
    const onAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const silences: [string, (signal: AbortSignal) => Promise<Response>][] = [
      ["no headers", (signal) => onAbort(signal)],
      [
        "headers, then a body that never ends",
        async (signal) =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(`{"${token}":`));
                signal.addEventListener("abort", () => c.error(signal.reason));
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ],
    ];
    let checked = 0;
    for (const [label, silence] of silences) {
      const signals: AbortSignal[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
        signals.push(init!.signal!);
        return silence(init!.signal!);
      }));
      warnSpy.mockClear();
      const t0 = performance.now();
      expect(await lichessGrantDowngraded(userId), label).toBe(false);
      const waited = performance.now() - t0;
      expect(signals, `${label}: asked once`).toHaveLength(1);
      expect([signals[0]!.aborted, (signals[0]!.reason as Error).name], `${label}: the cap fired`).toEqual([true, "TimeoutError"]);
      expect(waited, `${label}: waited out the cap`).toBeGreaterThanOrEqual(LICHESS_TOKEN_TEST_TIMEOUT_MS - 5);
      expect(waited, `${label}: never the 10 s of the other calls`).toBeLessThan(LICHESS_TIMEOUT_MS);
      expect((warnSpy.mock.calls as unknown[][]).map((c) => c[0]), label).toEqual([{ userId, reason: "timeout" }]);
      checked += 1;
    }
    expect(checked).toBe(silences.length);
  });

  it("a stored token we cannot open is not the player's grant: false, nothing asked", async () => {
    const userId = await linked("p10-kek", `lio_p10_kek_${randomUUID().slice(0, 6)}`);
    vi.stubEnv("LICHESS_TOKEN_KEK", randomBytes(32).toString("hex"));
    expect(await lichessGrantDowngraded(userId)).toBe(false);
    expect(tokenTests()).toEqual([]);
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

  // Fix round 1 (review): V451's SECOND unique constraint,
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

// The organiser's roster demand (createEntrants on an online division) asks "does every rostered person hold a Lichess
// link?" ONCE per transaction, on the transaction's own connection, as a set — not person by person through the pool.
// `user_external_accounts` is sealed from `app_user` (V451: FORCE RLS, no grant), so the read has to happen before the
// role drops: `withTenant`'s `privilegedPrelude`.
describe.skipIf(!HAS_DB)("external-accounts — the roster's link set", () => {
  /** An org with one person per case the set has to tell apart. */
  async function seedOrgWithPeople(tag: string) {
    const suffix = randomUUID().slice(0, 8);
    const ownerId = await newUser(`${tag}-owner-${suffix}`);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${`${tag} ${suffix}`}, ${`${tag}-${suffix}`}, ${ownerId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
    const person = async (name: string, userId: string | null, org: string = orgId): Promise<string> => {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name, user_id) values (${org}, ${name}, ${userId}) returning id`;
      return id;
    };
    const link = (userId: string, scopes: string[] = [...PLAY_SCOPES]) =>
      upsertLichessLink(userId, { externalUserId: lid(tag), username: tag, scopes, token: "lio_t" });
    /** A person whose own user holds a Lichess link. */
    const linkedPerson = async (name: string): Promise<string> => {
      const userId = await newUser(`${tag}-${name.replaceAll(" ", "")}-${suffix}`);
      await link(userId);
      return person(name, userId);
    };
    return { suffix, orgId, person, link, linkedPerson };
  }

  /** The oracle the set must agree with, person by person: the question asked the long way round, as two privileged
   *  reads (the person's user, then that user's Lichess row) — not the join the set is written as. */
  async function linkedTheLongWay(personId: string): Promise<boolean> {
    const [person] = await sql<{ user_id: string | null }[]>`select user_id from persons where id = ${personId}`;
    if (!person?.user_id) return false;
    return (await getLichessLink(person.user_id)) !== null;
  }

  /** Who holds a Lichess row, as a set: the keys of the states map, the ONE reader (a "linked" person is a stored row,
   *  whatever it stores; what the row lets them do is the map's value, swept in the next describe). */
  const linkedSet = async (orgId: string, ids?: readonly string[]): Promise<Set<string>> =>
    new Set((await sql.begin((tx) => lichessLinkStatesByPerson(tx, orgId, ids))).keys());

  it("holds exactly the org's persons whose user has a Lichess row — and agrees with the long way round on every one", async () => {
    const o = await seedOrgWithPeople("set");
    const linkedUser = await newUser(`set-linked-${o.suffix}`);
    await o.link(linkedUser);
    const unlinkedUser = await newUser(`set-unlinked-${o.suffix}`);
    // A legacy identity-only row (no token, no consent): linked for REGISTRATION, which is what this demand is.
    const legacyUser = await newUser(`set-legacy-${o.suffix}`);
    await sql`
      insert into user_external_accounts (user_id, provider, external_user_id, username)
      values (${legacyUser}, 'lichess', ${lid("lid-legacy")}, 'Legacy')`;
    // A SECOND org holding a person of the same linked user: must not appear in the first org's set.
    const other = await seedOrgWithPeople("other");
    const otherOrgPerson = await other.person("Same user, other org", linkedUser);

    const people = {
      linked: await o.person("Linked", linkedUser),
      legacy: await o.person("Legacy", legacyUser),
      unlinked: await o.person("Unlinked user", unlinkedUser),
      noUser: await o.person("No user", null),
    };

    const set = await linkedSet(o.orgId);

    expect([...set].sort()).toEqual([people.linked, people.legacy].sort());
    expect(set.has(otherOrgPerson), "another org's person is not in this org's set").toBe(false);
    let checked = 0;
    for (const id of Object.values(people)) {
      expect(set.has(id), id).toBe(await linkedTheLongWay(id));
      checked++;
    }
    expect(checked, "anti-vacuity: persons compared").toBe(4);
    expect(set.size, "premise: the set is not empty").toBeGreaterThan(0);
  });

  it("is empty for an org nobody has linked — the empty case answers no to everyone", async () => {
    const o = await seedOrgWithPeople("empty");
    const user = await newUser(`empty-user-${o.suffix}`);
    const p = await o.person("Unlinked", user);

    const set = await linkedSet(o.orgId);

    expect(set.size).toBe(0);
    expect(set.has(p)).toBe(false);
  });

  it("follows a link and an unlink: the same person enters the next set, then drops out of the one after", async () => {
    const o = await seedOrgWithPeople("unlink");
    const user = await newUser(`unlink-user-${o.suffix}`);
    const p = await o.person("Linked then not", user);
    // A user with a person but no Lichess row yet is not in the set; the link brings the person in.
    expect((await linkedSet(o.orgId)).has(p)).toBe(false);
    await o.link(user);
    expect((await linkedSet(o.orgId)).has(p)).toBe(true);

    await unlinkLichess(user);

    expect((await linkedSet(o.orgId)).has(p)).toBe(false);
  });

  // Scoped to the persons a roster NAMES: the answer for those and no one else. Used when the roster is known up
  // front (explicit members), so a big org's whole linked list is not read to answer for one player.
  it("scoped to person ids: holds only the named persons who are linked", async () => {
    const o = await seedOrgWithPeople("scope");
    const linkedA = await o.linkedPerson("Linked A");
    const linkedB = await o.linkedPerson("Linked B");
    const unlinked = await o.person("Unlinked", await newUser(`scope-u-${o.suffix}`));
    // Another org's linked person, named explicitly: the org scope still applies to a named id.
    const other = await seedOrgWithPeople("scope-other");
    const foreign = await other.linkedPerson("Foreign linked");
    const read = (ids?: readonly string[]) => linkedSet(o.orgId, ids);

    expect([...(await read())].sort(), "premise: unscoped is the whole org").toEqual([linkedA, linkedB].sort());
    expect([...(await read([linkedA]))]).toEqual([linkedA]);
    expect([...(await read([linkedA, unlinked]))], "a named person who is not linked is absent").toEqual([linkedA]);
    expect([...(await read([unlinked]))]).toEqual([]);
    expect([...(await read([]))], "naming nobody asks about nobody").toEqual([]);
    expect([...(await read([foreign]))], "a named id of another org's person").toEqual([]);
    expect([...(await read([linkedA, linkedB, linkedA]))].sort(), "a repeated id answers once").toEqual([linkedA, linkedB].sort());
  });

  // WHY a prelude and not the ambient `tx`: after `set local role app_user` the sealed table is unreadable. If this
  // ever stops being true (a grant is added), the prelude is no longer required and this pin names that change.
  it("cannot be read through a tenant transaction — the table is sealed from app_user", async () => {
    const o = await seedOrgWithPeople("sealed");

    await expect(withTenant(o.orgId, (tx) => lichessLinkStatesByPerson(tx, o.orgId))).rejects.toMatchObject({
      code: "42501", // insufficient_privilege
    });
  });

  it("is read by withTenant's privilegedPrelude on the transaction's own connection, then used inside it", async () => {
    const o = await seedOrgWithPeople("prelude");
    const user = await newUser(`prelude-user-${o.suffix}`);
    await o.link(user);
    const p = await o.person("Linked", user);
    let loaded: ReadonlyMap<string, LichessLinkState> | null = null;
    let preludePid: number | null = null;
    let preludeRole: string | null = null;

    const seen = await withTenant(
      o.orgId,
      async (tx: Tx) => {
        const [{ pid, role }] = await tx<{ pid: number; role: string }[]>`
          select pg_backend_pid() as pid, current_user as role`;
        return { pid, role, has: loaded?.has(p) ?? false };
      },
      {
        privilegedPrelude: async (ptx) => {
          [{ pid: preludePid, role: preludeRole }] = await ptx<{ pid: number; role: string }[]>`
            select pg_backend_pid() as pid, current_user as role`;
          loaded = await lichessLinkStatesByPerson(ptx, o.orgId);
        },
      },
    );

    expect(seen.has, "the set read in the prelude is the one the transaction uses").toBe(true);
    expect(preludePid, "premise: the prelude ran").not.toBeNull();
    expect(seen.pid, "ONE connection: the prelude read is not a second checkout").toBe(preludePid);
    // THE SECURITY PIN. A prelude may read what the tenant role cannot, but the callback it precedes must still run
    // as the tenant role — otherwise every RLS policy is off for the whole transaction the moment a prelude is given.
    expect(preludeRole, "premise: the prelude is privileged — it is not the tenant role").not.toBe("app_user");
    expect(seen.role, "the callback runs as app_user whenever a prelude was given").toBe("app_user");
  });
});

// What a roster's links LET each person do, not just whether they exist: the registration gate refuses exactly what the
// seat gate refuses (`lichessGrantPlays`, owner 2026-10-25), so it needs each person's state - plays / reconnect / no
// link - from the one reader, `lichessLinkStatesByPerson`. Expected states are derived from PLAY_SCOPES (the declared
// play grant), never from a table of scope names typed here.
describe.skipIf(!HAS_DB)("external-accounts — the roster's link states", () => {
  async function seedOrg(tag: string) {
    const suffix = randomUUID().slice(0, 8);
    const ownerId = await newUser(`${tag}-owner-${suffix}`);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${`${tag} ${suffix}`}, ${`${tag}-${suffix}`}, ${ownerId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
    const person = async (name: string, userId: string | null, org: string = orgId): Promise<string> => {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name, user_id) values (${org}, ${name}, ${userId}) returning id`;
      return id;
    };
    const user = (name: string) => newUser(`${tag}-${name.replaceAll(" ", "")}-${suffix}`);
    const grant = (userId: string, scopes: string[], consented = true) =>
      consented
        ? upsertLichessLink(userId, { externalUserId: lid(tag), username: tag, scopes, token: "lio_t" })
        : sql`insert into user_external_accounts (user_id, provider, external_user_id, username, scopes)
              values (${userId}, 'lichess', ${lid(tag)}, ${tag}, ${scopes})`;
    return { orgId, person, user, grant };
  }
  const states = (orgId: string, ids?: readonly string[]) => sql.begin((tx) => lichessLinkStatesByPerson(tx, orgId, ids));

  it("says plays / reconnect for each person by what their stored grant is, and nothing for a person with no link", async () => {
    const o = await seedOrg("states");
    const want = new Map<string, LichessLinkState | "absent">();
    const add = async (name: string, state: LichessLinkState | "absent", setup: (userId: string) => Promise<unknown>) => {
      const userId = await o.user(name);
      await setup(userId);
      want.set(await o.person(name, userId), state);
    };

    await add("Full grant", "plays", (u) => o.grant(u, [...PLAY_SCOPES]));
    await add("Identity only", "reconnect", (u) =>
      sql`insert into user_external_accounts (user_id, provider, external_user_id, username)
          values (${u}, 'lichess', ${lid("states-idonly")}, 'Legacy')`);
    // The scopes look right but the consent stamp is missing - and so is the token (V451's consent_token CHECK).
    await add("Scopes, no consent", "reconnect", (u) => o.grant(u, [...PLAY_SCOPES], false));
    // One case per declared play scope: the grant that has every scope BUT that one still owes a reconnect.
    for (const dropped of PLAY_SCOPES) {
      await add(`Without ${dropped}`, "reconnect", (u) => o.grant(u, PLAY_SCOPES.filter((x) => x !== dropped)));
    }
    // A grant wider than the play grant plays (extra scopes are not a reason to refuse).
    await add("Wider grant", "plays", (u) => o.grant(u, [...PLAY_SCOPES, "email:read"]));
    await add("User, no link", "absent", async () => undefined);
    want.set(await o.person("No user", null), "absent");
    // The same linked user in ANOTHER org: not this org's.
    const other = await seedOrg("states-other");
    const otherUser = await other.user("Other full");
    await other.grant(otherUser, [...PLAY_SCOPES]);
    const foreign = await other.person("Other org person", otherUser);

    const got = await states(o.orgId);

    let checked = 0;
    for (const [id, state] of want) {
      expect(got.get(id) ?? "absent", id).toBe(state);
      checked++;
    }
    expect(checked, "anti-vacuity: persons compared").toBe(want.size);
    expect(want.size, "premise: every scope has its own case, plus 6 fixed ones").toBe(PLAY_SCOPES.length + 6);
    expect([...want.values()].filter((v) => v === "reconnect").length, "premise: identity-only, no-consent, and one per dropped scope").toBe(PLAY_SCOPES.length + 2);
    expect([...want.values()].filter((v) => v === "plays").length, "premise: the passing side is not empty").toBe(2);
    expect(got.has(foreign), "another org's person is not answered for").toBe(false);
    expect(got.size, "only the linked persons are in the map").toBe([...want.values()].filter((v) => v !== "absent").length);
  });

  it("scoped to person ids: answers for the named persons only, and for no one when none are named", async () => {
    const o = await seedOrg("scope");
    const mk = async (name: string, scopes: string[]) => {
      const u = await o.user(name);
      await o.grant(u, scopes);
      return o.person(name, u);
    };
    const plays = await mk("Plays", [...PLAY_SCOPES]);
    const narrow = await mk("Narrow", PLAY_SCOPES.slice(1));
    const bystander = await mk("Bystander", [...PLAY_SCOPES]);

    expect(Object.fromEntries(await states(o.orgId, [plays, narrow])), "named people, each with their state").toEqual({
      [plays]: "plays",
      [narrow]: "reconnect",
    });
    expect((await states(o.orgId, [narrow])).get(bystander), "a person not named is not answered for").toBeUndefined();
    expect((await states(o.orgId, [])).size, "naming nobody asks about nobody").toBe(0);
    expect((await states(o.orgId)).size, "premise: unscoped is the whole org").toBe(3);
  });

  // THE SEQUENCE this exists for: a player the gate refuses with "reconnect" is let through once they reconnect - and
  // one who unlinks falls out of the map altogether (no link, a different reason from reconnect).
  it("follows reconnect and unlink: reconnect -> plays -> (unlink) -> absent", async () => {
    const o = await seedOrg("seq");
    const u = await o.user("Sequence");
    await sql`insert into user_external_accounts (user_id, provider, external_user_id, username)
              values (${u}, 'lichess', ${lid("seq")}, 'Legacy')`;
    const p = await o.person("Sequence", u);
    expect((await states(o.orgId)).get(p), "identity-only").toBe("reconnect");

    await upsertLichessLink(u, { externalUserId: lid("seq-2"), username: "Seq", scopes: [...PLAY_SCOPES], token: "lio_t" });
    expect((await states(o.orgId)).get(p), "after the reconnect").toBe("plays");

    await unlinkLichess(u);
    expect((await states(o.orgId)).get(p), "after the unlink").toBeUndefined();
  });

  // The verdict is the seat gate's own predicate: a row the play gate would refuse is `reconnect`, always.
  it("agrees with lichessGrantPlays on every stored row it reads", async () => {
    const o = await seedOrg("oracle");
    const rows: { personId: string; userId: string }[] = [];
    for (const [name, scopes, consented] of [
      ["Full", [...PLAY_SCOPES], true],
      ["Half", PLAY_SCOPES.slice(0, 1), true],
      ["Stamp missing", [...PLAY_SCOPES], false],
      ["Empty", [], false],
    ] as const) {
      const u = await o.user(name);
      await o.grant(u, [...scopes], consented);
      rows.push({ personId: await o.person(name, u), userId: u });
    }

    const got = await states(o.orgId);

    let checked = 0;
    for (const r of rows) {
      const link = await getLichessLink(r.userId);
      expect(got.get(r.personId), r.personId).toBe(lichessGrantPlays(link!) ? "plays" : "reconnect");
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(4);
    expect(new Set(got.values()), "premise: both verdicts occur").toEqual(new Set(["plays", "reconnect"]));
  });
});

/** What a synchronous call throws, or null. */
function thrownBy(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("external-accounts — the roster's link demand (no DB)", () => {
  const states = (entries: [string, LichessLinkState][]): ReadonlyMap<string, LichessLinkState> => new Map(entries);
  const naming = (e: unknown): unknown => (e as { extra?: { person_ids?: unknown } }).extra?.person_ids;

  it("assertPersonIdsLinkedForOnlinePlay: passes only when EVERY person's link plays", () => {
    const map = states([["a", "plays"], ["b", "plays"]]);

    expect(thrownBy(() => assertPersonIdsLinkedForOnlinePlay(map, ["a", "b"]))).toBeNull();
    let refused = 0;
    for (const ids of [["a", "x"], ["x"], ["x", "a", "b"]]) {
      expect(thrownBy(() => assertPersonIdsLinkedForOnlinePlay(map, ids)), ids.join(",")).toMatchObject({
        status: 422,
        code: "LICHESS_LINK_REQUIRED",
      });
      refused++;
    }
    expect(refused, "anti-vacuity: partial maps swept").toBe(3);
    // The empty map refuses everyone it is asked about (it answers no, not "nothing to check").
    expect(thrownBy(() => assertPersonIdsLinkedForOnlinePlay(new Map(), ["a"]))).toMatchObject({
      code: "LICHESS_LINK_REQUIRED",
    });
    // Nobody rostered, nobody to refuse.
    expect(thrownBy(() => assertPersonIdsLinkedForOnlinePlay(map, []))).toBeNull();
  });

  // The owner's ruling (2026-10-25): a link the seat gate would refuse is refused at registration, with the RECONNECT
  // reason (not "link"), so the player is told to reconnect before they register.
  it("assertPersonIdsLinkedForOnlinePlay: a link that does not play is refused as RECONSENT, never as LINK", () => {
    const e = thrownBy(() => assertPersonIdsLinkedForOnlinePlay(states([["a", "reconnect"]]), ["a"]));

    expect(e).toMatchObject({ status: 422, code: "LICHESS_RECONSENT_REQUIRED" });
    expect(naming(e)).toEqual(["a"]);
    // Two reasons, two sentences: the player must be able to tell "link" from "reconnect" by the words alone.
    const link = thrownBy(() => assertPersonIdsLinkedForOnlinePlay(new Map(), ["a"])) as Error;
    expect((e as Error).message).not.toBe(link.message);
    expect(link.message, "the existing not-linked copy is unchanged").toBe(
      "Every player must link a Lichess account before entering online play",
    );
    expect((e as Error).message.toLowerCase()).toContain("reconnect");
  });

  it("assertPersonIdsLinkedForOnlinePlay: names each refused person under the reason that is true of them", () => {
    const map = states([["ok", "plays"], ["re1", "reconnect"], ["re2", "reconnect"]]);

    // Reconnect only: every reconnecting person is named, the one who plays is not.
    const reconnect = thrownBy(() => assertPersonIdsLinkedForOnlinePlay(map, ["ok", "re1", "re2"]));
    expect(reconnect).toMatchObject({ code: "LICHESS_RECONSENT_REQUIRED" });
    expect(naming(reconnect)).toEqual(["re1", "re2"]);

    // A person with no link at all is the EARLIER reason (you cannot reconnect what was never linked), and is the only
    // one named under it - the reconnecting people are named when the roster is next tried.
    const mixed = thrownBy(() => assertPersonIdsLinkedForOnlinePlay(map, ["ok", "re1", "none", "re2"]));
    expect(mixed).toMatchObject({ code: "LICHESS_LINK_REQUIRED" });
    expect(naming(mixed)).toEqual(["none"]);

    // The same person named twice is named once.
    expect(naming(thrownBy(() => assertPersonIdsLinkedForOnlinePlay(map, ["re1", "re1"])))).toEqual(["re1"]);
  });

  // `null` is "the states were never read for this transaction" - the division turned online between the prelude's read
  // and the transaction's. It cannot be answered from nothing, so it refuses (fails closed), the way an unasked flag does.
  it("assertPersonIdsLinkedForOnlinePlay: states that were never read refuse everyone who is rostered", () => {
    expect(thrownBy(() => assertPersonIdsLinkedForOnlinePlay(null, ["a"]))).toMatchObject({
      status: 422,
      code: "LICHESS_LINK_REQUIRED",
    });
    expect(thrownBy(() => assertPersonIdsLinkedForOnlinePlay(null, []))).toBeNull();
  });
});
