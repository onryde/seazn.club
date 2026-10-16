// The three video tables as they were BEFORE V459 (V451 + V454 + V457): one shared meeting per fixture. Used by the delta's
// own test (online-chess-video-schema.test.ts) and by the deploy script's (end-shared-meetings-script.test.ts), which must
// run against exactly this shape. Both put it in a SCRATCH schema ahead of the live one on the search path, with the
// referenced tables as STUBS in the scratch schema: a replica whose foreign keys named the live tables would take locks on
// them (SHARE ROW EXCLUSIVE as it is created, ACCESS EXCLUSIVE when the delta drops a constraint) and block, or deadlock,
// every other test file writing fixtures, organizations, persons or users.
export const OLD_SHAPE = `
  create table fixture_video_meetings (
    fixture_id uuid primary key references fixtures(id) on delete cascade,
    org_id     uuid not null references organizations(id) on delete cascade,
    provider   text not null default 'realtimekit' check (provider in ('realtimekit')),
    meeting_id text not null unique,
    home_entrant_id uuid not null,
    away_entrant_id uuid not null,
    created_at timestamptz not null default now(),
    ended_at   timestamptz null,
    camera_evidence_at timestamptz null,
    constraint fixture_video_meetings_camera_evidence_check check (camera_evidence_at is null or ended_at is not null)
  );
  create index fixture_video_meetings_org_idx on fixture_video_meetings (org_id);
  create table fixture_video_participants (
    id uuid primary key default gen_random_uuid(),
    fixture_id uuid not null references fixture_video_meetings(fixture_id) on delete cascade,
    person_id uuid null references persons(id) on delete set null,
    preset text not null check (preset in ('player', 'arbiter')),
    participant_id text not null,
    last_publisher_seen_at timestamptz null,
    created_at timestamptz not null default now(),
    unique (fixture_id, participant_id),
    user_id uuid null references users(id) on delete set null,
    removed_at timestamptz null,
    seat_read_at timestamptz null,
    seat_reads integer not null default 0 check (seat_reads >= 0),
    seat_read_state text null,
    seat_read_since timestamptz null,
    constraint fixture_video_participants_user_check check (user_id is null or preset = 'arbiter'),
    constraint fixture_video_participants_removed_check check (removed_at is null or preset = 'arbiter'),
    constraint fixture_video_participants_seat_read_check check (
      seat_reads > 0 or (seat_read_at is null and seat_read_state is null and seat_read_since is null)),
    constraint fixture_video_participants_seat_read_state_check check (
      (seat_read_state is null and seat_read_since is null)
      or (seat_read_state is not null and seat_read_state in ('starting', 'unreadable') and seat_read_since is not null))
  );
  create index fixture_video_participants_person_idx on fixture_video_participants (fixture_id, person_id);
  create index fixture_video_participants_arbiter_open_idx
    on fixture_video_participants (fixture_id) where preset = 'arbiter' and removed_at is null;
  create table fixture_video_guard_faults (
    id uuid primary key default gen_random_uuid(),
    fixture_id uuid not null references fixture_video_meetings(fixture_id) on delete cascade,
    person_id uuid not null references persons(id) on delete cascade,
    started_at timestamptz not null,
    ended_at timestamptz null,
    constraint fixture_video_guard_faults_interval_check check (ended_at is null or ended_at >= started_at)
  );
  create unique index fixture_video_guard_faults_open_idx
    on fixture_video_guard_faults (fixture_id, person_id) where ended_at is null;`;

/** The referenced tables as stubs inside the scratch schema, holding only the rows the caller seeds from. */
export function oldShapeStubs(live: string, a: { fixtureIds: readonly string[]; orgId: string; personId: string }): string {
  const ids = `'{${a.fixtureIds.join(",")}}'::uuid[]`;
  return `
    create table fixtures (id uuid primary key, home_entrant_id uuid, away_entrant_id uuid);
    create table organizations (id uuid primary key);
    create table persons (id uuid primary key);
    create table users (id uuid primary key);
    insert into fixtures select id, home_entrant_id, away_entrant_id from "${live}".fixtures where id = any(${ids});
    insert into organizations values ('${a.orgId}');
    insert into persons values ('${a.personId}');`;
}
