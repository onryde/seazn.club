# Competition Desk W3 — the in-play band and the phone composition (PR B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the competition page a live in-play band, give the fixtures tab a real phone composition rather than a groomed shrink, and stop an odd-entrant Swiss stage reporting its own designed sit-out as a data fault.

**Architecture:** One producer for in-play data — `getCompetitionDesk` gains the fixture list so the server component paints the band on first load, and a new read-only `GET /api/v1/competitions/{id}/desk` returns the same shape for a 20 s client poll. The phone work is a re-composition of DOM that already exists: the run-sheet row is already mobile-first, so W3 moves its breakpoint and reshapes its stack rather than branching a second tree.

**Tech Stack:** Next.js App Router (async server components + `"use client"` islands), React, Tailwind, Zod (api-v1 schemas), vitest (`environment: "node"` — no DOM), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-competition-desk-design.md` §W3 (amendment 5). Owner rulings 12-17 in `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md`.

## Global Constraints

- **PR A must be merged first.** Task T6 folds the rail that PR A builds (`docs/superpowers/plans/2026-09-06-competition-desk-w2-stage-rail.md`, ruling 13). T1 also edits `stages-panel.tsx`, so T1 either lands before PR A starts or waits for it — never concurrently.
- **`in_play` is DERIVED, never stored.** `server/engine-db/append-event.ts:128` — `return has("core.start") ? "in_play" : "scheduled"`. In e2e, start a fixture with `seedRosteredFixture(request, { …, emitCoreStart: true })`. **Do NOT use `setFixtureStatusSql`** (`e2e/helpers.ts:715`): it force-sets the column with no engine event, producing a fixture that looks in-play with an empty ledger — a band test built on it asserts nothing.
- **The acceptance criterion for the phone work is a control-set DIFF at 320 vs 1280.** W2's gate measured them byte-identical (71 controls, `diff` empty). Same set at smaller sizes is a groomed shrink; a different set is a composition. Compare the visible control SET from the live DOM — membership, order, repeats — never box sizes.
- **Run the WHOLE `mobile.spec.ts`, never a `-g` slice.** It is `describe.configure({ mode: "serial" })`, so the first red aborts everything after it: a failure count is a floor, not a total. Re-run after each fix until a full pass completes.
- **T4 changes the 640-767 band, which no Playwright project covers** (they are 320/360/375/390/430/768/834). Check ~700 by hand; the matrix is structurally blind to it.
- `apps/web` vitest is `environment: "node"` — **there is no DOM**. A `max-md:hidden` body still renders into the markup, so a class-scan test stays green while five width projects go red on `toBeVisible()`. Anything a user touches gets an e2e, not just a unit.
- All new user-facing strings go in `dictionaries/{en,es,fr,nl}/ui.json` under `desk.*`, then `pnpm i18n:gen-keys` (which regenerates `i18n-keys.ts` — never hand-edit it). Active verbs on buttons; sub-lines state the fact.
- Package manager is **pnpm**. Vitest: `cd apps/web && pnpm vitest run …`, never `--root`. Judge green from `--reporter=json --outputFile` (`numPassedTests` / `numTotalTests`), and treat a DROP in the total as a collection failure, not a pass.
- Every change ships a test that fails without it.

---

### Task T1: The odd-Swiss sit-out miscopy — drive it, then fix it

**Runs first, because it is the only task whose shape is unknown.**

**Files:**
- Read: `packages/engine/src/scheduling/swiss.ts` (`pairRound`, the `bye` field)
- Read: `apps/web/src/server/usecases/stages.ts` (`swissGen` mapping; the stage-wide `referenced` query and the `ghosts`/`unplaced` computation)
- Modify (one of, decided by Step 3): `apps/web/src/lib/roster-drift-eligibility.ts` · `apps/web/src/server/usecases/stages.ts` · `apps/web/src/components/v2/stages-panel.tsx` + the four dictionaries
- Test: `apps/web/src/server/usecases/__tests__/stage-roster-drift.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on. T1 is independent and can merge alone.

