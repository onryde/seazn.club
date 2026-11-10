// /api/v1 contracts — streaming (R1): stream sessions, targets and YouTube, phone beat, relay heartbeat, phase and job contracts.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { streamUrlSchema } from "../../../lib/stream-url.ts";
// Streaming R1 (Task 9) — the capture QR's ONE schema (design §7.6), re-exported
// in the relay block below, never re-typed. Relative + explicit `.ts`, same
// reason as stream-url.ts above; lib/capture-qr.ts imports zod and nothing else.
import { CaptureQrV2 } from "../../../lib/capture-qr.ts";
// T9: the panel's read model (StreamPhone) reuses the beat's own field shapes, so it cannot drift from the contract.
import { CaptureBeat, CaptureNotReady, CapturePhoneState, CaptureStartFailed } from "../capture-schemas.ts";
// PR-2 T6: `StreamPhone.auto.refusal` and `StreamPhone.phone.health` are the domain's OWN declarations, never re-typed. Relative +
// explicit `.ts`, same reason as above; both files import NOTHING (domain-purity.test.ts pins that), which is what lets the
// standalone generator load them. (phone-health.ts itself imports ../config extensionlessly and cannot be loaded here.)
import { AUTO_SERVED_REFUSALS, AUTO_WONT_START } from "../../relay/domain/auto-stream.ts";
import { HEALTH_REASONS } from "../../relay/domain/health-reasons.ts";
// The compositor's degrade-ladder rungs (owner 2026-10-18: `full → overlay_half_rate`, the score is never removed). The
// heartbeat use-case reads the same declaration for its sizing alarm. Import-free, like health-reasons.ts.
import { LADDER_RUNGS } from "../../relay/domain/ladder.ts";
// D6 (fixture-page stream, 2026-09-30) — the platforms a NEW destination may name. RELATIVE with `.ts`, never `@/`,
// for the same reason as the imports above; lib/stream-destinations.ts is deliberately import-free.
import { STREAM_PLATFORMS } from "../../../lib/stream-destinations.ts";
// YouTube Connect (T8): the privacy vocabulary is lib/youtube.ts's own list (constants only; loads bare under strip-types).
import { YOUTUBE_PRIVACIES } from "../../../lib/youtube.ts";
// R2007 PR B — the compositor's programme phases, the overlay page's phase channels and the loopback phase endpoint's
// constants. RELATIVE with `.ts` for the same reason; lib/relay-phase.ts is deliberately import-free.
import { PHASE_CHANNELS, PROGRAMME_PHASES, RELAY_PHASE_LONG_POLL_MAX_MS, RELAY_PHASE_PATH, RELAY_PHASE_PORT, type RelayPhaseReply as RelayPhaseReplyWire } from "../../../lib/relay-phase.ts";

// ---------------------------------------------------------------------------
// Streaming R1 — relay sessions (design §6.3 / §6.4 / §7.6). Every shape a
// route or the panel exchanges lives here. The QR payload's schema is
// lib/capture-qr.ts (client-safe — the panel renders it), imported at the top of
// this file with the other relative `.ts` imports the standalone OpenAPI
// generator needs; capture QR v2 §6.13 (W4, T11) removed the v1 payload.
// ---------------------------------------------------------------------------

export const StreamMode = z.enum(["passthrough", "composed"]);
export type StreamMode = z.infer<typeof StreamMode>;
export const StreamSessionState = z.enum(["requested", "provisioning", "warming", "live", "ending", "completed", "failed"]);
export type StreamSessionState = z.infer<typeof StreamSessionState>;
/** §6.4 — NOT storage_exhausted (E5: a create-time refusal with no row). */
export const StreamFailReason = z.enum([
  "no_inbound_timeout", "target_rejected", "no_credits",
  // R2008 (owner ruling 2026-10-19): a COMPOSED session went live and no camera ever appeared for PHONE_LOST_LIVE_MINUTES —
  // cancelled, and its credit returned (nothing was ever received).
  "camera_never_live",
  // the Fly machine lifecycle's reasons (plan §"Fly machine lifecycle"; domain/runner.ts RunnerFailReason)
  "machine_create_failed", "machine_boot_timeout", "machine_exit_nonzero", "machine_oom", "machine_crash",
  // R2003: the compositor refused its run (exit 78, or a final beat saying `refused`) — never retried
  "machine_refused",
  // The two TIMED exits the domain's expiry owns (Task 2B `evaluate`): a create
  // that never finished (F16) and a row admitted but never provisioned (F18).
  // They belong HERE and not in StreamEndReason: a failed session carries no
  // end reason at all (P1-F-b). Fourteen members — the copy map (Task 13) is total
  // over this enum, so adding one here owes four dictionary keys there.
  "provision_timeout", "admission_timeout",
  // M10 (Task 14b review): a deployment with no relay ended a session left up from before.
  "relay_disabled",
  // R2004 (PR #981 review I3): the destination output could not be added at provisioning — failed closed, never charged.
  "output_failed",
]);
/** How a COMPLETED session ended — the deadline is not a failure. Capture QR v2 (T6, §5.3): the five DB reasons
 *  (domain/end-reason.ts `DB_END_REASONS`, V430's end_reason check) — the organiser's Stop, the phone operator's
 *  Stop (W12), the automatic stop after the result (W7), the phone and its video gone (W19), and the wall clock.
 *  stream-contract.test.ts pins this list against both. */
