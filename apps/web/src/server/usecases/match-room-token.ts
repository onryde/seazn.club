import "server-only";
// Personal match-room link (spec §12.1): stateless HS256 JWT. It IDENTIFIES a
// player for one fixture; it never widens what they can do — the server window
// and Lichess expiry gate every action. Expiry is pinned to the FIXTURE's
// scheduled_at + MATCH_ROOM_TOKEN_TTL_MS, not to mint time, so a link minted
// well before kickoff still dies on schedule.
import { SignJWT, errors, jwtVerify } from "jose";
import { HttpError } from "@/lib/errors";
import { MATCH_ROOM_TOKEN_TTL_MS } from "@/server/external-play/window";
import { authSecretKey } from "./signing-key";

const TYP = "seazn-match-room";

export type MatchRoomClaims = { fixtureId: string; personId: string; scheduledAt: string };

export async function mintMatchRoomToken(c: MatchRoomClaims): Promise<string> {
  const exp = Math.floor((Date.parse(c.scheduledAt) + MATCH_ROOM_TOKEN_TTL_MS) / 1000);
  return new SignJWT({ fid: c.fixtureId, pid: c.personId, sat: c.scheduledAt })
    .setProtectedHeader({ alg: "HS256", typ: TYP })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(authSecretKey());
}

/** Verify a match-room token → claims verbatim. The Task 8 room resolver
 *  compares fixtureId/personId/scheduledAt against the fixture row — that
 *  comparison does NOT belong here. */
export async function verifyMatchRoomToken(token: string): Promise<MatchRoomClaims> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, authSecretKey(), { typ: TYP });
    if (protectedHeader.typ !== TYP) throw new Error("typ");
    const { fid, pid, sat } = payload as Record<string, unknown>;
    if (typeof fid !== "string" || typeof pid !== "string" || typeof sat !== "string") throw new Error("claims");
    return { fixtureId: fid, personId: pid, scheduledAt: sat };
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      throw new HttpError(401, "This match link has expired", "MATCH_ROOM_EXPIRED");
    }
    throw new HttpError(401, "This match link is not valid", "MATCH_ROOM_INVALID");
  }
}
