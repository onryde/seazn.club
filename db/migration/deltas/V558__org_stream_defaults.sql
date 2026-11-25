-- V558 — the club's default Score style and Score timing (Seazn-hosted video, Phase 4, Task 38). V554 to V556 are the realtime
-- branch's; V557 and V559 (once V553) are this branch's. The tests find this file by name, never by number.
--
-- A club sets the look of the score on its video ONCE, on the Streaming page, and every new stream starts with it. One row per
-- organisation, made by its first save; no row is the same as a row of two nulls: "nothing set here".
--
-- `overlay_template` is the club's style (a template id, the fixture's `fixture_stream_settings.overlay_template` one level up).
-- NO check constraint, for V462's reason: templates live in code (components/overlay/template-registry.ts), and an id that is later
-- retired or removed must still read, then resolve (resolveTemplate) — never an error under a running stream.
-- `overlay_delay_ms` is the club's Score timing, whole ms, V462's bound. null = "no club timing": the server's default.
--
-- The chain a session copies at its start (usecases/stream-sessions/start.ts), and never moves afterwards:
--   style:  the match's own choice, else the club's, else the sport's default;
--   timing: the match's own, else the club's, else the default — except a COURT session, which ignores the club's timing
--           (its own default is 0 s, relay/config.ts COURT_PHONE_OVERLAY_DELAY_MS) and takes the club's style like any other.
--
-- `revision` (V466's rule): every write bumps it under the row lock, so the Streaming page orders a read against a save it has
-- already seen settle. An insert writes 1; a row never read reads null (the page's "older than any write").
--
-- RLS (V430's pattern, ruling R1): ENABLE + FORCE, NO policy, NO trg_set_org, NO grant to app_user. Every read and write goes
-- through the app's non-tenant client, and the use-case writes org_id from the authorised org. The name joins the stream fold, so
-- rls-static.test.ts holds the two alter lines below.
create table org_stream_defaults (
  org_id           uuid primary key references organizations(id) on delete cascade,
  overlay_template text null,
  overlay_delay_ms integer null check (overlay_delay_ms between 0 and 30000),
  revision         bigint not null default 1,
  updated_by       uuid null,
  updated_at       timestamptz not null default now()
);
alter table org_stream_defaults enable row level security;
alter table org_stream_defaults force  row level security;
