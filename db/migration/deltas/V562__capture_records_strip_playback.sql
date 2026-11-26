-- V562 — a playback address is never stored (owner ruling 2026-11-26, "fix it"): strip it from the capture records already
-- stored. Pairs with the server's strip at ingest (relay/domain/capture-record.ts drops the `playbackUrl` key;
-- relay/record-playback-scrub.ts drops or masks a Cloudflare Stream playback ADDRESS wherever the allow-list admits one),
-- which keeps NEW records clean; this is the backfill for the rows written before it (stg R-Q4S2 and its siblings).
--
-- A Cloudflare Stream playback address holds its credential as the first PATH segment (a signed token, or an unsigned input's
-- uid), so the rule is on the address, not only the key — the same shape as scrub-score-url.ts's STREAM_PLAYBACK_PATH:
--   1. the `playbackUrl` field is removed from every line that has one;
--   2. a `url` or `overlayUrl` field whose value holds such an address is removed;
--   3. in any other string (free text: `message`, `problems`) the credential segment becomes `***` (the scrub's own mask).
-- Each line is edited as TEXT, never re-serialised through jsonb (which would reorder keys and respace the line), so a line
-- with none of the above is byte for byte what it was and every other field of a changed line is untouched. A line is kept
-- whole: `received_lines`, `kept_lines`, `dropped_lines` and `invalid_lines` and `body_bytes` are not written.
--
-- Idempotent: after one run no line holds the key or a bare address (a masked segment re-reads as `***`, which a second pass
-- masks to `***` again), so a second run finds no line to change and writes nothing. Loud: it announces the rows and lines it
-- changed. It refuses (raises, rolling the delta back) if an edited line is no longer a JSON object with a `kind`.
--
-- RLS: unchanged — capture_records keeps V437's enable + force with no policy; the migrating role is not the app role. No
-- table, policy or grant is created here.
do $$
declare
  n_rows  integer;
  n_lines integer;
  n_bad   integer;
begin
  drop table if exists v562_capture_lines;
  create temp table v562_capture_lines on commit drop as
    with src as (
      select r.id, l.ord, l.line as old_line
        from capture_records r
        cross join lateral unnest(string_to_array(r.lines, E'\n')) with ordinality as l(line, ord)
       -- only a row that can hold either shape is read at all
       where r.lines like '%playbackUrl%' or r.lines like '%cloudflarestream.com%'
    ), s1 as (
      -- 1. the playbackUrl key: with its leading comma, or (first key) its trailing one. A JSON string cannot hold an unescaped
      --    quote, so `,"playbackUrl":"` outside a string is a key.
      select id, ord, old_line,
             regexp_replace(
               regexp_replace(old_line, ',"playbackUrl":"(?:[^"\\]|\\.)*"', '', 'g'),
               '"playbackUrl":"(?:[^"\\]|\\.)*",', '', 'g') as t
        from src
    ), s2 as (
      -- 2. a url / overlayUrl field holding a Cloudflare playback address (plain, or URL-encoded inside another URL)
      select id, ord, old_line,
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(t,
                     ',"(?:url|overlayUrl)":"(?=(?:[^"\\]|\\.)*\.cloudflarestream\.com(?::[0-9]+)?/[^/?#\s"''<>\\]+)(?:[^"\\]|\\.)*"', '', 'g'),
                   '"(?:url|overlayUrl)":"(?=(?:[^"\\]|\\.)*\.cloudflarestream\.com(?::[0-9]+)?/[^/?#\s"''<>\\]+)(?:[^"\\]|\\.)*",', '', 'g'),
                 ',"(?:url|overlayUrl)":"(?=(?:[^"\\]|\\.)*\.cloudflarestream\.com(?:%(?:25)*3[Aa][0-9]+)?%(?:25)*2[Ff][^%&/?#\s"''<>\\]+)(?:[^"\\]|\\.)*"', '', 'g'),
               '"(?:url|overlayUrl)":"(?=(?:[^"\\]|\\.)*\.cloudflarestream\.com(?:%(?:25)*3[Aa][0-9]+)?%(?:25)*2[Ff][^%&/?#\s"''<>\\]+)(?:[^"\\]|\\.)*",', '', 'g') as t
        from s1
    )
    -- 3. an address left in free text: the credential segment becomes the mask
    select id, ord, old_line,
           regexp_replace(
             regexp_replace(t, '(\.cloudflarestream\.com(?::[0-9]+)?/)[^/?#\s"''<>\\]+', '\1***', 'g'),
             '(\.cloudflarestream\.com(?:%(?:25)*3[Aa][0-9]+)?%(?:25)*2[Ff])[^%&/?#\s"''<>\\]+', '\1***', 'g') as new_line
      from s2;

  select count(*) into n_lines from v562_capture_lines where new_line <> old_line;
  -- The guard: an edited line is still one JSON object with a kind (the cast raises on anything else).
  select count(*) into n_bad from v562_capture_lines
   where new_line <> old_line and not (jsonb_typeof(new_line::jsonb) = 'object' and jsonb_exists(new_line::jsonb, 'kind'));
  if n_bad > 0 then
    raise exception 'V562: % edited capture line(s) are no longer a JSON object with a kind', n_bad;
  end if;

  update capture_records r
     set lines = c.new_lines
    from (select id, string_agg(new_line, E'\n' order by ord) as new_lines
            from v562_capture_lines
           group by id
          having bool_or(new_line <> old_line)) c
   where c.id = r.id;
  get diagnostics n_rows = row_count;

  raise notice 'V562 capture records: playback addresses stripped: rows=% lines=%', n_rows, n_lines;
end
$$;
