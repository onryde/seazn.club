# F4 — Day-one fixtures on the surfaces organisers hand out

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make day-one placeholder fixtures ("Winner of Group A") render on the two surfaces an organiser hands to other people — the exported/printed draw and the subscribed `.ics` calendar — instead of "TBD vs TBD" and a missing event.

**Architecture:** Two independent server-side changes. (1) The export path selects the `home_slot_label` / `away_slot_label` jsonb columns it has never selected and resolves them through the single existing renderer `resolveSlotLabel`, using the org's default locale exactly as the calendar route already does. (2) The ICS builder gains an all-day, `STATUS:TENTATIVE` event shape so a fixture that exists but has no time still becomes a VEVENT — anchored on the competition's `ends_on` — and keeps the same UID when it later resolves to a timed event, so subscribed calendars update in place.

**Tech Stack:** TypeScript 7, Node 26, Next.js (app router), postgres.js tagged templates, vitest, Playwright, `scripts/smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-08-18-format-progression-f3-f5-design.md` §4 and §7 (P5, P2); pickup prompt in §8. Programme rules: `docs/superpowers/specs/2026-08-17-format-progression-prompts/_RULES.md`, status/decision log `_INDEX.md`. Project standing rules: `docs/superpowers/RULES.md`.

## Global Constraints

- **TypeScript 7, Node 26**, pnpm workspaces. `apps/web` typecheck peaks ~2.8 GB — run it as `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit`.
- **Worktree**: all work happens in `/Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout` on branch `feat/f4-day-one-handout-surfaces`. **Prefix every command with `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout &&` in the SAME call** — the shell cwd resets to the main checkout between tool calls, and a verify run launched from the wrong cwd silently tests `main` and returns a false green.
- **Database**: label `f4`, already up. Load it with `eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)"` in the same call as the test command. Schema is at v373.
- **Judge vitest green ONLY from `--reporter=json --outputFile=<path>`**, reading `numPassedTests` / `numTotalTests` / `numFailedTestSuites`. A suite that fails to collect contributes 0 tests and 0 failures, so `failed: 0` is not green on its own. Readable summaries print `PASS(0) FAIL(0)` for a suite that never collected.
- Run vitest with `--root apps/web`; from the repo root it under-reports with `Cannot find package '@/lib/db'`.
- **Every change ships a test that fails without it.** All four test types this session: unit, E2E, smoke, regression.
- **No new user-facing strings are owed.** Verified: `schedule.tbd` and every `slot.*` key already exist in all four dictionaries (`apps/web/src/dictionaries/{en,fr,es,nl}/ui.json`). If a task finds itself adding a key, it goes into all four — never hardcoded English.
- **Never hand-build a slot label string.** `apps/web/src/lib/slot-label.ts` is deliberately the only place a `SlotLabel` becomes display text.
- **Do not touch** `apps/web/src/components/v2/format-templates.ts`, `packages/engine/src/competition/progression.ts`, or the seeding region of `apps/web/src/server/usecases/stages.ts` — those belong to F3, which may run in parallel.
- **Do not file GitHub issues.** A defect found mid-task is fixed inline; if the fix widens the blast radius beyond this plan's file list, stop and ask. Record every such fix in the PR body under `Unplanned fixes`.
- Pre-commit: `npm run openapi:gen && git status --porcelain` must be empty afterwards.
- CI gate is `turbo run lint typecheck` from the repo root — `npm run lint` alone is not it.

## Ground truth established before this plan (do not re-derive)

| Fact | Evidence |
|---|---|
| `fixtures.home_slot_label` / `away_slot_label` are `jsonb`, nullable, shape `{key, params}` | `db/migration/deltas/V360__stage_progression_seeding.sql:28-29` |
| `public_fixtures_v` exposes both, unmasked | `db/migration/deltas/V362__public_fixtures_slot_labels.sql:32` |
| `public_fixtures_v` NULLs `scheduled_at`, `venue`, `court_label` whenever `divisions.status = 'setup'` | `V362:25-27` |
| `resolveSlotLabel(label, lookup, fallbackKey)` is the single renderer | `apps/web/src/lib/slot-label.ts:53-66` |
| `msgFor(locale, key, vars)` is the server-side lookup; never throws | `apps/web/src/lib/messages-i18n.ts:24-32` |
| `fixtures.status` defaults `'scheduled'`, so generated placeholders DO reach the rota queries' `status in ('scheduled','in_play')` filter | `db/migration/v2-engine/tables/V214__fixtures.sql:21` |
| `competitions.starts_on` / `ends_on` are `date`, both nullable. `divisions` carry no dates at all. | `db/migration/v2-engine/tables/V207__competitions.sql:10`, `V209__divisions.sql` |
| Three catalogue templates already emit `timing: "setup"`, so labelled placeholder fixtures exist to test against today | `apps/web/src/server/templates/catalog/euro24.json:47`, `league-playoff.json:32`, `t20-super8.json:33`,`:48` |

### Owner rulings taken for this session (2026-08-18)

1. **An unscheduled fixture becomes an all-day VEVENT on `competitions.ends_on`**, falling back to `starts_on`, and is **skipped entirely if both are null**. `STATUS:TENTATIVE`. Same UID as the timed event it later becomes.
2. **V362's pre-publish mask stays.** Consequence, accepted deliberately: while `divisions.status = 'setup'` every fixture appears as an all-day tentative event and converts to a timed one at publish. Nothing new is exposed — slot labels are already public per V362.

### False premise found in the brief — corrected here

The design doc §7 P5 and the §8 pickup prompt both state that `ticketRegistrationRows` "does the same" as `officialDutyRows` — i.e. coalesces fixture participant names to `"TBD"`. **That is false.** `ticketRegistrationRows` (`exports.ts:659-668`) selects `registrations.display_name`, `ref_code` and name-display flags; it never joins `fixtures` or `entrants` and has no participant column to label. **It is out of scope and needs no change.** Do not "fix" it.

