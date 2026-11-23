import { randomBytes, randomUUID } from "node:crypto";
// The fake hosts' own names and the embed token's life, from the server's declarations (config.ts is import-free, so it loads
// under `--experimental-strip-types`, as captureV2 reads it).
import {
  FAKE_PLAYBACK_HOST, FAKE_REPLAY_EMBED_HOST, REPLAY_EMBED_TOKEN_TTL_SECONDS, SEAZN_CF_DELETE_DELAY_MINUTES, seaznHostedCost,
} from "../../../apps/web/src/server/relay/config.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, cookieHeader, newSession, check, signIn, smokeDb, tag, timedFixture, v1, v1data, setPlan, setStaff } from "../harness.ts";

/**
 * Seazn-hosted video, Phases 1 and 2 (plan Tasks 19 and 28), over real HTTP on the fake relay drivers and the fake replay host:
 *
 * 1. PRESENT AND FIRST — V541's trigger gives every organisation exactly one active `seazn` destination, made with the org,
 *    so it is the org's OLDEST destination: still first after a Twitch destination is added (read in SQL, the one place
 *    that holds in both modes).
 * 2. THE LIST — with SEAZN_HOSTED_LIVE off (every smoke job: no workflow sets it) the Streaming list leaves the Seazn row out
 *    and still lists the Twitch one; told LIVE is on (the runner's own SEAZN_HOSTED_LIVE, read as the e2e runner reads it),
 *    the Seazn row is listed once and FIRST.
 * 3. REFUSED WHILE OFF — naming the Seazn destination as the fixture's pick (PUT stream-settings) and starting on it (POST
 *    stream-sessions) are both refused `422 seazn_unavailable`, and the refused start writes no session row. Skipped when
 *    told LIVE is on: that refusal does not exist there.
 * 4. NO-STORE — the public video route answers `private, no-store` with `{ live: null, replay: [] }`, for this match (no
 *    video) and for an id that names no match.
 *
 * Phase 2 (Task 28): one recording of this match, through the replay swap (G-B, Task 25), read by the REAL public route:
 * 5. INTERIM — its copy still `encoding` on the replay host: the route lists ONE `hls` part 1, the recording signed on the fake
 *    Cloudflare host, and nothing of the replay host's.
 * 6. PLAYABLE — the copy reaches `playable` (verified): the route lists ONE `embed` part 1, the copy signed by the server's fake
 *    replay host (`https://<fake embed host>/embed/<library>/<copy>?token=<64 hex>&expires=<s>`, expiring the declared
 *    REPLAY_EMBED_TOKEN_TTL_SECONDS from now) and no `hls` part: never two parts for one recording.
 * 7. DELETE — the organiser's DELETE (Task 26) answers `{ deleted: true }`: the row is `deleted` by the organiser and has
 *    forgotten its copy (the server's host was asked to remove it). The route then lists NO part, the interim included,
 *    though the recording is still locked on Cloudflare. A second DELETE answers the same and changes nothing.
 *
 * Phase 3 (Task 32): what Seazn video costs, over the same HTTP:
 * 8. STAFF TABLE — /admin/orgs/[id] as staff ships the "Seazn video" table (Task 31): EMPTY for the new org before any Seazn
 *    session (read right after step 1), and at the end exactly ONE row, this match's session, naming its part deleted by the
 *    organiser (step 7). The owner is made staff only for each read (`setStaff`), and never left so.
 * 9. THE SWEEP — the daily relay sweep (POST /api/cron/relay-sweep, the server's and the smoke's one CRON_SECRET) answers 200 with
 *    every Seazn counter of its step 7e a number — `seaznMeasured` first. Told COST is off (the runner's SEAZN_HOSTED_COST, read as
 *    the server reads it: every smoke job leaves it unset), every one of them is 0, because 7e did not run. Told it is on, each is a
 *    whole number: this match's session ended today, so it owes no day yet, and what other sessions owe is not this suite's to say.
 *    The sweep is server-wide, as the YouTube suite's later one is; its passes act only on what is past a retention, a grace or an
 *    expiry, and the earlier suites retire what they start (sponsors.ts's note).
 * HOW THE ROW GETS THERE, AND WHY NOT BY THE MOVE. The session, its programme input, the locked recording and the replay row are
 * written by SQL, in the shape the stream tick's passes leave them (the e2e seed's shape, e2e/helpers/seazn-video-seed.ts), and
 * `encoding → playable` is the conditional update the move's poll and the Bunny webhook write. The move cannot run here: it is
 * behind SEAZN_HOSTED_REPLAY, which no smoke job sets, and the fake host's videos live in the SERVER's memory, where only a test
 * can advance one. The move and the webhook are proved on the fakes in vitest (usecases/__tests__/seazn-replays.test.ts,
 * seazn-replay-webhook.test.ts, video/__tests__/seazn-video-replays.test.ts); what this proves is everything after the row, in
 * the built server: the view, the merge, the call that signs (its call site, TTL and URL assembly, on the fakes' signers: the replay
 * host's is a stand-in digest, the interim's the fake relay's token), the route's headers and the organiser's delete.
 *
 * Its own Pro org and sign-in, nothing from SubsetCtx, purged by cleanup() (which empties the replay tables before the orgs).
 * One sport (hockey, as captureV2): the Seazn destination, the video route and the replay rows read no sport.
 * SMOKE_ONLY=seaznHosted runs it alone (SELECTABLE_SUITES).
 */
