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

**Consequence**: F4 as originally conceived has almost no work left. This
document recommends folding its comment into F3 and **retiring F4 as a
session**, renumbering F5 or leaving the gap. A session that exists to justify
its own number is how programmes accumulate ceremony. The owner should confirm
before anyone writes an F4 prompt.

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
