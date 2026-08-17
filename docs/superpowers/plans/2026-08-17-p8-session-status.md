# P8 (D5a) — venues & courts: schema + API + org UI — session status

Branch `feat/p8-venues-schema-ui`, worktree `.claude/worktrees/p8-venues`, off
`51ab77a8`. Prompt: `../specs/bench-product-value/portfolio-prompts/P08-venues-schema-ui.md`.
Spec: `../specs/bench-product-value/designs/2026-08-13-venues-courts-design.md`.
Rules: `portfolio-prompts/_RULES.md` + `docs/superpowers/RULES.md`.

## Gate

Both hard gates cleared before start:

- **release-2 C-chain DONE** — C6 `252a073d` (#588), C7 `298da0af` (#590),
  C8 `e9a7c54a` (#591), coverage close `0ccd2665` (#594). z3 is gone.
- P7 merged `98e95c9e` (#582). Owner green-light given 2026-08-17.

## Environment

- Postgres label `p8venues`, port **54765**, schema at **v366** (`db:apply` +
  `sync:sports` both run).
- Placement service on **:50325**, secret `dev-secret`, started BY HAND after
  `seazn-env up --placement` lost the first-run venv race. It is therefore NOT
  tracked by `seazn-env down --label p8venues` — kill it explicitly at close
  (`lsof -t -i :50325 -sTCP:LISTEN | xargs kill`).
- `readlink -f node_modules/@seazn/engine` resolves inside the worktree.

## Scout re-pin (step zero) — corrections to the prompt/spec

| Prompt/spec claim | Truth on `main` at 51ab77a8 |
|---|---|
| next free `V<n>` (prompt says re-verify) | **V367**; ceiling is `V366__rls_billing_org_tables.sql`, all deltas live in `db/migration/deltas/` |
| — | Org-resource copy target: `apps/web/src/server/usecases/sponsors.ts` + `apps/web/src/app/api/v1/orgs/[id]/sponsors/route.ts` |
| — | Membership gate: `requireOrgAuth(req, orgId, scope)` — `apps/web/src/server/api-v1/auth.ts:201`; 403 not 401; `EDITOR_ROLES`/`READ_ROLES` |
| — | RLS policy shape: `db/migration/deltas/V283__sponsor_crm.sql:29` |
| `node scripts/check-rls.ts` | `npm run check:rls` (package.json:43) |
| — | Key scopes: `apps/web/src/server/api-v1/key-scopes.ts`; sponsors pair is `read` / `manage` |
| — | OpenAPI: manual entries in `apps/web/src/server/api-v1/openapi.ts` (~:142 for sponsors), tag list ~:605; regen `npm run openapi:gen` |
| 4 dictionary **files** | 4 dictionary **directories**: `apps/web/src/dictionaries/{en,es,fr,nl}/{common,console,emails,errors,marketing,metadata,public,ui}.json`, flat dotted keys |
| — | pino: `apps/web/src/server/logger.ts:16` (`export const log`); example call `usecases/org-posts.ts:620` |
| — | Division settings form `apps/web/src/components/v2/division-settings.tsx`; patcher `usecases/divisions.ts:523` |
| — | Org settings hub `apps/web/src/app/o/[orgSlug]/settings/page.tsx` (tabs via `routes.orgSettings`); closest structural template `settings/add-ons/page.tsx` |
| — | **No `venues`/`courts` table, column or route exists.** Only `fixtures.court_label` (text) and free-text venue helpers (`apps/web/src/lib/venue.ts`). Zero name collision. |

## Rulings made this session

1. **`org_id` is denormalized onto `courts`, `court_hours` and
   `court_exceptions`** — a deliberate deviation from the spec's DDL, which
   gives those three no `org_id`. `scripts/check-rls.ts:40-52` enumerates only
   tables that HAVE an `org_id` column, so the spec's literal DDL ships three
   tenant tables the RLS guard skips **silently** — the same shape as the
   earlier "RLS guard checked zero tables" finding. `V201__v2_role_and_current_org_id.sql:13`
   names the repo's own proven pattern as "filled `org_id` + a direct RLS
   policy `org_id = current_org_id()`". Consistency is enforced in DDL, not by
   convention: `venues` gets `unique (id, org_id)` and each child carries a
   composite FK `(parent_id, org_id) references parent (id, org_id) on delete cascade`,
   which makes an org_id that disagrees with its parent unrepresentable.

2. **The calendar editor ships in P8, not P10.** The spec's UI section labels
   it "(P8 org settings, P10 calendar editor)", but P8's prompt puts the
   `court_hours`/`court_exceptions` tables, the `PUT /courts/{id}/calendar`
   route AND the editor in P8's scope and acceptance criteria ("weekly hours +
   one exception → survives reload", "calendar editor especially at 320").
   P10 owns only the `usableWindows` compiler and its lattice consumption.
   The prompt wins; recorded so P10 does not re-derive it.

3. **Venues live in the Directory, not in org settings** (owner ruling,
   2026-08-17). Both the spec ("Org settings → Venues") and P8's prompt
   ("Org settings → Venues UI") place this surface under settings. Overridden:
   `apps/web/src/app/directory/page.tsx:2-5` states the governing principle in
   its own header — People and Clubs "are org-wide entities, so they live
   behind one 'Directory' menu with a tab each". Venues and courts meet that
   test; org settings is for org configuration, not for org-wide entity
   registers. Concretely:

   - Surface is `/directory?tab=venues`; add `"venues"` to the `TABS` tuple at
     `directory/page.tsx:24`, and a `VenuesTab` async server component beside
     `PlayersTab`/`ClubsTab`/`OfficialsTab` (each calls
     `requirePageAuth()` → `{ auth, canEdit }` and passes `canEdit` down).
   - Client panel `apps/web/src/components/v2/venues-panel.tsx`, mirroring
     `persons-panel.tsx` (410 lines) / `clubs-teams-list.tsx` (303) — `"use client"`,
     CRUD via `apiV1`, no server actions (there are none in this repo).
   - i18n: `directory.tab.venues` plus a `venues.*` namespace in
     `dictionaries/*/ui.json`, ×4 locales.
   - **NOT built:** `settings/venues/page.tsx`, a `routes.settings.venues`
     helper, or a settings `NAV_ITEMS` entry. An earlier plan in this session
     proposed exactly those; they are withdrawn.
   - The division `required_court_tags` picker is unaffected — it stays in
     `components/v2/division-settings.tsx`.
   - e2e width coverage: the new route goes in `apps/web/e2e/mobile.spec.ts`'s
     console-routes array (~:155) or the seven width projects never see it.

4. **Court removal is delete-OR-archive, and unavailability is a calendar
   exception — three cases, not one** (owner ruling, 2026-08-17). The spec and
   prompt define exactly one rule: court with any fixture reference → 409
   `court.in_use`, "soft-block; reassign first". That is app-side only and has
   no end state — a club that permanently loses a hall can never remove the
   court, because history references it forever, so pickers accumulate dead
   courts.

   | Situation | Behaviour |
   |---|---|
   | Court referenced by NO fixture | Hard delete allowed |
   | Court referenced only by COMPLETED fixtures | Delete → 409 `court.in_use`; **archive** allowed |
   | Court referenced by any UNPLAYED fixture | Delete → 409; **archive also → 409** — reassign first |
   | Court out for a day / a week | `court_exceptions` row, NOT archive |

   **The archive test is fixture status, not fixture date.** "Future fixtures"
   was the ruling as first stated; a date comparison is the wrong instrument —
   it needs an org-tz "now", it drifts as the clock moves, and it wrongly
   clears a past-dated fixture that was never played but still needs a court.
   Unplayed-vs-completed is stable, tz-free, and is the property that actually
   matters (an unplayed fixture needs somewhere to happen; a completed one is
   history). Confirm the real completed/unplayed predicate against the fixtures
   table before implementing — do not assume a column name.

   Schema consequences, and they must land in **V367** because the schema is
   P8's — retrofitting them later costs a second migration on a populated table:

   - `archived_at timestamptz null` on BOTH `venues` and `courts`. Repo
     precedent and naming: `db/migration/deltas/V261__division_archive.sql:5`.
   - The courts uniqueness becomes a PARTIAL index —
     `unique (venue_id, name) where archived_at is null` — so a name frees up
     after archiving. V261:9 is the precedent for this exact form.
   - `fixtures.court_id` FK is **`on delete restrict`**, not the repo's more
     common `on delete cascade`. Precedent:
     `db/migration/deltas/V299__sponsor_order_delete_restrict.sql:12`, the same
     "referenced history must not vanish" case. The 409 must be a DDL
     guarantee, not only a check in `venues.ts` that a future call site can
     forget — same principle as uniqueness living in DDL.
   - Archived venues/courts are excluded from list endpoints by default,
     from the court picker, and (P9) from scheduling candidate sets.

5. **Closing a calendar under already-placed fixtures is advisory in P8.**
   A `closed: true` exception, or narrowed hours, can strand fixtures already
   scheduled outside the new window. Nothing in the spec detects this. The
   detector belongs in P10 (it needs `usableWindows`), so P8 does the honest
   half: `PUT /courts/{id}/calendar` returns an advisory count of fixtures on
   that court now falling outside their court's hours. **Owed to P10:** a real
   conflict code for the stranded-fixture case, surfaced through the same
   entity-aware `/validate` path that gains court double-booking.

## Status log

- 2026-08-17 — gates verified, worktree + DB + placement up, scout re-pin
  complete, two rulings above recorded. Implementation starting: server tier
  (migration → usecase → routes → openapi) first, UI tier second.

- 2026-08-17 — **server tier + Directory UI + i18n DONE and gate-green.**
  Orchestrator's own measurement on a DB rebuilt from the current V367 (not an
  agent's self-report): apps/web `src` **8395 total / 8323 passed / 4 failed**,
  the 4 being `schedule-build-honours-locks` (pre-existing on main). tsc 0
  errors, lint `✖ 75 problems (0 errors, 75 warnings)`, `check:rls` 58 tenant
  tables naming all four new ones, i18n parity 4790 keys ×4, no OpenAPI drift.
  Shipped: V367, `usecases/venues.ts`, 8 routes, archive at court AND venue
  level, advisory stranded count, Directory venues tab, `venues-panel.tsx`,
  reusable `components/ui/tag-chip-input.tsx`, calendar editor, division
  required-tags picker, 84 `venues.*` keys ×4.

- 2026-08-17 — **reviewer found 7, all closed.** The three that mattered:
  `listVenues` filtered courts to non-archived regardless of the flag (archived
  courts unreachable by ANY endpoint, making A5's toggle unbuildable); a
  duplicate court name fell through to a raw 500 leaking the Postgres
  constraint string while `unarchiveCourt` handled the same constraint cleanly
  90 lines below; and `deleteVenue` was check-then-act with a cascading FK, so
  a concurrently-created court was silently deleted instead of blocking. The
  race was closed in BOTH layers — a `for update` lock AND `courts.venue_id`
  changed to `on delete restrict`, so a bypassed guard fails loudly instead of
  quietly. Its tests hold an uncommitted transaction open and poll
  `pg_stat_activity` for `wait_event_type = 'Lock'`; a `Promise.all` proves
  nothing here, per this repo's own `uniqueSlug` precedent.

### Defects this session found AFTER "done" was reported

Recorded because all three were invisible to a green suite:

1. **3 real `tsc` errors reported as "tsc: clean (3 runs)".** `CourtException`
   declares `open_min: number | null`; the zod input used `.nullish()`, which
   infers it optional. Fixed at the parse boundary with `.default(null)`.
   **vitest never typechecks**, and every existing exception test passed an
   explicit `null` — the omitted wire form had no coverage at all.
2. **`required_court_tags` was completely inert.** V367 adds the column to
   `divisions` and `stages`, the picker holds and sends it, and
   `grep -arn required_court_tags apps/web/src/server/` returned NOTHING — no
   schema, no usecase. Save silently no-opped. Grep the server tier for a new
   field's name before believing a picker persists.
3. **A stale comment asserting an impossibility.** `venues-panel.tsx` carried a
   comment explaining archived courts could not be shown, written against an API
   limitation that the review-fix pass had already removed.

### Process notes for the next session

- **Three subagents ended their turn parked on background watchers** and
  reported nothing. Work survived every time because they committed as they
  went, but every report had to be reconstructed from the tree. Dispatch briefs
  should mandate foreground verification explicitly.
- **Never trust an agent's gate numbers.** Of three "green" reports, one hid 3
  tsc errors, one hid two inert seams, and one measured against a stale schema.
  Re-run the gate at the wave boundary — the standing rule earned its keep here.
- Running vitest from the WORKTREE ROOT rather than `apps/web` under pnpm
  under-collects by ~2600 tests while printing a plausible total. Cost this
  session: one wrong conclusion (a new test file blamed for pollution it did
  not cause).

### Outstanding at compaction

e2e spec; **`apps/web/e2e/mobile.spec.ts` console-routes array registration**
(without it the seven width projects never see the surface); smoke suite;
screenshots 1280/320/768; PR; `_INDEX.md` P8 row → DONE (its **P7 row is also
stale** — still says "PR open" though `98e95c9e` merged).
