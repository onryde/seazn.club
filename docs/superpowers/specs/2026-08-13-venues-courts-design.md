# Venues & courts as entities — design (D5)

Date: 2026-08-13. Status: **approved design, creative-only** — build not
scheduled; owner green-light required; **build after the release-2 C-chain
lands** (shared `build.ts`/`schedule.ts` surfaces). Origin: bench spec §14
item 5. Sessions: P8 (schema+API+org UI), P9 (scheduler integration +
stored-config migration), P10 (calendars) in the portfolio index.

## Purpose

Courts are config-level strings and `tournaments.venue` is free text
(V109) — no reuse across competitions, no availability, no filtering.
Owner rulings (2026-08-13): full v1 = entities + schedule integration +
**tags** (owner's suggestion, replacing typed attribute columns) +
**availability calendars in v1** (not deferred).

## Design

### Data (P8)

```sql
venues(id uuid pk, org_id fk, name text, address text null,
       sort int, created_at)
courts(id uuid pk, venue_id fk, name text, sort int,
       tags text[] not null default '{}')
court_hours(court_id fk, weekday int 0-6, open_min int, close_min int,
            pk(court_id, weekday, open_min))          -- multiple ranges/day
court_exceptions(court_id fk, date date, closed bool,
                 open_min int null, close_min int null,
                 pk(court_id, date))                  -- override wins
```

Greenfield stance (RULES.md): correct schema over compatibility.
`fixtures.court_id uuid null fk` replaces `court_label`/`venue` text as
the write model; a read-side label stays derived. Divisions/stages gain
`required_court_tags text[]` (empty = any court).

### Stored-config migration (P9 — the read-path trap, handled)

`ScheduleConfig` is the READ path — stored rows with court name strings
must not 500 (memory: a refine there 500'd stored rows). Migration:

1. For each org, collect distinct court strings across stored schedule
   configs → create one venue "Main venue" + one court per distinct
   string (name = string, no tags).
2. Rewrite stored configs' `courts[]` to the new court ids; rewrite
   `fixtures.court_label` matches to `court_id`.
3. Zod: `courts: z.array(CourtId)` — post-migration there is exactly one
   shape; the migration IS the compatibility strategy, not a tolerant
   union that lives forever.

### Scheduler integration (P9)

- `build.ts` maps court ids → solver indices (as it does strings today);
  **zero placement-proto change** — day/session windows are already
  pre-baked into `grid_slots` client-side, calendars just change how the
  lattice is computed.
- Tag filter: candidate courts for a stage = `tags ⊇ required_court_tags`.
  Empty candidate set = typed 422 `capacity.no_matching_court` BEFORE
  solving (feeds D2's card when both exist).
- `/validate` + the independent conflict codes become entity-aware
  (court double-booking keys on court_id).

### Calendars → lattice (P10)

Usable windows per court-day =
`court_hours[weekday]` overridden by `court_exceptions[date]`,
intersected with the schedule's `sessionWindows`, minus `blackouts`.
One pure function: `packages/engine/src/scheduling/court-windows.ts`
`usableWindows(court, dateRange, config): Window[]` — shared by lattice
build, `/validate`, D2 capacity input, and the future bench checker
(same one-function-both-sides rule as D2).

### UI (P8 org settings, P10 calendar editor)

Org settings → Venues: venue list → courts (name, sort, tags chip
editor); court calendar editor (weekly ranges + exception days —
mobile-first: per-day list, not a desktop-only grid). Schedule setup:
court multi-picker replaces free-text strings; division settings:
required-tags picker. Public fixture pages show venue/court names.
Full polish; 320/768/1280 screenshots; wide tables scroll in their own
container.

## Testing (all four)

- Unit: `usableWindows` (hours ∩ session − blackout, exception override,
  multi-range days, tz edges at DST via org tz — `settings.orgTz` is the
  governing clock, #448), tag subset filter.
- Regression: stored-config migration on a fixture of real stored shapes
  (string courts → ids, zero 500s on read); lattice byte-equivalence for
  a no-calendar org before/after (pure refactor proof).
- E2E: venue CRUD → tag a court → division requires tag → auto-schedule
  places only on tagged courts → validate green.
- Smoke: schedule end-to-end on an org with 2 venues, calendars, 1 tagged
  division.

## i18n

Venues/courts/tags UI copy, calendar editor, conflict/422 codes ×4.

## Dependencies & sequencing

P8 → P9 → P10 strictly. Gated on release-2 C-chain completion. D2/D3
consume outputs when present (additive input changes, both specs carry
the delta note). D1 templates may name suggested tags only (no venue data
in templates — venues are org-real, templates are format-abstract).
OpenAPI regen owed (venues/courts CRUD, config shape). Structured
logging: pino on CRUD + migration counts.

## Risks / re-pin

Every `court_label` reader must be enumerated by the plan's scout
(fixtures API, exports, public pages, e2e fixtures). `ScheduleConfig`
zod lines re-pinned post-C-chain. Migration is the riskiest step —
ships with a dry-run count report before rewrite.

## Non-goals

No typed capacity/surface columns (tags cover filtering; semantics wait
for a consumer), no booking/rental features, no cross-org venue sharing,
no travel-time modeling.
