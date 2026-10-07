// The constraints of __stream_sessions.sql are only real if something tries
// to violate them (AGENTS.md class 3). Each refusal here has its accepted twin
// in the same `it`, so a test that passes on an EMPTY schema cannot exist:
// the twin would fail with "relation does not exist" first.
//
// Real Postgres required; skipped without DATABASE_URL like every suite in
// server/usecases/__tests__. The eight tables are reached through the plain
// `sql` client — RLS is FORCEd with zero policies, so `withTenant` (app_user)
// would see nothing, which is the point of §6.1 and of V366.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { CAPTURE_CODE_RE } from "@/server/api-v1/capture-schemas";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { MAX_DURATION_MINUTES } from "../config";
import { AUTO_START_REFUSALS } from "../domain/auto-stream";
import { ACTIVE_STATES, TERMINAL_STATES } from "../domain/session";
import { lastCheckList, STREAM_TABLES } from "./_stream-migration";

const HAS_DB = !!process.env.DATABASE_URL;

async function rig() {
  const { auth } = await seedOrg();
  const { fixtureId } = await startedDivisionWithFixture(auth);
  const [target] = await sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc)
    values (${auth.orgId}, 'youtube', 'Club channel', ${Buffer.from("not-a-real-envelope")})
    returning id`;
  // The session's NOT NULL snapshot facts, read from their SOURCE rows (Task 0 data rulings, Db) — never typed.
  const [src] = await sql<{ division_id: string; competition_id: string; sport_key: string }[]>`
    select f.division_id, d.competition_id, d.sport_key
      from fixtures f join divisions d on d.id = f.division_id
     where f.id = ${fixtureId}`;
  // seedOrg's AuthCtx carries `userId: null` (_rig.ts), and created_by is NOT NULL with no FK: `auth.userId!`
  // would insert null and every session insert would refuse on created_by (23502) — which would also make the
  // "entitlement_via_override has NO default" refusal below pass for the wrong column. A fresh uuid is a creator.
  return {
    orgId: auth.orgId, userId: randomUUID(), fixtureId, targetId: target!.id,
    divisionId: src!.division_id, competitionId: src!.competition_id, sportKey: src!.sport_key,
  };
}

async function insertSession(r: Awaited<ReturnType<typeof rig>>, state: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by,
                                         sport_key, competition_id, division_id, entitlement_via_override)
    values (${r.fixtureId}, ${r.orgId}, 'passthrough', ${state}, ${r.targetId}, ${r.userId},
            ${r.sportKey}, ${r.competitionId}, ${r.divisionId}, true)
    returning id`;
  return row!.id;
}

