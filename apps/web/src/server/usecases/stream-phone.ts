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
import { CODE_GRACE_AFTER_FINISH_MINUTES, PHONE_SILENT_FLOOR_SECONDS, POLL_FAR_SECONDS, tunable } from "@/server/relay/config";
import { isNotResponding, isPresent, isSilent } from "@/server/relay/domain/pairing";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { codeStatus } from "@/server/relay/domain/stream-code";
import { wipeStreamCodeTok } from "@/server/relay/secret-columns";
import { fixtureStreamTarget, requireSessionEditor } from "./stream-codes";

/** PR-1 carries one camera: the panel reads slot 0. */
const SLOT = 0;

type PairingRow = {
  id: string; device_model: string | null; app_version: string | null; mode: string | null; phone_state: string | null;
  not_ready: string | null; start_failed: string | null; last_beat_at: Date; answered_poll_seconds: number; last_beat: unknown;
};
const PAIRING_COLS = () => sql`p.id, p.device_model, p.app_version, p.mode, p.phone_state, p.not_ready, p.start_failed,
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
 *  - `auto`: PR-2's, null;
 *  - `legacy` / `finished` (T11): the open session has no pairing (C-1), and the fixture is finished (C5's match-over row);
 *  - `session` (B8 review I-2): the fixture's OPEN session's id, whoever started it — the panel's `current` rests at
 *    Ready, so a session the PHONE started would otherwise stay unseen there.
 */
export async function streamPhone(auth: AuthCtx, fixtureId: string, deps: { now: () => Date }): Promise<StreamPhone> {
  requireSessionEditor(auth);
  const [fx] = await sql<{ org_id: string; finished_at: Date | null }[]>`
    select c.org_id, f.finished_at from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
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
  if (p) {
    const lastBeatAt = new Date(p.last_beat_at);
    const floor = tunable("PHONE_SILENT_FLOOR_SECONDS", PHONE_SILENT_FLOOR_SECONDS);
    phone = {
      present: isPresent({ current: true, lastBeatAt, answeredPoll: p.answered_poll_seconds }, now, floor),
      silent: isSilent(lastBeatAt, p.answered_poll_seconds, now, floor),
      notResponding: isNotResponding({ held, lastBeatAt, answeredPoll: p.answered_poll_seconds }, now),
      model: p.device_model,
      appVersion: p.app_version,
      mode: p.mode === "automatic" || p.mode === "operator" ? p.mode : null,
      state: word(CapturePhoneState, p.phone_state),
      notReady: word(CaptureNotReady, p.not_ready),
      startFailed: word(CaptureStartFailed, p.start_failed),
      lastBeatAt: lastBeatAt.toISOString(),
      elapsedMs: Math.max(0, now.getTime() - lastBeatAt.getTime()),
      beat: beatOf(p.last_beat),
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
    code, phone, destination, lastTakeover, auto: null,
    legacy, finished: fx.finished_at !== null, session: openId === null ? null : { id: openId },
  };
}
