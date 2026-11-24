import "server-only";
// The relay job's facts: the session as the Machine reads it (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { RelayJobSession } from "@/server/api-v1/schemas";
import { resolveTemplate } from "@/components/overlay/template-registry";
import { RELAY_HEARTBEAT_INTERVAL_MS, relayOutputProfile } from "@/server/relay/config";
import { isTerminal, type Session } from "@/server/relay/domain/session";
import { readCameraPlayback, readFirstInput } from "@/server/relay/secret-columns";
import { mintRelayToken, relayTokenExpiry, verifyRelayToken } from "@/server/relay/tokens";
import { log } from "@/server/logger";
import { readRow } from "./session-row";
import type { SessionDeps } from "./deps";
import { destinationRowOf, readSessionDestination } from "./destination";
import { reconcileSession } from "./expiry";

/** Seazn Task 36b: how long a Machine that met `inputs_not_ready` is told to wait. A few seconds — an input create is ~1-3 s —
 *  and the compositor retries on its own back-off whatever this says (1 s, doubling to 10 s, no attempt cap). */
export const INPUTS_NOT_READY_RETRY_AFTER_SECONDS = 3;

async function jobSession(sessionId: string, token: string, deps: SessionDeps): Promise<Session> {
  await verifyRelayToken(token, { sid: sessionId, scope: "relay-job" });
  const s = await reconcileSession(sessionId, deps);                        // B: the Machine's own reads tick the policy too
  if (!s) throw new HttpError(404, "session not found");
  if (isTerminal(s.state)) throw new HttpError(410, "session has ended", "SESSION_ENDED");
  return s;
}

/** R2002: the `data` of GET /api/internal/relay/sessions/{sid}, typed as the relay-job.v1 contract's session (STRICT:
 *  a key this returns that the contract does not declare is a tsc error here, and C07 refuses it on the wire). */
export async function sessionFactsForJob(sessionId: string, token: string, deps: SessionDeps): Promise<RelayJobSession> {
  const s = await jobSession(sessionId, token, deps);
  const row = (await readRow(sessionId))!;
  const pageToken = await mintRelayToken({ sid: sessionId, scope: "relay-page", expiresAt: relayTokenExpiry(s) });
  const base = { sessionId, fixtureId: s.fixtureId, mode: s.mode, themeId: row.theme_id, overlayDelayMs: row.overlay_delay_ms, maxDurationMinutes: s.maxDurationMinutes, pageToken };
  if (s.mode !== "composed") {
    // Passthrough has no Machine; its shape is today's, for contract completeness. T11: an API-backed session's is its
    // broadcast's pooled key — the same destination its Cloudflare output carries.
    const target = (await sql.begin(async (tx) => readSessionDestination(tx, await destinationRowOf(tx, sessionId)))) as { url: string; streamKey: string };
    return { ...base, target };
  }
  // #981 follow-up (C07 review; coordinator decision): the overlay page is `/overlay/fixtures/<fixtureId>`, and a fixture
  // deleted mid-session (V410 `on delete set null`) left the compositor `/overlay/fixtures/null`, which it accepted. A
  // composed session with no fixture has no page to render, so its facts are refused — 404 FIXTURE_GONE, a status C07's
  // GET table maps to `Refused` (exit 78, fatal config: the host does not restart it). Passthrough has no page; its facts
  // still answer `fixtureId: null`.
  if (s.fixtureId === null) {
    log.warn({ sid: sessionId, orgId: s.orgId, state: s.state }, "stream session: a composed session's fixture has been deleted — its job facts are refused");
    throw new HttpError(404, "the session's fixture has been deleted", "FIXTURE_GONE");
  }
  const fixtureId = s.fixtureId;
  // R2004 (spec §5.3): the Machine READS the camera (Input A) over SRT playback and PUBLISHES to the programme (Input B)
  // over RTMPS. The destination is a Cloudflare output on B, so its key is never read here and never reaches the Machine.
  const { programme, playback, sportKey } = (await sql.begin(async (tx) => ({
    programme: await readFirstInput(tx, sessionId, "programme"),
    playback: await readCameraPlayback(tx, sessionId),
    sportKey: (await tx<{ sport_key: string }[]>`select sport_key from fixture_stream_sessions where id = ${sessionId}`)[0]!.sport_key,
  }))) as { programme: Awaited<ReturnType<typeof readFirstInput>>; playback: Awaited<ReturnType<typeof readCameraPlayback>>; sportKey: string };
  // Seazn Task 36b: a composed session's Machine is asked for WHILE its inputs are made, so it can boot and read before the
  // credentials are stored (they are written in one transaction, both or neither). That is not a fault: while the session is
  // still `provisioning`, a missing credential is answered 503 `inputs_not_ready` with a Retry-After, never partial facts and
  // never a 404/410/500 (the compositor's GET table treats 404/410 as fatal and retries a 5xx on its back-off).
  if (s.state === "provisioning" && (!programme?.rtmps || !playback)) {
    log.info({ sid: sessionId, orgId: s.orgId }, "stream session: the Machine asked for its facts before the inputs' credentials were stored — answered inputs_not_ready");
    throw new HttpError(503, "the session's inputs are not ready yet; try again", "inputs_not_ready", undefined, { "Retry-After": String(INPUTS_NOT_READY_RETRY_AFTER_SECONDS) });
  }
  // Task 36b review m2: an `ending` session whose credentials never landed (the write was rolled back and the stop owns the row)
  // is over as far as a Machine is concerned. A typed 410 — the compositor's GET table maps it to `Gone`, a clean exit — and not
  // the plain Error below, which is a 500 and a Sentry report on every poll until the stop completes.
  if (s.state === "ending" && (!programme?.rtmps || !playback)) throw new HttpError(410, "session has ended", "SESSION_ENDED");
  // Past `provisioning` a composed session always has them (storing them precedes `provisioned`). A row without either is
  // refused by name — never a session served with a guessed or empty credential.
  if (!programme?.rtmps) throw new Error(`stream session ${sessionId}: a composed session has no programme input credential to publish to`);
  if (!playback) throw new Error(`stream session ${sessionId}: a composed session has no camera playback credential to read`);
  // R2004 decision 5 / 7: the overlay page the compositor renders. `sid` because verifyRelayToken needs the expected sid;
  // `template` RESOLVED from the session's copy, so the URL always names a live, non-retired template.
  const overlay = new URL(`/overlay/fixtures/${encodeURIComponent(fixtureId)}`, deps.appUrl);
  overlay.search = new URLSearchParams({
    sid: sessionId, st: pageToken, host: "compositor", delay: String(row.overlay_delay_ms), template: resolveTemplate(row.theme_id, sportKey).id,
  }).toString();
  return RelayJobSession.parse({
    ...base,
    target: { url: programme.rtmps.url, streamKey: programme.rtmps.streamKey },
    input: { protocol: "srt", url: playback.url, streamId: playback.streamId, passphrase: playback.passphrase },
    output: relayOutputProfile(),
    heartbeatIntervalMs: RELAY_HEARTBEAT_INTERVAL_MS,
    overlayUrl: overlay.toString(),
  });
}
