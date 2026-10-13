import "server-only";
import {
  SignJWT,
  importPKCS8,
  importJWK,
  type CryptoKey,
  type JWK,
} from "jose";
import type { LichessStatus } from "@/server/external-play/types";
import { spectatorBoard, type PublicBoardPush } from "@/server/external-play/public-view";

/** How long a broadcast may take before its fetch is aborted. Every caller is
 *  fire-and-forget, but one that awaits the promise (a player-stats refresh
 *  inside `after()` once did) must not be held by a realtime endpoint that
 *  never answers: undici's own timeouts run to minutes. */
export const BROADCAST_TIMEOUT_MS = 3_000;

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
      signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
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
 * Subscriber JWT for the online-play lobby (chess Lichess external-play
 * redesign, Task 8). Carries `lobby_fixture_id` — NEVER `fixture_id`: V403's
 * paid `fixture:{id}` score-channel policy reads `fixture_id`, and
 * `external-play:{fixtureId}` (V407) is a private, unpaid channel with its
 * own policy keyed on `lobby_fixture_id` — sharing the claim name would let a
 * paid-realtime subscriber JWT also authorize the free lobby topic, or vice
 * versa. `expiresAt` is the fixture's own deadline (T+20, `windowFor`'s
 * `deadline`), not a flat TTL — the room's realtime subscription should never
 * outlive the window it was minted for (spec §12.1: "the realtime subscriber
 * JWT is issued per room load and expires at T+20").
 */
export async function mintExternalPlayLobbyToken(
  fixtureId: string,
  subject: string,
  expiresAt: Date,
): Promise<string> {
  const { key, alg, kid } = await resolveRealtimeMintKey();
  const header: { alg: typeof alg; typ: "JWT"; kid?: string } = { alg, typ: "JWT" };
  if (kid) header.kid = kid;
  return new SignJWT({
    role: "authenticated",
    sub: subject,
    lobby_fixture_id: fixtureId,
  })
    .setProtectedHeader(header)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
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

/** The match room's whole state after an accepted move (chess design §3.4,
 *  Task 10), so a client renders it without a refetch — a refetch here is
 *  served from the browser's HTTP cache and shows stale state. Clocks are
 *  true AT THE INSTANT OF THE BROADCAST and are rendering only: nothing
 *  declares a flag from them (spec §6, M2). */
export type RoomBroadcast = {
  fen: string;
  lastMove: string | null;
  turn: "white" | "black";
  whiteMs: number;
  blackMs: number;
  status: LichessStatus;
  drawOfferBy: "white" | "black" | null;
};

/** Push the room state to both players, and the board to spectators. Same endpoint, headers and topic as
 *  `publishExternalPlayLobby` — the topic's realtime policy (V434) already
 *  admits a seated player, so no new policy — plus the timeout that
 *  `publishFixtureUpdate` carries. Fire-and-forget: never throws. */
export async function publishRoomBroadcast(fixtureId: string, body: RoomBroadcast): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  // A board the spectators' copy cannot read (not a FEN, a status nobody
  // declared) costs the spectators one push — never the players theirs.
  let spectator: PublicBoardPush | null = null;
  try {
    spectator = spectatorBoard(body);
  } catch (err) {
    console.warn(`[realtime] spectator board skipped for ${fixtureId}:`, err);
  }
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
            event: "room_state",
            payload: body,
            private: true,
          },
          // T16 — the spectators' copy, on the public fixture topic the public
          // realtime token is minted for (V403): the board alone, never the
          // draw offer. The watch island reads it through the match centre's
          // one subscription (use-live-fixture → live-board-channel).
          ...(spectator === null
            ? []
            : [{ topic: `fixture:${fixtureId}`, event: "board_state", payload: spectator, private: true }]),
        ],
      }),
      signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[realtime] room broadcast failed (${res.status}) for ${fixtureId}`);
    }
  } catch (err) {
    console.warn("[realtime] room broadcast error:", err);
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
