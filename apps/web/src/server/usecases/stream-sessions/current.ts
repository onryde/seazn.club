import "server-only";
// The organiser's projection: latestRow and currentSession (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { StreamSessionCurrent } from "@/server/api-v1/schemas";
import {
  PHONE_LOST_LIVE_MINUTES,
  PHONE_SILENT_FLOOR_SECONDS,
  RECONNECT_QUIET_SECONDS,
  WARMING_TIMEOUT_MINUTES,
  tunable,
} from "@/server/relay/config";
import { lostCountdown } from "@/server/relay/domain/phone-lost";
import { fixtureReplayParts, sessionVideoUrl } from "@/server/youtube/parts";
import { creditBalance, neverLiveRefundStanding, restartAllowance } from "../stream-credits";
import { type Row, cols, d } from "./session-row";
import type { SessionDeps } from "./deps";
import { fixtureContext } from "./lookups";
import { outputSinceExpr } from "./ingest-poll";
import { phoneFactsOf, ask10PhoneOf } from "./phone-lost";
import { tickSession } from "./tick";

// ---------------------------------------------------------------------------
// Reads and the organiser's commands
// ---------------------------------------------------------------------------
export async function latestRow(fixtureId: string): Promise<Row | null> {
  const [row] = await sql<Row[]>`select ${cols()} from fixture_stream_sessions where fixture_id = ${fixtureId} order by created_at desc limit 1`;
  return row ?? null;
}

