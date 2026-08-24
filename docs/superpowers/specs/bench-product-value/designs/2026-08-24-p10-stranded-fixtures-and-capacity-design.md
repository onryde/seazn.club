# P10 — Stranded fixtures, the fourth window copy, and a server-side capacity precheck

Design of record for portfolio session P10, authored 2026-08-24 against
`203395b6a` (P9.5, #638). Amends
`2026-08-13-venues-courts-design.md` (D5c) and supersedes the scope written in
`../portfolio-prompts/P10-venues-calendars.md`.

## Why this document exists

P10's prompt was authored 2026-08-13 and describes building
`packages/engine/src/scheduling/court-windows.ts` and wiring the lattice and
`/validate` to consume it. **P9.5 shipped all of that** on 2026-08-24. Scope
items 1 and 2 of the prompt are done; the calendar editor UI the prompt gestures
at was reassigned to P8 (amendment A4) and shipped there. Re-planning P10 from
the prompt file produces work that already exists.

What P10 actually still owes, per the venues-courts design's own closing line
and `_INDEX.md:49`, is the stranded-fixture conflict code (amendment A6). Three
further items were found while re-pinning and folded in by owner ruling
2026-08-24: a fourth copy of the window rule living outside its own guard's
reach, one verify-config site that never learned about court calendars, and the
capacity precheck's standing "treats every court as open all day" limit.

## Current state, verified

| Fact | Evidence |
|---|---|
| `usableWindows` complete — weekly hours, exception close + partial override, session intersection, blackout subtraction, org-tz boundaries | `packages/engine/src/scheduling/court-windows.ts:187` |
| Lattice, greedy, placer candidates and capacity all consume it | `calendar.ts:559`, `build-grid.ts:129`, `court-candidates.ts:362`, `capacity-input.ts:152` |
| Court calendar schema + write API exist, shipped by P8 | `db/migration/deltas/V367__venues_and_courts.sql:114,136`; `venues.ts:160`; `api/v1/orgs/[id]/courts/[courtId]/calendar/route.ts:14` |
| `courts.archived_at` exists, partial index on `archived_at is null` | `V367:52`, `V367:98` |
| Health offenders already carry real court names with A12 `Name (Venue)` disambiguation | `schedule-health.ts:279-281` via `courtNamesById` → `buildCourtDirectory` |

### The A6 gap, precisely

`calendar.ts:1763-1769`:

```ts
const openHours = courtHourWindows.get(a.court);
if (openHours !== undefined && !openHours.some((w) => a.startAt >= w.from && a.endAt <= w.to)) {
```

`courtHourWindows` is built at `:1745-1758` from `config.courtCalendars` alone.
When a fixture's court is **absent** from that map, `openHours` is `undefined`
and the guard short-circuits: no conflict of any kind is reported.

The map is scoped to candidate court ids deliberately. `schedule.ts:3187-3197`
records why: reusing the candidate set for the mismatch conflict "would
retroactively red an assignment sitting on a since-archived court — exactly
what ruling 3 (candidate-courts.ts) forbids."

So A6 sits directly on an existing owner ruling, and the `undefined` branch is
load-bearing for a second reason: it also covers **never-configured** courts. A
naive "report whenever `openHours` is undefined" fix would fire on every fixture
of every org that has no court calendars at all.

## Ruling 1 — what a stranded fixture is

A stranded fixture is an unplayed fixture assigned to a court that is
**archived (`courts.archived_at is not null`) or absent from `courts`
entirely**. It is *not* "a court with no calendar rows".

The conflict is **REPORTED, never BLOCKING**, following the precedent
`outside_court_hours` set on 2026-08-24: narrowing availability under already
placed fixtures must not hard-refuse publish with no way out.

This is compatible with ruling 3 rather than an exception to it. Ruling 3
forbids retroactively *refusing* an assignment on a since-archived court.
Surfacing it as a non-blocking conflict does not refuse it — the organiser sees
the fixture and decides.

## Design

### §1 Stranded-fixture conflict

- New `ConflictDetailKind` `stranded_fixture` — the 28th kind.
- The engine holds no database handle, so the server resolves the set and
  passes it through config, mirroring how `courtCalendars` already arrives:
  a `strandedCourtIdsForDivision` beside `courtCalendarsForDivision`
  (`court-candidates.ts:250-262`).
- `validateAssignments` reports one detail per assignment whose `court` is in
  that set. The `openHours === undefined` short-circuit at `calendar.ts:1763`
  is **left exactly as it is** — the new check is a separate branch keyed on
  court status, not on calendar presence, so orgs without calendars stay silent.
- `isBlockingConflict` and `isBlockingForBuild` are **not** widened. That file's
  own ruling forbids it, and non-blocking is the point.
- User-facing strings: `board.conflict.detail.stranded_fixture` plus its board
  label, in all four dictionaries, followed by `i18n:gen-keys` regeneration.

### §2 One window rule, enforced across both workspaces

`countStrandedFixtures` (`venues.ts:680-697`) computes court availability with
`resolveCourtDay` (`venues.ts:243`) — a fourth implementation of the window
rule. It survived P9.5's de-forking because `window-single-source.test.ts` reads
only `calendar.ts` and `build-grid.ts` through `import.meta.url` and never scans
`apps/web`.

- `countStrandedFixtures` moves onto the engine's `usableWindows`.
  `resolveCourtDay` is deleted.
- This corrects three defects in a number organisers already see in P8's
  calendar editor: the predicate tests only the fixture's **start** minute
  (a fixture starting five minutes before close "fits"), it ignores blackouts
  and session windows, and it reads `organizations.timezone` where the standing
  rule is `settings.orgTz`. Whether that column is in fact the orgTz source is
  **verified during implementation, not assumed**.
- `window-single-source.test.ts` is extended to scan `apps/web` sources, so the
  guard can see a future copy on either side of the workspace boundary.

### §3 One verify-config builder

Five sites construct a `VerifyConfig` by hand. Four pass `courtCalendars`
(`schedule.ts:1532`, `:2589`, `:2944`, `:3308`); `person-merge.ts:382` calls
`toVerifyConfig` with four arguments and never resolves calendars at all, so a
fixture reassigned during a person merge is validated with no court-hours
signal.

Hand-assembly at five sites is how a blind sixth gets born. A single
`verifyConfigForDivision(...)` resolves calendars and stranded courts together
and builds the config; all five sites route through it.

### §4 Capacity precheck moves server-side

`capacity-input.ts:143-156` passes `hours: []`, `exceptions: []` to
`usableWindows` unconditionally. Its own doc comment at `:135-141` states the
reason: P9 stopped shipping per-court calendars to the board after they blew the
RSC payload budget, so the precheck treats every court as open all day and can
only **overstate** supply.

Owner ruling 2026-08-24: make it calendar-aware by moving the computation to the
server rather than by re-inflating the board payload.

- A new endpoint accepts the board's **live, unsaved** config and fixtures in
  the request body. Deriving from stored rows instead would make the card blind
  to in-flight edits, which is the only reason the precheck exists.
- The server resolves court calendars and runs the existing pure
  `assessCapacity` (`packages/engine/src/scheduling/capacity.ts:475`). No logic
  is duplicated: `capacityInputForFixtures` is already re-exported server-side
  by `capacity-guard.ts:20`.
- Numbers travel back, calendars do not. The board payload
  (`board/types.ts:68-93`) is unchanged and P9's shrink holds.
- `settings-panel.tsx:250` and `stages-panel.tsx:422` replace their `useMemo`
  with a debounced fetch. **The server is the only producer** — there is no
  client-side fallback computation, because a fallback is the placer/verifier
  fork wearing a different hat. While a request is in flight the card shows the
  previous report, marked stale.
- Accepted cost: an instant local recompute becomes a round trip. The stale
  marking is the mitigation, and the card must read as deliberate rather than
  broken at every width.
- OpenAPI regeneration and a clean drift check are part of the change.

### §5 D3 — nothing owed

The prompt's "health offenders show court names" is already true
(`schedule-health.ts:279-281`), including A12 disambiguation and a deliberate
raw-id fallback so a since-deleted court still gets an identifiable row.
`_INDEX.md` records this as already-satisfied, not as implemented by P10.

## Testing

All four types, per `_RULES.md` §1.

- **Unit** — stranded predicate across archived, deleted, and (negative)
  uncalendared courts; `countStrandedFixtures` on `usableWindows` covering
  fixture duration, blackouts, session windows, and DST in both directions;
  the capacity usecase.
- **Regression** — an org with no court calendars produces zero
  `stranded_fixture` conflicts; the advisory count returned by
  `putCourtCalendar` and validate's stranded count agree for the same court and
  calendar.
- **E2E** — archive a court holding a scheduled fixture: the conflict is
  visible on the board and publishing is still permitted.
- **Smoke** — schedule a round on a calendared org; the capacity card renders
  server-computed numbers.
- Gates run **with and without live placement**, per the standing P9 rule.
- UI bar for the capacity card: 1280 / 320 / 768, no horizontal page scroll.

## Explicitly out of scope

- P8's calendar CRUD and its editor UI.
- The placement service and its proto — windows stay pre-baked into
  `grid_slots`, still zero proto change.
- Widening `isBlockingConflict`.
- The AI pack's draft placer remaining blind to court hours via `toSlotConfig`
  — deliberate, see the P9.5 record.
