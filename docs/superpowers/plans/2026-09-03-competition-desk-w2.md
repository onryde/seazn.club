# Competition Desk W2 — the fixtures tab as a run sheet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the division page's `?tab=fixtures` from a per-stage, round-grouped
list into a run sheet — a division-wide list on a time spine with one action per
fixture, and a stage rail on the right that owns every action that moves the
division forward.

**Architecture:** Two pure builders in `apps/web/src/lib/` (`run-sheet-groups.ts`,
`fixture-row-action.ts`) decide grouping and per-row action from data the division
page already loads; three new client components under `components/v2/desk/`
(`run-sheet.tsx`, `run-sheet-row.tsx`, `stage-rail.tsx`) render them;
`stages-panel.tsx` becomes the two-column host that mounts both and no longer owns
stage chrome. No new server query, no new endpoint, no schema change.

**Tech Stack:** Next.js (see `node_modules/next/dist/docs/` before writing route or
RSC code), React client components, Tailwind, vitest (`environment: "node"`,
no DOM), Playwright, `@seazn/engine/scheduling/tz`.

**Spec:** `docs/superpowers/specs/2026-09-02-competition-desk-design.md` §W2
(line 195). Standing rules: `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_RULES.md`.
Programme index and owner rulings: `_INDEX.md` beside it.

---

## Global Constraints

Copied verbatim from the spec, `_RULES.md`, and `AGENTS.md`. Every task's
requirements implicitly include this section.