describe.skipIf(!HAS_DB)("__stream_sessions.sql — the constraints are real", () => {
  it("RLS is enabled AND forced on all TWELVE tables (V410's eight, V430's four), with zero policies", async () => {
    // The list is read from the migration files themselves (`create table (\w+)` over the
    // stream fold), so a table added later is guarded the day it lands, not the day someone
    // remembers this test. STREAM_TABLES comes from _stream-migration.ts, which
    // rls-static.test.ts and telemetry.test.ts (Task 2) import too.
    const rows = await sql<{ relname: string; rls: boolean; forced: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relname = any(${STREAM_TABLES})
      order by c.relname`;
    expect(STREAM_TABLES.length).toBe(8 + 4);
    expect(rows.map((r) => r.relname)).toEqual([...STREAM_TABLES].sort());
    for (const r of rows) {
      expect(r.rls, r.relname).toBe(true);
      expect(r.forced, r.relname).toBe(true);
      expect(r.policies, r.relname).toBe(0);
    }
  });

  it("slot: -1 is refused by check (slot >= 0); 0 and 1 are accepted (r9)", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    await expect(
      sql`insert into fixture_stream_inputs (session_id, slot) values (${sid}, -1)`,
    ).rejects.toMatchObject({ code: "23514" });
    await sql`insert into fixture_stream_inputs (session_id, slot) values (${sid}, 0)`;
    await sql`insert into fixture_stream_inputs (session_id, slot) values (${sid}, 1)`;
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_inputs where session_id = ${sid}`;
    expect(n).toBe(2);
  });

  it("unique (session_id, slot): a second slot-0 row on one session is refused (r6)", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    await sql`insert into fixture_stream_inputs (session_id, slot) values (${sid}, 0)`;
    await expect(
      sql`insert into fixture_stream_inputs (session_id, slot) values (${sid}, 0)`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("fixture_stream_sessions_one_active: a second non-terminal session on one fixture is refused; a second COMPLETED one is not (r1)", async () => {
    const r = await rig();
    await insertSession(r, "live");
    await expect(insertSession(r, "requested")).rejects.toMatchObject({ code: "23505" });
    // The partial index is PARTIAL: terminal rows never collide.
    await insertSession(r, "completed");
    await insertSession(r, "failed");
  });

  it("org_stream_credits: delta 0 refused; balance_after -1 refused; a duplicate stripe_event_id refused (m3); the accepted twins land", async () => {
    const r = await rig();
    await expect(
      sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${r.orgId}, 0, 'grant', 0)`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${r.orgId}, -1, 'consume', -1)`,
    ).rejects.toMatchObject({ code: "23514" });
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after, stripe_event_id)
              values (${r.orgId}, 5, 'purchase', 5, ${"evt_shape_" + r.orgId})`;
    await expect(
      sql`insert into org_stream_credits (org_id, delta, reason, balance_after, stripe_event_id)
          values (${r.orgId}, 5, 'purchase', 10, ${"evt_shape_" + r.orgId})`,
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${r.orgId}, 1, 'bonus', 6)`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("runner_retries defaults to 0 and refuses a negative", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    const [row] = await sql<{ runner_retries: number }[]>`
      select runner_retries from fixture_stream_sessions where id = ${sid}`;
    expect(row!.runner_retries).toBe(0);
    await expect(
      sql`update fixture_stream_sessions set runner_retries = -1 where id = ${sid}`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("runner_state defaults to none, refuses a value outside the lifecycle; end_reason refuses an unknown reason, and refuses ANY reason unless the session is ending or completed (P1-F-b)", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    const [row] = await sql<{ runner_state: string; runner_name: string | null; end_reason: string | null }[]>`
      select runner_state, runner_name, end_reason from fixture_stream_sessions where id = ${sid}`;
    expect(row).toEqual({ runner_state: "none", runner_name: null, end_reason: null });
    await expect(sql`update fixture_stream_sessions set runner_state = 'running' where id = ${sid}`).rejects.toMatchObject({ code: "23514" });
    await sql`update fixture_stream_sessions set runner_state = 'creating', runner_name = 'relay-x-r1' where id = ${sid}`;
    // REFUSED by the state check: a reason while the row is still `requested`, and a reason on a FAILED session.
    await expect(sql`update fixture_stream_sessions set end_reason = 'stopped' where id = ${sid}`).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'machine_boot_timeout', end_reason = 'stopped' where id = ${sid}`,
    ).rejects.toMatchObject({ code: "23514" });
    // REFUSED by the VALUE check alone: 'ending' permits a reason, so the state check passes and only
    // `end_reason in ('stopped','max_duration')` can refuse 'crashed' (a probe at `requested` is refused by both).
    await expect(
      sql`update fixture_stream_sessions set state = 'ending', end_reason = 'crashed' where id = ${sid}`,
    ).rejects.toMatchObject({ code: "23514" });
    // ACCEPTED: both reasons once the session is ending, and the last one survives the move to completed.
    await sql`update fixture_stream_sessions set state = 'ending', end_reason = 'stopped' where id = ${sid}`;
    await sql`update fixture_stream_sessions set end_reason = 'max_duration' where id = ${sid}`;
    await sql`update fixture_stream_sessions set state = 'completed' where id = ${sid}`;
    // ACCEPTED: a failed session with NO end reason — fail_reason carries the cause. (Inserted after the row
    // above left the active set, or the one-active partial index would refuse the second session.)
    const sid2 = await insertSession(r, "requested");
    await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'machine_boot_timeout' where id = ${sid2}`;
  });

  // ---- ruling 13: the capture tables -------------------------------------

  it("fixture_stream_events is append-only: UPDATE and direct DELETE are refused; (session_id, seq) is unique; a SESSION delete's cascade still works", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    // kind is 'transition' — the migration's own vocabulary (and Task 2's EventKind); 'state' is not a kind and
    // would make every insert below refuse on the kind check, and the 'ufo' probe refuse for the wrong column.
    const insert = (seq: number) => sql`
      insert into fixture_stream_events (session_id, org_id, seq, source, kind, type, from_state, to_state)
      values (${sid}, ${r.orgId}, ${seq}, 'domain', 'transition', 'admitted', 'requested', 'provisioning')`;
    await insert(1);
    await expect(insert(1)).rejects.toMatchObject({ code: "23505" });
    await insert(2);
    await expect(sql`update fixture_stream_events set to_state = 'live' where session_id = ${sid}`).rejects.toMatchObject({ code: "23001" });
    await expect(sql`delete from fixture_stream_events where session_id = ${sid}`).rejects.toMatchObject({ code: "23001" });
    await expect(sql`insert into fixture_stream_events (session_id, org_id, seq, source, kind, type) values (${sid}, ${r.orgId}, 3, 'ufo', 'transition', 'x')`).rejects.toMatchObject({ code: "23514" });
    // The positive pair: history goes with its SESSION row — the FK cascade runs the trigger at
    // pg_trigger_depth() 2, not 1, so it is not a direct delete. (A fixture delete no longer reaches this
    // table at all: fixture_id is `on delete set null` — the next test.)
    await sql`delete from fixture_stream_sessions where id = ${sid}`;
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sid}`;
    expect(n).toBe(0);
  });

  it("deleting a STREAMED fixture keeps the stream: the session survives with fixture_id null, and its input, event and consume credit rows survive with the org balance unchanged", async () => {
    const r = await rig();
    const sid = await insertSession(r, "live");
    await sql`insert into fixture_stream_inputs (session_id, slot, ingest_input_id) values (${sid}, 0, 'in-uid-kept')`;
    await sql`insert into fixture_stream_events (session_id, org_id, seq, source, kind, type, from_state, to_state)
              values (${sid}, ${r.orgId}, 1, 'domain', 'transition', 'admitted', 'requested', 'provisioning')`;
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${r.orgId}, 5, 'grant', 5)`;
    const [consume] = await sql<{ id: string }[]>`
      insert into org_stream_credits (org_id, delta, reason, balance_after, session_id)
      values (${r.orgId}, -1, 'consume', 4, ${sid}) returning id`;
    await sql`update fixture_stream_sessions set credit_ledger_id = ${consume!.id} where id = ${sid}`;
    const balance = async () => {
      const [{ b }] = await sql<{ b: number }[]>`
        select coalesce(sum(delta), 0)::int as b from org_stream_credits where org_id = ${r.orgId}`;
      return b;
    };
    expect(await balance()).toBe(4);

    // With `fixture_id … not null on delete cascade` this delete is REFUSED (23503: the consume row still
    // references the cascaded session); without a consume row it silently erases the session, its inputs
    // (the paid Cloudflare resources retention finds through them) and its append-only history.
    await sql`delete from fixtures where id = ${r.fixtureId}`;

    const [session] = await sql<{ fixture_id: string | null; credit_ledger_id: string | null }[]>`
      select fixture_id, credit_ledger_id from fixture_stream_sessions where id = ${sid}`;
    expect(session).toEqual({ fixture_id: null, credit_ledger_id: consume!.id });
    const [kept] = await sql<{ inputs: number; events: number; credits: number }[]>`
      select (select count(*) from fixture_stream_inputs where session_id = ${sid})::int as inputs,
             (select count(*) from fixture_stream_events where session_id = ${sid})::int as events,
             (select count(*) from org_stream_credits where session_id = ${sid})::int as credits`;
    expect(kept).toEqual({ inputs: 1, events: 1, credits: 1 });
    expect(await balance()).toBe(4);
  });

  it("stream_provider_calls: a path with a query string, a raw uuid or a raw machine/input id is refused (a template, never a URL); attempt 0 and a negative latency are refused; the twin lands", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    const ok = sql`insert into stream_provider_calls (session_id, provider, operation, subject_id, method, path_template, status, latency_ms, attempt, request_id)
                  values (${sid}, 'cloudflare', 'createLiveInput', 'in-uid-1', 'POST', '/accounts/{id}/stream/live_inputs', 200, 143, 1, 'cf-ray-shape')`;
    await ok;
    await expect(sql`insert into stream_provider_calls (session_id, provider, operation, method, path_template, latency_ms)
                     values (${sid}, 'fly', 'x', 'GET', '/apps/{id}/machines/3d8d9e4b1234ab', 1)`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`insert into stream_provider_calls (session_id, provider, operation, method, path_template, latency_ms)
                     values (${sid}, 'cloudflare', 'x', 'GET', '/stream/live_inputs?key=abc', 1)`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`insert into stream_provider_calls (session_id, provider, operation, method, path_template, latency_ms)
                     values (${sid}, 'fly', 'x', 'GET', ${"/apps/relay/machines/" + sid}, 1)`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`insert into stream_provider_calls (session_id, provider, operation, method, path_template, latency_ms, attempt)
                     values (${sid}, 'fly', 'x', 'GET', '/apps/{app}/machines/{id}', 1, 0)`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`insert into stream_provider_calls (session_id, provider, operation, method, path_template, latency_ms)
                     values (${sid}, 'fly', 'x', 'GET', '/apps/{app}/machines/{id}', -1)`).rejects.toMatchObject({ code: "23514" });
  });

  it("fixture_stream_samples and stream_storage_snapshots: the enums hold; a snapshot's headroom is used-vs-limit arithmetic the CHECK enforces", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    await sql`insert into fixture_stream_samples (session_id, source, ingest_state, bitrate_kbps, fps) values (${sid}, 'heartbeat', 'connected', 4500, 29.97)`;
    await expect(sql`insert into fixture_stream_samples (session_id, source) values (${sid}, 'guess')`).rejects.toMatchObject({ code: "23514" });
    await sql`insert into stream_storage_snapshots (source, session_id, used_minutes, limit_minutes, reserved_minutes, headroom_minutes)
              values ('admission', ${sid}, 900, 1000, 40, 60)`;
    await expect(sql`insert into stream_storage_snapshots (source, used_minutes, limit_minutes, reserved_minutes, headroom_minutes)
                     values ('sweep', 900, 1000, 40, 99)`).rejects.toMatchObject({ code: "23514" });
  });

  it("org_stream_credits purchase link: a negative amount_minor and a 2-letter currency are refused; the full Stripe link lands (item 6)", async () => {
    const r = await rig();
    await expect(sql`insert into org_stream_credits (org_id, delta, reason, balance_after, amount_minor) values (${r.orgId}, 5, 'purchase', 5, -1)`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`insert into org_stream_credits (org_id, delta, reason, balance_after, currency) values (${r.orgId}, 5, 'purchase', 5, 'gb')`).rejects.toMatchObject({ code: "23514" });
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after, stripe_event_id, stripe_checkout_session_id, stripe_payment_intent_id, pack_key, amount_minor, currency)
              values (${r.orgId}, 5, 'purchase', 5, ${"evt_link_" + r.orgId}, ${"cs_test_" + r.orgId}, ${"pi_" + r.orgId}, 'seazn_stream_pack_5', 4900, 'gbp')`;
  });

  // ---- Task 0 data rulings (2026-09-14): the session facts ----------------

  it("session facts: the snapshot's not-null columns refuse null; entitlement_via_override has NO default; recording_bytes, credentials_served_count (V430's rename) and est_cost_minor refuse a negative; est_cost_currency refuses 'GBP' and 'gb'; the accepted twin lands every fact, with a venue id no row has (no FK)", async () => {
    const r = await rig();
    // No default: an insert that omits entitlement_via_override is refused — a default would hide a missing producer (Task 10).
    await expect(sql`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id)
      values (${r.fixtureId}, ${r.orgId}, 'passthrough', 'requested', ${r.targetId}, ${r.userId}, ${r.sportKey}, ${r.competitionId}, ${r.divisionId})`,
    ).rejects.toMatchObject({ code: "23502" });
    const sid = await insertSession(r, "requested");
    // NOT NULL only where the SOURCE is not null — one mutant ("drop not null") per column.
    for (const col of ["sport_key", "competition_id", "division_id", "entitlement_via_override"]) {
      await expect(sql`update fixture_stream_sessions set ${sql(col)} = null where id = ${sid}`, col).rejects.toMatchObject({ code: "23502" });
    }
    // The two counters start at the sum of nothing.
    const [zero] = await sql<{ recording_bytes: number; credentials_served_count: number }[]>`
      select recording_bytes::int as recording_bytes, credentials_served_count from fixture_stream_sessions where id = ${sid}`;
    expect(zero).toEqual({ recording_bytes: 0, credentials_served_count: 0 });
    for (const [col, bad] of [["recording_bytes", -1], ["credentials_served_count", -1], ["est_cost_minor", -1], ["est_cost_currency", "GBP"], ["est_cost_currency", "gb"]] as const) {
      await expect(sql`update fixture_stream_sessions set ${sql(col)} = ${bad} where id = ${sid}`, `${col} = ${bad}`).rejects.toMatchObject({ code: "23514" });
    }
    // The accepted twin: every Task 0 fact lands; the nullable snapshot columns take null (no court, no schedule,
    // an org with no timezone) and venue_id takes an id no venue has — a snapshot, not a reference.
    await sql`
      update fixture_stream_sessions
         set recording_bytes = 734003200, credentials_served_count = 2, credentials_served_first_at = now(),
             est_cost_minor = 0, est_cost_currency = 'usd', output_uid = 'out-uid-1',
             fixture_scheduled_at = null, venue_id = gen_random_uuid(), venue_address = null, org_timezone = null
       where id = ${sid}`;
  });

  // ---- The Task 7 / 7A amend to V410 (orchestrator rulings 2026-09-16) ----

  it("org_stream_credits reason: 'revoke' (a negative staff row) lands; an unknown reason is still refused (the Task 7A amend)", async () => {
    const r = await rig();
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${r.orgId}, 3, 'grant', 3)`;
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${r.orgId}, -1, 'revoke', 2)`;
    await expect(
      sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${r.orgId}, -1, 'reverse', 1)`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("org_stream_credits idempotency_key: unique across the TABLE (the donor's V320 scope) — a second row with one key is refused in the same org AND in another org; a different key, and any number of NULL keys, land; and the index is pinned by NAME and predicate, which no insert can witness (the Task 7A amend)", async () => {
    const a = await rig();
    const b = await rig();
    const key = `idem-shape-${a.orgId}`;
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after, idempotency_key) values (${a.orgId}, 1, 'grant', 1, ${key})`;
    await expect(
      sql`insert into org_stream_credits (org_id, delta, reason, balance_after, idempotency_key) values (${a.orgId}, 1, 'grant', 2, ${key})`,
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      sql`insert into org_stream_credits (org_id, delta, reason, balance_after, idempotency_key) values (${b.orgId}, 1, 'grant', 1, ${key})`,
    ).rejects.toMatchObject({ code: "23505" });
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after, idempotency_key) values (${b.orgId}, 1, 'grant', 1, ${key + "-b"})`;
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${a.orgId}, 1, 'grant', 2)`;
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after) values (${a.orgId}, 1, 'grant', 3)`;
    // The two NULL rows above do NOT prove the partial predicate: a plain unique index is
    // NULLS DISTINCT by default, so dropping `where idempotency_key is not null` leaves every
    // insert in this test behaving identically (measured — that mutant survived the whole
    // suite). The predicate keeps the index off every purchase and consume row, and the NAME
    // is what stream-credits.ts matches a 23505 on to answer 409 idempotency_key_reused
    // (Task 7A). Neither is reachable from behaviour, so both are pinned as text here.
    const [idx] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
       where schemaname = current_schema() and tablename = 'org_stream_credits'
         and indexname = 'org_stream_credits_idempotency_key'`;
    expect(idx?.indexdef, "org_stream_credits_idempotency_key is missing or renamed").toMatch(
      /^CREATE UNIQUE INDEX org_stream_credits_idempotency_key ON \w+\.org_stream_credits USING btree \(idempotency_key\) WHERE \(idempotency_key IS NOT NULL\)$/,
    );
  });

  it("org_stream_credits_payment_intent (V420) exists, is PARTIAL on the null test, and is NOT narrowed to purchases", async () => {
    // findStreamPurchase asks "was this charge a match-credit pack?" with no org in the
    // predicate — finding out whose org it is IS the query's purpose — so V410's
    // (org_id, created_at) cannot serve it and, without this index, the claw-back seq-scans
    // every row of every org on a path that refunds for registration, sponsor, Event Pass and
    // AI credit packs all reach as well.
    //
    // Pinned as TEXT, not by behaviour, for the same reason as the index above: on a small
    // test table the planner prefers a seq scan whether or not the index exists, so an
    // EXPLAIN assertion would pass with the index dropped. Two properties are load-bearing and
    // neither is reachable from a query result.
    //
    // PARTIAL on `is not null` is what keeps it small — the column is written on the purchase
    // row only, and consume rows (one per stream session) are the bulk of this table.
    //
    // The predicate must NOT also be `reason = 'purchase'`. A claw-back row deliberately
    // carries the same payment intent so a human can walk the ledger back to the Stripe
    // object; an index narrowed to purchases could not serve that walk. A future edit that
    // "tightens" the predicate is the mutant this line exists to catch.
    const [idx] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
       where schemaname = current_schema() and tablename = 'org_stream_credits'
         and indexname = 'org_stream_credits_payment_intent'`;
    expect(idx?.indexdef, "org_stream_credits_payment_intent is missing or renamed").toMatch(
      /^CREATE INDEX org_stream_credits_payment_intent ON \w+\.org_stream_credits USING btree \(stripe_payment_intent_id\) WHERE \(stripe_payment_intent_id IS NOT NULL\)$/,
    );
  });

  it("org_stream_credits_session_id (V425) exists and is PARTIAL on the null test — a session's rows are looked up by session", async () => {
    // Three readers ask for one session's ledger rows: the organiser's 5-second poll (currentSession's creditUsed sum),
    // the linked-refund cap and reuseWindowOpen (stream-credits.ts), and Postgres itself — session_id is a foreign key
    // with no ON DELETE action, so deleting a session row (provisionSession's ingest-refusal cleanup) checks this table
    // with no org in the predicate. V410 indexed none of them by session.
    //
    // Pinned as TEXT for V420's reason: on a small test table the planner seq-scans whether or not the index exists, so
    // an EXPLAIN assertion would pass with it dropped. PARTIAL on `is not null` keeps purchases, grants and unlinked
    // refunds — which carry no session and are never looked up by one — out of it.
    const [idx] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
       where schemaname = current_schema() and tablename = 'org_stream_credits'
         and indexname = 'org_stream_credits_session_id'`;
    expect(idx?.indexdef, "org_stream_credits_session_id is missing or renamed").toMatch(
      /^CREATE INDEX org_stream_credits_session_id ON \w+\.org_stream_credits USING btree \(session_id\) WHERE \(session_id IS NOT NULL\)$/,
    );
  });

  it("org_stream_credits.bucket (V426, Task 14b R2) is NOT NULL, defaults to 'pack', and admits exactly 'monthly' and 'pack' — a row that names neither is refused", async () => {
    // The two buckets are what make a monthly grant expirable while a bought pack never is. A row written without a
    // bucket (every writer that predates V426, and every backfilled row) is a PACK: it never expires.
    const { orgId } = await rig();
    const insert = (bucket: string | null) =>
      bucket === null
        ? sql<{ bucket: string }[]>`insert into org_stream_credits (org_id, delta, reason, balance_after)
                                     values (${orgId}, 1, 'grant', 1) returning bucket`
        : sql<{ bucket: string }[]>`insert into org_stream_credits (org_id, delta, reason, balance_after, bucket)
                                     values (${orgId}, 1, 'grant', 1, ${bucket}) returning bucket`;
    expect((await insert(null))[0]!.bucket, "the default").toBe("pack");
    let admitted = 0;
    for (const bucket of ["monthly", "pack"]) {
      expect((await insert(bucket))[0]!.bucket).toBe(bucket);
      admitted++;
    }
    expect(admitted).toBe(2);
    await expect(insert("grant"), "a reason is not a bucket").rejects.toMatchObject({ code: "23514" });
    await expect(insert("Monthly"), "the check is exact").rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`insert into org_stream_credits (org_id, delta, reason, balance_after, bucket) values (${orgId}, 1, 'grant', 1, ${null})`,
      "NOT NULL",
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("org_stream_credits.stripe_event_id and stripe_checkout_session_id say what they hold (V424, lane B carry M7): a Checkout Session id, the purchase idempotency key, NOT a Stripe event id — each naming its twin", async () => {
    // The column NAME says "event id"; the writer stores the Checkout SESSION id (billing-events.ts recordPurchase
    // `stripeEventId: session.id`), and the link column holds the same value. That FACT is pinned through the real webhook
    // by stream-credits-webhook.test.ts ("writes ONE purchase row…": stripe_event_id === stripe_checkout_session_id ===
    // the cs_ id). What only the catalogue can carry is the warning to the next reader — a comment nothing reads is not
    // there, so this reads it back (col_description is null until V424 runs).
    const rows = await sql<{ column: string; comment: string | null }[]>`
      select a.attname as column, col_description(a.attrelid, a.attnum) as comment
        from pg_attribute a
       where a.attrelid = 'org_stream_credits'::regclass and a.attname in ('stripe_event_id', 'stripe_checkout_session_id')
       order by a.attname`;
    expect(rows.map((r) => r.column), "both columns are there to be described").toEqual(["stripe_checkout_session_id", "stripe_event_id"]);
    const link = rows[0]!.comment;
    const key = rows[1]!.comment;
    expect(key, "stripe_event_id").toMatch(/Checkout Session id \(cs_…\)/);
    expect(key).toMatch(/idempotency key/);
    expect(key).toMatch(/NOT a Stripe event id/);
    expect(key).toMatch(/stripe_checkout_session_id/);
    expect(link, "stripe_checkout_session_id").toMatch(/Checkout Session id/);
    expect(link).toMatch(/stripe_event_id/);
  });

  it("max_duration_minutes: 0 is refused by check (max_duration_minutes > 0) — domain/expiry.ts deadlineOf would read a stored 0 as 300; 1 lands, and the default is still 300 (the Task 7 amend, Task 2B review M4)", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    const minutes = async () =>
      (await sql<{ max_duration_minutes: number }[]>`
        select max_duration_minutes from fixture_stream_sessions where id = ${sid}`)[0]!.max_duration_minutes;
    expect(await minutes()).toBe(300);
    await expect(
      sql`update fixture_stream_sessions set max_duration_minutes = 0 where id = ${sid}`,
    ).rejects.toMatchObject({ code: "23514" });
    // -1 as well as 0: `>= 0` would refuse the negative and still let the zero through, which is
    // the exact mutant the 0 case alone cannot see.
    await expect(
      sql`update fixture_stream_sessions set max_duration_minutes = -1 where id = ${sid}`,
    ).rejects.toMatchObject({ code: "23514" });
    expect(await minutes()).toBe(300);
    await sql`update fixture_stream_sessions set max_duration_minutes = 1 where id = ${sid}`;
    expect(await minutes()).toBe(1);
  });

  // Whole-branch review gap g2. The upper bound was missing entirely: 100000 was accepted, and THREE consumers derive
  // from this number — `relayTokenExpiry` (a ~69-day relay token), `MACHINE_MINUTES_BOUND`, and `RunnerSpec.deadlineAt`
  // (a Fly Machine whose hard stop is 69 days out). The ceiling lives in the DDL rather than only in a usecase because
  // a constraint is the only guard that survives a second writer.
  it("max_duration_minutes: the CEILING is real — 301 refused and 300 accepted, with 1 still accepted and 0 / -1 still refused; and the DDL's ceiling EQUALS config.ts's MAX_DURATION_MINUTES, so moving the constant reds this instead of leaving the CHECK on yesterday's number (gap g2)", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    const minutes = async () =>
      (await sql<{ max_duration_minutes: number }[]>`
        select max_duration_minutes from fixture_stream_sessions where id = ${sid}`)[0]!.max_duration_minutes;
    // Refused, both ends. 301 is the row the old CHECK could not see at all.
    for (const bad of [301, 100000, 0, -1]) {
      await expect(
        sql`update fixture_stream_sessions set max_duration_minutes = ${bad} where id = ${sid}`, String(bad),
      ).rejects.toMatchObject({ code: "23514" });
    }
    // Accepted, both ends — the boundary itself and the floor, or a CHECK of `< 300` would pass the rows above.
    for (const ok of [1, MAX_DURATION_MINUTES - 1, MAX_DURATION_MINUTES]) {
      await sql`update fixture_stream_sessions set max_duration_minutes = ${ok} where id = ${sid}`;
      expect(await minutes(), String(ok)).toBe(ok);
    }
    // SQL needs a literal, so the literal is checked against the source of truth rather than re-typed as an
    // expectation here (rule 19: derive from the engine's own declarations). Read from the LIVE catalogue — the DDL
    // Postgres actually holds, not the text of the file.
    const [ceiling] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = current_schema() and t.relname = 'fixture_stream_sessions' and c.contype = 'c'
         and pg_get_constraintdef(c.oid) like '%max_duration_minutes%'`;
    expect(ceiling?.def, "no CHECK constraint on fixture_stream_sessions.max_duration_minutes").toBeDefined();
    const bound = /max_duration_minutes\s*<=\s*(\d+)/.exec(ceiling!.def);
    expect(bound, `the CHECK states no upper bound: ${ceiling!.def}`).not.toBeNull();
    expect(Number(bound![1])).toBe(MAX_DURATION_MINUTES);
  });

  // Whole-branch review gap g1. `failReasonFromExit` (domain/runner.ts) is the only thing that separates machine_oom
  // from machine_exit_nonzero from machine_crash, and its sole input is the Machine's exit — which had NO column.
  // Three columns of their own rather than a key inside `last_heartbeat`: that jsonb is the beat route's to write and
  // a jsonb write REPLACES the document, so a beat between the observation and the destroy would drop the exit and the
  // session would report machine_crash for an OOM.
  it("the runner exit facts have columns of their own: three NULLABLE columns with NO default (absent means NOT OBSERVED, which must fall through to the engine's default rather than override it), and each round-trips its own type (gap g1)", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    const shape = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_sessions'
         and column_name in ('runner_exit_code', 'runner_oom_killed', 'runner_requested_stop')
       order by column_name`;
    expect(shape).toEqual([
      { column_name: "runner_exit_code", data_type: "integer", is_nullable: "YES", column_default: null },
      { column_name: "runner_oom_killed", data_type: "boolean", is_nullable: "YES", column_default: null },
      { column_name: "runner_requested_stop", data_type: "boolean", is_nullable: "YES", column_default: null },
    ]);
    // A new row has observed nothing — the three read null, which is `ExitInfo`'s "we never saw an exit".
    const read = async () =>
      (await sql<{ runner_exit_code: number | null; runner_oom_killed: boolean | null; runner_requested_stop: boolean | null }[]>`
        select runner_exit_code, runner_oom_killed, runner_requested_stop from fixture_stream_sessions where id = ${sid}`)[0]!;
    expect(await read()).toEqual({ runner_exit_code: null, runner_oom_killed: null, runner_requested_stop: null });
    // The accepted twin, with the values that actually distinguish the three fail reasons: an OOM kill is exit 137.
    await sql`
      update fixture_stream_sessions
         set runner_exit_code = 137, runner_oom_killed = true, runner_requested_stop = false
       where id = ${sid}`;
    expect(await read()).toEqual({ runner_exit_code: 137, runner_oom_killed: true, runner_requested_stop: false });
    // …and `false` is distinguishable from `null`, which is the whole reason there is no default: a clean exit 0 that
    // WAS observed must not read like an exit nobody looked at.
    await sql`
      update fixture_stream_sessions
         set runner_exit_code = 0, runner_oom_killed = false, runner_requested_stop = true
       where id = ${sid}`;
    expect(await read()).toEqual({ runner_exit_code: 0, runner_oom_killed: false, runner_requested_stop: true });
    // The exit facts are NOT inside last_heartbeat: a beat REPLACING that document leaves them untouched.
    await sql`update fixture_stream_sessions set last_heartbeat = ${sql.json({ fps: 30 })} where id = ${sid}`;
    expect(await read()).toEqual({ runner_exit_code: 0, runner_oom_killed: false, runner_requested_stop: true });
  });

  it("beat_window_at: a NULLABLE timestamptz with NO default, separate from heartbeat_at — a new session reads null in both, and writing the window anchor leaves the last beat received untouched (Task 2C review I4, ruling A; the Task 7 amend)", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    const beats = async () =>
      (await sql<{ heartbeat_at: Date | null; beat_window_at: Date | null }[]>`
        select heartbeat_at, beat_window_at from fixture_stream_sessions where id = ${sid}`)[0]!;
    expect(await beats()).toEqual({ heartbeat_at: null, beat_window_at: null });
    // The shape itself, pinned: a DEFAULT (now(), say) would read as an anchor on every new row and silently
    // restart every session's first beat window at insert time.
    const [shape] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_sessions' and column_name = 'beat_window_at'`;
    expect(shape).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
    await sql`update fixture_stream_sessions set beat_window_at = '2026-09-16T10:02:00Z' where id = ${sid}`;
    const after = await beats();
    expect(after.beat_window_at?.toISOString()).toBe("2026-09-16T10:02:00.000Z");
    expect(after.heartbeat_at).toBeNull(); // two facts, two columns: the anchor never writes the panel's last beat
  });

  it("dest_fingerprint (V421, A19): NULLABLE text with no default, so a row that predates it holds null and nulls never collide; a non-hex value is refused (the column can never hold a plaintext url or key); one org cannot hold one fingerprint twice, another org can; the index is pinned by NAME and PREDICATE", async () => {
    const a = await rig();
    const b = await rig();
    const hex64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
    const target = (orgId: string, fp: string | null) => sql`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc, dest_fingerprint)
      values (${orgId}, 'youtube', 'fp', ${Buffer.from("not-a-real-envelope")}, ${fp})`;
    const [shape] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'org_stream_targets' and column_name = 'dest_fingerprint'`;
    expect(shape).toEqual({ data_type: "text", is_nullable: "YES", column_default: null });
    // rig()'s target is a pre-V421-shaped raw insert: null, and a second null in the same org lands beside it.
    await target(a.orgId, null);
    const fp = hex64();
    await target(a.orgId, fp);
    await expect(target(a.orgId, fp)).rejects.toMatchObject({ code: "23505", constraint_name: "org_stream_targets_org_dest_fingerprint" });
    await target(b.orgId, fp);   // the same destination in ANOTHER org is its own row
    let refused = 0;
    for (const bad of ["rtmps://a.rtmps.youtube.com/live2", fp.toUpperCase(), fp.slice(1), `${fp}0`]) {
      await expect(target(a.orgId, bad), bad).rejects.toMatchObject({ code: "23514", constraint_name: "org_stream_targets_dest_fingerprint_shape" });
      refused++;
    }
    expect(refused).toBe(4);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_targets where org_id = ${a.orgId}`;
    expect(n).toBe(3);   // rig's null, the second null, the fingerprinted row
    // The PREDICATE keeps legacy nulls outside the index WITHOUT leaning on NULLS DISTINCT (a later "tidy" to NULLS NOT
    // DISTINCT would otherwise make two legacy rows collide), and it is what insertStreamTarget's
    // `on conflict (org_id, dest_fingerprint) where dest_fingerprint is not null` must match to INFER this index — a
    // drifted predicate turns every dedupe into 42P10. Neither is reachable from a plain insert, so both are pinned as
    // text (the idempotency_key precedent above). V427 (D2) narrowed the predicate to ACTIVE rows too, keeping V421's
    // own conjunct; insertStreamTarget's ON CONFLICT names the whole of it.
    const [idx] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
       where schemaname = current_schema() and tablename = 'org_stream_targets'
         and indexname = 'org_stream_targets_org_dest_fingerprint'`;
    expect(idx?.indexdef, "org_stream_targets_org_dest_fingerprint is missing or renamed").toMatch(
      /^CREATE UNIQUE INDEX org_stream_targets_org_dest_fingerprint ON \w+\.org_stream_targets USING btree \(org_id, dest_fingerprint\) WHERE \(\(dest_fingerprint IS NOT NULL\) AND \(archived_at IS NULL\)\)$/,
    );
  });

  it("archived_at (V427, D2): NULLABLE timestamptz with no default; an ARCHIVED row never blocks an active row of the same fingerprint, while two ACTIVE rows still collide by name", async () => {
    const a = await rig();
    const hex64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
    const [shape] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'org_stream_targets' and column_name = 'archived_at'`;
    expect(shape).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
    const fp = hex64();
    const put = (archived: boolean) => sql`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc, dest_fingerprint, archived_at)
      values (${a.orgId}, 'youtube', 'fp', ${Buffer.from("not-a-real-envelope")}, ${fp}, ${archived ? new Date() : null})`;
    await put(true);
    await put(true);               // two archived rows of one destination: history, both kept
    await put(false);              // the active row lands beside them
    await expect(put(false)).rejects.toMatchObject({ code: "23505", constraint_name: "org_stream_targets_org_dest_fingerprint" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_targets where org_id = ${a.orgId} and dest_fingerprint = ${fp}`;
    expect(n).toBe(3);
  });

  it("ingest_polled_at (V428, final review I-1): NULLABLE timestamptz with no default, so every existing session reads 'never claimed' and its next poll reads Cloudflare", async () => {
    const [shape] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_sessions' and column_name = 'ingest_polled_at'`;
    expect(shape).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
  });

  it("runner_gone_confirmed_at (V422, A22(c)): NULLABLE timestamptz with no default, so every existing row reads 'not confirmed'; the mark is REFUSED on every ACTIVE state and accepted on every TERMINAL one — both lists the domain's own, never typed here", async () => {
    const r = await rig();
    const [shape] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_sessions' and column_name = 'runner_gone_confirmed_at'`;
    expect(shape).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
    const mark = (sid: string) => sql`update fixture_stream_sessions set runner_gone_confirmed_at = now() where id = ${sid}`;
    let refused = 0;
    for (const state of ACTIVE_STATES) {
      const sid = await insertSession(r, state);
      const [fresh] = await sql<{ m: Date | null }[]>`select runner_gone_confirmed_at as m from fixture_stream_sessions where id = ${sid}`;
      expect(fresh!.m, `${state}: a new row is not confirmed`).toBeNull();
      await expect(mark(sid), state).rejects.toMatchObject({ code: "23514", constraint_name: "fixture_stream_sessions_runner_gone_terminal" });
      refused++;
      await sql`update fixture_stream_sessions set state = 'failed' where id = ${sid}`;   // frees the fixture's one-active slot for the next state
    }
    let accepted = 0;
    for (const state of TERMINAL_STATES) {
      const sid = await insertSession(r, state);
      await mark(sid);
      const [row] = await sql<{ m: Date | null }[]>`select runner_gone_confirmed_at as m from fixture_stream_sessions where id = ${sid}`;
      expect(row!.m, state).toBeInstanceOf(Date);
      accepted++;
    }
    // Anti-vacuity: each list was walked in full, and neither is empty.
    expect(refused).toBe(ACTIVE_STATES.length);
    expect(accepted).toBe(TERMINAL_STATES.length);
    expect(refused * accepted).toBeGreaterThan(0);
  });

  it("output_released_at (V423, C1): NULLABLE timestamptz with no default, so every existing row reads 'not released'; the mark is REFUSED on every ACTIVE state and on a row that never held an output, and accepted on every TERMINAL row that did — both state lists the domain's own", async () => {
    const r = await rig();
    const [shape] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_sessions' and column_name = 'output_released_at'`;
    expect(shape).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
    const release = (sid: string) => sql`update fixture_stream_sessions set output_released_at = now() where id = ${sid}`;
    const REFUSAL = { code: "23514", constraint_name: "fixture_stream_sessions_output_released" };
    let refused = 0;
    for (const state of ACTIVE_STATES) {
      const sid = await insertSession(r, state);
      await sql`update fixture_stream_sessions set output_uid = 'out-1' where id = ${sid}`;
      const [fresh] = await sql<{ m: Date | null }[]>`select output_released_at as m from fixture_stream_sessions where id = ${sid}`;
      expect(fresh!.m, `${state}: a new row is not released`).toBeNull();
      await expect(release(sid), state).rejects.toMatchObject(REFUSAL);   // a live broadcast is never marked released
      refused++;
      await sql`update fixture_stream_sessions set state = 'failed' where id = ${sid}`;   // frees the one-active slot
    }
    let accepted = 0, noOutput = 0;
    for (const state of TERMINAL_STATES) {
      const bare = await insertSession(r, state);
      await expect(release(bare), `${state} with no output`).rejects.toMatchObject(REFUSAL);   // nothing was added, nothing to release
      noOutput++;
      const sid = await insertSession(r, state);
      await sql`update fixture_stream_sessions set output_uid = 'out-1' where id = ${sid}`;
      await release(sid);
      const [row] = await sql<{ m: Date | null }[]>`select output_released_at as m from fixture_stream_sessions where id = ${sid}`;
      expect(row!.m, state).toBeInstanceOf(Date);
      accepted++;
    }
    expect(refused).toBe(ACTIVE_STATES.length);
    expect(accepted).toBe(TERMINAL_STATES.length);
    expect(noOutput).toBe(TERMINAL_STATES.length);
    expect(refused * accepted).toBeGreaterThan(0);
  });
});

