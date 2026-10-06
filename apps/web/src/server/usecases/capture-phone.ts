import "server-only";
// server/usecases/capture-phone.ts — the phone-facing use-cases of capture QR v2 (§6.3): the descriptor (`getCode`,
// T8a), the beat (`postBeat`, T8b), the phone's own start (`postStart`, T8c), the match's Remote scoring link
// (`postScoringLink`, W27), and the waiting-fields builder both answers share, so the two never disagree (R7: ONE owner
// of the length fit).
//
// R1 (§17.1): the V430 tables are FORCE RLS with no policy, so every read here goes through the non-tenant `sql` —
// never `withTenant` — and the org is the code row's (`resolveStreamCode`). Each answer is built field by field, never
// by spreading a row. The sealed ingest secrets are opened (`readFirstInput`) only when `cred` is about to be served,
// inside this request, and never logged.
import { sql, type Tx } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { DEVICE_LINK_MINT_LIMIT, rateLimit } from "@/lib/rate-limit";
import { DESTINATION_NOT_ALLOWED, TARGET_UNREADABLE } from "@/lib/stream-destinations";
import { captureError } from "@/lib/sentry";
import { getDictionary, t, toLocale } from "@/lib/i18n";
import { OVERLAY_KEY_PARAM } from "@/lib/realtime-purpose";
import { defaultThemeFor } from "@/components/overlay/theme-registry";
import { CaptureRefusalError, codeEnded } from "@/server/api-v1/capture-http";
import {
  CaptureDescriptor, CaptureWaiting, type CaptureBeat, type CaptureBeatAnswer, type CaptureCred, type CaptureStartBody,
  CaptureScoringLinkOk, type CaptureStage, type CaptureStartedBy, type CaptureStartOk,
} from "@/server/api-v1/capture-schemas";
import type { z } from "zod";
import { log } from "@/server/logger";
import { overlayKeyFor } from "@/server/overlay/overlay-key";
import {
  DEAD_PHONE_TAKEOVER_SECONDS, HOLD_SLACK_SECONDS, HOT_THERMAL_STATUS, INGEST_TIMEOUT_SECONDS, LOW_BATTERY_PERCENT,
  PHONE_BEAT_RETENTION_HOURS, POLL_FAR_SECONDS, QR_PREFERRED_DEFAULT, SRT_LATENCY_MS, WARMING_TIMEOUT_MINUTES,
  srtEnabled, streamIngestHost, streamPlaybackHost, tunable,
} from "@/server/relay/config";
import { beatAnswer, wireBeatAnswer } from "@/server/relay/domain/beat-answer";
import { wireEndReason, type DbEndReason } from "@/server/relay/domain/end-reason";
import { type ClaimOutcome, deadForTakeover, decideClaim, isNotResponding } from "@/server/relay/domain/pairing";
import { pollSecondsFor } from "@/server/relay/domain/poll-seconds";
import { ACTIVE_STATES, isActive, type FailReason, type SessionState } from "@/server/relay/domain/session";
import { slotState } from "@/server/relay/domain/slot";
import { normaliseCode } from "@/server/relay/domain/stream-code";
import { ingestCred } from "@/server/relay/ingest-cred";
import type { IngestState } from "@/server/relay/ports";
import { readFirstInput } from "@/server/relay/secret-columns";
import { recordEvent } from "@/server/relay/telemetry";
import { captureStageOf } from "./capture-stage";
import { provideDeviceLinkForPhone, type PhoneScoringLink } from "./device-links";
import { fixtureStreamTarget, resolveStreamCode, type ResolvedCode } from "./stream-codes";
import { apply, lastConnectedSampleAt, startBroadcast, tickSession, type SessionDeps } from "./stream-sessions";

type Descriptor = z.infer<typeof CaptureDescriptor>;

/** PR-1 carries one camera: every other slot is `422 invalid` (T41). */
const SLOT = 0;

/** The contract's own maxima (R7), read off the zod twins — never retyped. */
const LABEL_MAX = maxOf(CaptureWaiting.shape.label.maxLength, "label");
const DEST_MAX = maxOf(CaptureWaiting.shape.destinationName.unwrap().maxLength, "destinationName");
const SESSION_SHAPE = CaptureDescriptor.options[1];   // warming — every session branch shares SessionFields
const HOLD_MAX = Math.min(
  maxOf(SESSION_SHAPE.shape.holdWindowSeconds.shape.srt.maxValue, "holdWindowSeconds.srt"),
  maxOf(SESSION_SHAPE.shape.holdWindowSeconds.shape.rtmps.maxValue, "holdWindowSeconds.rtmps"),
);
function maxOf(v: number | null | undefined, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`capture contract: ${field} has no maximum to fit to`);
  return v;
}

/**
 * R7: the ONE owner of the length fit, for every label and destinationName on the wire (the descriptor and the beat
 * answer). Within `max` → unchanged. Over → exactly `max` UTF-16 units (what zod's `.max` measures), ending in a single
 * "…", without splitting a surrogate pair (a pair that would straddle the cut is dropped whole).
 */
export function fitText(s: string, max: number): string {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`fitText: max must be a positive whole number, got ${max}`);
  if (s.length <= max) return s;
  let cut = max - 1;   // room for the one "…" (a single UTF-16 unit)
  const last = s.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;   // a high surrogate whose low half is past the cut
  return `${s.slice(0, cut)}…`;
}

/** §6.4: `holdWindowSeconds`. RTMPS is the ingest capability's; SRT is `INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS`
 *  computed HERE, because the hold is Cloudflare's per-input recording timeout, not a property of the protocol — the
 *  capability's `srt` stays null (A17, FP13: unmeasured). Both must fit the contract (capture request d), or this
 *  refuses by name rather than serve a value the phone's parser rejects. */
export function holdWindowFor(capability: { rtmps: number; srt: number | null }): { srt: number; rtmps: number } {
  const w = { srt: INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS, rtmps: capability.rtmps };
  for (const [k, v] of Object.entries(w)) {
    if (!Number.isInteger(v) || v < 1 || v > HOLD_MAX) throw new RangeError(`holdWindowSeconds.${k} = ${v} is outside the contract's 1..${HOLD_MAX}`);
  }
  return w;
}

