// Server-side Supabase Realtime: the one broadcast transport (`broadcast()`)
// and the subscriber-JWT mint for private topics.
//
// Supabase quotas: UNVERIFIED (CS-2). Nothing in the repo states them; each
// line below is a placeholder until it is read from the project's plan and
// written here as a docs commit (realtime push-nudges plan, CS-2):
//   - concurrent connections:            UNVERIFIED
//   - channels per connection:           UNVERIFIED
//   - channel joins per second:          UNVERIFIED
//   - messages per month (billed):       UNVERIFIED
//   - messages per broadcast request:    UNVERIFIED (`BROADCAST_CHUNK` assumes 100;
//                                        lower it if the plan's maximum is below that)
// A refused connection or join behaves like "Realtime down": every subscriber
// falls back to its poll, and a publish only ever logs a warning.
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
 * Where a server-side broadcast goes, or null when publishing is off.
 *
 * `REALTIME_PUBLISH=off` is the kill switch: local servers load the main
 * checkout's .env.local, whose Supabase URL + service-role key point at the STG
 * project, so every local e2e/smoke score event posted a real broadcast there
 * (~370k/day, 2026-11-03). Blanking the key instead would break
 * `supabaseAdmin()` storage uploads, which read the same variables.
 *
 * Read case- and whitespace-insensitively: the repo's .env.local carries
 * `REALTIME_PUBLISH=Off`, which an exact `=== "off"` read as "publish", so
 * local servers kept broadcasting to stg (T0.2 review, m5).
 */
function publishTarget(): { url: string; key: string } | null {
  if (process.env.REALTIME_PUBLISH?.trim().toLowerCase() === "off") return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

/** One message of a broadcast request, exactly as it goes on the wire. A
 *  message without `private` is joinable on a public channel by anyone holding
 *  the anon key; every new topic sends `private: true`. */
export type RealtimeMessage = { topic: string; event: string; payload: unknown; private?: true };

/** Messages per broadcast request. The API's per-request maximum is UNVERIFIED
 *  (CS-2 in the header); 100 is the design's assumption. */
export const BROADCAST_CHUNK = 100;

/**
 * The one server-side broadcast transport. Sends `messages` as POSTs of at most
 * `BROADCAST_CHUNK` each, one after another, each with the same headers and
 * `BROADCAST_TIMEOUT_MS` abort as every publisher before it. An empty list or
 * a null `publishTarget()` (kill switch, missing env) sends nothing.
 *
 * Fire-and-forget: never throws. A failed chunk warns
 * `[realtime] <label> broadcast failed (<status>)` — the HTTP status, or the
 * error's class name when the request itself failed — and the next chunk is
 * still sent. The warn line never carries a message body, an error message or
 * the service key: a body may hold a room's state, and a key in a log is a
 * leaked credential.
 */
export async function broadcast(messages: readonly RealtimeMessage[], label: string): Promise<void> {
  if (messages.length === 0) return;
  const target = publishTarget();
  if (!target) return;
  const { url, key } = target;
  for (let start = 0; start < messages.length; start += BROADCAST_CHUNK) {
    try {
      const body = JSON.stringify({ messages: messages.slice(start, start + BROADCAST_CHUNK) });
      const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          apikey: key,
        },
        body,
        signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
      });
      if (!res.ok) console.warn(`[realtime] ${label} broadcast failed (${res.status})`);
    } catch (err) {
      const name = err instanceof Error ? err.name : "error";
      if (name === "TimeoutError") {
        // An endpoint that let one chunk time out will not answer the next one either: waiting 3 s for each
        // remaining chunk would hold an awaiting caller for 3 s × chunks. Drop the rest and count them once.
        const left = Math.ceil((messages.length - start - BROADCAST_CHUNK) / BROADCAST_CHUNK);
        const skipped = left > 0 ? `, ${left} later chunk${left === 1 ? "" : "s"} skipped` : "";
        console.warn(`[realtime] ${label} broadcast failed (TimeoutError)${skipped}`);
        break;
      }
      console.warn(`[realtime] ${label} broadcast failed (${name})`);
    }
  }
}

export type FixtureUpdateReason = "event" | "finalize" | "schedule";
export type DivisionUpdateReason = "schedule" | "publish" | "start" | "score";

/** Why a capture phone is told to beat now (design §2.3). */
export const CAPTURE_NUDGE_REASONS = ["go-live", "stop", "replaced", "over", "next-match"] as const;
export type CaptureNudgeReason = (typeof CAPTURE_NUDGE_REASONS)[number];
/** Why a Match Day screen is told to re-read its day (design §3). */
export const MATCH_DAY_NUDGE_REASONS = ["score", "schedule", "call"] as const;
export type MatchDayNudgeReason = (typeof MATCH_DAY_NUDGE_REASONS)[number];
export type NudgeReason = CaptureNudgeReason | MatchDayNudgeReason;

export type CaptureTopic = `capture:${string}`;
export type MatchDayTopic = `match-day:${string}`;
export type DivisionTopic = `division:${string}`;