A fifth `?? "TBD"` site exists that the brief does not name: `auditLedgerDoc` (`exports.ts:763`). It is also **out of scope**: an audit ledger is a forensic record of a fixture that has already been scored, so both sides are always filled entrants — a slot label cannot occur there. Task 2 adds a one-line comment recording that, so the next reader does not re-derive it as a gap.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/web/src/server/usecases/exports.ts` | Select slot-label columns; resolve them through `resolveSlotLabel` with an org-locale lookup, in `exportFixtures`, `divisionMeta`, `toExportFixture`, `officialDutyRows`, `buildOfficialsRotaDoc`, `buildMyRotaDoc` | 1, 2, 3 |
| `apps/web/src/server/usecases/me-officiating.ts` | Widen the cross-org assignments query with slot labels + the owning org's `default_locale` | 3 |
| `apps/web/src/lib/public-site.ts` | `IcsEvent` gains an all-day/tentative timing variant; `buildIcs` emits `DTSTART;VALUE=DATE` + `STATUS` | 4 |
| `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/route.ts` | Stop dropping unscheduled fixtures; emit them as tentative all-day events anchored on the competition dates | 5 |
| `apps/web/src/server/usecases/__tests__/exports.test.ts` | DB-backed unit + regression coverage for tasks 1–3 | 1, 2, 3 |
| `apps/web/src/lib/__tests__/public-site.test.ts` | Unit coverage for the new ICS shape | 4 |
| `apps/web/src/app/(public)/.../calendar.ics/__tests__/route.test.ts` | Route-level unit + the UID-stability regression test | 5 |
| `apps/web/e2e/calendar-ics.spec.ts` (new) | E2E: the served `.ics` carries the tentative final | 6 |
| `scripts/smoke.ts` | Smoke: exported timetable shows a slot label; `.ics` carries the tentative event | 7 |

---

### Task 1: The exported draw resolves slot labels

`exportFixtures` coalesces to the SQL literal `'TBD'` and never selects the label columns, so the printed timetable, scoresheet and bracket say "TBD vs TBD" on day one while every HTML surface says "Winner of Group A".

**Files:**
- Modify: `apps/web/src/server/usecases/exports.ts:70-82` (`divisionMeta`), `:191-224` (`FixtureExportRow`, `exportFixtures`), `:225-241` (`toExportFixture`), and the four `case` arms of `buildDivisionDocModel` that call `toExportFixture`
- Modify: `apps/web/src/server/usecases/exports.ts` — `DivisionMeta` interface (search `interface DivisionMeta`)
- Test: `apps/web/src/server/usecases/__tests__/exports.test.ts`

**Interfaces:**
- Consumes: `resolveSlotLabel(label: SlotLabel | null, lookup: SlotLabelLookup, fallbackKey: MessageKey): string` from `@/lib/slot-label`; `msgFor(locale, key, vars?)` from `@/lib/messages-i18n`; `toLocale(s: string): Locale` from `@/lib/i18n-constants`; `type SlotLabel = { key: string; params: Record<string, unknown> }`.
- Produces: `exportLookup(defaultLocale: string): SlotLabelLookup` — a module-level helper in `exports.ts` reused verbatim by Tasks 2 and 3. `toExportFixture(f: FixtureExportRow, divisionName: string, lookup: SlotLabelLookup): ExportFixture` — note the **third parameter**, which Task 2 does not change and Task 3 does not use.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/usecases/__tests__/exports.test.ts`. Follow the existing suite's setup helpers (it already builds divisions via `createStages` / `generateStageFixtures` and calls `buildDivisionDocModel` directly against the DB — copy that arrangement rather than inventing one).

```ts
it("a placeholder fixture exports its slot label, not TBD", async () => {
  // Arrange: a division whose downstream stage generated fixtures at SETUP
  // timing, so home_slot_label / away_slot_label are populated and both
  // entrant ids are null. `setupDivisionWithProgression` is the existing
  // helper in this file; if it does not exist under that name, use whatever
  // this suite already uses to build a two-stage division and then write the
  // labels directly:
  //   await sql`update fixtures set home_slot_label =
  //     ${{ key: "slot.winner_group", params: { g: "A" } }},
  //     away_slot_label = ${{ key: "slot.runner_up_group", params: { g: "B" } }},
  //     home_entrant_id = null, away_entrant_id = null
  //     where id = ${fixtureId}`;
  const model = await buildDivisionDocModel(auth, divisionId, "timetable", {
    printedAt: "2026-08-18T00:00:00Z",
  });

  const text = JSON.stringify(model);
  expect(text).toContain("Winner of Group A");
  expect(text).toContain("Runner-up of Group B");
  // Regression: the pair that used to render as the SQL literal.
  expect(text).not.toContain("TBD vs TBD");
});

it("a filled fixture still exports entrant names", async () => {
  const model = await buildDivisionDocModel(auth, filledDivisionId, "timetable", {
    printedAt: "2026-08-18T00:00:00Z",
  });
  const text = JSON.stringify(model);
  expect(text).toContain(homeEntrantName);
  expect(text).toContain(awayEntrantName);
});

