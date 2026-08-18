# Format progression F3–F5 — design

**Status**: approved in outline 2026-08-18 (owner rulings inline). No
implementation plans yet — those are written per session, after the previous
one merges.

**Depends on**: F1 (merged, #606 + #613) and F2 (PR #616, in review).

**Predecessors**: `2026-08-17-format-progression-design.md` is the design of
record for the programme. This document covers only what remains, and it is
written against the code F1 and F2 **actually shipped**, which differs from
what their own designs predicted in at least three ways (`carry` kept, `timing`
added, multi-source built rather than renamed).

---

## 1. Where the programme actually stands

F1 gave every bracket round its true name, read from a persisted role rather
than re-derived from match counts. F2 replaced two mutually-exclusive
progression vocabularies with one `stages.progression` field.

**Neither delivered the owner's original ask.** That ask was:

> as an org, I can choose any format with customization and I want to see all
> fixtures including final from day one.

F2 preserved every writer's existing behaviour on purpose — a migration that
also changed product behaviour would have been impossible to review. The
consequence, verified on the shipped branch: **all six multi-stage picker
templates emit `timing: "on_complete"`**, so no format reachable from the
picker shows day-one fixtures. The capability exists and nothing uses it.

F3 is where the programme's stated purpose is delivered.

### Ground truth, verified on the F2 branch

| Fact | Evidence |
|---|---|
| 14 picker templates | `components/v2/format-templates.ts:48-211` |
| 6 multi-stage, **all** `timing: "on_complete"` | `:60, :79, :109, :122, :187, :205` |
| 8 single-stage, `progression: null` | league, swiss, knockout, double_elim, triple_rr, americano, mexicano, ladder |
| **Every** template emits `placement: "rank_order"` | `:62, :97, :111, :124, :193, :207` |
| `snake` / `seeded_map` never emitted by the picker | present in the type union at `:28` only |
| Working reference shapes exist | `catalog/euro24.json:40` (`seeded_map`), `catalog/t20-super8.json:32` (`snake`) |
| All 14 `label`/`help` are plain English literals | `:44-45`, rendered raw at `division-builder.tsx:672-673`, `division-settings.tsx:544` |
| No dictionary keys exist for them | zero hits across `dictionaries/**` |
| Picker covers **all 9** engine `StageKind`s | `schemas.ts:27` vs the 14 templates |

That last row matters and is covered in §4.

---

## 2. F3 — deliver day-one fixtures, and a correct draw

Three changes, one session. They belong together because all three touch
`format-templates.ts` and would otherwise collide.

### 2.1 Flip all six multi-stage templates to `timing: "setup"`

**Owner ruling**: all six. Any format the picker offers shows its full
bracket — final included — at setup, with TBD placeholders that resolve as
sources complete.

The formats that genuinely cannot do this — swiss, americano, mexicano,
ladder — pair from live results and have no downstream bracket to draw. None
of them is a *source* in any multi-stage template, so this ruling has no
conflict with them. They stay single-stage and unaffected.

### 2.2 The real hazard: entrant churn, not unknowable size

The owner asked what happens when the downstream size is not knowable. The
answer is that **it always is** — every take rule carries an explicit count
(`topNPerGroup n`, `rankRange from–to`, `bestNth count`, `picks`), and
`progressionSize` derives the total from the spec alone.

What is *not* stable is the **entrant list**. Generate a 16-slot bracket from
4 groups × top 2 + 4 best thirds, then two entrants register late and the
groups reshape — the bracket already shown to everyone is now the wrong size.

This is not a new hazard. It is an existing one that F3 multiplies exposure
to, because today only catalogue templates use `setup` and after F3 every
multi-stage picker format will:

- `computeSeedProposal` already 422s `SEEDING_RULES_MISSING` with *"this
  stage's generated TBD fixtures don't match its current seeding rules —
  regenerate them first"* (`stages.ts:2358`).
- Regeneration is idempotent and deterministic, keyed by `ext_key`
  (`stages.ts:3, :150, :401`), so re-running diffs against what exists rather
  than duplicating.
- **But that advice is already documented as unable to work in one case.**
  `stages.ts:1560`: stranded seeds leave `computeSeedProposal` 422ing
  *"forever ('regenerate them first' — advice that cannot work)"*. A
  pre-insert guard was added to fail the transaction cleanly instead of
  committing a stage that can never be seeded.

**F3 must decide what an organiser sees when this happens**, and the decision
is a product one, not an implementation detail. The options, in the order this
document recommends them:

1. **Detect and offer.** When entrants change under a `setup` stage with
   generated fixtures, surface it in the UI — "your bracket was built for 16
   qualifiers; your groups now produce 18. Rebuild it?" — with a one-click
   regenerate. The organiser sees the truth and chooses.
2. **Auto-regenerate on entrant change**, silently, while no result exists.
   Least friction, but a bracket that silently reshapes under an organiser who
   has already shared its link is its own kind of wrong.
3. **Lock entrants once day-one fixtures exist.** Simplest to reason about,
   worst for real tournaments, where late entries are normal.

Whatever is chosen, F3 owes a test for the stranded-seed case specifically —
it is the one path the existing error message admits it cannot resolve.

### 2.3 Derive placement from shape

**Owner ruling**: automatic, no new UI.

Today the picker emits `rank_order` universally, which flattens qualifiers from
several groups into one ranked list — so two teams from the same group can meet
in the quarter-final. Group separation is exactly what `snake` and `seeded_map`
exist for, and the picker cannot reach them. **This is a wrong draw, not
merely a late one**, and the original design named it the strongest argument
for the whole unification.

F3 derives placement from the source's shape: a group-stage source implies
`snake`; a template that pins specific seats uses `seeded_map`. Organisers get
a correct draw without needing to know either word. `euro24.json` and
`t20-super8.json` are the working reference shapes — F3 should produce output
that matches their structure, not invent a third convention.

### 2.4 The 14 hardcoded-English templates

Every `label` and `help` in `STAGE_TEMPLATES` is a plain string literal
rendered raw. This violates the standing four-locale rule and has done since
before this programme.

F3 wires all 14 through the dictionary in one pass, **with a reader in the
same commit**. Adding keys nothing reads is the inert-seam pattern that L3 was
made to revert on owner ruling, and `i18n:check` verifies locale parity rather
than usage — so unused keys stay green while being dead.

**Watch the e2e specs**: they pin the English picker labels. Changing this copy
without updating them reds CI, and e2e runs on pull requests here.

---

## 3. F3's central risk

The three changes above are individually modest and collectively a **product
behaviour change on every multi-stage format at once**. F2 was a migration
that deliberately changed nothing observable; F3 changes what organisers see
the moment they pick a format.

That argues for F3 shipping behind nothing — no flag, per the greenfield
stance — but with the widest verification of any session in the programme:
every one of the six templates exercised end to end on a real build, at
desktop and both mobile widths, with the resulting bracket inspected rather
than merely asserted on.

---

## 4. F4 — smaller than expected

F4's premise was sport and format kinds. Verification found **no gap in either
direction**: the picker's 14 templates use exactly the 9 engine `StageKind`s
(`schemas.ts:27`), and every engine kind is reachable from the picker.

The one open question was `mexicano`, which maps to engine kind `americano`
(`division-builder.tsx:61`). The root cause is that `StageKind` has no
`mexicano` member; the mode lives in `stage.config.mode`
(`format-templates.ts:170`).

**Owner ruling**: deliberate, document and leave. Mexicano is a
pairing/scoring mode of americano, not a separate stage kind. F4 adds a comment
at the mapping site so the next reader does not re-derive it as a bug, and does
**not** touch the engine enum — which would ripple through the schema, the DB
CHECK and every exhaustive switch for a naming question.

**Consequence**: F4 *as originally conceived* has almost no work left — one
comment, folded into F3. But the slot should not be left empty or renumbered.

**F4 is repurposed** to the two product gaps §7 identifies on the surfaces
organisers hand out: the exported/printed draw (P5) and the subscribed calendar
(P2). Both are day-one fixtures leaking on a non-HTML surface, both are
server-side, both are small, and both are disjoint from everything F3 touches.
That is a coherent session with a real deliverable, which is a better use of
the number than a session that exists to justify it — and better than a
renumber, which would break every reference already written to F5.

The sport/format-kind premise is retired; the number is not.
**Owner confirmed the repurpose 2026-08-18.**

---

## 5. F5 — the debt this programme created

**Owner ruling**: F1's owed smoke check, plus the recommended set.

| Item | Evidence |
|---|---|
| **F1's smoke check** — F1 shipped unit + e2e + regression, no smoke assertion for round naming or byes. Deferred to avoid conflicting with F2's `smoke.ts` conversion, which has now landed. | standing rule: all four test types per task |
| **Three tautological tests** — assert a field is absent on a type that no longer has it. They passed before the rename, pass after, and would pass if the code were deleted. | `catalog.test.ts:68`, `format-templates.test.ts:200`, `format-gallery.test.ts:97` |
| **Multi-source fuzz** — the property harness builds single-source specs only, by its own comment. Multi-source is the newest code in the programme and has directed tests but no fuzz. | `testkit/simulation.ts:796-797` |
| **The board payload budget** — `main` sits at roughly 250003 against a 250000 ceiling by inference, about 2% headroom. The next per-fixture field anyone adds trips it, unrelated to whoever adds it. **This figure is inferred from arithmetic, not measured** — F5 should measure it first. | `e2e/board-v3.spec.ts:228` |
| **A weak seeded_map assertion** — checks only `placed[0]` of four unclaimed seats; an implementation slicing by position rather than filtering by claimed key would pass byte-identically. | `progression.test.ts:157` |
| **A stale blocker comment** — `format-catalogue.test.ts` claims it stays red until Task 6 converts and says not to regenerate the snapshot; Task 6 landed and it passes 3/3. Reads as an open blocker it is not. | `format-catalogue.test.ts:67-89` |
| **Missing `best_nth` cross-pool tie-flagging test** — the deleted `stage-seeding.test.ts` had one; the shared tie block is proven via `rank_range` only. | `progression.ts:521-527` |

Two adjacent defects found while fixing the Page-playoff gate copy, not owned
by any session: `AddStageForm` shows a plain error banner instead of a paywall
card, and `division-settings.tsx`'s `buildTemplateStages` call has no
`PAYMENT_REQUIRED` handling at all. Both are missing UI rather than wrong
behaviour. F5 is the natural home unless they are wanted sooner.

---

## 6. The one process rule this programme earned

The unowned work in F2 surfaced in **four waves** — 2 files, then 5, then 3
scripts, then 4 e2e specs — and every wave was found by a sweep scoped to
whatever that author happened to be touching: components, then usecases, then
scripts, then specs. Each sweep found files the previous author had no reason
to look at.

**Before writing F3's task list**, grep `apps/web/src`, `scripts/`,
`apps/web/e2e/`, `db/` and `packages/` in one pass for every symbol the session
will touch. The plan's file lists were not merely incomplete in F2; they were
incomplete in a way only a differently-scoped sweep could reveal.

The second rule, equally earned: **the silent failures are the expensive
ones**. Every serious defect in F1 and F2 was silent — a dropped key returning
200, a filter matching nothing, a CHECK constraint accepting what it was
written to reject because Postgres treats NULL as satisfied, a test asserting a
defect approvingly. None crashed. All passed their suites. F3 changes what
organisers see on every multi-stage format at once, so it should be verified by
looking at rendered output, not by counting green tests.

---

## 7. Product improvements (added 2026-08-18, verified by execution)

The sections above describe what F3 must *not get wrong*. This section is
what F3 is *worth* — the product value that day-one fixtures unlock, and the
places that value currently leaks out. Every row was checked against the code
rather than reasoned about; the two that reverse an earlier assumption are
marked.

| # | Improvement | Verdict | Evidence |
|---|---|---|---|
| P1 | Schedule the whole tournament at setup, not just stage 1 | **unlocked free by F3** | no scheduler query excludes placeholder fixtures |
| P2 | The subscribed calendar drops every day-one fixture | **real gap, blocks the stated product value** | `calendar.ics/route.ts:40` |
| P3 | Staleness warned proactively, not as a 422 on save | **net-new UI, not a copy change** | `lib/seeding-error.ts` is post-hoc only |
| P4 | Placeholder labels read well on day one | **already true — no work owed** | `stages.ts:1611,1614` |
| P5 | The printed/exported draw says "TBD vs TBD" everywhere | **real gap, invisible from the UI** | `exports.ts` selects no `*_slot_label` |
| P6 | Multi-source pool keys may collide | **open question F3 must answer** | `sourceIndex` discarded at `stages.ts:1457-1462` |

### Where each of these lands

Four of the six are F3's own work; two are not, and the split is not a matter
of taste. F3 is already the riskiest session in the programme (§3) — it changes
what organisers see on every multi-stage format at once. P2 and P5 touch a
different subsystem entirely and would widen that blast radius for no gain.

| # | Home | Why |
|---|---|---|
| P1 | **F3**, as a verification step | Confirms the flip is usable; only becomes work if a gate turns out to depend on entrant identity |
| P2 | **F4** (see §4) | `calendar.ics` route — disjoint from every file F3 opens |
| P3 | **F3** | It *is* §2.2, the session's central product decision |
| P4 | nowhere — no work owed | Verified already correct |
| P5 | **F4** (see §4) | `exports.ts` — disjoint from every file F3 opens |
| P6 | **F3** | F3 is the session that makes multi-source reachable from the picker |

**P2 and P5 do not have to wait for F3.** Verified on the F2 branch: three
catalogue templates already emit `timing: "setup"` today —
`euro24.json:47`, `league-playoff.json:32`, `t20-super8.json:33` and `:48`. So
labelled placeholder fixtures exist to test against right now, and the export
and calendar fixes can be written, tested and merged without F3 having landed.
F3 then widens who benefits from them rather than enabling them.

File sets are provably disjoint — F3 owns `format-templates.ts`,
`progression.ts` and the seeding region of `stages.ts`; F4 owns `exports.ts`
and the `calendar.ics` route — so the two may run in parallel. That is the
standing bar for parallel work in this repo, and it is met here on inspection
rather than by ownership assertion.

### P1 — the whole tournament becomes schedulable on day one

This is the largest unlock in the programme and it is nearly free, because the
scheduler is already placeholder-aware. Verified: no query in `schedule.ts` or
`packages/engine/src/scheduling/**` filters on `home_entrant_id is null`, and
two subsystems handle unfilled sides deliberately — `capacity-input.ts:304`
(a TBD side falls back to the fixture's pool for `restByGroup`) and
`competition-schedule-ai.ts:770,1273` (avoids double-booking a person into a
TBD bracket slot).

So the moment F3 makes downstream fixtures exist at setup, BUILD and
auto-schedule can allocate courts and times for finals day **before the group
stage starts**. Today an organiser cannot book a venue for a final that does
not exist as a row. That is an operational need, not a cosmetic one, and it is
the clearest commercial answer to "why does day-one matter".

**F3 owes a check, not a build**: confirm a `setup` stage's fixtures reach the
board and survive a BUILD, and that placing them does not depend on entrant
identity. If something does gate on entrants, that gate — not the flip — is
F3's real work.

### P2 — the subscribed calendar cannot deliver its own stated purpose

`calendar.ics/route.ts:40` filters `f.scheduled_at !== null` before building
events. Four lines above it, the P6 owner ruling is recorded verbatim:

> "a subscribed calendar showing 'TBD vs TBD' for the final is the exact
> product value TBD fixtures exist to deliver."

It cannot currently deliver that. A day-one final exists but is unscheduled, so
it never becomes a VEVENT and is simply absent from the calendar. P1 fixes this
incidentally (scheduled fixtures pass the filter); emitting tentative events for
unscheduled ones fixes it directly.

**Constraint either way**: the VEVENT UID must stay keyed on the fixture id, so
that when the final resolves from "Winner of Group A" to a real name it
**updates in place** in calendars people already subscribed to, rather than
arriving as a second event beside a stale one. A subscribed calendar is the one
surface where getting this wrong is not recoverable by a redeploy.

### P3 — staleness is currently a 422 the organiser meets too late

§2.2 describes the entrant-churn hazard. What was not established there is that
the only existing surface for it is reactive: `lib/seeding-error.ts` maps
`SEEDING_RULES_MISSING` to a message *after* the organiser presses seed. No
component warns while the bracket is drifting out of date, and nothing watches
entrant count against `progressionSize`.

So §2.2 option 1 ("detect and offer") is **new UI plus a derived staleness
signal**, not a rewording of an existing banner. Scope it accordingly.

### P4 — reverses an earlier assumption: labels are already correct

An earlier reading of this programme assumed day-one fixtures would render
"TBD vs TBD" and that giving them meaningful labels was F3's headline work.
**That is wrong, and the opposite is true.**

- `generateProgressionSetupFixtures` (`stages.ts:1432`) is reached *only* when
  `progression.timing === "setup"` (short-circuit at `:981, :989-990`), and it
  writes both `home_slot_label` and `away_slot_label` at `:1611` and `:1614`.
  The `on_complete` path never calls `descriptorLabel` at all — labelling is
  **exclusively** a setup-timing feature.
- `descriptorLabel` (`packages/engine/src/competition/progression.ts:102-115`)
  yields *Winner of Group A*, *Runner-up of Group A*, *3rd in Group A*,
  *Best 3rd place*, *Rank N* — as i18n `{key, params}` refs, never prebuilt
  strings.
- `resolveSlotLabel` (`lib/slot-label.ts`) is the single renderer, and eight
  surfaces already go through it: the public bracket (`bracket.tsx:57`), the
  division page (`:105-108`), the fixture page (`:48-74`), the calendar route
  (`:37`), the embed widget (`embed/divisions/[id]/[widget]/page.tsx:73-74`),
  the OG image (`opengraph-image.tsx:52-57`), the public schedule (resolved by
  its server parent and passed as `slotLabels`), and the board (`board/
  types.ts:183-186`).

**Consequence for F3**: flipping the six templates to `timing: "setup"` makes
them *better labelled*, not worse — the labelling machinery only ever runs on
the path they are moving onto. This removes what looked like F3's biggest risk.
It also means the flip is the thing that switches labelling on, so a template
left on `on_complete` keeps bare TBD by construction.

### P5 — the printed draw is the one surface that stays "TBD vs TBD"

`apps/web/src/server/usecases/exports.ts` selects **no** `*_slot_label` column
anywhere: `exportFixtures` (`:205-220`) joins only `entrants.display_name` and
coalesces to the literal `'TBD'` in SQL (`:209-210`), and `officialDutyRows`
(`:566-572`) and `ticketRegistrationRows` do the same. `:614` and `:726` apply
the same `?? "TBD"` in TypeScript.

This is the sharpest gap in the set, because of *which* surface it is. The
export path produces the artifact an organiser prints and pins to a wall, or
mails to clubs, on day one — precisely the moment F3 exists to serve. Every
other surface will show "Winner of Group A" while the printed sheet shows
"TBD vs TBD", and **nothing in the UI reveals the discrepancy**: the columns are
never selected, so no renderer can compensate downstream.

Related: `poster.pdf` renders no fixture data at all today (QR and branding
only). A day-one full-draw poster is a genuine product opportunity that F3
makes possible for the first time, but it is additive scope — name it, do not
smuggle it in.

### P6 — the open question: multi-source pool keys may collide

`expandSources` (`progression.ts:181-190`) tags every pot with its
`sourceIndex`, but `placeDescriptors` (`:209-254`) and the `slotOf` map that
consumes it (`stages.ts:1457-1462`) keep only `.descriptor` and **discard
`sourceIndex`**. `descriptorKey` is `` `${pool}${rank}` `` — so two sources that
both expose a pool named "A" produce the same key `A1`, and `descriptorLabel`
produces the same text *Winner of Group A* for two different slots.

This is stated as an open question, not a confirmed defect: it requires two
sources with overlapping pool keys, and no shipped template produces that today
(all six are single-source). But F3 is the session that makes multi-source
reachable from the picker, so **F3 must determine whether the collision is real
and either fix it or record why it cannot occur.** Leaving it undetermined is
how this programme's silent defects have been created every previous time.

---

## 8. Pick-up prompts — start any of these from one message

Each block below is self-contained: paths, criteria, exclusions, verification.
Paste one as the whole prompt. F4 does not wait for F3 and the two may run in
parallel — see §7's routing table for why. Do not
start F3 until PR #616 (F2) has merged —
F3 consumes the shipped `progression` field, and this repo has a repeated
failure where a session authored against a design met an implementation that
landed differently.

Standing rules that apply to **all** of these, restated so they need no lookup:
read `docs/superpowers/RULES.md` first; every change ships a test that fails
without it; all four test types (unit / e2e / smoke / regression); any new or
changed user-facing string goes into all four locale dictionaries; UI is
verified by screenshot at 1280, 320 and 768 with no horizontal page scroll;
new branches go in a worktree, never the main checkout; `.github/workflows/
e2e.yml` is **live on pull requests**.

### Prompt: F3 — deliver day-one fixtures

> Implement F3 of the format-progression programme, per
> `docs/superpowers/specs/2026-08-18-format-progression-f3-f5-design.md`
> §2 and §7. Read that document and `docs/superpowers/specs/
> 2026-08-17-format-progression-prompts/_INDEX.md` before writing any code.
> Write the implementation plan first (superpowers:writing-plans), then execute
> it with a Scout/Implementer/Reviewer topology.
>
> **Deliver, in this order:**
> 1. Flip all six multi-stage templates in `apps/web/src/components/v2/
>    format-templates.ts` (lines 60, 79, 109, 122, 187, 205) from
>    `timing: "on_complete"` to `timing: "setup"`. Owner ruling: all six.
> 2. Derive `placement` from source shape instead of emitting `rank_order`
>    universally (`:62, :97, :111, :124, :193, :207`) — a group-stage source
>    implies `snake`; a template pinning specific seats uses `seeded_map`.
>    Owner ruling: automatic, no new UI. Match the structure of the working
>    references `server/templates/catalog/euro24.json:40` (`seeded_map`) and
>    `catalog/t20-super8.json:32` (`snake`); do not invent a third convention.
> 3. Resolve §7 P6: determine whether two progression sources with overlapping
>    pool keys collide in `descriptorKey`
>    (`packages/engine/src/competition/progression.ts`, `stages.ts:1457-1462`).
>    Fix it or record in the index why it cannot occur. Do not leave it open.
> 4. Verify §7 P1 by execution: a `setup` stage's fixtures reach the schedule
>    board and survive a BUILD. If any gate depends on entrant identity, that
>    gate is the real work — report before proceeding.
> 5. Decide and implement the §2.2 entrant-churn experience. The design
>    recommends option 1 (detect and offer a rebuild); confirm with the owner
>    before building, since §7 P3 establishes this is new UI, not new copy.
>    Ship a test for the stranded-seed case specifically — `stages.ts:1560`
>    records that the existing advice "cannot work" there.
> 6. Wire all 14 `label`/`help` strings in `STAGE_TEMPLATES` through the
>    dictionary, **with a reader in the same commit**. Keys nothing reads are
>    the inert-seam pattern L3 was made to revert; `i18n:check` verifies locale
>    parity, not usage, so unused keys stay green while being dead.
>
> **Do not touch**: `packages/engine/src/sport/**`, the fidelity-tier scale,
> the scoring pad, or the `StageKind` enum. §4's mexicano comment may be folded
> in as a one-line comment at `division-builder.tsx:61` and nothing more.
>
> **Before writing the task list**, grep `apps/web/src`, `scripts/`,
> `apps/web/e2e/`, `db/` and `packages/` in ONE pass for every symbol the
> session touches. F2's unowned work surfaced in four separate waves because
> each sweep was scoped to whatever that author happened to be editing (§6).
>
> **Verify**: `turbo run lint typecheck` from the repo root is the CI gate —
> `npm run lint` alone is not. Run vitest with
> `--reporter=json --outputFile=<path>` and judge only `numPassedTests` /
> `numTotalTests`; readable summaries print `PASS(0) FAIL(0)` for a suite that
> failed to collect. e2e specs pin the English picker labels, so step 6 will
> red CI unless they are updated in the same PR.
>
> **Verify by looking, not by counting.** Every serious defect in F1 and F2 was
> silent — a dropped key returning 200, a CHECK accepting what it was written
> to reject, a test asserting a defect approvingly. F3 changes what organisers
> see on every multi-stage format at once, so exercise all six templates end to
> end on a real build and inspect the rendered bracket.

### Prompt: F4 — day-one fixtures on the surfaces organisers hand out

> Implement F4 of the format-progression programme, per
> `docs/superpowers/specs/2026-08-18-format-progression-f3-f5-design.md`
> §4 and §7 (P5, P2). Read that document first. Write the implementation plan
> (superpowers:writing-plans), then execute with Scout/Implementer/Reviewer.
>
> One session, two deliverables. Day-one placeholder fixtures render correctly
> on eight HTML surfaces already; these are the two places they do not, and
> both are surfaces an organiser hands to other people.
>
> **This session does NOT depend on F3 and must not wait for it.** Three
> catalogue templates already emit `timing: "setup"` today —
> `apps/web/src/server/templates/catalog/euro24.json:47`,
> `league-playoff.json:32`, `t20-super8.json:33` and `:48` — so labelled
> placeholder fixtures exist to test against right now. F3 later widens who
> benefits; it does not enable any of this.
>
> **Deliverable 1 — the exported and printed draw (§7 P5).**
> `apps/web/src/server/usecases/exports.ts` selects no `*_slot_label` column
> anywhere: `exportFixtures` (`:205-220`) coalesces to the SQL literal `'TBD'`
> at `:209-210`, `:614` and `:726` apply `?? "TBD"` in TypeScript, and
> `officialDutyRows` (`:566-572`) and `ticketRegistrationRows` do the same.
> Select the columns and resolve them through `resolveSlotLabel`
> (`apps/web/src/lib/slot-label.ts`) — that module is deliberately the ONLY
> place a `SlotLabel` becomes display text, so do not hand-build strings.
> The export path is server-side and has no `useMsg()`; pass a `msgFor`-backed
> lookup exactly as `calendar.ics/route.ts:32-33` does, using the org's default
> locale rather than a request cookie, for the reason recorded at that file's
> `:24-30` (an exported document has no single viewer to read a cookie from).
>
> **Deliverable 2 — the subscribed calendar (§7 P2).**
> `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/
> calendar.ics/route.ts:40` filters `f.scheduled_at !== null`, so a final that
> exists at setup but has no time is absent from the calendar — contradicting
> the owner ruling recorded at `:24-30` of that same file, which names this
> exact case as the product value TBD fixtures exist to deliver. Emit tentative
> events for unscheduled fixtures.
>
> **The one constraint that a redeploy cannot repair**: keep the VEVENT UID
> keyed on the fixture id, so a final that resolves from "Winner of Group A" to
> a real name **updates in place** in calendars people have already subscribed
> to, rather than arriving as a second event beside a stale copy. Ship a test
> that asserts UID stability across resolution.
>
> **Tests** (all four types — unit, e2e, smoke, regression). Each must fail
> before the change:
> - An export of a division with generated `setup` fixtures contains
>   "Winner of Group A", and contains no "TBD" for any slot that has a label.
> - The `.ics` for such a division contains the final as an event.
> - The same fixture's UID is byte-identical before and after its entrant
>   resolves.
>
> **Do not touch**: `format-templates.ts`, `packages/engine/src/competition/
> progression.ts`, or the seeding region of `stages.ts` — those belong to F3,
> which may be running in parallel. Adding fixture data to `poster.pdf` (which
> today renders QR and branding only) is out of scope and separately worth
> doing.
>
> **Verify**: `turbo run lint typecheck` from the repo root is the CI gate —
> `npm run lint` alone is not. Run vitest with
> `--reporter=json --outputFile=<path>` and judge only `numPassedTests` /
> `numTotalTests`; readable summaries print `PASS(0) FAIL(0)` for a suite that
> failed to collect. Any new user-facing string goes into all four locale
> dictionaries.

### Prompt: F5 — the programme's test debt

> Close the deferred test debt from F1–F3, per `docs/superpowers/specs/
> 2026-08-18-format-progression-f3-f5-design.md` §5. Owner ruling: F1's owed
> smoke check plus the full recommended set. The table in §5 lists each item
> with its evidence — work it top to bottom.
>
> Two items need care rather than typing. **Measure the board payload budget
> before changing it**: §5's figure is inferred from arithmetic, not measured,
> and `e2e/board-v3.spec.ts:228` is the gate. And the three tautological tests
> assert a field is absent on a type that no longer has it — they would pass if
> the code were deleted, so replace the assertion, do not delete the test.