- **The governing clock for this sheet is `scheduleSettings.tz`** — the resolved
  venue zone (`resolveVenueTz(divisionTz, orgTz)`), used for BOTH bucketing ("is
  this today?") and printing ("Sat 5 Sep"). `_RULES.md`: *"A fixture's DAY is its
  venue's day — the display zone — for BOTH bucketing and printing. The org zone
  is a FALLBACK when a division has no venue zone, never a second authority. Two
  zones in one row is the bug, wherever the seam is drawn."* The `orgTz` prop
  stays in use for the board-slot grid only (`boardSlotOptionsFor(scheduleSettings, orgTz)`).
- **A phase/grouping rule set whose tests are all "does the set contain X" states
  its EMPTY case FIRST.** `_RULES.md`: *"The empty set answers no to every
  question and lands on whatever the default is."* Four defects shipped from this
  shape in W1. `buildRunSheet` returns `[]` for zero fixtures as its first
  statement, and the spec's empty state is *"Fixtures tab with no fixtures → the
  stage rail alone, steps showing what is missing; no run sheet header."*
- **Counted strings go through `plural()`** (`apps/web/src/lib/i18n-runtime.ts:39`,
  Intl.PluralRules, `.one`/`.other`, `{count}`). Five desk strings shipped as
  "1 fixtures" in W1 before this was enforced.
- **Never let a verb agree with an interpolated free-text name.** Stage names are
  user-typed and usually plural ("Finals", "Playoffs").
- **An empty cell is not information.** Suppress a clause rather than print a zero.
- **All four locales** — `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, real
  translations, never the English copied. Then `npm run i18n:gen-keys` (root
  script; `i18n-keys.ts` is GENERATED) and `npm run i18n:check`.
  `apps/web/content/help/**` is English-only.
- **Every change ships a test that fails without it.** Four test types per task:
  unit, E2E, smoke, regression.
- **Mutate the guard.** A guard nothing kills is not tested. Mutate per SURFACE,
  not per test.
- **`apps/web` vitest is `environment: "node"`** — no DOM. A green builder suite is
  blind to stale closures, CSS cascade and real tap area. Touched something
  tappable ⇒ re-run the e2e that covers it.
- **Green is only green from JSON** (`docs/agent-playbook.md:107`):
  `npx vitest run --reporter=json --outputFile=/tmp/r.json <paths>` then
  `jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests}'`.
  Confirm `.testResults[].name` resolves inside your worktree.
- **UI verified by screenshot at 1280, 768 and 320**, no horizontal page scroll at
  any of them. The seven-width e2e matrix (320/360/375/390/430/768/834 —
  `playwright.config.ts:179-246`) is the enforcement backstop.
- **`git stash` in a worktree is not safe here** — the stash stack is shared with
  the main checkout.
- **Cite the SYMBOL, not the line.** Line pins in this plan were taken on `main` at
  2026-09-03 and move as tasks land. Re-grep the symbol before editing.
- **Working directory.** Every command below written as `/path/to/worktree/...` means
  the absolute path of THIS wave's worktree, which the controller creates before
  Task 1 and names in the dispatch brief. Shell cwd can reset to the main checkout
  between calls, so prefix `cd <abs worktree> &&` in the SAME call as the command it
  serves, and confirm the resolved paths in `.testResults[].name` before believing a
  count. New branches go in a worktree; never check out in the main repo dir.
- **Out of scope, and must stay unchanged:** `BracketPanel`, `AmericanoPanel` and
  `LadderPanel` (`page.tsx:549`, `:564`, `:571`). They are sibling mounts that
  render ABOVE the sheet in stage order, exactly as today. Spec: *"Bracket /
  americano / ladder panels: unchanged inside the tab."* Also unchanged: the
  scorepad, the `/schedule` board, the slideshow, and every mutation endpoint
  (PATCH `/api/v1/fixtures/{id}`, `/stages/{id}/fixtures`, `/divisions/{id}/undo`).

---

## Decision record — owner rulings, 2026-09-03

These were put to the owner in this session against a mockup
(`https://claude.ai/code/artifact/5be0a3be-a4ef-4ccd-ba6d-d37051bcc76e`) and
answered directly. They are **owner rulings**, not recommendations. Anything in
this plan that contradicts them is a defect in this plan.

1. **W2 is desktop-only. The W2/W3 split holds** (re-affirming `_INDEX.md` owner
   ruling 6). The run sheet's phone composition — two-line rows, the rail as a
   bottom sheet — stays in W3. W2 must still pass the seven-width gate with no
   horizontal scroll; it simply will not be *designed* below `lg` until W3.
2. **A2 — bracket stages keep their round sections.** Every other stage kind is
   day-grouped. The owner accepted the stated cost ("two organising principles
   visible in one tab on mixed divisions") in exchange for knockout comprehension
   on a finals day.
3. **Sheet skeleton — day groups are MERGED across all non-bracket stages** into
   one division-wide day spine (a Saturday shows every league/americano/ladder
   fixture under one header), each bracket stage is its own round-sectioned block,
   and ONE division-wide "Not yet scheduled" group closes the sheet.
4. **B1 — the auto-schedule CTA and its capacity-blocked reason live on the stage
   rail.** The sheet's unscheduled group is display-only with a "Set time" per row.
5. **All stage chrome moves to the rail** — Add match, Generate/Pair next, Complete
   stage, Delete stage, Required court tags, auto-schedule and Compute proposal.
   The left column becomes purely the sheet. This closes current-state finding 6
   ("actions in six places").

### Decisions taken by this plan (not owner rulings — flag them at the walkthrough)

- **Block order is chronological.** All blocks — day groups and bracket blocks
  alike — are ordered by their earliest scheduled instant, nulls last; the
  unscheduled group is always last. Rationale: ruling 3 puts two block kinds in one
  sheet without saying which comes first, and "what is on now, what is next" is the
  wave's stated premise, so the earliest thing sorts first. In the common shapes
  (one league; a league then a cup) this degrades to the obvious order. **Show this
  to the owner in Task 9's walkthrough** — it is cheap to reverse to "brackets
  first, in stage seq order" if they read it differently.
- **`page.clock` is NOT used.** The spec's W2 test list says
  *"`run-sheet.spec.ts` with `page.clock.setFixedTime`"*, but
  `grep -a -rn "page.clock" apps/web/e2e` returns **zero hits** — it would be a new
  technique in this repo, and it interacts badly with a server-rendered `now`. The
  NOW rule is instead driven deterministically by seeding fixture times *relative
  to `Date.now()`* through the existing `setFixtureScheduledAtSql`
  (`apps/web/e2e/helpers.ts:704`). The tz-boundary cases (23:30 vs 00:30) are the
  unit test's job, where no clock control is needed at all.

### Spec amendment 4 (this wave writes it)

Design §W2 line 204 reads *"Groups by calendar day in the org clock
(`settings.orgTz`, the governing zone; `settings.tz` is display-only …)"*. **This
is retired.** W1's H1 fix (final review round 3, Critical) already corrected the
division page to pass the venue zone — `d/[divSlug]/page.tsx`, the `resolvePhase`
call, `tz: scheduleSettings.tz`, whose own comment reads *"this used to be the bare
org zone … the same bucket-vs-print split competition-desk.ts had, one level up"*.
`_RULES.md`'s "One zone per fixture" states the corrected rule. Task 1 corrects the
design line in place, W1-style (corrected, not deleted, because it is what the next
session would otherwise re-derive).

### False premises found while planning (recorded, not blockers)

Every one of these was in the spec, believed, and checked against the tree on
2026-09-03:

| Spec says | Actually | Consequence |
|---|---|---|
| Masthead at `page.tsx:298-378` | `:389-396` | Stale pin. |
| `DocumentsMenu` at `stages-panel.tsx:755` | `:774` | Stale pin. |
| Bracket/americano/ladder panels render inside the tab "for their stage" | They are **sibling mounts** on the page (`page.tsx:549`, `:564`, `:571`), never nested in `StagesPanel` | They render above the whole sheet in stage order, not interleaved per stage. |
| "Re-anchor the **nine** existing specs on `data-fixture-no`" | **11** specs touch `?tab=fixtures`; `data-fixture-no` and `data-run-sheet-day` **do not exist anywhere** in `apps/web` | W2 *introduces* both attributes. Only two testids actually die with the round bars: `round-dates` and `stage-auto-schedule*`. |
| Rail steps come from "the same numbers the status line uses (`card-stats`)" | `listDivisionCardStats` (`card-stats.ts:158`) is **competition-scoped and per-division**; the rail's steps are **per-stage** | The per-stage counts get ONE derivation, `stageProgress` (Task 5), shared by every consumer. Hand-copying it is the exact K3/M1 defect W1 paid for twice. |
| (unstated) | `dayKeyInTz` already exists — `packages/engine/src/scheduling/tz.ts:72` — and `stages-panel.tsx:54` **already imports it** | The builder uses it. A second bucketing helper is a defect. |

---

## File structure

**New — pure builders (no DOM, no server import, table-testable):**

- `apps/web/src/lib/fixture-row-action.ts` — fixture state → the ONE action a row
  offers. Nothing else decides this.
- `apps/web/src/lib/run-sheet-groups.ts` — `FixtureRow[]` + stages + tz + now →
  ordered `RunSheetBlock[]`, including NOW-rule placement.
- `apps/web/src/lib/stage-progress.ts` — per-stage derived step list for the rail.

**New — components (client):**

- `apps/web/src/components/v2/desk/run-sheet.tsx` — the left column: filter
  segment, blocks, day headers, NOW rule, unscheduled group.
- `apps/web/src/components/v2/desk/run-sheet-row.tsx` — one fixture row: time spine
  cell, court + round, entrants + sub-line, one action. Replaces `FixtureLine`'s
  role in the sheet; `FixtureLine` itself survives only inside bracket blocks until
  Task 4 retires it there too.
- `apps/web/src/components/v2/desk/stage-rail.tsx` — the right rail: one card per
  stage, derived steps, every stage action, Documents, Up next.

**Modified:**

- `apps/web/src/components/v2/stages-panel.tsx` (2147 lines) — becomes the
  two-column host. Loses: the per-stage card chrome, the round-grouped non-bracket
  lists, the pinned per-stage unscheduled section, the `DocumentsMenu` mount, the
  tz caption. Keeps: `autoScheduleStage` and the other handlers (now called from
  the rail), the bracket `splitRounds` sections, `FixtureLine` for those.
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` (813 lines) —
  masthead to one row with a phase-driven primary CTA; tab strip gains counts;
  `searchParams` gains `filter`.
- `apps/web/src/components/v2/progression-panel.tsx` (438 lines) — "Compute
  proposal" moves out to the rail; the confirm flow is reused unchanged.
- `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` — new `runsheet.*` and `rail.*`
  keys, `plural()` shapes for every count.
- `apps/web/e2e/division-schedule.spec.ts` — `round-dates` assertion re-anchored.
- `apps/web/e2e/capacity-precheck.spec.ts` — `stage-auto-schedule*` re-anchored to
  the rail.
- `scripts/smoke.ts` — a fixtures-tab step.
- `apps/web/e2e/mobile.spec.ts` — run-sheet rows at the seven widths.
- `apps/web/content/help/scheduling/run-sheet.md` (new, English only) +
  `apps/web/src/lib/help.ts` `HELP_ARTICLE_SLUGS` (a slug outside the registry
  resolves to null and `help-content.test.ts` fails in BOTH directions).
- `docs/superpowers/specs/2026-09-02-competition-desk-design.md` — amendment 4.
- `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md` — today's
  rulings.

**New — tests:**

- `apps/web/src/lib/__tests__/fixture-row-action.test.ts`
- `apps/web/src/lib/__tests__/run-sheet-groups.test.ts`
- `apps/web/src/lib/__tests__/stage-progress.test.ts`
- `apps/web/e2e/run-sheet.spec.ts`

---

### Task 1: Record the rulings and correct the spec

The rest of the plan cites these documents as authority. `_RULES.md`: *"Brief must
QUOTE the ruling, not cite it"* — so the words have to be on disk before any task
quotes them.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-competition-desk-design.md` (the §W2
  grouping line, currently reading "in the org clock (`settings.orgTz`, the
  governing zone …)", and the amendments list)
- Modify: `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md`
  (owner rulings list, status table, false premises list)

- [ ] **Step 1: Correct the §W2 grouping line in place**

Replace the clause naming `settings.orgTz` with the venue zone, and leave the old
wording visible as a retired ruling — the same treatment `_RULES.md` gives its own
corrected tz bullet, and for the same stated reason.

```markdown
- Groups by calendar day in the **venue clock** (`scheduleSettings.tz`, i.e.
  `resolveVenueTz(divisionTz, orgTz)`) — the same single value the division page
  already passes to `resolvePhase` and to `StagesPanel`'s `tz` prop — ascending;
  header "Saturday 5 September · venue · n fixtures". This line used to read
  "in the org clock (`settings.orgTz`, the governing zone; `settings.tz` is
  display-only)" — RETIRED by amendment 4, and left corrected rather than deleted
  because the org zone as a SECOND authority is the bug, three times over.
```

- [ ] **Step 2: Add amendment 4 to the amendments list**

```markdown
4. **The run sheet buckets and prints in the VENUE zone** (`scheduleSettings.tz`),
   not the org zone. W1's H1 fix (final review round 3, Critical) had already
   corrected the division page — its `resolvePhase` call passes
   `tz: scheduleSettings.tz` with the comment "this used to be the bare org zone
   … the same bucket-vs-print split competition-desk.ts had, one level up" — but
   §W2 still carried the retired wording. One zone per fixture, for both
   bucketing and printing; the org zone is a fallback, never a second authority.
```

- [ ] **Step 3: Add the 2026-09-03 rulings to `_INDEX.md`**

Append to the owner-rulings list (numbering continues from 6), and update the
status table's W2 row to "In flight". Copy rulings 1–5 of this plan's Decision
Record verbatim. Add to the false-premises list the six rows of this plan's table.

- [ ] **Step 4: Verify the two documents no longer contradict each other**

Run: `rtk proxy grep -n "orgTz\|org clock" docs/superpowers/specs/2026-09-02-competition-desk-design.md`
Expected: every surviving hit is either the retired-wording quote inside the
corrected bullet, amendment 4, or `PhaseInput`'s own comment at :75 — which also
needs the same correction if it still names `orgTz` as the governing clock.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-02-competition-desk-design.md \
        docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md
git commit -m "docs(desk): W2 rulings + amendment 4 — the run sheet uses the venue zone"
```

---

### Task 2: `fixtureRowAction` — the state → action table

**Files:**
- Create: `apps/web/src/lib/fixture-row-action.ts`
- Test: `apps/web/src/lib/__tests__/fixture-row-action.test.ts`

**Interfaces:**
- Consumes: `FixtureRow` from `@/server/usecases/stages` (type-only import — a
  value import from `@/server` into a client component is a BUILD FAIL; `import
  type` is erased and safe).
- Produces: `fixtureRowAction(input: RowActionInput): RowAction` and the exported
  `RowAction` union. Task 4's `run-sheet-row.tsx` and Task 8's e2e both read it.

- [ ] **Step 1: Write the failing test**

The spec's table is: `in_play` → "Open pad"; `scheduled` & today & no officials →
"Assign scorer"; `scheduled` → "Score"; decided/finalized → "Result"; unscheduled →
"Set time". Enumerate it fully — `_RULES.md`: *"One sample is not a parity sweep."*
The API status set is `scheduled|in_play|decided|finalized|abandoned|forfeited|cancelled`
(design §W1, `PhaseInput`), so the three statuses the spec's table does **not**
name must be pinned too, or they fall through to whatever the default is.

```ts
// fixture-row-action.test.ts — the one authority for what a run-sheet row
// offers. Pure: no DB, no DOM, no engine import.
import { describe, expect, it } from "vitest";
import { fixtureRowAction, type RowActionInput } from "../fixture-row-action";

const TZ = "Europe/London";
// 2026-09-03T13:00:00Z — 14:00 London, comfortably inside the day either way.
const NOW = Date.UTC(2026, 8, 3, 13, 0);
const TODAY_1500 = "2026-09-03T14:00:00.000Z";
const TOMORROW_1000 = "2026-09-04T09:00:00.000Z";

function row(over: Partial<RowActionInput> = {}): RowActionInput {
  return {
    status: "scheduled",
    scheduledAt: TODAY_1500,
    hasOfficials: true,
    canEdit: true,
    tz: TZ,
    nowMs: NOW,
    ...over,
  };
}

describe("fixtureRowAction — the enumerated table", () => {
  it("in_play beats every other consideration, scheduled today or not", () => {
    expect(fixtureRowAction(row({ status: "in_play" })).kind).toBe("open_pad");
    expect(fixtureRowAction(row({ status: "in_play", scheduledAt: null })).kind).toBe("open_pad");
    expect(fixtureRowAction(row({ status: "in_play", hasOfficials: false })).kind).toBe("open_pad");
  });

  it("a scheduled fixture TODAY with no officials asks for a scorer", () => {
    expect(fixtureRowAction(row({ hasOfficials: false })).kind).toBe("assign_scorer");
  });

  it("a scheduled fixture NOT today with no officials does not — it is not today's problem", () => {
    expect(fixtureRowAction(row({ scheduledAt: TOMORROW_1000, hasOfficials: false })).kind).toBe("score");
  });

  it("a scheduled fixture with officials scores, today or not", () => {
    expect(fixtureRowAction(row()).kind).toBe("score");
    expect(fixtureRowAction(row({ scheduledAt: TOMORROW_1000 })).kind).toBe("score");
  });

  it("decided and finalized both read Result", () => {
    expect(fixtureRowAction(row({ status: "decided" })).kind).toBe("result");
    expect(fixtureRowAction(row({ status: "finalized" })).kind).toBe("result");
  });

  it("a scheduled fixture with no time offers Set time, and only to an editor", () => {
    expect(fixtureRowAction(row({ scheduledAt: null })).kind).toBe("set_time");
    expect(fixtureRowAction(row({ scheduledAt: null, canEdit: false })).kind).toBe("view");
  });

  it("abandoned, forfeited and cancelled are RESULTS, not open work", () => {
    // Not in the spec's table. Without an explicit branch they fall through to
    // the default, and a cancelled match would print "Score" — inviting an
    // organiser to score a match that will never be played.
    for (const status of ["abandoned", "forfeited", "cancelled"]) {
      expect(fixtureRowAction(row({ status })).kind, status).toBe("result");
    }
  });

  it("an unknown status never crashes and never invites scoring", () => {
    expect(fixtureRowAction(row({ status: "teleported" })).kind).toBe("view");
  });
});

describe("fixtureRowAction — the ORDER of the ladder, not just its branches", () => {
  // _RULES.md: a test that pins a ladder must pin the ORDER too — a case whose
  // expected value differs between two candidate orderings. If the
  // "scheduled today, no officials" rule were checked BEFORE in_play, this
  // fixture would read assign_scorer instead of open_pad.
  it("in_play + today + no officials is open_pad, which only the correct order gives", () => {
    expect(fixtureRowAction(row({ status: "in_play", hasOfficials: false })).kind).toBe("open_pad");
  });

  // And the mirror: if set_time were checked FIRST, an in_play fixture whose
  // time was cleared would read set_time.
  it("in_play with no time is open_pad, not set_time", () => {
    expect(fixtureRowAction(row({ status: "in_play", scheduledAt: null })).kind).toBe("open_pad");
  });
});

describe("fixtureRowAction — 'today' is the VENUE day, and the boundary is real", () => {
  it("23:30 local on the day before is NOT today", () => {
    // 2026-09-02T22:30Z = 23:30 London on the 2nd.
    expect(
      fixtureRowAction(row({ scheduledAt: "2026-09-02T22:30:00.000Z", hasOfficials: false })).kind,
    ).toBe("score");
  });

  it("00:30 local on the day itself IS today", () => {
    // 2026-09-02T23:30Z = 00:30 London on the 3rd.
    expect(
      fixtureRowAction(row({ scheduledAt: "2026-09-02T23:30:00.000Z", hasOfficials: false })).kind,
    ).toBe("assign_scorer");
  });

  it("the same instant in a different venue zone lands on a different day", () => {
    // Pacific/Auckland is +12: 2026-09-02T22:30Z is 10:30 on the 3rd there.
    expect(
      fixtureRowAction(
        row({ scheduledAt: "2026-09-02T22:30:00.000Z", hasOfficials: false, tz: "Pacific/Auckland" }),
      ).kind,
    ).toBe("assign_scorer");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/worktree/apps/web && npx vitest run --reporter=json \
  --outputFile=/tmp/w2-t2.json src/lib/__tests__/fixture-row-action.test.ts
jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests}' /tmp/w2-t2.json
```
Expected: the suite fails to collect — `Cannot find module '../fixture-row-action'`.
`numTotalTests: 0` here means **failed to collect**, not passed; that is the
expected red for this step and the only step where a zero is acceptable.

- [ ] **Step 3: Write the implementation**

```ts
// fixture-row-action.ts — the ONE authority for the single action a run-sheet
// row offers. Pure and client-safe: `import type` from @/server is erased, so
// this never drags server-only code into the client bundle.
//
// This is a LADDER: the first matching branch wins, so a rule's POSITION is
// part of its meaning and no grep can see it (_RULES.md, "the phase ladder is
// ORDER, not a set of predicates"). Do not reorder without reading
// fixture-row-action.test.ts's ORDER describe block, which exists to kill a
// reordering mutant.
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import type { FixtureRow } from "@/server/usecases/stages";

/** Statuses that mean "this match has an outcome" — not open work. Derived from
 *  the API status set (design §W1 `PhaseInput`), never retyped per call site. */
const SETTLED = new Set(["decided", "finalized", "abandoned", "forfeited", "cancelled"]);

export type RowAction =
  | { kind: "open_pad" }
  | { kind: "assign_scorer" }
  | { kind: "score" }
  | { kind: "result" }
  | { kind: "set_time" }
  | { kind: "view" };

export type RowActionInput = {
  status: FixtureRow["status"];
  scheduledAt: FixtureRow["scheduled_at"];
  /** Any officials recorded on the fixture — the "no scorer" signal. */
  hasOfficials: boolean;
  canEdit: boolean;
  /** The VENUE zone (`scheduleSettings.tz`), for both bucketing and printing.
   *  Never the org zone: one zone per fixture (_RULES.md). */
  tz: string;
  nowMs: number;
};

export function fixtureRowAction(input: RowActionInput): RowAction {
  const { status, scheduledAt, hasOfficials, canEdit, tz, nowMs } = input;

  // 1. Live beats everything. A match in play is the one thing an organiser
  //    standing at the venue is looking for, whatever its time says.
  if (status === "in_play") return { kind: "open_pad" };

  // 2. Settled. Checked before the scheduling rules below so a cancelled match
  //    never invites an organiser to score a match that will not be played.
  if (SETTLED.has(status)) return { kind: "result" };

  // 3. Anything not "scheduled" by now is a status this table does not know.
  //    Read-only rather than a guess — an invented action on an unknown state
  //    is how a wrong write path gets offered.
  if (status !== "scheduled") return { kind: "view" };

  // 4. Scheduled with no time: the missing fact IS the action.
  if (scheduledAt === null) return canEdit ? { kind: "set_time" } : { kind: "view" };

  // 5. Scheduled TODAY in the venue zone with nobody to score it. Not "any day
  //    with no scorer" — a fixture three weeks out with no scorer is not yet a
  //    problem, and printing it as one on every row is the noise this wave
  //    exists to remove ("an empty cell is not information").
  const today = dayKeyInTz(nowMs, tz);
  const day = dayKeyInTz(Date.parse(scheduledAt), tz);
  if (day === today && !hasOfficials) return { kind: "assign_scorer" };

  // 6. Otherwise: score it.
  return { kind: "score" };
}
```

- [ ] **Step 4: Run the test — expect green**

```bash
cd /path/to/worktree/apps/web && npx vitest run --reporter=json \
  --outputFile=/tmp/w2-t2.json src/lib/__tests__/fixture-row-action.test.ts
jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests,
     files: [.testResults[].name]}' /tmp/w2-t2.json
