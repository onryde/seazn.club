// The personal match-room link's token, minted as invite.ts → mintMatchRoomToken
// mints it (src/server/usecases/match-room-token.ts): HS256, typ
// "seazn-match-room", claims fid/pid/rid/oat — bound to the ROUND'S OPEN
// (`stage_round_opens`, T14), expiring at openedAt + MATCH_ROOM_TOKEN_TTL_MS,
// never at a scheduled time. The invite email itself cannot be captured (no
// mail provider in e2e). The runner must carry the server's AUTH_SECRET; the
// fallback is the server's own dev fallback (signing-key.ts).
// src/server/external-play/__tests__/e2e-seams.test.ts proves the product's
// verifyMatchRoomToken accepts what this mints.
import { SignJWT } from "jose";
import { MATCH_ROOM_TOKEN_TTL_MS } from "../src/server/external-play/window";

export async function mintMatchRoomLink(c: {
  fixtureId: string;
  personId: string;
  roundOpenId: string;
  openedAt: Date;
}): Promise<string> {
  const secret = process.env.AUTH_SECRET ?? "dev-insecure-secret-change-me";
  const exp = Math.floor((c.openedAt.getTime() + MATCH_ROOM_TOKEN_TTL_MS) / 1000);
  return new SignJWT({ fid: c.fixtureId, pid: c.personId, rid: c.roundOpenId, oat: c.openedAt.toISOString() })
    .setProtectedHeader({ alg: "HS256", typ: "seazn-match-room" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
}