**Background, already established — do not re-derive:** `pairRound` puts the sat-out entrant in a `bye` field, excluded from `pairings`. `swissGen` maps only `round.pairings`, so that entrant gets **no fixture row at all** — not a bye row, not a null-opponent row. Roster drift computes `unplaced` as active entrants referenced by no fixture **stage-wide**, so the sat-out entrant lands in it, `hasDrift` goes true, and the banner "Fixtures don't match the roster" plus a "Rebuild fixtures" CTA renders. Keys are `progression.rosterDrift.heading` and `progression.rosterDrift.rebuildCta`, translated in all four locales. `isRosterDriftEligible` gates on `stage.progression === null` **and** `!ROSTER_DRIFT_INELIGIBLE_KINDS.has(stage.kind)`, where the set is `{ladder, americano}` — so the miscopy can only appear on a **progression-less** Swiss stage. That narrows the repro.

- [ ] **Step 1: Stand up a local environment**

Follow the `seazn-local-env` skill. Two traps it exists for: `db:apply` alone is not a fresh schema — it needs `sync:sports`, or `funnel.test.ts` fails `expected 'generic' to be 'badminton'`; and a `pg_ctl` that fails with "Address already in use" is followed by a `createdb` that SUCCEEDS against another session's server. Confirm `show data_directory` is yours before trusting anything.

- [ ] **Step 2: Drive the repro in a browser**

Create a division with an **odd** entrant count (5 is enough), add a **Swiss** stage with no progression, generate round 1. Open `?tab=fixtures`. Read the banner. Screenshot it.

- [ ] **Step 3: Drive the second round — this is the question the fix turns on**

Pair round 2 so the round-1 sat-out entrant now plays. Re-read the banner.

Write down what you SAW, not what must be true:
- **If the banner clears** — the flag is transient, visible only until the sat-out entrant is first paired. The right fix is narrow: suppress a Swiss sit-out from `unplaced` for the round in which it sits out.
- **If the banner persists** — it is a standing false alarm on every odd Swiss stage, and re-wording alone would be a cover-up. Prefer the `unplaced` fix in that case too.
- **Only if neither is workable**, add `"swiss"` to `ROSTER_DRIFT_INELIGIBLE_KINDS`. This is last because it silences the banner for a genuine mid-stage roster change, which is the case it exists for.

Record the observation in `_INDEX.md` under the W3 item 6 section, replacing the UNCONFIRMED paragraph.

- [ ] **Step 4: Write the failing test**

`stage-roster-drift.test.ts` has **zero** swiss cases today — `grep -a swiss` across all three roster-drift test files returns nothing. Its green is not coverage here. Add the first one, driving the REAL swiss generator rather than hand-building rows:

The file already imports everything you need — use these, do not invent helper names: `seedOrg` and `GENERIC_CONFIG` from `./_seed`, `createCompetition` from `../competitions`, `createDivision` from `../divisions`, `createEntrants` / `patchEntrant` from `../entrants`, `startDivision` from `../schedule`, plus `createStages`, `generateStageFixtures`, `getStageRosterDrift`, `rebuildStageFixtures`, `decideFixture` and `appendEvent` from `@/server/engine-db`.

```ts
it("an odd-entrant swiss stage does not report its own sit-out as roster drift", async () => {
  const { auth, orgId } = await seedOrg();
  const competitionId = await createCompetition(auth, orgId, /* … as the file's other cases do … */);
  const divisionId = await createDivision(auth, competitionId, GENERIC_CONFIG);
  await createEntrants(auth, divisionId, FIVE_ENTRANTS);   // ODD on purpose
  const [stage] = await createStages(auth, divisionId, [{ kind: "swiss", name: "Swiss", progression: null }]);
  await startDivision(auth, divisionId);
  await generateStageFixtures(auth, stage.id);

  const drift = await getStageRosterDrift(auth, divisionId);
  expect(drift[stage.id]?.unplaced ?? []).toEqual([]);
});
```

