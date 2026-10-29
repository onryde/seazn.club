import "server-only";
// Start-a-competition funnel (v3/07 §6): a visitor configures a competition
// BEFORE authenticating; the draft rides a single-use emailed token that both
// proves email ownership (like login_links) and carries the payload. Claiming
// creates the org (if none), the competition and a division, then lands the
// new organiser inside it.
import crypto from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@/lib/db";
import type { Locale } from "@/lib/i18n-constants";
import { createOrgForUser, getUserOrgs } from "@/lib/auth";
import { consumeReferralCookie } from "@/lib/referral";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { pickVariant } from "@/lib/preferred-variant";
import { routes } from "@/lib/routes";
import type { AuthCtx } from "@/server/api-v1/auth";

const DRAFT_TTL_DAYS = 7;

export const funnelPayloadSchema = z
  .object({
    name: z.string().min(1).max(200),
    sport: z.string().min(1).max(60),
    entrants: z.number().int().min(2).max(256),
    start_date: z.string().max(10).optional(),
    format: z.string().max(40).optional(),
  })
  .strict();

export type FunnelPayload = z.infer<typeof funnelPayloadSchema>;

export interface FunnelDraft {
  id: string;
  email: string;
  payload: FunnelPayload;
}

/** Create a draft on `db` and return its single-use claim token and the instant it stops working. The start route passes its
 *  transaction, so the draft and the outbox row that carries its token are committed together or not at all. `locale` is the
 *  language the visitor started it in (the start route's pick), kept for the +24h reminder; null when they gave none. */
export async function createFunnelDraft(
  email: string,
  payload: FunnelPayload,
  db: Tx | typeof sql = sql,
  locale: Locale | null = null,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000);
  const [row] = await db<{ id: string }[]>`
    insert into funnel_drafts (token, email, payload, expires_at, locale)
    values (${token}, ${email}, ${db.json(payload)}, ${expiresAt.toISOString()}, ${locale})
    returning id`;
  return { id: row.id, token, expiresAt };
}

/**
 * Consume a claim token: mark it used and return the draft if it was valid,
 * unexpired and unused — otherwise null. Single-use inside one transaction,
 * exactly like login-link consumption (clicking proves email ownership).
 */
export async function consumeFunnelDraft(token: string): Promise<FunnelDraft | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<
      { id: string; email: string; payload: unknown; expires_at: string; used_at: string | null }[]
    >`
      select id, email, payload, expires_at, used_at
      from funnel_drafts where token = ${token}
      for update limit 1`;
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }
    const parsed = funnelPayloadSchema.safeParse(row.payload);
    if (!parsed.success) return null;
    await tx`update funnel_drafts set used_at = now() where id = ${row.id}`;
    return { id: row.id, email: row.email, payload: parsed.data };
  });
}

/** Map the funnel's free-text sport onto the engine catalog: an exact-name
 *  sport with its PREFERRED system variant (the one the division builder
 *  preselects - `lib/preferred-variant.ts`, so the two creation paths cannot
 *  disagree; W2e D2 made badminton's 3x15), else the first system variant by
 *  key, else the generic score module. */
export async function resolveSport(
  sport: string,
): Promise<{ sport_key: string; variant_key: string }> {
  const rows = await sql<{ sport_key: string; variant_key: string }[]>`
    select s.key as sport_key, v.key as variant_key
    from sports s
    join sport_variants v on v.sport_key = s.key and v.is_system
    where lower(s.name) = ${sport.toLowerCase()}
    order by s.key, v.key`;
  const first = rows[0];
  if (first) {
    const variants = rows.filter((r) => r.sport_key === first.sport_key).map((r) => ({ key: r.variant_key }));
    return { sport_key: first.sport_key, variant_key: pickVariant(first.sport_key, variants) };
  }
  const [generic] = await sql<{ variant_key: string }[]>`
    select key as variant_key from sport_variants
    where sport_key = 'generic' and is_system
    order by key limit 1`;
  return { sport_key: "generic", variant_key: generic?.variant_key ?? "score" };
}

/**
 * Turn a claimed draft into real structure for `userId` and return where to
 * land: inside the new competition on the division's entrants tab. Uses the
 * standard use-cases, so quotas/slugs/audit all apply as if typed by hand.
 * Reads the referral cookie (`consumeReferralCookie`) ONLY when creating a new
 * org, to attribute it — so this needs request scope; its only caller is the
 * funnel claim route.
 */
export async function createFromDraft(
  userId: string,
  draft: FunnelDraft,
): Promise<{ redirect: string; orgId: string }> {
  const orgs = await getUserOrgs(userId);
  // Consume the referral cookie ONLY when actually creating a new org — an
  // existing user (orgs[0]) can't be a fresh referral, so don't burn their
  // cookie for nothing (it stays for a genuine new-org create later).
  const org =
    orgs[0] ??
    (await createOrgForUser(userId, `${draft.payload.name} organisers`, {
      referredByOrgId: await consumeReferralCookie(userId),
    }));

  const auth: AuthCtx = { orgId: org.id, via: "session", userId, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    name: draft.payload.name,
    visibility: "private",
    branding: {},
    ...(draft.payload.start_date ? { starts_on: draft.payload.start_date } : {}),
  } as never);

  const { sport_key, variant_key } = await resolveSport(draft.payload.sport);
  const division = await createDivision(auth, competition.id, {
    name: draft.payload.sport,
    sport_key,
    variant_key,
    config: {},
  } as never);

  return {
    redirect: routes.division(org.slug, competition.slug, division.slug, "entrants"),
    orgId: org.id,
  };
}
