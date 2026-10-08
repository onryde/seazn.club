import "server-only";
// server/usecases/stream-phone.ts — capture QR v2 §9 / §6.12 (T9): the organiser panel's phone read model,
// `GET /api/v1/fixtures/{id}/stream-phone`. The panel polls it every STREAM_POLL_MS beside `current`.
//
// It carries NO secret: every column is named, every field picked by name — never the tok or its hash, never `cred`,
// never a destination's stream key. R1 (§17.1): the V430 tables are FORCE RLS with no policy, so every read goes
// through the non-tenant `sql`, and the org is a WHERE (the fixture's org must be the caller's: another club's fixture
// reads exactly like a missing one). It ticks nothing — `current`, polled beside it, is the tick (§6.11) — and writes one
// thing only: C2's lazy expiry, which "the first evaluation that finds it true writes" (§5.1).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  CaptureNotReady, CapturePhoneState, CaptureStartFailed, StreamPhoneBeat, type StreamPhone,
} from "@/server/api-v1/schemas";
import {
  AUTO_START_RETRY_SECONDS, CODE_GRACE_AFTER_FINISH_MINUTES, PHONE_NOT_READY_SHOW_AFTER_SECONDS, PHONE_SILENT_FLOOR_SECONDS,
  POLL_FAR_SECONDS, tunable,
} from "@/server/relay/config";
import { AUTO_START_REFUSALS, autoStartVerdict, type PhoneMode } from "@/server/relay/domain/auto-stream";
import { isNotResponding, isPresent, isSilent } from "@/server/relay/domain/pairing";
import { phoneHealthOf } from "@/server/relay/domain/phone-health";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { codeStatus } from "@/server/relay/domain/stream-code";
import { wipeStreamCodeTok } from "@/server/relay/secret-columns";
import { fixtureStreamTarget, requireSessionEditor } from "./stream-codes";

/** PR-1 carries one camera: the panel reads slot 0. */
const SLOT = 0;

type PairingRow = {
  id: string; device_model: string | null; app_version: string | null; mode: string | null; phone_state: string | null;
  not_ready: string | null; not_ready_since: Date | null; start_failed: string | null; last_beat_at: Date; answered_poll_seconds: number;
  last_beat: unknown;
};
const PAIRING_COLS = () => sql`p.id, p.device_model, p.app_version, p.mode, p.phone_state, p.not_ready, p.not_ready_since, p.start_failed,
  p.last_beat_at, p.answered_poll_seconds, p.last_beat`;

/** One of the beat's enum words, or null — a column the beat wrote through the strict contract, re-checked on the way
 *  out so a stray value never reaches the panel as a word it has no copy for. */
function word<T extends string>(e: { options: readonly T[] }, v: string | null): T | null {
  return v !== null && (e.options as readonly string[]).includes(v) ? (v as T) : null;
}

/** §6.10: the stored beat is the allowlisted `raw`; the panel's five fields are picked from it by name and checked
 *  against the beat's own shapes. A beat that will not parse (none yet, or a row written by an older shape) reads as
 *  all-null rather than as a guess. */
function beatOf(raw: unknown): NonNullable<StreamPhone["phone"]>["beat"] {
  const none = { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null };
  if (raw === null || typeof raw !== "object") return none;
  const r = raw as Record<string, unknown>;
  const picked = StreamPhoneBeat.safeParse({
    battery: r.battery ?? null, bitrateKbps: r.bitrateKbps ?? null, delivery: r.delivery ?? null, thermal: r.thermal ?? null,
    dataUsedMB: r.dataUsedMB ?? null,
  });
  return picked.success ? picked.data : none;
}

/**
 * The slot's phone, by the same rules as the two writers that act on it:
 *  - an OPEN session with NO phone (`pairing_id` null — every session open when V430 deployed): no phone at all. It
 *    keeps today's rules, so the panel shows today's (controller ruling C-1). `null` with `legacy: true`;
 *  - an OPEN session's own pairing, while that pairing has not ended — its CODE's state is not read (C1b/C3, spec §17.11:
 *    a reissued code's phone that is still streaming is the current phone). `held`;
 *  - otherwise the current pairing on the fixture's ACTIVE code — exactly W5's lookup (`currentPhoneOf`), so the panel
 *    offers Go live on exactly the phone the server admits: after a reissue, only a claim on the NEW code pairs one.
 */