export const StreamEndReason = z.enum(["stopped", "operator_stopped", "auto_stopped", "phone_lost", "max_duration"]);
export type StreamEndReason = z.infer<typeof StreamEndReason>;
export type StreamFailReason = z.infer<typeof StreamFailReason>;
export const StreamTargetKind = z.enum(["youtube", "facebook", "twitch", "kick", "custom_rtmp"]);
export type StreamTargetKind = z.infer<typeof StreamTargetKind>;

/** A fixture's score timing override, whole ms 0–30000 (V462's `overlay_delay_ms` check; lib/stream-settings.ts
 *  `OVERLAY_DELAY_MAX_MS`, held equal by stream-settings.test.ts). ONE bound for the settings write and the create. */
const OverlayDelayOverrideMs = z.number().int().min(0).max(30_000);

/** `overlayDelayMs` (PR #989 review m2): the score timing the organiser's panel SHOWED, so Go live never races the
 *  timing's own save. Absent: the fixture's stored timing (the phone's start and the automatic start send none); null:
 *  the server's default, whatever is stored; a number: that delay. Read for a composed session only — a passthrough
 *  session has no compositor to delay. */
export const CreateStreamSession = z
  .object({
    mode: StreamMode,
    targetId: z.string().uuid(),
    themeId: z.string().min(1).max(40).optional(),
    overlayDelayMs: OverlayDelayOverrideMs.nullable().optional(),
  })
  .strict();
export type CreateStreamSession = z.infer<typeof CreateStreamSession>;
export const StreamSessionCreated = z.object({ sessionId: z.string() });
export type StreamSessionCreated = z.infer<typeof StreamSessionCreated>;

export const StreamHealth = z.object({
  fps: z.number().nullable(),
  bitrateKbps: z.number().nullable(),
  lastBeatAt: z.string().nullable(),
});
export type StreamHealth = z.infer<typeof StreamHealth>;
/** C6: the ingest STATE, worded as what it is — never "healthy". */
export const StreamIngest = z.object({
  state: z.enum(["connected", "disconnected", "unknown"]),
  protocol: z.enum(["srt", "rtmps"]).nullable(),
});
export type StreamIngest = z.infer<typeof StreamIngest>;
/** D3 (spec §5.6) — the destination's side of a passthrough broadcast. For a non-ok `state`, `since` is when the
 *  destination last received — the start of the current not-ok period, however its word changed inside it (I1, B2
 *  review); for `ok`, when it began receiving. Clamped to go-live (the destination is not tried before it). `connecting`
 *  is still dialling, never ok. `elapsedMs` is `now - since` on the SERVER's clock at this response (M6): the client
 *  judges the 30 s warning on it, never on its own clock, so a browser running ahead cannot warn early. */
export const StreamOutput = z.object({
  state: z.enum(["ok", "connecting", "rejected", "unknown"]),
  since: z.string(),
  elapsedMs: z.number().int().nonnegative(),
});
export type StreamOutput = z.infer<typeof StreamOutput>;

/** W23: `restartAllowance`'s answer (stream-credits.ts) — inside one reuse window, `limit` restarts that reached video
 *  are free; `used` have been counted since the window's anchor. */
export const StreamRestartAllowance = z
  .object({ windowOpen: z.boolean(), used: z.number().int().nonnegative(), limit: z.number().int().positive(), free: z.boolean() })
  .strict();

/** W24 (§6.12): `lostCountdown`'s answer — both durations on the server's clock, never below 0. */
const countdownClock = { elapsedMs: z.number().int().nonnegative(), remainingMs: z.number().int().nonnegative() };
/** W24 (controller ruling 2026-10-04): the countdown names the end it counts to — `live` only W19's `phone_lost`;
 *  `warming` the warming timeout (`no_inbound_timeout`) or ask 10's `phone_lost`, whichever lands first. */
export const StreamLostCountdown = z.discriminatedUnion("kind", [
  // R2008: a COMPOSED live session's countdown names the end it counts to — W19's `phone_lost` (the camera was in and is
  // gone) or the never-live cancellation (`camera_never_live`: no camera ever appeared; the credit is returned, or none was taken —
  // `camera_never_live_charged`: the same cancellation when the fixture's window already holds a never-live refund, so the charge
  // stands; owner ruling 2026-10-20). The two differ only in what the organiser is told about the money.
  z.object({ kind: z.literal("live"), reason: z.enum(["phone_lost", "camera_never_live", "camera_never_live_charged"]), ...countdownClock }).strict(),
  z.object({ kind: z.literal("warming"), reason: z.enum(["no_inbound_timeout", "phone_lost"]), ...countdownClock }).strict(),
]);
export type StreamLostCountdown = z.infer<typeof StreamLostCountdown>;

