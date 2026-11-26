import "server-only";
// Provisioning a new session: ingest inputs, their credentials, the first runner edge (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { machineNameFor } from "@/server/relay/domain/runner";
import type { IngestCreateSpec, IngestCredentials, InputAccess } from "@/server/relay/ports";
import { storeInputCredentials, storePlaybackCredentials } from "@/server/relay/secret-columns";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { isTerminal, type SessionState } from "@/server/relay/domain/session";
import { readRow, toSession } from "./session-row";
import type { SessionDeps } from "./deps";
import { programmeAccess } from "./destination";
import { disablePhoneInput, forceDestroy, recordEffect } from "./port-effects";
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

/** Deletes inputs this attempt made at the provider, side by side. An input a start made has had nothing connect to it, so it
 *  holds no recording for the delete to leak (C2). A failed delete is reported with the uid — the sweep cannot reclaim an input
 *  whose row is about to go with its session, so the alarm is the only trace — and never keeps the others from being deleted. */
async function deleteInputs(sessionId: string, orgId: string, uids: string[], deps: SessionDeps): Promise<void> {
  await Promise.all(uids.map((orphan) => deps.drivers.ingest.deleteInput(orphan).catch((cleanup: unknown) => {
    captureError(cleanup, { orgId, route: "relay.provision_cleanup", extra: { sessionId, inputUid: orphan } });
    log.error({ sid: sessionId, inputUid: orphan, err: String(cleanup) }, "stream session: a provisioned input was NOT deleted after the create failed — it is orphaned at the provider");
  })));
}

/** Seazn Task 36b (with T36d's m1): destroys EVERY Machine the session has at the provider — the one its row names and every
 *  one the provider lists under its id, so a Machine whose create answered but whose id never reached the row (the `create_ok`
 *  write failed, or a create that landed late) is not left billing until the daily sweep. Each goes through `forceDestroy`
 *  (recorded on the session's ledger, alarmed on failure), so this runs BEFORE the session row is deleted: the ledger row
 *  needs it. Nothing here throws: the caller is a cleanup, and a provider or ledger fault must not keep it from deleting the
 *  inputs and the row. A listing that fails is reported and leaves the Machine to the daily sweep's orphan pass (A22(b)). */
async function destroySessionMachines(sessionId: string, orgId: string, reason: string, deps: SessionDeps): Promise<void> {
  const row = await readRow(sessionId);
  if (!row) return;
  const s = toSession(row);
  const ids = new Set<string>();
  if (s.runner.machineId !== null) ids.add(s.runner.machineId);
  try {
    for (const m of await deps.drivers.runner.list()) if (m.sessionId === sessionId) ids.add(m.runnerId);
  } catch (err) {
    captureError(err, { orgId, route: "relay.provision_cleanup", extra: { sessionId, step: "list_machines" } });
    log.error({ sid: sessionId, err: String(err) }, "stream session: the provider's Machines could not be listed to clean up an abandoned start — a Machine this start made is left to the daily sweep");
  }
  for (const machineId of ids) {
    try {
      await forceDestroy(s, machineId, "force_destroy", { machineId, reason }, deps);
    } catch (err) {
      captureError(err, { orgId, route: "relay.provision_cleanup", extra: { sessionId, machineId, step: "destroy_machine" } });
      log.error({ sid: sessionId, machineId, err: String(err) }, "stream session: an abandoned start's Machine destroy could not be recorded — it may still be running; the daily sweep retries it");
    }
  }
}

/** A start that cannot be provisioned, and its ONE exit (Seazn Task 36: both creates, any failure). Each failure is logged with
 *  the input it was for (`role`: camera or programme), then — Task 36b — every Machine the session has is destroyed (a composed
 *  start asks for its Machine while the inputs are made, so it may exist whichever input failed; `machineReason` is null for a
 *  start that asked for none), every input this attempt DID make is deleted, and the session goes. */
