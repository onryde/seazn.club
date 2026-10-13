import "server-only";
// Linked external board accounts (Lichess first). The row carries the
// player's OAuth TOKEN AT REST (chess design §3.1, V439) — this reverses the
// identity-only decision V405 shipped under, because our server submits both
// players' moves with their own tokens. The token is sealed by
// external-play/secrets.ts; `access_token_enc` is named HERE and nowhere else
// (enc-boundary.test.ts holds every other file to that). Touched only via
// privileged `sql` (FORCE RLS with no app_user policy).
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { LICHESS_OAUTH_SCOPES, LICHESS_TOKEN_URL } from "@/lib/oauth";
import { LICHESS_TIMEOUT_MS } from "@/server/external-play/window";
import { openPlayerToken, sealPlayerToken } from "@/server/external-play/secrets";
import { log } from "@/server/logger";
import { hasValidKek } from "@/server/relay/crypto";

/** V439's second unique constraint — a Lichess account can only ever be
 *  linked to ONE Seazn user. */
const ALREADY_LINKED_CONSTRAINT = "user_external_accounts_provider_external_user_id_key";

/** The grant design §3.1 asks for: submit moves (`board:play`), create the
 *  challenge (`challenge:write`) and list White's challenges when recovering a
 *  crashed create (`challenge:read`). Any linked row that does not carry EVERY
 *  one of these owes a re-consent, whatever else it carries.
 *
 *  DERIVED from `lib/oauth.ts`'s `LICHESS_OAUTH_SCOPES`, which is the string
 *  the OAuth start actually sends, so the two cannot drift. The dependency
 *  runs this way round on purpose: this module already imports `lib/oauth`
 *  for `LICHESS_TOKEN_URL`, and having `oauth.ts` import PLAY_SCOPES back
 *  would close an import CYCLE whose top-level `.join(" ")` evaluates before
 *  this module finishes initialising, depending on which side loads first. */
export const PLAY_SCOPES: readonly string[] = LICHESS_OAUTH_SCOPES.split(" ");

export type LichessLink = {
  externalUserId: string;
  username: string;
  scopes: string[];
  /** null => linked under the identity-only flow; re-consent owed before play. */
  consentedAt: Date | null;
};

export async function getLichessLink(userId: string): Promise<LichessLink | null> {
  const rows = await sql<
    { external_user_id: string; username: string; scopes: string[]; consented_at: Date | null }[]
  >`
    select external_user_id, username, scopes, consented_at
      from user_external_accounts
     where user_id = ${userId} and provider = 'lichess'`;
  const row = rows[0];
  if (!row) return null;
  return {
    externalUserId: row.external_user_id,
    username: row.username,
    scopes: row.scopes,
    consentedAt: row.consented_at,
  };
}

/** Why a STORED token could not be opened. A classification an operator can
 *  act on — never the token, never the ciphertext, never the crypto error's
 *  text: `key_unavailable` is LICHESS_TOKEN_KEK unset or malformed;
 *  `decrypt_failed` is a valid key that does not open this row (rotated,
 *  wrong, or the ciphertext was damaged). */
type TokenOpenFailure = "key_unavailable" | "decrypt_failed";

/** The stored token, opened. `null` means there is NO token — no link, or a
 *  legacy identity-only row — and is the only "absent" answer. A row that
 *  HOLDS a token we cannot open is a different fact (review T2-I2: unlink's
 *  old `.catch(() => null)` made a missing or rotated key look like "nothing
 *  stored"), so it comes back as a failure each caller must handle. */
async function readStoredToken(
  userId: string,
): Promise<{ token: string } | { failure: TokenOpenFailure } | null> {
  const rows = await sql<{ access_token_enc: Uint8Array | null }[]>`
    select access_token_enc from user_external_accounts
     where user_id = ${userId} and provider = 'lichess'`;
  const enc = rows[0]?.access_token_enc ?? null;
  if (!enc) return null;
  try {
    return { token: await openPlayerToken(Buffer.from(enc).toString("base64")) };
  } catch {
    return { failure: hasValidKek("LICHESS_TOKEN_KEK") ? "decrypt_failed" : "key_unavailable" };
  }
}