```
Expected: `failed: 0`, `total` ≥ 14, and every path in `files` inside your
worktree — not the main checkout (`AGENTS.md`: a verify run launched from a
worktree can silently execute on `main` and return a false green).

- [ ] **Step 5: Mutate the ladder — three mutants, one at a time**

A guard nothing kills is not tested, and two guards covering for each other are
each untested, so mutate them **individually**.

1. Move the `in_play` branch below the "scheduled today, no officials" branch.
   Expected: the two ORDER tests fail. If they pass, the order is untested.
2. Replace `SETTLED.has(status)` with `status === "decided"`.
   Expected: the abandoned/forfeited/cancelled test fails.
3. Change `day === today` to `true`.
   Expected: the "not today" and "23:30 the day before" tests fail.

Revert each mutant before applying the next. Record the three results in the task
report; a surviving mutant is a finding, not a footnote.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/fixture-row-action.ts \
        apps/web/src/lib/__tests__/fixture-row-action.test.ts
git commit -m "feat(desk): fixtureRowAction — one action per fixture state, order-pinned"
```

---

### Task 3: `buildRunSheet` — the grouping builder

**Files:**
- Create: `apps/web/src/lib/run-sheet-groups.ts`
- Test: `apps/web/src/lib/__tests__/run-sheet-groups.test.ts`

**Interfaces:**
- Consumes: `FixtureRow` (type-only), `dayKeyInTz` from
  `@seazn/engine/scheduling/tz` (`packages/engine/src/scheduling/tz.ts:72`,
  `dayKeyInTz(instantMs: number, tz: string): Ymd` where `Ymd = string` in
  `"YYYY-MM-DD"` form) — **already imported by `stages-panel.tsx:54`, so this is
  a reuse, not a new dependency**.
- Produces: `buildRunSheet(input: RunSheetInput): RunSheetBlock[]`, plus the
  exported `RunSheetBlock`, `RunSheetDayBlock`, `RunSheetBracketBlock`,
  `RunSheetUnscheduledBlock` types. Task 4 renders them; Task 8 asserts their
  rendered order.

**Ruling this task implements (quoted, per `_RULES.md`):** *"day groups are MERGED
across all non-bracket stages into one division-wide day spine … each bracket stage
is its own round-sectioned block, and ONE division-wide 'Not yet scheduled' group
closes the sheet."*

- [ ] **Step 1: Write the failing test**