async function phoneOf(fixtureId: string): Promise<{ row: PairingRow | null; held: boolean; legacy: boolean; openId: string | null }> {
  const [open] = await sql<{ id: string; pairing_id: string | null }[]>`
    select id, pairing_id from fixture_stream_sessions
     where fixture_id = ${fixtureId} and state in ${sql([...ACTIVE_STATES])}
     order by created_at desc, id desc limit 1`;
  const openId = open?.id ?? null;
  if (open && open.pairing_id === null) return { row: null, held: false, legacy: true, openId };
  if (open) {
    const [held] = await sql<PairingRow[]>`
      select ${PAIRING_COLS()} from fixture_stream_pairings p where p.id = ${open.pairing_id} and p.ended_at is null`;
    if (held) return { row: held, held: true, legacy: false, openId };
  }
  const [cur] = await sql<PairingRow[]>`
    select ${PAIRING_COLS()}
      from fixture_stream_codes c
      join fixture_stream_pairings p on p.code_id = c.id and p.slot = ${SLOT} and p.ended_at is null
     where c.fixture_id = ${fixtureId} and c.ended_at is null`;
  return { row: cur ?? null, held: false, legacy: false, openId };
}

/** The fixture's settings row, joined onto the fixture read (null columns with no row), and the one fact the refusal check needs. */
type SettingsFacts = {
  /** Null when the fixture has no settings row. */
  settings_id: string | null; auto_stream: boolean | null; auto_started_at: Date | null; auto_start_blocked_at: Date | null;
  auto_start_attempted_at: Date | null; auto_start_refusal: string | null;
  /** Some session of this fixture EVER received ingest — read only while a refusal is stored (it is false otherwise). */
  any_ingest: boolean;
};

/**
 * `StreamPhone.auto` (PR-2 T6, §7.1/§7.2). `enabled`, `startedAt` and `blocked` are the columns. The REFUSAL is not: the
 * stored code outlives the attempt it belonged to — an `already_running` start and an unmapped error leave an earlier code in
 * place, a Go live or a Stop makes it moot — so it is served only while the auto-start predicate could still pass
 * (`autoStartVerdict`, the ONE definition of "due": switch on, phone automatic, match in play, no open session, not started,
 * not blocked, no broadcast ever ingested). Two of its conjuncts are neutralised on purpose, because a refusal is meant to
 * outlast them: the retry spacing (the attempt is by definition inside it right after the refusal; `autoStartAttemptedAt: null`
 * makes it hold) and the phone's presence (a silent phone returns and the retry fires; `phonePresent: true`).
 */
function autoOf(
  st: SettingsFacts & { status: string }, c: { phoneMode: PhoneMode | null; openSession: boolean }, now: Date,
): StreamPhone["auto"] {
  if (st.settings_id === null) return null;
  const refusal = word({ options: AUTO_START_REFUSALS }, st.auto_start_refusal);
  const couldStillFire = refusal !== null && autoStartVerdict({
    autoStream: st.auto_stream === true,
    phoneMode: c.phoneMode,
    phonePresent: true,
    fixtureStatus: st.status,
    openSession: c.openSession,
    autoStartedAt: st.auto_started_at,
    autoStartBlockedAt: st.auto_start_blocked_at,
    anySessionHadIngest: st.any_ingest,
    autoStartAttemptedAt: null,
  }, now, tunable("AUTO_START_RETRY_SECONDS", AUTO_START_RETRY_SECONDS)).due;
  return {
    enabled: st.auto_stream === true,
    startedAt: st.auto_started_at === null ? null : new Date(st.auto_started_at).toISOString(),
    blocked: st.auto_start_blocked_at !== null,
    refusal: couldStillFire ? refusal : null,
    refusalAt: couldStillFire && st.auto_start_attempted_at !== null ? new Date(st.auto_start_attempted_at).toISOString() : null,
  };
}