/** §6.4: `OAUTH_BASE_URL || NEXT_PUBLIC_BASE_URL`, both set on every deployment; only when neither is set (local, CI)
 *  the deps' app url. Never read off a request header where the environment sets it. */
function captureOrigin(deps: SessionDeps): string {
  return (process.env.OAUTH_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || deps.appUrl).replace(/\/+$/, "");
}

const unavailable = (why: string): CaptureRefusalError => new CaptureRefusalError(503, "unavailable", `streaming is unavailable (${why})`);

/** The fixture's latest session and its phone: the descriptor follows it (§6.3.1). The phone is the session's pairing
 *  while that pairing has not ended — its CODE's state is not read (C-2, spec §17.11). */
type LatestSession = {
  id: string; state: SessionState; end_reason: DbEndReason | null; fail_reason: FailReason | null; theme_id: string | null;
  warming_at: Date | null; created_at: Date; max_duration_minutes: number; phone: string | null; phone_slot: number | null;
};
async function latestSession(fixtureId: string): Promise<LatestSession | null> {
  const [row] = await sql<LatestSession[]>`
    select s.id, s.state, s.end_reason, s.fail_reason, s.theme_id, s.warming_at, s.created_at, s.max_duration_minutes,
           p.phone, p.slot as phone_slot
      from fixture_stream_sessions s
      left join fixture_stream_pairings p on p.id = s.pairing_id and p.ended_at is null
     where s.fixture_id = ${fixtureId}
     order by s.created_at desc, s.id desc
     limit 1`;
  return row ?? null;
}

/** The waiting fields (§6.4), shared by the descriptor's every shape and the beat answer's common fields (§6.3.3). */
export type CaptureCommon = {
  code: string; label: string; venueTimezone: string; scheduledStart: number | null; pollSeconds: number;
  autoAllowed: boolean; destinationName: string | null; overlayUrl: string | null; scoreUpdates: "realtime" | "polled";
  heartbeatUrl: string; startUrl: string;
};

type FixtureCtx = {
  fixture_no: number; status: string; scheduled_at: Date | null; finished_at: Date | null; competition_id: string;
  sport_key: string; tz: string; default_locale: string | null; home_name: string | null; away_name: string | null;
};

/**
 * The waiting fields, each from its §6.4 source. `open` is the fixture's OPEN session's state (its cadence row, §6.6),
 * null when none; `themeId` the latest session's theme (the overlay opens on the sport's default otherwise).
 */
export async function captureCommon(
  c: { orgId: string; fixtureId: string; code: string },
  s: { open: SessionState | null; themeId: string | null },
  deps: SessionDeps,
  now: Date,
): Promise<CaptureCommon> {
  // One statement for the fixture's facts: the V305 venue lane (division → org → UTC, the checkin-token.ts query), the
  // org's locale (W25) and both sides' names. The destination is `fixtureStreamTarget`'s — the one the start opens on
  // (B8 review I-1), so the phone names exactly what it would stream to.
  const [ctx] = await sql<FixtureCtx[]>`
    select f.fixture_no, f.status, f.scheduled_at, f.finished_at, d.competition_id, d.sport_key,
           coalesce(ss.tz, o.timezone, 'UTC') as tz, o.default_locale,
           h.display_name as home_name, a.display_name as away_name
      from fixtures f
      join divisions d on d.id = f.division_id
      join organizations o on o.id = d.org_id
      left join schedule_settings ss on ss.division_id = d.id
      left join entrants h on h.id = f.home_entrant_id
      left join entrants a on a.id = f.away_entrant_id
     where f.id = ${c.fixtureId} and d.org_id = ${c.orgId}`;
  // The code cascades with its fixture (T35), so a resolved code's fixture is there; one deleted in between reads as an
  // ended code, never a 500.
  if (!ctx) throw codeEnded();
  const target = await fixtureStreamTarget(sql, { orgId: c.orgId, fixtureId: c.fixtureId });

  const label = ctx.home_name !== null && ctx.away_name !== null
    ? `${ctx.home_name} v ${ctx.away_name}`
    : t(await getDictionary(toLocale(ctx.default_locale), "ui"), "breadcrumb.match", { no: ctx.fixture_no });

  const origin = captureOrigin(deps);
  let overlayUrl: string | null = null;
  let keyed = false;
  if (await hasFeature(c.orgId, "streaming.overlay", ctx.competition_id)) {
    const key = overlayKeyFor(c.fixtureId);
    keyed = key !== null;
    const theme = s.themeId ?? defaultThemeFor(ctx.sport_key);
    overlayUrl = `${origin}/overlay/fixtures/${c.fixtureId}?style=${encodeURIComponent(theme)}${key !== null ? `&${OVERLAY_KEY_PARAM}=${encodeURIComponent(key)}` : ""}`;
  }

  return {
    code: c.code,
    label: fitText(label, LABEL_MAX),
    venueTimezone: ctx.tz,
    scheduledStart: ctx.scheduled_at === null ? null : Math.floor(new Date(ctx.scheduled_at).getTime() / 1000),
    pollSeconds: pollSecondsFor({
      open: s.open, fixtureStatus: ctx.status, scheduledAt: ctx.scheduled_at === null ? null : new Date(ctx.scheduled_at),
      finished: ctx.finished_at !== null,
    }, now),
    autoAllowed: false,   // §6.4: PR-1 always false; PR-2 wires the fixture's switch (§7.1)
    destinationName: target === null ? null : fitText(target.label, DEST_MAX),
    overlayUrl,
    scoreUpdates: keyed ? "realtime" : "polled",
    heartbeatUrl: `${origin}/api/v1/capture/codes/${c.code}/beats`,
    startUrl: `${origin}/api/v1/capture/codes/${c.code}/start`,
  };
}

/** The waiting shape's fields, picked by name (the strict wire): `scheduledStart` is OMITTED when null (§6.4), and so
 *  is W28's `stage` when no code can be produced (`captureStageOf`) — on every shape, since every shape spreads this. */
