import { randomBytes } from "node:crypto";
import postgres from "postgres";
// captureV2's automatic stop advances time past the SAME default delay the server runs (the relay's one authority for
// its numbers). The module is import-free, so it loads under `--experimental-strip-types` (proven before relying on it).
import { AUTO_STOP_AFTER_RESULT_SECONDS, RELAY_OVERLAY_DELAY_DEFAULT_MS, RESERVATION_BUFFER_MINUTES } from "../../../apps/web/src/server/relay/config.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, newSession, call, check, signIn, tag, timedFixture, v1, v1data, setPlan } from "../harness.ts";

/**
 * Capture QR v2 over real HTTP (spec 2026-10-01 §11.1.6, case `capture-v2`), on the fake relay drivers: the organiser
 * mints the stream code → a phone claims the slot with it → the same phone gone silent (its last beat moved back in SQL)
 * is refused `409 phone_not_responding` (owner ruling 2026-10-09), its next beat restores it → the organiser's Go live →
 * the phone's beat hears `go-live`
 * for that session → the phone's descriptor GET carries the session AND its `cred`, while a SECOND phone's GET of the
 * same code carries the session and NO `cred` → the fake input connects (the T7 control route) → the phone's beat hears
 * `live` → the organiser's Stop → the beat hears `over`, stopped. W28/W27 (2026-10-06): both descriptors carry the
 * match's `stage` (the league's R1), and the phone asks for the match's Remote scoring link (`…/scoring-link`) — the
 * current phone is served `{url}` (the same one twice) on an https origin, or `503 unavailable` (nothing served on a URL
 * the contract refuses) where the server's origin is http; another phone is `409 replaced`. EVERY phone answer is `Cache-Control: private,
 * no-store` (§6.3: each one can carry a credential) — counted, and zero counted is a failure. The phone is a bare HTTP
 * client with the QR's Bearer tok and no cookie, as Seazn Capture is. Its own Pro org (a monthly credit to spend),
 * purged by cleanup(). SMOKE_ONLY=captureV2 runs it alone (SELECTABLE_SUITES).
 *
 * PR-2 (plan T8) — AUTOMATIC STREAMING on a second fixture (generic, so a device link can post its result): the
 * organiser's switch on over the API → a phone in Automatic (`mode: "automatic"`) claims its code and hears
 * `autoAllowed` → the match STARTS ON A DEVICE LINK (`core.start` with the link's Bearer dl_, no cookie — the
 * courtside surface, never the console) → the phone's beat hears `go-live` startedBy automatic and the one session is
 * `start_cause = 'automatic'` → the result goes in on the same link → ADVANCE: the result and the session are both
 * moved back past AUTO_STOP_AFTER_RESULT_SECONDS in SQL (both, by the same interval: the stop is owed only to a session
 * created BEFORE the result, A15) → the phone's next beat naming its sid hears `over` auto_stopped. A smoke server runs
 * the default three-minute delay (CI's smoke job tunes nothing), which is why time is advanced rather than waited out.
 * A beat right after the result, BEFORE the advance, is not yet over — so a stop at the result itself is red too.
 */