Copy the exact argument shapes off the knockout case already in this file rather than trusting the ellipses above. **Five entrants, not four** — an even count produces no sit-out and the test would pass against the unfixed code. And drive the REAL generator: a test that hand-builds the row shape the product does not produce is exactly how the bye suite stayed green while never once executing against a real bye.

- [ ] **Step 5: Run it and confirm it fails**

```bash
cd apps/web && pnpm vitest run src/server/usecases/__tests__/stage-roster-drift.test.ts \
  --reporter=json --outputFile=/tmp/w3-t1-1.json; \
  node -e 'const r=require("/tmp/w3-t1-1.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: exactly one failure, and the total is the old total + 1.

- [ ] **Step 6: Apply the fix chosen in Step 3**

- [ ] **Step 7: Re-run, then mutate**

Re-run Step 5's command: all green, total unchanged. Then revert the fix locally and confirm the new test — **and only the new test** — reddens. If a pre-existing test also reddens, the fix changed behaviour beyond the sit-out; stop and reconsider.

- [ ] **Step 8: Re-drive the browser repro**

The unit test proves the computation. It does not prove the person stops seeing the banner. Repeat Step 2 and confirm with your eyes, then screenshot the cleared state beside the Step 2 screenshot and confirm the two images DIFFER.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/server/usecases/__tests__/stage-roster-drift.test.ts <the file you fixed> \
        docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md
git commit -m "fix(desk): an odd-swiss sit-out is a design, not roster drift"
```

---

### Task T2: The band's producer — one shape, two doors

**Files:**
- Modify: `apps/web/src/server/usecases/competition-desk.ts` (types at ~35-72; the fixture query at 226-270)
- Create: `apps/web/src/app/api/v1/competitions/[id]/desk/route.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts` (the `ROUTES` array, starts line 57)
- Test: `apps/web/src/server/usecases/__tests__/competition-desk.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, for T3:

```ts
export interface DeskInPlayFixture {
  id: string;
  division_id: string;
  division_name: string;
  home: string | null;
  away: string | null;
  fixture_no: number;
  event_count: number;
  started_at: string | null;
}

