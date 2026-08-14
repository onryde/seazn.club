# P7 (D1b) multi-stage templates — task briefs, handed over

P7 was started on 2026-08-14 and **held by the owner mid-session**. No P7
code shipped. These are the five task briefs as they were written, after a
full scout re-pin against live code at `cdcc3bef`.

They are committed here rather than left in the session's SDD workspace
because `.superpowers/` is gitignored — a handover that lives there is
deleted the moment the worktree goes.

**Read the P7 section of
`docs/superpowers/specs/bench-product-value/portfolio-prompts/_INDEX.md`
first** — it carries the rulings these briefs assume. The two that matter
most, because a fresh session will otherwise re-derive them wrongly:

1. **Instantiation must NOT generate fixtures** (T3). The P07 prompt says
   it should. Doing so format-locks a template-created competition at
   birth, via both `replaceStages` AND `patchDivision`.
2. **`page_playoff` IS DB-checked** (V298), so the format-templates design
   doc's fallback to `knockout(4)` for `league-playoff` is stale.

One correction to the T5 brief below, which was written before main
changed on 2026-08-14: it says `.github/workflows/e2e.yml` is disabled and
must never be enabled. **That is now false** — e2e is LIVE on pull
requests, six Playwright jobs including the seven-width matrix. Local
verification is still useful, but CI is the arbiter. Ignore that paragraph.

---



---

# T1+T2 — `TemplateStage.seeding` and the three multi-stage catalog entries

Your requirements. Every value here is verbatim-exact; use these, not your
own judgement on naming, numbers, or keys.

These are one task because T2 cannot parse without T1, and T1 is a single
optional field.

## T1 — the schema field

`apps/web/src/server/templates/schema.ts:51-73` declares `TemplateStage`.
Lines `:22-25` are an explicit comment reserving the field for this session:

    // No `seeding` field yet on TemplateStage — that lands in P7 with D4's
    // StageSeeding.

Add `seeding` as an OPTIONAL field, typed by **importing** the existing
schema:

    import { StageKind, StageSeedingSchema } from "@/server/api-v1/schemas";

`StageSeedingSchema` is at `apps/web/src/server/api-v1/schemas.ts:543-555`:

    source: "previous" | { stageId: Uuid }
    take: TakeRule[]            // 1..8
    placement: "seeded_map" | "snake" | "rank_order"
    map?: { slot: string; source: string }[]   // max 64; required non-empty when placement === "seeded_map"

    TakeRule = { kind:"rankRange", from, to }
             | { kind:"topNPerGroup", n }        // n 1..16
             | { kind:"bestNth", nth, count }

**Do NOT redeclare, re-derive, copy, or `z.object({...})` your own version
of this shape.** One vocabulary. A forked seeding type is the specific
defect class this task exists to avoid, and the reviewer checks for it
first.

Caveat you must handle: a template's `source` cannot be `{ stageId: Uuid }`
— a catalog JSON has no UUIDs, they don't exist until instantiation. Templates
express only `source: "previous"`, or a stage reference the instantiation
layer resolves. Decide how to express that with the IMPORTED schema (e.g.
constrain the template-side field to the `"previous"` branch) rather than by
declaring a parallel type. Update the `:22-25` comment to say what shipped.

## T2 — three catalog entries

`apps/web/src/server/templates/catalog/` holds 5 JSONs today: `slam128`,
`swiss11`, `wc32`, `americano-night`, `box-league`. Loader:
`apps/web/src/server/templates/catalog.ts:17-23` — add each new file there.

Build them in THIS order. `euro24` first: it is the hardest, and it is the
one that will expose a schema that cannot express what templates need. Find
that out before writing the other two, not after.

### `euro24` — 6 groups of 4 → best-thirds → R16 → QF → SF → F

24 entrants, 6 groups of 4. Top 2 per group (12) + the 4 best third-placed
(4) = 16 → R16.

    take: [ { kind: "topNPerGroup", n: 2 }, { kind: "bestNth", nth: 3, count: 4 } ]

