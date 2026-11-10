import "server-only";
// server/usecases/stream-sessions.ts — the APPLICATION layer over the pure
// domain (server/relay/domain/*). One shape for every change:
//
//   apply(sessionId, command):  lock the row → toSession → decide(session,
//   command, now) → persist(next) → [consume_credit INSIDE the transaction]
//   → commit → the remaining effects through the ports → the session.
//
// This file never assigns `state`; it persists what `decide` returned. The
// expiry policy runs LAZILY through applyExpiry on every read, heartbeat,
// poll and admission (recommendation B) — no money or safety rule waits for
// the daily cron. Network calls (ingest, runner) happen OUTSIDE transactions;
// the replay fill (setFixtureStreamUrl, a withTenant caller) runs after every
// transaction has closed. E5: storage_exhausted is a REFUSAL (503, no row).
//
// Split by concern (src/server/MODULARIZATION.md). This folder replaces the
// single `stream-sessions.ts`; importers keep `from "@/server/usecases/stream-sessions"`
// and land here. The barrel re-exports exactly the public surface the file had;
// siblings never import it.
//
//   session-row   the fixture_stream_sessions row: shape, columns, Row <-> Session, loaders by id, the state sets
//   deps          the ports the application layer works through: SessionDeps and the process defaults
//   lookups       shared lookups: a fixture's org and competition, and its active session
//   destination   where a session streams: destination row, decrypted key, target connection, replay link
//   persist       persisting a transition: the aggregate, the facts it made true, the cost estimate
//   port-effects  port effects that never re-enter apply: recorded outcome, forced destroy, output release, phone-input off
//   apply         THE seam: apply (lock, decide, persist, consume) and the post-commit effects it feeds back into
//   ingest-poll   the coalesced ingest read: poll sample, D3's since, the claim window, carried words
//   expiry        the lazy expiry path: observe before expiring, applyExpiry, reconcileSession
//   storage       admission's recording pool: fitted usage, reservations, headroom, the overcommit report
//   holders       who holds a destination: holder guard, prior Machine / output teardown, target_in_use, holder expiry
//   refusals      start refusals: admit's verdict to HttpError, unreadable-key refusals, the early probe
//   provision     provisioning a new session: ingest inputs, their credentials, the first runner edge
//   start         Go live: createSession and the ONE start path every start comes through
//   panel-reads   the organiser panels' readers: the credits card, the run sheet's open-stream states
//   phone-lost    the phone-lost ends: the facts they judge on, the camera evidence, endIfPhoneLost
//   auto-stop     the automatic stop after the result (7.3): its facts, verdict and endIfAutoStopDue
//   tick          who advances a session: tickSession and the stream-tick pass over every open session
//   current       the organiser's projection: latestRow and currentSession
//   stop          the organiser's Stop: the automatic-start block stamp and stopSession
//   heartbeat     the Machine's beat: stored beat, programme-phase log, airings, sizing alarm, beat sample
//   job-facts     the relay job's facts: the session as the Machine reads it

export { ACTIVE_STATES, TERMINAL_STATES } from "./session-row";
export { defaultDeps } from "./deps";
export type { SessionDeps } from "./deps";
export { readSessionDestination, fillReplayUrl } from "./destination";
export { estimateCostMinor } from "./persist";
export { releaseOutput, disablePhoneInput, destroyListedMachine } from "./port-effects";
export { apply, retryRunner } from "./apply";
export type { Actor } from "./apply";
export { applyExpiry, reconcileSession } from "./expiry";
export {
  storageUsageForColumns,
  storageReservations,
  reportStorageOvercommit,
  storageHeadroomMinutes,
} from "./storage";
export { expireTargetHolders } from "./holders";
export { createSession, startBroadcast } from "./start";
export type { StartCause, StartActor } from "./start";
export { relayCredits, openStreamStates, holdStatesOf } from "./panel-reads";
export type { RelayCredits, OpenSessionRow } from "./panel-reads";
export { lastConnectedSampleAt } from "./phone-lost";
export type { CameraFacts } from "./phone-lost";
export { autoStopAppliesTo } from "./auto-stop";
export { tickSession, STREAM_TICK_BUDGET_MS, tickOpenSessions } from "./tick";
export type { TickObservation, StreamTickResult } from "./tick";
export { currentSession } from "./current";
export { stopSession } from "./stop";
export { heartbeat } from "./heartbeat";
export { sessionFactsForJob } from "./job-facts";