```ts
// run-sheet-groups.test.ts — the division-wide grouping builder. Pure: no DB,
// no DOM. Fed in production by the division page's own `listDivisionFixtures`
// rows; run-sheet.spec.ts drives the same seam through the browser so the
// builder is proven by its REAL producer and consumer, not by a fixture on
// both ends (_RULES.md, "the inert seam").
import { describe, expect, it } from "vitest";
import { buildRunSheet, type RunSheetInput } from "../run-sheet-groups";

const TZ = "Europe/London";
const NOW = Date.UTC(2026, 8, 3, 13, 0); // 14:00 London, Thu 3 Sep

const LEAGUE = { id: "s1", seq: 1, kind: "league" };
const CUP = { id: "s2", seq: 2, kind: "knockout" };

function fx(over: Partial<RunSheetInput["fixtures"][number]> = {}) {
  return {
    id: "f1",
    stage_id: "s1",
    fixture_no: 1,
    round_no: 1,
    seq_in_round: 1,
    scheduled_at: "2026-09-03T14:00:00.000Z",
    status: "scheduled",
    ...over,
  };
}

function input(over: Partial<RunSheetInput> = {}): RunSheetInput {
  return { fixtures: [fx()], stages: [LEAGUE], tz: TZ, nowMs: NOW, ...over };
}

// THE EMPTY CASE, STATED FIRST. _RULES.md: "a rule set whose tests are all
// 'does the set contain X' needs an explicit empty case, stated FIRST — the
// empty set answers no to every question and lands on whatever the default
// is." Four vacuous-truth defects shipped in W1 from exactly this shape.
describe("buildRunSheet — the empty case", () => {
  it("no fixtures at all produces NO blocks — not an empty day, not a header", () => {
    expect(buildRunSheet(input({ fixtures: [] }))).toEqual([]);
  });

  it("no fixtures and no stages either still produces no blocks", () => {
    expect(buildRunSheet(input({ fixtures: [], stages: [] }))).toEqual([]);
  });

  it("a bracket stage with zero fixtures produces no bracket block", () => {
    const out = buildRunSheet(input({ fixtures: [], stages: [LEAGUE, CUP] }));
    expect(out).toEqual([]);
  });
});

describe("buildRunSheet — day groups merge across non-bracket stages", () => {
  it("two stages' fixtures on one day land in ONE day block", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, { id: "s3", seq: 2, kind: "league" }],
        fixtures: [
          fx({ id: "a", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "b", stage_id: "s3", scheduled_at: "2026-09-05T11:00:00.000Z" }),
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("day");
    expect(out[0].kind === "day" && out[0].fixtures.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("separate days are separate blocks, ascending", () => {
    const out = buildRunSheet(
      input({
        fixtures: [
          fx({ id: "late", scheduled_at: "2026-09-06T09:00:00.000Z" }),
          fx({ id: "early", scheduled_at: "2026-09-05T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.map((b) => b.kind === "day" && b.dayKey)).toEqual(["2026-09-05", "2026-09-06"]);
  });

  it("rows inside a day sort by time, then stage seq, then round, then seq_in_round", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, { id: "s3", seq: 2, kind: "league" }],
        fixtures: [
          fx({ id: "d", stage_id: "s3", scheduled_at: "2026-09-05T09:00:00.000Z", round_no: 1, seq_in_round: 1 }),
          fx({ id: "c", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z", round_no: 2, seq_in_round: 1 }),
          fx({ id: "b", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z", round_no: 1, seq_in_round: 2 }),
          fx({ id: "a", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z", round_no: 1, seq_in_round: 1 }),
        ],
      }),
    );
    expect(out[0].kind === "day" && out[0].fixtures.map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("buildRunSheet — the venue zone decides the day", () => {
  it("23:30 and 00:30 either side of local midnight are DIFFERENT days", () => {
    const out = buildRunSheet(
      input({
        fixtures: [
          fx({ id: "before", scheduled_at: "2026-09-02T22:30:00.000Z" }), // 23:30 on the 2nd
          fx({ id: "after", scheduled_at: "2026-09-02T23:30:00.000Z" }), // 00:30 on the 3rd
        ],
      }),
    );
    expect(out.map((b) => b.kind === "day" && b.dayKey)).toEqual(["2026-09-02", "2026-09-03"]);
  });

  it("the SAME instants in a different venue zone land on ONE day", () => {
    // Pacific/Auckland (+12): both are the 3rd there. This is the case that
    // fails if the builder ever reaches for the org zone instead.
    const out = buildRunSheet(
      input({
        tz: "Pacific/Auckland",
        fixtures: [
          fx({ id: "before", scheduled_at: "2026-09-02T22:30:00.000Z" }),
          fx({ id: "after", scheduled_at: "2026-09-02T23:30:00.000Z" }),
        ],
      }),
    );
    expect(out.filter((b) => b.kind === "day")).toHaveLength(1);
  });
});

describe("buildRunSheet — the NOW rule", () => {
  it("sits between the last row at or before now and the first after it", () => {
    const out = buildRunSheet(
      input({
        fixtures: [
          fx({ id: "past", scheduled_at: "2026-09-03T12:00:00.000Z" }),
          fx({ id: "future", scheduled_at: "2026-09-03T15:00:00.000Z" }),
        ],
      }),
    );
    expect(out[0].kind === "day" && out[0].nowIndex).toBe(1);
  });

  it("is absent from a day that is not today", () => {
    const out = buildRunSheet(input({ fixtures: [fx({ scheduled_at: "2026-09-05T09:00:00.000Z" })] }));
    expect(out[0].kind === "day" && out[0].nowIndex).toBeNull();
  });

  it("sits at the top when every row today is still to come", () => {
    const out = buildRunSheet(input({ fixtures: [fx({ scheduled_at: "2026-09-03T15:00:00.000Z" })] }));
    expect(out[0].kind === "day" && out[0].nowIndex).toBe(0);
  });

  it("sits at the end when every row today has been and gone", () => {
    const out = buildRunSheet(input({ fixtures: [fx({ scheduled_at: "2026-09-03T09:00:00.000Z" })] }));
    expect(out[0].kind === "day" && out[0].nowIndex).toBe(1);
  });

  it("appears on exactly ONE block, even when today has fixtures in two stages", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, { id: "s3", seq: 2, kind: "league" }],
        fixtures: [
          fx({ id: "a", stage_id: "s1", scheduled_at: "2026-09-03T12:00:00.000Z" }),
          fx({ id: "b", stage_id: "s3", scheduled_at: "2026-09-03T15:00:00.000Z" }),
          fx({ id: "c", scheduled_at: "2026-09-05T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.filter((b) => b.kind === "day" && b.nowIndex !== null)).toHaveLength(1);
  });
});

describe("buildRunSheet — bracket stages keep round sections (owner ruling A2)", () => {
  it("a knockout stage becomes its own block, NOT day-grouped", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          fx({ id: "lg", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "qf", stage_id: "s2", round_no: 1, scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    const bracket = out.find((b) => b.kind === "bracket");
    expect(bracket).toBeDefined();
    expect(bracket?.kind === "bracket" && bracket.stageId).toBe("s2");
    // and the knockout fixture is NOT also in a day block
    const inDays = out.flatMap((b) => (b.kind === "day" ? b.fixtures.map((f) => f.id) : []));
    expect(inDays).toEqual(["lg"]);
  });

  it("its rounds are sections in round order, each carrying its own rows", () => {
    const out = buildRunSheet(
      input({
        stages: [CUP],
        fixtures: [
          fx({ id: "sf", stage_id: "s2", round_no: 2, scheduled_at: "2026-09-06T11:00:00.000Z" }),
          fx({ id: "qf2", stage_id: "s2", round_no: 1, seq_in_round: 2, scheduled_at: "2026-09-06T09:00:00.000Z" }),
          fx({ id: "qf1", stage_id: "s2", round_no: 1, seq_in_round: 1, scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    const bracket = out.find((b) => b.kind === "bracket");
    expect(bracket?.kind === "bracket" && bracket.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(bracket?.kind === "bracket" && bracket.rounds[0].fixtures.map((f) => f.id)).toEqual(["qf1", "qf2"]);
  });

  it("two bracket stages produce two blocks, in stage seq order", () => {
    const out = buildRunSheet(
      input({
        stages: [CUP, { id: "s9", seq: 3, kind: "knockout" }],
        fixtures: [
          fx({ id: "b", stage_id: "s9", scheduled_at: "2026-09-06T09:00:00.000Z" }),
          fx({ id: "a", stage_id: "s2", scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.filter((b) => b.kind === "bracket").map((b) => b.kind === "bracket" && b.stageId))
      .toEqual(["s2", "s9"]);
  });
});

describe("buildRunSheet — block ORDER (kills a reorder mutant)", () => {
  // A case whose expected value differs between two candidate orderings:
  // chronological (this plan's decision) vs "brackets first". The cup here is
  // EARLIER than the league day, so only chronological puts it first.
  it("an earlier bracket block sorts above a later day block", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          fx({ id: "lg", stage_id: "s1", scheduled_at: "2026-09-10T09:00:00.000Z" }),
          fx({ id: "qf", stage_id: "s2", scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.map((b) => b.kind)).toEqual(["bracket", "day", "unscheduled"].slice(0, 2));
  });

  it("a LATER bracket block sorts below an earlier day block — the mirror case", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          fx({ id: "lg", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "qf", stage_id: "s2", scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.map((b) => b.kind)).toEqual(["day", "bracket"]);
  });
});

describe("buildRunSheet — the unscheduled group", () => {
  it("is ALWAYS last, even when its stage sorts first", () => {
    const out = buildRunSheet(
      input({
        fixtures: [
          fx({ id: "timed", scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "untimed", scheduled_at: null }),
        ],
      }),
    );
    expect(out[out.length - 1].kind).toBe("unscheduled");
  });

  it("collects unscheduled rows from EVERY stage, brackets included, into one group", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          fx({ id: "lg", stage_id: "s1", scheduled_at: null }),
          fx({ id: "cup", stage_id: "s2", scheduled_at: null }),
        ],
      }),
    );
    const tail = out.filter((b) => b.kind === "unscheduled");
    expect(tail).toHaveLength(1);
    expect(tail[0].kind === "unscheduled" && tail[0].fixtures.map((f) => f.id)).toEqual(["lg", "cup"]);
  });

  it("orders by stage seq, then round, then seq_in_round", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          fx({ id: "d", stage_id: "s2", round_no: 1, seq_in_round: 1, scheduled_at: null }),
          fx({ id: "c", stage_id: "s1", round_no: 2, seq_in_round: 1, scheduled_at: null }),
          fx({ id: "b", stage_id: "s1", round_no: 1, seq_in_round: 2, scheduled_at: null }),
          fx({ id: "a", stage_id: "s1", round_no: 1, seq_in_round: 1, scheduled_at: null }),
        ],
      }),
    );
    const tail = out[out.length - 1];
    expect(tail.kind === "unscheduled" && tail.fixtures.map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("a DECIDED fixture with no time is a result, not unscheduled (finding 3)", () => {
    // The current row prints "Unscheduled" on a decided match. A decided
    // fixture belongs to the day it was played on where one is known, and to
    // no group at all rather than the unscheduled pile where none is.
    const out = buildRunSheet(
      input({ fixtures: [fx({ id: "done", status: "decided", scheduled_at: null })] }),
    );
    const tail = out.find((b) => b.kind === "unscheduled");
    expect(tail?.kind === "unscheduled" && tail.fixtures.map((f) => f.id)).not.toContain("done");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/worktree/apps/web && npx vitest run --reporter=json \
  --outputFile=/tmp/w2-t3.json src/lib/__tests__/run-sheet-groups.test.ts
jq '{total, passed: .numPassedTests, failed: .numFailedTests}' /tmp/w2-t3.json
```
Expected: collection failure — `Cannot find module '../run-sheet-groups'`.

- [ ] **Step 3: Write the implementation**