**RULING — read this before you try to reproduce UEFA.** The real Euro 2024
best-thirds rule is a *combination lookup table*: which R16 slot a
third-placed team gets depends on WHICH four groups' thirds qualified (ADBC,
ABCD, … — 15 permutations). `StageSeeding.map` is a STATIC
`{slot, source}[]`, so it cannot express that, and the prompt's standing
instruction is "escalate if `StageSeeding` needs a field templates can't
express — do NOT fork the schema."

So: **do not model the combination table.** Map the 4 best thirds by rank
among thirds (best third to the highest available slot, and so on) using
`placement: "seeded_map"`. This satisfies the acceptance criterion — 16 R16
slots of which 4 are best-third sources — and stays inside the schema.

Say so plainly in the catalog file's own description/comment and in your
report: this is a simplification of the real tournament's rule, taken
deliberately, not an oversight. Do not silently approximate it.

### `t20-super8` — 4 groups → Super 8 (2 groups of 4) → SF → F

Top 2 per group (8) → two Super 8 groups of 4 → top 2 of each → SF → F.
The Super 8 stage is itself seeded FROM the group stage, and the SF is
seeded from the Super 8 — so this entry exercises a seeding chain more than
one link long. That is the point of including it.

### `league-playoff` — league → top-4 page playoff

    take: [ { kind: "rankRange", from: 1, to: 4 } ]

**Use `kind: "page_playoff"` for the playoff stage.** It IS DB-checked —
`db/migration/deltas/V298__page_playoff_stage_kind.sql` added it to the
`stages_kind_check` CHECK constraint, and the api-v1 `StageKind` enum's 9
values match the constraint exactly. The format-templates design doc
(`:50-56`) hedged that `page_playoff` might be rejected and to fall back to
`knockout(4)` — **that fallback is NOT taken**; the caveat is stale, it was
written before V298 was re-verified. Do not use `knockout(4)`.

### Shape rules for all three

- Copy the existing entries' shape exactly — read `wc32.json` first; it is
  the closest existing multi-group entry.
