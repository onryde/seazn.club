import "server-only";
// Court stream, the desk's side (spec seazn.club.capture docs/specs/2026-11-14-court-stream-design.md §5; plan Task 3): an
// organiser links a COURT, for one day, to a connected YouTube channel and is shown the court's QR; the phone at that court
// scans it once and streams every match the organiser has switched on. Link, list and withdraw are session-editor acts.
//
// The court's code is a row of fixture_stream_codes with no fixture (V525) — the same sealed-tok rules as a fixture's
// (stream-codes.ts): FORCE RLS with no policy, so every read and write here is on the non-tenant `sql`, the org a WHERE
// the code writes. The link has no org-tying foreign key for competition_id / target_id, so both are written from the
// authorised, org-scoped reads below and from nowhere else. The tok is held in memory between a seal or open and the
// answer: never logged, never in an error, never in a URL.
import { dayKeyInTz } from "@seazn/engine/scheduling";
import { sql, withTenant, type Tx } from "@/lib/db";
import { requireFeature } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import { resolveVenueTz } from "@/lib/tz";
import type { CaptureQrV2 } from "@/lib/capture-qr";
import { assertUuid, type AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import type { MatchDayCourtStream } from "@/lib/match-day/types";
import { courtMinAppVersion } from "@/server/relay/config";
import { AUTO_START_REFUSALS, type AutoServedRefusal } from "@/server/relay/domain/auto-stream";
import { courtPhoneStatus, courtTailEndsAt } from "@/server/relay/domain/court-stream";
import { ACTIVE_STATES, isTerminal, type SessionState } from "@/server/relay/domain/session";
import { autoStopDelaySeconds } from "./stream-sessions/auto-stop";
import type { SessionDeps } from "./stream-sessions/deps";
import { stopSession } from "./stream-sessions/stop";
import { finishOwedStop } from "./stream-sessions/apply";
import { endCourtBroadcastSoon } from "./stream-sessions/court-end";
import { frozenCompetitionIds } from "./entitlement-freeze";
import { hasValidKek } from "@/server/relay/crypto";
import { insertCourtStreamCode, openStreamCodeTok, wipeStreamCodeTok } from "@/server/relay/secret-columns";
import { resolveCandidateCourts } from "./court-candidates";
import { competitionZone, dayBounds } from "./match-day-codes";
import { loadSettings } from "./schedule/settings";
import {
  CODE_RETRIES, SLOT, activeCodeOf, drawCode, fixtureOf, freshTok, isCodeCollision, lockFixtureCode, requireSessionEditor, sha256Hex,
} from "./stream-codes";

export type CourtStreamShown = {
  id: string;
  courtId: string;
  courtName: string;
  day: string;
  expiresAt: Date;
  target: { id: string; label: string };
  /** null only when the sealed tok will not reopen: the link is listed so it can still be withdrawn. */
  qr: CaptureQrV2 | null;
};

const KEK_MISSING = "Stream codes are not configured on this server (RELAY_KEK missing or malformed)";

type LinkRow = {
  id: string;
  court_id: string;
  court_name: string;
  day: string;
  expires_at: Date;
  target_id: string;
  target_label: string;
  code_id: string | null;
  code: string | null;
  tok_hash: string | null;
};

type Q = Tx | typeof sql;
// `day::text`: a bare `date` would come back as a JS Date at local midnight. The link's one live code rides along.
// `where` is built on the same executor, so a transaction reads its own uncommitted rows.
const linkSelect = (q: Q, where: ReturnType<Q>) => q<LinkRow[]>`
  select l.id, l.court_id, c.name as court_name, l.day::text as day, l.expires_at, l.target_id, t.label as target_label,
         k.id as code_id, k.code, k.tok_hash
    from court_stream_links l
    join courts c on c.id = l.court_id
    join org_stream_targets t on t.id = l.target_id
    left join fixture_stream_codes k on k.court_link_id = l.id and k.ended_at is null
   where ${where}
   order by c.sort, c.name, l.day, l.id`;

async function shownOf(tx: Tx, r: LinkRow): Promise<CourtStreamShown> {
  const base = {
    id: r.id,
    courtId: r.court_id,
    courtName: r.court_name,
    day: r.day,
    expiresAt: r.expires_at,
    target: { id: r.target_id, label: r.target_label },
  };
  if (r.code_id === null || r.code === null || r.tok_hash === null) return { ...base, qr: null };
  if (!hasValidKek("RELAY_KEK")) throw new HttpError(503, KEK_MISSING, "RELAY_KEK_MISSING");
  const tok = await openStreamCodeTok(tx, r.code_id);
  if (tok === null || sha256Hex(tok) !== r.tok_hash) {
    log.warn({ codeId: r.code_id, linkId: r.id }, "court stream: the sealed tok is not this code's; listed without its QR");
    return { ...base, qr: null };
  }
  return { ...base, qr: { v: 2, code: r.code, slot: SLOT, tok, exp: Math.floor(r.expires_at.getTime() / 1000) } };
}

/** Insert the link's sealed code, redrawing on a code collision (a savepoint per attempt, as `mintLocked`). */
async function mintCourtCode(tx: Tx, auth: AuthCtx, linkId: string, fresh: { tok: string; tokEnc: Buffer }): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await tx.savepoint((sp) => insertCourtStreamCode(sp, {
        orgId: auth.orgId, courtLinkId: linkId, code: drawCode(), tokHash: sha256Hex(fresh.tok), tokEnc: fresh.tokEnc, issuedBy: auth.userId!,
      }));
      return;
    } catch (err) {
      if (isCodeCollision(err) && attempt < CODE_RETRIES) continue;
      throw err;
    }
  }
}