it("a fixture with neither entrant nor label falls back to localized TBD", async () => {
  // org.default_locale = 'fr' for this org; fr's schedule.tbd is not the
  // English literal, which is what proves the lookup is wired to the org.
  const model = await buildDivisionDocModel(auth, frDivisionId, "timetable", {
    printedAt: "2026-08-18T00:00:00Z",
  });
  expect(JSON.stringify(model)).toContain(msgFor("fr", "schedule.tbd"));
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)" && \
  npx vitest run --root apps/web src/server/usecases/__tests__/exports.test.ts \
    --reporter=json --outputFile=/tmp/f4-t1-red.json; echo "EXIT=$?"
```

Expected: the first test FAILS on `expect(text).toContain("Winner of Group A")` — the model carries the string `"TBD"`. Confirm by reading `numFailedTests >= 1` **and** `numTotalTests` moved, in `/tmp/f4-t1-red.json`. A `numTotalTests` of 0 means the suite failed to collect and the red is meaningless.

- [ ] **Step 3: Add the locale column to `divisionMeta`**

In `exports.ts`, widen the `DivisionMeta` interface with `default_locale: string;` and add the column to the select at `:72`:

```ts
async function divisionMeta(tx: Tx, divisionId: string): Promise<DivisionMeta> {
  const [row] = await tx<DivisionMeta[]>`
    select d.id, d.name, d.org_id, org.name as org_name, org.slug as org_slug,
           org.default_locale,
           d.competition_id, c.name as competition_name, c.slug as comp_slug,
           c.visibility, d.slug as div_slug,
           c.branding, d.sport_key, d.module_version, d.config
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations org on org.id = d.org_id
    where d.id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return row;
}
```

- [ ] **Step 4: Add the shared lookup helper**

Add near the top of `exports.ts`, below the imports:

```ts
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";

/** Copy locale for a document nobody is "viewing".
 *
 *  An exported PDF is printed and pinned to a wall, or mailed to clubs — it
 *  has no single reader whose cookie could be consulted, so it uses the org's
 *  own default locale. This mirrors `calendar.ics/route.ts:32-33` exactly;
 *  the reasoning is recorded at that file's :24-30 and is the same reasoning
 *  here. Do NOT swap this for resolveLocale(). */
function exportLookup(defaultLocale: string): SlotLabelLookup {
  const locale = toLocale(defaultLocale);
  return (key, vars) => msgFor(locale, key, vars);
}
```

- [ ] **Step 5: Select the label columns and stop coalescing in SQL**

```ts
interface FixtureExportRow {
  id: string;
  scheduled_at: string | null;
  court_label: string | null;
  round_no: number | null;
  stage_name: string;
  home_label: string | null;
  away_label: string | null;
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  home_color: string | null;
  away_color: string | null;
  summary: { sides?: { line: string }[] } | null;
  status: string;
}

async function exportFixtures(tx: Tx, divisionId: string): Promise<FixtureExportRow[]> {
  return tx<FixtureExportRow[]>`
    select f.id, f.scheduled_at::text as scheduled_at, f.court_label, f.round_no,
           s.name as stage_name,
           he.display_name as home_label,
           ae.display_name as away_label,
           f.home_slot_label, f.away_slot_label,
           htd.colors->>'primary' as home_color,
           atd.colors->>'primary' as away_color,
           m.summary, f.status
    from fixtures f
    join stages s on s.id = f.stage_id
    left join entrants he on he.id = f.home_entrant_id
    left join entrants ae on ae.id = f.away_entrant_id
    left join team_display_v htd on htd.team_id = he.team_id
    left join team_display_v atd on atd.team_id = ae.team_id
    left join match_states m on m.fixture_id = f.id
    where f.division_id = ${divisionId}
    order by s.seq, f.round_no, f.seq_in_round`;
}
```

The `'TBD'` coalesce moves out of SQL because SQL cannot reach the message catalogue. Losing it makes `home_label` nullable, which is why the interface changes with it — leave `home_label` as `string` and TypeScript will not complain while the field silently becomes `null` at runtime.

- [ ] **Step 6: Resolve in `toExportFixture`**

```ts
function toExportFixture(
  f: FixtureExportRow,
  divisionName: string,
  lookup: SlotLabelLookup,
): ExportFixture {
  const sides = f.summary?.sides;
  return {
    id: f.id,
    at: f.scheduled_at,
    court: f.court_label,
    stageName: f.stage_name,
    round: f.round_no,
    // A filled side wins; an empty one falls back to its placeholder label,
    // and only a side with neither reaches the localized TBD.
    home: f.home_label ?? resolveSlotLabel(f.home_slot_label, lookup, "schedule.tbd"),
    away: f.away_label ?? resolveSlotLabel(f.away_slot_label, lookup, "schedule.tbd"),
    ...(f.home_color !== null ? { homeColor: f.home_color } : {}),
    ...(f.away_color !== null ? { awayColor: f.away_color } : {}),
    divisionName,
    ...(f.status === "decided" && sides !== undefined && sides.length === 2
      ? { result: `${sides[0]!.line} – ${sides[1]!.line}` }
      : {}),
  };
}
```

- [ ] **Step 7: Thread the lookup through every `toExportFixture` call site**

Inside `buildDivisionDocModel`'s `withTenant` callback, after `const meta = await divisionMeta(tx, divisionId);`:

```ts
const slotLookup = exportLookup(meta.default_locale);
```

Then update each `toExportFixture(f, meta.name)` call to `toExportFixture(f, meta.name, slotLookup)`. Find them all — do not assume there is only one:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  grep -an 'toExportFixture(' apps/web/src/server/usecases/exports.ts
```

`buildCompetitionTimetable` (`:513`) also calls it and reads a different meta row — give it its own `exportLookup(...)` from whatever locale that function has in scope. If it has no org row at all, widen its query the same way `divisionMeta` was widened in Step 3; do not fall back to a hardcoded `"en"`.

- [ ] **Step 8: Run the test and watch it pass**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)" && \
  npx vitest run --root apps/web src/server/usecases/__tests__/exports.test.ts \
    --reporter=json --outputFile=/tmp/f4-t1-green.json; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`, `numFailedTestSuites: 0`, and `numTotalTests` at least 3 higher than the pre-existing count. Read the JSON — do not trust a readable summary.

- [ ] **Step 9: Run the suites that share this file**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)" && \
  npx vitest run --root apps/web \
    src/server/usecases/__tests__/pass-scope-exports.test.ts \
    src/server/usecases/__tests__/scoresheet-per-pitch.test.ts \
    src/server/usecases/__tests__/pool-nesting-tripwire.test.ts \
    src/server/__tests__/doc-render-bracket.test.ts \
    --reporter=json --outputFile=/tmp/f4-t1-neighbours.json; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`. These four all import `exports.ts` internals and are where a signature change surfaces.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/server/usecases/exports.ts apps/web/src/server/usecases/__tests__/exports.test.ts
git commit -m "fix(exports): resolve slot labels in the exported draw

The export path never selected fixtures.home_slot_label/away_slot_label and
coalesced to the SQL literal 'TBD', so a printed draw showed 'TBD vs TBD'
on day one while every HTML surface showed 'Winner of Group A'. Nothing in
the UI could reveal the discrepancy, because the columns were never read.

Selects both columns and resolves them through resolveSlotLabel with a
lookup bound to the org's default locale, mirroring calendar.ics/route.ts."
```

---

### Task 2: The officials rota resolves slot labels

`officialDutyRows` joins entrants only, and `buildOfficialsRotaDoc` applies `?? "TBD"` in TypeScript. An official handed a rota for a knockout day sees "TBD vs TBD" for every unfilled match.

**Files:**
- Modify: `apps/web/src/server/usecases/exports.ts:552-585` (`OfficialDutyRow`, `officialDutyRows`), `:605-620` (the rota assembly loop), `:744-770` (`auditLedgerDoc` — comment only)
- Test: `apps/web/src/server/usecases/__tests__/exports.test.ts`

**Interfaces:**
- Consumes: `exportLookup(defaultLocale: string): SlotLabelLookup` from Task 1; `resolveSlotLabel`; `SlotLabel`.
- Produces: nothing new. `OfficialDutyRow` gains `home_slot_label: SlotLabel | null` and `away_slot_label: SlotLabel | null`.

- [ ] **Step 1: Write the failing test**

```ts
it("the officials rota shows slot labels for unfilled fixtures", async () => {
  // Arrange: assign an official to the placeholder fixture built in Task 1's
  // arrangement (home_entrant_id and away_entrant_id both null, both
  // *_slot_label populated), via the same fixture_officials insert this suite
  // already uses for its rota tests.
  const model = await buildOfficialsRotaDoc(auth, divisionId, {
    printedAt: "2026-08-18T00:00:00Z",
  });
  const text = JSON.stringify(model);
  expect(text).toContain("Winner of Group A vs Runner-up of Group B");
  expect(text).not.toContain("TBD vs TBD");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)" && \
  npx vitest run --root apps/web src/server/usecases/__tests__/exports.test.ts \
    -t "officials rota shows slot labels" \
    --reporter=json --outputFile=/tmp/f4-t2-red.json; echo "EXIT=$?"
```

Expected: FAIL, the model contains `"TBD vs TBD"`. Note `-t` filters by test name; confirm `numTotalTests` is 1, not 0.

- [ ] **Step 3: Select the columns**

```ts
interface OfficialDutyRow {
  official_id: string;
  official_name: string;
  scheduled_at: string | null;
  venue_tz: string | null;
  court_label: string | null;
  comp_name: string;
  div_name: string;
  role_key: string;
  response: "pending" | "accepted" | "declined";
  home: string | null;
  away: string | null;
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
}
```

and in the query, after `h.display_name as home, a.display_name as away`, add:

```sql
           f.home_slot_label, f.away_slot_label,
```

- [ ] **Step 4: Resolve in the assembly loop**

In `buildOfficialsRotaDoc`, after `const meta = await divisionMeta(tx, divisionId);` add `const slotLookup = exportLookup(meta.default_locale);`, then replace the `opponents` line at `:614`:

```ts
        opponents: `${r.home ?? resolveSlotLabel(r.home_slot_label, slotLookup, "schedule.tbd")} vs ${r.away ?? resolveSlotLabel(r.away_slot_label, slotLookup, "schedule.tbd")}`,
```

- [ ] **Step 5: Record why `auditLedgerDoc` is deliberately untouched**

Above the `vs` construction at `exports.ts:761`, add:

```ts
    // No slot-label fallback here, deliberately: an audit ledger is the
    // forensic record of a fixture that has already been scored, so both
    // sides are always filled entrants. A placeholder cannot reach this doc.
```

- [ ] **Step 6: Run it and watch it pass**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)" && \
  npx vitest run --root apps/web src/server/usecases/__tests__/exports.test.ts \
    --reporter=json --outputFile=/tmp/f4-t2-green.json; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`, `numFailedTestSuites: 0`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/usecases/exports.ts apps/web/src/server/usecases/__tests__/exports.test.ts
git commit -m "fix(exports): resolve slot labels in the officials rota

officialDutyRows joined entrants only, so an official handed a rota for a
knockout day read 'TBD vs TBD' for every unfilled match."
```

---

### Task 3: The cross-org personal rota resolves slot labels

`buildMyRotaDoc` reads `getMyOfficiating(userId)`, which selects entrant names only. It is cross-org and SEAZN-neutral, so there is no single org locale — each row must carry its own.

**Files:**
- Modify: `apps/web/src/server/usecases/me-officiating.ts:80-111` (the assignments query) and the `MyOfficiatingAssignment` interface in that file
- Modify: `apps/web/src/server/usecases/exports.ts:712-733` (`buildMyRotaDoc`)
- Test: `apps/web/src/server/usecases/__tests__/exports.test.ts`

**Interfaces:**
- Consumes: `exportLookup` from Task 1.
- Produces: `MyOfficiatingAssignment` gains `home_slot_label: SlotLabel | null`, `away_slot_label: SlotLabel | null`, `org_default_locale: string`.

- [ ] **Step 1: Write the failing test**

```ts
it("my rota shows slot labels, localized per owning org", async () => {
  // Arrange: the same official, linked to a user, assigned to the placeholder
  // fixture. Use whatever helper this suite already uses for buildMyRotaDoc.
  const model = await buildMyRotaDoc(userId, { printedAt: "2026-08-18T00:00:00Z" });
  const text = JSON.stringify(model);
  expect(text).toContain("Winner of Group A vs Runner-up of Group B");
  expect(text).not.toContain("TBD vs TBD");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)" && \
  npx vitest run --root apps/web src/server/usecases/__tests__/exports.test.ts \
    -t "my rota shows slot labels" \
    --reporter=json --outputFile=/tmp/f4-t3-red.json; echo "EXIT=$?"
```

Expected: FAIL on the `toContain`.

- [ ] **Step 3: Widen the query**

In `me-officiating.ts`, add to the `MyOfficiatingAssignment` interface:

```ts
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  org_default_locale: string;
```

(import `type { SlotLabel } from "@/server/usecases/stage-seeding"`), and in the assignments select at `:86`, after `h.display_name as home_name, a.display_name as away_name,`:

```sql
           f.home_slot_label, f.away_slot_label,
           org.default_locale as org_default_locale,
```

`org` is already joined at `:98` (`join organizations org on org.id = f.org_id`) — do not add a second join.

Check whether the `completed` query lower in the same function needs the same columns. It does **not**: a completed fixture has filled entrants by definition. Leave it, and say so in a comment.

- [ ] **Step 4: Resolve per row**

In `buildMyRotaDoc`, replace the `opponents` line at `:726`:

```ts
    // Cross-org doc: each duty is localized by ITS OWN org's default locale,
    // not one global choice — the reader officiates for many organisations.
    const lookup = exportLookup(a.org_default_locale);
    s.duties.push({
      at: fixtureWhen(a.scheduled_at, a.venue_tz),
      court: a.court_label,
      compDivision: `${a.competition_name} · ${a.division_name}`,
      role: a.role_key,
      opponents: `${a.home_name ?? resolveSlotLabel(a.home_slot_label, lookup, "schedule.tbd")} vs ${a.away_name ?? resolveSlotLabel(a.away_slot_label, lookup, "schedule.tbd")}`,
      response: a.response,
    });
```

- [ ] **Step 5: Run it and watch it pass, plus the me-officiating suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)" && \
  npx vitest run --root apps/web \
    src/server/usecases/__tests__/exports.test.ts \
    src/server/usecases/__tests__/me-officiating.test.ts \
    --reporter=json --outputFile=/tmp/f4-t3-green.json; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`, `numFailedTestSuites: 0`. If `me-officiating.test.ts` does not exist under that name, find it: `ls apps/web/src/server/usecases/__tests__/ | grep -i offic`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/me-officiating.ts apps/web/src/server/usecases/exports.ts apps/web/src/server/usecases/__tests__/exports.test.ts
git commit -m "fix(exports): resolve slot labels in the personal officiating rota

Cross-org doc, so each duty is localized by its own org's default locale
rather than one global choice."
```

---

### Task 4: The ICS builder gains all-day tentative events

`IcsEvent` requires `start: Date` and `durationMinutes`, and `buildIcs` emits no `STATUS`. A fixture that exists at setup has no time at all, so it cannot be expressed. This task changes only the builder; Task 5 uses it.

**Files:**
- Modify: `apps/web/src/lib/public-site.ts:31-39` (`IcsEvent`), `:62-87` (`buildIcs`)
- Test: `apps/web/src/lib/__tests__/public-site.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type IcsEvent = {
    uid: string;
    summary: string;
    location?: string;
    description?: string;
  } & (
    | { start: Date; durationMinutes: number }
    | { allDayOn: string }   // "YYYY-MM-DD"
  );
  ```
  A union, not two optional fields, so "both" and "neither" are unrepresentable. Existing call sites that pass `{start, durationMinutes}` keep compiling unchanged.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/lib/__tests__/public-site.test.ts`:

```ts
it("an all-day event emits DATE-typed bounds and TENTATIVE status", () => {
  const ics = buildIcs("Cup", [
    { uid: "fix-1", allDayOn: "2026-09-13", summary: "Winner of Group A vs Runner-up of Group B" },
  ]);
  expect(ics).toContain("DTSTART;VALUE=DATE:20260913");
  // RFC 5545 §3.6.1: the DATE-typed DTEND is EXCLUSIVE, so a one-day event
  // ends on the following day. Ending on the same date renders as zero-length.
  expect(ics).toContain("DTEND;VALUE=DATE:20260914");
  expect(ics).toContain("STATUS:TENTATIVE");
});

it("a timed event stays timed and is marked confirmed", () => {
  const ics = buildIcs("Cup", [
    {
      uid: "fix-1",
      start: new Date("2026-09-13T14:00:00Z"),
      durationMinutes: 90,
      summary: "Lions vs Tigers",
    },
  ]);
  expect(ics).toContain("DTSTART:20260913T140000Z");
  expect(ics).toContain("DTEND:20260913T153000Z");
  expect(ics).toContain("STATUS:CONFIRMED");
  expect(ics).not.toContain("VALUE=DATE");
});

it("UID is byte-identical across the tentative-to-timed transition", () => {
  const tentative = buildIcs("Cup", [
    { uid: "fix-1", allDayOn: "2026-09-13", summary: "Winner of Group A vs Runner-up of Group B" },
  ]);
  const timed = buildIcs("Cup", [
    { uid: "fix-1", start: new Date("2026-09-13T14:00:00Z"), durationMinutes: 90, summary: "Lions vs Tigers" },
  ]);
  const uidOf = (s: string) => s.split("\r\n").find((l) => l.startsWith("UID:"));
  expect(uidOf(tentative)).toBe("UID:fix-1@seazn.club");
  expect(uidOf(timed)).toBe(uidOf(tentative));
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  npx vitest run --root apps/web src/lib/__tests__/public-site.test.ts \
    --reporter=json --outputFile=/tmp/f4-t4-red.json; echo "EXIT=$?"
```

Expected: the all-day test fails to **compile-or-run** (`allDayOn` is not on `IcsEvent`) and the timed test fails on `STATUS:CONFIRMED`. Note vitest does NOT typecheck — an excess-property error may surface only as a runtime `undefined`, so read the assertion messages rather than assuming a type error.

- [ ] **Step 3: Implement**

```ts
export type IcsEvent = {
  uid: string;
  summary: string;
  location?: string;
  description?: string;
} & (
  | {
      start: Date;
      /** minutes; feeds default to 90 when the sport gives no better figure */
      durationMinutes: number;
    }
  | {
      /** `YYYY-MM-DD` — an all-day VEVENT (RFC 5545 §3.3.4 DATE value type),
       *  for a fixture that exists but has no time yet. Emitted TENTATIVE so
       *  subscribers see it as provisional; it becomes a timed CONFIRMED event
       *  under the SAME UID once scheduled, and therefore updates in place in
       *  calendars people have already subscribed to. */
      allDayOn: string;
    }
);

function icsDateOnly(ymd: string): string {
  return ymd.replace(/-/g, "");
}

/** The DATE-typed DTEND is exclusive (RFC 5545 §3.6.1), so a single all-day
 *  event ends on the following day. Same date start and end renders as a
 *  zero-length event that several clients drop entirely. */
function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildIcs(calendarName: string, events: IcsEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//seazn.club//public-dashboard//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(calendarName)}`,
  ];
  for (const ev of events) {
    const timing =
      "allDayOn" in ev
        ? [
            `DTSTAMP:${icsDateOnly(ev.allDayOn)}T000000Z`,
            `DTSTART;VALUE=DATE:${icsDateOnly(ev.allDayOn)}`,
            `DTEND;VALUE=DATE:${icsDateOnly(nextDay(ev.allDayOn))}`,
            "STATUS:TENTATIVE",
          ]
        : [
            `DTSTAMP:${icsDate(ev.start)}`,
            `DTSTART:${icsDate(ev.start)}`,
            `DTEND:${icsDate(new Date(ev.start.getTime() + ev.durationMinutes * 60_000))}`,
            "STATUS:CONFIRMED",
          ];
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.uid}@seazn.club`,
      ...timing,
      `SUMMARY:${icsText(ev.summary)}`,
      ...(ev.location ? [`LOCATION:${icsText(ev.location)}`] : []),
      ...(ev.description ? [`DESCRIPTION:${icsText(ev.description)}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
```

`DTSTAMP` remains derived from the event's own time rather than "now", which is what makes the output deterministic and testable — that was already true and must stay true.

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  npx vitest run --root apps/web src/lib/__tests__/public-site.test.ts \
    --reporter=json --outputFile=/tmp/f4-t4-green.json; echo "EXIT=$?"
```

Expected: `numFailedTests: 0` and `numTotalTests` up by 3.

- [ ] **Step 5: Confirm no other caller broke**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  grep -ran 'buildIcs\|IcsEvent' apps/web/src --include='*.ts' --include='*.tsx' | grep -v __tests__
```

Expected hits: `lib/public-site.ts` itself and the `calendar.ics` route only. `apps/web/src/server/usecases/registrations.ts:3001-3024` hand-rolls a **separate** VCALENDAR builder (`registrationIcs`) that does not use `buildIcs` — that duplication is real but out of scope here. Note it in the PR body; do not merge them in this session.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/public-site.ts apps/web/src/lib/__tests__/public-site.test.ts
git commit -m "feat(ics): all-day tentative events, explicit STATUS

IcsEvent becomes a union so a fixture with no time is representable and
'both'/'neither' timing stays unrepresentable. All-day events use the
DATE value type with the exclusive DTEND RFC 5545 requires."
```

---

### Task 5: The subscribed calendar emits day-one fixtures

The route drops every fixture with `scheduled_at === null`, so a final that exists at setup never becomes a VEVENT — contradicting the owner ruling recorded in that same file's own comment at `:24-30`.

**Files:**
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/route.ts:39-56`
- Test: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/__tests__/route.test.ts`

**Interfaces:**
- Consumes: the `IcsEvent` union from Task 4. `getPublicDivision` already returns `data.competition.starts_on` and `.ends_on` as `string | null` (`server/public-site/data.ts:84-85`) — no query change is needed.

- [ ] **Step 1: Write the failing tests**

The existing suite mocks `getPublicDivision` wholesale via `vi.mock` and calls `GET` directly with a `Request` — copy that arrangement.

```ts
it("an unscheduled fixture becomes a tentative all-day event on the competition's last day", async () => {
  mockDivision({
    competition: { name: "Cup", slug: "cup", starts_on: "2026-09-01", ends_on: "2026-09-13" },
    fixtures: [
      {
        id: "fix-final",
        scheduled_at: null,
        home_entrant_id: null,
        away_entrant_id: null,
        home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
        away_slot_label: { key: "slot.runner_up_group", params: { g: "B" } },
        venue: null,
        court_label: null,
      },
    ],
  });
  const body = await (await GET(new Request("https://x/c.ics"), { params })).text();
  expect(body).toContain("DTSTART;VALUE=DATE:20260913");
  expect(body).toContain("STATUS:TENTATIVE");
  expect(body).toContain("Winner of Group A vs Runner-up of Group B");
});

it("falls back to starts_on when the competition has no end date", async () => {
  mockDivision({
    competition: { name: "Cup", slug: "cup", starts_on: "2026-09-01", ends_on: null },
    fixtures: [{ id: "fix-final", scheduled_at: null, /* ...as above... */ }],
  });
  const body = await (await GET(new Request("https://x/c.ics"), { params })).text();
  expect(body).toContain("DTSTART;VALUE=DATE:20260901");
});

it("skips an unscheduled fixture when the competition has no dates at all", async () => {
  mockDivision({
    competition: { name: "Cup", slug: "cup", starts_on: null, ends_on: null },
    fixtures: [{ id: "fix-final", scheduled_at: null, /* ...as above... */ }],
  });
  const body = await (await GET(new Request("https://x/c.ics"), { params })).text();
  // No anchor date exists, so no defensible DTSTART exists either. Emitting a
  // VEVENT with a guessed date is worse than omitting it.
  expect(body).not.toContain("BEGIN:VEVENT");
});

it("REGRESSION: the UID is byte-identical before and after the fixture resolves", async () => {
  const uidOf = (s: string) => s.split("\r\n").find((l) => l.startsWith("UID:"));

  mockDivision({
    competition: { name: "Cup", slug: "cup", starts_on: "2026-09-01", ends_on: "2026-09-13" },
    fixtures: [{ id: "fix-final", scheduled_at: null, home_entrant_id: null, away_entrant_id: null,
                 home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
                 away_slot_label: { key: "slot.runner_up_group", params: { g: "B" } },
                 venue: null, court_label: null }],
  });
  const before = await (await GET(new Request("https://x/c.ics"), { params })).text();

  // Same fixture id, now drawn and scheduled.
  mockDivision({
    competition: { name: "Cup", slug: "cup", starts_on: "2026-09-01", ends_on: "2026-09-13" },
    entrants: [{ id: "e1", display_name: "Lions" }, { id: "e2", display_name: "Tigers" }],
    fixtures: [{ id: "fix-final", scheduled_at: "2026-09-13T14:00:00Z",
                 home_entrant_id: "e1", away_entrant_id: "e2",
                 home_slot_label: null, away_slot_label: null,
                 venue: null, court_label: null }],
  });
  const after = await (await GET(new Request("https://x/c.ics"), { params })).text();

  // A subscribed calendar is the one surface where getting this wrong is not
  // recoverable by a redeploy: a changed UID arrives as a SECOND event beside
  // a stale copy, in calendars we no longer control.
  expect(uidOf(before)).toBe("UID:fix-final@seazn.club");
  expect(uidOf(after)).toBe(uidOf(before));
  expect(after).toContain("DTSTART:20260913T140000Z");
  expect(after).toContain("Lions vs Tigers");
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  npx vitest run --root apps/web \
    "src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/__tests__/route.test.ts" \
    --reporter=json --outputFile=/tmp/f4-t5-red.json; echo "EXIT=$?"
```

Expected: the first, second and fourth FAIL (the body contains no `BEGIN:VEVENT` at all — the fixture is filtered out); the third passes vacuously and only becomes meaningful after the change. Quote the path — it contains brackets and parentheses that the shell will otherwise glob.

- [ ] **Step 3: Implement**

Replace the `events` construction (`:39-56`):

```ts
  // A fixture that exists but has no time is the whole point of day-one
  // fixtures: it is anchored to the competition's last day as an all-day
  // TENTATIVE event, and becomes a timed CONFIRMED one under the same UID
  // when it is scheduled. Note that `public_fixtures_v` NULLs scheduled_at
  // for EVERY fixture while divisions.status = 'setup' (V362:25), so
  // pre-publish the whole feed is tentative by construction — that masking
  // is a deliberate privacy rule and is not worked around here.
  const anchorDate = data.competition.ends_on ?? data.competition.starts_on;

  const events: IcsEvent[] = data.fixtures
    .filter(
      (f) =>
        !entrantId || f.home_entrant_id === entrantId || f.away_entrant_id === entrantId,
    )
    // No competition dates means no defensible anchor; emitting a guessed
    // DTSTART into somebody's calendar is worse than omitting the event.
    .filter((f) => f.scheduled_at !== null || anchorDate !== null)
    .map((f) => {
      const common = {
        uid: f.id,
        summary: `${nameOrLabel(f.home_entrant_id, f.home_slot_label)} vs ${nameOrLabel(f.away_entrant_id, f.away_slot_label)} — ${data.division.name}`,
        ...(f.venue
          ? { location: f.court_label ? `${f.venue} (${f.court_label})` : f.venue }
          : {}),
        description: `${data.competition.name} · https://seazn.club/shared/${data.org.slug}/${data.competition.slug}/${data.division.slug}/fixtures/${f.id}`,
      };
      return f.scheduled_at !== null
        ? { ...common, start: new Date(f.scheduled_at), durationMinutes: 90 }
        : { ...common, allDayOn: anchorDate as string };
    });
