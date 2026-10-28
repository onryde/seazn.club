// Shared rig for the YouTube connections suites (T8): a pending Google grant exactly as the OAuth callback leaves it for the save,
// built with the callback's own producers (insertPending / storeGrant / sealPendingToken), and a connect through the real save.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { insertPending, storeGrant } from "@/server/youtube/connect-flow";
import { saveConnectionFromGrant } from "@/server/youtube/connections";
import { FakeYouTube } from "@/server/youtube/fake";
import { sealPendingToken } from "@/server/youtube/token-store";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";

export const SCOPE = "https://www.googleapis.com/auth/youtube";
export const channelId = () => `UC${randomUUID().replace(/-/g, "").slice(0, 22)}`;
export const refreshToken = () => `1//t8-${randomBytes(16).toString("hex")}`;
/** The port a save is handed; it must never be called (a save talks to no one), so a test can read `calls`. */
export const fake = new FakeYouTube();

export interface Org { auth: AuthCtx; orgId: string; userId: string }
export async function org(): Promise<Org> {
  const { auth } = await seedOrg("pro");
  return { auth, orgId: auth.orgId, userId: auth.userId! };
}
/** A second signed-in person of the same org, under `role` (an admin is an editor; a viewer is not). */
export async function colleague(o: Org, role: "admin" | "viewer" = "admin"): Promise<AuthCtx> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${o.orgId}, ${u.id}, ${role})`;
  return { orgId: o.orgId, via: "session", userId: u.id, role, keyId: null };
}

export interface Ch { id: string; title: string }
export interface GrantOpts {
  channels?: Ch[]; token?: string; connectionId?: string | null; privacy?: "unlisted" | "public" | "private"; madeForKids?: boolean;
  consentVersion?: number; consentAt?: Date; sealed?: boolean; startedMinutesAgo?: number; sub?: string | null; userId?: string;
}
/** A pending grant exactly as the OAuth callback leaves it for the save: the start's row, the grant's details, the token sealed. */
export async function grant(o: Org, g: GrantOpts = {}): Promise<{ id: string; token: string; channels: Ch[] }> {
  const channels = g.channels ?? [{ id: channelId(), title: "Solo United" }];
  const token = g.token ?? refreshToken();
  const { id } = await insertPending({
    state: randomUUID(), orgId: o.orgId, userId: g.userId ?? o.userId, connectionId: g.connectionId ?? null, privacy: g.privacy ?? "unlisted",
    madeForKids: g.madeForKids ?? false, consentVersion: g.consentVersion ?? 1, now: new Date(Date.now() - (g.startedMinutesAgo ?? 0) * 60_000),
    ...(g.consentAt ? { consentAt: g.consentAt } : {}),
  });
  await sql.begin(async (tx) => {
    await storeGrant(tx, id, { grantedScope: SCOPE, googleSub: g.sub === undefined ? `sub-${id}` : g.sub, channels });
    if (g.sealed !== false) await sealPendingToken(tx, id, token);
  });
  return { id, token, channels };
}
/** Connect the grant's first channel in `o` through the real save. */
export async function connect(o: Org, g: GrantOpts = {}) {
  const p = await grant(o, g);
  const ch = p.channels[0]!;
  const saved = await saveConnectionFromGrant({ pendingId: p.id, channelId: ch.id, userId: g.userId ?? o.userId }, fake);
  return { ...saved, channel: ch, token: p.token, pendingId: p.id };
}
