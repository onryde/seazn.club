// server/usecases/whoami.ts: the identity the analytics bootstrap identifies a signed-in visitor with. One builder for
// the two routes that serve it: GET /api/users/me (401 for an anonymous caller) and GET /api/users/identity (200 with
// no identity). Minimised to what the identify call consumes: no email.
import { resolveActiveOrg } from "@/lib/auth";
import { sql } from "@/lib/db";
import type { User } from "@/lib/types";

export interface Whoami {
  id: string;
  org: { id: string; name: string; plan: string } | null;
}

/** The plan key of an organisation's subscription; `community` when it has none. */
export async function planKeyOfOrg(orgId: string): Promise<string> {
  const [sub] = await sql<{ plan_key: string | null }[]>`
    select coalesce(s.plan_key, 'community') as plan_key
    from subscriptions s
    join organizations o on o.subscription_id = s.id
    where o.id = ${orgId}`;
  return sub?.plan_key ?? "community";
}

export async function whoami(user: User): Promise<Whoami> {
  const org = await resolveActiveOrg(user);
  if (!org) return { id: user.id, org: null };
  return { id: user.id, org: { id: org.id, name: org.name, plan: await planKeyOfOrg(org.id) } };
}