```

- [ ] **Step 4: Run them and watch them pass**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  npx vitest run --root apps/web \
    "src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/__tests__/route.test.ts" \
    --reporter=json --outputFile=/tmp/f4-t5-green.json; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`, `numTotalTests` up by 4, `numFailedTestSuites: 0`.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/route.ts" "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/__tests__/route.test.ts"
git commit -m "feat(calendar): emit day-one fixtures as tentative all-day events

The route filtered out every fixture with no scheduled_at, so a final that
exists at setup was simply absent — contradicting the owner ruling recorded
in this file's own comment. Unscheduled fixtures now anchor to the
competition's last day as all-day TENTATIVE events under the fixture id as
UID, so they update in place once scheduled."
```

---

### Task 6: E2E — the served `.ics` carries the tentative final

`apps/web/e2e/` has no calendar spec at all. `.github/workflows/e2e.yml` is live on pull requests, so this runs in CI.

**Files:**
- Create: `apps/web/e2e/calendar-ics.spec.ts`
- Test: itself

**Interfaces:**
- Consumes: nothing from Tasks 1–5 at the type level; it asserts on served bytes.

- [ ] **Step 1: Read one existing spec to copy its fixtures**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  ls apps/web/e2e/ && sed -n '1,40p' apps/web/e2e/mobile.spec.ts
```