export interface CompetitionDesk {
  in_play: number;
  in_play_fixtures: DeskInPlayFixture[];  // NEW — ordered by started_at ascending, nulls last
  up_next: DeskNextFixture | null;        // NEW — the soonest `next` across divisions
  divisions: Map<string, DeskDivision>;
  now: string;
}
```

**The data is already fetched.** The existing query at `competition-desk.ts:227-229` already selects `f.id, f.division_id, f.status, f.scheduled_at, f.fixture_no, f.stage_id, h.display_name as home, a.display_name as away, coalesce(e.n,0)::int as event_count, e.started_at`. T2 exposes it on the type; it should not need a new query. Confirm that by reading the query before writing SQL.

- [ ] **Step 1: Write the failing usecase test**

```ts
it("carries every in-play fixture, ordered by kickoff, with its event count", async () => {
  const desk = await getCompetitionDesk(auth, competitionId);
  expect(desk.in_play_fixtures.map((f) => f.fixture_no)).toEqual([1, 2]);
  expect(desk.in_play_fixtures[0]?.event_count).toBe(0);
  expect(desk.in_play).toBe(desk.in_play_fixtures.length);
});
```

The last assertion is the one that matters: it pins the new list against the scalar the pill already renders, so the two cannot drift into two authorities for one fact.

Seed at least **two** in-play fixtures with **different** event counts — one at zero (the "NO SCORE" case) and one above it. A single sample cannot witness an ordering or a per-row mapping bug.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/web && pnpm vitest run src/server/usecases/__tests__/competition-desk.test.ts \
  --reporter=json --outputFile=/tmp/w3-t2-1.json; \
  node -e 'const r=require("/tmp/w3-t2-1.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

- [ ] **Step 3: Extend the usecase**

Add the two fields. Derive `in_play_fixtures` from rows already in hand, and `up_next` as the soonest `next` across divisions. Do not add a second query for either.

- [ ] **Step 4: Add the Zod schema**

In `schemas.ts`, add `S.CompetitionDesk` mirroring the interface exactly. `S.Fixture` already declares the status enum `["scheduled","in_play","decided","finalized","abandoned","forfeited","cancelled"]` — reuse it rather than retyping the members.

- [ ] **Step 5: Add the route**

`apps/web/src/app/api/v1/competitions/[id]/desk/route.ts`, following the shape of `app/api/v1/fixtures/[id]/route.ts`:

```ts
export const GET = v1(async (req, { params }) => {
  const { id } = await params;
  const auth = await requireResourceAuth(req, { competitionId: id }, "read");
  return getCompetitionDesk(auth, id);
});
```

Return the usecase's value bare — the `v1()` kernel supplies the `{ ok, data, requestId }` envelope, maps `HttpError` to its status (403 → `FORBIDDEN`, 404 → `NOT_FOUND`), `ZodError` to 400 and `AuthError` to 401. Do not hand-roll any of that. Read `server/api-v1/auth.ts` and copy the auth helper an existing competition-scoped GET uses; do not guess at `requireResourceAuth`'s argument shape.

- [ ] **Step 6: Add the OpenAPI row**

One entry in `ROUTES`, same shape as the existing GET at line 68:

```ts
{ path: "/competitions/{id}/desk", method: "get", summary: "Get a competition desk summary", tag: "competitions", response: S.CompetitionDesk },
```

Then:

```bash
pnpm openapi:gen
```

A coverage test asserts the `ROUTES` table matches route files 1:1, so a missing row is CI-red rather than a silent gap.

- [ ] **Step 7: Run the usecase suite, the api-v1 suites, and typecheck**

```bash
cd apps/web && pnpm vitest run src/server/usecases/__tests__/competition-desk.test.ts \
  src/server/api-v1/__tests__ \
  --reporter=json --outputFile=/tmp/w3-t2-2.json; \
  node -e 'const r=require("/tmp/w3-t2-2.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
cd ../.. && pnpm typecheck
```

`openapi-coverage.test.ts` is the one that catches a missing `ROUTES` row. Note that `pnpm build` locally does NOT typecheck — run `pnpm typecheck` as its own gate.

- [ ] **Step 8: Smoke the endpoint**

Add a case to the smoke script asserting the endpoint 200s and validates against `S.CompetitionDesk`. Assert the envelope is `{ ok: true, data: … }`, not a bare body.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/server/usecases/competition-desk.ts \
        apps/web/src/server/usecases/__tests__/competition-desk.test.ts \
        apps/web/src/server/api-v1/schemas.ts apps/web/src/server/api-v1/openapi.ts \
        apps/web/src/app/api/v1/competitions/ openapi/
git commit -m "feat(desk): the in-play fixture list gets one producer and one door"
```

---

### Task T3: The in-play band

**Files:**
- Create: `apps/web/src/components/v2/desk/in-play-band.tsx`
- Create: `apps/web/src/components/v2/desk/__tests__/in-play-band.test.tsx`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx` (insert between the masthead row's closing `</div>` at ~398 and `<NeedsYou dict={dict} items={needs} />` at ~400)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`

**Interfaces:**
- Consumes: `DeskInPlayFixture`, `CompetitionDesk.in_play_fixtures`, `CompetitionDesk.up_next` from T2.
- Produces:

```ts
export function InPlayBand(props: {
  competitionId: string;
  initial: { inPlay: DeskInPlayFixture[]; upNext: DeskNextFixture | null };
  dict: Dict;
}): React.ReactElement | null;
```

