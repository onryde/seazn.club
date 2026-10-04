import "server-only";
// server/usecases/capture-phone.ts — the phone-facing use-cases of capture QR v2 (§6.3): the descriptor (`getCode`,
// T8a), and the waiting-fields builder the beat answer reuses (T8b), so the two never disagree (R7: ONE owner of the
// length fit).
//
// R1 (§17.1): the V430 tables are FORCE RLS with no policy, so every read here goes through the non-tenant `sql` —
// never `withTenant` — and the org is the code row's (`resolveStreamCode`). Each answer is built field by field, never
// by spreading a row. The sealed ingest secrets are opened (`readFirstInput`) only when `cred` is about to be served,
// inside this request, and never logged.
import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { getDictionary, t, toLocale } from "@/lib/i18n";
import { OVERLAY_KEY_PARAM } from "@/lib/realtime-purpose";
import { defaultThemeFor } from "@/components/overlay/theme-registry";
import { CaptureRefusalError, codeEnded } from "@/server/api-v1/capture-http";
import { CaptureDescriptor, CaptureWaiting, type CaptureCred } from "@/server/api-v1/capture-schemas";
import type { z } from "zod";
import { log } from "@/server/logger";
import { overlayKeyFor } from "@/server/overlay/overlay-key";
import {
  HOLD_SLACK_SECONDS, INGEST_TIMEOUT_SECONDS, QR_PREFERRED_DEFAULT, SRT_LATENCY_MS, WARMING_TIMEOUT_MINUTES,
  srtEnabled, streamIngestHost, streamPlaybackHost,
} from "@/server/relay/config";
import { wireEndReason, type DbEndReason } from "@/server/relay/domain/end-reason";
import { pollSecondsFor } from "@/server/relay/domain/poll-seconds";
import { isActive, type FailReason, type SessionState } from "@/server/relay/domain/session";
import { normaliseCode } from "@/server/relay/domain/stream-code";
import { ingestCred } from "@/server/relay/ingest-cred";
import { readFirstInput } from "@/server/relay/secret-columns";
import { resolveStreamCode, type ResolvedCode } from "./stream-codes";
import type { SessionDeps } from "./stream-sessions";

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
  target_label: string | null;
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
  // org's locale (W25), both sides' names, and the pre-picked destination — an archived one reads as none (T36).
  const [ctx] = await sql<FixtureCtx[]>`
    select f.fixture_no, f.status, f.scheduled_at, f.finished_at, d.competition_id, d.sport_key,
           coalesce(ss.tz, o.timezone, 'UTC') as tz, o.default_locale,
           h.display_name as home_name, a.display_name as away_name, t.label as target_label
      from fixtures f
      join divisions d on d.id = f.division_id
      join organizations o on o.id = d.org_id
      left join schedule_settings ss on ss.division_id = d.id
      left join entrants h on h.id = f.home_entrant_id
      left join entrants a on a.id = f.away_entrant_id
      left join fixture_stream_settings st on st.fixture_id = f.id
      left join org_stream_targets t on t.id = st.target_id and t.org_id = ${c.orgId} and t.archived_at is null
     where f.id = ${c.fixtureId} and d.org_id = ${c.orgId}`;
  // The code cascades with its fixture (T35), so a resolved code's fixture is there; one deleted in between reads as an
  // ended code, never a 500.
  if (!ctx) throw codeEnded();

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
    destinationName: ctx.target_label === null ? null : fitText(ctx.target_label, DEST_MAX),
    overlayUrl,
    scoreUpdates: keyed ? "realtime" : "polled",
    heartbeatUrl: `${origin}/api/v1/capture/codes/${c.code}/beats`,
    startUrl: `${origin}/api/v1/capture/codes/${c.code}/start`,
  };
}

/** The waiting shape's fields, picked by name (the strict wire): `scheduledStart` is OMITTED when null (§6.4). */
function waitingFieldsOf(w: CaptureCommon) {
  return {
    code: w.code, label: w.label, venueTimezone: w.venueTimezone,
    ...(w.scheduledStart !== null ? { scheduledStart: w.scheduledStart } : {}),
    pollSeconds: w.pollSeconds, autoAllowed: w.autoAllowed, destinationName: w.destinationName, overlayUrl: w.overlayUrl,
    heartbeatUrl: w.heartbeatUrl, startUrl: w.startUrl,
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

  const sessionShape = q.phone !== null && latest !== null && (
    latest.state === "warming" || latest.state === "live" || latest.state === "ending"
    || ((latest.state === "completed" || latest.state === "failed") && latest.warming_at !== null)
  );
  if (!sessionShape) return { state: "waiting", ...waitingFieldsOf(common) };
  return sessionDescriptor(resolved, latest!, q, common, deps, now);
}

async function sessionDescriptor(
  resolved: ResolvedCode, s: LatestSession, q: { slot: number; phone: string | null }, common: CaptureCommon, deps: SessionDeps, now: Date,
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
    ...waitingFieldsOf(common),
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