```ts
// run-sheet-groups.ts — the division-wide run sheet's grouping builder.
// Pure, client-safe, no DB, no DOM.
//
// Owner rulings, 2026-09-03 (docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md):
//   A2 — "bracket stages keep their round sections. Every other stage kind is
//         day-grouped."
//   Skeleton — "day groups are MERGED across all non-bracket stages into one
//         division-wide day spine, each bracket stage is its own
//         round-sectioned block, and ONE division-wide 'Not yet scheduled'
//         group closes the sheet."
//
// The governing clock is the VENUE zone (`scheduleSettings.tz`) for BOTH
// bucketing and printing — amendment 4. Never the org zone: two zones in one
// row is the bug, wherever the seam is drawn (_RULES.md, "One zone per
// fixture").
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import type { FixtureRow } from "@/server/usecases/stages";

/** The fixture fields this builder reads, derived from the wire row rather
 *  than retyped — a hand-written twin is how DEFAULT_MATCH_MINUTES drifted. */
export type RunSheetFixture = Pick<
  FixtureRow,
  "id" | "stage_id" | "fixture_no" | "round_no" | "seq_in_round" | "scheduled_at" | "status"
>;

export type RunSheetStage = { id: string; seq: number; kind: string };

export type RunSheetInput = {
  fixtures: RunSheetFixture[];
  stages: RunSheetStage[];
  /** The VENUE zone. Amendment 4. */
  tz: string;
  nowMs: number;
};

export type RunSheetDayBlock = {
  kind: "day";
  /** "YYYY-MM-DD" in `tz` — the block's identity and its `data-run-sheet-day`. */
  dayKey: string;
  fixtures: RunSheetFixture[];
  /** Index of the first row after `nowMs`; the NOW rule renders before it.
   *  `fixtures.length` means "after every row". `null` means this day is not
   *  today and carries no rule at all. */
  nowIndex: number | null;
};

export type RunSheetBracketBlock = {
  kind: "bracket";
  stageId: string;
  stageSeq: number;
  rounds: { round: number; fixtures: RunSheetFixture[] }[];
};

export type RunSheetUnscheduledBlock = { kind: "unscheduled"; fixtures: RunSheetFixture[] };

export type RunSheetBlock = RunSheetDayBlock | RunSheetBracketBlock | RunSheetUnscheduledBlock;

/** Stage kinds that render as a bracket. Single authority — `stages-panel.tsx`
 *  imports this rather than keeping its own `BRACKET_KINDS`, so the sheet and
 *  the panel can never disagree about which stage is a bracket. */
export const BRACKET_STAGE_KINDS = new Set(["knockout", "double_elim", "consolation"]);

/** A settled fixture with no time is a RESULT, not open scheduling work —
 *  finding 3 ("'Unscheduled' on a decided match is noise"). */
const OPEN = new Set(["scheduled", "in_play"]);

export function buildRunSheet(input: RunSheetInput): RunSheetBlock[] {
  const { fixtures, stages, tz, nowMs } = input;

  // THE EMPTY CASE, FIRST. A sheet with no fixtures has no blocks — not an
  // empty day, not a bare header. The page renders the rail alone (spec,
  // "Error and empty states"). Every rule below is a "does the set contain X"
  // test, and the empty set answers no to all of them, so without this line
  // the answer is whatever the last branch happens to be (_RULES.md).
  if (fixtures.length === 0) return [];

  const seqOf = new Map(stages.map((s) => [s.id, s.seq]));
  const bracketStageIds = new Set(
    stages.filter((s) => BRACKET_STAGE_KINDS.has(s.kind)).map((s) => s.id),
  );
  const rank = (f: RunSheetFixture) =>
    [seqOf.get(f.stage_id) ?? Number.MAX_SAFE_INTEGER, f.round_no, f.seq_in_round] as const;
  const byRank = (a: RunSheetFixture, b: RunSheetFixture) => {
    const [as, ar, aq] = rank(a);
    const [bs, br, bq] = rank(b);
    return as - bs || ar - br || aq - bq;
  };

  const unscheduled: RunSheetFixture[] = [];
  const dayed: RunSheetFixture[] = [];
  const bracketed = new Map<string, RunSheetFixture[]>();

  for (const f of fixtures) {
    if (f.scheduled_at === null) {
      // Only OPEN work belongs in the unscheduled pile. A decided match with
      // no recorded time is a result nobody needs to schedule.
      if (OPEN.has(f.status)) unscheduled.push(f);
      continue;
    }
    if (bracketStageIds.has(f.stage_id)) {
      const list = bracketed.get(f.stage_id) ?? [];
      list.push(f);
      bracketed.set(f.stage_id, list);
      continue;
    }
    dayed.push(f);
  }

  const today = dayKeyInTz(nowMs, tz);
  const blocks: { at: number; seq: number; block: RunSheetBlock }[] = [];

  // Day blocks — merged across every non-bracket stage (owner ruling 3).
  const byDay = new Map<string, RunSheetFixture[]>();
  for (const f of dayed) {
    const key = dayKeyInTz(Date.parse(f.scheduled_at as string), tz);
    const list = byDay.get(key) ?? [];
    list.push(f);
    byDay.set(key, list);
  }
  for (const [dayKey, rows] of byDay) {
    rows.sort((a, b) => {
      const at = Date.parse(a.scheduled_at as string) - Date.parse(b.scheduled_at as string);
      return at !== 0 ? at : byRank(a, b);
    });
    // The NOW rule exists ONLY on today's block. `findIndex` returning -1 means
    // every row is at or before now, so the rule goes after the last one.
    let nowIndex: number | null = null;
    if (dayKey === today) {
      const first = rows.findIndex((f) => Date.parse(f.scheduled_at as string) > nowMs);
      nowIndex = first === -1 ? rows.length : first;
    }
    blocks.push({
      at: Date.parse(rows[0].scheduled_at as string),
      seq: Number.MAX_SAFE_INTEGER,
      block: { kind: "day", dayKey, fixtures: rows, nowIndex },
    });
  }

  // Bracket blocks — one per stage, rounds in round order (owner ruling A2).
  for (const [stageId, rows] of bracketed) {
    rows.sort(byRank);
    const rounds: RunSheetBracketBlock["rounds"] = [];
    for (const f of rows) {
      const last = rounds[rounds.length - 1];
      if (last && last.round === f.round_no) last.fixtures.push(f);
      else rounds.push({ round: f.round_no, fixtures: [f] });
    }
    rounds.sort((a, b) => a.round - b.round);
    const earliest = Math.min(...rows.map((f) => Date.parse(f.scheduled_at as string)));
    blocks.push({
      at: earliest,
      seq: seqOf.get(stageId) ?? Number.MAX_SAFE_INTEGER,
      block: { kind: "bracket", stageId, stageSeq: seqOf.get(stageId) ?? 0, rounds },
    });
  }

  // Chronological, with stage seq as the tie-break so two bracket blocks that
  // start at the same instant still read in stage order. This plan's decision,
  // not an owner ruling — see the plan's "Decisions taken by this plan".
  blocks.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const out: RunSheetBlock[] = blocks.map((b) => b.block);

  // The unscheduled group is ALWAYS last, whatever its stage seq.
  if (unscheduled.length > 0) {
    unscheduled.sort(byRank);
    out.push({ kind: "unscheduled", fixtures: unscheduled });
  }
  return out;
}
```

- [ ] **Step 4: Run the test — expect green**

```bash
cd /path/to/worktree/apps/web && npx vitest run --reporter=json \
  --outputFile=/tmp/w2-t3.json src/lib/__tests__/run-sheet-groups.test.ts
jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests,
     files: [.testResults[].name]}' /tmp/w2-t3.json
```
Expected: `failed: 0`, `total` ≥ 20, paths inside the worktree.

- [ ] **Step 5: Mutate — five mutants, one at a time**

1. Delete the `if (fixtures.length === 0) return [];` line.
   Expected: the three empty-case tests fail. If they still pass, the empty case
   is decoration and this task has reproduced W1's defect exactly.
2. Change `dayKeyInTz(..., tz)` to a UTC slice (`new Date(ms).toISOString().slice(0,10)`).
   Expected: the "23:30 / 00:30" and the Auckland test fail.
3. Change the block sort to `a.seq - b.seq || a.at - b.at` (brackets-first-ish).
   Expected: the "earlier bracket sorts above a later day" ORDER test fails.
4. Change `OPEN.has(f.status)` to `true`.
   Expected: the finding-3 test fails.
5. Change `nowIndex` to always compute (drop the `dayKey === today` guard).
   Expected: "absent from a day that is not today" and "appears on exactly ONE
   block" both fail.

Record all five outcomes. A surviving mutant is a finding.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/run-sheet-groups.ts \
        apps/web/src/lib/__tests__/run-sheet-groups.test.ts
git commit -m "feat(desk): buildRunSheet — venue-zone day spine, bracket blocks, unscheduled tail"
```

---

### Task 4: The run sheet renders

**Files:**
- Create: `apps/web/src/components/v2/desk/run-sheet.tsx`
- Create: `apps/web/src/components/v2/desk/run-sheet-row.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` — replace the
  `orderedRounds.map(...)` non-bracket list and the pinned per-stage unscheduled
  `<ul>` with one `<RunSheet>`; keep the `splitRounds` bracket sections for now
  (Task 4 step 6 folds them into the sheet's bracket blocks)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Modify: `apps/web/e2e/division-schedule.spec.ts` (the `round-dates` assertion)

**Interfaces:**
- Consumes: `buildRunSheet`, `RunSheetBlock` (Task 3); `fixtureRowAction`,
  `RowAction` (Task 2); `routes.fixture(org, comp, div, no)`
  (`apps/web/src/lib/routes.ts:58`); `ClientTime` from `@/components/client-time`;
  `DateTimeField` from `../shared/datetime-field`.
- Produces: `<RunSheet>` with props
  `{ blocks, tz, entrantNames, courtNames, canEdit, hrefFor, filter, onFilter, boardSlotOptions, venues, onRescheduled }`,
  and the DOM contract Task 8 asserts:
  - `[data-testid="run-sheet"]` on the sheet root
  - `[data-run-sheet-day="YYYY-MM-DD"]` on each day block
  - `[data-run-sheet-block="bracket|unscheduled"]` on the other two
  - `[data-fixture-no="<n>"]` on every row
  - `[data-row-action="open_pad|assign_scorer|score|result|set_time|view"]` on the
    row's single action control
  - `[data-testid="run-sheet-now"]` on the NOW rule, present at most once
  - `[data-testid="run-sheet-filter"]` on the segment, with
    `[data-filter="today|needs_result|unscheduled|all"]` per control

**New dictionary keys** (all four locales; every count through `plural()`):

```
runsheet.filter.today          runsheet.filter.needsResult
runsheet.filter.unscheduled    runsheet.filter.all
runsheet.day.fixtures.one / .other      ("{count} fixture" / "{count} fixtures")
runsheet.unscheduled.title
runsheet.now
runsheet.action.openPad        runsheet.action.assignScorer
runsheet.action.score          runsheet.action.result
runsheet.action.setTime        runsheet.action.view
runsheet.sub.noScorer          runsheet.sub.awaitingDraw
runsheet.round                 ("Round {n}")
```

- [ ] **Step 1: Write the failing test — the DOM contract, in e2e, not vitest**

`apps/web` vitest is `environment: "node"`: it cannot see this component at all.
`_RULES.md`: *"Pure-builder tests cannot see wiring … a green builder suite is
blind to stale closures and re-invocation, to CSS cascade, and to real tap area."*
So this task's failing test is the first block of `run-sheet.spec.ts`, written now
and completed in Task 8.

```ts
// apps/web/e2e/run-sheet.spec.ts
import { expect, test } from "@playwright/test";
import { createStageAndGenerate, divisionPath, setFixtureScheduledAtSql } from "./helpers";

