import "server-only";
// Provisioning a new session: ingest inputs, their credentials, the first runner edge (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { machineNameFor } from "@/server/relay/domain/runner";
import { storeInputCredentials, storePlaybackCredentials } from "@/server/relay/secret-columns";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { readRow } from "./session-row";
import type { SessionDeps } from "./deps";
import { recordEffect } from "./port-effects";
import { apply } from "./apply";

/** R2004: a composed camera input with no SRT playback credential cannot be read by the compositor — refused by name at
 *  provisioning, never discovered by a Machine that boots and has nothing to read. */
class CameraPlaybackMissing extends Error {
  constructor(inputId: string) {
    super(`stream session: the camera input ${inputId} came back without an SRT playback credential — a composed session cannot read it`);
    this.name = "CameraPlaybackMissing";
  }
}

export async function provisionSession(sessionId: string, deps: SessionDeps): Promise<void> {
  const provisioning = (await apply(sessionId, { type: "provision" }, deps))!;
  const composed = provisioning.mode === "composed";
  let creds: Awaited<ReturnType<SessionDeps["drivers"]["ingest"]["createLiveInput"]>> | undefined;
  let programme: typeof creds;
  try {
    creds = await recordEffect(provisioning, "create_live_input", "ingest", () => deps.drivers.ingest.createLiveInput({ sessionId, slot: 0 }), { slot: 0 });
    if (composed) {
      // R2004 (spec §5.3): Input A is the camera, read by the compositor over SRT PLAYBACK; Input B is the programme, which
      // the compositor publishes to and the destination output attaches to. A first, so a camera the compositor could not
      // read never costs a second input.
      if (!creds.srtPlayback) throw new CameraPlaybackMissing(creds.inputId);
      programme = await recordEffect(provisioning, "create_live_input", "ingest",
        () => deps.drivers.ingest.createLiveInput({ sessionId, slot: 0, role: "programme" }), { slot: 0, role: "programme" });
    }
  } catch (err) {
    log.error({ sid: sessionId, err }, "stream session: ingest create failed");
    // R2004: an input this attempt DID make is not left at the provider — nothing has connected to it, so it holds no
    // recording for the delete to leak (C2). A failed cleanup is reported with the uid; the sweep cannot reclaim an input
    // whose row is about to go with its session, so the alarm is the only trace.
    if (creds) {
      const orphan = creds.inputId;
      await deps.drivers.ingest.deleteInput(orphan).catch((cleanup: unknown) => {
        captureError(cleanup, { orgId: provisioning.orgId, route: "relay.provision_cleanup", extra: { sessionId, inputUid: orphan } });
        log.error({ sid: sessionId, inputUid: orphan, err: String(cleanup) }, "stream session: a provisioned input was NOT deleted after the create failed — it is orphaned at the provider");
      });
    }
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
  const camera = creds!;
  await sql.begin(async (tx) => {
    const [inp] = await tx<{ id: string }[]>`select id from fixture_stream_inputs where session_id = ${sessionId} and role = 'camera' and slot = 0`;
    await storeInputCredentials(tx, inp!.id, camera.inputId, camera);
    if (programme) {
      await storePlaybackCredentials(tx, inp!.id, camera.srtPlayback!);
      const [prog] = await tx<{ id: string }[]>`select id from fixture_stream_inputs where session_id = ${sessionId} and role = 'programme' and slot = 0`;
      await storeInputCredentials(tx, prog!.id, programme.inputId, programme);
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
  if (afterIngest?.state === "provisioning") await apply(sessionId, { type: "provisioned" }, deps);   // effects: add_output (C9; R2004: composed's on B)
}