- [ ] **Step 1: Write the failing unit test — the guard first**

```tsx
it("renders nothing when no fixture is in play", () => {
  const html = renderToStaticMarkup(
    <InPlayBand competitionId="c1" initial={{ inPlay: [], upNext: null }} dict={dict} />,
  );
  expect(html).toBe("");
});

it("prints NO SCORE for an in-play fixture with an empty ledger, and the score otherwise", () => {
  const html = renderToStaticMarkup(
    <InPlayBand competitionId="c1" initial={{ inPlay: [fixtureWithZeroEvents, fixtureWithEvents], upNext: null }} dict={dict} />,
  );
  expect(html).toContain(dict.desk.band.noScore);
  // and exactly once — the fixture WITH events must not also print it
  expect(html.split(dict.desk.band.noScore).length - 1).toBe(1);
});
```

The "exactly once" count is the point. An assertion that `NO SCORE` merely appears passes on a band that prints it for every card.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/in-play-band.test.tsx \
  --reporter=json --outputFile=/tmp/w3-t3-1.json; \
  node -e 'const r=require("/tmp/w3-t3-1.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

- [ ] **Step 3: Add the four dictionaries**

`desk.band.noScore`, `desk.band.upNext`, and an accessible name for the band region. All four locales, no hardcoded English — then:

```bash
pnpm i18n:gen-keys && pnpm i18n:check
```

- [ ] **Step 4: Build the component**

`"use client"`. Night ground; numerals styled with the existing `--sport-led` token (defined `app/globals.css:1018` as `var(--color-lime-400, #9ae600)`). **There is no LED-numeral component in this repo** — a grep for seven-segment/LED-digit primitives is empty, so build the numerals fresh with the token; do not go looking for one to reuse.

One card per in-play fixture across divisions, plus one dashed "Up next" card. `"NO SCORE"` in red when `event_count === 0`. Return `null` when the list is empty — no empty state.

If the band scrolls horizontally on a phone, it owes `tabindex="0"` plus a role and an accessible name, or axe reds at SERIOUS on `scrollable-region-focusable`. `tabindex` cannot be varied by media query, so it is unconditional.

- [ ] **Step 5: Poll, on the established pattern**

This repo has no query library. Copy the shape of `components/v2/board/run-elapsed.tsx:23-33`:

```ts
useEffect(() => {
  if (!live) return;
  const id = setInterval(() => { void refresh(); }, 20_000);
  return () => clearInterval(id);
}, [live]);
```

`live` is true while the competition pill says in play, false otherwise — so the interval is not merely skipped but **cleared** when play stops. `refresh()` fetches `/api/v1/competitions/{id}/desk` and reads `json.data`.

- [ ] **Step 6: Mount it**

In `page.tsx` (async server component; the desk comes from `await getCompetitionDesk(auth, id).catch(...)` in the `Promise.all` at ~45, so it can be `null`). Insert between the masthead row's closing `</div>` and `<NeedsYou … />`. Pass `initial` from the already-awaited desk so the band paints on first load. Handle `desk === null` by rendering nothing.

- [ ] **Step 7: Run the unit test, then MUTATE the guard**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/in-play-band.test.tsx \
  --reporter=json --outputFile=/tmp/w3-t3-2.json; \
  node -e 'const r=require("/tmp/w3-t3-2.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Then delete the `inPlay.length > 0` guard and re-run. Expected: **exactly one** test reddens. If none does, the guard is untested and the test is decoration.

- [ ] **Step 8: Write the e2e — with a REAL ledger event**

New spec or a case in `e2e/competition-desk.spec.ts`:

```ts
await seedRosteredFixture(request, { divisionId, /* … */ emitCoreStart: true });
await page.goto(compUrl);
await expect(page.getByTestId("desk-in-play-band")).toBeVisible();
await expect(page.getByTestId("desk-in-play-band")).toContainText("NO SCORE");
```