This spec has **no UI**, so it must not be added to the seven-width `mobile.spec.ts` matrix. It needs a public division whose competition has an `ends_on` and at least one `setup`-timing stage — build it through the same org/competition setup helper the other specs use, or seed it from one of the three catalogue templates that already emit `timing: "setup"` (`euro24`, `league-playoff`, `t20-super8`).

- [ ] **Step 2: Write the spec**

```ts
import { test, expect } from "@playwright/test";

// F4/P2: a subscribed calendar is a surface an organiser hands out, so the
// day-one final has to be IN it. Asserts on served bytes, not on a DOM.
test("the public .ics carries an unscheduled final as a tentative all-day event", async ({
  request,
}) => {
  const url = `/shared/${orgSlug}/${competitionSlug}/${divisionSlug}/calendar.ics`;
  const res = await request.get(url);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/calendar");

  const body = await res.text();
  expect(body).toContain("BEGIN:VEVENT");
  expect(body).toContain("STATUS:TENTATIVE");
  expect(body).toContain("DTSTART;VALUE=DATE:");
  // The label, not the placeholder — anchored on `Winner of` so a bare
  // "TBD" cannot satisfy it.
  expect(body).toMatch(/SUMMARY:.*Winner of /);
  expect(body).not.toMatch(/SUMMARY:TBD vs TBD/);
});
```

