import { v1, reply } from "@/server/api-v1/http";
import { HttpError } from "@/lib/errors";
import { getCurrentUser, getOrgRole } from "@/lib/auth";
import { publicRateLimit } from "@/server/usecases/public";
import { fixtureRealtimeEligible } from "@/server/public-site/data";
import { fixtureScope, scorerCovers, scoresViaAssignment } from "@/server/usecases/scorers";
import { mintPublicFixtureToken } from "@/lib/realtime";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Public realtime subscriber token for `fixture:{id}` (doc 09 §4). 403 unless
 * the fixture's org has the `realtime` entitlement — Community spectators use
 * the 15 s polling fallback. Enforced here (service layer), not in the UI.
 * Exception (doc 13 §6): the fixture's own officials — editors and covering
 * scorers — get realtime regardless of plan; they are producing the data.
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    const eligible =
      (await fixtureRealtimeEligible(id)) ||
      (await isFixtureOfficial(id)) ||
      (await isFixtureDeviceLink(req, id));
    if (!eligible) throw new HttpError(403, "realtime not available for this competition");
    const token = await mintPublicFixtureToken(id);
    return reply(200, { token, channel: `fixture:${id}` });
  });
}

/** Doc 13 §7: a valid device link for THIS fixture gets the realtime token —
 *  same officials bypass as scorers; the holder is producing the data.
 *
 *  Ownership is NOT re-spelled here: it is the same predicate the scoring door
 *  refuses on (`deviceLinkCoversFixture`, device-links.ts), so a change to one
 *  is a change to both.
 *
 *  The prefix test stays HERE, ahead of the dynamic import, because this is a
 *  public route: an anonymous spectator with no `dl_` token must not pull the
 *  usecase module (and the entitlement lane behind it) into their request. It
 *  is a cheap negative filter, not the authorisation decision —
 *  `requestDeviceLinkCoversFixture` re-tests it against `DEVICE_LINK_PREFIX`
 *  and is the only thing that can return true. */
async function isFixtureDeviceLink(req: Request, fixtureId: string): Promise<boolean> {
  if (!req.headers.get("authorization")?.startsWith("Bearer dl_")) return false;
  const { requestDeviceLinkCoversFixture } = await import("@/server/usecases/device-links");
  return requestDeviceLinkCoversFixture(req, fixtureId);
}

async function isFixtureOfficial(fixtureId: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const scope = await fixtureScope(fixtureId);
  if (!scope) return false;
  const role = await getOrgRole(scope.org_id, user.id);
  if (role === "owner" || role === "admin") return true;
  return scoresViaAssignment(role) && (await scorerCovers(scope.org_id, user.id, scope));
}
