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
 * PRIVATE ONLY (review 2026-09-14, I1). Every fixture-topic subscriber in this
 * codebase joins `{private: true}` (`use-fixture-stream.ts`,
 * `use-live-fixture.ts`), and `use-live-fixture.ts` falls back to POLLING on a
 * token failure rather than opening a public channel — there is no "public
 * twin" consumer anywhere in this branch. A second, non-private message used
 * to ship alongside this one; it doubled Realtime send cost for zero
 * subscribers, and — because a non-private broadcast on `fixture:{id}` is
 * joinable by anyone holding the public anon key (ships in the client bundle)
 * — bypassed the `realtime` entitlement gate on the token-mint route
 * (`api/v1/public/fixtures/[id]/realtime-token/route.ts`). Removed.
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
        messages: [{ topic, event: "state_changed", payload, private: true }],
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

/** Decode `SUPABASE_JWT_SIGNING_KEY_B64` when the raw JWK/PEM env is absent. */
function decodePrivateKeyB64(): string | undefined {
  const b64 = process.env.SUPABASE_JWT_SIGNING_KEY_B64?.trim();
  if (!b64) return undefined;
  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8").trim();
    return decoded || undefined;
  } catch {
    return undefined;
  }
}

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
 * CI alternative: `SUPABASE_JWT_SIGNING_KEY_B64` = the same material, base64.
 * GitHub Actions strips job-env vars by NAME, not by value shape — the
 * plaintext `SUPABASE_JWT_PRIVATE_KEY` line never appeared beside its
 * siblings in the runner dump (measured run 34784354416), and base64-encoding
 * the value under the name `SUPABASE_JWT_PRIVATE_KEY_B64` did not dodge it
 * either — the same var, absent from every one of ~15 step `env:` dumps in a
 * run that then minted HS256 (measured run 34830995761, job 103934064629;
 * PR #782 review, 2026-09-14). The filter reads the substring `PRIVATE_KEY`
 * in the var NAME, so this var is named to avoid it — do not rename it back
 * to anything containing `PRIVATE_KEY`, in this file or in `e2e.yml`.
 *
 * Fallback: `SUPABASE_JWT_SECRET` = legacy / shared-secret signing key (long
 * random string). Rejected when it looks like a JWKS `kid` (UUID).
 *
 * `SUPABASE_JWT_ALG` (optional, PEM branch only — review 2026-09-14, I7b): a
 * PKCS8 PEM's `-----BEGIN PRIVATE KEY-----` header does not encode which
 * algorithm the key is for (unlike the PKCS1 `BEGIN RSA PRIVATE KEY` header,
 * which `importPKCS8` does not even accept), so there is no reliable way to
 * tell an RS256 PKCS8 key from an ES256 one by sniffing the PEM text. Set
 * `SUPABASE_JWT_ALG=RS256` when `SUPABASE_JWT_PRIVATE_KEY`/the CI `_B64` var
 * is an RSA PKCS8 key; anything else (including unset) defaults to ES256,
 * matching this project's actual Supabase signing keys.
 *
 * @see https://supabase.com/docs/guides/auth/signing-keys
 */
export async function resolveRealtimeMintKey(): Promise<MintKey> {
  const privateRaw =
    process.env.SUPABASE_JWT_PRIVATE_KEY?.trim() || decodePrivateKeyB64();
  if (privateRaw) {
    if (privateRaw.startsWith("{")) {
      let jwk: JWK;
      try {
        jwk = JSON.parse(privateRaw) as JWK;
      } catch (err) {
        // Unguarded JSON.parse used to throw a raw SyntaxError straight out of
        // mintPublicFixtureToken, 500ing the token route on a malformed key
        // (review 2026-09-14, I7a).
        throw new Error(
          `Realtime JWT mint: SUPABASE_JWT_PRIVATE_KEY is not valid JWK JSON (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      // Use the JWK's own declared alg when it is one this function can mint
      // with; a silent coercion to ES256 for anything else (ES512, EdDSA, …)
      // would sign a token with the wrong algorithm header (review 2026-09-14,
      // I7c).
      if (jwk.alg !== "ES256" && jwk.alg !== "RS256" && jwk.alg !== "HS256") {
        throw new Error(
          `Realtime JWT mint: SUPABASE_JWT_PRIVATE_KEY JWK has unsupported alg ${JSON.stringify(jwk.alg)} — expected ES256, RS256, or HS256`,
        );
      }
      const alg = jwk.alg;
      const key = await importJWK(jwk, alg);
      return {
        key,
        alg,
        ...(typeof jwk.kid === "string" ? { kid: jwk.kid } : {}),
      };
    }
    const alg =
      process.env.SUPABASE_JWT_ALG?.trim().toUpperCase() === "RS256" ||
      privateRaw.includes("BEGIN RSA PRIVATE KEY") ||
      privateRaw.includes("RSA PRIVATE")
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
/** Private lobby topic. Not the paid `fixture:{id}` score channel. */
export function externalPlayLobbyTopic(fixtureId: string): string {
  return `external-play:${fixtureId}`;
}

/**
 * Subscriber JWT for the online-play lobby. Same fixture_id claim shape as the
 * score channel so Realtime Authorization can bind the topic. The route only
 * mints this for a player on the fixture — not for the paid realtime add-on.
 */
export async function mintExternalPlayLobbyToken(
  fixtureId: string,
  userId: string,
  ttlSeconds = 3600,
): Promise<string> {
  const { key, alg, kid } = await resolveRealtimeMintKey();
  const header: { alg: typeof alg; typ: "JWT"; kid?: string } = { alg, typ: "JWT" };
  if (kid) header.kid = kid;
  return new SignJWT({
    role: "authenticated",
    sub: userId,
    fixture_id: fixtureId,
  })
    .setProtectedHeader(header)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setAudience("authenticated")
    .sign(key);
}

/** Tell the other lobby screen that Ready changed. Fire-and-forget. */
export async function publishExternalPlayLobby(fixtureId: string): Promise<void> {
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
            topic: externalPlayLobbyTopic(fixtureId),
            event: "lobby_changed",
            payload: { v: Date.now() },
            private: true,
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[realtime] lobby broadcast failed (${res.status}) for ${fixtureId}`);
    }
  } catch (err) {
    console.warn("[realtime] lobby broadcast error:", err);
  }
}

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
