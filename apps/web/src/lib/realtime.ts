import "server-only";
import {
  SignJWT,
  importPKCS8,
  importJWK,
  type CryptoKey,
  type JWK,
} from "jose";

/**
 * Broadcast a state_changed event on `fixture:{id}` after a v2 scoring write
 * (doc 08 §4 — publish after commit). Same transport as tournaments; fire-and-
 * forget, never throws.
 *
 * Two messages on purpose (measured 2026-09-12):
 * - `private: true` for scorepad / private subscribers.
 * - a public twin for the spectator overlay when the minted public JWT fails
 *   Realtime auth (`JwtSignatureError`) and the client falls back to a public
 *   channel (slideshow pattern). Private-only publish left the overlay on the
 *   15 s poll; public-only never reaches private scorepad subscribers.
 */
export async function publishFixtureUpdate(
  fixtureId: string,
  reason: "event" | "finalize" | "schedule",
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const payload = { v: Date.now(), reason, at: new Date().toISOString() };
    const topic = `fixture:${fixtureId}`;
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
      body: JSON.stringify({
        messages: [
          { topic, event: "state_changed", payload, private: true },
          { topic, event: "state_changed", payload },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[realtime] fixture broadcast failed (${res.status}) for ${fixtureId}`);
    }
  } catch (err) {
    console.warn("[realtime] fixture broadcast error:", err);
  }
}

/**
 * Broadcast on `division:{id}`: schedule_changed after a schedule write
 * (doc 12 §2/§6 — two organisers on one board see each other's moves),
 * state_changed after a scoring write (reason "score") so division-wide
 * listeners like the slideshow refresh without one channel per fixture.
 * Fire-and-forget, never throws.
 */
export async function publishDivisionUpdate(
  divisionId: string,
  reason: "schedule" | "publish" | "start" | "score",
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
      body: JSON.stringify({
        messages: [
          {
            topic: `division:${divisionId}`,
            event: reason === "score" ? "state_changed" : "schedule_changed",
            payload: { v: Date.now(), reason, at: new Date().toISOString() },
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[realtime] division broadcast failed (${res.status}) for ${divisionId}`);
    }
  } catch (err) {
    console.warn("[realtime] division broadcast error:", err);
  }
}

type MintKey = {
  key: CryptoKey | Uint8Array;
  alg: "ES256" | "RS256" | "HS256";
  kid?: string;
};

/**
 * Resolve signing material for spectator realtime JWTs.
 *
 * This project uses Supabase **asymmetric** signing keys (JWKS ES256). The
 * value historically stored as `SUPABASE_JWT_SECRET` was the key's `kid`
 * (UUID), not an HMAC secret — minting HS256 with it yields
 * `JwtSignatureError` on private Realtime channels (measured 2026-09-12).
 *
 * Preferred: `SUPABASE_JWT_PRIVATE_KEY` = PKCS8 PEM or private JWK JSON for an
 * imported signing key (Supabase cannot export the private half — import your
 * own). Optional `SUPABASE_JWT_KID` when using PEM.
 *
 * Fallback: `SUPABASE_JWT_SECRET` = legacy / shared-secret signing key (long
 * random string). Rejected when it looks like a JWKS `kid` (UUID).
 *
 * @see https://supabase.com/docs/guides/auth/signing-keys
 */
export async function resolveRealtimeMintKey(): Promise<MintKey> {
  const privateRaw = process.env.SUPABASE_JWT_PRIVATE_KEY?.trim();
  if (privateRaw) {
    if (privateRaw.startsWith("{")) {
      const jwk = JSON.parse(privateRaw) as JWK;
      const alg = (jwk.alg === "RS256" ? "RS256" : "ES256") as "ES256" | "RS256";
      const key = await importJWK(jwk, alg);
      return {
        key,
        alg,
        ...(typeof jwk.kid === "string" ? { kid: jwk.kid } : {}),
      };
    }
    const alg =
      privateRaw.includes("BEGIN RSA PRIVATE KEY") || privateRaw.includes("RSA PRIVATE")
        ? "RS256"
        : "ES256";
    const key = await importPKCS8(privateRaw, alg);
    const kid = process.env.SUPABASE_JWT_KID?.trim();
    return { key, alg, ...(kid ? { kid } : {}) };
  }

  const secret = process.env.SUPABASE_JWT_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "Realtime JWT mint: set SUPABASE_JWT_PRIVATE_KEY (ES256 PKCS8/JWK) or a real SUPABASE_JWT_SECRET shared secret",
    );
  }

  // UUID-shaped values that match the project's JWKS kid are a known misconfig
  // (HS256 mint → JwtSignatureError on private Realtime). Still mint so the
  // public-channel spectator path keeps working until SUPABASE_JWT_PRIVATE_KEY
  // is set; do not treat this as healthy.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secret)) {
    console.error(
      "[realtime] SUPABASE_JWT_SECRET looks like a JWKS kid (UUID), not a signing secret. " +
        "Private Realtime auth will fail until SUPABASE_JWT_PRIVATE_KEY is set " +
        "(import an ES256 signing key in the dashboard, then paste the private JWK/PEM).",
    );
  }

  return { key: new TextEncoder().encode(secret), alg: "HS256" };
}

/**
 * Mint a subscriber JWT for a PUBLIC fixture channel (doc 09 §4). No user —
 * spectators are anonymous; entitlement (org `realtime` feature) is checked by
 * the route before minting. Short TTL: a spectator page re-requests freely.
 *
 * Header must include `kid` when signing with an asymmetric key so Realtime
 * can pick the matching JWKS entry.
 */
export async function mintPublicFixtureToken(
  fixtureId: string,
  ttlSeconds = 3600,
): Promise<string> {
  const { key, alg, kid } = await resolveRealtimeMintKey();
  const header: { alg: typeof alg; typ: "JWT"; kid?: string } = { alg, typ: "JWT" };
  if (kid) header.kid = kid;
  return new SignJWT({
    role: "authenticated",
    sub: `public:${fixtureId}`,
    fixture_id: fixtureId,
  })
    .setProtectedHeader(header)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setAudience("authenticated")
    .sign(key);
}
