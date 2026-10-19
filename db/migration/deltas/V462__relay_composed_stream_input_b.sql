-- V462 — Relay Release 2, R2004: a composed session publishes to its own Cloudflare input (compositor plan 2026-10-14,
-- task R2004; overlay templates spec 2026-10-15 §4.4 and §6).
--
-- A composed session has TWO live inputs. Input A is the camera, as today: the phone publishes to it and the compositor
-- reads it over SRT playback. Input B is the programme: the compositor publishes the composed picture to it, and the
-- destination output attaches to B. The destination key therefore never reaches the Machine.
--
-- 1. `fixture_stream_inputs.role` says which input a row is. Every row written before this migration is a camera input
--    (the column default), so a passthrough session is unchanged: one row, role `camera`, slot 0. The unique key widens
--    from (session_id, slot) to (session_id, role, slot), amended in place (greenfield stance), so a composed session can
--    hold camera slot 0 AND programme slot 0, and a second camera slot 0 is still refused.
-- 2. `playback_srt_url` / `playback_srt_key_enc`: Input A's SRT PLAYBACK credential, which the compositor reads the camera
--    with. It mirrors the SRT ingest pair exactly: the url is stored bare and `{ passphrase, streamId }` is sealed together
--    (server/relay/secret-columns.ts is the only code that names the sealed column). Written for a composed session's
--    camera row only.
-- 3. `recordings_deleted_at` (owner ruling 2026-10-18, option (a)): BOTH inputs of a composed session record. A keeps
--    recording because Cloudflare serves an input's HLS only while its recording mode is `automatic`, and the phone's
--    delivery watch reads A's HLS (capture descriptor `playbackUrl`). B's recording is the product (the VOD with the
--    score bug). A's recording is deleted at the first daily sweep after the session ends, and this column records that
--    it is done, so a second sweep asks the provider nothing. It is a CAMERA fact only: the programme's recording is
--    never deleted early, and the CHECK holds that against any writer.
-- 4. `fixture_stream_settings.overlay_delay_ms`: the organiser's overlay delay for the fixture. null means "use the
--    default" (config.ts RELAY_OVERLAY_DELAY_DEFAULT_MS), and 0 is a real override. A composed create copies the
--    EFFECTIVE value into fixture_stream_sessions.overlay_delay_ms (V410), so a running session never moves.
-- 5. `fixture_stream_settings.overlay_template`: the organiser's overlay template choice. NO check constraint: templates
--    live in code (components/overlay/template-registry.ts OVERLAY_TEMPLATES), and a stored id that is later retired or
--    removed must still read, then resolve. null means the sport default. Every create copies the choice into
--    fixture_stream_sessions.theme_id (V410). R2006 is the writer.
alter table fixture_stream_inputs
  add column role                  text not null default 'camera' check (role in ('camera', 'programme')),
  add column playback_srt_url      text null,
  add column playback_srt_key_enc  bytea null,       -- AES-256-GCM envelope (§6.2), the ingest SRT key's discipline
  add column recordings_deleted_at timestamptz null,
  add constraint fixture_stream_inputs_recordings_deleted_camera_only
    check (recordings_deleted_at is null or role = 'camera');
alter table fixture_stream_inputs drop constraint fixture_stream_inputs_session_id_slot_key;
alter table fixture_stream_inputs add constraint fixture_stream_inputs_session_id_role_slot_key unique (session_id, role, slot);

alter table fixture_stream_settings
  add column overlay_delay_ms integer null check (overlay_delay_ms between 0 and 30000),
  add column overlay_template text null;