Replace `orgSlug` / `competitionSlug` / `divisionSlug` with the values the setup helper returns — do not hardcode demo slugs that may not exist in a CI-seeded database.

- [ ] **Step 3: Run it against a prod build**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label f4 && \
  eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)" && \
  npx playwright test e2e/calendar-ics.spec.ts --config apps/web/playwright.config.ts; \
  echo "EXIT=$?"
```

Expected: 1 passed. e2e must run on `localhost`, never `127.0.0.1` — a secure cookie on the numeric host 401s.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/calendar-ics.spec.ts
git commit -m "test(e2e): the public .ics carries the day-one final"
```

---

### Task 7: Smoke — both handout surfaces, end to end

`scripts/smoke.ts` exercises the export endpoints at `:1708`, `:2220` and `:11408` but asserts only that bytes are a valid PDF/XLSX. It has **zero** `calendar.ics` coverage. Smoke CI runs on PRs only.

**Files:**
- Modify: `scripts/smoke.ts`
- Test: itself

- [ ] **Step 1: Find the section that already builds a multi-stage division**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  grep -an 'exports/timetable\|shared/' scripts/smoke.ts | head -20
```

Add the new checks beside the existing timetable export at `:11403-11413`, reusing that division rather than building another.

- [ ] **Step 2: Add the export assertion**

The existing check reads bytes and asserts `%PDF-`. Add an XLSX or CSV read whose **text** can be searched — a PDF's bytes are compressed and a `toContain` against them proves nothing:

```ts
// F4/P5: the printed draw is the artifact an organiser pins to a wall on day
// one. It used to say "TBD vs TBD" while every HTML surface said "Winner of
// Group A", and nothing in the UI could reveal the discrepancy because the
// slot-label columns were never selected.
const drawXlsx = await fetch(
  `${BASE}/api/v1/divisions/${div.id}/exports/timetable?format=xlsx`,
  { headers: authHeaders },
);
const drawText = await xlsxToText(Buffer.from(await drawXlsx.arrayBuffer()));
check(
  "exports timetable shows a placeholder's slot label, not TBD",
  drawXlsx.status === 200 && /Winner of /.test(drawText) && !/TBD vs TBD/.test(drawText),
);
```

If no `xlsxToText` helper exists in `smoke.ts`, use whatever the file already uses to read the org name out of an exported workbook (`:1633` says it does exactly that) — reuse it, do not write a second reader.

- [ ] **Step 3: Add the calendar assertion**

```ts
// F4/P2: the subscribed calendar had no smoke coverage at all.
const ics = await fetch(
  `${BASE}/shared/${orgSlug}/${compSlug}/${divSlug}/calendar.ics`,
);
const icsBody = await ics.text();
check(
  "public .ics serves as text/calendar",
  ics.status === 200 && (ics.headers.get("content-type") ?? "").includes("text/calendar"),
);
check(
  "public .ics carries the day-one final as a tentative all-day event",
  icsBody.includes("STATUS:TENTATIVE") &&
    icsBody.includes("DTSTART;VALUE=DATE:") &&
    /SUMMARY:.*Winner of /.test(icsBody),
);
check(
  "public .ics keys the VEVENT UID on the fixture id",
  icsBody.includes(`UID:${finalFixtureId}@seazn.club`),
);
```

Match the file's actual assertion helper — if it is not named `check`, copy the neighbouring call's shape exactly.

- [ ] **Step 4: Run the full smoke**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label f4 && \
  eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)" && \
  npx tsx scripts/smoke.ts > /tmp/f4-smoke.log 2>&1; echo "EXIT=$?" >> /tmp/f4-smoke.log; \
  tail -30 /tmp/f4-smoke.log
```

