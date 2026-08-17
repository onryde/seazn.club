# Venues & courts as entities — design (D5)

Date: 2026-08-13. **Amended 2026-08-17 during the P8 session — read the
amendment log at the foot of this file before trusting any section; six
amendments (A1–A6) are corrected in place above it, and three of them
change the shipped product.** Status: approved design; release-2 C-chain
gate CLEARED (C7 `298da0af`, C8 `e9a7c54a`); P8 green-lit and in build
2026-08-17. Origin: bench spec §14 item 5. Sessions: P8 (schema + API +
**Directory** UI, incl. the calendar editor), P9 (scheduler integration +
stored-config migration), P10 (`usableWindows` + lattice) in the portfolio
index.

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
       sort int, archived_at timestamptz null, created_at,
       unique (id, org_id))                           -- A1: composite-FK anchor
courts(id uuid pk, venue_id fk, org_id uuid not null, name text, sort int,
       tags text[] not null default '{}',
       archived_at timestamptz null,
       foreign key (venue_id, org_id) references venues (id, org_id),
       unique (id, org_id),
       unique (venue_id, name) where archived_at is null)   -- A3: partial
court_hours(court_id fk, org_id uuid not null,
            weekday int 0-6, open_min int, close_min int,
            pk(court_id, weekday, open_min))          -- multiple ranges/day
court_exceptions(court_id fk, org_id uuid not null,
                 date date, closed bool,
                 open_min int null, close_min int null,
                 pk(court_id, date))                  -- override wins