/** The plaintext token, or null when there is none (no link, or a legacy
 *  identity-only row). Every caller treats null as "cannot play yet", never
 *  as "play without a token".
 *
 *  A token that is stored but cannot be opened fails CLOSED with its own
 *  code, LICHESS_TOKEN_UNAVAILABLE — NOT a re-consent prompt: re-linking
 *  cannot fix an operator's key, and sending a player round an OAuth trip
 *  for it would mint a fresh grant we then could not open either. */
export async function getLichessAccessToken(userId: string): Promise<string | null> {
  const stored = await readStoredToken(userId);
  if (stored === null) return null;
  if ("failure" in stored) {
    log.error(
      { userId, reason: stored.failure },
      "lichess: the player's stored token cannot be opened — online play refused",
    );
    throw new HttpError(
      503,
      "Online play is unavailable right now because of a problem on Seazn's side. Please try again later.",
      "LICHESS_TOKEN_UNAVAILABLE",
    );
  }
  return stored.token;
}

/** Best-effort `DELETE /api/token`: null when Lichess accepted it, else why
 *  not — a classification, so a caller can report a grant left live without
 *  ever handling the token. */
async function revokeAtLichess(
  token: string,
): Promise<null | { reason: "revoke_rejected"; status: number } | { reason: "revoke_unreachable" }> {
  try {
    const res = await fetch(LICHESS_TOKEN_URL, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
    });
    return res.ok ? null : { reason: "revoke_rejected", status: res.status };
  } catch {
    return { reason: "revoke_unreachable" };
  }
}

/** Upsert on `(user_id, provider)`. V439's second unique constraint,
 *  `(provider, external_user_id)`, means a given Lichess account links to ONE
 *  Seazn user; a different user claiming an already-linked account trips it,
 *  and it is surfaced as a typed 409 rather than a raw 23505. Writing the
 *  token also writes `consented_at = now()`: V439's
 *  `user_external_accounts_consent_token_check` refuses one without the
 *  other, so the two cannot drift apart. */
export async function upsertLichessLink(
  userId: string,
  link: { externalUserId: string; username: string; scopes: string[]; token: string },
): Promise<void> {
  const sealed = Buffer.from(await sealPlayerToken(link.token), "base64");
  try {
    await sql`
      insert into user_external_accounts (
        user_id, provider, external_user_id, username,
        access_token_enc, scopes, consented_at, updated_at
      ) values (
        ${userId}, 'lichess', ${link.externalUserId}, ${link.username},
        ${sealed}, ${link.scopes}, now(), now()
      )
      on conflict (user_id, provider) do update set
        external_user_id = excluded.external_user_id,
        username         = excluded.username,
        access_token_enc = excluded.access_token_enc,
        scopes           = excluded.scopes,
        consented_at     = excluded.consented_at,
        updated_at       = now()`;
  } catch (err) {
    const pg = err as { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === ALREADY_LINKED_CONSTRAINT) {
      throw new HttpError(
        409,
        "That Lichess account is already linked to a different Seazn account.",
        "LICHESS_ALREADY_LINKED",
      );
    }
    throw err;
  }
}

/** Revoke at Lichess, THEN delete. Best-effort revoke: a failure leaves an
 *  orphaned grant on Lichess's side, which is not a reason to keep a token we
 *  were told to forget. A legacy row has no token, so nothing is sent.
 *
 *  Never SILENT, though (review T2-I2): a token we cannot open, a revoke
 *  Lichess refuses, and a revoke that never arrives all leave a move-capable
 *  grant live, so each is reported to the error channel with the user id and
 *  a reason — never the token — and the row is deleted anyway. */
export async function unlinkLichess(userId: string): Promise<void> {
  const stored = await readStoredToken(userId);
  if (stored !== null && "failure" in stored) {
    log.error(
      { userId, reason: stored.failure },
      "lichess: unlink could not open the stored token — the grant was NOT revoked at Lichess and stays live until the player revokes it there",
    );
  } else if (stored !== null) {
    const failure = await revokeAtLichess(stored.token);
    if (failure) {
      log.error(
        { userId, ...failure },
        "lichess: unlink could not revoke the grant at Lichess — it stays live until the player revokes it there",
      );
    }
  }
  await sql`
    delete from user_external_accounts
     where user_id = ${userId} and provider = 'lichess'`;
}

