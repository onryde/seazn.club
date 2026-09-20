import "server-only";
// Fixture check-in QR tokens (PROMPT-53): stateless HS256 JWTs signed with
// AUTH_SECRET — the QR stays valid until local midnight (device-links day-of
// policy) without a table row. A distinct `typ` keeps a stolen session JWT
// from opening this door and vice versa.
import { SignJWT, jwtVerify } from "jose";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { endOfLocalDay } from "./device-links";

const TYP = "seazn-checkin";
/** The ONE algorithm this seam mints and accepts (whole-branch review m1). jose already refuses `alg: none` and an
 *  asymmetric alg against a symmetric key, and nobody without AUTH_SECRET can sign anything — but without this list a
 *  token signed HS384 or HS512 with the SAME secret verifies here, and this was the only one of the three verify sites
 *  in the tree left unpinned (`relay/tokens.ts` and `lib/auth.ts` were both pinned this lane). Spelled once and used
 *  by both the mint and the verify, so the two can never drift apart. */
const ALGORITHMS = ["HS256"] as const;

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production")
      throw new Error("AUTH_SECRET environment variable is required in production");
    return new TextEncoder().encode("dev-insecure-secret-change-me");
  }
  return new TextEncoder().encode(secret);
}

/** Mint a check-in token for a fixture. Caller supplies the expiry (end of
 *  the fixture's local day — reuse endOfLocalDay from device-links). */
export async function mintCheckinToken(fixtureId: string, expiresAt: Date): Promise<string> {
  return new SignJWT({ fid: fixtureId })
    .setProtectedHeader({ alg: ALGORITHMS[0], typ: TYP })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey());
}

/**
 * Organiser mint (editor session only, device-links rule): sign a check-in
 * token for the fixture, valid until the end of the fixture's local day
 * (V305 venue lane: division override → org timezone → UTC).
 */
export async function createCheckinLink(
  auth: AuthCtx,
  fixtureId: string,
): Promise<{ token: string; expires_at: string }> {
  if (auth.via !== "session" || !auth.userId) {
    throw new HttpError(403, "Check-in codes can only be managed with a session login");
  }
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<{ id: string; division_id: string; status: string }[]>`
      select id, division_id, status from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    // Check-in is an arrival tool: mint only before play starts (the UI hides
    // the button then too — this is the enforcement, not the hiding).
    if (fixture.status !== "scheduled") {
      throw new HttpError(422, `fixture is ${fixture.status} — check-in codes are minted before the match starts`);
    }
    // Venue lane (V305): division override → org timezone → UTC.
    const [settings] = await tx<{ tz: string }[]>`
      select coalesce(ss.tz, o.timezone, 'UTC') as tz
      from divisions d
      left join schedule_settings ss on ss.division_id = d.id
      left join organizations o on o.id = d.org_id
      where d.id = ${fixture.division_id}`;
    const expiresAt = endOfLocalDay(new Date(), settings?.tz ?? "UTC");
    const token = await mintCheckinToken(fixtureId, expiresAt);
    return { token, expires_at: expiresAt.toISOString() };
  });
}

/** Verify a check-in token → fixture id. Distinct codes: CHECKIN_EXPIRED for
 *  a stale QR (print from yesterday), CHECKIN_INVALID for everything else. */
export async function verifyCheckinToken(token: string): Promise<string> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, secretKey(), {
      typ: TYP,
      algorithms: [...ALGORITHMS],
    });
    if (protectedHeader.typ !== TYP || typeof payload.fid !== "string") {
      throw new Error("wrong token type");
    }
    return payload.fid;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_JWT_EXPIRED") {
      throw new HttpError(401, "This check-in code has expired — ask the organiser for today's", "CHECKIN_EXPIRED");
    }
    throw new HttpError(401, "This check-in code is not valid", "CHECKIN_INVALID");
  }
}