test("the run sheet groups by venue day and prints the day, the time and the pitch", async ({ page, request }) => {
  // Setup ONLY from e2e/helpers.ts — never an invented request body. A probe
  // in W1 passed at every width because its setup calls had silently failed
  // (stages 400, generate 404, start 422) and the page was never in the state
  // under test. `createStageAndGenerate` (helpers.ts:1325) returns the ids.
  const divisionId = await createDivisionForTest(request); // helpers.ts — use the
  // existing division-seeding helper the neighbouring specs already call; grep
  // `divisionPath(` in e2e/ for the one in current use rather than adding a new one.
  const { fixtureIds } = await createStageAndGenerate(request, divisionId);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet")
    .toBeGreaterThanOrEqual(3);
  // Times relative to real now — NOT page.clock, which has zero uses in this
  // repo. Two rows before now and one after, all today.
  const now = Date.now();
  await setFixtureScheduledAtSql(fixtureIds[0], new Date(now - 90 * 60_000).toISOString());
  await setFixtureScheduledAtSql(fixtureIds[1], new Date(now - 30 * 60_000).toISOString());
  await setFixtureScheduledAtSql(fixtureIds[2], new Date(now + 90 * 60_000).toISOString());

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const sheet = page.getByTestId("run-sheet");
  await expect(sheet).toBeVisible();

  // PRINT WHAT WAS SEEN beside the gate — _RULES.md: "A green gate on the
  // wrong state is worse than a red one." A probe here once passed at every
  // width on a page that was never in the state under test.
  const dayKeys = await sheet.locator("[data-run-sheet-day]").evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-run-sheet-day")),
  );
  console.log("run sheet day keys:", dayKeys);
  expect(dayKeys, `expected one day group, saw ${JSON.stringify(dayKeys)}`).toHaveLength(1);

  // The NOW rule sits between the 30-minutes-ago row and the 90-minutes-hence
  // row: exactly one rule, and the row after it is the future one.
  await expect(sheet.getByTestId("run-sheet-now")).toHaveCount(1);
});
```

- [ ] **Step 2: Run it and watch it fail for the RIGHT reason**

```bash
cd /path/to/worktree/apps/web && npx playwright test e2e/run-sheet.spec.ts --project=parallel
```
Expected: fails on `getByTestId("run-sheet")` not being visible — **not** on a
seeding 400/404/422. Read the failure text: `_RULES.md` records a probe whose setup
calls silently failed (stages 400 on a wrong body shape, generate 404 on a wrong
route, start 422) while every width passed cleanly. Build setup only from
`e2e/helpers.ts` (`createStageAndGenerate`, `:1325`), never an invented body shape.

- [ ] **Step 3: Write `run-sheet-row.tsx`**

One row. The action is whatever `fixtureRowAction` says and nothing else — no chip
stack, no second link. Anatomy per spec: `court + round` · `home v away` ·
`score/result + sub-line` · ONE action.

```tsx
"use client";

// One run-sheet row. The SINGLE action comes from fixtureRowAction — this
// component never decides it, so the table cannot be restated here and drift
// (the K3/M1 hand-copied-predicate defect W1 paid for twice).
import Link from "@/components/ui/console-link";
import { ClientTime } from "@/components/client-time";
import { useMsg } from "@/components/i18n/dict-provider";
import { fixtureRowAction, type RowActionInput } from "@/lib/fixture-row-action";
import type { RunSheetFixture } from "@/lib/run-sheet-groups";

export function RunSheetRow({ fixture, href, tz, nowMs, home, away, courtLabel, hasOfficials, canEdit, subLine, onSetTime }: {
  fixture: RunSheetFixture;
  href: string;
  tz: string;
  nowMs: number;
  home: string;
  away: string;
  courtLabel: string | null;
  hasOfficials: boolean;
  canEdit: boolean;
  subLine: string | null;
  onSetTime: () => void;
}) {
  const msg = useMsg();
  const action = fixtureRowAction({
    status: fixture.status,
    scheduledAt: fixture.scheduled_at,
    hasOfficials,
    canEdit,
    tz,
    nowMs,
  } satisfies RowActionInput);
  // ... render: time cell (mono, tabular-nums; em-dashes when null), court +
  // round label, entrants, sub-line, then ONE control carrying
  // data-row-action={action.kind}. `set_time` renders a button that calls
  // onSetTime; every other kind renders a <Link href={href}>.
}
```

Full markup requirements — each is a defect this repo has already paid for:

- The row root carries `data-fixture-no={fixture.fixture_no}`.
- The time cell is `font-variant-numeric: tabular-nums` mono so the spine lines up.
- **`truncate` needs `min-w-0` on the WHOLE ancestor chain**, not just the span —
  a missing one put 106px of horizontal overflow on the page at 320-390, visible
  only with a realistic 43-character entrant name and only in a browser.
- The action control is `min-h-11` (≥44px) — and Task 8 hit-tests it with
  `elementFromPoint`, not `boundingBox()`, because a control can measure 44px and
  still be untappable under an overlay.
- No `data-*` probe is written bare: React serialises an omitted prop as
  `"$undefined"`, so assertions anchor on `="`.

- [ ] **Step 4: Write `run-sheet.tsx`**

Renders the filter segment, then `blocks.map(...)` over `RunSheetBlock[]`:

- `day` → header `<h3 data-run-sheet-day={dayKey}>` reading
  "Saturday 5 September · {venue} · {plural(dict, "runsheet.day.fixtures", n)}",
  then rows, with the NOW rule spliced in at `nowIndex` when it is not null.
  Suppress the venue clause entirely when the day's rows span more than one venue
  or none is known — *"an empty cell is not information."*
- `bracket` → `<section data-run-sheet-block="bracket">`, one sub-header per round
  using the existing `bracketRoundLabel(msg, stage.kind, round, stageFixtures)`
  (already in `stages-panel.tsx` — export it rather than writing a second labeller),
  then rows.
- `unscheduled` → `<section data-run-sheet-block="unscheduled">` with
  `msg("runsheet.unscheduled.title")` and rows whose action is `set_time`. **No CTA
  here** — owner ruling B1 puts Solve on the rail.

Filter semantics (spec): `Today` · `Needs result (n)` · `Unscheduled (n)` · `All`;
default `Today` when `phase === "match_day"`, else `All`; **unknown `filter` param is
treated as All** (spec, "Error and empty states"). Filtering removes rows, then
removes any block left empty — a day header over zero rows is the "empty cell"
defect in another costume.

- [ ] **Step 5: Wire it into `stages-panel.tsx`**

Replace, inside the stage loop:
- the `splitRounds ? null : (<div>…orderedRounds.map…</div>)` non-bracket list, and
- the `{unscheduled.length > 0 && (<div>…)}` pinned section's `<ul>` of `FixtureLine`
  (the section's CTA and capacity reason move to the rail in Task 5 — until then,
  leave them in place so `capacity-precheck.spec.ts` stays green through this task),

with a single `<RunSheet>` mounted **once, outside the stage loop**, fed by
`buildRunSheet({ fixtures, stages, tz, nowMs: Date.now() })`.

`nowMs` on a server-rendered page: compute it in the client component's render, not
at module scope — a module-scope `Date.now()` freezes at first import and the NOW
rule would stick to the deploy time.

- [ ] **Step 6: Fold the bracket sections into the sheet's bracket blocks**