/** A family's id, refused when empty or blank: it names no pairing, code or division, and a policy's
 *  `'capture:' || ''` would bind a token for it to the bare `capture:` topic. The Error names the family only. */
function familyId(family: "capture" | "match day" | "division", what: string, id: string): string {
  if (id.trim() === "") throw new Error(`Realtime ${family}: the ${what} is blank`);
  return id;
}

/** Private topic of one capture pairing (V554 keys it on `capture_pairing_id`). */
export function captureTopic(pairingId: string): CaptureTopic {
  return `capture:${familyId("capture", "pairing id", pairingId)}`;
}
/** Private topic of one Match Day code (V555 keys it on `md_code_id`). */
export function matchDayTopic(codeId: string): MatchDayTopic {
  return `match-day:${familyId("match day", "code id", codeId)}`;
}
/** Topic of one division (V556 keys its private messages on `division_ids`). */
export function divisionTopic(divisionId: string): DivisionTopic {
  return `division:${familyId("division", "division id", divisionId)}`;
}

/** A score or schedule change on one fixture: private `state_changed`. */
export function fixtureMessage(fixtureId: string, reason: FixtureUpdateReason): RealtimeMessage {
  const payload = { v: Date.now(), reason, at: new Date().toISOString() };
  return { topic: `fixture:${fixtureId}`, event: "state_changed", payload, private: true };
}

/** A change on one division: `state_changed` for a score, `schedule_changed`
 *  for every other reason. Today the ONE public message; the private twin of
 *  the design's §4.3 dual-publish window is added beside it later (Task 14),
 *  which is why this returns a list. */
export function divisionMessages(divisionId: string, reason: DivisionUpdateReason): RealtimeMessage[] {
  return [
    {
      topic: divisionTopic(divisionId),
      event: reason === "score" ? "state_changed" : "schedule_changed",
      payload: { v: Date.now(), reason, at: new Date().toISOString() },
    },
  ];
}

/**
 * A nudge: a private ping `{v, reason, at}` that tells the subscriber to
 * re-read through its own read path (design §1). It carries no state, ids,
 * scores or URLs. The overloads tie each reason list to its family's topic,
 * so a Match Day reason on a capture topic does not compile.
 */
export function nudgeMessage(topic: CaptureTopic, reason: CaptureNudgeReason): RealtimeMessage;
export function nudgeMessage(topic: MatchDayTopic, reason: MatchDayNudgeReason): RealtimeMessage;
export function nudgeMessage(topic: CaptureTopic | MatchDayTopic, reason: NudgeReason): RealtimeMessage {
  return { topic, event: "nudge", payload: { v: Date.now(), reason, at: new Date().toISOString() }, private: true };
}

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
export async function publishFixtureUpdate(fixtureId: string, reason: FixtureUpdateReason): Promise<void> {
  await broadcast([fixtureMessage(fixtureId, reason)], `fixture ${fixtureId}`);
}

/**
 * Broadcast on `division:{id}`: schedule_changed after a schedule write
 * (doc 12 §2/§6 — two organisers on one board see each other's moves),
 * state_changed after a scoring write (reason "score") so division-wide
 * listeners like the slideshow refresh without one channel per fixture.
 * Fire-and-forget, never throws.
 */