function waitingFieldsOf(w: CaptureCommon, stage: CaptureStage | null) {
  return {
    code: w.code, label: w.label, venueTimezone: w.venueTimezone,
    ...(w.scheduledStart !== null ? { scheduledStart: w.scheduledStart } : {}),
    pollSeconds: w.pollSeconds, autoAllowed: w.autoAllowed, destinationName: w.destinationName, overlayUrl: w.overlayUrl,
    heartbeatUrl: w.heartbeatUrl, startUrl: w.startUrl,
    ...(stage !== null ? { stage } : {}),
  };
}

/**
 * `GET /api/v1/capture/codes/{code}` (§6.3.1). With a `phone`, the answer follows the fixture's latest session:
 *  - open in warming, live or ending → the session shape; `cred` ONLY when `phone` is that session's current phone
 *    (on `slot`), otherwise ABSENT (the phone reads "open, not current" and claims);
 *  - ended after reaching warming → completed / failed with its wire `endReason`, never `cred`;
 *  - requested or provisioning (cadence 5 s), ended before warming, or no session → the waiting shape.
 * Without a `phone`: always the waiting shape. A served `cred` counts once on the session (`credentials_served_*`).
 */
export async function getCode(
  rawCode: string, tok: string, q: { slot: number; phone: string | null }, deps: SessionDeps, now: Date,
): Promise<Descriptor> {
  const resolved = await resolveStreamCode(rawCode, tok, "get", q.phone, now);
  if (q.slot !== SLOT) throw new CaptureRefusalError(422, "invalid", `slot ${String(q.slot)} is not served (PR-1 carries slot ${SLOT})`);
  const code = normaliseCode(rawCode)!;   // resolve refused every code that does not normalise
  const latest = await latestSession(resolved.fixtureId);
  const open = latest !== null && isActive(latest.state) ? latest.state : null;
  const common = await captureCommon({ orgId: resolved.orgId, fixtureId: resolved.fixtureId, code }, { open, themeId: latest?.theme_id ?? null }, deps, now);
  // W28: the descriptor's own read (the beat answer carries no stage), recomputed on every GET.
  const stage = await captureStageOf(resolved.orgId, resolved.fixtureId);

  const sessionShape = q.phone !== null && latest !== null && (
    latest.state === "warming" || latest.state === "live" || latest.state === "ending"
    || ((latest.state === "completed" || latest.state === "failed") && latest.warming_at !== null)
  );
  if (!sessionShape) return { state: "waiting", ...waitingFieldsOf(common, stage) };
  return sessionDescriptor(resolved, latest!, q, common, stage, deps, now);
}

async function sessionDescriptor(
  resolved: ResolvedCode, s: LatestSession, q: { slot: number; phone: string | null }, common: CaptureCommon, stage: CaptureStage | null,
  deps: SessionDeps, now: Date,
): Promise<Descriptor> {
  // A deployment with no relay has no capability to read and no playback to name: the phone waits and retries.
  if (deps.drivers.disabled) throw unavailable("relay_disabled");
  const playbackHost = streamPlaybackHost();
  if (playbackHost === null) {
    log.error({ sid: s.id, orgId: resolved.orgId }, "capture descriptor: STREAM_PLAYBACK_HOST is not set on a real-driver deployment");
    throw unavailable("playback_unconfigured");
  }
  const srtOn = srtEnabled();
  const openState = s.state === "warming" || s.state === "live" || s.state === "ending";
  const wantCred = openState && s.phone !== null && s.phone === q.phone && s.phone_slot === q.slot;

  const { uid, cred, preferred } = wantCred
    ? await serveCred(resolved, s.id, srtOn, now)
    : { uid: await inputUidOf(s.id), cred: null, preferred: srtOn ? QR_PREFERRED_DEFAULT : ("rtmps" as const) };
  if (uid === null) throw unavailable("no ingest input");

  const session = {
    sid: s.id, preferred,
    playbackUrl: `https://${playbackHost}/${uid}/manifest/video.m3u8`,
    holdWindowSeconds: holdWindowFor(deps.drivers.ingest.capabilities.holdWindowSeconds),
    maxDurationMinutes: s.max_duration_minutes,
    // A8: the SAME anchor as the warming timeout — warming_at, or created_at for a session opened before V430.
    warmingDeadline: Math.floor((new Date(s.warming_at ?? s.created_at).getTime() + WARMING_TIMEOUT_MINUTES * 60_000) / 1000),
    scoreUpdates: common.scoreUpdates,
    ...waitingFieldsOf(common, stage),
  };
  const withCred = cred !== null ? { cred } : {};
  switch (s.state) {
    case "warming": return { state: "warming", ...session, ...withCred };
    case "live": return { state: "live", ...session, ...withCred };
    case "ending": return { state: "ending", ...session, ...withCred, endReason: wireEndReason({ endReason: s.end_reason, failReason: s.fail_reason }) };
    case "completed": return { state: "completed", ...session, endReason: wireEndReason({ endReason: s.end_reason, failReason: s.fail_reason }) };
    case "failed": return { state: "failed", ...session, endReason: wireEndReason({ endReason: s.end_reason, failReason: s.fail_reason }) };
    default: throw new RangeError(`capture descriptor: no session shape for ${s.state}`);
  }
}

/** The input's provider uid, for `playbackUrl` — no secret is opened for it. */
async function inputUidOf(sessionId: string): Promise<string | null> {
  const [row] = await sql<{ ingest_input_id: string | null }[]>`
    select ingest_input_id from fixture_stream_inputs where session_id = ${sessionId} order by slot asc limit 1`;
  return row?.ingest_input_id ?? null;
}

/** Open the session's ingest secrets and serve them (§6.4), counting the serve under the session row's lock (two
 *  concurrent GETs cannot lose a count; the first-served time is coalesced and never moves). A credential that cannot
 *  be served is 503 — never a cred-less answer, which its own phone would read as "open, not current" and re-claim. */