/**
 * Link a court to a YouTube channel for a day and show its QR (spec §5.1). The day defaults to today in the competition's
 * zone; the QR's `exp` is the end of that day. The same court, day and target again re-shows the one QR; another target
 * is 409 `court_already_streaming`. The tok is sealed BEFORE any write, so a missing key writes nothing.
 */
export async function linkCourtStream(
  auth: AuthCtx,
  competitionId: string,
  input: { courtId: string; targetId: string; day?: string },
  now: Date = new Date(),
): Promise<CourtStreamShown> {
  requireSessionEditor(auth);
  assertUuid(input.courtId, "court");
  assertUuid(input.targetId, "target");
  const tz = await competitionZone(auth, competitionId);
  await requireFeature(auth.orgId, "streaming.relay", competitionId);
  if (courtMinAppVersion() === null) {
    throw new HttpError(503, "Court streaming is not configured on this server", "court_streaming_unconfigured");
  }
  const [court] = await sql<{ id: string }[]>`
    select id from courts where id = ${input.courtId} and org_id = ${auth.orgId} and archived_at is null`;
  if (!court) throw new HttpError(404, "court not found");
  const [target] = await sql<{ id: string; yt: string | null }[]>`
    select id, youtube_connection_id as yt from org_stream_targets
     where id = ${input.targetId} and org_id = ${auth.orgId} and archived_at is null`;
  if (!target) throw new HttpError(404, "target not found");
  if (target.yt === null) {
    throw new HttpError(422, "A court streams to a connected YouTube channel, not a pasted stream key", "court_destination_not_youtube");
  }
  const day = input.day ?? dayKeyInTz(now.getTime(), tz);
  const { opensAt, expiresAt } = dayBounds(day, tz);
  if (expiresAt.getTime() <= now.getTime()) throw new HttpError(422, "that day is already over", "day_over");
  const fresh = freshTok(); // seal first: a missing KEK writes nothing
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"court_stream:" + input.courtId + ":" + day}))`;
    const [live] = await linkSelect(tx, tx`l.court_id = ${input.courtId} and l.day = ${day}::date and l.withdrawn_at is null`);
    if (live) {
      if (live.target_id !== input.targetId) {
        throw new HttpError(409, "This court already streams to another destination today", "court_already_streaming");
      }
      const shown = await shownOf(tx, live);
      if (shown.qr !== null) return shown;
      // An envelope that will not open is never re-shown: end it and mint a fresh code for the same link.
      if (live.code_id !== null) await wipeStreamCodeTok(tx, live.code_id, "reissued", auth.userId);
      await mintCourtCode(tx, auth, live.id, fresh);
      const [again] = await linkSelect(tx, tx`l.id = ${live.id}`);
      return shownOf(tx, again!);
    }
    const [link] = await tx<{ id: string }[]>`
      insert into court_stream_links (org_id, competition_id, court_id, day, tz, opens_at, expires_at, target_id, created_by)
      values (${auth.orgId}, ${competitionId}, ${court.id}, ${day}::date, ${tz}, ${opensAt}, ${expiresAt}, ${target.id}, ${auth.userId})
      returning id`;
    await mintCourtCode(tx, auth, link!.id, fresh);
    const [row] = await linkSelect(tx, tx`l.id = ${link!.id}`);
    return shownOf(tx, row!);
  });
}

/** The competition's candidate courts (every live division's, the scheduler's own resolver) and the courts carrying one of
 *  its fixtures today — Match Day's court list (match-day.ts "Which courts"). */
async function competitionCourtIds(auth: AuthCtx, competitionId: string, tz: string, now: Date): Promise<string[]> {
  const { opensAt, expiresAt } = dayBounds(dayKeyInTz(now.getTime(), tz), tz);
  return withTenant(auth.orgId, async (tx) => {
    const ids = new Set<string>();
    const divisions = await tx<{ id: string; required_court_tags: string[] | null }[]>`
      select id, required_court_tags from divisions where competition_id = ${competitionId} and archived_at is null`;
    for (const d of divisions) {
      const settings = await loadSettings(tx, d.id);
      const c = await resolveCandidateCourts(tx, d.id, settings.config.courts, d.required_court_tags ?? []);
      for (const id of c.ids) ids.add(id);
    }
    const today = await tx<{ court_id: string }[]>`
      select distinct f.court_id from fixtures f join divisions d on d.id = f.division_id
       where d.competition_id = ${competitionId} and f.court_id is not null
         and f.scheduled_at >= ${opensAt} and f.scheduled_at < ${expiresAt}`;
    for (const r of today) ids.add(r.court_id);
    return [...ids];
  });
}

/** The competition's live court links (not withdrawn, not yet over) on its courts, each re-shown with its QR, in court order. */
export async function listCourtStreams(auth: AuthCtx, competitionId: string, now: Date = new Date()): Promise<CourtStreamShown[]> {
  requireSessionEditor(auth);
  const tz = resolveVenueTz(null, await orgTz(auth, competitionId));
  // As the link is: without streaming.relay the list is 402, the answer the openapi documents (final review m-7). After the 404 above.
  await requireFeature(auth.orgId, "streaming.relay", competitionId);
  const courtIds = await competitionCourtIds(auth, competitionId, tz, now);
  if (courtIds.length === 0) return [];
  return sql.begin(async (tx) => {
    const rows = await linkSelect(
      tx,
      tx`l.org_id = ${auth.orgId} and l.withdrawn_at is null and l.expires_at > ${now} and l.court_id in ${tx(courtIds)}`,
    );
    const shown: CourtStreamShown[] = [];
    for (const r of rows) shown.push(await shownOf(tx, r));
    return shown;
  });
}

async function orgTz(auth: AuthCtx, competitionId: string): Promise<string | null> {
  await competitionZone(auth, competitionId); // the 404 for another org's competition
  const [o] = await sql<{ timezone: string | null }[]>`select timezone from organizations where id = ${auth.orgId}`;
  return o?.timezone ?? null;
}

/** The competition and org a link belongs to, for the withdraw route's door (404 when there is no such link). */
export async function courtLinkOwner(linkId: string): Promise<{ orgId: string; competitionId: string }> {
  assertUuid(linkId, "court link");
  const [row] = await sql<{ org_id: string; competition_id: string }[]>`
    select org_id, competition_id from court_stream_links where id = ${linkId}`;
  if (!row) throw new HttpError(404, "court link not found");
  return { orgId: row.org_id, competitionId: row.competition_id };
}

/**
 * Withdraw a court link: the link and its code end together, the sealed tok wiped. Idempotent: a second withdraw writes
 * nothing. A session already live keeps streaming to its end (C1b, Task 6); the court takes no new start.
 */
export async function withdrawCourtStream(auth: AuthCtx, linkId: string): Promise<void> {
  requireSessionEditor(auth);
  assertUuid(linkId, "court link");
  await sql.begin(async (tx) => {
    const [link] = await tx<{ id: string; withdrawn_at: Date | null }[]>`
      select id, withdrawn_at from court_stream_links where id = ${linkId} and org_id = ${auth.orgId} for update`;
    if (!link) throw new HttpError(404, "court link not found");
    if (link.withdrawn_at !== null) return;
    await tx`update court_stream_links set withdrawn_at = now(), withdrawn_by = ${auth.userId} where id = ${linkId}`;
    const codes = await tx<{ id: string }[]>`select id from fixture_stream_codes where court_link_id = ${linkId} and ended_at is null`;
    for (const c of codes) await wipeStreamCodeTok(tx, c.id, "withdrawn", auth.userId);
  });
}

/** The court's link that is not withdrawn and is open at `now` (`opens_at <= now < expires_at`), or null — also for a match
 *  with no court. The one answer to "is this court streaming right now?", for the switch and the mint guards. */
export async function liveCourtLinkFor(
  exec: Tx | typeof sql, a: { orgId: string; courtId: string | null; now: Date },
): Promise<{ id: string; courtName: string; targetLabel: string } | null> {
  if (a.courtId === null) return null;
  const [row] = await exec<{ id: string; court_name: string; target_label: string }[]>`
    select l.id, c.name as court_name, t.label as target_label
      from court_stream_links l join courts c on c.id = l.court_id join org_stream_targets t on t.id = l.target_id
     where l.org_id = ${a.orgId} and l.court_id = ${a.courtId} and l.withdrawn_at is null
       and l.opens_at <= ${a.now} and ${a.now} < l.expires_at
     limit 1`;
  return row ? { id: row.id, courtName: row.court_name, targetLabel: row.target_label } : null;
}

/**
 * The match's Stream switch (spec §5.2): ON hands the match to its court's phone. OFF by default; turning it on spends no
 * credit (the credit is taken when a session starts). On is refused by name while the match has its own ACTIVE code
 * (`has_own_stream_code`) or its court has no live link now (`court_not_streaming`); off is never refused. It takes the
 * fixture's code lock first, the lock `ensureStreamCode` takes, so a mint and a switch-on cannot both succeed. An upsert that
 * never touches `target_id` / `target_chosen` (plan R-1), bumping `revision`.
 *
 * O17 (owner, 2026-11-17: "switching Stream off should stop the video now"): OFF while the match's court session is
 * requested, provisioning, warming or live ends it at once — the organiser's Stop (`stopSession`, end reason `stopped`, no
 * 30 s tail), which also latches the match (`auto_start_blocked_at`), so the court never starts it again by itself; the desk
 * restarts it by hand. The switch is written first, so a court start racing the stop finds it off. `deps` are the relay's
 * (the route's `defaultDeps`); an OFF that finds a session to stop without them refuses rather than leave it running.
 */
export async function setCourtStream(
  auth: AuthCtx, fixtureId: string, on: boolean, now: Date = new Date(), deps: SessionDeps | null = null,
): Promise<{ on: boolean }> {
  requireSessionEditor(auth);
  assertUuid(fixtureId, "fixture");
  await fixtureOf(auth, fixtureId); // the 404 for another org's fixture
  await sql.begin(async (tx) => {
    await lockFixtureCode(tx, fixtureId);
    if (on) {
      if (await activeCodeOf(tx, fixtureId)) {
        throw new HttpError(409, "This match has its own stream code; end it before the court streams the match", "has_own_stream_code");
      }
      const [f] = await tx<{ court_id: string | null }[]>`select court_id from fixtures where id = ${fixtureId}`;
      if (!(await liveCourtLinkFor(tx, { orgId: auth.orgId, courtId: f?.court_id ?? null, now }))) {
        throw new HttpError(409, "This match's court is not streaming right now", "court_not_streaming");
      }
    }
    await tx`
      insert into fixture_stream_settings (fixture_id, org_id, court_stream, updated_by, updated_at, revision)
      values (${fixtureId}, ${auth.orgId}, ${on}, ${auth.userId}, now(), 1)
      on conflict (fixture_id) do update
         set court_stream = excluded.court_stream, updated_by = excluded.updated_by, updated_at = now(),
             revision = fixture_stream_settings.revision + 1`;
  });
  if (!on) await stopCourtSessionOf(auth, fixtureId, deps);
  return { on };
}

/** O17: the match's court session that is still up — stopped as the organiser's Stop stops it. One per match: a match's
 *  sessions are one at a time (`active_session`). An `ending` one is included (fix round 2, item 1): its stop may have
 *  committed with the provider never asked, and only `advanceCourtStop` can tell. */
async function stopCourtSessionOf(auth: AuthCtx, fixtureId: string, deps: SessionDeps | null): Promise<void> {
  const [open] = await sql<{ id: string }[]>`
    select id from fixture_stream_sessions
     where fixture_id = ${fixtureId} and org_id = ${auth.orgId} and court_link_id is not null
       and state in ('requested', 'provisioning', 'warming', 'live', 'ending')
     order by created_at desc, id desc limit 1`;
  if (!open) return;
  if (deps === null) throw new Error("setCourtStream: switching Stream off found a court session to stop, and no session deps were given");
  // Fix round 1 (finding 4) + fix round 2 (item 1): the switch has committed, so a stop that fails leaves the video on with the
  // switch off. It is advanced twice at most, each time from the row as it NOW stands, and a second failure is reported and
  // rethrown — the organiser sees the error, and a second OFF finds the session (an `ending` one too) and advances it again.
  try {
    await advanceCourtStop(auth, fixtureId, open.id, deps);
  } catch (first) {
    log.warn({ orgId: auth.orgId, fixtureId, sid: open.id, err: String(first) }, "court stream: the Stream-off stop failed — trying once more (O17)");
    try {
      await advanceCourtStop(auth, fixtureId, open.id, deps);
    } catch (second) {
      log.error({ orgId: auth.orgId, fixtureId, sid: open.id, err: String(second) }, "court stream: the Stream-off stop failed twice — the switch is off, the video is not stopped (O17)");
      captureError(second, { orgId: auth.orgId, route: "court_stream.switch_off_stop", extra: { fixtureId, sid: open.id } });
      throw second;
    }
  }
  log.info({ orgId: auth.orgId, fixtureId, sid: open.id }, "court stream: Stream switched off — the match's court session was stopped (O17)");
}

/** One step of the Stream-off stop, from the row as it stands (fix round 2, item 1):
 *  - still up: the organiser's Stop (`stopSession`), which schedules the court's YouTube end itself once its decision and
 *    effects have run (B1);
 *  - `ending`: the stop's decision committed and its provider effect may not have run — `stopSession` would decide nothing
 *    (idempotent on `ending`) and record a second tap, so the owed effect is re-run instead (`finishOwedStop`), and the YouTube
 *    end the throwing stop never reached is scheduled here, once, only when an owed effect ran. A session draining after a
 *    stop that landed owes nothing and schedules nothing: its own stop already did;
 *  - terminal: nothing to do (a stop whose completion landed but whose later effect threw leaves the YouTube end to the cron's
 *    end step, at most a firing late). */
async function advanceCourtStop(auth: AuthCtx, fixtureId: string, sid: string, deps: SessionDeps): Promise<void> {
  const [row] = await sql<{ state: SessionState }[]>`select state from fixture_stream_sessions where id = ${sid}`;
  if (!row || isTerminal(row.state)) return;
  if (row.state !== "ending") {
    await stopSession(auth, fixtureId, sid, deps);
    return;
  }
  if (await finishOwedStop(sid, deps)) endCourtBroadcastSoon(sid, deps);
}

type StoredRefusal = (typeof AUTO_START_REFUSALS)[number];
const isRefusal = (v: string | null): v is StoredRefusal => v !== null && (AUTO_START_REFUSALS as readonly string[]).includes(v);

type RefusalRow = {
  id: string; court_id: string | null; competition_id: string; auto_start_refusal: string | null;
  auto_start_attempted_at: Date | null; settled: boolean;
};

/** The ONE rule for a court's refusal word, shared by the desk (`courtStreamsForDay`) and the court phone
 *  (`courtRefusalOf`) so they never disagree: per wanted court, the newest stored refusal among its unsettled matches (a success
 *  or a Go live clears it); `competition_frozen` for a stored `not_entitled` while the competition is frozen. */
async function servedRefusals(
  orgId: string, rows: readonly RefusalRow[], wanted: (courtId: string) => boolean,
): Promise<Map<string, AutoServedRefusal>> {
  const newest = new Map<string, RefusalRow>();
  for (const r of rows) {
    if (r.court_id === null || r.settled || !isRefusal(r.auto_start_refusal) || !wanted(r.court_id)) continue;
    const held = newest.get(r.court_id);
    if (!held || (r.auto_start_attempted_at?.getTime() ?? 0) > (held.auto_start_attempted_at?.getTime() ?? 0)) newest.set(r.court_id, r);
  }
  const out = new Map<string, AutoServedRefusal>();
  if (newest.size === 0) return out;
  // Asked only when it could change the answer, outside any transaction (`frozenCompetitionIds`).
  const frozen = [...newest.values()].some((r) => r.auto_start_refusal === "not_entitled") ? await frozenCompetitionIds(orgId) : new Set<string>();
  for (const [courtId, r] of newest) {
    const refusal = r.auto_start_refusal as StoredRefusal;
    out.set(courtId, refusal === "not_entitled" && frozen.has(r.competition_id) ? "competition_frozen" : refusal);
  }
  return out;
}

/** E2: the refusal word the court phone is told (and the Match Day card shows) for a court, from the court's own matches; null when none. */
export async function courtRefusalOf(orgId: string, courtId: string, fixtureIds: readonly string[]): Promise<AutoServedRefusal | null> {
  if (fixtureIds.length === 0) return null;
  const rows = await sql<RefusalRow[]>`
    select f.id, f.court_id, d.competition_id, st.auto_start_refusal, st.auto_start_attempted_at,
           (f.status not in ('scheduled', 'in_play')
            or exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id and s.state in ${sql([...ACTIVE_STATES])})) as settled
      from fixtures f
      join divisions d on d.id = f.division_id
      left join fixture_stream_settings st on st.fixture_id = f.id
     where f.id in ${sql([...fixtureIds])} and d.org_id = ${orgId}`;
  return (await servedRefusals(orgId, rows, (c) => c === courtId)).get(courtId) ?? null;
}

/**
 * The desk's read of court streams for Match Day (spec §5.5): per court the live link with its phone's status and the court's
 * latest stored refusal, per match its switch and whether it has its own ACTIVE code. Two statements however many courts and
 * matches: one over the links (the pairing and the open session by lateral join), one over the matches. No tok, no code.
 * The refusal is the newest stored one among the court's unfinished matches that have no open session (a success or a Go live
 * clears it); `competition_frozen` is served for a stored `not_entitled` while the competition is frozen (as `streamPhone`).
 */
export async function courtStreamsForDay(
  orgId: string, courtIds: readonly string[], fixtureIds: readonly string[], now: Date,
): Promise<{ links: Map<string, MatchDayCourtStream>; switches: Map<string, { on: boolean; ownCode: boolean }> }> {
  const links = new Map<string, MatchDayCourtStream>();
  const switches = new Map<string, { on: boolean; ownCode: boolean }>();
  if (courtIds.length > 0) {
    const linkRows = await sql<{
      id: string; court_id: string; label: string; expires_at: Date;
      last_beat_at: Date | null; answered_poll_seconds: number | null; open_state: SessionState | null;
      result_at: Date | null; session_predates_result: boolean | null; session_mode: string | null;
    }[]>`
      select l.id, l.court_id, t.label, l.expires_at, p.last_beat_at, p.answered_poll_seconds, s.state as open_state,
             s.result_at, s.session_predates_result, s.session_mode
        from court_stream_links l
        join org_stream_targets t on t.id = l.target_id
        left join lateral (
          select p.last_beat_at, p.answered_poll_seconds
            from fixture_stream_pairings p join fixture_stream_codes k on k.id = p.code_id
           where k.court_link_id = l.id and k.ended_at is null and p.ended_at is null
           order by p.claimed_at desc, p.id desc limit 1) p on true
        -- The newest open session, with the facts the auto-stop judges (O16's tail): its match's result, whether it predates it
        -- (compared here, in SQL, at the stamps' own precision: auto-stop.ts), and its phone's mode.
        left join lateral (
          select s.state, sf.finished_at as result_at, s.created_at < sf.finished_at as session_predates_result, sp.mode as session_mode
            from fixture_stream_sessions s
            left join fixtures sf on sf.id = s.fixture_id
            left join fixture_stream_pairings sp on sp.id = s.pairing_id
           where s.court_link_id = l.id and s.state in ${sql([...ACTIVE_STATES])}
           order by s.created_at desc, s.id desc limit 1) s on true
       where l.org_id = ${orgId} and l.court_id in ${sql([...courtIds])} and l.withdrawn_at is null
         and l.opens_at <= ${now} and ${now} < l.expires_at`;
    const tailSeconds = autoStopDelaySeconds(true);
    for (const r of linkRows) {
      const tailEnd = courtTailEndsAt({
        openState: r.open_state,
        finishedAt: r.result_at === null ? null : new Date(r.result_at),
        sessionPredatesResult: r.session_predates_result === true,
        phoneMode: r.session_mode === "automatic" || r.session_mode === "operator" ? r.session_mode : null,
      }, now, tailSeconds);
      links.set(r.court_id, {
        link_id: r.id,
        target_label: r.label,
        expires_at: r.expires_at.toISOString(),
        phone: courtPhoneStatus({
          pairing: r.last_beat_at === null ? null : { lastBeatAt: new Date(r.last_beat_at), answeredPoll: r.answered_poll_seconds! },
          openState: r.open_state,
        }, now),
        refusal: null,
        tail_ends_at: tailEnd === null ? null : tailEnd.toISOString(),
      });
    }
  }
  if (fixtureIds.length === 0) return { links, switches };
  const rows = await sql<{
    id: string; court_id: string | null; competition_id: string; court_stream: boolean | null;
    auto_start_refusal: string | null; auto_start_attempted_at: Date | null; settled: boolean; own_code: boolean;
  }[]>`
    select f.id, f.court_id, d.competition_id, st.court_stream, st.auto_start_refusal, st.auto_start_attempted_at,
           (f.status not in ('scheduled', 'in_play')
            or exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id and s.state in ${sql([...ACTIVE_STATES])})) as settled,
           exists (select 1 from fixture_stream_codes k where k.fixture_id = f.id and k.ended_at is null) as own_code
      from fixtures f
      join divisions d on d.id = f.division_id
      left join fixture_stream_settings st on st.fixture_id = f.id
     where f.id in ${sql([...fixtureIds])} and d.org_id = ${orgId}`;
  for (const r of rows) switches.set(r.id, { on: r.court_stream === true, ownCode: r.own_code });
  const served = await servedRefusals(orgId, rows, (courtId) => links.has(courtId));
  for (const [courtId, refusal] of served) links.get(courtId)!.refusal = refusal;
  return { links, switches };
}