export async function currentSession(auth: AuthCtx, fixtureId: string, deps: SessionDeps): Promise<StreamSessionCurrent | null> {
  const { orgId } = await fixtureContext(fixtureId);
  if (orgId !== auth.orgId) throw new HttpError(404, "fixture not found");
  let row = await latestRow(fixtureId);
  if (!row) return null;

  // B: the organiser's poll IS a tick (§6.11) — expiry + one Machine observation, the coalesced ingest read, warming →
  // live, target_rejected and the phone-lost ends. T7 (A10): the projection below is built from what THAT tick observed,
  // exactly as it was from the block's own locals before the extraction.
  const { ingestState, outputObserved, coalescedSince, freshIngest, phoneReadFailed, camera } = await tickSession(row.id, deps, "poll");
  row = (await latestRow(fixtureId))!;

  const [target] = await sql<{ id: string; kind: StreamSessionCurrent["target"]["kind"]; label: string }[]>`
    select id, kind, label from org_stream_targets where id = ${row.target_id}`;
  const [fx] = await sql<{ stream_url: string | null; status: string }[]>`select stream_url, status from fixtures where id = ${fixtureId}`;
  const hb = row.last_heartbeat as { fps?: number | null; bitrateKbps?: number | null } | null;
  // D3: the session's OWN net spend — its consume row, less any refund linked to it. Neither a restart inside the reuse
  // window (no consume row) nor a refunded consume is "a credit used". Unlinked refunds name no session and never count.
  // Org-scoped as reuseWindowOpen's arithmetic is; the lookup itself rides V425's partial (session_id) index on every
  // poll rather than walking the org's whole ledger through (org_id, created_at).
  const [spend] = await sql<{ net: number }[]>`
    select coalesce(sum(delta), 0)::int as net from org_stream_credits
     where org_id = ${row.org_id} and session_id = ${row.id} and reason in ('consume', 'refund')`;
  // D3: `since` is when the destination last received (I1, B2 review): for a non-ok word, the first ingest_status event
  // after the last one that read `ok` — so a flip BETWEEN two non-ok words (unknown → connecting) is inside the same
  // not-receiving period and never restarts the 30 s clock; for `ok`, the first event after the last non-ok one. These
  // are the events the poll above already records on every change (Ruling 13). CLAMPED to the session's `live_at`. The
  // destination is not tried before the phone is live, and Cloudflare reads `unknown` (non-ok) all through warming,
  // so an unclamped run would start the 30 s clock during warming and warn on the first live render (review #9). While
  // live, `since` is therefore "non-ok while live". `greatest` ignores a null `live_at` (not live yet). Null for
  // composed sessions and whenever this poll did not read the output.
  // I-2a (controller ruling 2026-10-01, B5 re-review 2 §3): for a NON-ok word it is clamped to the phone's latest
  // RECONNECT as well — an ingest_status event INTO `connected` from anything else. The mirror of the live clamp: the
  // destination is not fed while the phone is silent either, so when the phone returns Cloudflare re-dials it, and a
  // clock carried over from the drop put the stream-key box up at once over a key that was fine. A drop never moves it
  // (the last connect predates the drop), so the phone box's timing is unchanged; the key box needs 30 s of the phone
  // sending with the destination still not receiving. An `ok` word's since is not clamped: a phone that came back
  // without the destination ever stopping never restarted its receiving.
  let output: StreamSessionCurrent["output"] = null;
  if (row.mode === "passthrough" && outputObserved !== null) {
    const sinceAt = coalescedSince !== undefined ? coalescedSince
      : ((await sql<{ since: Date | null }[]>`select ${outputSinceExpr(row.id, outputObserved === "ok")} as since`)[0]?.since ?? null);
    const since = new Date(sinceAt ?? deps.now());
    // M6: the elapsed on THIS clock, at this response — the client judges D3 on it, never on the browser's clock.
    output = { state: outputObserved, since: since.toISOString(), elapsedMs: Math.max(0, deps.now().getTime() - since.getTime()) };
  }
  const allowance = await restartAllowance(sql, { orgId: row.org_id, fixtureId, excludeSessionId: null }, deps.now());
  // W24 (§6.12, T9): the countdown to the end the tick will make, from the clocks the tick judges (phoneFactsOf: the
  // phone's beat, the last connected sample, first ingest) and the row's warming entry, on this response's clock, and
  // from the reading THIS tick judged on (controller rulings 2026-10-04: shown iff that end fires, naming the EARLIEST
  // end and its reason; lostCountdown gates each end on what it reads). Ask 10's clock is the tick's own mapping. A session with no phone (C-1: pairing_id null) has no phone rules, so it has no
  // countdown either.
  const facts = await phoneFactsOf(sql, row.id);
  const countdownOf = (chargeStands: boolean) => lostCountdown({
    state: row.state, firstIngestAt: facts!.first_ingest_at, warmingAt: d(row.warming_at), phoneBeatAt: facts!.phone_beat_at,
    read: { fresh: freshIngest, served: ingestState?.state ?? null, failed: phoneReadFailed }, lastConnectedSampleAt: facts!.last_connected_at,
    phone: ask10PhoneOf(facts!),
    // R2008, I1: a composed session's countdown is built from the camera facts THIS tick judged on (null: no rule could fire).
    camera: camera && { startedAt: d(row.started_at), liveOnceAt: camera.live_once_at, reconnectingSince: camera.reconnecting_since, waitedOnly: camera.waited_only, logBeganAt: camera.log_began_at, chargeStands },
  }, deps.now(), {
    silentFloorSeconds: tunable("PHONE_SILENT_FLOOR_SECONDS", PHONE_SILENT_FLOOR_SECONDS),
    lostMinutes: tunable("PHONE_LOST_LIVE_MINUTES", PHONE_LOST_LIVE_MINUTES), warmingMinutes: WARMING_TIMEOUT_MINUTES,
    quietSeconds: RECONNECT_QUIET_SECONDS,
  });
  let countdown = facts?.has_phone ? countdownOf(false) : null;
  // Free-gaps (owner ruling 2026-10-20): a never-live countdown asks the SAME question the end acts on — will the credit come back
  // (or was none taken), or does the charge stand? — and only a never-live countdown pays for the ledger read. It re-names itself
  // with the answer; every other countdown is untouched.
  if (countdown?.kind === "live" && countdown.reason === "camera_never_live") {
    const standing = await neverLiveRefundStanding(sql, { orgId: row.org_id, sessionId: row.id, fixtureId: row.fixture_id }, deps.now());
    if (standing.chargeStands) countdown = countdownOf(true);
  }
  return {
    id: row.id, fixtureId, mode: row.mode, state: row.state, desiredState: row.desired_state, failReason: row.fail_reason,
    overlay: row.mode === "composed" ? { themeId: row.theme_id, delayMs: row.overlay_delay_ms } : null,
    health: row.heartbeat_at ? { fps: hb?.fps ?? null, bitrateKbps: hb?.bitrateKbps ?? null, lastBeatAt: new Date(row.heartbeat_at).toISOString() } : null,
    ingest: ingestState, output,
    balance: await creditBalance(sql, row.org_id),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    replayUrl: fx?.stream_url ?? null,
    replayParts: await fixtureReplayParts(row.org_id, fixtureId),
    youtubeVideoUrl: await sessionVideoUrl(row.org_id, row.id),
    target: { id: target!.id, kind: target!.kind, label: target!.label },
    fixtureDecided: fx?.status === "decided" || fx?.status === "finalized",
    fixtureHeld: fx?.status === "needs_decision",
    endReason: row.end_reason,
    creditUsed: spend!.net < 0,
    // I-1 + W23 (T6b, A9(a)): admission's own question, on admission's own clock (startBroadcast asks `restartAllowance`
    // with deps.now()), so the tab's "free restart" and the gate that waives the balance cannot disagree. `restart` is the
    // allowance (null while no window is open) — the one restart field since T11 retired the derived boolean beside it.
    restart: allowance.windowOpen ? allowance : null,
    startCause: row.start_cause,
    countdown,
  };
}