async function serveCred(
  resolved: ResolvedCode, sessionId: string, srtOn: boolean, now: Date,
): Promise<{ uid: string | null; cred: CaptureCred; preferred: "srt" | "rtmps" }> {
  return sql.begin(async (tx) => {
    await tx`select id from fixture_stream_sessions where id = ${sessionId} for update`;
    const input = await readFirstInput(tx, sessionId);
    if (!input || input.rtmps === null || input.srt === null) throw unavailable("ingest credentials missing");
    const r = ingestCred({ srt: input.srt, rtmps: input.rtmps }, { ingestHost: streamIngestHost(), srtEnabled: srtOn, latencyMs: SRT_LATENCY_MS });
    if (!r.ok) {
      log.error({ sid: sessionId, orgId: resolved.orgId, which: r.which }, "capture descriptor: ingest_host_unexpected");
      throw unavailable("ingest_host_unexpected");
    }
    await tx`
      update fixture_stream_sessions
         set credentials_served_first_at = coalesce(credentials_served_first_at, ${now}),
             credentials_served_count = credentials_served_count + 1
       where id = ${sessionId}`;
    return { uid: input.ingestInputId, cred: r.cred, preferred: r.preferred };
  }) as Promise<{ uid: string | null; cred: CaptureCred; preferred: "srt" | "rtmps" }>;
}

// ---------------------------------------------------------------------------------------------------------------------
// T8b — the beat: `POST /api/v1/capture/codes/{code}/beats` (§6.3.2, §6.3.3, §6.5, §6.8.2, §6.10)
// ---------------------------------------------------------------------------------------------------------------------

type Beat = z.infer<typeof CaptureBeat>;
type BeatAnswer = z.infer<typeof CaptureBeatAnswer>;
type Exec = Tx | typeof sql;

/** The fixture's open session (one per fixture, V421) as the beat reads it. */
type OpenRow = { id: string; state: SessionState; first_ingest_at: Date | null; start_cause: CaptureStartedBy; pairing_id: string | null };
type PairingRow = { id: string; code_id: string; phone: string; last_beat_at: Date; answered_poll_seconds: number };

async function openSessionOf(exec: Exec, fixtureId: string): Promise<OpenRow | null> {
  const [row] = await exec<OpenRow[]>`
    select id, state, first_ingest_at, start_cause, pairing_id from fixture_stream_sessions
     where fixture_id = ${fixtureId} and state in ${sql([...ACTIVE_STATES])}
     order by created_at desc, id desc limit 1`;
  return row ?? null;
}

/** "C", the slot's current pairing (§5.5). While a session is open, the phone that HOLDS it is C — its pairing, ended
 *  or not by nothing but a takeover, the operator's Stop or the code's cascade, wherever its code (C-2: a reissue never
 *  makes the open session's phone non-current, so the code's state is not read). Otherwise the current pairing on the
 *  caller's own code, the one current pairing per (code, slot) of V430's partial unique index. */
async function holderOf(exec: Exec, codeId: string, open: OpenRow | null): Promise<PairingRow | null> {
  if (open?.pairing_id) {
    const [held] = await exec<PairingRow[]>`
      select id, code_id, phone, last_beat_at, answered_poll_seconds from fixture_stream_pairings
       where id = ${open.pairing_id} and ended_at is null`;
    if (held) return held;
  }
  const [cur] = await exec<PairingRow[]>`
    select id, code_id, phone, last_beat_at, answered_poll_seconds from fixture_stream_pairings
     where code_id = ${codeId} and slot = ${SLOT} and ended_at is null`;
  return cur ?? null;
}

const slotOf = (holder: PairingRow | null, open: OpenRow | null, dead: boolean) =>
  slotState({ hasCurrent: holder !== null, open: open === null ? null : { state: open.state, firstIngestAt: open.first_ingest_at }, dead });

/** §6.10's sanitising: `raw` is the beat through an ALLOWLIST of the contract's fields, picked by name, so a widened
 *  caller object never reaches storage. `at` is normalised to UTC (R5). `device` rides only on a claim beat (G0-e). */
function rawOf(b: Beat, atUtc: string): Record<string, unknown> {
  return {
    code: b.code, slot: b.slot, phone: b.phone, claim: b.claim, sid: b.sid, at: atUtc, state: b.state, cause: b.cause,
    notReady: b.notReady, startFailed: b.startFailed, stopped: b.stopped, mode: b.mode, transport: b.transport,
    bitrateKbps: b.bitrateKbps, delivery: b.delivery, deliveredLagS: b.deliveredLagS, audioOk: b.audioOk,
    battery: b.battery === null ? null : { percent: b.battery.percent, charging: b.battery.charging, drainPctPerHour: b.battery.drainPctPerHour },
    thermal: b.thermal, dataUsedMB: b.dataUsedMB, appVersion: b.appVersion,
    ...(b.claim !== null && b.device !== null ? { device: { model: b.device.model } } : {}),
    ...(b.endReason !== undefined ? { endReason: b.endReason } : {}),
  };
}

/** §6.10's derived flags, each from its config.ts threshold. `notResponding` is §6.9's W8 condition, judged on the
 *  pairing's PREVIOUS beat: this beat ends a stretch the panel must still see. */
function flagsOf(b: Beat, notResponding: boolean): string[] {
  const f: string[] = [];
  if (b.battery !== null && b.battery.percent < LOW_BATTERY_PERCENT && !b.battery.charging) f.push("battery_low");
  if (b.thermal !== null && b.thermal >= HOT_THERMAL_STATUS) f.push("hot");
  if (b.delivery === "stalled") f.push("stalled");
  if (b.notReady !== null) f.push("not_ready");
  if (notResponding) f.push("not_responding");
  return f;
}
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** §6.10: a history `minute` row when the pairing has none inside this window. */
const HISTORY_MINUTE_MS = 60_000;

/** §6.10's history, inside a SAVEPOINT: a failure is logged and the beat still answers (the sampleBeat isolation rule).
 *  A `change` row on a state or flag change; otherwise a `minute` row when the pairing has written no row this minute
 *  (a change row stands in for that minute's sample: one row, of kind `change`). Every row written when the minute was
 *  due purges the pairing's history past PHONE_BEAT_RETENTION_HOURS. All on the SERVER clock — `at` is never a clock. */