// ---- V430 (capture QR v2 PR-1 T3, spec §8.1 amended by §17.1/§17.3) -------------------------
// The stable stream code, its pairings, the per-fixture settings and the phone-beat history; the
// session columns the code and pairing hang off; the drop and the rename (R3); end_reason's five
// and events.source's 'phone'. Every refusal has its accepted twin; every enum is read from the
// parsed fold (_stream-migration.ts lastCheckList), never typed.

/** A well-formed code from the Crockford alphabet the contract publishes (CAPTURE_CODE_RE). */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const newCode = (): string => Array.from(randomBytes(12), (b) => CROCKFORD[b % 32]).join("");
const tokHash = (): string => createHash("sha256").update(randomBytes(16)).digest("hex");

async function insertCode(r: Awaited<ReturnType<typeof rig>>, over: { code?: string; tokEnc?: Buffer | null } = {}) {
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_stream_codes (org_id, fixture_id, code, tok_hash, tok_enc, issued_by)
    values (${r.orgId}, ${r.fixtureId}, ${over.code ?? newCode()}, ${tokHash()},
            ${over.tokEnc === undefined ? Buffer.from("sealed-envelope") : over.tokEnc}, ${r.userId})
    returning id`;
  return row!.id;
}

async function insertPairing(orgId: string, codeId: string, over: { slot?: number; phone?: string; ended?: boolean } = {}) {
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, claimed_at, last_beat_at,
                                         answered_poll_seconds, ended_at, end_cause)
    values (${orgId}, ${codeId}, ${over.slot ?? 0}, ${over.phone ?? "phone-" + randomUUID()}, 'new', now(), now(),
            10, ${over.ended ? sql`now()` : null}, ${over.ended ? "replaced" : null})
    returning id`;
  return row!.id;
}