/**
 * `GET /api/v1/fixtures/{id}/stream-phone` (§9). Editors only, session login only; another org's fixture is 404.
 *  - `code`: the fixture's ACTIVE code (else its latest ended one), with C2 evaluated on the server's clock;
 *  - `phone`: §6.9's present / silent / not responding, `elapsedMs` on the server's clock (the D3 M6 rule);
 *  - `destination`: `fixtureStreamTarget`'s — the target the phone's own start opens on (B8 review I-1), so the panel's
 *    picker shows exactly that: the saved choice, or with none saved the oldest (`source: "default"`); none when the
 *    choice was cleared or archived (T36, n1). Read, never written: opening the panel saves nothing;
 *  - `lastTakeover`: the latest time ANOTHER phone took the slot (§7.5, T2/T4) — read from the pairings, because a
 *    takeover on a slot with no session has no session to carry a `phone_takeover` event. The session's phone re-seated
 *    onto a reissued code (B6 I-2) is the same phone moving, never a takeover;
 *  - `auto` (PR-2 T6): the fixture's settings row as the panel's switch and strips read it — null with no row. Its `refusal` is
 *    served only while `autoStartVerdict` could still pass (`autoOf`): the stored code can outlive the attempt it belonged to;
 *  - `phone.health` (PR-2 T6): domain/phone-health.ts's one derivation over the stored beat — withheld while the phone is silent
 *    (its readings are stale; `not_responding` still names a held one); `phone.notReadyForMs` / `notReadyShown` (FP16, owner
 *    ruling R-2): the debounce of the flapping `notReady`, from the pairing's `not_ready_since`, shown only once a BEAT a
 *    constant after the stretch began still says not ready (and never for a silent phone);
 *  - `legacy` / `finished` (T11): the open session has no pairing (C-1), and the fixture is finished (C5's match-over row);
 *  - `session` (B8 review I-2): the fixture's OPEN session's id, whoever started it — the panel's `current` rests at
 *    Ready, so a session the PHONE started would otherwise stay unseen there.
 */
