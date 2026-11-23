import { randomBytes, randomUUID } from "node:crypto";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, newSession, check, signIn, smokeDb, tag, timedFixture, v1, v1data, setPlan } from "../harness.ts";

/**
 * Seazn-hosted video, Phase 1 (plan Task 19), over real HTTP on the fake relay drivers:
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
 * Its own Pro org and sign-in, nothing from SubsetCtx, purged by cleanup(). One sport (hockey, as captureV2): the Seazn
 * destination and the video route read no sport. SMOKE_ONLY=seaznHosted runs it alone (SELECTABLE_SUITES).
 */
export async function seaznHostedSuite(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP  seazn-hosted suite (DATABASE_URL not set — the Seazn row is read in SQL)");
    return;
  }
  const live = process.env.SEAZN_HOSTED_LIVE === "true";
  // LIVE on drops the two refusal steps (3) — the refusal exists only while LIVE is off.
  const EXPECTED_STEPS = live ? 6 : 8;
  let steps = 0;
  const step = (label: string, cond: boolean) => {
    check(`seazn-hosted smoke: ${label}`, cond);
    steps++;
  };
  const done = () => {
    console.log(`seazn-hosted smoke: ${steps} steps (LIVE ${live ? "on" : "off"})`);
    check(`seazn-hosted smoke: all ${EXPECTED_STEPS} steps ran (ran ${steps})`, steps === EXPECTED_STEPS);
  };

  const owner = newSession();
  const orgId = (await signIn(owner, `delivered+seaznhosted_${tag}@resend.dev`)).org_id;
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
    const video = async (id: string) => {
      const res = await fetch(`${BASE}/api/v1/public/fixtures/${id}/video`);
      const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: { live?: unknown; replay?: unknown } } | null;
      return { status: res.status, cache: res.headers.get("cache-control"), data: body?.data };
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
    done();
  } finally {
    await db.end();
  }
}