const V430_TABLES = ["fixture_stream_codes", "fixture_stream_settings", "fixture_stream_pairings", "fixture_stream_phone_beats"];

describe.skipIf(!HAS_DB)("V430__capture_stream_codes.sql — the constraints are real", () => {
  it("the four new tables exist, each with RLS enabled AND forced and NO row in pg_policies (R1: the V410 pattern)", async () => {
    const rows = await sql<{ relname: string; rls: boolean; forced: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*) from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname)::int as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = current_schema() and c.relname = any(${V430_TABLES})
       order by c.relname`;
    expect(rows.map((r) => r.relname)).toEqual([...V430_TABLES].sort());
    for (const r of rows) expect(r, r.relname).toMatchObject({ rls: true, forced: true, policies: 0 });
    // R1: no tenant trigger either — the use-case writes org_id from the code or session row.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = any(${V430_TABLES}) and t.tgname = 'trg_set_org'`;
    expect(n).toBe(0);
  });

  it("fixture_stream_codes_one_active and fixture_stream_pairings_one_current are PARTIAL UNIQUE indexes, pinned by name and predicate — and each refuses a second live row while an ended one never collides", async () => {
    const idx = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
       where schemaname = current_schema()
         and indexname in ('fixture_stream_codes_one_active', 'fixture_stream_pairings_one_current')
       order by indexname`;
    expect(idx.map((i) => i.indexname)).toEqual(["fixture_stream_codes_one_active", "fixture_stream_pairings_one_current"]);
    expect(idx[0]!.indexdef).toMatch(/^CREATE UNIQUE INDEX fixture_stream_codes_one_active ON \w+\.fixture_stream_codes USING btree \(fixture_id\) WHERE \(ended_at IS NULL\)$/);
    expect(idx[1]!.indexdef).toMatch(/^CREATE UNIQUE INDEX fixture_stream_pairings_one_current ON \w+\.fixture_stream_pairings USING btree \(code_id, slot\) WHERE \(ended_at IS NULL\)$/);

    const r = await rig();
    const first = await insertCode(r);
    await expect(insertCode(r), "a second ACTIVE code on one fixture").rejects.toMatchObject({ code: "23505", constraint_name: "fixture_stream_codes_one_active" });
    await sql`update fixture_stream_codes set ended_at = now(), end_cause = 'reissued', tok_enc = null where id = ${first}`;
    const second = await insertCode(r);                                   // the ended one never collides (C3: reissue)

    await insertPairing(r.orgId, second, { slot: 0 });
    await expect(insertPairing(r.orgId, second, { slot: 0 }), "a second CURRENT pairing on (code, slot)").rejects.toMatchObject({ code: "23505", constraint_name: "fixture_stream_pairings_one_current" });
    await insertPairing(r.orgId, second, { slot: 0, ended: true });       // an ENDED pairing never collides
    await insertPairing(r.orgId, second, { slot: 1 });                    // another slot is another key
  });

  it("fixture_stream_codes: tok_enc is NULLABLE and `ended_at is null or tok_enc is null` holds — an ended code with its envelope is refused, wiped it lands; the code pattern IS the contract's CAPTURE_CODE_RE; tok_hash is 64 hex; ended_at and end_cause move together", async () => {
    const [shape] = await sql<{ data_type: string; is_nullable: string }[]>`
      select data_type, is_nullable from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_codes' and column_name = 'tok_enc'`;
    expect(shape).toEqual({ data_type: "bytea", is_nullable: "YES" });
    const r = await rig();
    const id = await insertCode(r);
    await expect(sql`update fixture_stream_codes set ended_at = now(), end_cause = 'expired' where id = ${id}`, "ended with its tok still sealed")
      .rejects.toMatchObject({ code: "23514" });
    await expect(sql`update fixture_stream_codes set ended_at = now(), tok_enc = null where id = ${id}`, "ended_at without end_cause")
      .rejects.toMatchObject({ code: "23514" });
    await expect(sql`update fixture_stream_codes set ended_at = now(), end_cause = 'stolen', tok_enc = null where id = ${id}`, "an end_cause outside the list")
      .rejects.toMatchObject({ code: "23514" });
    await sql`update fixture_stream_codes set ended_at = now(), end_cause = 'expired', tok_enc = null where id = ${id}`;
    // The DB's pattern is the contract's, read from pg_constraint — never a second copy typed here.
    const defs = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'fixture_stream_codes'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%code ~%'`;
    expect(defs).toHaveLength(1);
    expect(defs[0]!.def).toContain(`'${CAPTURE_CODE_RE.source}'`);
    const r2 = await rig();
    for (const bad of ["abcdefghijkl", "ABCDEFGHJKMN", "abcdefghjkm", "abcdefghjkmnp"]) {   // i/l, upper case, 11, 13
      expect(CAPTURE_CODE_RE.test(bad), bad).toBe(false);
      await expect(insertCode(r2, { code: bad }), bad).rejects.toMatchObject({ code: "23514" });
    }
    await expect(sql`insert into fixture_stream_codes (org_id, fixture_id, code, tok_hash, issued_by)
                     values (${r2.orgId}, ${r2.fixtureId}, ${newCode()}, 'not-hex', ${r2.userId})`).rejects.toMatchObject({ code: "23514" });
    await insertCode(r2, { tokEnc: null });                               // an active code with no envelope is admitted (ensure re-mints)
  });

  it("fixture_stream_pairings and fixture_stream_phone_beats: every enum and bound refuses, and the accepted twin lands", async () => {
    const r = await rig();
    const codeId = await insertCode(r);
    const base = { org: r.orgId, code: codeId };
    const pairing = (col: string, value: unknown) => sql`
      insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, claimed_at, last_beat_at, answered_poll_seconds)
      values (${base.org}, ${base.code}, 7, ${"phone-" + randomUUID()}, 'new', now(), now(), 10)
      returning id`.then(async ([row]) => {
        try { await sql`update fixture_stream_pairings set ${sql(col)} = ${value as never} where id = ${row!.id}`; }
        finally { await sql`update fixture_stream_pairings set ended_at = now(), end_cause = 'replaced' where id = ${row!.id}`; }
      });
    const refusals: [string, unknown][] = [
      ["slot", -1], ["phone", "short"], ["phone", "p".repeat(65)], ["claim_kind", "steal"], ["device_model", "m".repeat(81)],
      ["app_version", "v".repeat(41)], ["mode", "manual"], ["not_ready", "battery"], ["start_failed", "boom"],
      ["answered_poll_seconds", 4], ["answered_poll_seconds", 301], ["end_cause", "replaced"],
    ];
    for (const [col, bad] of refusals) await expect(pairing(col, bad), `${col} = ${String(bad)}`).rejects.toMatchObject({ code: "23514" });
    // The accepted twin: every bound at its edge.
    const pid = await insertPairing(r.orgId, codeId, { slot: 0, phone: "p".repeat(16) });
    await sql`update fixture_stream_pairings set phone = ${"p".repeat(64)}, answered_poll_seconds = 5, mode = 'operator', not_ready = 'held',
                start_failed = 'cred-host', device_model = ${"m".repeat(80)}, app_version = ${"v".repeat(40)} where id = ${pid}`;
    await sql`update fixture_stream_pairings set answered_poll_seconds = 300 where id = ${pid}`;

    const beat = (over: Record<string, unknown>) => sql`
      insert into fixture_stream_phone_beats ${sql({ org_id: r.orgId, pairing_id: pid, recorded_at: new Date(), kind: "minute", raw: sql.json({}), ...over } as never)}`;
    for (const [col, bad] of [["kind", "hour"], ["battery_pct", 101], ["battery_pct", -1], ["delivery", "lost"]] as const) {
      await expect(beat({ [col]: bad }), `${col} = ${bad}`).rejects.toMatchObject({ code: "23514" });
    }
    await beat({ kind: "change", battery_pct: 0, delivery: "stalled", flags: ["battery_low", "hot"], delivered_lag_s: 12.3 });
    await beat({ kind: "minute", battery_pct: 100, delivery: "ok" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_phone_beats where pairing_id = ${pid}`;
    expect(n).toBe(2);
  });

  it("fixture_stream_sessions: start_cause defaults to 'organiser' and admits exactly organiser/operator/automatic (read from the fold); code_id, pairing_id, phone_beat, phone_beat_at and warming_at are NULLABLE with no default", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    const [row] = await sql<Record<string, unknown>[]>`
      select start_cause, code_id, pairing_id, phone_beat, phone_beat_at, warming_at from fixture_stream_sessions where id = ${sid}`;
    expect(row).toEqual({ start_cause: "organiser", code_id: null, pairing_id: null, phone_beat: null, phone_beat_at: null, warming_at: null });
    const causes = lastCheckList("fixture_stream_sessions", "start_cause");
    expect(causes, "the fold declares start_cause's list").toHaveLength(3);
    for (const cause of causes) await sql`update fixture_stream_sessions set start_cause = ${cause} where id = ${sid}`;
    await expect(sql`update fixture_stream_sessions set start_cause = 'phone' where id = ${sid}`).rejects.toMatchObject({ code: "23514" });
    const cols = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_sessions'
         and column_name in ('code_id', 'pairing_id', 'phone_beat', 'phone_beat_at', 'warming_at')
       order by column_name`;
    expect(cols).toEqual(["code_id", "pairing_id", "phone_beat", "phone_beat_at", "warming_at"].map((c) => ({ column_name: c, is_nullable: "YES", column_default: null })));
  });

  it("fixture_stream_sessions.ingest_read_failed (B7 re-review, the outage gap): boolean NOT NULL default false — a new session starts with no failed read, and null is refused", async () => {
    const r = await rig();
    const sid = await insertSession(r, "requested");
    const [row] = await sql<{ ingest_read_failed: unknown }[]>`select ingest_read_failed from fixture_stream_sessions where id = ${sid}`;
    expect(row).toEqual({ ingest_read_failed: false });
    const [col] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_sessions' and column_name = 'ingest_read_failed'`;
    expect(col).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
    await expect(sql`update fixture_stream_sessions set ingest_read_failed = null where id = ${sid}`).rejects.toMatchObject({ code: "23502" });
  });

  it("the drop and the rename (R3): qr_issued_first_at is GONE, credentials_served_first_at and credentials_served_count are present, the pre-rename names are absent", async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_sessions'
         and column_name in ('qr_issued_first_at', 'credentials_revealed_first_at', 'credentials_reveal_count',
                             'credentials_served_first_at', 'credentials_served_count')
       order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(["credentials_served_count", "credentials_served_first_at"]);
    // The counter's check follows the column's name (B3 review m-7), and still refuses a negative (the session-facts case).
    const checks = await sql<{ conname: string }[]>`
      select conname from pg_constraint
       where conrelid = 'fixture_stream_sessions'::regclass and conname like 'fixture_stream_sessions_credentials_%'
       order by conname`;
    expect(checks.map((c) => c.conname)).toEqual(["fixture_stream_sessions_credentials_served_count_check"]);
  });

  it("end_reason admits EXACTLY the fold's five — every one lands on an ending session, anything else is refused — and the live constraint lists the same five", async () => {
    const five = lastCheckList("fixture_stream_sessions", "end_reason");
    expect(five, "read from the parsed delta, never typed").toHaveLength(5);
    const r = await rig();
    let admitted = 0;
    for (const reason of five) {
      const sid = await insertSession(r, "ending");
      await sql`update fixture_stream_sessions set end_reason = ${reason} where id = ${sid}`;
      await sql`update fixture_stream_sessions set state = 'completed' where id = ${sid}`;   // frees the one-active slot
      admitted++;
    }
    expect(admitted).toBe(5);
    const sid = await insertSession(r, "ending");
    await expect(sql`update fixture_stream_sessions set end_reason = 'crashed' where id = ${sid}`).rejects.toMatchObject({ code: "23514", constraint_name: "fixture_stream_sessions_end_reason_check" });
    await sql`update fixture_stream_sessions set state = 'completed' where id = ${sid}`;   // leave no open row behind
    const [def] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'fixture_stream_sessions'::regclass and conname = 'fixture_stream_sessions_end_reason_check'`;
    expect([...def!.def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort()).toEqual([...five].sort());
  });

  it("the end-reason value check keeps Postgres's DEFAULT name for V410's inline check — fixture_stream_sessions_end_reason_check, read from pg_constraint (A4) — and the named state check is unchanged", async () => {
    const rows = await sql<{ conname: string; def: string }[]>`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'fixture_stream_sessions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%end_reason%'
       order by conname`;
    expect(rows.map((r) => r.conname)).toEqual(["fixture_stream_sessions_end_reason_check", "fixture_stream_sessions_end_reason_state"]);
    expect(rows[1]!.def).toBe("CHECK (((end_reason IS NULL) OR (state = ANY (ARRAY['ending'::text, 'completed'::text]))))");
  });

  it("fixture_stream_events.source admits 'phone' (the fold's list, V410's eight kept), and still refuses an unknown source", async () => {
    const sources = lastCheckList("fixture_stream_events", "source");
    expect(sources).toContain("phone");
    const r = await rig();
    const sid = await insertSession(r, "requested");
    let seq = 0;
    for (const source of sources) {
      seq++;
      await sql`insert into fixture_stream_events (session_id, org_id, seq, source, kind, type) values (${sid}, ${r.orgId}, ${seq}, ${source}, 'observed', 'probe')`;
    }
    expect(seq).toBe(sources.length);
    await expect(sql`insert into fixture_stream_events (session_id, org_id, seq, source, kind, type) values (${sid}, ${r.orgId}, ${seq + 1}, 'ufo', 'observed', 'probe')`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "fixture_stream_events_source_check" });
  });

  it("fixtures.finished_at is a NULLABLE timestamptz with no default, kept by the BEFORE INSERT OR UPDATE OF status trigger fixtures_track_finished", async () => {
    const [shape] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixtures' and column_name = 'finished_at'`;
    expect(shape).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
    const [trg] = await sql<{ def: string }[]>`
      select pg_get_triggerdef(t.oid) as def from pg_trigger t
       where t.tgrelid = 'fixtures'::regclass and t.tgname = 'fixtures_track_finished'`;
    expect(trg?.def).toMatch(/^CREATE TRIGGER fixtures_track_finished BEFORE INSERT OR UPDATE OF status ON \w+\.fixtures FOR EACH ROW EXECUTE FUNCTION fixtures_track_finished\(\)$/);
  });

  it("T35: deleting the fixture deletes its codes, pairings, beat history and settings (cascade); the session survives with fixture_id, code_id and pairing_id all null", async () => {
    const r = await rig();
    const codeId = await insertCode(r);
    const pid = await insertPairing(r.orgId, codeId);
    await sql`insert into fixture_stream_phone_beats (org_id, pairing_id, recorded_at, kind, raw) values (${r.orgId}, ${pid}, now(), 'minute', '{}'::jsonb)`;
    await sql`insert into fixture_stream_settings (fixture_id, org_id, target_id) values (${r.fixtureId}, ${r.orgId}, ${r.targetId})`;
    const sid = await insertSession(r, "live");
    await sql`update fixture_stream_sessions set code_id = ${codeId}, pairing_id = ${pid}, start_cause = 'operator' where id = ${sid}`;
    await sql`delete from fixtures where id = ${r.fixtureId}`;
    const [left] = await sql<{ codes: number; pairings: number; beats: number; settings: number }[]>`
      select (select count(*) from fixture_stream_codes where id = ${codeId})::int as codes,
             (select count(*) from fixture_stream_pairings where id = ${pid})::int as pairings,
             (select count(*) from fixture_stream_phone_beats where pairing_id = ${pid})::int as beats,
             (select count(*) from fixture_stream_settings where fixture_id = ${r.fixtureId})::int as settings`;
    expect(left).toEqual({ codes: 0, pairings: 0, beats: 0, settings: 0 });
    const [session] = await sql<{ fixture_id: string | null; code_id: string | null; pairing_id: string | null; start_cause: string }[]>`
      select fixture_id, code_id, pairing_id, start_cause from fixture_stream_sessions where id = ${sid}`;
    expect(session).toEqual({ fixture_id: null, code_id: null, pairing_id: null, start_cause: "operator" });
  });
});