/** True when the person's linked Seazn user has a Lichess account row. */
export async function personHasLichessLink(orgId: string, personId: string): Promise<boolean> {
  const userId = await withTenant(orgId, async (tx) => {
    const rows = await tx<{ user_id: string | null }[]>`
      select user_id from persons where id = ${personId}`;
    return rows[0]?.user_id ?? null;
  });
  if (!userId) return false;
  return (await getLichessLink(userId)) !== null;
}

/** REGISTRATION gate — a link is required to enter an online division.
 *  Deliberately NOT a consent gate: a player registers long before consent is
 *  needed, and §3.1 owes re-consent "before their first online fixture", not
 *  before signup. The consent gate is assertLichessConsentForPlay. */
export async function assertUserHasLichessForOnlinePlay(userId: string | null): Promise<void> {
  if (!userId) {
    throw new HttpError(
      422,
      "Sign in and link your Lichess account to register for online play",
      "LICHESS_LINK_REQUIRED",
    );
  }
  if (!(await getLichessLink(userId))) {
    throw new HttpError(
      422,
      "Link your Lichess account in Settings before registering for online play",
      "LICHESS_LINK_REQUIRED",
    );
  }
}

export async function assertPersonIdsLinkedForOnlinePlay(
  orgId: string,
  personIds: string[],
): Promise<void> {
  for (const personId of personIds) {
    if (!(await personHasLichessLink(orgId, personId))) {
      throw new HttpError(
        422,
        "Every player must link a Lichess account before entering online play",
        "LICHESS_LINK_REQUIRED",
      );
    }
  }
}

/** Whether a stored grant is enough to PLAY: a consent timestamp AND every scope in PLAY_SCOPES. The one authority —
 *  the play gate below refuses exactly when this answers false, and `/me` asks for re-consent on the same answer. */
export function lichessGrantPlays(link: Pick<LichessLink, "consentedAt" | "scopes">): boolean {
  return link.consentedAt !== null && PLAY_SCOPES.every((s) => link.scopes.includes(s));
}

/** PLAY gate (§3.1). A link is not enough: the row must carry a consent
 *  timestamp AND every scope in PLAY_SCOPES, because a grant from the
 *  identity-only flow cannot submit a move and would 401 mid-game, one
 *  without `challenge:write` cannot create White's challenge, and one without
 *  `challenge:read` cannot be recovered after a crashed create.
 *
 *  Production callers, both through preflight.ts `playGrantRefusal`, which maps
 *  the two 422s to the reasons `lichess_link_required` /
 *  `lichess_reconsent_required` and lets anything else propagate:
 *  - T8's `seatPlayer`, after its identity, board and window checks and
 *    before any participant token is minted (fix round 2);
 *  - T9's `createGameIfReady`, as defence before the seats, answering the
 *    same two reasons.
 *  T14 renders the re-link screen on those reasons. */
export async function assertLichessConsentForPlay(userId: string | null): Promise<void> {
  if (!userId) {
    throw new HttpError(
      422,
      "Sign in and link your Lichess account to play online",
      "LICHESS_LINK_REQUIRED",
    );
  }
  const link = await getLichessLink(userId);
  if (!link) {
    throw new HttpError(
      422,
      "Link your Lichess account in Settings before playing online",
      "LICHESS_LINK_REQUIRED",
    );
  }
  // EVERY scope the design asks for (review T2-I3) — one authority for "the
  // grant that is enough to play", so a PLAY_SCOPES that grows demands
  // re-consent from everyone whose grant predates it.
  if (!lichessGrantPlays(link)) {
    throw new HttpError(
      422,
      "Re-link your Lichess account so Seazn can submit your moves",
      "LICHESS_RECONSENT_REQUIRED",
    );
  }
}
