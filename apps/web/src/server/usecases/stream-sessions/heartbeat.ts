import "server-only";
// The Machine's beat: stored beat, programme-phase log, airings, sizing alarm, beat sample (see ./index.ts).
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { RelayHeartbeat, RelayHeartbeatReply } from "@/server/api-v1/schemas";
import { SAMPLES_PER_SESSION_CAP } from "@/server/relay/config";
import { isTerminal, supersededAttempt } from "@/server/relay/domain/session";
import { steppedDownTo } from "@/server/relay/domain/ladder";
import { restartsInPlaceAfter, stoppedBeatTrigger } from "@/server/relay/domain/runner";
import { programmePhaseRowMatters } from "@/server/relay/domain/phone-lost";
import { readCameraPlayback, readFirstInput } from "@/server/relay/secret-columns";
import { scrubBeatText } from "@/server/relay/sanitise";
import { recordAirings } from "@/server/sponsors/airings";
import { PROGRAMME_PHASE_EVENT, latestLiveRung, recordEvent, recordSample } from "@/server/relay/telemetry";
import { verifyRelayToken } from "@/server/relay/tokens";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { type Row, lockRow, readRow, storedPhaseOf } from "./session-row";
import type { SessionDeps } from "./deps";
import { apply } from "./apply";
import { applyExpiry } from "./expiry";

/** R2004 review m1: the secrets a composed Machine HOLDS, for scrubbing its free text — its job token, the programme
 *  input's stream key (it publishes there) and the camera's SRT playback passphrase and stream id (it reads there). The
 *  destination key never reaches a Machine (spec §5.3), so it is not one of them. Read only for a beat that carries
 *  free text; a read that fails still scrubs the token and every shape `scrubBeatText` knows, and says so. */