// V431 (capture QR v2 PR-2, spec §8.2, plan R-1 and FP16). v431-migration.test.ts reads the file's TEXT; these run it. Each
// refusal has its accepted twin in the same `it`, so a test on an unmigrated schema cannot pass.
describe.skipIf(!HAS_DB)("V431__auto_stream.sql — the constraints are real", () => {
  const settingsRow = (r: Awaited<ReturnType<typeof rig>>) =>
    sql`insert into fixture_stream_settings (fixture_id, org_id) values (${r.fixtureId}, ${r.orgId})`;

  it("auto_start_refusal: every code the DOMAIN declares is accepted (and null), an unknown code is refused by the CHECK", async () => {
    const r = await rig();
    await settingsRow(r);
    const set = (code: string | null) => sql`update fixture_stream_settings set auto_start_refusal = ${code} where fixture_id = ${r.fixtureId}`;
    let accepted = 0;
    for (const code of AUTO_START_REFUSALS) {
      await set(code);
      accepted++;
    }
    expect(accepted).toBe(AUTO_START_REFUSALS.length);
    expect(accepted).toBeGreaterThan(0);
    await set(null);   // null = "no refusal on record"
    await set("no_credit");
    await expect(set("ufo")).rejects.toMatchObject({ code: "23514", constraint_name: "fixture_stream_settings_auto_start_refusal_check" });
    const [row] = await sql<{ auto_start_refusal: string | null }[]>`select auto_start_refusal from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
    expect(row!.auto_start_refusal, "the refused write changed nothing").toBe("no_credit");
  });

  it("auto_start_session_id: an unknown session is refused by the FK; deleting the session NULLS the pointer and the row — and its once-per-match stamp — survive (ON DELETE SET NULL)", async () => {
    const r = await rig();
    await expect(
      sql`insert into fixture_stream_settings (fixture_id, org_id, auto_start_session_id) values (${r.fixtureId}, ${r.orgId}, ${randomUUID()})`,
    ).rejects.toMatchObject({ code: "23503" });
    const sid = await insertSession(r, "live");
    await sql`insert into fixture_stream_settings (fixture_id, org_id, auto_start_session_id, auto_started_at) values (${r.fixtureId}, ${r.orgId}, ${sid}, now())`;
    const read = () => sql<{ auto_start_session_id: string | null; auto_started_at: Date | null }[]>`
      select auto_start_session_id, auto_started_at from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
    expect((await read())[0]!.auto_start_session_id, "twin: the pointer holds while the session exists").toBe(sid);
    await sql`delete from fixture_stream_sessions where id = ${sid}`;
    const after = await read();
    expect(after).toHaveLength(1);   // the row is not deleted with its session
    expect(after[0]!.auto_start_session_id).toBeNull();
    expect(after[0]!.auto_started_at, "a deleted session does not re-arm auto start").not.toBeNull();
  });

  it("fixture_stream_pairings.not_ready_since: a NULLABLE timestamptz with no default, null on a new pairing, round-trips a timestamp and clears back to null (FP16)", async () => {
    const [shape] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_pairings' and column_name = 'not_ready_since'`;
    expect(shape).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
    const r = await rig();
    const pid = await insertPairing(r.orgId, await insertCode(r));
    const read = async () => (await sql<{ not_ready_since: Date | null }[]>`select not_ready_since from fixture_stream_pairings where id = ${pid}`)[0]!.not_ready_since;
    expect(await read()).toBeNull();
    const at = new Date("2026-10-07T12:00:00.123Z");
    await sql`update fixture_stream_pairings set not_ready_since = ${at} where id = ${pid}`;
    expect((await read())?.toISOString()).toBe(at.toISOString());
    await sql`update fixture_stream_pairings set not_ready_since = null where id = ${pid}`;
    expect(await read()).toBeNull();
  });
});
