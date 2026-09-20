// server/relay/tokens.ts — job and page tokens (design §6.6, G1). HS256 over
// AUTH_SECRET through jose, the same shape as lib/realtime.ts's
// mintPublicFixtureToken but a DIFFERENT trust domain: the realtime subscriber
// secret signs realtime tokens only, is never read here, and is deliberately
// not NAMED here either — this module is production code, and the P3 review
// probe fails on any production file that names it (the guard `it` in
// tokens.test.ts pins this file from the other side).
//
// A job token is a Fly Machine's credential for calling back into us; a page
// token is a viewer's credential for a relay page. Claims are { sid, scope }
// with `exp` = the session's own deadline + TOKEN_GRACE_MINUTES, and the
// audience pins a token to this seam, so a token minted for another seam
// cannot be replayed at the heartbeat route even if two secrets were ever
// confused.
//
// Everything this module refuses is ONE 401 with ONE sentence: a verifier that
// says which check failed is an oracle for whoever is probing it. The 410 for a
// TERMINAL session is the caller's (it needs the row) — this module answers
// only "is this token genuine, unexpired, for this sid and this scope".
import { SignJWT, jwtVerify } from "jose";
import { HttpError } from "@/lib/errors";
import { TOKEN_GRACE_MINUTES } from "./config";
import { deadlineOf } from "./domain/expiry";

export type RelayScope = "relay-job" | "relay-page";
export interface RelayClaims {
  sid: string;
  scope: RelayScope;
  exp: number;
}

const AUDIENCE = "seazn-relay";
/** The ONE algorithm this seam mints and accepts. jose refuses `alg: none`
 *  outright and refuses an asymmetric alg against a symmetric key, but a list
 *  of one is what stops a token signed HS512 with the same secret. */
const ALGORITHM = "HS256";

function key(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  // No dev fallback, unlike lib/auth.ts and usecases/checkin-token.ts: this is
  // the credential a Fly Machine drives a paid session with, and a
  // publicly-known signing key outside production is a forgeable job token.
  if (!secret) throw new Error("AUTH_SECRET is required to sign relay tokens");
  return new TextEncoder().encode(secret);
}

const refuse = (): HttpError => new HttpError(401, "relay token is not valid for this session", "RELAY_TOKEN_INVALID");

export async function mintRelayToken(input: { sid: string; scope: RelayScope; expiresAt: Date }): Promise<string> {
  return new SignJWT({ sid: input.sid, scope: input.scope })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(input.expiresAt.getTime() / 1000))
    .setAudience(AUDIENCE)
    .sign(key());
}

export async function verifyRelayToken(
  token: string,
  expected: { sid: string; scope: RelayScope },
): Promise<RelayClaims> {
  // Resolved BEFORE the try on purpose: a missing AUTH_SECRET is our
  // misconfiguration, and swallowing it into the 401 below would report a
  // config outage as "every token expired".
  const secret = key();
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, secret, { audience: AUDIENCE, algorithms: [ALGORITHM] }));
  } catch {
    // Signature, expiry, audience, algorithm and every malformed input land
    // here. Nothing from the caught error is re-thrown or logged: it carries
    // the payload.
    throw refuse();
  }
  if (payload.sid !== expected.sid) throw refuse();
  if (payload.scope !== expected.scope) throw refuse();
  // jose validates `exp` only when it is PRESENT, so a token minted without one
  // never expires. Deny by default: an unexpected claim shape is a 401.
  if (typeof payload.exp !== "number") throw refuse();
  return { sid: expected.sid, scope: expected.scope, exp: payload.exp };
}

/** When a token minted at `from` for a session booked for `maxDurationMinutes`
 *  expires: the session's own hard stop plus the grace. It reads the deadline
 *  through the domain's `deadlineOf` rather than re-deriving it, so a token can
 *  never expire before the session it belongs to — including for a falsy
 *  max_duration, which `deadlineOf` reads as the default rather than as zero. */
export function relayTokenExpiry(from: Date, maxDurationMinutes: number): Date {
  const deadline = deadlineOf({ createdAt: from, startedAt: null, maxDurationMinutes });
  return new Date(deadline.getTime() + TOKEN_GRACE_MINUTES * 60_000);
}
