# P6 (D4b) — progression UI: session plan + rulings

Branch `feat/p6-progression-ui`, worktree `.claude/worktrees/p6-progression-ui`.
Prompt: `../specs/bench-product-value/portfolio-prompts/P06-progression-ui.md`.
Spec: `../specs/bench-product-value/designs/2026-08-13-stage-progression-design.md`.
Depends on P5 (#554, migration V360) — merged, on `main` as `776ba389`.

## Scout re-pin — three prompt premises were wrong

Recorded as discovered, per `_RULES.md` §1. Do not re-derive.

**1. There is no read path for a proposal.** `stage_seed_proposals` is
touched at exactly seven sites (`stages.ts:1941, 2008, 2010, 2052, 2071,
2169, 2227`) and every one is inside compute/confirm/stale-marking. No
usecase reads "the current proposal for this stage", and there is no
`GET /api/v1/stages/{id}/seed-proposal` — the route file
(`app/api/v1/stages/[id]/seed-proposal/route.ts`) is POST-only. A panel
that renders on page load therefore cannot read its own state, and it
must not POST to find out: recompute has side effects (it marks prior
drafts stale and inserts a row, `stages.ts:2008-2010`).

**Ruling: add a read-only usecase, not a route.** `getSeedProposal(auth,
stageId)` in `stages.ts`, consumed by the division page (server
component) and handed to the panel as a prop — the pattern every sibling
panel already uses (`page.tsx:333` feeds `StagesPanel` server-fetched
`stages`/`fixtures`). Recompute and confirm stay on P5's POSTs; fresh
state after either comes from `router.refresh()`. This keeps the session
UI-only, so the prompt's `openapi:gen` → empty-porcelain check still
holds. A public API GET is not owed by P6's scope.

**2. The destructive-edit path has no error code to wire to.** The
prompt says the dialog is "wired to P5's codes"; there is no such code.
Late structure edits go through the pre-existing idempotent-diff
regeneration in `generateStageFixtures` (`stages.ts:849`), which added
no flag and no code in P5. All 13 shipped `SEEDING_*` codes are
compute/confirm validation, not regeneration.

**Ruling: the dialog is client-side and computes its own blast radius**
from the fixtures the panel already holds — count of fixtures to be
discarded, how many are scheduled (`scheduled_at` non-null), how many
carry results. It names those numbers before calling the existing
regenerate path. No server change, no new code invented to match a
sentence in the prompt.

> **THIS RULING WAS WRONG. Overturned by the whole-branch review.**
>
> Its premise — that late regeneration discards fixtures — was inferred
> from the design doc calling `generateStageFixtures` an "idempotent
> diff" and from the prompt's own wording. **Neither was checked against
> the code, and the code deletes nothing.** `stages.ts:997-1031` builds
> `byKey` from `existing` and inserts only `gen` rows missing from it;
> unmatched existing rows are LEFT IN PLACE. `GenerateOutcome`
> (`stages.ts:835-839`) carries only `created`/`existing`. The repo's
> only `delete from fixtures` are `history.ts:135` (checkpoint restore)
> and a demo seed.
>
> So the dialog shipped a false data-loss warning on a SAFE routine
> action: an organiser adding a late entrant was told they would lose
> 12 fixtures and 5 results. The real hazard is the opposite —
> STRANDED leftovers, fixtures that no longer match the rules and are
> silently kept.
>
> The correction is in flight. The lesson is the one this session kept
> finding in other people's work and then reproduced in its own: I
> verified that no error code existed for the destructive path (true,
> and worth finding) but never verified that the destructive path
> existed at all. Disproving one half of a premise is not checking it.

**3. The label columns are wired to nothing.** V360 added
`fixtures.home_slot_label` / `away_slot_label` (jsonb `{key, params}`),
and `descriptorLabel()` (`stage-seeding.ts:89`) produces them, but no
renderer reads them. All 28 fixture-rendering surfaces print a
hardcoded English `"TBD"` (`schedule/page.tsx:304`,
`public-site/bracket.tsx:32`, `exports.ts:207-208`, SQL
`coalesce(...,'TBD')`, …). P5's five `slot.*` keys already exist in all
four locales (`ui.json:1539-1543`); `slot.winner_match` /
`slot.loser_match` from the spec do not, and the intra-bracket preview
helper `stages.ts:794-797` builds a concatenated English string
("Winner of R2 #1") instead.

## The prompt's verify block does not run this suite

**4th false premise, found at the gate.** `P06-progression-ui.md` says
verbatim:

```bash
npx vitest run --reporter=json --outputFile=/tmp/p6.json apps/web/src
```

Run from the repo/worktree ROOT, that produces **1,248 tests across
1,004 suites with 663 suites FAILED** — against a suite that is ~7,231
tests. Every failure is `Cannot find package '@/…'`: the `@/` alias
resolves through `apps/web`'s own vitest config, so from the root
almost every suite fails to COLLECT. A collecting failure contributes
no tests and no failures, which is why the shape matters more than the
count — `numFailedTests` was 41 while ~6,000 tests never ran at all.

**Correct gate: run it from `apps/web`.** Any P-session copying that
verify block verbatim from the root is reading a number that describes
about a sixth of the suite. The `seazn-local-env` skill already lists
this exact signature ("`Cannot find package '@/lib/...'` in a suite
that was green | cwd drifted to the repo root; re-run from
`apps/web`"); the prompt predates it being written down.

## Scope ruling — which of the 28 surfaces get localized labels

The prompt says "everywhere fixtures appear … exports keep raw labels".
Drawing that line explicitly so it is not re-litigated:

- **IN (localized `{key, params}` → resolved string):** org schedule
  page + schedule board, stages panel, bracket panel, org fixture
  detail, public schedule/bracket/results-matrix, public fixture
  detail, my-matches, slideshow + embed + OG (public *displays*, not
  exports).
- **OUT (keep today's raw `TBD` / SQL `coalesce`):** `exports.ts`
  (CSV/PDF), `official-marks.ts`, `match-reports.ts`. These are
  documents; the prompt exempts them.
- **ICS — owner ruling 2026-08-13: IN, against the prompt's blanket
  export exemption.** A subscribed calendar is a display, not a
  document: the final showing "TBD vs TBD" on day one is exactly the
  product value TBD fixtures exist to deliver. One route
  (`.../calendar.ics/route.ts:32-33`), one resolver call, org locale.

One resolver, two entry points, no second copy: `msgFor()` on the
server, `useMsg()` in client islands, both over the same key set.

## Tasks (sequential — both touch the four dictionaries)

- **A — labels.** Resolver + the two missing `slot.*` keys ×4 locales +
  loaders selecting the columns + the IN-list renderers.
- **B — panel.** Proposal table, tie picks, edit-in-place, confirm CTA,
  stale banner + recompute, destructive-edit dialog, `getSeedProposal`.

## Owner ruling — SEEDING_* error copy is P6's, scoped

All four `errors.json` are `{}`, so P5's 13 `SEEDING_*` codes have no
human copy and the panel would show an organizer a raw
`SEEDING_TIE_UNRESOLVED`. P5 disclosed this as accepted, noting the
cited `CAPACITY_IMPOSSIBLE` precedent is not wired either.

**Ruling (owner, 2026-08-13): wire copy for the 13 `SEEDING_*` codes
only** — ×4 locales, plus the resolver that renders a code into it —
inside task B, where the errors actually surface. Do NOT audit or wire
the other unwired codes; that is a separate session's scope. This
establishes the errors-dictionary pathway on the flow that needs it
without turning a UI session into an i18n sweep.

## Sequencing after P6

**Owner ruling: P7 (D1b multi-stage templates) runs after P6 MERGES**,
not in parallel — its own worktree, its own scout re-pin against a
merged P6. The ratified wave plan's W4 = P6 ∥ P7 is superseded for this
pair: both touch template/stage surfaces and the four dictionaries.

## Open follow-ups this session ships KNOWINGLY

Both surfaced by the final reviews. Neither blocks the PR; both are
real and must not be quietly dropped.

### 1. Two dictionary keys with no production reader

`slot.winner_match` / `slot.loser_match` were added ×4 locales this
session and are read ONLY by the marketing preview
(`stages.ts:801-809`). `descriptorLabel` never emits them, so a live
public bracket's round-2+ slots still render a bare "TBD" while the org
board shows a feed label — an org/public divergence.

Two paths were ruled out at the time and a **third was in reach and
was missed**, which is the part worth recording:

- BLOCKED: extend `SlotDescriptor`/`descriptorLabel`
  (`stage-seeding.ts:68-100`) — that is P5 server logic, out of scope.
- BLOCKED: expose `winner_to_fixture`/`winner_to_slot` on
  `public_fixtures_v` — needs a new migration, barred.
- **NOT BLOCKED, and not taken:** `stages.ts`'s own generation already
  computes `g.homeFrom`/`g.awayFrom` per fixture (`GenFixture`,
  `stages.ts:499-500, 525-526`) — the same data the English-only
  preview helper already uses to build `{key:"slot.winner_match", …}`
  directly, bypassing `SlotDescriptor` entirely. `SlotLabel` is a
  generic `{key, params}` and both columns already exist from V360, so
  **no migration is needed**. `generateStageFixtures` simply never
  writes such a label today.

The stop-clause was honest about the two paths it named; the
alternatives search was not exhaustive. A follow-up that only repeats
the two dead ends would send the next session down them again.

### 2. Dropping the regenerate dialog leaves a hazard with no signal

Dropping was the right immediate call — the client genuinely cannot
compute which existing fixtures have gone stale, and a content-free
disclaimer on every click (including the common harmless case) is worse
than nothing.

But the residual risk is larger than "clutter", and the PR should not
imply it is closed: because `generateStageFixtures` only inserts, a
fixture orphaned by a rules change **stays live**. It can still take a
scheduled time and a result indefinitely, silently polluting standings
and exports after the rules that produced it stopped applying. Before
this session there was a false signal; now there is **zero** signal,
which in that one dimension is worse.

The real fix is server-side — generation reporting what no longer
matches — and that is P5 territory, not P6's.

## Tests owed (all four, per RULES)

Unit: label resolver (params, 4 locales, no concatenation). Regression:
a fixture list with a MIX of filled and TBD rows renders both, anchored
on `="` (a bare `data-*` probe passes in both states). E2E: browser
flow — decided groups → panel → edit a slot → resolve a tie → confirm →
bracket shows real entrants, schedule times unchanged on screen; plus
the destructive-dialog path. Smoke: extend the existing D4a step at
`scripts/smoke.ts:802` to drive proposal → confirm.

## Environment

Postgres `:54353` (data_directory confirmed mine — `:54341` was
squatted by another session, the documented `START_EXIT=1` +
`createdb` exit 0 trap). `db:apply` → v360, `sync:sports` → 11 sports /
31 system variants. `readlink -f node_modules/@seazn/engine` resolves
inside the worktree.