Expected: `EXIT=0` and the four new lines present and passing. The AI section is gated off locally — its skips are expected and are not failures.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke.ts
git commit -m "test(smoke): cover both day-one handout surfaces

The exported draw's slot labels, and the .ics feed, which had no smoke
coverage at all."
```

---

### Task 8: Full gate, review, PR

- [ ] **Step 1: Typecheck and lint — the actual CI gate**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  NODE_OPTIONS=--max-old-space-size=6144 npx turbo run lint typecheck > /tmp/f4-gate.log 2>&1; \
  echo "EXIT=$?" >> /tmp/f4-gate.log; tail -40 /tmp/f4-gate.log
```

Expected: `EXIT=0`. `rtk` hides lint output and prints "ESLint output (JSON parse failed)" for a run it lost — if that appears, re-run through `rtk proxy` and read the `✖ N problems` line.

- [ ] **Step 2: OpenAPI drift**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  npm run openapi:gen && git status --porcelain; echo "EXIT=$?"
```

Expected: empty output. No route signature changed in this session, so drift here would mean something unintended moved.

- [ ] **Step 3: Re-verify the known-red baseline before judging anything red**

`_RULES.md` §4 lists five suites that fail on a clean `main` for environmental reasons: `help-content`, `help-groups-suspension`, `sponsor-crm-migration`, `enrichment-dict-parity`, `schedule-build-honours-locks`. That list is dated 2026-08-17 — re-verify rather than trusting it, and attribute nothing on it to this change.

- [ ] **Step 4: Full affected-suite run**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/f4-handout && \
  eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f4)" && \
  npx vitest run --root apps/web src/server/usecases src/lib "src/app/(public)" \
    --reporter=json --outputFile=/tmp/f4-all.json; echo "EXIT=$?"
```

Read `/tmp/f4-all.json`: `numFailedTestSuites` must be 0 apart from the baseline five, and `numTotalTests` must be a plausible four-figure number — a small total means most suites never collected.

- [ ] **Step 5: Reviewer pass**

Dispatch the `reviewer` agent (Sonnet, MAX effort) over the branch diff. Loop Implementer → Reviewer until the gap list is empty AND the gate is green. Specifically ask it to check: every `?? "TBD"` site in `exports.ts` is either fixed or has a comment saying why not; no slot label string is built outside `resolveSlotLabel`; the ICS union genuinely prevents "both" and "neither"; and the UID test would fail if the UID were keyed on anything but the fixture id.

- [ ] **Step 6: Open the PR**

One PR per session. Body must carry: the two owner rulings taken 2026-08-18 (ICS anchored on `ends_on`; V362's pre-publish mask kept), the corrected false premise about `ticketRegistrationRows`, an `Unplanned fixes` section, and the noted-but-untouched duplication of `registrationIcs` in `registrations.ts`.

- [ ] **Step 7: Update the programme index**

Add F4's status row and both rulings to `docs/superpowers/specs/2026-08-17-format-progression-prompts/_INDEX.md` — that file is the compaction anchor and rulings go in as they happen, not at the end.
