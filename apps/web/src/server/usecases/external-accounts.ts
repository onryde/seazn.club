import "server-only";
// Linked external board accounts (Lichess first). Tokens live in
// user_external_accounts and are only touched via privileged `sql` (FORCE RLS
// with no app_user policy — see V405).
import { sql, withTenant } from "@/lib/db";

export type ExternalAccountProvider = "lichess";

export type LinkedAccount = {
  provider: ExternalAccountProvider;
  externalUserId: string;
  username: string;
  updatedAt: Date;
};

export async function getLinkedAccount(
  userId: string,
  provider: ExternalAccountProvider,
): Promise<LinkedAccount | null> {
  const rows = await sql<
    { external_user_id: string; username: string; updated_at: Date }[]
  >`
    select external_user_id, username, updated_at
      from user_external_accounts
     where user_id = ${userId} and provider = ${provider}`;
  const row = rows[0];
  if (!row) return null;
  return {
    provider,
    externalUserId: row.external_user_id,
    username: row.username,
    updatedAt: row.updated_at,
  };
}

export async function upsertLichessLink(
  userId: string,
  row: {
    externalUserId: string;
    username: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiresAt?: Date;
  },
): Promise<void> {
  await sql`
    insert into user_external_accounts (
      user_id, provider, external_user_id, username,
      access_token, refresh_token, token_expires_at, updated_at
    ) values (
      ${userId}, 'lichess', ${row.externalUserId}, ${row.username},
      ${row.accessToken}, ${row.refreshToken ?? null}, ${row.tokenExpiresAt ?? null}, now()
    )
    on conflict (user_id, provider) do update set
      external_user_id = excluded.external_user_id,
      username = excluded.username,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expires_at = excluded.token_expires_at,
      updated_at = now()`;
}

export async function unlinkExternalAccount(
  userId: string,
  provider: ExternalAccountProvider,
): Promise<void> {
  await sql`
    delete from user_external_accounts
     where user_id = ${userId} and provider = ${provider}`;
}

/** True when the person's linked Seazn user has a Lichess account row. */
export async function personHasLichessLink(
  orgId: string,
  personId: string,
): Promise<boolean> {
  const userId = await withTenant(orgId, async (tx) => {
    const rows = await tx<{ user_id: string | null }[]>`
      select user_id from persons where id = ${personId}`;
    return rows[0]?.user_id ?? null;
  });
  if (!userId) return false;
  const linked = await getLinkedAccount(userId, "lichess");
  return linked !== null;
}

/** Privileged read of the access token for challenge create (cron / prepare). */
export async function getLichessAccessToken(userId: string): Promise<string | null> {
  const rows = await sql<{ access_token: string }[]>`
    select access_token from user_external_accounts
     where user_id = ${userId} and provider = 'lichess'`;
  return rows[0]?.access_token ?? null;
}
