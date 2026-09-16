// The constraints of __stream_sessions.sql are only real if something tries
// to violate them (AGENTS.md class 3). Each refusal here has its accepted twin
// in the same `it`, so a test that passes on an EMPTY schema cannot exist:
// the twin would fail with "relation does not exist" first.
//
// Real Postgres required; skipped without DATABASE_URL like every suite in
// server/usecases/__tests__. The eight tables are reached through the plain
// `sql` client — RLS is FORCEd with zero policies, so `withTenant` (app_user)
// would see nothing, which is the point of §6.1 and of V366.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { STREAM_TABLES } from "./_stream-migration";

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
  it("RLS is enabled AND forced on all EIGHT tables, with zero policies", async () => {
    // The list is read from the migration file itself (`create table (\w+)`), so a
    // ninth table added later is guarded the day it lands, not the day someone
    // remembers this test. STREAM_TABLES comes from _stream-migration.ts, which
    // rls-static.test.ts and telemetry.test.ts (Task 2) import too.
    const rows = await sql<{ relname: string; rls: boolean; forced: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relname = any(${STREAM_TABLES})
      order by c.relname`;
    expect(STREAM_TABLES.length).toBe(8);
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

  it("session facts: the snapshot's not-null columns refuse null; entitlement_via_override has NO default; recording_bytes, credentials_reveal_count and est_cost_minor refuse a negative; est_cost_currency refuses 'GBP' and 'gb'; the accepted twin lands every fact, with a venue id no row has (no FK)", async () => {
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
    const [zero] = await sql<{ recording_bytes: number; credentials_reveal_count: number }[]>`
      select recording_bytes::int as recording_bytes, credentials_reveal_count from fixture_stream_sessions where id = ${sid}`;
    expect(zero).toEqual({ recording_bytes: 0, credentials_reveal_count: 0 });
    for (const [col, bad] of [["recording_bytes", -1], ["credentials_reveal_count", -1], ["est_cost_minor", -1], ["est_cost_currency", "GBP"], ["est_cost_currency", "gb"]] as const) {
      await expect(sql`update fixture_stream_sessions set ${sql(col)} = ${bad} where id = ${sid}`, `${col} = ${bad}`).rejects.toMatchObject({ code: "23514" });
    }
    // The accepted twin: every Task 0 fact lands; the nullable snapshot columns take null (no court, no schedule,
    // an org with no timezone) and venue_id takes an id no venue has — a snapshot, not a reference.
    await sql`
      update fixture_stream_sessions
         set recording_bytes = 734003200, credentials_reveal_count = 2, qr_issued_first_at = now(), credentials_revealed_first_at = now(),
             est_cost_minor = 0, est_cost_currency = 'usd', output_uid = 'out-uid-1',
             fixture_scheduled_at = null, venue_id = gen_random_uuid(), venue_address = null, org_timezone = null
       where id = ${sid}`;
  });
});
