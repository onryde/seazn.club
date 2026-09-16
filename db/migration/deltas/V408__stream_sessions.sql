-- V408 — Streaming R1: relay sessions, ingest inputs, destinations, credits
-- (design of record docs/superpowers/specs/2026-09-07-streaming-programme-design.md
-- §5.2 and §6.1; overriding corrections R0-CORRECTIONS-FOR-R1.md C3; re-pinned
-- 2026-09-16: `ls db/migration/deltas | sort -V | tail -1` → V404__retire_scorer_role.sql,
-- all-refs scan → V407__lichess_lobby_ready.sql (claimed on the unmerged
-- feat/chess-lichess-external-play), both re-confirmed immediately before writing this file).
--
-- Eight tables — four of STATE, four of CAPTURE (owner ruling 13, 2026-09-14:
-- "capture all data as possible"; schema growth pre-approved). RLS is ENABLED
-- and FORCED on every one and NO policy is created:
-- these rows are reached only through the app's non-tenant client, and the
-- organiser sees a projection through
-- /api/v1/fixtures/{id}/stream-sessions/current — never a row. V366's ENABLE +
-- FORCE is copied; its tenant policy is NOT (V366 did create one on
-- org_credit_allocation, `org_credit_allocation_tenant` — read 2026-09-16).
-- A future `grant … to app_user` lands on a table that is already sealed.
--
-- Differences from §6.1's DDL, each ACCEPTED by the owner on 2026-09-14
-- (ruling 5), each because a scope item was otherwise inert:
--   * `organizations(id)`, not `orgs(id)` — the table's real name here.
--   * org_stream_targets.watch_url — the destination's public watch URL an
--     organiser pastes when adding the destination; it is what the replay
--     fill (ruling F) copies into fixtures.stream_url on `completed`. Without
--     a column the producer can fill, that seam ships inert (AGENTS.md class 1).
--     Same floor CHECK as V401's stream_url; the real validator is
--     lib/stream-url.ts (R16) at the API.
--   * fixture_stream_sessions.runner_retries — the "ONE retry on a stale
--     heartbeat" (§6.4) needs a count that survives a restart; the domain
--     (server/relay/domain/session.ts) refuses a second retry, the CHECK below
--     refuses a negative, and the column is what makes both real.
--
-- Amended before merge by ORCHESTRATOR rulings on the Task 1 review
-- (2026-09-16, progress.md "Task 1 REVIEW" I2/I3) — not owner rulings:
--   * fixture_stream_sessions.fixture_id is NULLABLE, `on delete set null`
--     (§6.1: not null, on delete cascade). Fixtures ARE deleted in production:
--     directly (usecases/stages.ts delete + rebuild, history.ts) and through the
--     cascade from a deleted division or competition (divisions.ts,
--     competitions.ts). Under a cascade that delete either failed with a raw
--     23503 (a consume row in org_stream_credits still names the session) or
--     silently erased the session, its fixture_stream_inputs — the rows the
--     planned retention sweep (Task 12) reads to find the paid Cloudflare
--     live inputs it must delete — and
--     its append-only fixture_stream_events. With set null the MONEY (consume
--     rows), the RETAINED PAID RESOURCES (input rows) and the HISTORY (events)
--     all survive, and the admission snapshot below (sport_key, competition_id,
--     division_id, venue_id, …) keeps the context the fixture row carried.
--     fixture_stream_sessions_one_active is unaffected: nulls never collide.
--   * vcpu_seconds (§6.1) and fixture_stream_samples.duplicated_frames are NOT
--     created: neither has an R1 producer, and a `default 0` or an always-null
--     column reads as a measurement nobody took (the Task 0 rule below).
--
-- Task 0 data rulings (2026-09-14; _STATE.md "Owner data rulings at Task 0"):
-- the owner ruled telemetry retention ("2 is ok") and the non-personal
-- additions ("all"); the orchestrator — not the owner — narrowed their shapes
-- from a read-only Cloudflare probe and ruled PII. Every added column has a
-- named producer (plan §"Data captured"); a fact with no producer was dropped,
-- not left inert. Facts an existing column carries are reused, never copied.
-- The admission snapshot has NO foreign keys (it records what was true at
-- admission; fixture_id joins the live rows while the fixture exists, and is
-- set null when it is deleted) and is NOT NULL only where
-- its source is: divisions.sport_key and divisions.competition_id (not null,
-- V209__divisions.sql), fixtures.division_id (not null) and fixtures.scheduled_at
-- (null, V214__fixtures.sql), fixtures.court_id (null), courts.venue_id (not
-- null) and venues.address (null, V367__venues_and_courts.sql),
-- organizations.timezone (null, V305__org_timezone.sql).
--
-- FS10 — RULED 2026-09-14 ("all good"): balance_after with its `>= 0` CHECK is
-- §5.2's own DDL, built verbatim and KEPT. Consume rows are written under
-- `select … for update` (stream-credits.ts) after the pure `debit` in
-- server/relay/domain/credits.ts refused a negative in memory, so the CHECK is
-- the third floor under the same lock — the one a bug in the other two cannot
-- talk past.
--
-- M3 / owner ruling R-B: multi-camera is N INPUT ROWS under ONE session, never
-- N sessions — fixture_stream_sessions_one_active stays a true statement about
-- one broadcast per fixture, and credits stay per broadcast. R1 writes exactly
-- one row at slot 0 in the SAME transaction as the session insert and reads it
-- back by join. `check (slot >= 0)` is not decoration: it is the whole case
-- against an `inputs jsonb` column (no FK, no unique, no CHECK).
--
-- Both credential shapes are columns (C1 / ruling R-A): the v1 QR contract
-- carries SRT and RTMPS, and stream.liveInputs.create() returns both in one
-- response. The two *_enc columns take the same AES-256-GCM envelope
-- (server/relay/crypto.ts is the only module that touches a *_enc column;
-- enc-boundary.test.ts enumerates them from THIS file).