Delete the `{splitRounds && rounds.map(...)}` sibling sections. Their round headers
(`data-testid="round-dates"`, the second of the file's two) are replaced by the
bracket block's own round sub-headers.

- [ ] **Step 7: Re-anchor `division-schedule.spec.ts:88`**

Currently `await expect(page.getByTestId("round-dates").first()).toContainText("15");`.
That testid is gone. **Do not weaken the assertion to match the new markup** — re-aim
it at what the organiser now sees: the day group the fixture actually landed in.

```ts
// The round-dates bar is retired with the run sheet (W2). The fact this test
// was protecting — that a scheduled fixture prints its date where the
// organiser reads it — now lives on the day group header.
await expect(page.locator('[data-run-sheet-day="2026-09-15"]')).toBeVisible();
```
Re-derive the expected day key from whatever date the test seeds; do not type a
constant that the seed can drift away from.

- [ ] **Step 8: Dictionary keys, all four locales, then regenerate**

Add the key list above to `en`, `es`, `fr`, `nl`. Real translations, never the
English copied. Note the `fr` file indents two spaces inside the object and `en`
does not. Then:

```bash
npm run i18n:gen-keys && npm run i18n:check
```
Expected: `i18n:check` clean. `i18n-keys.ts` is GENERATED — never hand-edit it.

- [ ] **Step 9: Run the gates**

```bash
cd /path/to/worktree/apps/web && npx vitest run --reporter=json \
  --outputFile=/tmp/w2-t4.json src/lib src/components/v2
jq '{total: .numTotalTests, failed: .numFailedTests, files: [.testResults[].name]}' /tmp/w2-t4.json
npx playwright test e2e/run-sheet.spec.ts e2e/division-schedule.spec.ts --project=parallel
```
Expected: vitest `failed: 0`; both specs green. Re-run `division-schedule.spec.ts`
three times — `_RULES.md`: re-run a flaky-shaped gate three times before believing it.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/v2/desk/run-sheet.tsx \
        apps/web/src/components/v2/desk/run-sheet-row.tsx \
        apps/web/src/components/v2/stages-panel.tsx \
        apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts \
        apps/web/e2e/run-sheet.spec.ts apps/web/e2e/division-schedule.spec.ts
git commit -m "feat(desk): the fixtures tab renders as a run sheet on a time spine"
```

---

### Task 5: The stage rail, and every stage action moves onto it

**Files:**
- Create: `apps/web/src/lib/stage-progress.ts`
- Create: `apps/web/src/lib/__tests__/stage-progress.test.ts`
- Create: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` — becomes the two-column
  host; the stage `<header>` chrome, the pinned unscheduled section's CTA and
  capacity reason, the `DocumentsMenu` mount and the tz caption all move
- Modify: `apps/web/e2e/capacity-precheck.spec.ts`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`

**Interfaces:**
- Consumes: `stageProgress` (this task); `capacityGateBlocks`
  (`stages-panel.tsx:308`, already exported); `autoScheduleStage`, `act(stage.id,
  "generate"|"complete"|"delete")`, `setAddingTo`, `busy`, `confirmDialog` — all
  passed down as props from `StagesPanel`, which keeps owning the handlers.
- Produces: `<StageRail>` and the DOM contract:
  `[data-testid="stage-rail"]`, `[data-testid="stage-rail-card"][data-stage-id]`,
  `[data-testid="stage-auto-schedule"]` and
  `[data-testid="stage-auto-schedule-blocked"]` (**the same two testids as today** —
  they move, they are not renamed, so `capacity-precheck.spec.ts` re-anchors by
  scope rather than by name).

**Ruling this task implements (quoted):** *"All stage chrome moves to the rail —
Add match, Generate/Pair next, Complete stage, Delete stage, Required court tags,
auto-schedule and Compute proposal. The left column becomes purely the sheet."*

- [ ] **Step 1: Write the failing test for `stageProgress`**

The spec: *"Steps list derived, not typed: entrants confirmed → fixtures generated
→ n of m scheduled → n of m played → complete. Each step's tick state comes from
the same numbers the status line uses, so the two cannot disagree."*

`listDivisionCardStats` is per-DIVISION and this is per-STAGE, so the shared
derivation is this function — and every consumer reads it. A hand-copied twin is
the exact K3/M1 Critical W1 shipped twice.

```ts
// stage-progress.test.ts — the ONE per-stage derivation. If the rail and any
// status line ever disagree about "9 of 15 played", it is because something
// stopped calling this.
import { describe, expect, it } from "vitest";
import { stageProgress, type StageProgressInput } from "../stage-progress";

const PLAYED = ["decided", "finalized"];

function fx(over: Partial<StageProgressInput["fixtures"][number]> = {}) {
  return { stage_id: "s1", status: "scheduled", scheduled_at: null, ...over };
}

describe("stageProgress — the empty case first", () => {
  it("a stage with no fixtures reports zeros and NO generated tick", () => {
    const out = stageProgress({ stage: { id: "s1", status: "pending" }, entrants: 0, fixtures: [] });
    expect(out.total).toBe(0);
    expect(out.steps.find((s) => s.key === "generated")?.done).toBe(false);
    // and crucially not "complete" — an empty set satisfies "every fixture is
    // played" vacuously, which is amendment 2's defect one level down.
    expect(out.steps.find((s) => s.key === "played")?.done).toBe(false);
  });
});

describe("stageProgress — counts", () => {
  it("counts scheduled and played over the stage's OWN fixtures only", () => {
    const out = stageProgress({
      stage: { id: "s1", status: "active" },
      entrants: 12,
      fixtures: [
        fx({ scheduled_at: "2026-09-05T09:00:00.000Z", status: "decided" }),
        fx({ scheduled_at: "2026-09-05T11:00:00.000Z" }),
        fx(),
        fx({ stage_id: "s2", status: "decided" }), // another stage — ignored
      ],
    });
    expect(out).toMatchObject({ total: 3, scheduled: 2, played: 1 });
  });

  it("derives PLAYED from the same status set the desk counts with, not a literal", () => {
    for (const status of PLAYED) {
      const out = stageProgress({
        stage: { id: "s1", status: "active" },
        entrants: 2,
        fixtures: [fx({ status })],
      });
      expect(out.played, status).toBe(1);
    }
  });
});
```

- [ ] **Step 2: Run it, watch it fail, then implement**

`stageProgress` derives `played` from `division-phase.ts`'s own PLAYED set (import
it; do not retype the statuses) and returns
`{ total, scheduled, played, steps: { key, label, done }[] }`.

- [ ] **Step 3: Build `stage-rail.tsx`**

One card per stage in `seq` order; the active stage expanded. Card contents:
- Heading `{stage.seq}. {stage.name}` + the stage status badge (reuse
  `stageStatusLabel`/`stageStatusStyle` from `stages-panel.tsx` — export them
  rather than writing second copies).
- The derived step list from `stageProgress`.
- Buttons: **Add match**, **Schedule board**, **More ▾** (Generate/Pair next,
  Complete stage, Delete stage, Required court tags). The Delete confirm keeps
  using `confirmDialog` with the existing `confirm.deleteStage.*` keys.
- The **auto-schedule CTA** with its existing testid and disabled predicate
  verbatim — `disabled={busy !== null || capacityGateBlocks(capacityByStage.get(stage.id))}`
  — and the capacity-blocked reason under it with `data-testid="stage-auto-schedule-blocked"`.
- **Required court tags** hidden entirely when the stage has no tags (spec).

Plus two rail cards that are not per-stage, below the stage cards:
- **"Up next"** — the single next scheduled/`in_play` fixture, derived from the
  SAME ordering `card-stats`'s `next` lateral uses (`(status='in_play') desc,
  scheduled_at asc nulls last, round_no, seq_in_round`, TBD slots excluded) and
  from the same expression Task 7's masthead CTA reads. One derivation, two
  consumers — never two. Suppressed entirely when there is no next fixture; an
  "Up next: —" card is the empty cell the rules forbid.
- **Documents** — `<DocumentsMenu divisionId={…} competitionId={…} />` moves here
  verbatim from `stages-panel.tsx:774`, behind the same `canExport` gate.

And the `schedule.tz.caption` paragraph (`data-testid="tz-caption"`,
`stages-panel.tsx:770`) moves to the run sheet, under the filter segment (spec) —
not to the rail. Keep the testid; `tz-caption` is asserted elsewhere.

- [ ] **Step 4: Make `stages-panel.tsx` the two-column host**

Root becomes `lg:grid lg:grid-cols-[1fr_280px]` per spec. Below `lg` the rail
stacks under the sheet — W2 is desktop-only by ruling, so this is a stack, not a
bottom sheet, and no floating "Stage tools" button ships in this wave.

Delete from the panel: the stage `<section className="card">` wrapper and its
`<header>` with the Generate / Add match / Complete / Delete buttons; the pinned
unscheduled section entirely; the `<StageCourtTagsEditor>` mount at the card foot;
the `<DocumentsMenu>` mount; the `data-testid="tz-caption"` paragraph (it moves
under the filter segment per spec).

Keep in the panel: every handler (`act`, `autoScheduleStage`, `AddMatchForm`,
`setAddingTo`), the notice/undo strip, the roster-drift banner, the tip callout.

- [ ] **Step 5: Re-anchor `capacity-precheck.spec.ts`**

The two testids did not change, so the spec's four lines
(`:97`, `:100`, `:136`, `:137`) still resolve — but confirm they resolve **inside
the rail**, not to a stale duplicate:

```ts
const rail = page.getByTestId("stage-rail");
const solveButton = rail.getByTestId("stage-auto-schedule");
await expect(rail.getByTestId("stage-auto-schedule-blocked")).toBeVisible();
```
Then **verify the assertion is REACHABLE**: `_RULES.md` records three W1 regression
guards that were enumerated correctly by a reviewer and still could not fail,
because they asserted the absence of a string this page no longer renders. Delete
the rail mount temporarily and confirm this spec goes red.

- [ ] **Step 6: Run the gates and commit**

```bash
cd /path/to/worktree/apps/web && npx vitest run --reporter=json \
  --outputFile=/tmp/w2-t5.json src/lib src/components/v2
jq '{total: .numTotalTests, failed: .numFailedTests}' /tmp/w2-t5.json
npx playwright test e2e/capacity-precheck.spec.ts e2e/run-sheet.spec.ts \
  e2e/stage-roster-drift.spec.ts e2e/knockout.spec.ts --project=parallel
```
Sweep by BEHAVIOUR, not filename — grep the e2e tree for `stage-auto-schedule`,
`round-dates`, `schedule.complete` and `stage.addMatch` and run every spec that
hits one, not just the ones whose names look related.

```bash
git add apps/web/src/lib/stage-progress.ts apps/web/src/lib/__tests__/stage-progress.test.ts \
        apps/web/src/components/v2/desk/stage-rail.tsx \
        apps/web/src/components/v2/stages-panel.tsx \
        apps/web/e2e/capacity-precheck.spec.ts apps/web/src/dictionaries
git commit -m "feat(desk): stage rail owns every stage action; sheet is read-only"
```

---

### Task 6: "Compute proposal" moves onto the rail

**Files:**
- Modify: `apps/web/src/components/v2/progression-panel.tsx` (`ProgressionPanel`
  at `:196`, `recompute()` at `:224`, `confirm()` at `:252` POSTing
  `/api/v1/stages/${stageId}/seed-proposal/confirm` at `:258`)
- Modify: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Test: `apps/web/e2e/run-sheet.spec.ts` (new case)

**Ruling:** *"'Compute proposal' appears as the primary button on a stage whose
`needsProposal` is true (moves in from `progression-panel.tsx`'s top card; the
panel's confirm flow is reused unchanged)."*

- [ ] **Step 1: Write the failing e2e case**

Seed the U16-Cup shape (league complete, finals stage pending its draw), assert the
rail's stage-2 card carries the primary "Compute proposal" button, click it, and
assert the confirm flow appears — the SAME flow, not a second one.

Two traps, both of which made this exact button look broken in W1:
- the desk renders dual mobile/desktop DOM, so an unqualified locator resolves to
  the hidden variant — use `:visible`;
- `waitForLoadState("networkidle")` can resolve BEFORE a client-side navigation
  begins — use `waitForURL`.
Dismiss the cookie banner deterministically; a `try/catch` click with a short
timeout leaves it overlaying the control.

- [ ] **Step 2: Move the button, keep the flow**

The rail renders the trigger; `recompute()` and `confirm()` stay in
`progression-panel.tsx` and are reached through a prop or a shared hook. **Do not
copy them.** If the panel's top card is left rendering its own trigger as well, the
control set is duplicated — which is exactly what Task 9's control-set diff exists
to catch.

- [ ] **Step 3: Prove the seam through its REAL producer and consumer**

`_RULES.md`: *"A seam is proven only by driving it through its REAL producer and
consumer … a fixture on both ends proves the fixture."* Six inert seams shipped in
this repo despite being named explicitly each time. Click the rail's button in the
browser and assert a `seed-proposal/confirm` request actually leaves the page
(`page.waitForRequest`), then that the fixtures appear in the run sheet after it.

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(desk): Compute proposal moves to the stage rail, same confirm flow"
```

---

### Task 7: Masthead, tab counts, and the `filter` param

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx`
  (masthead ~`:389-396`; `searchParams` type at `:82`; tab parsing `:98-120`)
- Modify: `apps/web/src/components/v2/desk/run-sheet.tsx` (reads the filter)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`

- [ ] **Step 1: Widen `searchParams`**

```ts
searchParams: Promise<{ tab?: string; filter?: string }>;
```
Destructure `filter: rawFilter` beside `tab: rawTab`, and pass a validated value
down. **An unknown `filter` is treated as All** (spec) — and that has to be a
branch with a test, not an implicit fallthrough.

- [ ] **Step 2: One-row masthead with a phase-driven primary CTA**

Per spec: title + phase pill + status line; tools right = Slideshow ↗ ·
Registration · one primary CTA by phase —
`setting_up`: the `LaunchActions` primary as today;
`match_day`: "Score next: A v B" → `routes.fixture` of the next scheduled/in_play row;
`scheduled`: "Schedule board";
`finished`: none.

The "next" row is the same one `card-stats`'s `next` lateral already computes
(`card-stats.ts`, ordered `(status='in_play') desc, scheduled_at asc nulls last,
round_no, seq_in_round`, and excluding TBD slots). Derive it from the page's own
`fixtures` array with that ordering expressed once — never a fourth copy.

**Never let a verb agree with an interpolated name**: "Score next: {home} v {away}"
is safe; "{home} plays next" is not.

- [ ] **Step 3: Tab strip counts**

Fixtures, entrants, discipline — all three already in scope from the page's
`Promise.all` (`page.tsx:124`). No new query. Counted labels go through `plural()`.
Suppress a zero rather than print it.

- [ ] **Step 4: E2E — the filter param round-trips**

Assert `?tab=fixtures&filter=unscheduled` lands with the Unscheduled segment
selected and only the unscheduled block rendered; that clicking a segment updates
the URL; and that `?filter=banana` renders All rather than an empty sheet.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(desk): one-row masthead with a phase CTA, tab counts, filter param"
```

---

### Task 8: The full test set — e2e, smoke, mobile, regression, help

**Files:**
- Modify: `apps/web/e2e/run-sheet.spec.ts` (complete it)
- Modify: `apps/web/e2e/mobile.spec.ts`
- Modify: `scripts/smoke.ts`
- Create: `apps/web/content/help/scheduling/run-sheet.md` (English only)
- Modify: `apps/web/src/lib/help.ts` (`HELP_ARTICLE_SLUGS`)

- [ ] **Step 1: Complete `run-sheet.spec.ts`**

Cases, each printing what it saw beside its assertion:
1. Day grouping and the NOW rule (Task 4 step 1, already written).
2. **"Set time" on an unscheduled row moves it into a day group** — the seam
   driven end to end: click, fill `DateTimeField`, save, assert the row leaves
   `[data-run-sheet-block="unscheduled"]` and appears under the right
   `[data-run-sheet-day]`.
3. **"Open pad" opens the fixture console** — set a fixture `in_play` via the API,
   assert `[data-row-action="open_pad"]`, click, `waitForURL` the fixture route.
4. Filter param round-trip (Task 7).
5. **A2:** a knockout stage renders `[data-run-sheet-block="bracket"]` with its
   rounds in order, and its fixtures do NOT appear in any day block.
6. **Ordering:** a division with a league day and a cup day renders them in
   chronological order — the case that differs between the two candidate orderings.

- [ ] **Step 2: Regression cases (the three named findings)**

- **Finding 3:** a decided fixture renders no "Unscheduled" chip. Assert on the
  rendered row's text, and confirm the assertion is REACHABLE by temporarily
  reinstating the chip and watching it go red — three W1 guards asserted the
  absence of a string the page no longer rendered at all.
- **Finding 5:** stage 1 renders above stage 2 (in the rail now).
- **Finding 4:** the start-locks tip is absent on `finished`. This guards W1 code
  (`stages-panel.tsx`, `canEdit && phase === "setting_up" && !hasPlayedFixture(fixtures)`);
  mutate the gate to `return true` and confirm the test fails.

- [ ] **Step 3: Mobile — seven widths**

Add run-sheet cases to `mobile.spec.ts` at 320/360/375/390/430/768/834. Reuse
`overflowingIn` (`:91`) — and note its contract: an overflow whose extra content is
REACHABLE (computed `overflow-x` of `auto`/`scroll`) is a feature; one inside an
`overflow-hidden` box is a defect. **Assert that every box you excuse is the
reachable kind**, or the next overflow hides behind the exemption. Any new
scrolling region owes `tabindex="0"` plus a role and an accessible name or axe reds
at SERIOUS impact.

Tap targets: hit-test with `elementFromPoint` at the element's centre
(`mobile.spec.ts:207-213`), never `boundingBox()`.

W2 is desktop-only, so the phone bar here is: **no horizontal scroll, nothing
clipped, every action tappable** — not a designed phone composition. Do not add a
control-set assertion that would lock in a shrink; W3 owns that.

- [ ] **Step 4: Smoke step**

Copy the shape at `scripts/smoke.ts:1176-1179`:

```ts
const runSheet = await html(newSession(), `/o/${org}/c/${comp}/d/${div}?tab=fixtures`);
check(
  "p56: fixtures tab renders the run sheet with a day group",
  runSheet.status === 200 && runSheet.body.includes('data-run-sheet-day="'),
);
```
Anchor on `="` — React serialises an omitted prop as `"$undefined"`, so a bare
`data-run-sheet-day` probe passes in both states.

- [ ] **Step 5: Help article**

`apps/web/content/help/scheduling/run-sheet.md`, English only, and add
`"scheduling/run-sheet"` to `HELP_ARTICLE_SLUGS` in `apps/web/src/lib/help.ts` —
`help-content.test.ts` proves the registry and the files on disk agree in BOTH
directions, so one without the other is red.

- [ ] **Step 6: Run everything and commit**

```bash
cd /path/to/worktree/apps/web
npx vitest run --reporter=json --outputFile=/tmp/w2-t8.json
jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests}' /tmp/w2-t8.json
npx playwright test e2e/run-sheet.spec.ts --project=parallel
npx playwright test e2e/mobile.spec.ts --project=mobile-320 --project=mobile-360 \
  --project=mobile-se --project=mobile-14 --project=mobile-430 \
  --project=tablet-768 --project=tablet-834
```
**Run the whole `mobile.spec.ts` file, never a `-g` slice** — a `-g` sweep is a
filename sweep in a costume, and six green local gates once selected neither of the
two tests the change actually broke. And `mobile.spec.ts` runs
`describe.configure({ mode: "serial" })`: the first red aborts the rest, so treat a
failure count as a FLOOR and re-run after each fix until a full pass completes.

---

### Task 9: Customer walkthrough — an organiser runs a match day off this sheet

Not a test run. Drive the product as the customer and write down what you SAW.
`_RULES.md`: *"Every defect that mattered in W1 was found by loading a page and
reading it … none was found by a suite, and several survived suites that were
green, mutation-tested and reviewed."*

**Files:**
- Create: `docs/superpowers/specs/2026-09-02-competition-desk-prompts/W2-walkthrough.md`

- [ ] **Step 1: Stand up a real environment**

Follow the `seazn-local-env` skill. `db:apply` alone is NOT a fresh schema — it
needs `sync:sports`. Confirm `show data_directory` is yours before trusting a
`createdb` that "succeeded". Environment before defect: reproduce on a clean
detached worktree before calling any red pre-existing.

- [ ] **Step 2: Walk the golden path, clicking everything**

A six-team league plus a cup, from unscheduled through match day to finished:
set a time, auto-schedule the rest, assign a scorer, open the pad, score, decide,
compute the cup proposal, confirm it, schedule the semis, finish. Fill every field,
submit every form. Reachable ≠ used.

- [ ] **Step 3: Walk the edges**

Empty division (no stages) · a stage with no fixtures · an unknown `?filter=` ·
double-submit on Set time · back-nav mid-flow out of the pad · a 43-character
entrant name · a day spanning two venues · a division whose venue zone differs from
its org zone (the amendment-4 case — a fixture at 23:30 local must sit under the
right day header AND print the right time).

- [ ] **Step 4: Read what renders, at three widths, driven live at each**

1280, 768, 320. Zoom into the component, not full-page — full-page shots hide
alignment, duplication and truncation defects, and the owner found several that way
after a full-page shot had been signed off. Confirm the screenshots exist, DIFFER
from one another, and that the last one was taken AFTER the state being proven.

- [ ] **Step 5: Answer the plain questions in writing**

For every screen: does the day header's count match the rows under it? Does the NOW
rule sit where the clock says? Does any row show two contradicting facts? Is the
chronological block order (this plan's decision, not an owner ruling) the order the
owner expects — or should brackets come first?

- [ ] **Step 6: Write per-screen verdicts, then commit**

*"Sign-off means per-screen verdicts. 'CI green' / 'no gaps' was taken as merge
sign-off twice. It is not."* Findings go to the file, not to chat.

---

### Task 10: Wave gate

- [ ] **Step 1: Full suites from the worktree, JSON only**

```bash
cd /path/to/worktree/apps/web
npx vitest run --reporter=json --outputFile=/tmp/w2-gate.json
jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests,
     suites: (.testResults | length)}' /tmp/w2-gate.json
```
Confirm `.testResults[].name` paths are inside the worktree. A vitest run from a
worktree root once reported `numFailedTests: 0` while 25 suites failed to COLLECT;
`--root apps/web` loses 208 tests and invents 21 ENOENT failures. `cd apps/web &&
vitest` is the form.

- [ ] **Step 2: Lint and types, through `rtk proxy`**

`rtk` hides `npm run lint` output entirely and prints "tsc clean" while tsc exits 1.
Use `rtk proxy` and read `✖ N problems` and the real exit code.

- [ ] **Step 3: Full e2e sweep by behaviour**

Grep the e2e tree for `?tab=fixtures`, `stage-auto-schedule`, `round-dates`,
`data-run-sheet-day`, `data-fixture-no`, `schedule.complete`, `stage.addMatch` and
run every spec that hits one — all 11 `?tab=fixtures` specs at minimum. Not a
filename filter, not a `-g` slice.

- [ ] **Step 4: OpenAPI drift**

`npm run openapi:gen` — a `ci.yml` step, not a pre-commit hook. W2 adds no endpoint,
so this should be a no-op; confirm that it is.

- [ ] **Step 5: The final whole-branch review**

Run it **even though every task review was clean**. In W1 a task review returned
Approved with all three product mutations killing tests, live e2e green and nine
screenshots opened — and still missed both the Critical and three unreachable
assertions. The final whole-branch review found them by driving the product.

- [ ] **Step 6: Push and open the PR**

`.github/workflows/e2e.yml` triggers on **push to `main` only** — opening a PR runs
no e2e, ever, until it merges. `workflow_dispatch` with its `pr` input is the only
way to get an e2e run against this branch beforehand; **use it.** Smoke CI is the
mirror image: PRs only. Re-read `e2e.yml` rather than trusting this paragraph — its
trigger has changed three times in one day before now.