async function beatSecretsOf(sessionId: string, mode: string, token: string): Promise<string[]> {
  if (mode !== "composed") return [token];
  try {
    const { programme, playback } = await sql.begin(async (tx) => ({
      programme: await readFirstInput(tx, sessionId, "programme"),
      playback: await readCameraPlayback(tx, sessionId),
    })) as { programme: Awaited<ReturnType<typeof readFirstInput>>; playback: Awaited<ReturnType<typeof readCameraPlayback>> };
    return [token, programme?.rtmps?.streamKey, playback?.passphrase, playback?.streamId].filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch (err) {
    log.warn({ sid: sessionId, err }, "stream session: a composed beat's credentials could not be read to scrub its exit detail — scrubbed by shape and token only");
    return [token];
  }
}

/** R2008: one `programme_phase` event per CHANGE of the phase the compositor reports THAT A RULE READS
 *  (`programmePhaseRowMatters`), written in the transaction that stores the beat, under the row lock — so the log and
 *  `last_heartbeat` cannot disagree, and the tick's locked re-take reads a log that already holds every beat stored before it
 *  took the lock. `from` is the phase the STORED beat carried (whatever attempt wrote it) and `to` this beat's, null for a
 *  beat that reports none: a Machine that stops reporting a phase has stopped saying `reconnecting`, which must end that run
 *  (the safe direction). Keyed to the beat's attempt by the typed `attempt` column — only the CURRENT attempt's phase is a
 *  claim about the camera now; a superseded beat never gets here (it returns before the write, #983 r1), so a stray Machine's
 *  `live` or `reconnecting` is no evidence either way.
 *  Rows are for what the rules read — `live`, `reconnecting`, `waiting`, a break in a run, a new attempt's first beat — so a
 *  camera flickering `live` <-> `frozen` all match long adds nothing: a `frozen` out of `live` is a blip (it is `reconnecting`,
 *  three seconds on, that is an outage), and `live` again after it is the phase the log already holds. The phase-change
 *  decision is taken on `cur`, the LOCKED row: two beats that peeked the same stored phase are serialised by the lock, and
 *  the second reads what the first left (the "m1" race test). The last-row read it adds runs only for a beat that CHANGES the
 *  stored phase, never on a steady one.
 *  Why a log of changes and not the beat samples: a sample carries no attempt (`raw` is the whole body, pinned so), is written
 *  after the beat's lock is released, and stops at SAMPLES_PER_SESSION_CAP; an event has none of those three faults. */
async function logProgrammePhase(tx: Tx, cur: Row, beat: RelayHeartbeat, at: Date): Promise<void> {
  const stored = storedPhaseOf(cur);
  const phase = beat.programmePhase ?? null;
  // The first beat after a replacement boots (or a stale window moved the anchor) is looked at even when its phase equals the
  // stored one: the stored beat is another process's, and without a row of its own a new attempt that opens on the phase its
  // predecessor ended on would have nothing to say the CURRENT attempt is reconnecting. A same-attempt blip that re-anchors
  // the window logs one duplicate, which can only restart a run (the safe direction).
  if (phase === stored && storedBeatIsThisAttempt(cur)) return;
  const [last] = await tx<{ to_state: string | null; attempt: number | null }[]>`
    select to_state, attempt from fixture_stream_events where session_id = ${cur.id} and type = ${PROGRAMME_PHASE_EVENT} order by seq desc limit 1`;
  if (!programmePhaseRowMatters(phase, last ? { to: last.to_state, attempt: last.attempt } : null, cur.runner_attempts)) return;
  await recordEvent(tx, { sessionId: cur.id, orgId: cur.org_id, source: "runner", kind: "observed", type: PROGRAMME_PHASE_EVENT,
    from: stored, to: phase, attempt: cur.runner_attempts, occurredAt: at });
}

export async function heartbeat(sessionId: string, token: string, body: RelayHeartbeat, deps: SessionDeps): Promise<RelayHeartbeatReply> {
  const { att } = await verifyRelayToken(token, { sid: sessionId, scope: "relay-job" });
  // R2002 review Q3: the Machine's free text is scrubbed before EITHER store keeps it (its job token, anything
  // JWT-shaped, everything from the first `?`), so last_heartbeat and the sample's raw hold the same detail.
  // A PEEK (unlocked, pooled) for the one read that cannot run inside the beat's transaction (lib/db's nesting guard):
  // the secrets to scrub with (R2004 m1), a pooled read of its own. The peek decides NOTHING else — it can be stale by
  // the time the lock is granted (#983 r2): the 410, the superseded attempt, the Owed 37 guard and the sizing alarm's
  // previous rung are all taken on the LOCKED row below.
  const peek = await readRow(sessionId);
  if (!peek) throw new HttpError(404, "session not found");
  if (isTerminal(peek.state)) throw new HttpError(410, "session has ended", "SESSION_ENDED");
  // R4 S8 (ruling R14): the proof-of-play list is RECORDED (sponsor_airings, below) and kept out of both beat stores —
  // `beat` is everything else, so neither last_heartbeat nor the sample's raw duplicates up to 64 items every 5 s.
  const { airings, ...reported } = body;
  const beat: RelayHeartbeat = reported.exitDetail == null ? reported : { ...reported, exitDetail: scrubBeatText(reported.exitDetail, await beatSecretsOf(sessionId, peek.mode, token)) };
  // #983 review r1: a beat whose token names an attempt OLDER than the row's (`superseded`) is a replaced Machine's —
  // received after the retry moved on, where the beat_window_at anchor cannot tell it from the replacement's first beat.
  // It is a SAMPLE only: no row write, no expiry tick, no callback, no sizing alarm, and the reply is `ending` (drain).
  // Decided on the locked row below, and again on each callback's own locked row.
  // The beat is recorded FIRST (a late beat that arrived is not a stale one), then the policy runs.
  // Owed 37 (compositor PR #27): the compositor sends its FINAL beat on a lane of its own, so a periodic beat it sent
  // BEFORE the final can be received — and committed — AFTER it. So whether this beat may overwrite the stored one is
  // decided on the LOCKED row, in the transaction that writes it (an unlocked read let a beat that read the row before
  // the final committed overwrite the final after it). Once this attempt's stored beat is a final that closed the
  // attempt (`closesAttempt`), a non-final beat is a SAMPLE only: last_heartbeat keeps the exit's record, heartbeat_at
  // keeps the stale window running from the final (a late beat would delay `lost`), and the egress count stands. A
  // final beat still writes (a replayed final is the same fact), and so does a beat of a NEW attempt
  // (`storedBeatIsThisAttempt`). The row lock is taken alone — never the org lock — like recordEffect's (A7).
  // G5 (Task 11 review): `egressBytes` is optional, and an omitted field leaves the stored count alone — only a Machine
  // that REPORTS 0 stores 0 (the A29 rule: absent is not a measured zero). Within ONE attempt the count never goes
  // backwards (Owed 37: the GREATEST is kept — a lower count is an overtaken beat); a new attempt's count is its own.
  const { row: before, superseded, previousRung } = (await sql.begin(async (tx) => {
    const cur = await lockRow(tx, sessionId);
    if (!cur) throw new HttpError(404, "session not found");
    if (isTerminal(cur.state)) throw new HttpError(410, "session has ended", "SESSION_ENDED");
    if (supersededAttempt(att, cur.runner_attempts)) return { row: cur, superseded: true, previousRung: null };
    // Read BEFORE this beat is stored or sampled, on the locked row (#983 r2).
    const previousRung = await previousRungOf(tx, cur);
    // R4 S8 (spec §3.6.4): the beat's proof-of-play items, under the session row's lock. AFTER the superseded return (a
    // replaced Machine's page is not this session's programme) and BEFORE the post-final one (a periodic beat overtaken
    // by the final still carries items that aired before it). In a SAVEPOINT: a failing airing write never costs the beat.
    if (airings && airings.length > 0) await recordBeatAirings(tx, cur, airings, deps.now());
    warnAiringsDropped(cur, beat);
    const thisAttempt = storedBeatIsThisAttempt(cur);
    if (thisAttempt && closesAttempt(cur.last_heartbeat) && beat.state !== "stopped") {
      log.info({ sid: sessionId, state: beat.state }, "stream session: a beat received after this attempt's final beat is a sample only — the stored final stands");
      return { row: cur, superseded: false, previousRung };
    }
    const egress = beat.egressBytes ?? null;
    if (cur.mode === "composed") await logProgrammePhase(tx, cur, beat, deps.now());   // R2008: with the stored beat, under its lock
    await tx`update fixture_stream_sessions set last_heartbeat = ${sql.json(beat as never)}, heartbeat_at = ${deps.now()},
               egress_bytes = case when ${thisAttempt}::boolean then greatest(${egress}::bigint, egress_bytes)
                                   else coalesce(${egress}::bigint, egress_bytes) end
              where id = ${sessionId}`;
    return { row: cur, superseded: false, previousRung };
  })) as { row: Row; superseded: boolean; previousRung: unknown };
  await sampleBeat(sessionId, before.org_id, beat, deps);
  if (superseded) {
    log.info({ sid: sessionId, state: beat.state, att, attempt: before.runner_attempts }, "stream session: a beat from a superseded attempt's Machine is a sample only — the current attempt is untouched; the Machine is told to drain");
    // #983 review r2 (coordinator ruling): the superseded Machine is answered `ending` whatever the session's own
    // desired state — it is a stray (its force-destroy failed, or has not landed), and a stray told `live` keeps
    // publishing. `ending` drains it; the final beat it then sends is a superseded beat too, so a sample only.
    return { desiredState: "ending" };
  }
  raiseSizingAlarm(before, beat, previousRung);
  let s = (await applyExpiry(sessionId, deps))!;
  // The runner's own callbacks are lifecycle triggers (plan §"Fly machine lifecycle"): playing/stopped, nothing else moves the table from a beat.
  // m1 (lane C final review): each callback is re-decided on the LOCKED row (T5-a) — another writer may have moved the row
  // since `s` was read, and a plain apply the table no longer accepts was InvalidTransition, a 500 on the Machine's beat.
  // callback_playing is refused on a TERMINAL session (it is not a runner cleanup trigger); callback_stopped is one, so a
  // terminal row still takes it. #983 r1: neither is fed to a runner of a LATER attempt than the beat's token names — a
  // retry can land between this beat's write and its callback, and the replacement must not be played (or stopped) by
  // the Machine it replaced.
  if (s.mode === "composed" && (s.runner.state === "booting" || s.runner.state === "playing") && body.state === "playing") {
    s = (await apply(sessionId, (cur) => (cur.mode === "composed" && !isTerminal(cur.state) && (cur.runner.state === "booting" || cur.runner.state === "playing")
      && !supersededAttempt(att, cur.runner.attempt)
      ? { type: "runner", trigger: { type: "callback_playing" } } : null), deps)) ?? s;
  }
  // R2003: a COMPOSED stopped beat is routed by its exit reason (stoppedBeatTrigger): `ended` / `deadline` end the
  // session (I2), `refused` fails it, no reason is today's lost → retry. null = record only — a signalled run is a stop
  // someone else asked for, and a session_gone one is already over. A record-only beat applies nothing (the lifecycle
  // has no trigger for it); its reason stays in last_heartbeat and the sample, and it never writes the runner exit facts
  // (A5). A passthrough stopped beat is untouched.
  // R2003b: `fatal` is `callback_crashed` — one crash, counted toward RUNNER_CRASH_CAP. Below it the runner stays as it
  // was (Fly restarts it in place on the SAME attempt, runner-fly.ts on-failure; if the restarted process never beats,
  // the composed stale window takes it lost → destroyed → the one retry); the crash that reaches the cap fails the session
  // machine_crash and tears the Machine down. It is not a teardown trigger, so it reaches a still-running session only:
  // `decide` refuses it on a terminal one (it would 500 the Machine's beat).
  // Owed 66: `restart` — the compositor's own in-place restart (exit 75) — is `callback_restarted`: NEVER a crash and never
  // counted; Fly restarts the process on the SAME attempt and its beats hold the stale window. The runner only NOTES it
  // (`restartSeen`: this attempt's restart-count floor is dropped, review m1) — from the beat, which goes out before the exit
  // 75 and so does not wait for a read of it. Like `callback_crashed` it is not a teardown trigger: a still-running session only.
  const stopped = s.mode === "composed" && body.state === "stopped" ? stoppedBeatTrigger(body.exitReason) : null;
  if (stopped && (s.runner.state === "stopping" || s.runner.state === "playing" || s.runner.state === "booting")) {
    s = (await apply(sessionId, (cur) => (cur.mode === "composed" && (cur.runner.state === "stopping" || cur.runner.state === "playing" || cur.runner.state === "booting")
      && (stopped.type === "callback_stopped" || !isTerminal(cur.state)) && !supersededAttempt(att, cur.runner.attempt)
      ? { type: "runner", trigger: stopped } : null), deps)) ?? s;
  }
  // Owed 108 fix (b): the phone-live edge counter, read fresh from its row (never from `before`, which predates the writes above)
  // and served on EVERY reply — the relay acts once per increase, so repeating the current value is how it stays idempotent. Absent
  // while the session has no phone-live history (no phone, or a phone that has not published yet): `null` and absent mean the same
  // to the relay, and omitting it keeps the reply of every such session exactly what it was before this field existed. The
  // superseded Machine's drain reply above carries none: a stray must only drain, never be nudged to reconnect.
  const [live] = await sql<{ phone_live_edge: number | null }[]>`select phone_live_edge from fixture_stream_sessions where id = ${sessionId}`;
  return live?.phone_live_edge == null ? { desiredState: s.desiredState } : { desiredState: s.desiredState, phoneLiveEdge: live.phone_live_edge };
}

/** The rung the sizing alarm's dedupe compares a beat with: the previous beat's, when that beat belongs to this attempt.
 *
 *  #980 review M2: the dedupe is per ATTEMPT. A retry boots a new Machine — a new process, whose ladder starts on
 *  `full` — and restarts the beat window (beat_window_at, I4: "booted a replacement … restarts the window here"). A
 *  stored beat from before that anchor is the OLD Machine's, so its rung says nothing about this one: the new attempt's
 *  first stepped beat alarms. (The stale-beat arm moves the anchor too; a re-alarm after it is the safe direction.)
 *
 *  #980 review, carried into R2004: a `stopped` beat is a process's FINAL beat and reports no rung. Fly restarts a
 *  crashed compositor IN PLACE (the same Machine and attempt), so the dedupe reads THROUGH that beat to the attempt's
 *  last live beat — kept whole in the beat samples — and the restarted process's first beat on the rung its predecessor
 *  held is no new step. Read only after a final beat, so an ordinary beat costs no query. A read that fails answers
 *  null: an extra alarm is the safe direction for a sizing alarm, a lost one is not. */
async function previousRungOf(tx: Tx, before: Row): Promise<unknown> {
  if (before.mode !== "composed") return null;
  if (!storedBeatIsThisAttempt(before)) return null;
  if (before.last_heartbeat?.state !== "stopped") return before.last_heartbeat?.rung ?? null;
  // #983 r2: read on the beat's own row-lock transaction (the LOCKED row's anchor, no second pooled connection), in a
  // SAVEPOINT: a read that fails rolls back to it and answers null, and the beat's write still commits — without the
  // savepoint a failed read would abort the whole transaction and 500 the beat.
  try {
    return await tx.savepoint((sp) => latestLiveRung(sp, before.id, before.beat_window_at));
  } catch (err) {
    log.error({ sid: before.id, err: String(err) }, "stream session: the sizing alarm's previous rung could not be read — the beat may re-alarm");
    return null;
  }
}

/** Final review D4: a compositor that drops proof-of-play items leaves a hole in a sponsor's report, so it is logged - ONCE
 *  per session, not on every beat: `airingsDropped` is a process total sent on every beat once above 0, so only the beat
 *  that first reports one after a stored beat that reported none warns (read on the locked row, so two web machines agree).
 *  A restarted compositor that drops again starts from none and warns again: a new process's loss is news. */
function warnAiringsDropped(cur: Row, beat: RelayHeartbeat): void {
  const dropped = beat.airingsDropped ?? 0;
  if (dropped <= 0) return;
  const before = cur.last_heartbeat?.airingsDropped;
  if (typeof before === "number" && before > 0) return;
  log.warn({ sid: cur.id, orgId: cur.org_id, airingsDropped: dropped }, "stream session: the compositor dropped sponsor proof-of-play items (its 64-item buffer overflowed, or a 400/422 refused a batch) — the sponsor report undercounts this session");
}

/** R4 S8: `recordAirings` on the beat's transaction, isolated in a savepoint like `sampleBeat` is outside it — a
 *  database error rolls back the airings only, is logged and reported, and the beat is stored and answered anyway. */
async function recordBeatAirings(tx: Tx, cur: Row, items: NonNullable<RelayHeartbeat["airings"]>, now: Date): Promise<void> {
  try {
    await tx.savepoint((sp) => recordAirings(sp, { sessionId: cur.id, orgId: cur.org_id, fixtureId: cur.fixture_id ?? null }, items, now));
  } catch (err) {
    log.error({ sid: cur.id, items: items.length, code: (err as { code?: string }).code ?? null, err: String(err) }, "stream session: a heartbeat's sponsor airings were not recorded — the beat is answered anyway");
    captureError(err, { orgId: cur.org_id, route: "relay.sponsor_airings.record", extra: { sessionId: cur.id, items: items.length } });
  }
}

/** Whether the row's STORED beat belongs to the current attempt. #980 review M2: a retry boots a new Machine — a new
 *  process — and restarts the beat window (beat_window_at, I4: "booted a replacement … restarts the window here"), so a
 *  stored beat from before that anchor is the OLD Machine's. (The stale-beat arm moves the anchor too: after it a stored
 *  beat reads as another attempt's, so a rung re-alarms and the next beat writes — the direction that never drops a live
 *  process's beat.) The sizing alarm's dedupe and the beat route's Owed 37 guard read it. It judges the STORED beat,
 *  which carries no attempt of its own; the INCOMING beat's attempt is its token's `att` (`supersededAttempt`). */
function storedBeatIsThisAttempt(row: Pick<Row, "beat_window_at" | "heartbeat_at">): boolean {
  return row.beat_window_at == null
    || (row.heartbeat_at != null && new Date(row.heartbeat_at).getTime() > new Date(row.beat_window_at).getTime());
}

/** Owed 37: a stored beat that is a FINAL after which no live process of this attempt is left to beat. Every stopped beat
 *  but two: a `fatal` final is a crash, and a `restart` final (Owed 66) the compositor's own in-place restart — Fly restarts
 *  both IN PLACE on the SAME attempt (R2003b / `restartsInPlaceAfter`, runner-fly.ts `on-failure`), and the restarted
 *  process's beats are what hold the composed stale window off — so they must still write (AGENTS.md class 13). A late
 *  beat of the exited process is indistinguishable from them without a seq, and writes too. The rest (R2003): no reason
 *  tears the Machine down (its retry is a NEW attempt), `ended` / `deadline` / `refused` end the session, `signalled` is
 *  exit 0 (Fly never restarts it), and `session_gone` is a run whose session is already over. */
function closesAttempt(stored: Row["last_heartbeat"]): boolean {
  if (stored?.state !== "stopped") return false;
  return !restartsInPlaceAfter(stored.exitReason as RelayHeartbeat["exitReason"]);
}

/** The relay sizing alarm (owner ruling 2026-10-18, compositor `docs/_INDEX.md` Owed 20: "no lite mode; if CPU impacts,
 *  measure and raise the CPU size"). The compositor's ladder is `full → overlay_half_rate` and the bottom holds, so a
 *  composed beat that STEPPED DOWN says its Machine is short of CPU. It is raised once per step and per attempt
 *  (domain/ladder.ts `steppedDownTo`, against the previous beat's STORED rung — so a web restart keeps the dedupe — when
 *  that beat belongs to this attempt), on two channels: a structured warning (`alarm: "sizing"`)
 *  and the house alerting path, Sentry, under route `relay.sizing_alarm` with ONE message so every alarm groups as one
 *  issue. Ops answer it by raising the Machine size (compositor C17 runbook). A passthrough session has no Machine, so it
 *  never alarms. Telemetry, like the sample: it never throws into the beat. */
function raiseSizingAlarm(before: Row, beat: RelayHeartbeat, previousRung: unknown): void {
  if (before.mode !== "composed") return;
  const rung = steppedDownTo(previousRung, beat.rung);
  if (rung === null) return;
  const facts = { sessionId: before.id, rung, previousRung, attempt: before.runner_attempts, machineId: before.machine_id };
  try {
    log.warn({ sid: before.id, orgId: before.org_id, alarm: "sizing", rung, previousRung, attempt: facts.attempt, machineId: facts.machineId },
      `relay sizing alarm: the compositor's degrade ladder stepped down to ${rung} — the Machine is short of CPU; raise the Machine size (compositor C17 runbook)`);
    captureError(new Error("relay sizing alarm: the compositor's degrade ladder stepped down — raise the Machine size"),
      { orgId: before.org_id, route: "relay.sizing_alarm", extra: facts });
  } catch (err) {
    log.error({ sid: before.id, err: String(err) }, "stream session: the sizing alarm was not raised — the beat is answered anyway");
  }
}

/** Ruling 13: every beat is a SAMPLE — typed columns from the fields RelayHeartbeat (Task 9) declares, the whole body in
 *  `raw` (sanitised). Capped per session; the cap is reported ONCE as an event.
 *
 *  ISOLATED, not transactional (Task 11 review I1b): a sample is telemetry and the beat is the control channel. A sample
 *  write that throws is logged and the beat goes on — its expiry tick, its callback_playing / callback_stopped and its
 *  reply. ONE transaction with the lifecycle is not available: the lifecycle is several transactions by design
 *  (applyExpiry and each callback `apply` take the row lock, commit, THEN run provider effects — the row lock is never
 *  held across a provider call), and a sample inside any of them would roll that transition back with it. telemetry.ts's
 *  `fitToColumn` removes the known cause (ffmpeg's fractional numbers in integer columns); this isolation is for the next. */
async function sampleBeat(sessionId: string, orgId: string, body: RelayHeartbeat, deps: SessionDeps): Promise<void> {
  try {
    const wrote = await recordSample(sql, { sessionId, source: "heartbeat", sampledAt: deps.now(), ingestState: body.state ?? null,
      fps: body.fps ?? null, bitrateKbps: body.bitrateKbps ?? null, droppedFrames: body.droppedFrames ?? null, encoderSpeed: body.encoderSpeed ?? null,
      runnerCpuPct: body.cpuPct ?? null, runnerMemMb: body.memMb ?? null,
      // Dh has NO source on this path, stated rather than left to look forgotten: `ingest_reason` is
      // Cloudflare's status.current.reason, and a Machine's beat reports the MACHINE, not the ingest
      // input. Reading the input here would add a paid Cloudflare call per beat (every 5 s per live
      // session). Explicitly null — a borrowed value in a column whose whole purpose is "what the
      // provider said" is a fabricated fact, and the poll writer is the one that fills it.
      ingestReason: null, raw: body });
    if (wrote === "capped") {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and type = 'samples_capped'`;
      if (n === 0) await sql.begin(async (tx) => { await lockRow(tx, sessionId); await recordEvent(tx, { sessionId, orgId, source: "runner", kind: "event", type: "samples_capped", occurredAt: deps.now(), payload: { count: SAMPLES_PER_SESSION_CAP } }); });
    }
  } catch (err) {
    log.error({ sid: sessionId, code: (err as { code?: string }).code ?? null, err: String(err) }, "stream session: a heartbeat sample was not recorded — the beat is answered anyway");
  }
}