create table org_stream_targets (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  kind       text not null check (kind in ('youtube','facebook','twitch','kick','custom_rtmp')),
  label      text not null,
  rtmp_enc   bytea not null,                   -- AES-256-GCM envelope of the RTMPS url + key
  watch_url  text null check (watch_url is null or watch_url like 'https://%'),
  created_at timestamptz not null default now()
);
create index on org_stream_targets (org_id, created_at);

create table fixture_stream_sessions (
  id                   uuid primary key default gen_random_uuid(),
  -- NULL once the fixture is deleted: the session, its inputs, its events and its consume credit row outlive
  -- the fixture (money, retention of paid Cloudflare inputs, append-only history); the snapshot keeps the context.
  fixture_id           uuid null references fixtures(id) on delete set null,
  org_id               uuid not null references organizations(id) on delete cascade,
  mode                 text not null check (mode in ('passthrough','composed')),
  state                text not null check (state in ('requested','provisioning','warming','live','ending','completed','failed')),
  desired_state        text not null default 'live' check (desired_state in ('live','ending')),
  fail_reason          text null,
  theme_id             text null,
  overlay_delay_ms     integer not null default 0,
  target_id            uuid not null references org_stream_targets(id),
  machine_id           text null,               -- Fly Machine id (composed only)
  last_heartbeat       jsonb null,
  heartbeat_at         timestamptz null,
  started_at           timestamptz null,
  ended_at             timestamptz null,
  -- F22: when ENDING began. The ending backstop (domain/expiry.ts) measures from HERE, never from the
  -- wall clock: a session stopped at minute 5 of a 300-minute booking must not wait out its original
  -- deadline, which is the very stranding that backstop exists to end. Written in the SAME statement as
  -- the transition into 'ending' (Task 10's persist), exactly like state and end_reason.
  ending_at            timestamptz null,
  egress_bytes         bigint not null default 0,
  max_duration_minutes integer not null default 300,
  runner_retries       smallint not null default 0 check (runner_retries >= 0),
  -- The Fly machine lifecycle (plan §"Fly machine lifecycle"; domain/runner.ts).
  -- runner_state is the runner SUB-STATE of the aggregate; runner_name is the
  -- intended Machine name PERSISTED BEFORE the create call (invariant 4:
  -- crash-safe — a process dying mid-create is reconciled by name/metadata on
  -- the next read); runner_stop_requested_at starts the stop grace clock.
  runner_state         text not null default 'none' check (runner_state in ('none','creating','booting','playing','stopping','exited','destroyed','lost')),
  runner_name          text null,
  runner_stop_requested_at timestamptz null,
  -- How a COMPLETED session ended (a failed one carries fail_reason instead).
  end_reason           text null check (end_reason in ('stopped','max_duration')),
  -- Session FACTS (ruling 13, item 4). Set once by the usecase that learns them;
  -- the history of HOW they changed is fixture_stream_events. Every one is a
  -- fact the relay already holds in memory at some point and used to drop.
  provisioned_at       timestamptz null,       -- inputs created, QR issuable
  first_ingest_at      timestamptz null,       -- first 'connected' observation
  live_at              timestamptz null,       -- state -> live
  stop_requested_at    timestamptz null,       -- the ORGANISER's stop (runner_stop_requested_at is the Machine's grace clock)
  ingest_protocol      text null check (ingest_protocol in ('srt','rtmps')),
  destination_kind     text null,              -- copied from org_stream_targets.kind at admission (the target row may be edited later)
  ingest_input_uid     text null,              -- Cloudflare live input uid of slot 0 (non-secret; the keys stay *_enc on the input row)
  video_uids           text[] not null default '{}',   -- every recording uid Cloudflare produced for the input
  machine_region       text null,
  guest_cpus           smallint null,
  guest_memory_mb      integer null,
  guest_cpu_class      text null check (guest_cpu_class is null or guest_cpu_class in ('shared','dedicated')),   -- the PORT's vocabulary (RunnerSpec.guest.cpuClass); Fly's cpu_kind spelling stays in runner-fly.ts
  runner_attempts      smallint not null default 0 check (runner_attempts >= 0),  -- create calls made: the ONE authority Runner.attempt is loaded from (C3); runner_retries counts the RETRIES
  machine_seconds      integer not null default 0 check (machine_seconds >= 0),   -- wall seconds the Machine existed (created -> destroyed), summed over attempts
  recording_seconds    integer not null default 0 check (recording_seconds >= 0), -- Cloudflare's own duration of the recordings, summed
  storage_minutes_at_admission integer null,   -- the number the admission check saw
  reserved_minutes     integer null,            -- what this session reserved (C3)
  credit_ledger_id     uuid null,               -- the consume row (FK added after org_stream_credits below); the Stripe ids live on THAT row's purchase ancestor — one authority per fact
  sample_summary       jsonb null,              -- per-session aggregate written at the end (min/avg/max fps + bitrate, stall count, sample count) — survives sample retention (§"Data captured")
  -- Task 0 data rulings. The admission snapshot (Db; Task 10 createSession), no FKs:
  sport_key            text not null,          -- divisions.sport_key
  competition_id       uuid not null,          -- divisions.competition_id
  division_id          uuid not null,          -- fixtures.division_id
  fixture_scheduled_at timestamptz null,       -- fixtures.scheduled_at
  venue_id             uuid null,              -- courts.venue_id through fixtures.court_id; null when the fixture has no court
  venue_address        text null,              -- venues.address
  org_timezone         text null,              -- organizations.timezone
  -- Dc: `streaming.relay` granted by a live org_entitlement_overrides row at admission (overrideRow). NO default:
  -- a default would let a missing producer write a plausible value.
  entitlement_via_override boolean not null,
  -- Dd: Cloudflare's own byte size of the recordings, summed beside recording_seconds (0 = the sum of zero videos);
  -- the per-video facts are `recording_finalised` rows in fixture_stream_events.
  recording_bytes      bigint not null default 0 check (recording_bytes >= 0),
  -- De: the QR / paste code served (Task 11), first-at and count, under the session row lock.
  qr_issued_first_at   timestamptz null,
  credentials_revealed_first_at timestamptz null,
  credentials_reveal_count integer not null default 0 check (credentials_reveal_count >= 0),
  -- Df: the provider cost ESTIMATE, written once at the terminal transition from config.ts's rates.
  est_cost_minor       integer null check (est_cost_minor is null or est_cost_minor >= 0),
  est_cost_currency    text null check (est_cost_currency is null or est_cost_currency ~ '^[a-z]{3}$'),
  -- Dg: the slot-0 destination output's Cloudflare uid, beside ingest_input_uid (not a secret).
  output_uid           text null,
  created_by           uuid not null,
  created_at           timestamptz not null default now(),
  -- P1-F-b as a DATABASE fact: an end reason belongs to a session that is ending or
  -- already completed. A FAILED session carries fail_reason instead (domain `fail()`
  -- nulls endReason). Task 10's persist writes state and end_reason in ONE update, so
  -- the check only ever sees the finished row.
  constraint fixture_stream_sessions_end_reason_state
    check (end_reason is null or state in ('ending','completed'))
);
create unique index fixture_stream_sessions_one_active
  on fixture_stream_sessions (fixture_id)
  where state in ('requested','provisioning','warming','live','ending');