```

Greenfield stance (RULES.md): correct schema over compatibility.
`fixtures.court_id uuid null fk` **`on delete restrict`** (A3) replaces
`court_label`/`venue` text as the write model; a read-side label stays
derived. Divisions/stages gain `required_court_tags text[]` (empty = any
court).

**`org_id` is denormalized onto all three child tables (A1)** — not for
query convenience but because `scripts/check-rls.ts` enumerates only
tables that have an `org_id` column. Without it, three tenant tables are
skipped by the RLS guard silently. The composite FKs above make an
`org_id` disagreeing with its parent unrepresentable.

### Removal, archival and unavailability (A3)

Three distinct situations, three mechanisms — see the amendment log:

| Situation | Behaviour |
|---|---|
| Court referenced by NO fixture | Hard delete allowed |
| Court referenced only by COMPLETED fixtures | Delete → 409 `court.in_use`; **archive** allowed |
| Court referenced by any UNPLAYED fixture | Delete → 409; **archive also → 409** — reassign first |
| Court out for a day / a week | `court_exceptions` row, NOT archive |

The archive gate keys on fixture **status** (unplayed vs completed), never
on fixture date: a date test needs an org-tz "now", drifts as the clock
moves, and wrongly clears a past-dated fixture that was never played but
still needs a court. Archived venues/courts drop out of list endpoints,
the court picker, and (P9) scheduling candidate sets.

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

### UI — Directory → Venues (P8, calendar editor included)

**Surface is `/directory?tab=venues` (A2), not org settings.** `directory/page.tsx`
states the governing principle in its own header: People and Clubs "are
org-wide entities, so they live behind one 'Directory' menu with a tab
each". Venues and courts meet that test — settings is for org
configuration, not entity registers. A fourth `TABS` entry, a `VenuesTab`
async server component beside `PlayersTab`/`ClubsTab`/`OfficialsTab`
(`requirePageAuth()` → `{ auth, canEdit }`), and a `"use client"`
`venues-panel.tsx` doing CRUD via `apiV1` — the `persons-panel.tsx` shape.
No server actions; this repo has none.

**The calendar editor ships in P8, not P10 (A4).** P10 owns only
`usableWindows` and its lattice consumption.

Venue list → courts (name, sort, tags chip editor); court calendar editor
(weekly ranges + exception days — mobile-first: per-day list, not a
desktop-only grid). Division settings: required-tags picker. Schedule
setup court multi-picker and public fixture pages showing venue/court
names are **P9**, after consumers switch. Full polish; 320/768/1280
screenshots; wide tables scroll in their own container. The route must be
added to `apps/web/e2e/mobile.spec.ts`'s console-routes array or the seven
width projects never see it.

Resolved UI details (A5), previously unspecified:

- **Archived rows**: "Show archived" toggle on the venue detail, off by
  default; archived rows greyed, with an Unarchive action. No separate screen.
- **Calendar drudgery**: a "copy this day to all days" action. Seven days ×
  multiple ranges hand-typed at 320px is otherwise punishing.
- **Tag suggestions**: the picker suggests tags already used elsewhere in the
  org, ranked by count. Free-form entry still allowed; no registry, no
  validation, no server cascade.
- **Court ordering**: `sort` via up/down buttons, not drag — touch drag at
  320px is a known trap and this control is rarely used.
- **Competition free-text `venue` is left alone in P8.** Until P9 switches
  consumers, an organiser sees both the Venues register and the unrelated
  free-text venue field. P8 ships no cross-reference and no copy implying
  one; P9 owns the switch. Accepted, one session of visible duplication.

### Advisory: closing a calendar under placed fixtures (A6)

A `closed: true` exception, or narrowed hours, can strand fixtures already
scheduled outside the new window. `PUT /courts/{id}/calendar` returns an
advisory count of fixtures on that court now falling outside its hours.
**P10 owes** the real conflict code for the stranded-fixture case, surfaced
through the same entity-aware `/validate` path that gains court
double-booking — the detector needs `usableWindows`, which does not exist
until then.

## `usableWindows` algorithm (normative)

For court c, date d (org-tz local), config g:

1. base = `court_exceptions[c,d]` if present (closed ⇒ ∅; else its
   range(s)) else `court_hours[c, weekday(d)]` ranges (may be multiple,
   non-overlapping — validated at write).
2. session = base ∩ g.sessionWindows (if declared, else base).
3. minus = session − g.blackouts where blackout.court ∈ {null, c} and
   blackout ∩ d ≠ ∅.
4. Result: maximal disjoint ordered windows, minute precision, tz-fixed
   at org tz — DST days use civil local times (a 23-hour day simply
   yields shorter windows; no UTC arithmetic anywhere).
   No calendars declared for c ⇒ step 1 base = the full day (status quo
   ante — calendars strictly subtract).

## API surface (P8)

`/api/v1/orgs/{orgId}/venues` GET/POST · `/venues/{id}` PATCH/DELETE ·
`/venues/{id}/courts` POST · `/courts/{id}` PATCH/DELETE (tags, sort,
name) · `/courts/{id}/calendar` PUT (full weekly hours + exceptions
replace — one write shape, no per-row PATCH surface). Deletion rules:
court with any fixture reference → 409 `court.in_use` (soft-block;
reassign first); venue with courts → 409 `venue.not_empty`. All routes
org-member ACL; mutations require admin role (same role gate as
schedule apply).

## Migration order (P9 — each step independently verifiable)

1. V-a: create tables + indexes (no readers).
2. V-b (data): per org — distinct court strings from stored configs ∪
   distinct `fixtures.court_label` → "Main venue" + courts; emit
   dry-run report `{org, strings, courtsCreated}` BEFORE writing;
   write mapping table in-migration (temp), rewrite stored configs'
   `courts[]` and `fixtures.court_id`; leave `court_label` populated
   (read-only legacy column until V-c).
3. Code switch (same PR): zod `courts: z.array(CourtId)`, readers on
   court_id, writers stop touching court_label.
4. V-c (later PR, after a green soak): drop `court_label` + `venue`
   text columns. Greenfield allows aggressive timing; the two-step
   still ships the byte-equivalence regression between them.

## Tag semantics

Free-form lowercase slugs, org-scoped vocabulary (no global registry);
`required_court_tags` matches by ⊇ (court must carry ALL required);
empty required = every court. Tag rename = PATCH over courts carrying
it (client-side bulk; no server cascade in v1). Suggested-tags from D1
templates are hints rendered in the picker, never auto-created.

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

## Amendment log — P8 session, 2026-08-17

Six amendments made while executing P8. All are corrected in place above;
this log exists so P9 and P10 can see what changed and why, rather than
re-deriving the original answer. Owner-ratified unless marked otherwise.

- **A1 — `org_id` denormalized onto `courts`, `court_hours`,
  `court_exceptions`.** The original DDL gave them none.
  `scripts/check-rls.ts:40-52` enumerates only tables that HAVE an `org_id`
  column, so the DDL as written shipped three tenant tables the RLS guard
  skips **silently**. `V201__v2_role_and_current_org_id.sql:13` names the
  repo's proven pattern as "filled `org_id` + a direct RLS policy
  `org_id = current_org_id()`". Consistency enforced by composite FK to
  `venues (id, org_id)` / `courts (id, org_id)`, not by convention.

- **A2 — the UI lives in the Directory, not org settings.** Original text
  said "Org settings → Venues". `apps/web/src/app/directory/page.tsx:2-5`
  already states the rule that decides this. Withdrawn as a result: a
  `settings/venues/page.tsx`, a `routes.settings.venues` helper, and a
  settings `NAV_ITEMS` entry — an earlier P8 plan proposed all three.

- **A3 — removal is delete-OR-archive, not one permanent 409.** Original
  rule was "court with any fixture reference → 409 `court.in_use`
  (soft-block; reassign first)", which is app-side only and has no end
  state: a club that permanently loses a hall can never remove the court,
  because history references it forever, so pickers accumulate dead courts.
  Adds `archived_at` (precedent `V261__division_archive.sql:5`), a partial
  unique index so a name frees up after archiving (V261:9), and
  `on delete restrict` on `fixtures.court_id` (precedent
  `V299__sponsor_order_delete_restrict.sql:12`) so the 409 is a DDL
  guarantee rather than a check a future call site can forget.
  The archive gate keys on fixture **status**, not date — see the table above.

- **A4 — the calendar editor is P8's, not P10's.** The original UI heading
  said "(P8 org settings, P10 calendar editor)" while P8's own prompt put the
  `court_hours`/`court_exceptions` tables, the `PUT /courts/{id}/calendar`
  route and the editor in P8 scope and acceptance criteria. The prompt wins;
  P10 keeps `usableWindows` and lattice consumption only.

- **A5 — five UI behaviours specified** that were previously unstated and
  would otherwise be invented per-implementer: archived-row disclosure,
  copy-day-to-all-days, tag suggestions from org usage, up/down ordering
  instead of drag, and leaving competition free-text `venue` untouched
  in P8.

- **A6 — closing a calendar under placed fixtures is advisory in P8**, with
  the real conflict code owed to P10. Previously unaddressed entirely.

**Also owed to P10 by this session:** the stranded-fixture conflict code
(A6). **Owed to P9:** exclude archived venues/courts from scheduling
candidate sets (A3), and the competition free-text `venue` switch (A5).