async function storeHistory(
  tx: Tx, h: { orgId: string; pairingId: string; sessionId: string | null; beat: Beat; raw: Record<string, unknown>; flags: string[] }, now: Date,
): Promise<void> {
  try {
    await tx.savepoint(async (sp) => {
      const [prev] = await sp<{ phone_state: string | null; flags: string[] }[]>`
        select phone_state, flags from fixture_stream_phone_beats where pairing_id = ${h.pairingId} order by id desc limit 1`;
      const [recent] = await sp<{ n: number }[]>`
        select count(*)::int as n from fixture_stream_phone_beats
         where pairing_id = ${h.pairingId} and recorded_at > ${new Date(now.getTime() - HISTORY_MINUTE_MS)}`;
      const minuteDue = recent!.n === 0;
      const changed = !prev || prev.phone_state !== h.beat.state || !sameSet(prev.flags, h.flags);
      if (!changed && !minuteDue) return;
      const b = h.beat;
      await sp`
        insert into fixture_stream_phone_beats
          (org_id, pairing_id, session_id, recorded_at, kind, phone_state, flags, battery_pct, charging, thermal,
           bitrate_kbps, delivery, delivered_lag_s, raw)
        values (${h.orgId}, ${h.pairingId}, ${h.sessionId}, ${now}, ${changed ? "change" : "minute"}, ${b.state}, ${h.flags},
                ${b.battery?.percent ?? null}, ${b.battery?.charging ?? null}, ${b.thermal}, ${b.bitrateKbps}, ${b.delivery},
                ${b.deliveredLagS}, ${sp.json(h.raw as never)})`;
      if (minuteDue) {
        await sp`delete from fixture_stream_phone_beats
                  where pairing_id = ${h.pairingId} and recorded_at < ${new Date(now.getTime() - PHONE_BEAT_RETENTION_HOURS * 3_600_000)}`;
      }
    });
  } catch (err) {
    log.warn({ err: String(err), pairingId: h.pairingId, orgId: h.orgId }, "capture beat: the history row was not written — the beat is stored and answered");
    captureError(err, { orgId: h.orgId, route: "capture.beat.history" });
  }
}

/** What the beat's transaction decided, for the steps that run after it commits. */
type Decided = {
  claim: ClaimOutcome;
  callerCurrent: boolean;            // after the claim, BEFORE this beat's own `ended` (§6.3.3 row 2)
  mine: PairingRow | null;           // the caller's pairing, when it is current
  stop: string | null;               // the sid this beat stops (T21, T23), applied after the commit
  tickSid: string | null;            // the open session this beat ticks (§6.11): its phone's beat naming it
};

/**
 * `POST /api/v1/capture/codes/{code}/beats` (§6.3.2). `body` has passed the strict contract (`CaptureBeat`, its refines
 * included); the route answers 422 otherwise. In order:
 *  1. resolve the code (C1, C1b) — a `new` claim is a `claim` call, which an ended code never serves;
 *  2. the claim (T1–T7) under the code row's lock, so two claims are decided one after the other (§6.5);
 *  3. the beat stored (§6.10) on the SERVER clock, history in a savepoint;
 *  4. `ended` (T21/T22) or `stopped: X` (T23/T24/T24a), decided under the same lock and applied after the commit;
 *  5. the open session ticked (§6.11) when its phone's beat names it;
 *  6. the answer — `wireBeatAnswer`'s, sent exactly, its pollSeconds stored as the answered cadence.
 */