async function abandonProvisioning(
  sessionId: string, orgId: string, failures: { role: string; err: unknown }[], made: string[], machineReason: string | null, deps: SessionDeps,
): Promise<never> {
  for (const { role, err } of failures) log.error({ sid: sessionId, role, err }, "stream session: ingest create failed");
  // The Machine first (it bills), and before the row goes: its destroy is a row on this session's ledger.
  if (machineReason !== null) await destroySessionMachines(sessionId, orgId, machineReason, deps);
  // R2004: an input this attempt DID make is not left at the provider. Task 36: the deletes run side by side, and each reports
  // its own failure, so one failed delete never keeps the other input.
  await deleteInputs(sessionId, orgId, made, deps);
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

/** Waits for the Machine's create to settle on a start that is being abandoned. A runner error is not the start's answer there
 *  (the inputs' failure is), but it is logged, so a start that failed on both sides leaves both traces. */
async function settledRunner(sessionId: string, runner: ReturnType<typeof requestRunner> | null): Promise<void> {
  const ran = runner ? await runner : null;
  if (ran?.error !== undefined) log.error({ sid: sessionId, err: ran.error }, "stream session: the Machine's request also failed on a start that is being abandoned");
}

/** Seazn Task 36b: the Machine create, asked for while the inputs are made. `apply` persists the runner's first edge (none →
 *  creating) and runs the create, so the answer (and any retry or failure the runner table decides on) is back when this
 *  resolves. It never rejects: the caller reads the outcome after the inputs have settled, and a rejection nobody awaits yet is an
 *  unhandled one. Only while the row is STILL provisioning, decided on the LOCKED row (m4, fix round 1): a stop or the provision
 *  timeout can have ended the session, and `decide` refuses a runner create on an ended session. */
function requestRunner(sessionId: string, deps: SessionDeps): Promise<{ error?: unknown }> {
  return apply(sessionId, (s) => (s.state === "provisioning"
    ? { type: "runner", trigger: { type: "create_started", name: machineNameFor(sessionId, 1), attempt: 1 } }
    : null), deps).then(() => ({}), (error: unknown) => ({ error }));
}

export async function provisionSession(sessionId: string, deps: SessionDeps): Promise<void> {
  const provisioning = (await apply(sessionId, { type: "provision" }, deps))!;
  const composed = provisioning.mode === "composed";
  // Task 12 (G5): a Seazn session's programme input is created SIGNED (the camera never is). Read before any input is made,
  // so a deployment that cannot sign (admission refuses that first, on every driver: this is the backstop) or a Seazn session
  // that is not composed fails the start closed below with nothing at the provider to clean up — and, Task 36b, nothing asked
  // of the runner either: the Machine is requested only after this read.
  let access: InputAccess | undefined;
  try {
    access = programmeAccess(provisioning);
  } catch (err) {
    return abandonProvisioning(sessionId, provisioning.orgId, [{ role: "programme", err }], [], null, deps);
  }
  // Seazn Task 36b: a composed start asks for its Machine NOW, beside the inputs, not after them. The Machine's boot is the
  // longest wait of a start and needs none of the input credentials to begin: it reads them from the job facts, which answer a
  // typed 503 `inputs_not_ready` until they are stored (job-facts.ts) and which the compositor retries on its back-off
  // (1 s, doubling to 10 s, no attempt cap, fetch 5xx = Transient). Passthrough has no Machine.
  const runner = composed ? requestRunner(sessionId, deps) : null;
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
  const madeIds = made.map((m) => m.inputId);
  const failures = settled.flatMap((t, i) => (t.status === "rejected" ? [{ role: asks[i]!.role, err: t.reason as unknown }] : []));
  // Task 36b: an input failure waits for the Machine's create to SETTLE before it decides — the create is a call that cannot be
  // taken back, and a Machine still being made is one the cleanup could not yet see — then the abandon destroys it.
  if (failures.length > 0) {
    await settledRunner(sessionId, runner);
    return abandonProvisioning(sessionId, provisioning.orgId, failures, madeIds, composed ? "provision_abandoned" : null, deps);
  }
  // Nothing failed, so `made` holds every ask, in the order asked: the camera, then (composed) the programme.
  const [camera, programme] = made as [IngestCredentials, IngestCredentials | undefined];
  if (composed && !camera.srtPlayback) {
    await settledRunner(sessionId, runner);
    return abandonProvisioning(sessionId, provisioning.orgId, [{ role: "camera", err: new CameraPlaybackMissing(camera.inputId) }], madeIds, "provision_abandoned", deps);
  }
  try {
    // The credentials are stored the moment both inputs exist — never behind the Machine's create: a Machine that has booted
    // is already asking for them.
    // A Stop (or any other end) can land while the creates are out, and its `disable_phone_input` then read no input id: the
    // camera input would stay ENABLED. So a session that had ALREADY ENDED when the ids were stored switches it off here, first,
    // before anything below can throw. An end after the store reads the ids and does it itself. Never throws.
    if (await storeCredentials(sessionId, camera, programme, access, deps)) await disablePhoneInput(sessionId, deps);
    const ran = runner ? await runner : null;
    // A runner apply that THREW is the error of the start, as it was when the first edge ran after the credentials (the inputs
    // are stored and the row is left for F18, unless the error is a rollback, which goes out through the abandon below).
    if (ran?.error !== undefined) throw ran.error;
    await advance(sessionId, deps);
  } catch (err) {
    if (!isSerializationFailure(err)) throw err;
    // Task 36b review m1: the Machine's create may STILL be out (the credentials' write lost the race, not the Machine's). The
    // abandon lists and destroys what exists and then deletes the row — a create that lands after that finds no row, and its
    // Machine is named by nothing. So the create settles first, as it does on an input failure.
    await settledRunner(sessionId, runner);
    return abandonAfterRace(sessionId, provisioning.orgId, err, madeIds, deps);
  }
  // Task 36b: a Machine create that failed for good (made nothing, or a last attempt) failed the session before it ever went
  // live — so, as a destination output that cannot be added does (`failClosedOnOutput`), its inputs are deleted now: nothing has
  // connected to them. The row stays, with the failure the organiser reads (`machine_create_failed`) and its ledger; it keeps
  // the uids, so the retention sweep's later delete of a gone input is a 404, which is success. A session a STOP ended (it never
  // fails) or one still alive keeps its inputs, as before.
  const after = await readRow(sessionId);
  if (after?.state === "failed" && after.started_at === null) await deleteInputs(sessionId, provisioning.orgId, madeIds, deps);
}

/** Task 36d (defence in depth): a step after the inputs exist was rolled back by Postgres as a deadlock victim (40P01) or a
 *  serialization failure (40001) — the credentials' write, the runner's first edge, or `provisioned`. Left alone, the inputs
 *  stay at the provider with their credentials stored, the session sits in `provisioning` until F18, and the organiser reads a
 *  500. It goes out through the ONE exit instead (`abandonProvisioning`: the Machine destroyed, the inputs deleted, the session
 *  and its automatic stamp gone, 503 ingest_unavailable). Only while the row is STILL `provisioning`: one a stop or the timeout
 *  moved on is that writer's to tear down, and the error goes on unchanged. A composed row's Machines are destroyed first,
 *  every one the provider lists for the session and not only the one its row names (Task 36b m1: a Machine whose create answered
 *  but whose `create_ok` never landed is named by no row, and was left to the daily sweep). */
async function abandonAfterRace(sessionId: string, orgId: string, err: unknown, made: string[], deps: SessionDeps): Promise<never> {
  const row = await readRow(sessionId);
  if (row?.state !== "provisioning") {
    // Task 36b m2: the writer that moved the row on tears down what its rows name — and a rollback that took the credentials'
    // write with it left the inputs this start made on NO row: nobody could delete them. They are deleted here (a uid some row
    // carries is that writer's, and the retention sweep's), and the error goes on unchanged.
    await deleteInputs(sessionId, orgId, await inputsNoRowNames(sessionId, made), deps);
    throw err;
  }
  const code = (err as { code?: unknown }).code;
  log.error({ sid: sessionId, code, err }, "stream session: Postgres rolled a provisioning step back (a race with another writer) — the start is abandoned");
  captureError(err, { orgId, route: "relay.session.provision_race", extra: { sessionId, code } });
  return abandonProvisioning(sessionId, orgId, [], made, row.mode === "composed" ? "provision_race" : null, deps);
}

/** Task 36b m2: of the inputs a start made, those NO input row of the session names — the ones nobody else can delete, because
 *  the transaction that would have written their uids was rolled back. A uid some row carries is that row's writer's, and the
 *  retention sweep's. Exported for its own witness (a row naming an input cannot be had with a rollback in the same race). */
export async function inputsNoRowNames(sessionId: string, made: string[]): Promise<string[]> {
  if (made.length === 0) return [];
  const carried = new Set((await sql<{ uid: string }[]>`
    select ingest_input_id as uid from fixture_stream_inputs where session_id = ${sessionId} and ingest_input_id = any(${made})`).map((r) => r.uid));
  return made.filter((uid) => !carried.has(uid));
}

/** The credentials of both inputs, and the session's output input. One transaction: a Machine that reads the facts sees both
 *  or neither (job-facts.ts answers 503 `inputs_not_ready` until they are there).
 *
 *  Resolves `true` when the session had already ENDED. The answer is the session row's own `returning`, from the update that
 *  locks that row, so it leaves no gap with `apply` (which locks the same row to end a session): an end that committed first is
 *  seen here; any other commits after these ids do, and its `disable_phone_input` reads them. Both can switch (an end whose read
 *  runs after this commit) — a disable twice is success at the provider. A separate read would be one more thing to fail. */
async function storeCredentials(sessionId: string, camera: IngestCredentials, programme: IngestCredentials | undefined, access: InputAccess | undefined, deps: SessionDeps): Promise<boolean> {
  return (await sql.begin(async (tx) => {
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
    const [session] = await tx<{ state: SessionState }[]>`
      update fixture_stream_sessions set provisioned_at = coalesce(provisioned_at, ${deps.now()}), ingest_input_uid = ${outputInput}
       where id = ${sessionId} returning state`;
    return isTerminal(session!.state);
  })) as boolean;
}

/** `provisioned` is applied ONLY while the row is still provisioning. A stop, the wall clock, or the
 *  new provision_timeout (F18) can have moved it to ending/completed/failed while the ingest call was
 *  in flight — and `decide` THROWS InvalidTransition on `provisioned` from any of those, turning a
 *  routine race into a 500 on the organiser's own create. Re-read and skip if it moved. */
async function advance(sessionId: string, deps: SessionDeps): Promise<void> {
  const afterIngest = await readRow(sessionId);
  if (afterIngest?.state === "provisioning") await apply(sessionId, { type: "provisioned" }, deps);   // effects: add_output (C9; R2004: composed's on B; Seazn: none, G1)
}