- `i18nNameKey` / `descriptionKey` — **i18n keys, never literal English**.
  Every new key goes in all four dictionaries
  (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`), flat dotted keys.
  Translate properly; do not paste English into the es/fr/nl files.
- `version: 1` on each new entry.
- Divisions must pass the SAME `sportModule.configSchema` validation manual
  creation uses. A template that fails validation is a catalog bug and must
  fail the unit gate — never soft-fall-back.

## Do NOT touch

- `apps/web/src/server/api-v1/schemas.ts` — import from it, never edit it.
- `apps/web/src/server/usecases/stages.ts` and anything in P5's
  stage-seeding server logic. A different task owns instantiation.
- `apps/web/src/server/usecases/templates.ts` — the instantiation usecase is
  the NEXT task, not this one. This task ends at "the catalog parses".
- `packages/engine/**`, any `db/migration/**` file. No DDL.
- The 5 existing catalog JSONs. Their output must stay byte-stable.

## Tests you owe

- **Unit**: all 3 new entries parse against `CompetitionTemplate`. The
  existing catalog test that instantiates EVERY entry must cover them too —
  find it rather than writing a parallel one.
- **Unit**: each new entry's seeded stages carry the seeding rules you
  intend — assert on `take`, `placement`, and the map's slot count.
  euro24's R16 must have **16 slots, of which 4 come from best-third
  sources**. Assert that number explicitly.
- **Regression (required)**: extend the pinned-shape table at
  `apps/web/src/server/usecases/__tests__/templates.test.ts:437-452` (an
  inline `it.each`, NOT a snapshot file). **P4's 5 existing entries must
  stay byte-stable** — adding multi-stage must not disturb single-stage
  output. Make that a real assertion, not a comment.
- Every change ships a test that fails without it.

Do NOT write e2e or smoke tests here — a later task owns those.

## Verify (run EXACTLY this, from apps/web — NOT the repo root)

Running vitest from the repo root yields `Cannot find package '@/...'` and a
fake red across hundreds of suites.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p7-templates/apps/web && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54372/seazn_test" DATABASE_SSL=disable \
npx vitest run --reporter=json --outputFile=/tmp/t12.json src/server > /tmp/t12.log 2>&1; echo "EXIT=$?"
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/t12.json
```

Judge ONLY from the JSON. A suite that fails to COLLECT contributes zero
tests and zero failures, so `failed: 0` is not green on its own — check
`numTotalTests` went UP, not down.

**Known-red baseline, not yours**: `schedule-build-honours-locks.test.ts`
(4 tests) fails without the placement service running. Ignore it. Any OTHER
red is yours.

Then, from the same directory:

```bash
npx tsc --noEmit -p tsconfig.json > /tmp/t12-tsc.log 2>&1; echo "TSC_EXIT=$?"; tail -5 /tmp/t12-tsc.log
```

## Rules of engagement

- **Do not dispatch subagents.** Review comes from the orchestrator.
- **No background watchers, no `tail -f`, no long-lived background
  process.** Two implementers stalled on exactly that last session.
- Prefix `cd <abs worktree path> &&` in the SAME call as every command — the
  shell cwd resets between calls and a verify run silently executes on
  `main`, returning a false green.
- Use `git grep -a`; plain grep reports files here as `Binary file … matches`.
- Never `git stash` in this worktree — the stash stack is shared with the
  main checkout and popping takes a foreign stash.
- Commit your work.

## Report

Write your full report to
`.superpowers/sdd/2026-08-14-p7-multi-stage-templates-plan/t12-report.md`.

Return ONLY: status (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT),
commit SHAs, the raw JSON counts line, and concerns — **including whether
`StageSeeding` turned out to be expressive enough, which is the one thing
this task is designed to discover.**
Final message under 15 lines. No file contents, no diffs.


---

# T3 — instantiation persists stage seeding

Your requirements. Read the ruling in §2 before writing code — it is the
opposite of what the session prompt says, deliberately.

## 1. The gap

`instantiateTemplate` writes stage rows at
`apps/web/src/server/usecases/templates.ts:253-263`:

```ts
const [stage] = await tx<{ id: string }[]>`insert into stages (division_id, seq, kind, name, config) values (…) returning id`;
```

It inserts only `(division_id, seq, kind, name, config)`. `createStages`
(`apps/web/src/server/usecases/stages.ts:227-233`) writes `seeding` and
`qualification` as well. So even once `TemplateStage.seeding` exists in the
zod schema (a previous task added it), a template's seeding rules are parsed
and then silently dropped on the floor.

**Your job: carry `seeding` from the parsed template through to the stage
row.** Follow how `createStages` writes the column — same shape, same
serialisation. Do not invent a second way to persist it.

## 2. RULING: do NOT generate fixtures at instantiation

The session prompt says instantiation "generates seeded stages + their TBD
fixtures via P5's pathway". **That is overruled. Persist the rules; generate
nothing.** Here is why, so you do not helpfully re-add it:

- A `.seeding` stage bypasses the entrant query and mints synthetic entrants
  from its seeding rules (`stages.ts:1348-1354`). Unlike a plain stage, it
  therefore CAN produce fixture rows with zero real entrants.
- One fixture row anywhere in the division trips a division-wide lock in TWO
  places: `replaceStages` (`stages.ts:276-281`) and `patchDivision`
  (`apps/web/src/server/usecases/divisions.ts:556-563` — the identical
  `exists(...)` check).
- So generating at instantiation would mean: the moment an organiser picks a
  template, they can no longer change the division's format OR its
  `variant_key`/config — before adding a single entrant. The only escape is
  `deleteStage`, which removes the tail stage only.

The current code already refuses this deliberately and says so
(`templates.ts:258-262`): *"No fixtures at instantiation time by design:
entrants don't exist yet"*. **Keep that invariant and keep that comment
true.** Update it to mention seeding rules are now persisted.

`stageResults.push({ id, fixtureCount: 0 })` stays `0`. TBD fixtures arrive
later, from the existing Generate action, which already handles `.seeding`
stages via `generateSeededStageFixtures`.

If you believe you must generate fixtures here, stop and report BLOCKED with
your reasoning rather than doing it.

## 3. Resolving `source`

`StageSeeding.source` is `"previous" | { stageId: Uuid }`. A catalog JSON has
no UUIDs — they do not exist until instantiation. Templates express only
`"previous"` (or a positional reference, depending on what the schema task
shipped — read `apps/web/src/server/templates/schema.ts` to see which).

If the template side is `"previous"`, it persists as-is; `"previous"` is
resolved at read time by P5's code, not here. If the schema task shipped a
positional reference instead, resolve it to the real `stageId` of the
already-inserted stage in the SAME division, in the same transaction, and
fail the whole instantiation if it points at a stage that does not exist.

Read what actually shipped rather than assuming. Report which case you found.

## 4. Transaction integrity

Everything stays inside the existing single transaction
(`createFromTemplate`, `templates.ts:75-92`). Any failure rolls the whole
tree back — the wizard must never receive a half-instantiated competition.
The API's documented failure mode is 422 `template.instantiation_failed`
with `{divisionIndex, stageIndex, cause}` so a catalog defect is locatable;
if you add a failure path, use that shape.

## Do NOT touch

- `apps/web/src/server/usecases/stages.ts` — read `createStages` to copy its
  persistence shape, but do not edit that file. Another task owns it.
- P5's stage-seeding server internals. You CALL P5's pathway; you never
  reimplement or edit it.
- `apps/web/src/server/api-v1/schemas.ts` — import only.
- `apps/web/src/server/templates/catalog/**` and `schema.ts` — a previous
  task owns those; they should already be correct. If they are not, report
  it rather than editing them.
- Any `db/migration/**` file. No DDL — `stages.seeding` already exists (V360).
- `packages/engine/**`.

## Tests you owe

- **Unit**: instantiating a multi-stage template persists `seeding` on the
  right stage rows — read the row back and assert `take`, `placement`, and
  the map, not just that the column is non-null.
- **Unit**: instantiation still creates ZERO fixtures, and the returned
  `fixtureCount` is `0` for every stage. This pins the ruling in §2 so a
  later session cannot quietly reintroduce generation without a red test.
- **Regression**: P4's 5 existing single-stage templates instantiate exactly
  as before — byte-stable. The pinned-shape table lives at
  `apps/web/src/server/usecases/__tests__/templates.test.ts:437-452` (an
  inline `it.each`, not a snapshot file).
- **Regression**: a template whose seeding is malformed fails the whole
  instantiation and leaves NO partial competition behind — assert the
  rollback, by querying for the competition after the failure.
- Every change ships a test that fails without it.

Do NOT write e2e or smoke tests here — a later task owns those.

## Verify (run EXACTLY this, from apps/web — NOT the repo root)

Running vitest from the repo root yields `Cannot find package '@/...'` and a
fake red across hundreds of suites.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p7-templates/apps/web && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54372/seazn_test" DATABASE_SSL=disable \
npx vitest run --reporter=json --outputFile=/tmp/t3.json src/server > /tmp/t3.log 2>&1; echo "EXIT=$?"
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/t3.json
```

Judge ONLY from the JSON. A suite that fails to COLLECT contributes zero
tests and zero failures, so `failed: 0` is not green on its own — check
`numTotalTests` went UP.

**Known-red baseline, not yours**: `schedule-build-honours-locks.test.ts`
(4 tests) fails without the placement service running. Ignore it. Any OTHER
red is yours.

Then, from the same directory:

```bash
npx tsc --noEmit -p tsconfig.json > /tmp/t3-tsc.log 2>&1; echo "TSC_EXIT=$?"; tail -5 /tmp/t3-tsc.log
```

Before committing, from the worktree ROOT: `npm run openapi:gen` and confirm
`git status --porcelain` is empty afterwards. The instantiation response
shape is in the OpenAPI spec; if it drifted, commit the regenerated file.

## Rules of engagement

- **Do not dispatch subagents.**
- **No background watchers, no `tail -f`, no long-lived background process.**
- Prefix `cd <abs worktree path> &&` in the SAME call as every command — the
  shell cwd resets between calls and a verify run silently executes on
  `main`, returning a false green.
- Use `git grep -a`; plain grep reports files here as `Binary file … matches`.
- Never `git stash` in this worktree — the stash stack is shared with main.
- New server code uses pino structured logging; never in tests.
- Commit your work.

## Report

Write your full report to
`.superpowers/sdd/2026-08-14-p7-multi-stage-templates-plan/t3-report.md`.

Return ONLY: status, commit SHAs, the raw JSON counts line, which `source`
case you found in the schema, and concerns. Final message under 15 lines.
No file contents, no diffs.


---

# T4 — the progression map in the template detail sheet

Your requirements. This is a UI task with a full polish bar.

## What to build

`TemplateDetailSheet` (`apps/web/src/components/v2/template-gallery.tsx:88`)
shows a template's structure before the organiser commits to it. Its
per-stage render block is at `:178-193` (`data-testid="template-detail-structure"`,
stage-kind join at `:187`).

Today it lists stages. It does not show how entrants move BETWEEN them —
which is the entire point of the three multi-stage templates a previous task
added to the catalog (`euro24`, `t20-super8`, `league-playoff`).

Add a **textual progression map**: for each stage that carries `seeding`,
render a line describing where its entrants come from. The spec's example
phrasing is "Top 2 per group → QF".

Derive the text from the stage's `seeding.take` rules
(`apps/web/src/server/api-v1/schemas.ts:543-555`):

- `{ kind: "topNPerGroup", n }` → "Top {n} per group"
- `{ kind: "bestNth", nth, count }` → "{count} best {nth}-placed"
- `{ kind: "rankRange", from, to }` → "Ranked {from}–{to}"

A stage can carry SEVERAL take rules (euro24's R16 has two: top-2-per-group
AND 4 best thirds). Render all of them, joined, then the arrow and the target
stage name. Do not render only the first rule — euro24 is precisely the case
that would silently lose information, and it is the entry the reviewer will
check first.

Stages with no `seeding` render as they do today. Do not regress them.

## i18n — all four locales, no exceptions

Every string you add is user-facing and goes in ALL FOUR dictionaries:
`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Flat dotted keys.

- **Never concatenate translated fragments.** "Top {n} per group" is ONE key
  with a parameter, not "Top" + n + "per group" — word order differs by
  language and concatenation cannot be translated correctly.
- The arrow/target construction is likewise one key with parameters, e.g.
  `{source} → {target}`, not two strings glued at the call site.
- Translate genuinely into es/fr/nl. Do not paste English into the other
  three files.
- If the repo generates key types (`apps/web/src/lib/i18n-keys.ts` is
  generated), run the generator rather than hand-editing it.

## The UI bar (standing project rule, not optional)

- Screenshot-verify at **1280**, **320**, and **768**. No horizontal page
  scroll at any of them.
- If the progression map can be wide, it scrolls inside its OWN
  `overflow-x-auto` container — never the page.
- Touch targets stay at least 44px (`min-h-11`); note that the utilities
  layer can beat `.select`-style component classes, so verify the rendered
  height rather than assuming the class won.
- This is a full-polish surface (not `/admin`), so match the existing design
  system — read the surrounding components and reuse their tokens, spacing,
  and type scale rather than inventing new ones.
- Load and actually apply the `frontend-design` skill. Citing it is not
  compliance.

Attach the three screenshots to your report.

## Do NOT touch

- `apps/web/src/server/**` — this is a client-side rendering task. The data
  is already on the template object.
- `apps/web/src/server/templates/catalog/**` and `schema.ts` — a previous
  task owns those. If the data you need is not on the object, report it
  rather than editing the catalog.
- Any `db/migration/**` file.
- `packages/engine/**`.

## Tests you owe

- **Unit**: the take-rule → text mapping, including a stage with MULTIPLE
  take rules (euro24's two), asserting both appear.
- **Unit**: all four locales resolve every new key — a missing key in one
  dictionary must fail.
- **Regression**: a template with NO seeded stages renders exactly as before
  (the 5 single-stage entries must not change).
- Assertions on rendered Next HTML must anchor on `="` — React serialises an
  omitted prop as `"$undefined"`, so a bare `data-*` probe passes in BOTH
  states and proves nothing.
- Every change ships a test that fails without it.

Do NOT write e2e or smoke tests here — the next task owns those.

## Before you finish

Grep your changed/added UI text across `apps/web/e2e/**`. A changed string
breaks e2e assertions that pin it. Note: `mobile.spec.ts:1051-1088` pins
"Winner of Group A"/"Winner of Group B" — leave those strings alone.

## Verify (run EXACTLY this, from apps/web — NOT the repo root)

Running vitest from the repo root yields `Cannot find package '@/...'` and a
fake red across hundreds of suites.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p7-templates/apps/web && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54372/seazn_test" DATABASE_SSL=disable \
npx vitest run --reporter=json --outputFile=/tmp/t4.json src > /tmp/t4.log 2>&1; echo "EXIT=$?"
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/t4.json
```

Judge ONLY from the JSON. A suite that fails to COLLECT contributes zero
tests and zero failures, so `failed: 0` is not green on its own — check
`numTotalTests` went UP.

**Known-red baseline, not yours**: `schedule-build-honours-locks.test.ts`
(4 tests) fails without the placement service running. Ignore it. Any OTHER
red is yours.

Then, from the same directory:

```bash
npx tsc --noEmit -p tsconfig.json > /tmp/t4-tsc.log 2>&1; echo "TSC_EXIT=$?"; tail -5 /tmp/t4-tsc.log
```

Lint: run it via `rtk proxy npm run lint` and judge on the `✖ N problems`
line — rtk otherwise hides the output entirely, and "ESLint output (JSON
parse failed)" is the wrapper losing the result, not a clean run.

## Rules of engagement

- **Do not dispatch subagents.**
- **No background watchers, no `tail -f`, no long-lived background process.**
- Prefix `cd <abs worktree path> &&` in the SAME call as every command — the
  shell cwd resets between calls and a verify run silently executes on
  `main`, returning a false green.
- Use `git grep -a`; plain grep reports files here as `Binary file … matches`.
- Never `git stash` in this worktree — the stash stack is shared with main.
- Commit your work.

## Report

Write your full report to
`.superpowers/sdd/2026-08-14-p7-multi-stage-templates-plan/t4-report.md`.

Return ONLY: status, commit SHAs, the raw JSON counts line, the three
screenshot paths, and concerns. Final message under 15 lines. No file
contents, no diffs.


---

# T5 — e2e and smoke for multi-stage templates

Your requirements. This task closes the two remaining required test types.
The other three tasks deliberately left e2e and smoke to you so they land in
one coherent pass.

## E2E

**All P7 e2e goes in `apps/web/e2e/mobile.spec.ts`.** That file's seven
viewport projects (320/360/375/390/430/768/834) are the responsive
enforcement backstop, and a new surface has ZERO width coverage until its
spec lives there. Do not create a new spec file.

The flow to cover:

1. Create a competition from the `t20-super8` template.
2. Assert **three stages are visible** (groups → Super 8 → SF/F).
3. Add entrants and generate, then assert the Super 8 fixtures render
   **TBD-labelled**.

Note on step 3: instantiation deliberately creates NO fixtures — a ruling
this session made, because a `.seeding` stage can generate with zero real
entrants and one fixture row would format-lock the competition at birth via
both `replaceStages` and `patchDivision`. So the fixtures you assert on
appear only after entrants exist and Generate runs. Your spec must include
those steps; if you skip them you will be asserting on an empty stage and
the test will be vacuous.

### E2E traps in this repo — every one of these has produced a false green

- **`TAG` is PER PROCESS.** Seven viewport projects run as separate
  processes. A hardcoded identity is shared across all seven and they race —
  the symptom is a failure that MOVES between widths run to run. Derive
  per-project identity from `test.info().project.name`. A layout bug stays
  pinned to one width; a mover is contention.
- **Use `localhost`, never `127.0.0.1`** — the secure cookie is host-bound
  and `127.0.0.1` 401s.
- **Drive real `<option>` elements**, not hardcoded label text.
- **A `waitForURL` that matches the PRE-CLICK url is vacuous.** Assert on a
  URL that can only exist after the action.
- **Anchor assertions on `="`** — React serialises an omitted prop as
  `"$undefined"`, so a bare `data-*` probe passes in both states.
- Log in through the UI helper the file already uses (`loginUi`); do not
  hand-roll auth.
- Do not assert on strings pinned by existing specs. `mobile.spec.ts:1051-1088`
  pins "Winner of Group A"/"Winner of Group B" — leave those alone.

### Running it

Follow `docs/runbooks/e2e-local.md` — it is the authoritative recipe
(server env vars, `REDIS_URL` must be UNSET, staging `.next/static`,
`PLAYWRIGHT_BASE`). Key points:

- `next.config` sets `output: standalone`, so **`next start` returns HTTP 200
  while serving the wrong server**. Serve
  `.next/standalone/apps/web/server.js` after copying `.next/static` and
  `public` into it.
- **Bind port 3212 or higher.** Port 3100 is the shared e2e target and 3000
  is the owner's dev server. Another session's orphaned server on a squatted
  port serves the WRONG code while returning 200 for both HTML and assets.
- Before trusting a run, confirm the listener is YOURS: `lsof -ti tcp:PORT
  -sTCP:LISTEN` (without `-sTCP:LISTEN` you get Playwright's chromium and the
  check fails both ways), then check the PID's cwd.
- **Never kill another session's server.** If your port is taken, move up.
- A stale `next-server` survives `pkill -f server.js` — it is a renamed
  process. Kill by port and diff the PIDs.

## Smoke

Add ONE multi-stage from-template creation to `scripts/smoke.ts`, following
the existing step pattern in that file. Smoke CI runs on **PRs only**, so
this must be verified locally before it can be trusted.

## Judging the results

**Playwright**: a green job can still hide a real timeout behind
`retries: 1`. Measure the green baseline first — a test that normally takes
10–14s dying at 60s is a STALL, not drift. Also: progress lines are not
failures; a CANCELLED run reports as `failure`; the artifact dir is the
ATTEMPT, not the test; and a dead runner is invisible to `--log-failed`.

**Vitest** (if you touch any unit test): judge only from
`--reporter=json --outputFile`. A suite that fails to COLLECT contributes
zero tests and zero failures, so `failed: 0` is not green on its own.

Known-red baseline, not yours: `schedule-build-honours-locks.test.ts`
(4 tests) fails without the placement service running.

## Do NOT touch

- Anything under `apps/web/src/server/**`, `templates/**`, or
  `components/**` — the previous tasks own the production code. If e2e
  reveals a product defect, REPORT it; do not fix it here. (This is how P6
  found three defects two review passes had missed — the report is the
  valuable output.)
- `.github/workflows/e2e.yml`. Out of scope for this task — do not edit
  it. **Correction (P7 fix round, 2026-08-14): it is NOT disabled.** It
  is LIVE on pull requests — six Playwright jobs, including the
  seven-width matrix — so this paragraph's original premise ("never
  enable it, it's disabled deliberately") is stale; do not act on it.
  Local verification (prod build + `E2E_PROD_TARGET`) is still useful,
  but CI is now the arbiter too, not just a dead workflow file.
- Any `db/migration/**` file.

## Rules of engagement

- **Do not dispatch subagents.** Never run a long e2e run inside a subagent —
  the 600s watchdog kills it.
- **No background watchers, no `tail -f`.** Have long commands write their
  own `EXIT=$?`; a killed background command reports exit code 0, and that 0
  is the SIGTERM.
- Capture exit codes with a REDIRECT, never a pipe: `cmd > out.txt 2>&1;
  echo "EXIT=$?"`. `cmd | tail; echo $?` reports tail's status, always 0.
- Prefix `cd <abs worktree path> &&` in the SAME call as every command.
- Use `git grep -a`; plain grep reports files here as `Binary file … matches`.
- Never `git stash` in this worktree — the stash stack is shared with main.
- Commit your work.

## Report

Write your full report to
`.superpowers/sdd/2026-08-14-p7-multi-stage-templates-plan/t5-report.md`.

Return ONLY: status, commit SHAs, the raw Playwright passed/failed counts
across all seven projects, the smoke pass/fail counts, any product defect you
found, and concerns. Final message under 15 lines. No file contents, no
diffs.