export async function postBeat(rawCode: string, tok: string, body: Beat, deps: SessionDeps, now: Date): Promise<BeatAnswer> {
  const resolved = await resolveStreamCode(rawCode, tok, body.claim === "new" ? "claim" : "beat", body.phone, now);
  const code = normaliseCode(rawCode)!;
  if (body.slot !== SLOT) throw new CaptureRefusalError(422, "invalid", `slot ${body.slot} is not served (PR-1 carries slot ${SLOT})`);
  if (body.code !== code) throw new CaptureRefusalError(422, "invalid", "the body names another code than the path");
  const atUtc = new Date(body.at).toISOString();
  const raw = rawOf(body, atUtc);

  // T4 (§6.5): a `new` claim on a LIVE slot held by another phone may be a dead-phone takeover. Its second conjunct is a
  // FRESH read taken through the tick (claimIngestPoll coalesces it with any poll in the interval), and its third the
  // last connected sample BEFORE that read — each conjunct its own evidence. Both run on the pool, before the lock.
  let takeoverFacts: { fresh: IngestState | undefined; lastConnectedAt: Date | null } | null = null;
  if (body.claim === "new") {
    const open = await openSessionOf(sql, resolved.fixtureId);
    const holder = await holderOf(sql, resolved.codeId, open);
    if (open !== null && holder !== null && holder.phone !== body.phone && slotOf(holder, open, false) === "live") {
      try {
        const lastConnectedAt = await lastConnectedSampleAt(sql, open.id);
        const obs = await tickSession(open.id, deps, "beat");
        takeoverFacts = { fresh: obs.freshIngest, lastConnectedAt };
      } catch (err) {
        // No fresh read: nothing proves the holder gone, so the claim is judged as on a live slot (T3).
        log.error({ err: String(err), sid: open.id, orgId: resolved.orgId }, "capture beat: the takeover read failed — the claim is judged without it");
        captureError(err, { orgId: resolved.orgId, route: "capture.beat.takeover_read", extra: { sid: open.id } });
      }
    }
  }

  const decided = (await sql.begin(async (tx) => {
    if (body.claim !== null || body.stopped !== null) {
      await tx`select id from fixture_stream_codes where id = ${resolved.codeId} for update`;
    }
    const open = await openSessionOf(tx, resolved.fixtureId);
    const holder = await holderOf(tx, resolved.codeId, open);
    // A14 (T4): judged under the lock on the holder's LOCKED last beat. No fresh read, or an `unknown` one, proves
    // nothing (m-3's rule): the slot stays live and the claim is refused.
    const dead = takeoverFacts !== null && open !== null && holder !== null && open.first_ingest_at !== null
      && takeoverFacts.fresh !== undefined && takeoverFacts.fresh !== "unknown"
      && deadForTakeover({
        lastBeatAt: new Date(holder.last_beat_at), freshReadConnected: takeoverFacts.fresh === "connected",
        lastConnectedAt: takeoverFacts.lastConnectedAt, liveSince: new Date(open.first_ingest_at),
      }, now, tunable("DEAD_PHONE_TAKEOVER_SECONDS", DEAD_PHONE_TAKEOVER_SECONDS));
    const claim = decideClaim({ kind: body.claim, caller: body.phone, current: holder, slot: slotOf(holder, open, dead) });
    const callerCurrent = claim.result === "accept" || claim.result === "takeover" || claim.result === "none";
    const lockOpen = async () => { if (open) await tx`select id from fixture_stream_sessions where id = ${open.id} for update`; };
    const event = async (sessionId: string, type: string, payload: Record<string, unknown>) =>
      recordEvent(tx, { sessionId, orgId: resolved.orgId, source: "phone", kind: "event", type, actorUserId: null, occurredAt: now, payload });
    const insertMine = async (): Promise<PairingRow> => {
      const [p] = await tx<PairingRow[]>`
        insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, device_model, claimed_at, last_beat_at, answered_poll_seconds)
        values (${resolved.orgId}, ${resolved.codeId}, ${SLOT}, ${body.phone}, ${body.claim}, ${body.device?.model ?? null}, ${now}, ${now}, ${POLL_FAR_SECONDS})
        returning id, code_id, phone, last_beat_at, answered_poll_seconds`;
      return p!;
    };

    // 2. The claim decides who holds the slot, and nothing else.
    let mine: PairingRow | null = callerCurrent ? holder : null;
    if (claim.result === "accept" && holder === null) mine = await insertMine();
    if (claim.result === "accept" && holder !== null && holder.code_id !== resolved.codeId) {
      // B6 review I-2 (T1/T5 × C-2): the HOLDER rescanned — the open session's phone, its pairing on an older (reissued)
      // code, claiming on THIS one (the Revoke copy tells operators to scan the new QR). It keeps the slot, and its
      // pairing AND the open session move onto this code, so the phone lives entirely on the code it scanned: after the
      // session ends it is this code's current pairing (T20 `waiting`, never `replaced`), and its start reads it here.
      // The new row carries the old one's beat state; the old one ends `replaced`, handing over through replaced_by.
      const [moved] = await tx<PairingRow[]>`
        insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, device_model, claimed_at, last_beat_at,
                                             answered_poll_seconds, last_beat, not_ready, start_failed, mode, app_version, phone_state)
        select org_id, ${resolved.codeId}, slot, phone, ${body.claim}, device_model, ${now}, last_beat_at,
               answered_poll_seconds, last_beat, not_ready, start_failed, mode, app_version, phone_state
          from fixture_stream_pairings where id = ${holder.id}
        returning id, code_id, phone, last_beat_at, answered_poll_seconds`;
      await tx`update fixture_stream_pairings set ended_at = ${now}, end_cause = 'replaced', replaced_by = ${moved!.id} where id = ${holder.id}`;
      if (open && open.pairing_id === holder.id) {
        await lockOpen();
        await tx`update fixture_stream_sessions set pairing_id = ${moved!.id} where id = ${open.id}`;
        open.pairing_id = moved!.id;   // no event: T1 names none, and the old row's replaced_by is the audit trail
      }
      mine = moved!;
    }
    if (claim.result === "takeover") {
      await tx`update fixture_stream_pairings set ended_at = ${now}, end_cause = 'replaced' where id = ${holder!.id}`;
      mine = await insertMine();
      await tx`update fixture_stream_pairings set replaced_by = ${mine.id} where id = ${holder!.id}`;
      if (open && open.pairing_id === holder!.id) {
        await lockOpen();
        await tx`update fixture_stream_sessions set pairing_id = ${mine.id} where id = ${open.id}`;
        open.pairing_id = mine.id;
        await event(open.id, "phone_takeover", { dead: claim.row === "T4", pairingId: mine.id, replacedPairingId: holder!.id });
      }
    }
    if (claim.result === "taken" && open) {
      await lockOpen();
      await event(open.id, "claim_refused", { claimRow: claim.row });
    }

    // 3. The beat stored — only a current caller's; any other beat changes nothing (T6, T7, T22).
    const held = mine !== null && open !== null && open.pairing_id === mine.id;
    if (mine !== null) {
      const notResponding = held && isNotResponding({ held, lastBeatAt: new Date(mine.last_beat_at), answeredPoll: mine.answered_poll_seconds }, now);
      await tx`
        update fixture_stream_pairings
           set last_beat = ${tx.json(raw as never)}, last_beat_at = ${now}, phone_state = ${body.state}, not_ready = ${body.notReady},
               start_failed = ${body.startFailed}, mode = ${body.mode}, app_version = ${body.appVersion},
               device_model = coalesce(${body.claim !== null && body.device !== null ? body.device.model : null}, device_model)
         where id = ${mine.id}`;
      if (held && body.sid === open!.id) {
        await lockOpen();
        await tx`update fixture_stream_sessions set phone_beat = ${tx.json(raw as never)}, phone_beat_at = ${now} where id = ${open!.id}`;
      }
      await storeHistory(tx, { orgId: resolved.orgId, pairingId: mine.id, sessionId: held ? open!.id : null, beat: body, raw, flags: flagsOf(body, notResponding) }, now);
    }

    // 4. The stops, judged AFTER the claim (ask 7); applied once this transaction commits (apply takes its own locks).
    let stop: string | null = null;
    if (body.state === "ended" && held && body.sid === open!.id) {
      // T21: the operator's Stop from the session's phone ends the broadcast AND the pairing (a rescan is owed).
      await tx`update fixture_stream_pairings set ended_at = ${now}, end_cause = 'operator_stopped' where id = ${mine!.id}`;
      await lockOpen();
      await event(open!.id, "phone_stop", { pairingId: mine!.id });
      stop = open!.id;
    } else if (body.stopped !== null) {
      const [x] = await tx<{ id: string; state: SessionState; pairing_id: string | null }[]>`
        select id, state, pairing_id from fixture_stream_sessions where id = ${body.stopped} and fixture_id = ${resolved.fixtureId}`;
      if (x && isActive(x.state)) {
        // T23 / T24a (§6.8.2): X is held by the current phone iff X's pairing is the slot's current pairing.
        const currentNow = callerCurrent ? mine : holder;
        const heldByCurrent = currentNow !== null && x.pairing_id === currentNow.id;
        const stopApplies = callerCurrent || !heldByCurrent;
        if (stopApplies) stop = x.id;
        else {
          await tx`select id from fixture_stream_sessions where id = ${x.id} for update`;
          await event(x.id, "stop_ignored", { held: true });
        }
      }
    }
    // 5's subject: §6.11 "every beat from the session's phone" — the phone HOLDING the broadcast, naming its sid.
    const tickSid = held && body.sid === open!.id ? open!.id : null;
    return { claim, callerCurrent, mine, stop, tickSid } satisfies Decided;
  })) as Decided;

  if (decided.stop !== null) {
    await apply(decided.stop, (s) => (isActive(s.state) ? { type: "stop", reason: "operator_stopped" } : null), deps,
      { userId: resolved.issuedBy, source: "phone" });
  }
  if (decided.tickSid !== null) {
    try {
      await tickSession(decided.tickSid, deps, "beat");
    } catch (err) {
      // The beat is stored and the answer below reads the rows: a failed tick is reported, never a failed beat.
      log.error({ err: String(err), sid: decided.tickSid, orgId: resolved.orgId }, "capture beat: the session tick failed — the beat is answered");
      captureError(err, { orgId: resolved.orgId, route: "capture.beat.tick", extra: { sid: decided.tickSid } });
    }
  }

  // 6. The answer, from the rows as they now stand.
  const latest = await latestSession(resolved.fixtureId);
  const open = await openSessionOf(sql, resolved.fixtureId);
  const holder = await holderOf(sql, resolved.codeId, open);
  const named = body.sid ?? body.stopped;
  let namedEnded: { sid: string; endReason: ReturnType<typeof wireEndReason> } | null = null;
  if (named !== null) {
    const [x] = await sql<{ id: string; state: SessionState; end_reason: DbEndReason | null; fail_reason: FailReason | null }[]>`
      select id, state, end_reason, fail_reason from fixture_stream_sessions where id = ${named} and fixture_id = ${resolved.fixtureId}`;
    if (x && (x.state === "ending" || x.state === "completed" || x.state === "failed")) {
      namedEnded = { sid: x.id, endReason: wireEndReason({ endReason: x.end_reason, failReason: x.fail_reason }) };
    }
  }
  const core = beatAnswer({
    claim: body.claim === null ? null : decided.claim,
    callerCurrent: decided.callerCurrent,
    namedEnded,
    slot: slotOf(holder, open, false),
    open: open === null ? null : { sid: open.id, startedBy: open.start_cause },
  });
  const common = await captureCommon(
    { orgId: resolved.orgId, fixtureId: resolved.fixtureId, code },
    { open: open?.state ?? null, themeId: latest?.theme_id ?? null }, deps, now,
  );
  const answer = wireBeatAnswer(core, {
    label: common.label, scheduledStart: common.scheduledStart, autoAllowed: common.autoAllowed,
    destinationName: common.destinationName, overlayUrl: common.overlayUrl, pollSeconds: common.pollSeconds,
  });
  if (decided.mine !== null && answer.pollSeconds !== undefined) {
    await sql`update fixture_stream_pairings set answered_poll_seconds = ${answer.pollSeconds} where id = ${decided.mine.id}`;
  }
  return answer;
}