export async function streamPhone(auth: AuthCtx, fixtureId: string, deps: { now: () => Date }): Promise<StreamPhone> {
  requireSessionEditor(auth);
  const [fx] = await sql<(SettingsFacts & { org_id: string; finished_at: Date | null; status: string })[]>`
    select c.org_id, f.finished_at, f.status,
           st.fixture_id as settings_id, st.auto_stream, st.auto_started_at, st.auto_start_blocked_at, st.auto_start_attempted_at,
           st.auto_start_refusal,
           (st.auto_start_refusal is not null
            and exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id and s.first_ingest_at is not null)) as any_ingest
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      left join fixture_stream_settings st on st.fixture_id = f.id
     where f.id = ${fixtureId}`;
  if (!fx || fx.org_id !== auth.orgId) throw new HttpError(404, "fixture not found");
  const now = deps.now();

  // --- the code ---
  const [codeRow] = await sql<{ id: string; created_at: Date; ended_at: Date | null; end_cause: "reissued" | "expired" | null }[]>`
    select id, created_at, ended_at, end_cause from fixture_stream_codes
     where fixture_id = ${fixtureId}
     order by (ended_at is null) desc, created_at desc, id desc limit 1`;
  let code: StreamPhone["code"] = null;
  if (codeRow) {
    const [{ open }] = await sql<{ open: boolean }[]>`
      select exists (select 1 from fixture_stream_sessions where fixture_id = ${fixtureId} and state in ${sql([...ACTIVE_STATES])}) as open`;
    const status = codeStatus({ endedAt: codeRow.ended_at, finishedAt: fx.finished_at }, now, open,
      tunable("CODE_GRACE_AFTER_FINISH_MINUTES", CODE_GRACE_AFTER_FINISH_MINUTES));
    if (status === "expiry_due") {
      // C2: the first evaluation that finds the code expired writes it (and wipes the sealed tok), as resolve and ensure do.
      await sql.begin((tx) => wipeStreamCodeTok(tx, codeRow.id, "expired", null));
      code = { issuedAt: codeRow.created_at.toISOString(), state: "ended", endCause: "expired" };
    } else {
      code = { issuedAt: codeRow.created_at.toISOString(), state: status, endCause: codeRow.end_cause };
    }
  }

  // --- the phone ---
  const { row: p, held, legacy, openId } = await phoneOf(fixtureId);
  let phone: StreamPhone["phone"] = null;
  let phoneMode: PhoneMode | null = null;
  if (p) {
    const lastBeatAt = new Date(p.last_beat_at);
    const floor = tunable("PHONE_SILENT_FLOOR_SECONDS", PHONE_SILENT_FLOOR_SECONDS);
    const notResponding = isNotResponding({ held, lastBeatAt, answeredPoll: p.answered_poll_seconds }, now);
    const silent = isSilent(lastBeatAt, p.answered_poll_seconds, now, floor);
    // A silent phone's last word is old news: its readings and its not-ready are not judged (I1). `notResponding` is the
    // silence verdict itself, so a held phone that went quiet is still named.
    const fresh = !silent;
    const beat = beatOf(p.last_beat);
    // FP16 / R-2: the debounce. `notReady` is the latest reason; the clock is the beat that began the stretch. A reason with no
    // clock (a row from before V431) has no duration, so it is not shown; a clock in the future (skew) reads 0.
    const notReady = word(CaptureNotReady, p.not_ready);
    const sinceMs = notReady === null || p.not_ready_since === null ? null : new Date(p.not_ready_since).getTime();
    const notReadyForMs = sinceMs === null ? null : Math.max(0, now.getTime() - sinceMs);
    // BEAT-CONFIRMED (I2, "about 2 beats"): shown only when a beat at least the constant after the stretch began still says not
    // ready — the last beat is that evidence, the wall clock between beats is not. One sighting never ages into shown.
    const notReadyShown = fresh && sinceMs !== null && lastBeatAt.getTime() - sinceMs >= PHONE_NOT_READY_SHOW_AFTER_SECONDS * 1000;
    phoneMode = p.mode === "automatic" || p.mode === "operator" ? p.mode : null;
    phone = {
      present: isPresent({ current: true, lastBeatAt, answeredPoll: p.answered_poll_seconds }, now, floor),
      silent,
      notResponding,
      model: p.device_model,
      appVersion: p.app_version,
      mode: phoneMode,
      state: word(CapturePhoneState, p.phone_state),
      notReady,
      notReadyForMs,
      notReadyShown,
      // §7.4: the ONE derivation (the beat history's flags read the same predicates). A null reading contributes nothing, and a
      // silent phone's readings are withheld (I1) — the raw `beat` and `elapsedMs` below still say what it last reported and when.
      health: phoneHealthOf({
        notResponding,
        delivery: fresh ? beat.delivery : null, thermal: fresh ? beat.thermal : null, battery: fresh ? beat.battery : null,
      }),
      startFailed: word(CaptureStartFailed, p.start_failed),
      lastBeatAt: lastBeatAt.toISOString(),
      elapsedMs: Math.max(0, now.getTime() - lastBeatAt.getTime()),
      beat,
      farPoll: p.answered_poll_seconds === POLL_FAR_SECONDS,
    };
  }

  // --- the destination: the one the phone's start would open on (T36: a choice archived reads as none) ---
  const destination = await fixtureStreamTarget(sql, { orgId: auth.orgId, fixtureId });

  // --- the last takeover (§7.5): a pairing ended `replaced` by ANOTHER phone's ---
  let lastTakeover: StreamPhone["lastTakeover"] = null;
  if (!legacy) {
    const [t] = await sql<{ at: Date; model: string | null }[]>`
      select old.ended_at as at, nxt.device_model as model
        from fixture_stream_pairings old
        join fixture_stream_codes c on c.id = old.code_id
        join fixture_stream_pairings nxt on nxt.id = old.replaced_by
       where c.fixture_id = ${fixtureId} and old.end_cause = 'replaced' and nxt.phone <> old.phone
       order by old.ended_at desc, old.id desc limit 1`;
    if (t) lastTakeover = { at: new Date(t.at).toISOString(), model: t.model };
  }

  return {
    code, phone, destination, lastTakeover,
    auto: autoOf(fx, { phoneMode, openSession: openId !== null }, now),
    legacy, finished: fx.finished_at !== null, session: openId === null ? null : { id: openId },
  };
}
