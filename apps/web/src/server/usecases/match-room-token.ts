import "server-only";
// Personal match-room link (spec §12.1): stateless HS256 JWT. It IDENTIFIES a
// player for one fixture; it never widens what they can do — the server window
// and Lichess expiry gate every action.
//
// T14 (T19 review M4): the link is bound to the ROUND'S OPEN, not to the
// fixture's scheduled time. D12 hangs every window on the organiser's open, and
// an online Swiss board has no start time at all, so a schedule-bound link
// could never resolve for it. The claims name the open (`stage_round_opens.id`,
// one row per stage+round, never deleted) and its instant; expiry is pinned to
// `opened_at + MATCH_ROOM_TOKEN_TTL_MS`, not to mint time, so a resend minted an
// hour later still dies on the same clock.
import { SignJWT, errors, jwtVerify } from "jose";
import { HttpError } from "@/lib/errors";
import { MATCH_ROOM_TOKEN_TTL_MS } from "@/server/external-play/window";
import { authSecretKey } from "./signing-key";

const TYP = "seazn-match-room";

export type MatchRoomClaims = {
  fixtureId: string;
  personId: string;
  /** `stage_round_opens.id` of the fixture's round. */
  roundOpenId: string;
  /** That open's `opened_at`, ISO — the expiry anchor. */
  roundOpenedAt: string;
};

export async function mintMatchRoomToken(c: MatchRoomClaims): Promise<string> {
  const exp = Math.floor((Date.parse(c.roundOpenedAt) + MATCH_ROOM_TOKEN_TTL_MS) / 1000);
  // Explicit, not incidental: jose's setExpirationTime happens to reject NaN
  // too, but with its own generic message — pin ours so the failure names
  // the real cause.
  if (!Number.isFinite(exp)) throw new Error("mintMatchRoomToken: invalid roundOpenedAt");
  return new SignJWT({ fid: c.fixtureId, pid: c.personId, rid: c.roundOpenId, oat: c.roundOpenedAt })
    .setProtectedHeader({ alg: "HS256", typ: TYP })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(authSecretKey());
}

/** Verify a match-room token → claims verbatim. The room resolver compares
 *  fixtureId/personId/roundOpenId against the fixture row — that comparison
 *  does NOT belong here. A token of the old schedule-bound shape (`sat`, no
 *  `rid`) is refused as invalid. */
export async function verifyMatchRoomToken(token: string): Promise<MatchRoomClaims> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, authSecretKey(), {
      typ: TYP,
      algorithms: ["HS256"],
    });
    if (protectedHeader.typ !== TYP) throw new Error("typ");
    const { fid, pid, rid, oat } = payload as Record<string, unknown>;
    if (typeof fid !== "string" || typeof pid !== "string" || typeof rid !== "string" || typeof oat !== "string") {
      throw new Error("claims");
    }
    return { fixtureId: fid, personId: pid, roundOpenId: rid, roundOpenedAt: oat };
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      throw new HttpError(401, "This match link has expired", "MATCH_ROOM_EXPIRED");
    }
    throw new HttpError(401, "This match link is not valid", "MATCH_ROOM_INVALID");
  }
}
