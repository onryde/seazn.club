import "server-only";
// Linked external board accounts (Lichess first). The row carries the
// player's OAuth TOKEN AT REST (chess design §3.1, V432) — this reverses the
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

/** V432's second unique constraint — a Lichess account can only ever be
 *  linked to ONE Seazn user. */
const ALREADY_LINKED_CONSTRAINT = "user_external_accounts_provider_external_user_id_key";

/** The grant design §3.1 asks for: submit moves (`board:play`) and create the
 *  challenge (`challenge:write`). Any linked row that does not carry
 *  `board:play` owes a re-consent, whatever else it carries.
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

/** The plaintext token, or null when there is none (no link, or a legacy
 *  identity-only row). Every caller treats null as "cannot play yet", never
 *  as "play without a token". */
export async function getLichessAccessToken(userId: string): Promise<string | null> {
  const rows = await sql<{ access_token_enc: Uint8Array | null }[]>`
    select access_token_enc from user_external_accounts
     where user_id = ${userId} and provider = 'lichess'`;
  const enc = rows[0]?.access_token_enc ?? null;
  if (!enc) return null;
  return openPlayerToken(Buffer.from(enc).toString("base64"));
}

/** Upsert on `(user_id, provider)`. V432's second unique constraint,
 *  `(provider, external_user_id)`, means a given Lichess account links to ONE
 *  Seazn user; a different user claiming an already-linked account trips it,
 *  and it is surfaced as a typed 409 rather than a raw 23505. Writing the
 *  token also writes `consented_at = now()`: V432's
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
 *  were told to forget. A legacy row has no token, so nothing is sent. */
export async function unlinkLichess(userId: string): Promise<void> {
  const token = await getLichessAccessToken(userId).catch(() => null);
  if (token) {
    await fetch(LICHESS_TOKEN_URL, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
    }).catch(() => undefined);
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

/** PLAY gate (§3.1). A link is not enough: the row must carry a consent
 *  timestamp AND `board:play`, because a grant from the identity-only flow
 *  cannot submit a move and would 401 mid-game. Called by T8 (seat) and T9
 *  (creation); T14 renders the re-consent screen on this code. */
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
  if (link.consentedAt === null || !link.scopes.includes("board:play")) {
    throw new HttpError(
      422,
      "Re-link your Lichess account so Seazn can submit your moves",
      "LICHESS_RECONSENT_REQUIRED",
    );
  }
}