/** The sweep's Seazn counters (relay-sweep.ts `SweepResult`, step 7e and the Task 31b passes), `seaznMeasured` first. */
const SEAZN_SWEEP_COUNTERS = [
  "seaznMeasured", "seaznMeasureFailed", "seaznMeasureSkipped", "seaznReplaysPurged", "seaznPurgeFailed", "seaznFixturelessPurged",
  "seaznFixturelessFailed",
] as const;
/** The staff table's markers (components/admin-seazn-video-panel.tsx), anchored on `="` so a bare attribute name cannot pass. */
const PANEL = 'data-testid="seazn-video-panel"';
const EMPTY = 'data-testid="seazn-video-empty"';
const ROW = 'data-testid="seazn-video-row"';

/** /admin/orgs/[id] as staff: the owner made superadmin for this one read only, and never left so. */
async function staffOrgPage(s: Session, email: string, orgId: string): Promise<{ status: number; has: (m: string) => boolean; count: (m: string) => number }> {
  await setStaff(email, "superadmin");
  try {
    const res = await fetch(`${BASE}/admin/orgs/${orgId}`, { headers: { cookie: cookieHeader(s) } });
    const html = await res.text();
    return { status: res.status, has: (m) => html.includes(m), count: (m) => html.split(m).length - 1 };
  } finally {
    await setStaff(email, null);
  }
}