create index on fixture_stream_sessions (org_id, created_at);
create index on fixture_stream_sessions (state);

-- One broadcast, N ingest inputs, one Machine (M3 / owner ruling R-B).
create table fixture_stream_inputs (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid not null references fixture_stream_sessions(id) on delete cascade,
  slot                 smallint not null check (slot >= 0),
  ingest_input_id      text null,
  ingest_srt_url       text null,
  ingest_srt_key_enc   bytea null,        -- AES-256-GCM envelope (§6.2)
  ingest_rtmps_url     text null,         -- C1: §7.6's v1 payload carries BOTH shapes
  ingest_rtmps_key_enc bytea null,        -- same envelope discipline as the SRT key
  created_at           timestamptz not null default now(),
  unique (session_id, slot)
);

create table org_stream_credits (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  delta           integer not null check (delta <> 0),
  reason          text not null check (reason in ('purchase','consume','refund','grant','expire')),
  session_id      uuid null references fixture_stream_sessions(id),
  stripe_event_id text null unique,
  -- per-row snapshot + the oversell guard, copied from ai_credit_ledger (V320):
  -- the CHECK makes a consume that would overdraw fail in the transaction,
  -- so guard placement is enforced by the schema, not by a test.
  balance_after   integer not null check (balance_after >= 0),
  -- Purchase link (ruling 13, item 6): which checkout, which payment, which
  -- pack, how much — on the purchase row only; consume rows leave them null.
  stripe_checkout_session_id text null,
  stripe_payment_intent_id   text null,
  pack_key        text null,
  amount_minor    integer null check (amount_minor is null or amount_minor >= 0),
  currency        text null check (currency is null or currency ~ '^[a-z]{3}$'),
  note            text null,
  created_by      uuid null,
  created_at      timestamptz not null default now()
);
create index on org_stream_credits (org_id, created_at);
create index on org_stream_credits (stripe_checkout_session_id) where stripe_checkout_session_id is not null;
alter table fixture_stream_sessions
  add constraint fixture_stream_sessions_credit_ledger_fk
  foreign key (credit_ledger_id) references org_stream_credits(id);