export async function captureV2Suite(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP  capture-v2 suite (DATABASE_URL not set — the plan change needs SQL)");
    return;
  }
  // R2004: an environment naming a compositor image runs the composed Go live AND its Stop (two steps) where the
  // imageless one runs the single 503 refusal. R2006 adds 12c (the stored stream mode) to both.
  const EXPECTED_STEPS = process.env.RELAY_IMAGE ? 28 : 27;
  let steps = 0;
  const step = (label: string, cond: boolean) => {
    check(`capture-v2 smoke: ${label}`, cond);
    steps++;
  };
  const done = () => {
    console.log(`capture-v2 smoke: ${steps} steps, ${phoneAnswers} phone answers`);
    check(`capture-v2 smoke: all ${EXPECTED_STEPS} steps ran (ran ${steps})`, steps === EXPECTED_STEPS);
  };
  let phoneAnswers = 0;
  const notPrivate: string[] = [];

  const owner = newSession();
  await signIn(owner, `delivered+capturev2_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string }[];
  const orgId = orgs[0].id;
  await setPlan(orgId, "pro", owner);
  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Capture ${tag}`, visibility: "public" }),
  );
  const fx = await timedFixture(owner, comp.id, {
    name: "Capture",
    sport_key: "hockey",
    variant_key: "fih-outdoor",
    entrants: [
      { kind: "team", display_name: `Capture Home ${tag}`, seed: 1 },
      { kind: "team", display_name: `Capture Away ${tag}`, seed: 2 },
    ],
  });

  // 1. MINT — the organiser's stream code (§6.1): the v2 QR, exactly {v, code, slot, tok}, and private.
  const minted = await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/stream-code`, "POST");
  type Qr = { v: number; code: string; slot: number; tok: string };
  const qr = (minted.json.data as { qr?: Qr } | undefined)?.qr;
  step(
    `POST stream-code → 200 with the v2 QR {v, code, slot, tok}, private, no-store (got ${minted.status})`,
    minted.status === 200 &&
      minted.headers.get("cache-control") === "private, no-store" &&
      !!qr &&
      JSON.stringify(Object.keys(qr)) === JSON.stringify(["v", "code", "slot", "tok"]) &&
      qr.v === 2,
  );
  if (!qr) return done();

  // The phone: Bearer tok, no cookie. Every answer's Cache-Control is recorded.
  type Answer = {
    state?: string; sid?: string; startedBy?: string; endReason?: string; cred?: unknown; playbackUrl?: string; code?: string;
    heartbeatUrl?: string; stage?: { code: string; role: { kind: string; n?: number; entrants?: number }; pool?: string; label?: string }; url?: string;
    message?: string;
  };
  const phoneCallOn = async (q: Qr, path: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; json: Answer | null }> => {
    const res = await fetch(`${BASE}/api/v1/capture/codes/${q.code}${path}`, {
      method,
      headers: { Authorization: `Bearer ${q.tok}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    phoneAnswers++;
    const cache = res.headers.get("cache-control");
    if (cache !== "private, no-store") notPrivate.push(`${method} ${path.split("?")[0] || "/"} → ${res.status} ${String(cache)}`);
    return { status: res.status, json: (await res.json().catch(() => null)) as Answer | null };
  };
  const phoneCall = (path: string, method: "GET" | "POST", body?: unknown) => phoneCallOn(qr, path, method, body);
  /** The organiser panel's read model (§9, `GET …/stream-phone`), as the panel polls it: the owner's session. */
  type PhoneRead = {
    auto?: { enabled?: unknown } | null;
    lastTakeover?: { at?: unknown; model?: unknown; elapsedMs?: unknown } | null;
  };
  const readPhone = async (fixtureId: string): Promise<{ status: number; data: PhoneRead | null }> => {
    const r = await v1(owner, `/api/v1/fixtures/${fixtureId}/stream-phone`);
    return { status: r.status, data: v1data<PhoneRead | null>(r) ?? null };
  };
  const phoneA = randomBytes(16).toString("hex");
  const phoneB = randomBytes(16).toString("hex");
  const beatOn = (q: Qr, phone: string, extra: Record<string, unknown> = {}) =>
    phoneCallOn(q, "/beats", "POST", {
      code: q.code, slot: q.slot, phone, claim: null, device: null, sid: null,
      at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), state: "paired", cause: null, notReady: null,
      startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null, delivery: "unknown",
      deliveredLagS: null, audioOk: null, battery: { percent: 80, charging: false, drainPctPerHour: null }, thermal: 0,
      dataUsedMB: 0, appVersion: "1.4.0", ...extra,
    });
  const beat = (phone: string, extra: Record<string, unknown> = {}) => beatOn(qr, phone, extra);
  const descriptor = (phone: string) => phoneCall(`?phone=${phone}&slot=${qr.slot}`, "GET");
  /** Beat until the answer's state is `want` (requested/provisioning answer `waiting`; the server ticks on a beat that
   *  names the session). Bounded: 40 beats a second apart. */
  const beatUntil = async (want: string, extra: () => Record<string, unknown>, on: { q: Qr; phone: string } = { q: qr, phone: phoneA }): Promise<Answer | null> => {
    for (let i = 0; i < 40; i++) {
      const r = await beatOn(on.q, on.phone, extra());
      if (r.json?.state === want) return r.json;
      await new Promise((res) => setTimeout(res, 1_000));
    }
    return null;
  };

  // 2. CLAIM — phone A scans and claims the free slot: waiting (paired, nothing started).
  const claimed = await beat(phoneA, { claim: "new", device: { model: "Smoke phone" } });
  step(`a NEW claim on a free slot → 200 waiting (got ${claimed.status} ${claimed.json?.state})`, claimed.status === 200 && claimed.json?.state === "waiting");

  // The organiser's destination (step 3 goes live on it; 2b is refused on it).
  const target = await v1(owner, `/api/v1/orgs/${orgId}/stream-targets`, "POST", {
    kind: "youtube",
    label: "capture-v2 smoke",
    streamKey: `smoke-${randomBytes(6).toString("hex")}`,
  });
  const targetId = (target.json.data as { id?: string } | undefined)?.id;

  // 2b. W5's second answer (owner ruling 2026-10-09): the phone IS paired but has stopped beating. Its last beat is moved
  // back past §6.9's window in SQL (10 min: past max(floor, cadence + slack) for every cadence the DB admits, 5..300 s —
  // a smoke server runs the default floor, so waiting it out would cost minutes) → the organiser's Go live is 409
  // phone_not_responding, never phone_not_paired, and writes no session; the phone's next beat answers it again.
  {
    const quietUrl = process.env.DATABASE_URL;   // the suite's first line returns without it
    const quiet = postgres(quietUrl, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(quietUrl) ? false : "require",
      prepare: !quietUrl.includes(":6543"),
      max: 1,
    });
    try {
      const moved = await quiet`
        update fixture_stream_pairings p set last_beat_at = now() - interval '10 minutes'
          from fixture_stream_codes c
         where c.id = p.code_id and c.fixture_id = ${fx.fixtureId} and c.ended_at is null and p.ended_at is null`;
      const silent = await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/stream-sessions`, "POST", { mode: "passthrough", targetId });
      const [{ n: rows }] = await quiet<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${fx.fixtureId}`;
      const back = await beat(phoneA);
      step(
        `a paired phone gone silent → Go live 409 phone_not_responding, no session row; its next beat → 200 (pairings moved ${moved.count}, Go live ${silent.status} ${silent.json.error?.code ?? ""}, rows ${rows}, beat ${back.status})`,
        moved.count === 1 && silent.status === 409 && silent.json.error?.code === "phone_not_responding" && rows === 0 && back.status === 200,
      );
      // 2c. R2001: a COMPOSED Go live on a deployment with no compositor image is 503 composed_unavailable, refused at the
      // start's entry — no session row, input, credit or runner is created. A smoke server sets no RELAY_IMAGE (CI's smoke job, ci-local.sh and
      // seazn-env alike); a smoke environment that names one gets the positive answer instead (R2004, below). The phone
      // is paired and answering again, so the passthrough Go live in step 3 is what admits.
      const composed = await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/stream-sessions`, "POST", { mode: "composed", targetId });
      if (process.env.RELAY_IMAGE) {
        // R2004: this environment names a compositor image (the server's and this process's env agree), so the composed
        // Go live is ADMITTED, and over real HTTP it provisions what the compositor needs: the camera input (with its
        // SRT playback credential, sealed) and the programme input, the destination output on the PROGRAMME (the
        // session's output input), two recordings' buffers of storage reserved (owner ruling 2026-10-18, option (a): both
        // record; 2026-10-26 E1: each holds the buffer at admission), and the default overlay delay copied in. Then its Stop, and the next read of the fake Machine completes it, so
        // the passthrough Go live in step 3 admits on the same fixture.
        const csid = (composed.json.data as { sessionId?: string } | undefined)?.sessionId ?? null;
        const ins = csid ? await quiet<{ role: string; ingest_input_id: string | null; playback: boolean }[]>`
          select role, ingest_input_id, (playback_srt_url is not null) as playback from fixture_stream_inputs where session_id = ${csid} order by role` : [];
        const [srow] = csid ? await quiet<{ ingest_input_uid: string | null; output_uid: string | null; reserved_minutes: number; overlay_delay_ms: number }[]>`
          select ingest_input_uid, output_uid, reserved_minutes, overlay_delay_ms from fixture_stream_sessions where id = ${csid}` : [];
        step(
          `R2004: a composed Go live with a compositor image → 201, a camera input (playback stored) and a programme input, the output on the programme, ${2 * RESERVATION_BUFFER_MINUTES} minutes reserved (two recordings, each holding the buffer at admission — owner ruling 2026-10-26), the default delay copied (got ${composed.status} ${composed.json.error?.code ?? ""}, inputs ${ins.map((i) => `${i.role}${i.playback ? "+playback" : ""}`).join(",")}, output input ${srow?.ingest_input_uid === ins[1]?.ingest_input_id ? "programme" : "other"}, reserved ${srow?.reserved_minutes}, delay ${srow?.overlay_delay_ms})`,
          composed.status === 201 && ins.length === 2 && ins[0].role === "camera" && ins[0].playback && ins[1].role === "programme" && !ins[1].playback
            && !!ins[1].ingest_input_id && srow?.ingest_input_uid === ins[1].ingest_input_id && srow?.output_uid != null
            && srow?.reserved_minutes === 2 * RESERVATION_BUFFER_MINUTES && srow?.overlay_delay_ms === RELAY_OVERLAY_DELAY_DEFAULT_MS,
        );
        const cstop = csid ? await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/stream-sessions/${csid}/stop`, "POST") : null;
        let cstate: string | undefined;
        for (let i = 0; i < 10 && cstate !== "completed"; i++) {
          const cur = await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/stream-sessions/current`, "GET");
          cstate = (cur.json.data as { id?: string; state?: string } | null | undefined)?.id === csid ? (cur.json.data as { state?: string }).state : cstate;
        }
        step(`R2004: the composed session's Stop → 200, and it completes (got ${cstop?.status}, ${cstate})`, cstop?.status === 200 && cstate === "completed");
      } else {
        const [{ n: composedRows }] = await quiet<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${fx.fixtureId}`;
        step(
          `a composed Go live with no compositor image → 503 composed_unavailable, no session row (got ${composed.status} ${composed.json.error?.code ?? ""}, rows ${composedRows})`,
          composed.status === 503 && composed.json.error?.code === "composed_unavailable" && composedRows === 0,
        );
      }
    } finally {
      await quiet.end();
    }
  }

  // 3. GO LIVE — the start: W5 admits it (a phone paired and answering).
  const made = await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/stream-sessions`, "POST", { mode: "passthrough", targetId });
  const sid = (made.json.data as { sessionId?: string } | undefined)?.sessionId;
  step(
    `the organiser's Go live with the phone paired → 201 (destination ${target.status}, session ${made.status} ${made.json.error?.code ?? ""})`,
    target.status === 201 && made.status === 201 && !!sid,
  );
  if (!sid) return done();

  // 4. The phone's beat hears go-live for THIS session, started by the organiser (§6.3.3).
  const heard = await beatUntil("go-live", () => ({}));
  step(
    `phone A's beat hears go-live for the session, startedBy organiser (got ${JSON.stringify(heard)})`,
    heard?.sid === sid && heard?.startedBy === "organiser",
  );

  // 5–6. The descriptor: the session's own phone gets its cred; a SECOND phone, on the same code, never does.
  const own = await descriptor(phoneA);
  step(
    `phone A's GET → 200, the session (${own.json?.state}) WITH cred (got ${own.status})`,
    own.status === 200 && own.json?.sid === sid && !!own.json?.cred,
  );
  const other = await descriptor(phoneB);
  step(
    `a second phone's GET of the same code → 200, the session, and NO cred (got ${other.status}, cred ${other.json && "cred" in other.json ? "present" : "absent"})`,
    other.status === 200 && other.json?.sid === sid && !!other.json && !("cred" in other.json),
  );

  // 6b. W28 — both descriptors carry the stage: the fixture is round 1 of a league (timedFixture), so the board's chip
  // R1 and the engine's plain round 1.
  // label (owner ruling 2026-10-08): the division's name ("Capture", above) · the round's long form ("Round 1": a league
  // round is a plain round, in the new org's default en); the league match has no pool.
  const wantStage = JSON.stringify({ code: "R1", role: { kind: "plain_round", n: 1 }, label: "Capture · Round 1" });
  step(
    `both descriptors carry the stage {code: R1, role: plain_round 1, label: Capture · Round 1} (got ${JSON.stringify(own.json?.stage)} / ${JSON.stringify(other.json?.stage)})`,
    JSON.stringify(own.json?.stage) === wantStage && JSON.stringify(other.json?.stage) === wantStage,
  );

  // 6c. W27 — the current phone's Remote scoring link. The descriptor's own heartbeatUrl names the server's capture
  // origin: on https the phone is served {url} on the agreed pattern, the same url twice (never a second link); on an
  // http origin (a local or CI server) the contract's pattern cannot be met, and the server refuses 503 unavailable.
  const origin = own.json?.heartbeatUrl ? new URL(own.json.heartbeatUrl).origin : "";
  const linkA = await phoneCall("/scoring-link", "POST", { phone: phoneA });
  const linkAgain = await phoneCall("/scoring-link", "POST", { phone: phoneA });
  const SCORING_URL = /^https:\/\/[^/]+\/score\/dl_[A-Za-z0-9_-]{43}$/;
  step(
    origin.startsWith("https://")
      ? `phone A's scoring link → 200 {url} on the agreed pattern, the same url twice (got ${linkA.status}, ${linkAgain.status}, same ${linkA.json?.url === linkAgain.json?.url})`
      : `phone A's scoring link on an http origin (${origin || "none"}) → 503 unavailable naming origin_not_https, twice (got ${linkA.status} ${linkA.json?.code} "${linkA.json?.message}", ${linkAgain.status})`,
    origin.startsWith("https://")
      ? linkA.status === 200 && SCORING_URL.test(linkA.json?.url ?? "") && JSON.stringify(Object.keys(linkA.json ?? {})) === '["url"]'
        && linkAgain.status === 200 && linkAgain.json?.url === linkA.json?.url
      // The refusal's own words (review M3): a crash's generic 503 unavailable must not pass for the https refusal.
      : origin.startsWith("http://") && [linkA, linkAgain].every((l) =>
        l.status === 503 && l.json?.code === "unavailable" && String(l.json?.message ?? "").includes("origin_not_https")),
  );
  const linkB = await phoneCall("/scoring-link", "POST", { phone: phoneB });
  step(
    `a second phone's scoring link → 409 replaced, no url (got ${linkB.status} ${linkB.json?.code})`,
    linkB.status === 409 && linkB.json?.code === "replaced" && !("url" in (linkB.json ?? {})),
  );

  // 7. FAKE CONNECT — the T7 control flips the session's fake input to connected (the phone's video arriving).
  const inputId = own.json?.playbackUrl ? (new URL(own.json.playbackUrl).pathname.split("/")[1] ?? "") : "";
  const flip = await fetch(`${BASE}/api/internal/relay/fake-ingest/${encodeURIComponent(inputId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "connected" }),
  });
  step(`POST fake-ingest/{input} {connected} → 200 (got ${flip.status}, input ${inputId ? "named" : "missing"})`, flip.status === 200 && inputId.length > 0);

  // 8. LIVE — the phone, publishing the sid it holds, hears live (its beat ticks the session).
  const publishing = () => ({ sid, state: "publishing", transport: "srt", delivery: "ok" });
  const liveAnswer = await beatUntil("live", publishing);
  step(`phone A's beat hears live for the session (got ${JSON.stringify(liveAnswer)})`, liveAnswer?.sid === sid);

  // 9. STOP — the organiser's Stop.
  const stopped = await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/stream-sessions/${sid}/stop`, "POST");
  step(`the organiser's Stop → 200 (got ${stopped.status})`, stopped.status === 200);

  // 10. OVER — the phone that held it hears over, stopped.
  const over = await beat(phoneA, publishing());
  step(
    `phone A's next beat hears over, stopped (got ${JSON.stringify(over.json)})`,
    over.status === 200 && over.json?.state === "over" && over.json?.sid === sid && over.json?.endReason === "stopped",
  );

  // 12–17. PR-2: AUTOMATIC STREAMING on a second fixture of the same org (generic: a device link can post its result).
  const dbUrl = process.env.DATABASE_URL; // the suite's first line returns without it
  const db = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    const autoFx = await timedFixture(owner, comp.id, {
      name: "Capture auto",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      entrants: [
        { kind: "individual", display_name: `Auto Home ${tag}`, seed: 1 },
        { kind: "individual", display_name: `Auto Away ${tag}`, seed: 2 },
      ],
    });

    // 12. The organiser's switch (§7.1): on, over the API — the answer names it and leaves the destination unchosen.
    // R2006: the answer carries the score preferences too, all unset (null = the server's default) — a body naming one
    // field writes only that field.
    const autoBefore = await readPhone(autoFx.fixtureId);
    const switched = await v1(owner, `/api/v1/fixtures/${autoFx.fixtureId}/stream-settings`, "PUT", { autoStream: true });
    const unsetPrefs = { streamMode: null, overlayTemplate: null, overlayDelayMs: null };
    // PR #989 confirm N1: every answer also carries the row's revision, a number every write moves. It is compared apart.
    const answerOf = (data: unknown) => {
      const { revision, ...rest } = (data ?? {}) as { revision?: unknown };
      return { revision, rest: JSON.stringify(rest) };
    };
    const switchedAnswer = answerOf(switched.json.data);
    step(
      `PUT stream-settings {autoStream: true} → 200 {targetId: null, autoStream: true}, the score preferences unset, a revision (got ${switched.status} ${JSON.stringify(switched.json.data)})`,
      switched.status === 200 && switchedAnswer.rest === JSON.stringify({ targetId: null, autoStream: true, ...unsetPrefs })
        && typeof switchedAnswer.revision === "number",
    );

    // 12c. R2006 (owner ruling 2026-10-19, "Option C"): the organiser's "Camera only", stored — the automatic start in step
    // 15 READS it (lib/stream-settings.ts effectiveStreamMode). On a server naming a compositor image the default is the
    // score, so step 15's passthrough session is the witness that the stored mode was read; on an imageless one the
    // default is the camera as well. The switch from step 12 survives a body that names only the mode.
    const cameraOnly = await v1(owner, `/api/v1/fixtures/${autoFx.fixtureId}/stream-settings`, "PUT", { streamMode: "passthrough" });
    const cameraOnlyAnswer = answerOf(cameraOnly.json.data);
    step(
      `PUT stream-settings {streamMode: "passthrough"} → 200, stored, the switch still on, a later revision (got ${cameraOnly.status} ${JSON.stringify(cameraOnly.json.data)})`,
      cameraOnly.status === 200
        && cameraOnlyAnswer.rest === JSON.stringify({ targetId: null, autoStream: true, ...unsetPrefs, streamMode: "passthrough" })
        && typeof cameraOnlyAnswer.revision === "number" && typeof switchedAnswer.revision === "number"
        && cameraOnlyAnswer.revision > switchedAnswer.revision,
    );

    // 12b. The organiser's read (§9, PR-2 T6) serves the switch: `auto` null before it (the empty case — a fixture with
    // no settings row), `auto.enabled` true after. The panel's switch renders from this read, never from the PUT's answer.
    const autoAfter = await readPhone(autoFx.fixtureId);
    step(
      `GET stream-phone serves the switch: auto null before the PUT, auto.enabled true after (got ${autoBefore.status} ${JSON.stringify(autoBefore.data?.auto)} → ${autoAfter.status} ${JSON.stringify(autoAfter.data?.auto)})`,
      autoBefore.status === 200 && autoBefore.data?.auto === null && autoAfter.status === 200 && autoAfter.data?.auto?.enabled === true,
    );

    // 13. A phone in Automatic claims the fixture's code: waiting, and the switch reaches it (autoAllowed, A4's other half).
    const autoMinted = await v1(owner, `/api/v1/fixtures/${autoFx.fixtureId}/stream-code`, "POST");
    const qrAuto = (autoMinted.json.data as { qr?: Qr } | undefined)?.qr;
    if (!qrAuto) {
      step(`POST stream-code for the automatic fixture → 200 with a QR (got ${autoMinted.status})`, false);
      return done();
    }
    const phoneC = randomBytes(16).toString("hex");
    const automatic = { mode: "automatic" };
    const claimedC = await beatOn(qrAuto, phoneC, { ...automatic, claim: "new", device: { model: "Smoke phone C" } });
    step(
      `a phone in Automatic claims the code → 200 waiting, autoAllowed true (got ${claimedC.status} ${claimedC.json?.state} ${String((claimedC.json as { autoAllowed?: unknown } | null)?.autoAllowed)})`,
      claimedC.status === 200 && claimedC.json?.state === "waiting" && (claimedC.json as { autoAllowed?: unknown }).autoAllowed === true,
    );

    // 14. The match STARTS ON A DEVICE LINK: the courtside surface's own core.start, its Bearer dl_ and no cookie.
    const link = await v1(owner, `/api/v1/fixtures/${autoFx.fixtureId}/device-links`, "POST", { label: "Smoke court" });
    const dl = (link.json.data as { id?: string; secret?: string } | undefined) ?? {};
    const viaLink = (type: string, payload: Record<string, unknown>, expectedSeq: number) =>
      v1(newSession(), `/api/v1/fixtures/${autoFx.fixtureId}/events`, "POST", { expected_seq: expectedSeq, type, payload }, { Authorization: `Bearer ${dl.secret ?? ""}` });
    const started = await viaLink("core.start", {}, 0);
    const [startRow] = await db<{ device_link_id: string | null }[]>`
      select device_link_id from score_events where fixture_id = ${autoFx.fixtureId} and type = 'core.start'`;
    step(
      `core.start through the device link → 201, written BY the link (link ${link.status}, event ${started.status}, device_link_id ${startRow?.device_link_id === dl.id ? "the link's" : String(startRow?.device_link_id)})`,
      link.status === 201 && !!dl.secret && started.status === 201 && !!dl.id && startRow?.device_link_id === dl.id,
    );

    // 15. AUTO START (§7.2): the phone's beat starts the broadcast; it hears go-live, started automatically — one session.
    const autoLive = await beatUntil("go-live", () => automatic, { q: qrAuto, phone: phoneC });
    const autoSessions = await db<{ id: string; start_cause: string; mode: string }[]>`
      select id, start_cause, mode from fixture_stream_sessions where fixture_id = ${autoFx.fixtureId}`;
    step(
      `phone C's beat hears go-live startedBy automatic, and the fixture has ONE session, start_cause automatic, Camera only as stored in 12c (got ${JSON.stringify(autoLive)}, ${JSON.stringify(autoSessions)})`,
      autoLive?.startedBy === "automatic" && autoSessions.length === 1 && autoSessions[0].start_cause === "automatic" && autoLive.sid === autoSessions[0].id
        && autoSessions[0].mode === "passthrough",
    );
    const autoSid = autoSessions[0]?.id;
    if (!autoSid) return done();

    // 16. The RESULT, courtside, through the same link: the fixture is finished (V430's trigger stamps finished_at).
    const result = await viaLink("generic.result", { p1Score: 2, p2Score: 1 }, 1);
    const [fin] = await db<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${autoFx.fixtureId}`;
    step(
      `generic.result through the device link → 201, finished_at stamped (got ${result.status} ${result.json.error?.code ?? ""}, ${fin?.finished_at ? "stamped" : "null"})`,
      result.status === 201 && !!fin?.finished_at,
    );

    // 16b. NOT YET: a beat right after the result, naming the sid, ticks the session INSIDE the delay — it is not over.
    // (Without this, a server that stopped at the result itself would pass step 17 just the same.)
    const notYet = await beatOn(qrAuto, phoneC, { ...automatic, sid: autoSid, state: "publishing", transport: "srt", delivery: "ok" });
    const [stillOpen] = await db<{ state: string; end_reason: string | null }[]>`
      select state, end_reason from fixture_stream_sessions where id = ${autoSid}`;
    step(
      `a beat right after the result is NOT over — the stop waits for the delay (got ${JSON.stringify(notYet.json)}, ${JSON.stringify(stillOpen)})`,
      notYet.status === 200 && !!notYet.json?.state && notYet.json.state !== "over" && notYet.json.sid === autoSid
        && stillOpen?.end_reason === null && stillOpen.state !== "completed" && stillOpen.state !== "failed",
    );

    // 17. ADVANCE past the delay: the result AND the session move back by the same interval (the session must stay
    // older than the result, A15), past the longer of the default and any tuned delay — then the phone's next beat
    // names its sid, ticks the session, and hears it over, auto_stopped.
    const delayS = Math.max(AUTO_STOP_AFTER_RESULT_SECONDS, Number(process.env.AUTO_STOP_AFTER_RESULT_SECONDS ?? 0) || 0) + 5;
    await db`update fixture_stream_sessions set created_at = created_at - make_interval(secs => ${delayS}) where id = ${autoSid}`;
    await db`update fixtures set finished_at = finished_at - make_interval(secs => ${delayS}) where id = ${autoFx.fixtureId}`;
    const autoOver = await beatOn(qrAuto, phoneC, { ...automatic, sid: autoSid, state: "publishing", transport: "srt", delivery: "ok" });
    const [autoEnded] = await db<{ state: string; end_reason: string | null }[]>`
      select state, end_reason from fixture_stream_sessions where id = ${autoSid}`;
    step(
      `after the delay, phone C's beat hears over auto_stopped and the session ended auto_stopped (got ${JSON.stringify(autoOver.json)}, ${JSON.stringify(autoEnded)})`,
      autoOver.status === 200 && autoOver.json?.state === "over" && autoOver.json?.sid === autoSid && autoOver.json?.endReason === "auto_stopped"
        && autoEnded?.end_reason === "auto_stopped",
    );
  } finally {
    await db.end();
  }

  // 18–19. PR-2 §7.5 (T12, B7 review I-2): the organiser read's LAST TAKEOVER, on a third fixture whose code has no
  // session — so a second phone's NEW claim is a plain takeover of the first (§5.5 T2), never a refusal of a live slot.
  const takeFx = await timedFixture(owner, comp.id, {
    name: "Capture takeover",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    entrants: [
      { kind: "individual", display_name: `Take Home ${tag}`, seed: 1 },
      { kind: "individual", display_name: `Take Away ${tag}`, seed: 2 },
    ],
  });
  const takeMinted = await v1(owner, `/api/v1/fixtures/${takeFx.fixtureId}/stream-code`, "POST");
  const qrTake = (takeMinted.json.data as { qr?: Qr } | undefined)?.qr;
  if (!qrTake) {
    step(`POST stream-code for the takeover fixture → 200 with a QR (got ${takeMinted.status})`, false);
    return done();
  }
  const phoneE = randomBytes(16).toString("hex");
  const phoneF = randomBytes(16).toString("hex");
  const claimedE = await beatOn(qrTake, phoneE, { claim: "new", device: { model: "Smoke phone E" } });
  const noTakeover = await readPhone(takeFx.fixtureId);
  const claimedF = await beatOn(qrTake, phoneF, { claim: "new", device: { model: "Smoke phone F" } });
  const tookOver = await readPhone(takeFx.fixtureId);
  const took = tookOver.data?.lastTakeover;

  // 18. None after the first claim; after the second, the takeover with the NEW phone's model and its age on the
  // SERVER's clock (`elapsedMs`, the panel's 30-minute window) — a whole number of ms, never negative.
  step(
    `a second phone's claim is served as the last takeover: none after the first claim, then {model "Smoke phone F", elapsedMs a whole number ≥ 0} (claims ${claimedE.status}/${claimedF.status}, got ${JSON.stringify(noTakeover.data?.lastTakeover)} → ${JSON.stringify(took)})`,
    claimedE.status === 200 && claimedF.status === 200 && noTakeover.status === 200 && noTakeover.data?.lastTakeover === null
      && tookOver.status === 200 && took?.model === "Smoke phone F" && typeof took.elapsedMs === "number"
      && Number.isInteger(took.elapsedMs) && took.elapsedMs >= 0,
  );

  // 19. Revoke & reissue is the organiser's answer to a takeover: the read no longer serves it (only the ACTIVE code's).
  const reissued = await v1(owner, `/api/v1/fixtures/${takeFx.fixtureId}/stream-code/reissue`, "POST");
  const afterReissue = await readPhone(takeFx.fixtureId);
  step(
    `Revoke & reissue → 200, and the read's lastTakeover is null (got ${reissued.status}, ${afterReissue.status} ${JSON.stringify(afterReissue.data?.lastTakeover)})`,
    reissued.status === 200 && afterReissue.status === 200 && afterReissue.data?.lastTakeover === null,
  );

  // 11. Every phone answer above was private, no-store — and there were answers to judge.
  step(
    `every phone answer (${phoneAnswers}) is Cache-Control: private, no-store${notPrivate.length ? ` — not: ${notPrivate.join("; ")}` : ""}`,
    phoneAnswers > 0 && notPrivate.length === 0,
  );
  done();
}