export async function seaznHostedSuite(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP  seazn-hosted suite (DATABASE_URL not set — the Seazn row is read in SQL)");
    return;
  }
  const live = process.env.SEAZN_HOSTED_LIVE === "true";
  // Phase 3: COST as the sweep reads it (usecases/seazn-cost.ts `seaznCostArmed`: a malformed value is off).
  const cost = (() => {
    try {
      return seaznHostedCost();
    } catch {
      return false;
    }
  })();
  // LIVE on drops the two refusal steps (3) — the refusal exists only while LIVE is off. Phase 2 (5–7) adds five in both modes:
  // the read path reads no flag. Phase 3 (8–9) adds four in every mode: the two staff-table reads, the sweep's answer and its
  // counters by COST's mode.
  const EXPECTED_STEPS = (live ? 6 : 8) + 5 + 4;
  let steps = 0;
  const step = (label: string, cond: boolean) => {
    check(`seazn-hosted smoke: ${label}`, cond);
    steps++;
  };
  const done = () => {
    console.log(`seazn-hosted smoke: ${steps} steps (LIVE ${live ? "on" : "off"}, COST ${cost ? "on" : "off"})`);
    check(`seazn-hosted smoke: all ${EXPECTED_STEPS} steps ran (ran ${steps})`, steps === EXPECTED_STEPS);
  };

  const owner = newSession();
  const ownerEmail = `delivered+seaznhosted_${tag}@resend.dev`;
  const orgId = (await signIn(owner, ownerEmail)).org_id;
  await setPlan(orgId, "pro", owner);
  const db = smokeDb();
  try {
    type Row = { id: string; kind: string; archived: boolean };
    const targetsOf = () => db<Row[]>`
      select id, kind, archived_at is not null as archived from org_stream_targets
       where org_id = ${orgId} order by created_at asc, id asc`;

    // 1a. PRESENT: exactly one active Seazn row, made with the org (V541's trigger), before this suite adds anything.
    const before = await targetsOf();
    const seaznRows = before.filter((r) => r.kind === "seazn" && !r.archived);
    step(
      `the new org has exactly one active Seazn destination (V541) (got ${seaznRows.length} of ${before.length} rows)`,
      seaznRows.length === 1,
    );
    const seaznId = seaznRows[0]?.id;
    if (!seaznId) return done();

    // 8a. STAFF TABLE, EMPTY: the new org has no Seazn session yet, so the table says so and lists no row.
    const emptyTable = await staffOrgPage(owner, ownerEmail, orgId);
    step(
      `STAFF TABLE: before any Seazn session, /admin/orgs/[id] ships the Seazn video table, EMPTY (got ${emptyTable.status}, panel ${emptyTable.has(PANEL)}, empty ${emptyTable.has(EMPTY)}, ${emptyTable.count(ROW)} rows)`,
      emptyTable.status === 200 && emptyTable.has(PANEL) && emptyTable.has(EMPTY) && emptyTable.count(ROW) === 0,
    );

    const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const streamKey = "live_1_" + Array.from(randomBytes(24), (b) => ALNUM[b % ALNUM.length]).join("");
    const added = await v1(owner, `/api/v1/orgs/${orgId}/stream-targets`, "POST", { kind: "twitch", label: "smoke-seazn-tw", streamKey });
    const twitchId = v1data<{ id?: string } | undefined>(added)?.id;

    // 1b. FIRST: still the org's oldest destination once another exists (the positive pair: the Twitch row is there too).
    const after = await targetsOf();
    step(
      `the Seazn row is the org's FIRST destination, the added Twitch one after it (POST ${added.status}; order ${after.map((r) => r.kind).join(",")})`,
      added.status === 201 && !!twitchId && after.length === before.length + 1 && after[0]?.id === seaznId && after.some((r) => r.id === twitchId),
    );
    if (!twitchId) return done();

    // 2. THE LIST, by mode.
    const listed = await v1(owner, `/api/v1/orgs/${orgId}/stream-targets`);
    const items = v1data<{ id: string; kind: string }[] | undefined>(listed) ?? [];
    const seaznListed = items.filter((t) => t.kind === "seazn");
    step(
      live
        ? `LIVE on: the Streaming list names the Seazn row once and FIRST, the Twitch one after (got ${listed.status}, ${items.map((t) => t.kind).join(",")})`
        : `LIVE off: the Streaming list leaves the Seazn row out and still lists the Twitch one (got ${listed.status}, ${items.map((t) => t.kind).join(",")})`,
      listed.status === 200 && items.some((t) => t.id === twitchId) &&
        (live ? seaznListed.length === 1 && items[0]?.id === seaznId : seaznListed.length === 0),
    );

    const comp = v1data<{ id: string }>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Seazn hosted ${tag}`, visibility: "public" }),
    );
    const fx = await timedFixture(owner, comp.id, {
      name: "Seazn hosted",
      sport_key: "hockey",
      variant_key: "fih-outdoor",
      entrants: [
        { kind: "team", display_name: `Seazn Home ${tag}`, seed: 1 },
        { kind: "team", display_name: `Seazn Away ${tag}`, seed: 2 },
      ],
    });

    // 3. REFUSED WHILE OFF: the pick and the start, each by the Seazn destination's own 422, and no session row.
    if (!live) {
      const pick = await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/stream-settings`, "PUT", { targetId: seaznId });
      step(
        `LIVE off: naming the Seazn destination as the match's pick → 422 seazn_unavailable (got ${pick.status} ${String(pick.json.error?.code)})`,
        pick.status === 422 && pick.json.error?.code === "seazn_unavailable",
      );
      const start = await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/stream-sessions`, "POST", { mode: "passthrough", targetId: seaznId });
      const [{ n }] = await db<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${fx.fixtureId}`;
      step(
        `LIVE off: Go live on the Seazn destination → 422 seazn_unavailable, no session row written (got ${start.status} ${String(start.json.error?.code)}, ${n} rows)`,
        start.status === 422 && start.json.error?.code === "seazn_unavailable" && n === 0,
      );
    }

    // 4. NO-STORE: the public video route, anonymous (no cookie), for this match and for an id that names none.
    type Part = { partNo?: unknown; player?: unknown; src?: unknown; expiresAt?: unknown };
    const video = async (id: string) => {
      const res = await fetch(`${BASE}/api/v1/public/fixtures/${id}/video`);
      const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: { live?: unknown; replay?: unknown } } | null;
      const raw = body?.data?.replay;
      const replay: Part[] | null = Array.isArray(raw) ? (raw as Part[]) : null;
      return { status: res.status, cache: res.headers.get("cache-control"), data: body?.data, replay };
    };
    for (const [what, id] of [["this match", fx.fixtureId], ["an id that names no match", randomUUID()]] as const) {
      const r = await video(id);
      step(
        `GET the public video of ${what} → 200, private, no-store, { live: null, replay: [] } (got ${r.status}, ${String(r.cache)})`,
        r.status === 200 && r.cache === "private, no-store" && r.data?.live === null && Array.isArray(r.data?.replay) && r.data.replay.length === 0,
      );
    }

    // The anonymous read above made no Seazn row and no destination: the org still has exactly its two.
    const end = await targetsOf();
    step(
      `the reads changed no destination: the org still has the Seazn row first and the Twitch one (got ${end.map((r) => r.kind).join(",")})`,
      end.length === after.length && end[0]?.id === seaznId,
    );

    // ── Phase 2 (Task 28): one recording of this match through the replay swap, read by the real route (see the header). ──
    const must = <T,>(v: T | undefined, what: string): T => {
      if (v === undefined) throw new Error(`seazn-hosted smoke: premise failed: ${what}`);
      return v;
    };
    const hex = () => randomBytes(6).toString("hex");
    const programmeUid = `smoke-programme-${hex()}`;
    const cfVideoId = `smoke-recording-${hex()}`;
    const bunnyVideoId = `smoke-bunny-${hex()}`;
    // Any length: the route never reads it. The copy's matches the recording's, as the move's length check requires.
    const LENGTH_SECONDS = 120;
    // The signed-in owner: the delete below is theirs, so the row's deleted_by must name them.
    const ownerRow = must(
      (await db<{ user_id: string }[]>`select id as user_id from users where lower(email) = lower(${ownerEmail})`)[0],
      "the signed-in owner has a user row",
    );
    // The session the Seazn destination ran: warming, then live with its programme input, then stopped (the e2e seed's steps).
    const session = must(
      (await db<{ id: string }[]>`
        insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override, destination_kind)
        select f.id, ${orgId}, 'composed', 'warming', ${seaznId}, ${ownerRow.user_id}, d.sport_key, d.competition_id, f.division_id, true, 'seazn'
          from fixtures f join divisions d on d.id = f.division_id where f.id = ${fx.fixtureId}
        returning id`)[0],
      "the Seazn session row was written",
    );
    const input = must(
      (await db<{ id: string }[]>`
        insert into fixture_stream_inputs (session_id, slot, role, ingest_input_id) values (${session.id}, 0, 'programme', ${programmeUid})
        returning id`)[0],
      "the programme input row was written",
    );
    await db`update fixture_stream_sessions set state = 'live', started_at = now() where id = ${session.id}`;
    await db`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now() where id = ${session.id}`;
    // The tick's Seazn pass locked the recording (Task 13), and discovery listed it as part 1; the move has its copy encoding.
    const lockedAt = must(
      (await db<{ locked_at: Date }[]>`
        insert into seazn_locked_videos (cf_video_id, input_row_id, locked_at, recorded_at) values (${cfVideoId}, ${input.id}, now(), now())
        returning locked_at`)[0],
      "the recording was locked",
    ).locked_at;
    const replayId = must(
      (await db<{ id: string }[]>`
        insert into fixture_video_replays (org_id, session_id, fixture_id, cf_video_id, recorded_at, part_no, state, bunny_video_id, cf_duration_seconds, cf_height)
        values (${orgId}, ${session.id}, ${fx.fixtureId}, ${cfVideoId}, ${lockedAt}, 1, 'encoding', ${bunnyVideoId}, ${LENGTH_SECONDS}, 720)
        returning id`)[0],
      "the replay row was written",
    ).id;
    // What a step prints of the parts: number and player only. A src carries a token, and goes nowhere.
    const partsOf = (r: Part[] | null) => (r === null ? "no replay list" : r.map((p) => `${String(p.partNo)}:${String(p.player)}`).join(",") || "none");

    // 5. INTERIM: the copy is still encoding, so the recording plays from Cloudflare, under its stored number.
    const interim = await video(fx.fixtureId);
    const ip = interim.replay?.[0];
    step(
      `INTERIM: a copy still encoding → ONE hls part 1, the recording signed on the fake Cloudflare host, nothing of the replay host's (got ${interim.status}, ${String(interim.cache)}, parts ${partsOf(interim.replay)})`,
      interim.status === 200 && interim.cache === "private, no-store" && interim.data?.live === null && interim.replay?.length === 1 &&
        ip?.partNo === 1 && ip.player === "hls" && typeof ip.src === "string" &&
        ip.src.startsWith(`https://${FAKE_PLAYBACK_HOST}/fake.${cfVideoId}.`) && ip.src.endsWith("/manifest/video.m3u8") && !ip.src.includes(bunnyVideoId),
    );

    // 6. PLAYABLE: the copy passes the check (the poll's and the webhook's conditional write), and the route swaps to it.
    const swapped = await db<{ id: string }[]>`
      update fixture_video_replays
         set state = 'playable', state_at = now(), verified_at = now(), length_seconds = ${LENGTH_SECONDS},
             next_attempt_at = now() + ${SEAZN_CF_DELETE_DELAY_MINUTES}::int * interval '1 minute'
       where id = ${replayId} and state = 'encoding'
      returning id`;
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const embedShape = new RegExp(
      `^https://${esc(FAKE_REPLAY_EMBED_HOST)}/embed/\\d+/${esc(encodeURIComponent(bunnyVideoId))}\\?token=[0-9a-f]{64}&expires=(\\d+)$`,
    );
    const readAtMs = Date.now();
    const played = await video(fx.fixtureId);
    const pp = played.replay?.[0];
    const embed = typeof pp?.src === "string" ? embedShape.exec(pp.src) : null;
    const expiresMs = typeof pp?.expiresAt === "string" ? Date.parse(pp.expiresAt) : Number.NaN;
    const wantMs = readAtMs + REPLAY_EMBED_TOKEN_TTL_SECONDS * 1000;
    step(
      `PLAYABLE: the copy verified (${swapped.length} row moved) → ONE embed part 1 on the fake replay host for that copy, expiring in ${REPLAY_EMBED_TOKEN_TTL_SECONDS} s, no hls part (got ${played.status}, ${String(played.cache)}, parts ${partsOf(played.replay)}, src ${embed === null ? "NOT the fake host's embed shape" : "the fake host's embed shape"}, expiry off by ${Math.round((expiresMs - wantMs) / 1000)} s)`,
      swapped.length === 1 && played.status === 200 && played.cache === "private, no-store" && played.data?.live === null &&
        played.replay?.length === 1 && pp?.partNo === 1 && pp.player === "embed" && embed !== null &&
        Number(embed[1]) === Math.floor(expiresMs / 1000) && Math.abs(expiresMs - wantMs) <= 60_000,
    );

    // 7. DELETE: the organiser's delete takes the row to deleted, and the host is asked to remove the copy at once. (That the delete
    //    wins over a move in flight is proved on the fakes in usecases/__tests__/seazn-replays.test.ts; no move runs here.)
    type Removed = { state: string; deleted_reason: string | null; deleted_by: string | null; bunny_video_id: string | null; deleted_at: Date | null; state_at: Date };
    const removedRow = async () => (await db<Removed[]>`
      select state, deleted_reason, deleted_by, bunny_video_id, deleted_at, state_at from fixture_video_replays where id = ${replayId}`)[0];
    const deletePath = `/api/v1/fixtures/${fx.fixtureId}/replays/${replayId}`;
    const del = await v1(owner, deletePath, "DELETE");
    const afterDel = await removedRow();
    step(
      `DELETE: the organiser's delete → 200 { deleted: true }; the row is deleted by the organiser and has forgotten its copy (got ${del.status}, ${String(afterDel?.state)}/${String(afterDel?.deleted_reason)}, copy ${afterDel?.bunny_video_id === null ? "forgotten" : "still named"})`,
      del.status === 200 && v1data<{ deleted?: unknown } | undefined>(del)?.deleted === true && afterDel?.state === "deleted" &&
        afterDel.deleted_reason === "organiser" && afterDel.deleted_by === ownerRow.user_id && afterDel.bunny_video_id === null && afterDel.deleted_at !== null,
    );
    const [{ stillLocked }] = await db<{ stillLocked: number }[]>`
      select count(*)::int as "stillLocked" from seazn_locked_videos where cf_video_id = ${cfVideoId}`;
    const gone = await video(fx.fixtureId);
    step(
      `GONE: after the delete the route lists NO part, the interim included, though the recording is still locked (got ${gone.status}, ${String(gone.cache)}, parts ${partsOf(gone.replay)}, ${stillLocked} locked)`,
      gone.status === 200 && gone.cache === "private, no-store" && gone.data?.live === null && gone.replay?.length === 0 && stillLocked === 1,
    );
    const again = await v1(owner, deletePath, "DELETE");
    const afterAgain = await removedRow();
    step(
      `a second DELETE → 200 { deleted: true } and changes nothing (got ${again.status}, ${String(afterAgain?.state)})`,
      again.status === 200 && v1data<{ deleted?: unknown } | undefined>(again)?.deleted === true && afterAgain?.state === "deleted" &&
        afterDel?.deleted_at != null && afterAgain.deleted_at?.getTime() === afterDel.deleted_at.getTime() &&
        afterAgain.state_at.getTime() === afterDel.state_at.getTime(),
    );

    // ── Phase 3 (Task 32): the daily sweep's Seazn counters, and the staff table (see the header). ──
    // 9. THE SWEEP. The secret is the one the server was started with (CI's smoke job sets it at job level); without it nothing here
    //    can be read, which is a red, never a skip.
    const secret = process.env.CRON_SECRET ?? "";
    const swept = secret === ""
      ? { status: 0, body: null }
      : await fetch(`${BASE}/api/cron/relay-sweep`, { method: "POST", headers: { "x-cron-secret": secret } })
          .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as { ok?: boolean; data?: Record<string, unknown> } | null }));
    const counters = SEAZN_SWEEP_COUNTERS.map((k) => [k, swept.body?.data?.[k]] as const);
    const shown = counters.map(([k, v]) => `${k} ${String(v)}`).join(", ");
    step(
      secret === ""
        ? "THE SWEEP: CRON_SECRET is not in the smoke env, so the sweep cannot be asked (the server and the smoke must share it)"
        : `THE SWEEP: POST /api/cron/relay-sweep → 200, and its answer carries every Seazn counter as a number, seaznMeasured first (got ${swept.status}${swept.body?.data?.disabled === true ? ", a relay-DISABLED answer" : ""}; ${shown})`,
      swept.status === 200 && swept.body?.ok === true && counters.every(([, v]) => typeof v === "number"),
    );
    step(
      cost
        ? `THE SWEEP, COST on: every Seazn counter is a whole number (${shown})`
        : `THE SWEEP, COST off: step 7e did not run — every Seazn counter is 0 (${shown})`,
      counters.every(([, v]) => typeof v === "number" && Number.isInteger(v) && v >= 0 && (cost || v === 0)),
    );

    // 8b. STAFF TABLE, THE ROW: exactly this match's session, its one part deleted by the organiser (step 7).
    const table = await staffOrgPage(owner, ownerEmail, orgId);
    const sessionRow = `data-session-id="${session.id}"`;
    const deletedPart = "Part 1: deleted (by organiser)";
    const fixtureLabel = `Seazn Home ${tag} v Seazn Away ${tag}`;
    step(
      `STAFF TABLE: /admin/orgs/[id] lists exactly ONE Seazn session, this match's, named by its entrants, its part deleted by the organiser (got ${table.status}, panel ${table.has(PANEL)}, empty ${table.has(EMPTY)}, ${table.count(ROW)} rows, this session ${table.has(sessionRow)}, named ${table.has(fixtureLabel)}, "${deletedPart}" ${table.has(deletedPart)})`,
      table.status === 200 && table.has(PANEL) && !table.has(EMPTY) && table.count(ROW) === 1 && table.has(sessionRow) &&
        table.has(fixtureLabel) && table.has(deletedPart),
    );
    done();
  } finally {
    await db.end();
  }
}