**Do not reach for `setFixtureStatusSql`.** It sets the column with no engine event, and `in_play` is derived from `has("core.start")` — the band would render over a fixture that never started, and the test would prove nothing.

Then decide the fixture and assert the band disappears. Verify the poll with `page.clock`, never a sleep.

- [ ] **Step 9: Regression — the band is absent off match day**

Assert on a competition with no in-play fixture that the band's testid resolves to **zero** elements. Pair it with the positive case in the same file so the negative cannot pass vacuously against a page that failed to load at all — a zero-resolving locator satisfies "absent" for the wrong reason.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/v2/desk/in-play-band.tsx \
        apps/web/src/components/v2/desk/__tests__/in-play-band.test.tsx \
        apps/web/src/app/o/\[orgSlug\]/c/\[compSlug\]/page.tsx \
        apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts apps/web/e2e/
git commit -m "feat(desk): the competition page gets a live in-play band"
```

---

### Task T4: Unify the phone breakpoint on `md:`

**Files:**
- Modify: `apps/web/src/components/v2/desk/run-sheet-row.tsx` (row wrapper `:353`, action cell `:432`, and the `sm:contents` at `:354` / `:432`)
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx` (the six `max-sm:*` / `sm:hidden` tool classes at ~254-396)
- Modify: `apps/web/src/components/v2/desk/desk-tools-more.tsx` (`sm:hidden`)

**Interfaces:** none — this is a class change only. No props move.

**Ruling 15.** The ledger switches at `md:` (768), the masthead and the run-sheet row at `sm:` (640). At 768 the ledger is a card while the run sheet is already a desktop row. W3 unifies on `md:`.

- [ ] **Step 1: Enumerate before editing**

```bash
cd apps/web && grep -an "sm:" src/components/v2/desk/run-sheet-row.tsx \
  src/components/v2/desk/desk-tools-more.tsx \
  "src/app/o/[orgSlug]/c/[compSlug]/page.tsx"
```

Write the list into your notes. `\bmd:hidden\b` also matches inside `max-md:hidden` — the two are opposites, so read each hit rather than pattern-replacing.

- [ ] **Step 2: Write the failing e2e**

Add a case to `e2e/run-sheet.spec.ts` that at **768** the run-sheet row renders as ONE line — assert the time cell and the action cell share a `boundingBox().y` within a few pixels. Today at 768 that already passes (the row goes single-line at 640), so **also** assert at **700** via an explicit `setViewportSize({ width: 700, height: 900 })` that the row is STACKED. That second assertion is the one that fails before the change and no project covers.

- [ ] **Step 3: Run it and confirm the 700 case fails**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts --project=parallel
```

- [ ] **Step 4: Rewrite the classes**

`sm:` → `md:` and `max-sm:` → `max-md:` on the enumerated hits only. Do not touch `sm:` classes that belong to unrelated components in the same files.

- [ ] **Step 5: Run the whole spec files, then the seven widths**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts e2e/run-sheet-dates-and-court.spec.ts \
  e2e/competition-desk.spec.ts --project=parallel
cd apps/web && pnpm playwright test e2e/mobile.spec.ts \
  --project=mobile-320 --project=mobile-360 --project=mobile-se \
  --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834
```

Whole files. No `-g`.

- [ ] **Step 6: Check 640-767 by hand**

Screenshot the fixtures tab and the competition page at 700. No project covers this band; the matrix cannot tell you it is right.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/v2/desk/run-sheet-row.tsx \
        apps/web/src/components/v2/desk/desk-tools-more.tsx \
        apps/web/src/app/o/\[orgSlug\]/c/\[compSlug\]/page.tsx apps/web/e2e/run-sheet.spec.ts
