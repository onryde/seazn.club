import "server-only";
// Provisioning a new session: ingest inputs, their credentials, the first runner edge (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { machineNameFor } from "@/server/relay/domain/runner";
import type { IngestCreateSpec, IngestCredentials, InputAccess } from "@/server/relay/ports";
import { storeInputCredentials, storePlaybackCredentials } from "@/server/relay/secret-columns";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { readRow, toSession } from "./session-row";
import type { SessionDeps } from "./deps";
import { programmeAccess } from "./destination";
import { forceDestroy, recordEffect } from "./port-effects";
import { apply } from "./apply";
import { isSerializationFailure } from "./refusals";

/** R2004: a composed camera input with no SRT playback credential cannot be read by the compositor — refused by name at
 *  provisioning, never discovered by a Machine that boots and has nothing to read. */
class CameraPlaybackMissing extends Error {
  constructor(inputId: string) {
    super(`stream session: the camera input ${inputId} came back without an SRT playback credential — a composed session cannot read it`);
    this.name = "CameraPlaybackMissing";
  }
}

/** A start that cannot be provisioned, and its ONE exit (Seazn Task 36: both creates, any failure). Each failure is logged with
 *  the input it was for (`role`: camera or programme), every input this attempt DID make is deleted, and the session goes. */
async function abandonProvisioning(
  sessionId: string, orgId: string, failures: { role: string; err: unknown }[], made: string[], deps: SessionDeps,
): Promise<never> {
  for (const { role, err } of failures) log.error({ sid: sessionId, role, err }, "stream session: ingest create failed");
  // R2004: an input this attempt DID make is not left at the provider — nothing has connected to it, so it holds no
  // recording for the delete to leak (C2). A failed cleanup is reported with the uid; the sweep cannot reclaim an input
  // whose row is about to go with its session, so the alarm is the only trace. Task 36: the deletes run side by side, and
  // each reports its own failure, so one failed delete never keeps the other input.
  await Promise.all(made.map((orphan) => deps.drivers.ingest.deleteInput(orphan).catch((cleanup: unknown) => {
    captureError(cleanup, { orgId, route: "relay.provision_cleanup", extra: { sessionId, inputUid: orphan } });
    log.error({ sid: sessionId, inputUid: orphan, err: String(cleanup) }, "stream session: a provisioned input was NOT deleted after the create failed — it is orphaned at the provider");
  })));
  // No §6.4 reason fits; no dead row (E5's logic) — the events cascade with it (the ONE delete the append-only trigger
  // allows). Final review m-1: an automatic start's stamp goes WITH its session, in one transaction — the FK's
  // `on delete set null` would clear only the id and leave `auto_started_at`, so a start that never existed would block
  // every retry of the match.
  await sql.begin(async (tx) => {
    await tx`update fixture_stream_settings set auto_started_at = null, auto_start_session_id = null where auto_start_session_id = ${sessionId}`;
    await tx`delete from fixture_stream_sessions where id = ${sessionId}`;
  });
  throw new HttpError(503, "the streaming ingest is unavailable", "ingest_unavailable");
}

export async function provisionSession(sessionId: string, deps: SessionDeps): Promise<void> {
  const provisioning = (await apply(sessionId, { type: "provision" }, deps))!;
  const composed = provisioning.mode === "composed";
  // Task 12 (G5): a Seazn session's programme input is created SIGNED (the camera never is). Read before any input is made,
  // so a deployment that cannot sign (admission refuses that first, on every driver: this is the backstop) or a Seazn session
  // that is not composed fails the start closed below with nothing at the provider to clean up.
  let access: InputAccess | undefined;
  try {
    access = programmeAccess(provisioning);
  } catch (err) {
    return abandonProvisioning(sessionId, provisioning.orgId, [{ role: "programme", err }], [], deps);
  }
  // R2004 (spec §5.3): Input A is the camera, read by the compositor over SRT PLAYBACK; Input B is the programme, which the
  // compositor publishes to and the destination output attaches to (Seazn: no output; viewers play B). Seazn Task 36: a
  // composed start asks for A and B AT ONCE, so it waits for the slower create rather than the sum of the two. The price is
  // the old "A first" ordering, which kept a camera the compositor could not read from ever costing a second input: that rare
  // failure now costs one extra create and its delete. Passthrough asks for A alone, the one call it always made.
  const asks: { role: "camera" | "programme"; spec: IngestCreateSpec; payload: Record<string, unknown> }[] = [
    { role: "camera", spec: { sessionId, slot: 0 }, payload: { slot: 0 } },
    ...(composed
      ? [{ role: "programme" as const, spec: { sessionId, slot: 0, role: "programme" as const, ...(access ? { access } : {}) }, payload: { slot: 0, role: "programme" } }]
      : []),
  ];
  // Task 36d (T36 review m3): each input the PROVIDER made is captured inside the thunk, the moment the driver answers — as
  // forceDestroy captures its provider failure. A create that succeeded and whose ledger write then threw rejects through
  // recordEffect, and reading `made` off the settled results alone lost its uid: the input was orphaned with no
  // relay.provision_cleanup report. From the capture it is in the cleanup's list like any other.
  const created: (IngestCredentials | undefined)[] = asks.map(() => undefined);
  const settled = await Promise.allSettled(asks.map(({ spec, payload }, i) =>
    recordEffect(provisioning, "create_live_input", "ingest", async () => (created[i] = await deps.drivers.ingest.createLiveInput(spec)), payload)));
  // Every input that WAS made, whatever happened to the other create or to its own ledger row: the cleanup's list, in the order
  // asked. A create still out cannot be forgotten — allSettled waits for the last answer before anything is decided.
  const made = created.flatMap((c) => (c ? [c] : []));
  const failures = settled.flatMap((t, i) => (t.status === "rejected" ? [{ role: asks[i]!.role, err: t.reason as unknown }] : []));
  if (failures.length > 0) return abandonProvisioning(sessionId, provisioning.orgId, failures, made.map((m) => m.inputId), deps);
  // Nothing failed, so `made` holds every ask, in the order asked: the camera, then (composed) the programme.
  const [camera, programme] = made as [IngestCredentials, IngestCredentials | undefined];
  if (composed && !camera.srtPlayback) {
    return abandonProvisioning(sessionId, provisioning.orgId, [{ role: "camera", err: new CameraPlaybackMissing(camera.inputId) }], made.map((m) => m.inputId), deps);
  }
  try {
    await storeAndAdvance(sessionId, composed, camera, programme, access, deps);
  } catch (err) {
    if (!isSerializationFailure(err)) throw err;
    return abandonAfterRace(sessionId, provisioning.orgId, err, made.map((m) => m.inputId), deps);
  }
}

