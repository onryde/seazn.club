-- V465 — the arbiter can add time to a board's check-in while it is still open (spec 2026-10-09 §3.2.2; owner-approved
-- 2026-10-19, "yes build both": per board, and for a whole round).
--
-- Renumber at merge if main has moved past (V464 is another branch's; flyway.toml sets no outOfOrder). Purely additive: a row
-- that exists when this lands reads 0 extensions and behaves exactly as it did.
--
-- 1. `fixture_external_play.checkin_extra_ms` / `checkin_extensions` — the BOARD's extension. The board's window is
--    `T_batch + DEADLINE_AFTER_MS + checkin_extra_ms` (window.ts `windowFor`, the only place the deadline is computed), so
--    this is read by every reader of the window through the one anchor (`boardAnchor`'s fourth argument).
--
--    Why on the bridge row and not `stage_round_opens`: the extension is PER BOARD (a board whose players are stuck gets
--    time; its neighbours do not), and the bridge row is the board's own row that the sweep's candidate queries, the room's
--    reader (`boardOpenFor`) and the arbiter's board list already join. Why a stored MILLISECOND count beside the count of
--    presses: the deadline a player was told must not move if the step constant is ever retuned (the same reasoning that
--    stores `stage_round_opens.staggered`), and the count is what the cap (`CHECKIN_EXTEND_MAX`, in code) is judged on.
--
--    The cap itself is NOT a CHECK here: it is a product constant (window.ts), and a constant retuned in code must not need
--    a migration. What the schema does hold is coherence: the two columns are non-negative and zero together, so a count
--    without time (or time without a count) can never be written.
alter table fixture_external_play
  add column checkin_extra_ms   integer  not null default 0,
  add column checkin_extensions smallint not null default 0,
  add constraint fixture_external_play_checkin_extend_check check (
    checkin_extra_ms >= 0
    and checkin_extensions >= 0
    and (checkin_extensions = 0) = (checkin_extra_ms = 0)
  );

-- 2. The audit trail. `online_chess_audit` is the repo's record of an organiser's act on one board (V451: the human record of
--    WHO and WHY, `kind` demanded per kind by the shape check). An extension is exactly that, so it gets a kind here rather
--    than a second log: `checkin_extend`, one row per board extended (a round-wide press writes one per board), `note` the
--    machine-readable who/where/when (scope, the board's new count and deadline).
--    The two checks are re-declared under their own names (V451's names), so the existing refusals (an unknown kind by the
--    kind check; a kind that needs a fixture by the shape check) read the same.
alter table online_chess_audit drop constraint online_chess_audit_kind_check;
alter table online_chess_audit drop constraint online_chess_audit_shape_check;
alter table online_chess_audit
  add constraint online_chess_audit_kind_check check (kind in ('video_override', 'checkin_extend')),
  add constraint online_chess_audit_shape_check check (
    case kind
      when 'video_override' then fixture_id is not null
      when 'checkin_extend' then fixture_id is not null
      else false
    end
  );