-- ---------------------------------------------------------------------------
-- CAPTURE (ruling 13). Written beside the state, never instead of it.
-- ---------------------------------------------------------------------------

-- Every domain event, every state transition (session AND runner), every
-- observed external change, every effect result, every admin/webhook/client
-- action — one row each, in the SAME transaction as the state it records
-- (stream-sessions.ts `apply`), so this table can never disagree with the
-- session row. payload is ALLOWLIST-sanitised (server/relay/sanitise.ts)
-- before it is written; telemetry.test.ts pushes a known secret through every
-- writer and scans every row of every table here for it.
create table fixture_stream_events (
  id                  bigint generated always as identity primary key,
  session_id          uuid not null references fixture_stream_sessions(id) on delete cascade,
  org_id              uuid not null references organizations(id) on delete cascade,
  seq                 integer not null check (seq >= 1),   -- per session, assigned under the row lock
  occurred_at         timestamptz not null default now(),
  source              text not null check (source in ('domain','runner','ingest','output','sweep','webhook','admin','client')),
  kind                text not null check (kind in ('event','transition','runner_transition','observed','effect','action')),
  type                text not null,          -- the event / trigger / effect / action name, as the domain spells it
  from_state          text null,
  to_state            text null,
  result              text null check (result is null or result in ('ok','failed')),
  http_status         smallint null,
  latency_ms          integer null check (latency_ms is null or latency_ms >= 0),
  attempt             smallint null,
  provider_request_id text null,              -- fly-request-id / cf-ray: provider ids, not PII
  actor_user_id       uuid null,              -- a user id already stored (created_by on sessions and credits); NEVER an IP, user agent, device id or location (ORCH ruling at Task 0, not the owner's — §"Data captured")
  app_build_sha       text null,              -- Da: config.ts APP_BUILD_SHA (the FLY_IMAGE_REF tag when it is a 40-hex sha, else null)
  payload             jsonb not null default '{}'::jsonb,
  unique (session_id, seq)
);
create index on fixture_stream_events (session_id, occurred_at);
create index on fixture_stream_events (org_id, occurred_at);
-- Append-only. A direct UPDATE or DELETE raises (the trigger runs at
-- pg_trigger_depth() 1). A delete arriving through an FK CASCADE runs it at
-- depth > 1 and is allowed: a direct delete of the SESSION row, or of the
-- ORGANIZATION (both measured at depth 2, 2026-09-16). A fixture delete no
-- longer reaches this table — fixture_stream_sessions.fixture_id is set null.
-- Two holes this trigger does not close: a delete issued from inside any
-- other trigger also runs at depth > 1, and TRUNCATE fires no row trigger.
create function fixture_stream_events_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'fixture_stream_events is append-only' using errcode = '23001';
end $$;
create trigger fixture_stream_events_immutable
  before update or delete on fixture_stream_events
  for each row execute function fixture_stream_events_immutable();

-- One row per heartbeat and per organiser poll: what the ingest, the output
-- and the runner looked like at that instant. Typed where the shape is known
-- (§7.6's heartbeat), raw jsonb for the rest — sanitised like payload above.
-- Capped per session in the writer (config.ts SAMPLES_PER_SESSION_CAP), never
-- here: a CHECK cannot count. Retention is RULED (owner at Task 0, "2 is
-- ok"): the daily sweep deletes raw rows older than config.ts
-- SAMPLE_RETENTION_DAYS (90), only for sessions whose sample_summary is written.
create table fixture_stream_samples (
  id                bigint generated always as identity primary key,
  session_id        uuid not null references fixture_stream_sessions(id) on delete cascade,
  sampled_at        timestamptz not null default now(),
  source            text not null check (source in ('heartbeat','poll')),
  ingest_state      text null,                -- Cloudflare's live input status word, verbatim
  bitrate_kbps      integer null,
  fps               real null,
  dropped_frames    integer null,
  output_state      text null,                -- the destination output's status word, verbatim
  runner_cpu_pct    real null,
  runner_mem_mb     integer null,
  encoder_speed     real null,                -- ffmpeg's speed= (1.0 = real time)
  ingest_reason     text null,                -- Dh: Cloudflare's status.current.reason, verbatim
  app_build_sha     text null,                -- Da: config.ts APP_BUILD_SHA
  raw               jsonb not null default '{}'::jsonb
);
create index on fixture_stream_samples (session_id, sampled_at);

-- Every outbound provider call, every attempt: Cloudflare (Task 4), Fly
-- (Task 5A), Stripe (Task 8's checkout create). path_template carries `{uid}`
-- placeholders, never an id, never a query string — the two CHECKs below are
-- the floor under the recorder's own redaction.
create table stream_provider_calls (
  id                  bigint generated always as identity primary key,
  session_id          uuid null references fixture_stream_sessions(id) on delete set null,
  provider            text not null check (provider in ('cloudflare','fly','stripe')),
  operation           text not null,          -- the adapter method name (createLiveInput, createMachine, ...)
  subject_id          text null,              -- the input uid / machine id the call was ABOUT (a provider id, joinable to fixture_stream_sessions.ingest_input_uid / machine_id)
  method              text not null check (method in ('GET','POST','PUT','PATCH','DELETE')),
  path_template       text not null check (path_template not like '%?%' and path_template !~ '[0-9a-f]{8}-[0-9a-f]{4}-' and path_template !~ '/[0-9a-f]{12,}(/|$)'),
  status              smallint null,          -- null = no response (timeout / network)
  latency_ms          integer not null check (latency_ms >= 0),
  attempt             smallint not null default 1 check (attempt >= 1),
  retry_reason        text null,              -- 'status_429' | 'status_5xx' | 'timeout' | 'network' | null
  retry_after_seconds integer null,
  request_id          text null,              -- fly-request-id / cf-ray / stripe request-id
  error_code          text null,              -- the provider's own error code, never its message body
  called_at           timestamptz not null default now()
);
create index on stream_provider_calls (session_id, called_at);
create index on stream_provider_calls (provider, called_at);

-- What the storage picture looked like each time anyone measured it: every
-- daily sweep run and every admission check (C3's reservation arithmetic).
create table stream_storage_snapshots (
  id               bigint generated always as identity primary key,
  taken_at         timestamptz not null default now(),
  source           text not null check (source in ('sweep','admission')),
  session_id       uuid null references fixture_stream_sessions(id) on delete set null,   -- admission only
  used_minutes     integer not null check (used_minutes >= 0),
  limit_minutes    integer not null check (limit_minutes >= 0),
  reserved_minutes integer not null check (reserved_minutes >= 0),
  headroom_minutes integer not null check (headroom_minutes = limit_minutes - used_minutes - reserved_minutes),
  videos_deleted   integer not null default 0 check (videos_deleted >= 0),
  inputs_deleted   integer not null default 0 check (inputs_deleted >= 0),
  deferred         integer not null default 0 check (deferred >= 0)   -- kept because still inside CLOUDFLARE_RETENTION_RANGE.min / referenced by a live session
);
create index on stream_storage_snapshots (taken_at);

alter table org_stream_targets        enable row level security;
alter table org_stream_targets        force  row level security;
alter table fixture_stream_sessions   enable row level security;
alter table fixture_stream_sessions   force  row level security;
alter table fixture_stream_inputs     enable row level security;
alter table fixture_stream_inputs     force  row level security;
alter table org_stream_credits        enable row level security;
alter table org_stream_credits        force  row level security;
alter table fixture_stream_events     enable row level security;
alter table fixture_stream_events     force  row level security;
alter table fixture_stream_samples    enable row level security;
alter table fixture_stream_samples    force  row level security;
alter table stream_provider_calls     enable row level security;
alter table stream_provider_calls     force  row level security;
alter table stream_storage_snapshots  enable row level security;
alter table stream_storage_snapshots  force  row level security;