export const StreamSessionCurrent = z
  .object({
    id: z.string(),
    fixtureId: z.string(),
    mode: StreamMode,
    /** R2006: a COMPOSED session's own score style and timing, as its create copied them (V410's `theme_id` — null is
     *  the sport's default, resolved by the reader — and `overlay_delay_ms`). Null for passthrough. The panel shows these
     *  read-only while the session runs: a running session never moves, whatever the settings say since. */
    overlay: z.object({ themeId: z.string().nullable(), delayMs: z.number().int().min(0) }).strict().nullable(),
    state: StreamSessionState,
    desiredState: z.enum(["live", "ending"]),
    failReason: StreamFailReason.nullable(),
    health: StreamHealth.nullable(),
    ingest: StreamIngest.nullable(),
    /** D3: null for a composed session, and whenever the server's poll did not read the destination (not warming/live,
     *  or the provider read failed) — never a default object. */
    output: StreamOutput.nullable(),
    balance: z.number().int(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    replayUrl: z.string().nullable(),
    /** YouTube Connect T16: the fixture's replay PARTS - its complete YouTube broadcasts, numbered 1, 2, ... in the order they STARTED
     *  (a restart after a Stop is a new broadcast; one whose end was retried can finish after a later one and keeps its number).
     *  `[]` when no YouTube broadcast has completed (a pasted-key destination never has any). Read for THIS organisation, whatever the
     *  competition's visibility; `replayUrl` stays the single link the fixture holds (the first part to finish, unless the club set its
     *  own). `private` is true for a broadcast that is PRIVATE on YouTube: the organiser keeps it here and the panel says so, the public
     *  match page never shows it (and its number counts every complete broadcast, so it can differ from the public page's). */
    replayParts: z.array(z.object({ partNo: z.number().int().min(1), url: z.string(), private: z.boolean() }).strict()),
    /** Owner 2026-10-30: the watch URL of the video on YouTube THIS session streams into (server/youtube/parts.ts `sessionVideoUrl`) -
     *  its YouTube Connect broadcast once YouTube gave it its id, in any state but `failed`. Null for a pasted key, before the id is
     *  known, and once the channel is disconnected (the broadcast rows are purged). The panel's "On YouTube" card links it. */
    youtubeVideoUrl: z.string().nullable(),
    target: z.object({ id: z.string(), kind: StreamTargetKind, label: z.string() }),
    fixtureDecided: z.boolean(),
    /** W2a loop R, M2: the fixture is HELD (`needs_decision` — a level bracket result awaiting the organiser's settle).
     *  It arms the automatic stop like a decided one (ruling D-M1) but is NOT decided, so it has its own flag and its own
     *  Phone-tab chip. Never true together with `fixtureDecided`. */
    fixtureHeld: z.boolean(),
    endReason: StreamEndReason.nullable(),
    /** True iff THIS session's own consume still stands: the sum of its `consume` + `refund` credit rows is below zero.
     *  A restart inside the reuse window consumed nothing, and a refund linked to the session nets its consume out —
     *  both read false, so the "1 credit used" chip is never a false money claim (lane D D3). */
    creditUsed: z.boolean(),
    /** W23 (capture QR v2 T6b, A9(a)): the fixture's free-restart allowance in its reuse window — null while no window is
     *  open (never a default object). `free` is admission's own answer (`restartAllowance`, I-1): a new start on THIS
     *  fixture would cost nothing right now, so the Phone tab never sells a pack for a restart the server would admit at
     *  balance 0. A fixture fact, not this session's. T11 retired the derived boolean that stood beside it; this is the one field. */
    restart: StreamRestartAllowance.nullable(),
    /** Capture QR v2 §5.3 (T6): who started this session — the organiser's Go live, the phone operator's start, or
     *  the automatic start. V430's start_cause; set at creation and never changed. */
    startCause: z.enum(["organiser", "operator", "automatic"]),
    /** W24 (§6.12, T9): the server-computed countdown to the EARLIEST end the tick will make, carrying that end's
     *  `reason` — `live`: W19's phone-lost end, from the SHORTER of the two silences (no beat, no video), shown after
     *  RECONNECT_QUIET_SECONDS; `warming`: the warming deadline, or ask 10's once the phone's beats have stopped, whichever
     *  is first. `lostCountdown` (domain/phone-lost.ts) on the server's clock, from the same clocks the tick judges.
     *  null when there is nothing to count down — and always for a session with no phone (pairing_id null: today's
     *  rules, controller ruling C-1). */
    countdown: StreamLostCountdown.nullable(),
  })
  .strict();
export type StreamSessionCurrent = z.infer<typeof StreamSessionCurrent>;

/** Capture QR v2 §6.1 / §9 (T5): the stable stream code as the organiser's panel shows it — `POST …/stream-code` (ensure)
 *  and `POST …/stream-code/reissue`. `qr` is the v2 payload (lib/capture-qr.ts, re-used, never re-typed); `issuedAt`
 *  is when this code was minted, so a re-show answers the same instant. Served `private, no-store`: the tok is live. */
export const StreamCodeShown = z.object({ qr: CaptureQrV2, issuedAt: z.string() }).strict();
export type StreamCodeShown = z.infer<typeof StreamCodeShown>;
/** §6.7.3 / §8.1 (plan T3): the fixture's stream settings. `targetId` is the destination pre-pick (PR-1; `null` clears it) and
 *  `autoStream` is the automatic-streaming switch (PR-2, W7). Either or both, at least one: a PUT writes only the fields it
 *  names, so the panel's PR-1 body `{ targetId }` still leaves the switch alone and `{ autoStream }` leaves the pick alone. */
/** R2006 (owner ruling 2026-10-19, "Option C"): three more preferences, each written only when the body names it.
 *  `streamMode` — null resets to the default (the score whenever the deployment can run it), `passthrough` is "Camera
 *  only", `composed` is "Add the score back"; every start path reads it (V466). `overlayTemplate` — null resets to the
 *  sport's default; an id the fixture's sport is not offered is a 400 and writes nothing; 40 matches
 *  `CreateStreamSession.themeId`. `overlayDelayMs` — whole ms, 0–30000 (V462's check; lib/stream-settings.ts
 *  `OVERLAY_DELAY_MAX_MS`), null resets to the server's default and 0 is a real override. */
export const PutStreamSettings = z
  .object({
    targetId: z.string().uuid().nullable().optional(),
    autoStream: z.boolean().optional(),
    streamMode: StreamMode.nullable().optional(),
    overlayTemplate: z.string().min(1).max(40).nullable().optional(),
    overlayDelayMs: OverlayDelayOverrideMs.nullable().optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.targetId !== undefined || b.autoStream !== undefined || b.streamMode !== undefined ||
      b.overlayTemplate !== undefined || b.overlayDelayMs !== undefined,
    { message: "targetId, autoStream, streamMode, overlayTemplate or overlayDelayMs is required" },
  );
export type PutStreamSettings = z.infer<typeof PutStreamSettings>;
/** The answer: `targetId` is the SAVED choice (`null` when none was chosen or it was cleared); `autoStream` the switch.
 *  R2006: the three stored preferences as stored — `null` is "the default" for each (never the resolved value). */
export const StreamSettings = z
  .object({
    targetId: z.string().uuid().nullable(),
    autoStream: z.boolean(),
    streamMode: StreamMode.nullable(),
    overlayTemplate: z.string().nullable(),
    overlayDelayMs: z.number().int().nullable(),
    // PR #989 confirm N1: the row's revision after this write — a counter every write bumps (V466), so later writes to
    // one fixture's settings always answer higher and a reader orders two answers (or an answer and a page read) by it.
    // null only when no row exists.
    revision: z.number().int().nullable(),
  })
  .strict();
export type StreamSettings = z.infer<typeof StreamSettings>;

/** Capture QR v2 §9 / §6.12 (T9): the phone's latest beat as the panel reads it — each field picked by name from the
 *  stored beat (§6.10's allowlisted `raw`), null when the beat carried none. The beat's own shapes, never re-typed. */
export const StreamPhoneBeat = z
  .object({
    battery: CaptureBeat.shape.battery,
    bitrateKbps: CaptureBeat.shape.bitrateKbps,
    delivery: CaptureBeat.shape.delivery.nullable(),
    thermal: CaptureBeat.shape.thermal,
    dataUsedMB: CaptureBeat.shape.dataUsedMB,
  })
  .strict();
/** Capture QR v2 §9 / §6.12 (T9): `GET /api/v1/fixtures/{id}/stream-phone`, the organiser panel's phone read model. It
 *  carries NO secret — never the tok or its hash, never `cred`, never a destination's stream key: every field is picked
 *  by name. `code` is the fixture's stream code (the active one, else the latest ended); `phone` the slot's phone (§6.9's
 *  present / silent / not responding, on the server's clock); `destination` what the phone's start opens on (I-1);
 *  `lastTakeover` the latest time another phone took the slot (§7.5); `auto` (PR-2 T6, §7.1) the fixture's automatic-streaming
 *  state — null when the fixture has no settings row. */
export const StreamPhone = z
  .object({
    code: z
      .object({
        issuedAt: z.string(),
        state: z.enum(["active", "finishing", "ended"]),
        endCause: z.enum(["reissued", "expired"]).nullable(),
      })
      .strict()
      .nullable(),
    phone: z
      .object({
        present: z.boolean(),
        silent: z.boolean(),
        notResponding: z.boolean(),
        model: z.string().nullable(),
        appVersion: z.string().nullable(),
        mode: CaptureBeat.shape.mode.nullable(),
        state: CapturePhoneState.nullable(),
        /** The phone's LATEST not-ready reason. The panel shows "Phone not ready" only while `notReadyShown` (below) is true. */
        notReady: CaptureNotReady.nullable(),
        /** PR-2 T6 (owner ruling R-2, "20 s, about 2 beats"): BEAT-CONFIRMED — a beat at least
         *  PHONE_NOT_READY_SHOW_AFTER_SECONDS (20 s) after the stretch began still says not ready, so one sighting never ages into
         *  shown, whatever the wall clock does between beats. False for a silent phone (its last word is stale). The server owns
         *  the threshold; the panel never compares a number. */
        notReadyShown: z.boolean(),
        /** PR-2 T6 (§7.4): the amber reason, from domain/phone-health.ts's one derivation (W9's priority: not responding,
         *  stalled, hot, battery low) — null when none applies. Battery and thermal are null until Armed (the app sends them
         *  from then), so in the Paired phase only `stalled` (a delivery reading) or `not_responding` can apply. A SILENT
         *  phone's last readings are stale and are not judged: only `not_responding` (a held phone's silence) can name it. */
        health: z.enum(HEALTH_REASONS).nullable(),
        startFailed: CaptureStartFailed.nullable(),
        lastBeatAt: z.string(),
        /** `now − lastBeatAt` on the SERVER's clock at this response (the D3 M6 rule): the panel never compares its own
         *  clock with a server timestamp. */
        elapsedMs: z.number().int().nonnegative(),
        beat: StreamPhoneBeat,
        /** T11 (§6.6): the cadence the server last ANSWERED this phone was the far one (POLL_FAR_SECONDS) — the panel's
         *  "checks in every minute" line. A boolean, never the number: the panel words a cadence, it does not do sums. */
        farPoll: z.boolean(),
      })
      .strict()
      .nullable(),
    /** B8 review I-1: the destination the phone's own start opens on (`fixtureStreamTarget`) — the panel's picker shows
     *  it. `saved`: the fixture's choice; `default`: nothing chosen yet, so the org's oldest. Null: no live destination,
     *  or a choice that was cleared or archived (never swapped for another). */
    destination: z.object({ id: z.string(), label: z.string(), source: z.enum(["saved", "default"]) }).strict().nullable(),
    lastTakeover: z
      .object({
        at: z.string(),
        model: z.string().nullable(),
        /** PR-2 T12 (§7.5): `now − at` on the SERVER's clock at this response (the D3 M6 rule), clamped at 0 — the panel's
         *  "for 30 min after a takeover" notice is judged on it, never on the browser's clock against a server stamp. */
        elapsedMs: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    /** PR-2 T6 (§7.1, §7.2): the automatic-streaming state from the fixture's settings row — null when it has none (the
     *  switch was never touched and no organiser Stop has stamped one). `refusal` is served ONLY while an automatic start
     *  could still fire (the auto-start predicate, less the phone's presence and the retry spacing): the stored code can
     *  outlive the attempt it belonged to, so the raw column alone is never shown. */
    auto: z
      .object({
        enabled: z.boolean(),
        refusal: z.enum(AUTO_SERVED_REFUSALS).nullable(),
        /** Final review I-1 (owner, 2026-10-08): why automatic start will not run again in this match, whatever the switch
         *  says — the latch that holds over the auto-start predicate's own verdict (domain/auto-stream.ts
         *  `AUTO_START_LATCHES`): `stopped` (an organiser Stop or Cancel, A12), `already_streamed` (a session received video,
         *  A16), `already_started` (the automatic start has run). When several hold, that order decides. Null when none
         *  holds. Served with the switch off too; the panel words it only under a switch that is on. */
        wontStart: z.enum(AUTO_WONT_START).nullable(),
        /** B7 review M-3: whether §7.3's automatic stop will ever end the fixture's OPEN session (`autoStopApplies` over the
         *  same facts the tick judges, its pre/post-result comparison made in SQL) — the switch on, the session's phone
         *  automatic, and the session created before any result (A15). Null with no open session. The panel's live line
         *  "stops about N minutes after the result" is shown only on `true`. */
        stopApplies: z.boolean().nullable(),
      })
      .strict()
      .nullable(),
    /** T11 (controller ruling C-1): the fixture's OPEN session has no pairing (it opened before stream codes) — the panel
     *  renders today's panel for it. False with no open session, or one that has (or had) a phone. */
    legacy: z.boolean(),
    /** T11 (C5): the FIXTURE is finished (`finished_at` set). "This match is over" needs this as well as an ended code — a
     *  reverted result clears it while the expired code stays ended, and Ready may mint again. */
    finished: z.boolean(),
    /** B8 review I-2: the fixture's OPEN session (any starter — the organiser's Go live or the phone's own start), null
     *  with none. The panel reads `current` when it names one the panel does not show. An id, nothing else. */
    session: z.object({ id: z.string() }).strict().nullable(),
  })
  .strict();
export type StreamPhone = z.infer<typeof StreamPhone>;

/** D6: the platforms a NEW destination may name — a subset of `StreamTargetKind`, which stays whole for stored rows. */
export const StreamPlatform = z.enum(STREAM_PLATFORMS);
export type StreamPlatform = z.infer<typeof StreamPlatform>;

export const CreateStreamTarget = z
  .object({
    kind: StreamPlatform,
    label: z.string().min(1).max(80),
    /** The platform's stream key. The ingest URL is filled by the server from the platform's preset
     *  (lib/stream-destinations.ts STREAM_PLATFORM_PRESETS) — there is no url field (spec §5.2). */
    streamKey: z.string().min(1).max(200),
    /** The destination's PUBLIC watch link (R16 allowlist) — what the replay fill copies. */
    watchUrl: streamUrlSchema.optional(),
  })
  .strict();
export type CreateStreamTarget = z.infer<typeof CreateStreamTarget>;

/** Spec §5.3 — the session holding a destination. Nullable fields: a holder whose fixture was deleted
 *  (`fixture_id` is `on delete set null`) still holds, and cannot be named or linked. `matchNo` is a number, never an
 *  English "Match n": every client renders it through its own locale's `breadcrumb.match`. */
export const StreamTargetHolder = z.object({
  sessionId: z.string(),
  fixtureId: z.string().nullable(),
  href: z.string().nullable(),
  matchNo: z.number().int().nullable(),
  courtName: z.string().nullable(),
  state: z.enum(["live", "waiting"]),
});
export type StreamTargetHolder = z.infer<typeof StreamTargetHolder>;

/** YouTube Connect (T8, spec §5.1): a connection's visibility vocabulary — lib/youtube.ts's list, imported, not retyped. */
export const YoutubePrivacy = z.enum(YOUTUBE_PRIVACIES);

/** What the Streaming page shows of a connected channel (never a token or Google's own words). `channelId` is the channel's PUBLIC id
 *  (the one in its youtube.com/channel/<id> address): the row's YouTube logo links to it (owner, 2026-10-28). `status` is the
 *  two LIVE states — a revoked connection has no view. `liveState` is what the health check last learned about the channel's
 *  ability to stream: `unknown` until a check has run since the token last changed, while the grant is dead (nothing can be asked of YouTube), and for a result this build does not map; `enabled` only for a clean one.
 *  `termsOutdated`: the consent text moved on since this connection was consented — Go live is never blocked by it (spec
 *  §6.1.5). `openBroadcasts`: how many of this connection's broadcasts are neither complete nor failed (created, bound, reserved, live or ending). */
export const YoutubeConnectionView = z.object({
  connectionId: z.string(),
  channelId: z.string(),
  channelTitle: z.string(),
  privacy: YoutubePrivacy,
  madeForKids: z.boolean(),
  status: z.enum(["connected", "reconnect_needed"]),
  liveState: z.enum(["enabled", "not_enabled", "blocked", "unknown"]),
  termsOutdated: z.boolean(),
  openBroadcasts: z.number().int(),
});
export type YoutubeConnectionView = z.infer<typeof YoutubeConnectionView>;

export const StreamTarget = z.object({
  id: z.string(),
  kind: StreamTargetKind,
  label: z.string(),
  watchUrl: z.string().nullable(),
  createdAt: z.string(),
  /** The key's last 3 characters, or null for a key under 12 characters or an envelope that will not open (§5.3). */
  keyHint: z.string().nullable(),
  inUse: StreamTargetHolder.nullable(),
  /** YouTube Connect: the connection behind an API-backed destination; null for a pasted-key row (T8). */
  youtube: YoutubeConnectionView.nullable(),
});
export type StreamTarget = z.infer<typeof StreamTarget>;

/** How a create landed (secret-columns.ts `insertStreamTarget`, spec §5.2 create order): `existing` — the key is already
 *  an active destination, returned UNCHANGED (A19, owner decision (a): the typed name and watch link are not applied);
 *  `restored` — a removed one brought back under the typed name and watch link (D2); `inserted` — a new row. */
export const StreamTargetSaveOutcome = z.enum(["existing", "restored", "inserted"]);
export type StreamTargetSaveOutcome = z.infer<typeof StreamTargetSaveOutcome>;
/** POST /orgs/{id}/stream-targets — the stored row as the list reads it, plus how the save landed. */
export const StreamTargetSaved = StreamTarget.extend({ outcome: StreamTargetSaveOutcome });
export type StreamTargetSaved = z.infer<typeof StreamTargetSaved>;

/** Spec §5.2 — Rename (`{label}`, allowed at any time) or Replace key (`{streamKey}`, refused while held). Exactly one. */
export const PatchStreamTarget = z
  .object({ label: z.string().min(1).max(80).optional(), streamKey: z.string().min(1).max(200).optional() })
  .strict()
  .refine((b) => (b.label === undefined) !== (b.streamKey === undefined), { message: "send exactly one of label or streamKey" });
export type PatchStreamTarget = z.infer<typeof PatchStreamTarget>;
export const StreamTargetRemoved = z.object({ removed: z.literal(true) });

/** POST /orgs/{id}/youtube-connections — the channel picked from a multi-channel grant (the callback landed `pick` with the
 *  pending grant's id). */
export const PickYoutubeChannel = z
  .object({ pendingId: z.string().uuid(), channelId: z.string().min(1).max(200) })
  .strict();
export type PickYoutubeChannel = z.infer<typeof PickYoutubeChannel>;
/** The connection a pick (or a connect) saved, and its destination row. `existing` is true when the organisation ALREADY had a
 *  live connection to the channel: it was a reconnect (the token replaced), and the connection's own visibility and made-for-kids
 *  settings stand - the pick's choices did not overwrite them. False for a channel the organisation did not have. */
export const YoutubeConnectionSaved = z.object({ connectionId: z.string(), targetId: z.string(), existing: z.boolean() });
export type YoutubeConnectionSaved = z.infer<typeof YoutubeConnectionSaved>;
/** GET /orgs/{id}/youtube-connections/pending/{pendingId} — the channels a grant offers, for the picker. */
export const YoutubePendingChannels = z.object({ channels: z.array(z.object({ id: z.string(), title: z.string() })) });
export type YoutubePendingChannels = z.infer<typeof YoutubePendingChannels>;
/** PATCH /orgs/{id}/youtube-connections/{connectionId} — the connection's settings. `consent` and `consentMinors` can only be
 *  `true`, and only together: ticking BOTH boxes on the updated wording ("Review updated terms": the terms, and YouTube's under-16 rule —
 *  D16, PO 2026-10-30); one without the other is refused. There is no way to withdraw consent here (Disconnect is that). */
export const YoutubeConnectionSettings = z
  .object({
    privacy: YoutubePrivacy.optional(), madeForKids: z.boolean().optional(), consent: z.literal(true).optional(), consentMinors: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => b.privacy !== undefined || b.madeForKids !== undefined || b.consent !== undefined || b.consentMinors !== undefined, {
    message: "send at least one of privacy, madeForKids or consent",
  })
  .refine((b) => (b.consent === undefined) === (b.consentMinors === undefined), {
    message: "consent and consentMinors are given together: both boxes are ticked, or neither is sent",
  });
export type YoutubeConnectionSettings = z.infer<typeof YoutubeConnectionSettings>;
/** DELETE /orgs/{id}/youtube-connections/{connectionId} — what a disconnect did (YouTube Connect T18). `revokeOutcome` says what became of
 *  the grant at Google: `revoked` (Google answered the revoke), `skipped_shared_account` (left alone ON PURPOSE: another connected
 *  channel runs on the same Google account, and revoking would drop it) or `not_confirmed` (the revoke was tried and Google or YouTube
 *  did not answer, or Seazn's saved token would not open so none could be sent - the person can remove Seazn under their Google account's
 *  third-party access). In every case Seazn's own copy was purged. `keysDeleted`: stream keys Seazn made on the channel that were deleted at YouTube.
 *  `keysLeft`: the stream keys Seazn made that are still on the channel because YouTube would not delete them (0: none left), or `null` when
 *  Seazn could not read the channel's streams to confirm (no usable token, a revoked grant, YouTube not answering) - the organiser deletes
 *  them in YouTube Studio. `purged`: the broadcast records removed, and the match stream links that pointed at their videos cleared. */
export const YOUTUBE_REVOKE_OUTCOMES = ["revoked", "skipped_shared_account", "not_confirmed"] as const;
export const YoutubeDisconnected = z.object({
  revokeOutcome: z.enum(YOUTUBE_REVOKE_OUTCOMES),
  keysDeleted: z.number().int(),
  keysLeft: z.number().int().nullable(),
  purged: z.object({ broadcasts: z.number().int(), streamUrlsCleared: z.number().int() }),
});
export type YoutubeDisconnected = z.infer<typeof YoutubeDisconnected>;

/** R4 sponsors on stream, S8 (spec 2026-10-27 §3.6; plan P6): one proof-of-play item on the beat — the overlay page's
 *  `seazn:sponsor:start|end` console line (lib/overlay-compositor.ts `sponsorLine`, at most 512 bytes), tagged by the
 *  compositor with `kind` from the line's name. STRICT per item: a key the page never writes is refused, and since the
 *  beat is strict too that refuses the whole beat — so the compositor (SC1) validates each line before buffering it.
 *  `source` is the page's word: `scene` for a carousel showing, `rotation` for every break card (ruling R5: the server
 *  takes rotation vs operator from `sponsor_assignments`). `at` is UTC `Z`, as the page's `toISOString()` writes it. */
export const RelayAiring = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("start"), momentId: z.string().max(80), cardId: z.string().max(80), style: z.enum(["lower_third", "banner"]),
    source: z.enum(["rotation", "scene", "operator"]), breakKind: z.string().max(40).nullable(), at: z.string().datetime(),
  }).strict(),
  z.object({ kind: z.literal("end"), momentId: z.string().max(80), at: z.string().datetime(), cutShort: z.boolean() }).strict(),
]);
export type RelayAiring = z.infer<typeof RelayAiring>;

/** The Machine's beat (§6.3) — the control channel; the reply carries desired_state. */
export const RelayHeartbeat = z
  .object({
    state: z.enum(["starting", "playing", "stalled", "stopped"]),
    videoState: z.string().max(40).nullable().optional(),
    fps: z.number().nonnegative().nullable().optional(),
    bitrateKbps: z.number().nonnegative().nullable().optional(),
    egressBytes: z.number().int().nonnegative().optional(),
    measuredLatencyMs: z.number().int().nonnegative().nullable().optional(),
    // A29 — the encoder facts the R2 supervisor can read off ffmpeg. All
    // OPTIONAL: the supervisor sends what it has, and a field it omits is NULL
    // in the sample rather than a zero that reads as "measured and fine".
    // Declared HERE, in the one schema the route parses; Task 10's `heartbeat`
    // is their only consumer and writes them to typed sample columns.
    droppedFrames: z.number().int().nonnegative().nullable().optional(),
    encoderSpeed: z.number().nonnegative().nullable().optional(),
    cpuPct: z.number().nonnegative().nullable().optional(),
    memMb: z.number().nonnegative().nullable().optional(),
    // R2002 (compositor spec 2026-10-14 §5.3): what the R2 compositor reports beside the R1 facts — its supervisor's
    // HealthReport (C06), as C07's `heartbeat_wire` writes it. All OPTIONAL and nullable for the A29 reason: the
    // compositor omits what it has not measured, and a present 0 is a MEASURED zero. Stored as sent — in
    // `last_heartbeat` whole, and in each sample's `raw` through sanitise's allowlist (every key below is on it).
    // R2007 PR B: `final` is C06's final hold, and the final exit beat carries it too (owner ruling 2026-10-15).
    programmePhase: z.enum(PROGRAMME_PHASES).nullish(),
    input: z.enum(["connecting", "connected", "backoff"]).nullish(),
    output: z.enum(["connecting", "connected", "backoff"]).nullish(),
    graphics: z.enum(["starting", "ready", "restarting", "failed"]).nullish(),
    inputKicks: z.number().int().min(0).nullish(),
    inputKickAlert: z.boolean().nullish(),
    pipelineRebuilds: z.number().int().min(0).nullish(),
    sinkSwaps: z.number().int().min(0).nullish(),
    rung: z.enum(LADDER_RUNGS).nullish(),
    scoreStale: z.boolean().nullish(),
    // R2007 PR B (overlay templates spec 2026-10-15 §4.3): which channel the overlay page reads its phase from — the
    // compositor's loopback endpoint, or this beat through its data poll. R2005 reports it; stored as sent, like the rest.
    phaseChannel: z.enum(PHASE_CHANNELS).nullish(),
    // The FINAL beat's why (owner, 2026-10-15): C06's `ExitReason`, snake_case, plus C11b's `restart` (the in-place restart,
    // exit 75 — compositor `docs/_INDEX.md` Owed 66; domain/runner.ts BEAT_EXIT_REASONS pins this equal). A record of what the Machine said, kept
    // in the two beat stores only — never the runner's exit columns (A5: those are persisted from the OBSERVED exit), and
    // nothing here reacts to it (R2003 owns what a stopped beat does). exitDetail is compositor-redacted human text,
    // never parsed, and scrubbed again before it is stored (stream-sessions.ts `heartbeat`). Its max counts UTF-16
    // units; the contract publishes maxLength 100 (code points), the bound under which any text fits (review M1).
    exitReason: z.enum(["ended", "deadline", "signalled", "session_gone", "refused", "fatal", "restart"]).nullish(),
    exitDetail: z.string().max(200).nullish(),
    // R4 S8 (sponsors on stream spec 2026-10-27 §3.6.2): the page's proof-of-play items since the last 2xx (the compositor
    // buffers at most 64, dropping the oldest), and how many it has dropped. Additive and nullish like every R2 field: a
    // compositor built before S8 sends neither. `airings` is RECORDED (server/sponsors/airings.ts) and stripped before
    // either beat store (ruling R14); `airingsDropped` is stored as sent.
    airings: z.array(RelayAiring).max(64).nullish(),
    airingsDropped: z.number().int().min(0).nullish(),
  })
  .strict()
  // Review M6: the exit fields ride only on the FINAL beat. null is no report (the fields are nullish), so only a
  // present value is refused, at its own field.
  .superRefine((b, ctx) => {
    if (b.state === "stopped") return;
    for (const field of ["exitReason", "exitDetail"] as const) {
      if (b[field] != null) ctx.addIssue({ code: "custom", path: [field], message: `${field} is carried only by a stopped beat` });
    }
  });
export type RelayHeartbeat = z.infer<typeof RelayHeartbeat>;
export const RelayHeartbeatReply = z.object({
  desiredState: z.enum(["live", "ending"]),
  /** Owed 108 fix (b): the session's PHONE-LIVE EDGE counter (V476; domain/phone-live.ts) — bumped once each time the phone goes
   *  from not-live back to live after it had been live, so a relay waiting out its reconnect back-off can reconnect at once.
   *  The relay acts once per INCREASE. Monotonic for the life of the session and stored, never remembered. 0 at the first-ever
   *  live (no outage to recover from). Absent — web omits it, and a reader treats null the same — when the session has no phone,
   *  or its phone has not been live yet: unknown. */
  phoneLiveEdge: z.number().int().min(0).nullable().optional(),
});
export type RelayHeartbeatReply = z.infer<typeof RelayHeartbeatReply>;

/** R2007 PR B (overlay templates spec 2026-10-15 §4.3): the compositor's loopback `GET /phase?after=<seq>` reply, which
 *  the overlay page reads when `host=compositor`. The compositor serves it, never web; this twin exists so
 *  docs/contracts/relay-job.v1.json publishes it as `$defs.phaseReply` for both repos to pin. STRICT.
 *  The TYPE and the page's reader live in lib/relay-phase.ts (client-safe; a client component must never import this
 *  file), and relay-contract.test.ts sweeps that reader against this twin and the published bytes (review M3). */
export const RelayPhaseReply = z.object({ phase: z.enum(PROGRAMME_PHASES), seq: z.number().int().min(0) }).strict();
export type RelayPhaseReply = RelayPhaseReplyWire;
/** …and where that endpoint listens, as consts (`$defs.phaseEndpoint`): lib/relay-phase.ts is the authority, and the
 *  compositor drift-tests its own copies against the vendored file (C12). STRICT. */
export const RelayPhaseEndpoint = z
  .object({ port: z.literal(RELAY_PHASE_PORT), path: z.literal(RELAY_PHASE_PATH), longPollMaxMs: z.literal(RELAY_PHASE_LONG_POLL_MAX_MS) })
  .strict();
export type RelayPhaseEndpoint = z.infer<typeof RelayPhaseEndpoint>;

/** R2002: a composed session's camera — Cloudflare Input A slot 0's SRT PLAYBACK (spec §5.3; R2004 serves it). The
 *  url is bare `srt://host:port` — the guard below, not a comment: the stream id and passphrase are credentials and
 *  travel as their own fields, never in a query a log line would keep. */
export const RelayJobInput = z
  .object({
    protocol: z.literal("srt"),
    url: z.string().regex(/^srt:\/\/[^\s/?#@]+:\d+$/),
    streamId: z.string(),
    passphrase: z.string(),
  })
  .strict();
export type RelayJobInput = z.infer<typeof RelayJobInput>;
/** R2002: a composed session's programme encode (compositor ADR 0005; R2004's `relayOutputProfile`). */
export const RelayJobOutput = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    videoKbps: z.number().int().positive(),
  })
  .strict();
export type RelayJobOutput = z.infer<typeof RelayJobOutput>;

/** The `delay=` values an overlay URL carries, or null for a URL that does not parse. */
function overlayUrlDelays(url: string): string[] | null {
  try {
    return new URL(url).searchParams.getAll("delay");
  } catch {
    return null;
  }
}

/** R2002 — GET /api/internal/relay/sessions/{sid}: the facts a Machine boots from (design §6.3; compositor spec
 *  2026-10-14 §5.3), the `data` of the house `{ ok, data }` envelope. `sessionFactsForJob` returns this shape.
 *  STRICT: docs/contracts/relay-job.v1.json publishes it as `$defs.session` and the compositor vendors that file (C07).
 *  The four composed-only keys are R2004's to serve; a passthrough session, and a composed one until R2004 ships,
 *  carries none of them. `fixtureId` is null once the fixture is deleted mid-session (V410 `on delete set null`; the
 *  session outlives it — domain/session.ts).
 *
 *  ONE rule JSON Schema cannot state (the contract states it in prose): an overlayUrl carries `delay=` EXACTLY ONCE, equal
 *  to overlayDelayMs. Two authorities for one number must agree; the compositor refuses a session where the URL's is
 *  absent, repeated or different (C07, owner 2026-10-15), so the server refuses to describe one. */
export const RelayJobSession = z
  .object({
    sessionId: z.string().uuid(),
    fixtureId: z.string().uuid().nullable(),
    mode: StreamMode,
    themeId: z.string().nullable(),
    overlayDelayMs: z.number().int().min(0),
    maxDurationMinutes: z.number().int().positive(),
    target: z.object({ url: z.string(), streamKey: z.string() }).strict(),
    pageToken: z.string(),
    // Composed only — R2004 serves them; absent for passthrough.
    input: RelayJobInput.optional(),
    output: RelayJobOutput.optional(),
    heartbeatIntervalMs: z.number().int().positive().optional(),
    overlayUrl: z.url().optional(),
  })
  .strict()
  .refine((s) => {
    if (s.overlayUrl === undefined) return true;
    const delays = overlayUrlDelays(s.overlayUrl);
    return delays !== null && delays.length === 1 && delays[0] === String(s.overlayDelayMs);
  }, { path: ["overlayUrl"], message: "overlayUrl must carry delay=<overlayDelayMs> exactly once" });
export type RelayJobSession = z.infer<typeof RelayJobSession>;