// ---------------------------------------------------------------------------
// T8c — the phone's own start (§6.3.4, §6.7)
// ---------------------------------------------------------------------------

const alreadyLive = (open: { id: string; start_cause: CaptureStartedBy }): CaptureRefusalError =>
  new CaptureRefusalError(409, "already_live", "a session is already running for this match", { sid: open.id, startedBy: open.start_cause });
const noDestination = (why: string): CaptureRefusalError => new CaptureRefusalError(409, "no_destination", why);

/**
 * §6.7.2: the one start path's refusal → the phone's answer. The phone keys its copy on `code` and never shows the
 * message (a developer string). `{alreadyLive}` asks the caller to name the running session (its sid AND who started
 * it); `null` is not a phone refusal, and the caller rethrows it (a logged 500).
 */
export function phoneStartRefusal(err: unknown): CaptureRefusalError | { alreadyLive: string | null } | null {
  if (err instanceof PaymentRequiredError) return new CaptureRefusalError(403, "not_entitled", `the plan lacks ${err.featureKey}`);
  if (!(err instanceof HttpError)) return null;
  switch (err.code) {
    case "overlay_required": return new CaptureRefusalError(403, "not_entitled", "phone streaming needs the overlay tier");
    case "active_session": {
      const sid = err.extra?.sessionId;
      return { alreadyLive: typeof sid === "string" ? sid : null };
    }
    case "no_credits": return new CaptureRefusalError(402, "no_credit", "this organisation has no match credits");
    // The pre-pick is held by another match, refused by the allowlist, or its key will not open: the organiser picks or
    // fixes the destination (the panel names which).
    case "target_in_use": return noDestination("the picked destination is streaming another match");
    case DESTINATION_NOT_ALLOWED: return noDestination("the picked destination is no longer allowed");
    case TARGET_UNREADABLE: return noDestination("the picked destination's saved key cannot be read");
    case "storage_exhausted":
    case "ingest_unavailable": return new CaptureRefusalError(503, "unavailable", `the stream cannot start: ${err.code}`);
    // An assumption made a guard: a phone start passes phonePresent: true because the caller IS the current phone (T12,
    // checked first), so W5 cannot answer it. Refused by name, never mapped to an answer the phone would act on.
    case "phone_not_paired":
      throw new Error("postStart: startBroadcast answered phone_not_paired to a phone start, which passes phonePresent: true");
  }
  // admit's target_not_found (the pre-pick vanished between the read and the row lock) has no code.
  if (err.status === 404 && err.code === undefined && err.message === "stream target not found") return noDestination("the picked destination is gone");
  return null;
}

/**
 * `POST /capture/codes/{code}/start` (§6.3.4): the CURRENT phone starts its match on the organiser's pre-pick, through
 * the ONE start path (`startBroadcast`, cause `operator`, phonePresent: true, the claim's pairing, attributed to the
 * code's `issued_by` — T6 m-2). In order:
 *  - resolve as a `start` call: an ENDED code starts nothing, even for its open session's phone (C1b) → 401;
 *  - T12: a phone that is not §5.5's C → 409 replaced (first, so it is never told a sid). C is `holderOf`, the SAME
 *    holder a beat decides by: while a session is open, the phone holding it, wherever its code (C-2 — after a
 *    reissue the session's phone is still current on the new code); else the current pairing on this code;
 *  - T13: a session already running → 409 already_live {sid, startedBy} (F-A5: before the destination);
 *  - the destination (§6.7.3): `fixtureStreamTarget`'s — the saved choice, or with none saved the oldest; a choice cleared
 *    or archived, or no live destination at all, is none → 409 no_destination (the panel shows the same, B8 review I-1);
 *  - startBroadcast; its refusals through §6.7.2's table (`phoneStartRefusal`) — a session that opened between this
 *    read and the admission is its active_session, named the same way.
 * Not idempotent by design: a retry after a lost 200 meets 409 already_live naming the same sid.
 */
