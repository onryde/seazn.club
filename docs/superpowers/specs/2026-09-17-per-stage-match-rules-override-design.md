# Per-stage match-rules override — sets-based sports

Owner-approved 2026-09-17 (chat). v3. Supersedes v1 and v2 of the same
date; both were reviewed and came back Needs Fixes, and the corrections
below are what survived. Line numbers pinned against `main` `dc64cfcd6`
(contains #794 `f3dcbdb8b` and spectator #797 `22a9f6131`) and re-verified
against the tree, pin by pin, after the v2 review.

## Problem

Match format — `bestOf` and its neighbours in `MatchRuleFields`
(`apps/web/src/components/v2/match-rules.tsx`) — is settable once, on
`division.config`, and applies to every fixture of every stage. An
organiser cannot run Best-of-1 in the league/Swiss stage and Best-of-3 in
the knockout/playoff stage of the same division.

Not Swiss-specific. `swiss_playoff` / `swiss_knockout` are **template**
keys over the existing `swiss` and `knockout` `StageKind`s (#794); they are
not stage kinds. (`swiss_knockout` survives as a legacy string at
`apps/web/src/server/migration/v1-map.ts:17` and in
`packages/engine/src/testkit/simulation.ts:69,1025`, where a v1 import is
split into two stages — a customer for this feature, not a
counter-example.)

## Scope

**Sets-based sports only** (owner, 2026-09-17): tennis, badminton,
tabletennis, volleyball. **Per STAGE only** — not per round (see Known
gaps). **One editor**: the fixtures-tab stage panel.

### Field keys are NOT config keys — the distinction is load-bearing

A `RuleField`'s `key` names a FORM control; its `build()` decides which
CONFIG key is written, and for tennis the two diverge:
`setType`→`set` (a nested four-field object, `match-rules.tsx:382-389`),
`noAd`→`game` (`:417`), `tiebreakWinBy`→`tiebreak` (`:427`).

So the allowlist is the union of `Object.keys(field.build(probe, probe))`
over a sport's fields, **never `SPORT_RULES[sportKey].map(f => f.key)`** —
which is the expression already in the repo at `division-settings.tsx:273`
and would 400 four of tennis's five overrides. Resulting config-key sets:

| Sport | Form fields | CONFIG keys the allowlist admits |
| --- | --- | --- |
| tennis | `bestOf`, `setType`, `finalSet`, `noAd`, `tiebreakWinBy` | `bestOf`, `set`, `finalSet`, `game`, `tiebreak` |
| volleyball | `bestOf`, `setTo`, `finalSetTo`, `cap`, `winBy` | same names |
| badminton | `bestOf`, `setTo`, `finalSetTo`, `cap`, `winBy` | same names |
| tabletennis | `bestOf`, `setTo`, `finalSetTo`, `winBy` | same names |

`WIN_BY` (`match-rules.tsx:61-69`) is shared by volleyball, badminton
(`:140`) and tabletennis (`:167`) — it is not volleyball-only. Sources:
shared consts `:61-168` (wired `:360-362`), tennis `:363-429`.

### What the scoping does and does not buy

It removes two classes of problem outright, and converts a third into a
guard that must be built and tested:

- **No `shootout` / `extraTime` field** in any sets sport, so `rules`
  cannot become a second source for `STAGE_DECIDER_KEYS`
  (`engine-db/stage-cfg.ts:9`), which stays untouched.
- **No `teamSize` / `playersPerSide` / `goalkeeper` field**, so the lineup
  catalog is not cfg-coupled for these sports (see Known gaps).
- **`points` is NOT absent from these sports' CONFIG.** Tennis's
  `configSchema` carries a top-level `points` (`{win, loss}`,
  `packages/engine/src/sports/tennis/tennis.schema.json`) and the setbased
  kernel carries `pointsMap` (`sports/setbased/kernel.ts:115`, read at
  `:2249-2255`). What is absent is a `points` FIELD in `SPORT_RULES`. The
  merged-config parse would therefore ACCEPT `points`; **the allowlist is
  the only thing keeping it out**, which is why it must be enforced on
  every write path (T3) and tested for rejection, not assumed.

## Current resolution path (re-pinned)

- `resolveFixtureCfg` — `engine-db/fixture-cfg.ts:39`; `hasFrozenCfg`
  `:62-64` (its `:53-57` comment records that `undefined` is absence).
  Live cfg for a zero-event fixture is deliberate (`:24-28`).
- `stageScopedCfg` — `engine-db/stage-cfg.ts:11`, `STAGE_DECIDER_KEYS` `:9`.
- Callers: `append-event.ts:245`, `fold.ts:155`, `competition.ts:278`,
  `event-import.ts:280`, `player-stats.ts:439`, `match-centre-load.ts:291`,
  `admin-fixture-config.ts:120,191`, `org-posts.ts:761`.
- Freeze on first event: `append-event.ts:255` (`lastSeq === 0`), written
  `:328`; carve-out at `:250-255` — a JSON-`null` division config records
  events and freezes nothing.
- `StageConfig` — `schemas.ts:994-1035`, `.strictObject` (`:995`);
  `pairing:1018`, `points:1027`, `shootout:1032`, `extraTime:1033`.
  `rules` inserts after `:1033`.
- **A mirrored resolver exists**: `scripts/bench/lib/validate-pack.ts:394-406`
  (`stageScopedFoldCfg`, own `STAGE_DECIDER_KEYS` at `:392`), mirrored
  deliberately per its header `:380-391`. T1 must move it or prove packs
  cannot carry `rules`.

**Five surfaces bypass the resolver**, reading raw `division.config`:
`d/[divSlug]/f/[no]/page.tsx:119` (`rawConfig`) and `:171`
(`sport.config`); `score/[token]/page.tsx:84` (SQL aliases `d.config`),
`:145`, `:168`. The comment at `score/[token]/page.tsx:105-106` claiming
the device fixture carries its own resolved config is false — corrected
here. Pad skins read this directly: `tennis.tsx:268,505`,
`badminton.tsx:351,584`, `volleyball.tsx:496,648`,
`tabletennis.tsx:356,514`.

**Rule values do not round-trip.** Of 53 `RuleField` entries, exactly two
implement `read` (`match-rules.tsx:266,280` — football shoot-out points).
None of the in-scope fields has one, so a saved override reopens blank.
Live defect in the division editor today; T5 fixes it for the nine fields.

## Rulings

**D1 — the lock is per stage, and its predicate is named.** Division-wide
`FORMAT_LOCKED` stays as it is (`divisions.ts:582`, `:808-815`,
`:839-843` — it does lock `bestOf` today; this is a deliberate, recorded
relaxation for stage scope). A stage's rules are editable until the first
fixture in THAT stage has started, then locked.

"Started" is **not** `fixtures.status`: `fixtureStatusFromFold`
(`append-event.ts:119-129`) returns `in_play` only while an active
`core.start` exists, so voiding a start moves a fixture back to
`scheduled` — non-monotonic, and a stage whose only played fixture had its
start voided would re-open for editing. Use the monotonic pair:

```sql
select exists(
  select 1 from fixtures f
  where f.stage_id = $1
    and (f.config_snapshot is not null
         or exists(select 1 from score_events e where e.fixture_id = f.id))
) as locked
```

→ 409 `STAGE_FORMAT_LOCKED`. The `score_events` half covers the
JSON-`null`-config carve-out where no snapshot is ever taken.

*Interaction with the admin re-freeze:* `admin-fixture-config.ts` re-freezes
on `hasFrozenCfg(snapshot) && !LOCKED_FIXTURE_STATUSES.has(status)`
(`:135`, `:163`, `:184`) — it does not require `in_play`. Accepted, because
D1's predicate closes it: a fixture with a snapshot locks its stage, so no
rules edit can land after one exists. A test pins that ordering.

**D2 — allowlist, validation, storage.** The allowlist is derived from
`build()` output as above, per sport. Every write path validates the MERGED
`{...division.config, ...rules}` through the sport module's `configSchema`
and 422s `CONFIG_INVALID`, mirroring `divisions.ts:822-829`; the fragment
alone cannot be parsed, since defaults would fill it. **Validate the merge,
store the FRAGMENT** — storing `parsed.data` would write a
defaults-materialised full config into `config.rules` and pin the stage to
every division key forever.

**D2a — the sport gate is a guard, not prose.** Both write paths 400 for
any `sport_key` outside `{tennis, badminton, tabletennis, volleyball}`.
Without it a football division can POST `rules.points` — a shape
`SPORT_RULES.football` genuinely emits (`match-rules.tsx:194-204`) — which
T1's overlay then feeds to `standingsDelta` (`football.ts:2630-2633`) with
`standings.custom_points` never checked (`createStages` gates on
`s.config.points`, `stages.ts:282-289`, `requireFeature` `:287`).
`createStages` never parses stage config through any `configSchema`, so it
cannot be left as a second door: **`createStages`/`replaceStages` reject a
`rules` key outright** (400) — no caller needs it now that the builder is
out of scope (T6).

**D3 — the public hub format line is in scope.** `formatLine` is built from
raw division config at `competition-hub.ts:665`, `describeFormat`'s only
production caller. `describeFormat` is pure and takes a bare cfg
(`describe-format.ts:94-98`), so it is callable per stage. Shape:
`HubDivision` (`competition-hub-schema.ts:103-134`) gains
`stageFormatLines: z.array(z.object({stageName, line: Msg})).optional()`;
`formatLine` (`:119`) stays as the division default. Optional because the
hub API answers `s-maxage=30, stale-while-revalidate=300` (`:123-130`), so
a new bundle polls documents built before the field existed — the
`pub-hub-v3`→`v4` bump (`competition-hub.ts:1042`) clears `unstable_cache`
only, not that. The hub query must additionally select `s.config`, and
`competition-hub.test.ts:2489` pins `["pub-hub-v3","comp-1"]` and moves
with the bump.

**D5 — no entitlement gate.** Per-stage rules are core format settings.
D2's allowlist plus D2a's sport gate are what keep `points` out of reach.

**D6 — `replaceStages` preserves `rules` SERVER-SIDE** (owner, 2026-09-17,
after the Tasks 1-4 review). D2a's `assertNoRulesKey` closes the
create/replace door, which makes T6's original instruction — have the
client carry each surviving stage's `rules` through `structureDraftsForApply`
— unbuildable: the body it would send is exactly what the guard refuses.
Meanwhile the Format tab's Apply deletes every stage and re-creates it, so
without this ruling an unrelated knob nudge wipes every override silently,
in precisely the window (stages configured, fixtures not yet generated)
where format gets set. `replaceStages` therefore reads each stage's
`config.rules` before the delete and re-applies it to the new stage at the
same `seq`, so the guarantee holds for every client rather than only the
one screen that remembered. An override is per stage SLOT: if the stage at
that seq changes `kind`, the override is dropped rather than carried.

**D4 — WITHDRAWN. Rule labels stay English** (owner, 2026-09-17).
`match-rules.tsx:6-9` already records rule vocabulary as canonical English,
like sport and format names, with only the picker chrome localised; the
owner confirmed that decision stands. So this feature ships **no
dictionary work and no `gen-keys` regen for the labels themselves**.
Anything the stage panel adds around them — a "Same as division" control,
a lock reason, an error toast — is picker chrome and DOES owe all four
dictionaries plus the regen. Keep that line clear in review: the nine
field labels are exempt, the panel's own copy is not.

**D7 — where the editor lives. OPTION A, ruled by the owner 2026-09-18.**
Both options were rendered into the LIVE division page and shown to the owner
as screenshots (real CSS, real neighbouring controls, real data: stage 1 was
genuinely Complete so its locked state was not a mock-up, and stage 2 genuinely
carried `config.rules = {"bestOf": 5}`). The owner picked **A**.

The surface was mapped before the options were drawn, and every claim below
was re-read in the file rather than taken from the grep:

- The stage card is **inline JSX** in `stages-panel.tsx` (`:660` loop,
  `:786` `<section className="card overflow-hidden">`, `:804`
  `data-testid="stage-sheet"`, header `:805-810`). There is no stage-card
  component to extend.
- `stages-panel.tsx` carries **zero `max-md:` and zero `md:hidden`** —
  verified, not asserted. The stage card has no phone branch at all.
- Every phone-specific edit action lives in `desk/stage-rail.tsx`, whose
  trigger (`:241`), backdrop (`:252`) and sheet (`:349`) are `md:hidden`
  / `md:static`. That file is governed by the phone-composition design of
  record.
- Two precedents sit in the same card and point opposite ways:
  `AddMatchForm` (`:1576`, mounted `:912`, container `:1621`
  `border-b border-dashed bg-slate-50/60 px-4 py-3`) is an **inline
  expanding form**; `StageCourtTagsEditor` (`:1681`) is a **modal** reached
  from the rail.

**Option A — inline format row in the stage card** (`AddMatchForm`
precedent). One collapsed line in the card body; Edit expands
`MatchRuleFields` in place. Its `grid gap-4 sm:grid-cols-3` collapses to one
column below 640 on its own, so A needs **no new phone branch**.

**Option B — read-only line on the card, editor in the rail**
(`StageCourtTagsEditor` precedent). Editing joins the rail's action list —
bottom sheet on phone, modal ≥768.

The render settled an argument no text sketch could: **B puts the editor entry
point inside the destructive row.** At 1280 `Match format…` lands between
`Generate fixtures` and `Complete stage` / `Delete`, and in the phone sheet it
sits directly above the same two. That rail is a list of IRREVERSIBLE stage
actions; changing Best-of is a reversible setting that the API refuses outright
once the stage has started. A also renders the locked state with no control at
all — `Best of 3 · Locked — this stage has started` occupies the slot the Edit
button otherwise holds — where B must explain the same thing inside a sheet the
organiser has already tapped twice to reach.

A's cost, equally visible in the render: the open editor pushes the counts and
the fixtures link down ~150px, and at 320 it fills most of the viewport.
Measured at 320 with the editor open: `scrollWidth 320 = clientWidth 320`, no
horizontal scroll, fields stacked, both buttons on one row.

Recommendation was: **A**. Blast radius is the deciding argument — B opens
`stage-rail.tsx`, a file with its own owner-approved design of record,
while A opens none. Second, `stages-panel.tsx:786-804` records that the
two-column layout was retired after the card was measured
`body=262px rail=262px content=99px VOID=163px` — 62% empty at 1280 — with
the note that "no body content short of a fixture list could have fixed
it". A adds body content to a card measured as starved of it; B keeps it
starved. Third, A is one tap on phone against B's two. B's honest
advantage is that the card is already dense.

Either way, three states and their copy (all four dictionaries — the nine
field labels are exempt under D4, this chrome is not):

| State | Line | Controls |
| --- | --- | --- |
| inherited | `Best of 3 · Same as division` | Edit |
| overridden | `Best of 5 · Stage override` | Edit, Use division format |
| locked (409 `STAGE_FORMAT_LOCKED`) | `Best of 5 · Locked — this stage has started` | none |

There is **no existing default-vs-overridden precedent in the panel**; the
nearest anywhere is `division-settings.tsx:991-998`
(`divset.entrants.sportDefault` / `.overridden` plus a Reset button), and
the new copy should read like it.

**What A is, concretely** (validated in the browser against the live card):
the row is inserted immediately BEFORE `[data-testid="stage-progress"]`
inside `stage-sheet`, as a `border-b border-slate-100 px-4 py-3` band — the
same band the header uses. Expanding reuses `AddMatchForm`'s container
(`border-b border-dashed border-slate-200 bg-slate-50/60 px-4 py-3`) and
mounts `MatchRuleFields` unchanged; its `grid gap-4 sm:grid-cols-3` does the
phone stacking, so **A adds no `max-md:` and no `md:hidden`** and the stage
card keeps its property of having no phone branch. Buttons are the card's
own `btn btn-primary` / `btn btn-ghost` with `min-h-11 px-3 py-1.5 text-xs`.

**D8 — the panel's lock needs a server-fed prop; the page cannot derive it**
(ruled 2026-09-18, during Task 7, on the implementer's blocked report).

The server locks a stage on `f.config_snapshot is not null OR exists(score_events)`
(`stage-rules.ts:87-92`), deliberately NOT on `fixtures.status`, because voiding
a `core.start` moves a fixture BACK to `scheduled`. Nothing client-side can see
either fact: `FIXTURE_COLS` (`stages.ts:139-145`) carries no `config_snapshot`
and `score_events` reaches no page prop. The only client-visible "has started"
is `hasPlayedFixture` (`lib/division-phase.ts:414`), which is exactly the status
predicate the server avoided — and it under-reports after a void, i.e. it fails
in the BAD direction: server locked, UI offers Edit, organiser gets a 409 on a
control the product had just offered.

**Widening `FIXTURE_COLS` is refused.** `stages.ts:147-162` records a payload-
budget regression (PR #606, `board-v3.spec.ts` "gap 15", 279043 bytes against a
250000 budget) caused by five SCALAR columns; `config_snapshot` is an entire
frozen config per fixture.

Ruled: a division-scoped `formatLockedStageIds` in `stage-rules.ts`, called from
`page.tsx` the way `getStageRosterDrift` already is, skipped entirely when the
sport is not in `STAGE_RULES_SPORTS`. **Its predicate and `putStageRules`'s must
be ONE shared SQL fragment, not two kept in step** — this is a lock whose halves
are a UI that OFFERS a control and a server that REFUSES it, so drift is
invisible until an organiser is told "saved" by one and 409'd by the other.
Mutating one half of the fragment must red BOTH call sites' tests.

Two further props, both already on the page: `sportKey` (`page.tsx:263`) and
`divisionConfig` (`:829`).

**D8a — the summary line and the editor read DIFFERENT things.** The line shows
the EFFECTIVE config (`{...divisionConfig, ...rules}`), because an inherited
stage's fragment is empty and the line must still state the number the stage
will be played at. The editor hydrates the FRAGMENT ONLY. Hydrating the editor
from the merge fills every field, so the first save writes every key and pins
the stage to today's division format permanently — the defect D2/T5 exist to
prevent. One function, two inputs; say so in a comment, because a later reader
will "simplify" it.

**D9 — a value the picker cannot offer must be SHOWN, not swallowed**
(ruled 2026-09-18, from a reviewer finding on Task 6).

Badminton's `bestOf` offers only `[1, 3]`, but the engine's schema accepts more
— the walkthrough override that proved this whole seam is `{"bestOf": 5}` on a
badminton stage. Hydrating that into the select renders BLANK, above an
`<option value="">Default`. The same shape has three different consequences,
and only the third is a defect:

- `buildRuleOverride` skips `""`, so no `Number("") === 0` is written. Safe.
- `division-settings.tsx` builds its PATCH from a `{...division.config}` BASE,
  so an omitted key keeps its existing value. Cosmetic there.
- **The stage panel sends a FRAGMENT, where an omitted key means INHERIT.**

**CORRECTION (Task 7, proved in the browser): the badminton case does NOT lose
data, and the ruling's stated reason was wrong.** `values` keeps `"5"` in React
state even while the select paints blank, so `buildRuleOverride` re-emits it and
an untouched save is a no-op. The badminton defect is MISREPRESENTATION — the
screen reads "Default" over a live override — which is real but cosmetic.

The genuine data-loss case is narrower and was found only by implementing the
guard: **a stored value that NO field can hydrate** — a tennis `set` matching no
declared shape — because `hydrateRuleValues` returns nothing for it, so
`buildRuleOverride` can never re-emit it and a rebuilt fragment drops it. That
one is unreachable from React state, and it is what `stageFormatSaveFragment`
actually protects by re-sending the STORED fragment verbatim when nothing was
touched. The ruling's OUTCOME stands — both the synthetic option and the diff
are owed — but the badminton example motivates only the first of them.

Ruled: `MatchRuleFields` renders a synthetic, selected option for a hydrated
value not among `options`, labelled from the raw value. Fixes the division
editor's cosmetic case in the same stroke and removes the stage data-loss path
at its source. And generally: **the fragment PUT must be diffed against what
was hydrated** — "the organiser touched nothing" must never produce a clear,
and `{rules: null}` stays reachable only from the explicit "Use division
format" control.

This is failure class 19 inverted. That rule says a present, wrongly-seeded
field can be worse than an absent one because it overrides a correct default.
Here a PRESENT value renders as absent and is then written as absent — same
lesson, opposite direction: pin what a control OPENS AT, and check which way
the precedence runs before calling the gap closed.

## Design

### T0 — extract the rules table out of the client module

`match-rules.tsx:1` is `"use client"` and `:10` imports the dict provider;
its only importers today are client components and tests. A server module
importing it receives client references, not values — and `schemas.ts`
cannot hold the table either, because `scripts/openapi-gen.ts` runs that
file under bare `node --experimental-strip-types`, which parses neither
`@/` imports (`schemas.ts:4-20`, `:1013-1015`) nor JSX. **A vitest unit
test of the derivation passes regardless** (node env, no RSC boundary), so
getting this wrong ships green and inert.

Move `RuleField`, `SPORT_RULES`, `buildRuleOverride`, `hydrateRuleValues`
and the allowlist derivation into a directive-free, JSX-free
`apps/web/src/lib/match-rules.ts`; `match-rules.tsx` re-exports them and
keeps `MatchRuleFields`. The derivation must be exercised by a test that
runs in the SERVER graph, not only from the existing client-side test.

### T1 — resolver

In `stageScopedCfg`, apply `rules` FIRST, then the decider-key loop, so a
stage's own `shootout`/`extraTime` keep priority over anything in `rules`
(belt and braces — D2's allowlist already bars them):

```ts
if (isPlainObject(stageCfg.rules)) Object.assign(overlay, stageCfg.rules);
for (const key of STAGE_DECIDER_KEYS) { /* unchanged, runs after */ }
```

Merge order overall: `snapshot ?? {...divisionCfg, ...rules, ...deciders}`.
Identity when a stage has no `rules` — `stage-cfg.test.ts:24-27` asserts
reference identity and must keep passing. `Object.assign` copies explicit
`null`s, so **"inherit" is key ABSENCE, never `null`**; the endpoint strips
nulls on the way in. The merge is shallow: `rules.set` replaces the whole
`set` object, which is safe only because tennis's `build` emits all four
sub-fields (`match-rules.tsx:380-381` records the same invariant
client-side) — the merged parse is the enforcement.

Also in T1's file set: the bench mirror
(`scripts/bench/lib/validate-pack.ts:394-406`), and
`competition.ts:249`'s comment reasoning about what `stageScopedCfg` can
produce, which T1 widens. `packages/engine/src/sports/cfg-replay.conformance.test.ts:8`
quotes the resolver contract and may owe a `rules` case.

### T2 — atomic stage-config writes

Six writers rewrite a stage's whole config from a JS-side read with no
lock: `stages.ts:3176,3265,3699,3876`, `scoring.ts:555,567`. A rules write
inside that window is silently lost. #794 shipped the server-side merge
pattern at `stages.ts:764` — but that one is guarded
`and config->>'rounds' is null`, i.e. write-once. `rules` must be
replaceable and clearable, so: `config || jsonb_build_object('rules', …)`
to set, `config - 'rules'` to clear. Convert all six; the new endpoint
writes the same way.

### T3 — endpoint

`PUT /stages/:id/rules`. `withTenant` + `stageOrThrow` follow
`stage-court-tags.ts:134-209`, but that file has **no** billing-freeze
guard — take the freeze pattern from `registration-approval.ts:112,139`
instead (resolve `frozenCompetitionIds` BEFORE the tx, `assertNotFrozen`
inside). Plus D1's lock, D2's allowlist + merged validation + fragment
storage, D2a's sport gate, T2's atomic write, and an **awaited**
revalidation — `stages.ts:1335,1724,2798,3746` are four `void
fireStageRevalidate` calls already recorded as a defect; do not add a
fifth. Body `{rules:{…}}`; `{rules:null}` clears. This endpoint is the only
writer. OpenAPI regen (`ci.yml:92-96` gates drift).

### T4 — resolver threading

Route the five pad surfaces through `resolveFixtureCfg`. Both routes must
select **two** columns they do not select today — `f.config_snapshot` AND
the fixture's stage config: `getFixture` (`fixtures.ts:44-66`) selects
neither, and the device-link SQL (`score/[token]/page.tsx:82-92`) selects
neither. Because `hasFrozenCfg` treats `undefined` as absence, forgetting
`config_snapshot` renders live cfg for every scored fixture with no error.

### T5 — `read` for the in-scope fields

Implement `read` on each in-scope `RuleField` so the panel hydrates. The
panel hydrates from the stage's FRAGMENT — `hydrateRuleValues(sportKey,
stage.config.rules ?? {})`, never the division or resolved config, which
are defaults-materialised (`usecases/divisions.ts` materialises every
`.default()` at write time, per `lineup-catalog.ts:22-23`) and would make
the first save pin the whole division format into `config.rules`. With
`read` complete for the exposed set, the endpoint replaces `config.rules`
wholesale and "clear a field" means "inherit".

### T6 — UI: the Fixture Console only

No division-builder change (owner, 2026-09-17). The only editor is the
fixtures-tab stage panel `stages-panel.tsx` — per stage, "Same as
division" by default, disabled with a reason once D1's lock bites.
`structureDraftsForApply` (`division-settings.tsx:213-226`, applied
`:551-553`) rebuilds stage drafts from the template and drops stored
config; it must carry each surviving stage's `rules` forward, with a test
that fails without it.

### T7 — public format line

Per D3: hub query selects `s.config`, `stageFormatLines` built via
`describeFormat(sport_key, module_, stageScopedCfg(d.config, s.config))`,
schema + OpenAPI regen + `pub-hub-v4`, renderer on the hub division view.

## Testing

- **Unit** — `stageScopedCfg`: identity without `rules`; per-key override;
  decider keys still win; `null` never overrides. Endpoint: allowlist
  rejection (including a tennis `set` accepted where `setType` is
  rejected), merged-config 422, D1's lock boundary, D2a's sport gate,
  tenancy, freeze. `createStages` with a `rules` key → 400, **with a
  football `rules.points` case** — that test is what makes the scoping
  claim non-vacuous. Each guard verified by mutation: break the predicate,
  confirm a named test reds.
- **E2E** — a sets-sport division, league/Swiss and knockout at DIFFERENT
  formats, both generated; open the pad in each stage and assert the
  rendered format. Two constraints, or the test cannot witness its own
  regression: pick values that differ from the skins' `?? ` fallbacks
  (`cfg.bestOf ?? 3` for tennis/badminton, `?? 5` for
  volleyball/tabletennis), and derive both expectations from
  `configSchema.parse` output rather than a constant typed into the test.
  The only cfg-derived text the skins render is a translated context line
  taking `bestOf` as a param (`tennis.tsx:507`, `badminton.tsx:601`,
  `volleyball.tsx:657`, `tabletennis.tsx:529`) — assert on a testid and
  value, not English text. Mutant: set both stages to the same format and
  confirm the test reds. Then score a fixture, confirm its frozen snapshot
  is unchanged, and confirm the stage is now locked.
- **Regression** — (a) a frozen `config_snapshot` differing from live
  division config renders FROM THE SNAPSHOT on both pad routes (names the
  column, per T4); (b) a stage carrying only `shootout` overlays as before;
  (c) no stage rules anywhere resolves byte-identically.
- **Smoke** — Fixture Console round-trip: set an override, reload, confirm
  it hydrates (the T5 gap is exactly what fails this today).
- **Visual** — contact sheet at 320/390/768/1024/1280, per-screen verdicts,
  owner sign-off before PR; the spectator programme's gate applies to T7.
- Full spec files for e2e, never a `-g` slice; JSON reporter counts only.

## Known gaps — recorded, not fixed

- **Four lineup-catalog sites read raw `division.config`**:
  `d/[divSlug]/f/[no]/page.tsx:70`, `score/[token]/page.tsx:107`,
  `usecases/fixtures.ts:312,320` (SQL `:380`), `d/[divSlug]/page.tsx:37,269`.
  Catalog inputs are `teamSize`/`playersPerSide`/`goalkeeper`
  (`lineup-catalog.ts:4-30`) — team sports only, none in scope. They become
  live defects the day a team sport gains a stage-overridable `teamSize`.
- `event-import.ts:245-256` gates DLS entitlement on `division.config` by
  deliberate comment. Cricket, out of scope; a stage override must not move
  that gate.
- Team sports are excluded; extending re-opens D2a's entitlement question
  and the decider-key second source, and owes its own design round.
- **Per-ROUND overrides are out** (owner: "per stage only"). A round is an
  integer column on `fixtures`, not a row that can carry config, and
  per-round re-opens the mid-stage fairness question D1 closes.
- Not verified: whether `resolveScorePadBootstrap` tolerates a frozen
  snapshot predating a later schema change. Flagged, not asserted.
