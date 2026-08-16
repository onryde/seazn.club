# RS009 — free-agent assignment

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
— **first check RS005's close note**: if it ruled this folds into a light
follow-up, this session runs small; either way the scope below is the
contract. Org-panel session — load `frontend-design:frontend-design`.

Branch `feat/rs009-free-agents` in a fresh worktree. One PR.
Design: `../2026-08-16-registration-redesign-design.md` §4 (free-agent
entries), §5 (assign action), §6 (materialization of assigned agents).

## Why

Free agents (individuals in a team division, RS002/RS006) currently pool with
no exit: nobody can put them on a team. This session ships the organiser's
assignment loop and the registrant-facing result.

## Scope

1. **Assign usecase** (`registrations.ts` family): assign free-agent
   registration → target team entry in the same division. Target set: team
   registrations (pre-materialization → adds a `registration_players` row,
   source `captain_entered`-equivalent `organiser_assigned` — add the enum
   value if RS002 didn't) OR materialized entrants (→ `entrant_members`
   insert + person get-or-create, same path as RS002 materialization).
   Unassign (before the division starts) reverses it. Eligibility re-checked
   against the target (mixed composition may now fail — block with the
   reason). Idempotent; structured-logged.
2. **Hub UI** (Registrants tab): free-agent rows get "Assign to team" →
   picker of that division's team entries showing fill `5/7` and a
   composition hint for mixed; assign/unassign with optimistic update.
   Free-agent filter chip shows pool size per division.
3. **Registrant visibility**: status page (RS007) shows "assigned to Team A"
   on the free agent's entry; a consent-pending assigned player follows the
   normal RS008 claim path.
4. **Edge**: division with `allow_free_agents` toggled OFF after pool
   exists — pool remains actionable (assignment allowed), new entries
   blocked (RS002 already blocks; assert).

## Acceptance criteria

- [ ] E2E: free agent registers (public) → hub shows pool → assign to team →
      roster fill +1, status page reflects it; unassign reverses
- [ ] Assign onto a mixed team that would break composition → blocked with
      reason; onto a full roster → blocked
- [ ] Assign to a MATERIALIZED entrant → `entrant_members` row appears,
      person created via the one true path (no forked insert)
- [ ] Unassign after division start → refused (started divisions are
      scheduling's territory)
- [ ] ×4 locales; screenshots 1280/320 of the picker; matrix coverage holds
- [ ] Counts from JSON reporter; `tsc EXIT=0`; lint clean; drift gates clean

### Test types

- **Unit** — assign/unassign transitions, composition re-check, idempotency.
- **E2E** — the loop above. **Smoke** — deferred RS010.
- **Regression** — no forked person-creation path; started-division refusal.

## Gotchas

- Two writers, one target roster: assignment races join (RS007) on the same
  cap — take the same row-lock the join path takes; a lost race must fail
  clean, not overfill.
- `entrant_members` PK is (entrant_id, person_id) — double-assign of the
  same person must read as idempotent, not error.
- The picker at 320px: it's a list-in-a-drawer, not a table.

## Execution

Scout: RS002 materialization internals + join path locking, RS005 row-action
plumbing. One implementer loop; reviewer focus: race with join, forked
writes, refusal edges.

## On close

`_INDEX.md`: RS009 → DONE + PR#, `organiser_assigned` enum verdict, race
strategy recorded. Memory + snapshot.