export async function postStart(rawCode: string, tok: string, body: CaptureStartBody, deps: SessionDeps, now: Date): Promise<CaptureStartOk> {
  const resolved = await resolveStreamCode(rawCode, tok, "start", body.phone, now);
  const open = await openSessionOf(sql, resolved.fixtureId);
  const current = await holderOf(sql, resolved.codeId, open);
  if (!current || current.phone !== body.phone) throw new CaptureRefusalError(409, "replaced", "this phone is not the slot's current phone");
  if (open) throw alreadyLive(open);
  const pick = await fixtureStreamTarget(sql, { orgId: resolved.orgId, fixtureId: resolved.fixtureId });
  if (!pick) throw noDestination("this match has no destination to stream to");
  try {
    const { sessionId } = await startBroadcast(
      { userId: resolved.issuedBy, orgId: resolved.orgId, source: "phone", pairingId: current.id },
      resolved.fixtureId,
      { targetId: pick.id, startCause: "operator", phonePresent: true },
      deps,
    );
    return { sid: sessionId };
  } catch (err) {
    const mapped = phoneStartRefusal(err);
    if (mapped === null) throw err;
    if (mapped instanceof CaptureRefusalError) throw mapped;
    const [named] = mapped.alreadyLive === null ? [] : await sql<{ id: string; start_cause: CaptureStartedBy }[]>`
      select id, start_cause from fixture_stream_sessions where id = ${mapped.alreadyLive}`;
    const open = named ?? await openSessionOf(sql, resolved.fixtureId);
    if (open) throw alreadyLive(open);
    // The running session ended between admission and this read: nothing to name — the phone's "try again".
    throw new CaptureRefusalError(503, "unavailable", "a session was running and has just ended; try again");
  }
}

// ---------------------------------------------------------------------------
// W27 — the phone's Remote scoring link (§6.3.5, owner sign-off 2026-10-06)
// ---------------------------------------------------------------------------

/** W27: the origin the URL is built on must be https — the agreed pattern is `^https://[^/]+/score/dl_…`. Checked BEFORE
 *  the link is provided, so a deployment that would serve a URL the phone's parser rejects writes nothing. */
const HTTPS_ORIGIN = /^https:\/\/[^/]+$/;

/**
 * `POST /capture/codes/{code}/scoring-link` (§6.3.5, W27): the match's Remote scoring link, for the slot's CURRENT phone.
 * In order:
 *  - resolve as a `start` call: an ENDED code serves nothing here, even to its open session's phone (C1b) → 401;
 *  - the start's own holder check (T12, `holderOf`), session or none: any other phone → 409 replaced;
 *  - the origin is https (the contract's pattern), else 503 unavailable with nothing written;
 *  - the console's mint budget, `DEVICE_LINK_MINT_LIMIT` per client IP in its own `dlmint:` bucket ("a reissue IS a
 *    mint: one bucket, one number") → 429 rate_limited. Spent HERE, past the tok and holder checks (review M2): a caller
 *    without the tok, or a replaced phone, never drains the bucket the organiser's console shares. Every call that
 *    reaches it spends it, a re-shown link included — as the console's ensure does;
 *  - `provideDeviceLinkForPhone`: the console's plan gate (→ 402 not_entitled), then under the fixture's link lock a
 *    finished match (→ 409 match_finished, nothing written), else the live sealed link or a new one — NEVER revoking
 *    (the owner's rule: "must not remove or replace any existing QR"). A missing DEVICE_LINK_KEK → 503 unavailable.
 * 200 `{url}` = `captureOrigin()` + `/score/` + the secret. The URL is a credential: it is never logged, and it is
 * stored nowhere new (the row holds the hash and the sealed envelope, as every console link does).
 */
export async function postScoringLink(
  rawCode: string, tok: string, body: CaptureStartBody, deps: SessionDeps, now: Date, clientIp: string,
): Promise<CaptureScoringLinkOk> {
  const resolved = await resolveStreamCode(rawCode, tok, "start", body.phone, now);
  const open = await openSessionOf(sql, resolved.fixtureId);
  const current = await holderOf(sql, resolved.codeId, open);
  if (!current || current.phone !== body.phone) throw new CaptureRefusalError(409, "replaced", "this phone is not the slot's current phone");
  const origin = captureOrigin(deps);
  if (!HTTPS_ORIGIN.test(origin)) {
    log.error({ fixtureId: resolved.fixtureId, origin }, "capture scoring link: the server's origin is not https; no link is served");
    throw unavailable("origin_not_https");
  }
  await rateLimit(`dlmint:${clientIp}`, DEVICE_LINK_MINT_LIMIT);
  let got: PhoneScoringLink;
  try {
    got = await provideDeviceLinkForPhone(resolved.orgId, resolved.fixtureId, resolved.issuedBy);
  } catch (err) {
    if (err instanceof PaymentRequiredError) throw new CaptureRefusalError(402, "not_entitled", `the plan lacks ${err.featureKey}`);
    if (err instanceof HttpError && err.code === "DEVICE_LINK_KEK_MISSING") {
      throw new CaptureRefusalError(503, "unavailable", "scoring links are not configured on this server");
    }
    throw err;
  }
  if (got.kind === "finished") throw new CaptureRefusalError(409, "match_finished", `the match is ${got.status}; it has no scoring link`);
  const answer = CaptureScoringLinkOk.safeParse({ url: `${origin}/score/${got.secret}` });
  // An assumption made a guard: every secret is `mintDeviceLinkSecret`'s and the origin was checked above. Refused by
  // name (a logged 503) rather than served to a parser that rejects it — and never with the URL in the message.
  if (!answer.success) throw new Error("postScoringLink: the scoring link does not match the contract's url pattern");
  return answer.data;
}