/** Task 36d (defence in depth): a step after the inputs exist was rolled back by Postgres as a deadlock victim (40P01) or a
 *  serialization failure (40001) — the credentials' write, the runner's first edge, or `provisioned`. Left alone, the inputs
 *  stay at the provider with their credentials stored, the session sits in `provisioning` until F18, and the organiser reads a
 *  500. It goes out through the ONE exit instead (`abandonProvisioning`: the inputs deleted, the session and its automatic stamp
 *  gone, 503 ingest_unavailable). Only while the row is STILL `provisioning`: one a stop or the timeout moved on is that
 *  writer's to tear down, and the error goes on unchanged. A composed row whose Machine was already made has it destroyed first
 *  (forceDestroy: recorded, alarmed on failure); a Machine whose create answered but whose `create_ok` never landed is named by
 *  no row once the session goes, which is the daily sweep's orphan pass (A22(b)). */
async function abandonAfterRace(sessionId: string, orgId: string, err: unknown, made: string[], deps: SessionDeps): Promise<never> {
  const row = await readRow(sessionId);
  if (row?.state !== "provisioning") throw err;
  const code = (err as { code?: unknown }).code;
  log.error({ sid: sessionId, code, err }, "stream session: Postgres rolled a provisioning step back (a race with another writer) — the start is abandoned");
  captureError(err, { orgId, route: "relay.session.provision_race", extra: { sessionId, code } });
  const s = toSession(row);
  if (s.runner.machineId !== null) await forceDestroy(s, s.runner.machineId, "force_destroy", { reason: "provision_race" }, deps);
  return abandonProvisioning(sessionId, orgId, [], made, deps);
}

/** Everything after both inputs exist: their credentials, the runner's first edge (composed), and `provisioned`. */
async function storeAndAdvance(
  sessionId: string, composed: boolean, camera: IngestCredentials, programme: IngestCredentials | undefined,
  access: InputAccess | undefined, deps: SessionDeps,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [inp] = await tx<{ id: string }[]>`select id from fixture_stream_inputs where session_id = ${sessionId} and role = 'camera' and slot = 0`;
    await storeInputCredentials(tx, inp!.id, camera.inputId, camera);
    if (programme) {
      await storePlaybackCredentials(tx, inp!.id, camera.srtPlayback!);
      const [prog] = await tx<{ id: string }[]>`select id from fixture_stream_inputs where session_id = ${sessionId} and role = 'programme' and slot = 0`;
      // Task 12: the signing the programme input was created with, in the statement that stores its credentials (never after).
      await storeInputCredentials(tx, prog!.id, programme.inputId, programme, access ?? null);
    }
    // ruling 13 facts: when, and which input (the uid is not a secret; the keys stayed *_enc). R2004: the session's OUTPUT
    // input — the one its destination output attaches to and whose recording is the session's: the camera for
    // passthrough, the programme for composed.
    const outputInput = programme ? programme.inputId : camera.inputId;
    await tx`update fixture_stream_sessions set provisioned_at = coalesce(provisioned_at, ${deps.now()}), ingest_input_uid = ${outputInput} where id = ${sessionId}`;
  });
  if (composed) {
    // The lifecycle's first edge: none → creating (intent persisted) → create_machine → create_ok | create_failed.
    // m4 (fix round 1): only while the row is STILL provisioning, decided on the LOCKED row (the null command writes and
    // runs nothing). Nothing holds a lock across the ingest call above, so the organiser's stop — or the provision timeout
    // — can have ended the session meanwhile, and `decide` refuses a runner create on an ended session: InvalidTransition,
    // a 500 on the organiser's own create. The session's state is then the answer; no Machine is asked for.
    await apply(sessionId, (s) => (s.state === "provisioning"
      ? { type: "runner", trigger: { type: "create_started", name: machineNameFor(sessionId, 1), attempt: 1 } }
      : null), deps);
  }
  // `provisioned` is applied ONLY while the row is still provisioning. A stop, the wall clock, or the
  // new provision_timeout (F18) can have moved it to ending/completed/failed while the ingest call was
  // in flight — and `decide` THROWS InvalidTransition on `provisioned` from any of those, turning a
  // routine race into a 500 on the organiser's own create. Re-read and skip if it moved.
  const afterIngest = await readRow(sessionId);
  if (afterIngest?.state === "provisioning") await apply(sessionId, { type: "provisioned" }, deps);   // effects: add_output (C9; R2004: composed's on B; Seazn: none, G1)
}