git commit -m "fix(desk): one phone breakpoint for the whole desk, md not sm"
```

---

### Task T5: Two-line run-sheet rows

**Files:**
- Modify: `apps/web/src/components/v2/desk/run-sheet-row.tsx`
- Test: `apps/web/e2e/run-sheet.spec.ts`

**Interfaces:** none — composition only.

**Today's phone row is three reflowed lines** with the action as a ~100px pill on its own line, and the sheet runs 3,805px (6.7 screens) at 320 against 2,271px at 1280. A3 makes it two deliberate lines: line 1 = time + entrants; line 2 = court/round sub-line + the one action, right-aligned.

The cells and their exact classNames today:

| Cell | Current className |
| --- | --- |
| Time (editable) | `-my-1 flex min-h-11 w-14 shrink-0 items-center font-mono text-sm tabular-nums text-slate-600 underline decoration-slate-300 decoration-dotted underline-offset-4 hover:text-purple-700 hover:decoration-purple-500`, `data-testid="run-sheet-edit-time"` |
| Time (read-only) | `w-14 shrink-0 font-mono text-sm tabular-nums text-slate-600` |
| Entrant block | `min-w-0 flex-1`; sub-line `min-w-0 truncate text-xs text-slate-500`; name link `block min-w-0 truncate text-sm font-medium …` |
| Action | wrapper `flex flex-wrap items-center gap-2 sm:contents` (→ `md:contents` after T4); button `btn btn-primary min-h-11 shrink-0 px-3 text-xs` with `data-row-action` |

- [ ] **Step 1: Capture the baseline control set**

At 320 and at 1280, dump the visible control set from the live DOM — membership, order and repeats — and `diff` them. Record that today they are identical. This is the measurement the task has to move.

- [ ] **Step 2: Write the failing assertion**

Assert at 320 that the row occupies exactly TWO text lines: take the row's `boundingBox().height` and assert it is below a two-line ceiling derived from the row's own computed `line-height` and padding — **not** a hardcoded pixel constant, which goes stale the moment the type scale moves. Also assert the action's box is on the same visual line as the sub-line (compare `y` centres).

- [ ] **Step 3: Run and confirm it fails**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts --project=mobile-320
```

- [ ] **Step 4: Recompose**

Two rows in the phone stack, not three. `truncate` needs `min-w-0` on the **whole ancestor chain**, not just the span — a missing one put 106px of horizontal overflow on the page at 320-390 on the scorepad wave, visible only with a realistic 43-character entrant name and only in a browser. Test with a 43-character name.

- [ ] **Step 5: Re-measure the control set — this is the acceptance criterion**

Re-run Step 1's dump. The sets at 320 and 1280 must now **DIFFER**. If `diff` is still empty, the row is a shrink and the task is not done, whatever the screenshots look like.

- [ ] **Step 6: Hit-test, do not measure**

For each control on the phone row, take its centre and confirm `document.elementFromPoint` resolves to it or a child. `boundingBox()` reports paint: a control can measure 44px and still be untappable under an overlay. Note that the cookie banner intercepts phone clicks on a fresh context.

- [ ] **Step 7: Whole-file gates**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts e2e/run-sheet-dates-and-court.spec.ts --project=parallel
cd apps/web && pnpm playwright test e2e/mobile.spec.ts \
  --project=mobile-320 --project=mobile-360 --project=mobile-se \
  --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/v2/desk/run-sheet-row.tsx apps/web/e2e/run-sheet.spec.ts
git commit -m "feat(desk): the phone run-sheet row becomes two deliberate lines"
```

---

### Task T6: The rail folds into a bottom sheet

**Requires PR A merged.**

**Files:**
- Modify: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (the `lg:` grid PR A added)
- Test: `apps/web/e2e/run-sheet.spec.ts`, `apps/web/e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: `StageRailProps` from PR A.
- Produces: no new exports. The trigger is a floating "Stage tools" button below `md:`.