export async function publishDivisionUpdate(divisionId: string, reason: DivisionUpdateReason): Promise<void> {
  let messages: RealtimeMessage[];
  try {
    messages = divisionMessages(divisionId, reason);
  } catch (err) {
    // A blank id (divisionTopic refuses it). Still fire-and-forget: callers `void` this, so it must not reject.
    console.warn(`[realtime] division ${divisionId} broadcast failed (${err instanceof Error ? err.name : typeof err})`);
    return;
  }
  await broadcast(messages, `division ${divisionId}`);
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
        // (review 2026-09-14, I7a). The parse error by NAME only: V8's message
        // quotes the input around the bad token, i.e. a piece of the private
        // key, and this error reaches log lines and Sentry (push nudges T5, m5).
        throw new Error(
          `Realtime JWT mint: SUPABASE_JWT_PRIVATE_KEY is not valid JWK JSON (${err instanceof Error ? err.name : "parse error"})`,
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

/** Claims `mintRealtimeToken` sets itself: RFC 7519 §4.1's registered claims,
 *  plus `role`, which is what Supabase authorises on. */
const MINT_OWNED_CLAIMS = ["role", "sub", "aud", "exp", "iat", "nbf", "iss", "jti"] as const;

/**
 * Mint a subscriber JWT for one private realtime topic family. Every family
 * gets the same header (`kid` when the key is asymmetric, so Realtime can pick
 * the JWKS entry), `aud` and `role: authenticated`, `iat` now, and
 * `exp = floor(expiresAt / 1000)`. `claims` is the family's OWN claim — one
 * name per family, never shared (the V452 rule): its realtime.messages policy
 * keys on that name alone. A claim the mint owns (`role`, `sub`, the times…)
 * is refused rather than silently overriding the mint's own value.
 */
export async function mintRealtimeToken({
  sub,
  claims,
  expiresAt,
}: {
  sub: string;
  claims: Record<string, unknown>;
  expiresAt: Date;
}): Promise<string> {
  const owned = MINT_OWNED_CLAIMS.filter((claim) => claim in claims);
  if (owned.length > 0) {
    throw new Error(`Realtime JWT mint: claims may not set ${owned.join(", ")}`);
  }
  const { key, alg, kid } = await resolveRealtimeMintKey();
  const header: { alg: typeof alg; typ: "JWT"; kid?: string } = { alg, typ: "JWT" };
  if (kid) header.kid = kid;
  return new SignJWT({ role: "authenticated", sub, ...claims })
    .setProtectedHeader(header)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .setAudience("authenticated")
    .sign(key);
}

/** Subscriber JWT for one capture pairing's private topic (`captureTopic`). */
export async function mintCaptureToken(pairingId: string, expiresAt: Date): Promise<string> {
  familyId("capture", "pairing id", pairingId);
  return mintRealtimeToken({ sub: `capture:${pairingId}`, claims: { capture_pairing_id: pairingId }, expiresAt });
}

/** Subscriber JWT for one Match Day code's private topic (`matchDayTopic`). */
export async function mintMatchDayToken(codeId: string, expiresAt: Date): Promise<string> {
  familyId("match day", "code id", codeId);
  return mintRealtimeToken({ sub: `md:${codeId}`, claims: { md_code_id: codeId }, expiresAt });
}

/** Subscriber JWT for the private `division:{id}` topics of one competition.
 *  `division_ids` is a JSON array even for one division (V556 matches with
 *  jsonb `?`, which reads nothing from a scalar); an empty list mints a token
 *  that authorises no topic. */
export async function mintDivisionToken(
  competitionId: string,
  divisionIds: readonly string[],
  expiresAt: Date,
): Promise<string> {
  // Each id is refused when blank; an empty LIST still mints (it authorises no topic — T0.1's ruling).
  for (const id of divisionIds) familyId("division", "division id", id);
  return mintRealtimeToken({
    sub: `public-competition:${competitionId}`,
    claims: { division_ids: [...divisionIds] },
    expiresAt,
  });
}

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
 * versa. `expiresAt` is the fixture's own deadline (DEADLINE_AFTER_MS, `windowFor`'s
 * `deadline`), not a flat TTL — the room's realtime subscription should never
 * outlive the window it was minted for (spec §12.1: "the realtime subscriber
 * JWT is issued per room load and expires at the deadline").
 */
export async function mintExternalPlayLobbyToken(
  fixtureId: string,
  subject: string,
  expiresAt: Date,
): Promise<string> {
  return mintRealtimeToken({ sub: subject, claims: { lobby_fixture_id: fixtureId }, expiresAt });
}

/** Tell the other lobby screen that Ready changed. Fire-and-forget. Through
 *  `broadcast()`, so it carries the 3 s timeout it lacked before (realtime
 *  push-nudges T0.1): a lobby click must not be held by an endpoint that
 *  never answers. */
export async function publishExternalPlayLobby(fixtureId: string): Promise<void> {
  await broadcast(
    [
      {
        topic: externalPlayLobbyTopic(fixtureId),
        event: "lobby_changed",
        payload: { v: Date.now() },
        private: true,
      },
    ],
    `lobby ${fixtureId}`,
  );
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

/** Push the room state to both players, and the board to spectators. Same
 *  transport and topic as `publishExternalPlayLobby` — the topic's realtime
 *  policy (V452) already admits a seated player, so no new policy.
 *  Fire-and-forget: never throws. */
export async function publishRoomBroadcast(fixtureId: string, body: RoomBroadcast): Promise<void> {
  // Publishing off or unconfigured: skip the spectators' projection too, so a
  // board nobody would be sent never warns.
  if (!publishTarget()) return;
  // A board the spectators' copy cannot read (not a FEN, a status nobody
  // declared) costs the spectators one push — never the players theirs.
  let spectator: PublicBoardPush | null = null;
  try {
    spectator = spectatorBoard(body);
  } catch (err) {
    console.warn(`[realtime] spectator board skipped for ${fixtureId}:`, err);
  }
  await broadcast(
    [
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
        : [{ topic: `fixture:${fixtureId}`, event: "board_state", payload: spectator, private: true as const }]),
    ],
    `room ${fixtureId}`,
  );
}

/**
 * Mint a subscriber JWT for a PUBLIC fixture channel (doc 09 §4). No user —
 * spectators are anonymous; entitlement (org `realtime` feature) is checked by
 * the route before minting. Short TTL: a spectator page re-requests freely.
 * `ttlSeconds` from now, as the `${ttl}s` lifetime it always had.
 */
export async function mintPublicFixtureToken(fixtureId: string, ttlSeconds = 3600): Promise<string> {
  return mintRealtimeToken({
    sub: `public:${fixtureId}`,
    claims: { fixture_id: fixtureId },
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  });
}