**Precedent to reuse, not reinvent:** `apps/web/src/components/modal.tsx:117-129` already implements bottom-sheet-under-`sm` — `flex max-h-[85dvh] w-full … flex-col rounded-t-2xl … pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:rounded-2xl sm:pb-6`, with a `<span className="sheet-handle" aria-hidden />`. Crib the pattern; adjust its breakpoint to `md:` per ruling 15.

- [ ] **Step 1: Write the failing e2e**

At 320: the rail's controls are NOT visible; a "Stage tools" trigger IS; tapping it opens the sheet and every rail control becomes visible. At 1280: the trigger is absent and the rail controls are visible without any tap.

Wait on **`toBeAttached`**, not `toBeVisible`, for the folded controls before opening — visibility is exactly what the fold denies. And gate the open on the **trigger being visible**, not on a width literal: clicking a hidden control throws.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts --project=mobile-320 --project=parallel
```

- [ ] **Step 3: Grep the e2e suite for the rail's testids before changing anything**

```bash
cd apps/web && grep -an "stage-generate\|stage-complete\|stage-delete\|stage-auto-schedule\|stage-unscheduled-count" e2e/ src/
```

`stage-auto-schedule`, `stage-auto-schedule-blocked` and `stage-unscheduled-count` pre-date this programme and have existing callers. `stage-generate` / `stage-complete` / `stage-delete` are added by PR A Task 1, so their only callers are PR A's own tests.

Folding a control breaks every test that asserts it VISIBLE, and **no unit test can see it** — a class-scan test stays green while five width projects go red. Make those tests OPEN the fold. Do not weaken their assertions to match the new markup.

- [ ] **Step 4: Build the fold**

Below `md:` the rail renders inside the sheet; the floating trigger is `md:hidden`. **`/\bmd:hidden\b/` also matches inside `max-md:hidden`** — anchor any assertion on `\s...hidden"` rather than the bare pattern, or it passes on its own inversion.

If the panel mounts more than one rail (one per stage), opening the first leaves the others' controls boxless and `boundingBox()` returns null. Open EVERY instance the test touches.

- [ ] **Step 5: Whole-file gates plus axe**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts e2e/mobile.spec.ts \
  --project=mobile-320 --project=mobile-360 --project=mobile-se \
  --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834
```

- [ ] **Step 6: Control-set diff, again**

The fixtures tab's control set at 320 must differ from 1280. This is the second half of the same acceptance criterion T5 opened.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/v2/desk/stage-rail.tsx apps/web/src/components/v2/stages-panel.tsx apps/web/e2e/
git commit -m "feat(desk): the stage rail becomes a bottom sheet on phones"
```

---

## Final gate — the whole wave

- [ ] `cd apps/web && pnpm vitest run --reporter=json --outputFile=/tmp/w3-final.json`, and confirm `.testResults[].name` paths resolve inside **this worktree**. Shell cwd can reset to the main checkout between calls: a verify run launched from a worktree can silently execute on `main` and return a false green.
- [ ] `pnpm typecheck` as its own gate — a local build does not typecheck, and vitest can be structurally blind (`tsconfig.scripts.json` excludes tests).
- [ ] `pnpm lint` via `rtk proxy`, reading `✖ N problems`.
- [ ] Whole `mobile.spec.ts` at all seven widths, green in one uninterrupted run.
- [ ] `pnpm i18n:check` — four locales at parity.
- [ ] Screenshots at 1280 / 768 / 320 for the competition page and the fixtures tab in all four phases. Confirm the images EXIST and DIFFER, and print the asserted content beside each so a capture of the wrong state cannot pass.
- [ ] **Walkthrough**: drive the whole surface as an organiser on a match day. A green suite is not a working product — findings reachable from ~4,000 passing tests have included untranslated copy nothing renders and a page whose chunks were never emitted.
- [ ] Per-screen verdicts written into `_INDEX.md`. "CI green" / "no gaps" is not sign-off.
