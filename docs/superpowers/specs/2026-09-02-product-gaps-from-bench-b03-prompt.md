# Product gaps surfaced by bench B03 — session prompt

**Written 2026-09-02 by the B03 (scheduler-bench seeding layer) session.**
B03's own prompt forbids touching product code, so none of these were fixed
there. Every one was found by trying to drive the product's real API from
outside it, which is what the bench is for.

> ## STATUS 2026-09-03 — six of nine FIXED (PR #706); G4 WITHDRAWN; G7 and G9 open
>
> | gap | state |
> |---|---|
> | G1 `persons.lane` had no writer | **FIXED** — `CreatePerson.lane`, persisted |
> | G2 no org-side official blackout | **FIXED** — `POST`/`DELETE /api/v1/officials/{id}/availability` |
> | G3 no REST fixtures list | **FIXED** — `GET /api/v1/divisions/{id}/fixtures` |
> | G5 catch-order untested | **FIXED** — named test in `api-v1/__tests__/http.test.ts` |
> | G6 doc publishes a different object than the route enforces | **FIXED** — one schema object per route |
> | G8 drift gate ignored the published spec | **FIXED** — `ci.yml` diffs `v1.public.json` too |
> | G4 `import.events` granted by no plan | **NOT A GAP** — deliberate rollout kill-switch; withdrawn |
> | G7 `business` seeded by a migration, absent live | **OPEN**, and NOT blocked on W2 |
> | G9 blackouts are write-only over the API | **OPEN**, new — found while CONSUMING G2's own fix |
>
> Each fix was verified present in the tree, not taken from the PR
> description. **Read the six closed sections as history, not as work.** They
> are kept in full because the reasoning is the reusable part — how each was
> established, what the counter-argument was, and (for G3, G6 and G7) where
> this document's own first draft was wrong. Only G4 and G7 are live, and both
> want the W2 plan read first:
> `docs/superpowers/plans/2026-09-03-entitlements-w2-matrix-and-plumbing.md`.

Read `docs/superpowers/RULES.md` first, then this file. Written against
`313af3818`; **re-verified 2026-09-03 against `origin/main` `6f04875e5`** and
corrected in six places (marked **[re-verified 2026-09-03]**). Still: **re-pin
every `file:line` before trusting it** — one pin had already moved by two lines
inside a day, which is the whole point of the rule.

**What changed under this document between the two commits:** entitlements
**W1 is CLOSED** (merged `ae0751682`, "scoring detail is free on every plan —
the paywall model retired"), and a W2 plan landed
(`docs/superpowers/plans/2026-09-03-entitlements-w2-matrix-and-plumbing.md`).
G4 and G7 both said "coordinate with W1/W2" — **W1 is done**, so read the W2
plan rather than this document's sequencing advice.

Concretely, W1 **removed every scoring entitlement**:
`requiredFeatureForEvent` and the whole fidelity-band gate are deleted (no
non-test definition survives in `apps/web/src` or `packages/`), and
`V390__scoring_free.sql` drops the `scoring.ball_by_ball`,
`scoring.rally_by_rally` and `scoring.match_timeline` rows from
`plan_entitlements` **and** from `org_entitlement_overrides`. One
scoring-adjacent gate remains, and it is not a scoring-detail gate:
`scoring.ts:269-271`'s `requiresDlsEntitlement` → `cricket.dls`, whose own
docstring (`:281-283`) calls itself "the ONLY entitlement gate left at the
scoring door". Anyone reading G4 or G7 as evidence about the scoring paywall
should stop — that paywall no longer exists. Both gaps are about a different
part of the matrix and both still stand.

## How to read the evidence lines

Each gap says how it was established. `READ` means the file was opened and the
relevant lines were read. `QUERIED` means a live migrated database was asked
(schema v389 — see G7, which is stale by one delta because of it). `RUN` means
a command was executed and its output observed. `DERIVED` means a stated fact
was computed from observed inputs and **not itself observed** — G7's post-V390
table is the only one, and it is labelled in place.

A grep alone was never treated as evidence — three claims in this repo have
been made and withdrawn in one day on exactly that mistake. The 2026-09-03
re-verification found that this document made the same mistake anyway: G3's
"called only from RSC pages" was a generalisation from a partial call list and
was false. Corrected in place rather than quietly deleted, because the pattern
is more useful to the next reader than a clean document would be.

Nothing below is a defect report about someone's work. Several are "we shipped
the enum and the writer went to a different wave", which is a sequencing
artefact, not carelessness.

---

## G1 — `persons.lane` admits `'coach'` and `'staff'`, and nothing writes them

**Owner has already said this needs fixing** (2026-09-02, in response to B03's
question). It needs a DECISION before a fix, because the two candidate fixes
are opposite.

**Evidence (READ, all six sites):** V348 created `persons.lane` as
`'player' | 'official'`. **V356 widened the CHECK to `'coach'` and `'staff'`**
for the S3/#426 ruling ("a team official is IN the squad so a card can be shown
to him, but never in a playing projection"). The CHECK moved; no writer
followed. Every `insert into persons` in non-test `apps/web/src`:

| site | what it writes to `lane` |
| --- | --- |
| `usecases/registrations.ts:668` | literal `'player'` |
| `usecases/officials.ts:171` | literal `'official'` |
| `usecases/entrants.ts:51` | column omitted → `'player'` default |
| `usecases/persons.ts:75` | column omitted → default |
| `usecases/imports.ts:514` | column omitted → default |
| `usecases/registrations.ts:810` | column omitted → default |

`CreatePerson` (`apps/web/src/server/api-v1/schemas.ts:488-495`) has **no
`lane` field at all**, so the API cannot express it either.

**Customer impact:** today, none directly — a coach IS expressible, just
elsewhere: `EntrantMemberInput.roles` (`schemas.ts:365-421`) and
`LineupSlotInput.role: z.enum(["player","coach","staff"])` (`schemas.ts:1058`).
The cost is to everyone downstream: a reader who takes the CHECK constraint as
the contract builds against a value no customer can produce. B03 nearly seeded
it by SQL, which would have meant the bench exercising a database rather than
the product.

**Recommendation — decide first, then do one of:**
- **(a) Delete `'coach'`/`'staff'` from the CHECK.** Correct only if the S3
  ruling is fully served by `roles` + lineup `role`. Cheapest, and it removes a
  trap rather than adding a surface. **[re-verified 2026-09-03 — this document
  originally added "which on today's reading it is". That was wrong, and the
  refutation is in the migration itself; see below.]**
- **(b) Wire a writer** — a `lane` field on `CreatePerson` plus whatever
  registration/roster path should set it. Correct if the lane is meant to be a
  person-level fact (e.g. "list this org's coaches" independent of any entrant).

**Strongest argument against (a) [re-verified 2026-09-03, and much stronger
than first written]:** V356's author anticipated exactly this argument and
rejected it, in writing, in the migration body. Quoting
`V356__persons_lane_coach_staff.sql` rather than citing it, because the wording
is the whole point:

> Schema-only: this completes S3's caveat for PERSON REGISTRATION (this
> table), a different axis from the per-FIXTURE lineup slot role
> (LineupSlot.role) `aggregatePlayerStats` filters on — that gap was closed
> separately, same review round, by V357 (`lineups.role`) plus the app-layer
> wiring in `player-stats.ts`/`org-posts.ts`. A coach registering in the
> person model (this migration) and a coach being named on a specific
> fixture's team sheet (V357) are independent facts about independent
> tables; neither implies the other.

So "the lineup role already covers it" is the precise claim V356 was written to
deny. That does not settle the question — the author could be wrong, and the
lane still has no writer eighteen months on — but option (a) has to answer that
paragraph, not step around it. Read #428's history too.

**Strongest argument against (b):** it adds a person-level concept that
duplicates a roster-level one, and two places to ask "is this person a coach"
is the parallel-vocabulary problem this repo keeps hitting.

**Test owed:** whichever way it goes, a test that fails without the change.
For (a) a migration test that the CHECK rejects `'coach'`; for (b) an API test
that round-trips a coach-lane person through `POST /persons` and reads it back.

---

## G2 — an organiser cannot set an official's blackout through the API

**Evidence (READ):** `official_availability` (V284) has exactly one writer in
non-test code — `usecases/me-officiating.ts:346` (insert) and `:360` (delete),
reached only by `POST`/`DELETE /api/v1/me/availability/officiating`. That is
the official's OWN self-service route. Readers are
`usecases/officials.ts:102` (`listOfficialBlackouts`) and
`usecases/schedule.ts:3376` (the scheduling join). `officials.ts:119` says so
in its own comment: "person-wide (V284 official_availability, written through
/me)".

**Customer impact:** an organiser who is told "I can't do the 14th" by text
message has no way to record it. They must ask the official to log in and enter
it themselves, or the blackout never reaches the scheduler — and the scheduler
DOES read it (`schedule.ts:3376`), so the constraint silently doesn't apply.
This is a real organiser workflow, not a hypothetical.

**Recommendation:** add an org-side write route (`POST`/`DELETE
/api/v1/officials/{id}/availability`) writing the same table, guarded by org
membership. Keep `/me` as-is.

**Strongest argument against:** the self-service-only design may be
deliberate — an availability claim is arguably the official's own to make, and
an organiser overriding it invites disputes. If that IS the intent, the gap is
in the UI copy, not the API, and the fix is to tell organisers to ask.

**Blast radius:** small — one new route, one existing table, no schema change.

**Note for whoever takes this:** bench B04 (scheduling layer) is chartered to
assert "official blackout → `warn.official_unavailable`". Without an org-side
route it must seed blackouts by signing in as each official. Worth knowing, not
a reason to rush the fix.

---

## G3 — no REST route lists a division's or stage's fixtures

**Evidence (READ + exhaustive search):** no file under
`apps/web/src/app/api/v1/**` references `listDivisionFixtures`,
`listDivisionFixturesForBoard` (`usecases/fixtures.ts:67,98`) or `FIXTURE_COLS`
— zero hits under that whole tree. That is the load-bearing claim and it holds.

**[re-verified 2026-09-03 — correction.]** This document first said the two
functions "are called only from RSC pages". **That is false.** They also have
two server-side non-page callers: `server/slideshow-data.ts:122` and
`server/usecases/withdrawal.ts:145`. Neither is an HTTP route, so the gap is
unchanged — but "only from RSC pages" was an unchecked generalisation from a
partial list, which is the exact mistake this document's own evidence rules
exist to prevent. The
only way to obtain fixtures with their `ext_key` over HTTP is
`POST /api/v1/stages/{id}/generate`, whose response carries the full
`FIXTURE_COLS` including `ext_key` (`usecases/stages.ts:1038-1046`;
`Fixture.ext_key` at `schemas.ts:1034`).

**Customer impact:** any API consumer — the documented, `api.access`-gated
public API — can create fixtures but cannot list them without re-POSTing a
generate call. `generate` is idempotent and returns `{created, existing,
fixtures}`, so it happens to work, but "POST to read" is not an API anyone
should have to discover.

**Recommendation:** add `GET /api/v1/divisions/{id}/fixtures` (and/or
`/stages/{id}/fixtures`) returning `FIXTURE_COLS`, paginated like the other
list routes.

**Strongest argument against:** if no customer has asked, this is speculative
surface, and every new public route is a permanent compatibility obligation.
Check whether `api.access` holders actually exist before building.

---

## G4 — ~~`import.events` is granted by no plan~~ **WITHDRAWN 2026-09-03: not a gap**

> **This entry was wrong, and the evidence to see that was already inside it.**
> The write-up noted that "the route's own comment (`:11-14`) says this is
> intended rollout state" — and then recommended seeding the `plan_entitlements`
> rows anyway. Those are opposite conclusions and the observation should have
> settled it.
>
> Corrected by the entitlements owner: **the 402 is a deliberate rollout
> kill-switch, not a forgotten row.** `import.events` is absent from design §2
> as well — it was never meant to be in the matrix yet. So granting it would not
> be closing a plumbing gap, it would be **shipping P11's batch importer to
> customers**, which is a product launch decision and explicitly not one a
> plumbing wave takes.
>
> Two corrections follow for whoever reads the rest of this file. It is **not**
> "blocked on W2" — W2 is the wrong instrument entirely, and no entitlements
> wave should grant this key on its own authority. And zero rows here is the
> feature working, so **do not re-file this** the next time someone greps
> `plan_entitlements` and finds nothing.
>
> The general lesson is the one this document keeps relearning: an absent row
> and a suppressed feature look identical from outside, and only the owner of
> the decision can tell them apart. The original text is kept below unchanged.

**Evidence (QUERIED, live DB at v389):**
`select plan_key, bool_value from plan_entitlements where feature_key =
'import.events'` returns **zero rows**. The route gates on it unconditionally
(`app/api/v1/divisions/[id]/events/import/route.ts:28` —
`await requireFeature(auth.orgId, "import.events")`), so **every org gets a 402**
unless an `org_entitlement_overrides` row is added by hand. The route's own
comment (`:11-14`) says this is intended rollout state.

**Customer impact:** P11 shipped (`ee5aa1a01`, #653) and no customer can reach
it. If that is deliberate staging, fine — but nothing in the plan matrix or the
pricing copy says the feature exists, so there is also no upgrade path to sell.

~~**Recommendation:** decide whether P11 is launched or staged, then either seed
the `plan_entitlements` rows for the intended tiers, or record an explicit
"dark until X" line in the entitlements index so the next session doesn't read
the missing rows as a bug. **Coordinate with entitlements W1/W2** — that
programme is rewriting this whole matrix (see G7).~~
**Superseded — see the withdrawal note at the top of G4.** The half of this
that still stands is the documentation half: a "dark until launched" line
somewhere durable would stop the next reader filing what I filed.

**Strongest argument against acting now:** W2 rewrites the tier set outright
(Free / Pro / Event Pass, `pro_plus` deleted). Seeding rows against today's
plans creates work for W2 to undo. Sequencing this AFTER W2 is probably right.

**[re-verified 2026-09-03 — still zero rows, but the sequencing advice moved.]**
The `import.events` finding itself is unchanged: still no `plan_entitlements`
row on any plan, still an unconditional `requireFeature`. What changed is the
programme around it — **W1 has merged** (`ae0751682`), and W2 now has a written
plan (`docs/superpowers/plans/2026-09-03-entitlements-w2-matrix-and-plumbing.md`).
"Wait for W2" is therefore a shorter wait than it was when this was written, and
whoever picks this up should read that plan rather than this paragraph: if W2 is
already touching the matrix, the `import.events` decision is one row in its
scope rather than a separate errand.

---

## G5 — nothing tests the `http.ts` catch-block ORDER, and the order is the contract

**Evidence (READ, including the ordering, which is the whole point):**
`apps/web/src/server/api-v1/http.ts`'s catch block dispatches in source order:
`ZodError` (:152) → `EngineError.is` (:157) → `PaymentRequiredError` (:214) →
`AuthError` (:228) → `HttpError` (:231).

`PaymentRequiredError extends HttpError` (`lib/errors.ts:24-31`). It is caught
by its specific branch **only because that branch sits seventeen lines above
the generic one.** Its branch returns
`errorResponse(requestId, 402, "PAYMENT_REQUIRED", err.message, { feature,
feature_key, reason, ...err.extra })`. The generic `HttpError` branch would
return the same 402 — the status comes from `err.status` — with
`code: undefined` (the constructor passes `undefined`) and **no `feature_key`**.

**Customer impact if reordered:** every contextual paywall goes generic. The
comment at `:215` states the contract: "feature_key drives the contextual
paywall (`<UpgradeGate>`)". A reorder keeps the 402, so no status-code
assertion anywhere notices; the customer just stops being told what to buy.

**Current guards (verified by the entitlements-W1 session, reported to B03):**
`scripts/smoke.ts:1924` asserts `status === 402 && feature_key === "ai.credits"`,
and `e2e/pro-plus-tier.spec.ts:176-211` reads `error.feature_key` out of 402
bodies. So a reorder reds something rather than sailing past. But both assert
the BODY from inside routes that would break for other reasons too — **no test
names the ordering invariant itself.**

**Recommendation:** one unit test over the error mapper asserting that a
`PaymentRequiredError` produces `code === "PAYMENT_REQUIRED"` and a populated
`feature_key`, with a comment naming the subclass-ordering reason. Cheap,
permanent, and it fails for the right reason.

**Strongest argument against:** it is guarded twice already and the file is
rarely touched; a third test is arguably ceremony. Counter: the two existing
guards are incidental, and the failure mode is silent degradation rather than
an error, which is the class worth a named test.

**Not a W1 problem:** the W1 session confirmed `git diff --name-only
origin/main...HEAD -- apps/web/src/server/api-v1/http.ts` is empty on its
branch, so the reorder cannot come from that wave.

---

## G6 — the OpenAPI document publishes a different schema object than the route enforces

**Evidence (READ, both objects):** `schemas.ts:3069` exports `CreateOfficial`,
imported by exactly one file — `api-v1/openapi.ts:295`, which publishes it as
the documented request body. The route
(`app/api/v1/officials/route.ts:3,15`) validates with a **different object**,
`CreateOfficialInput` from `usecases/officials.ts:51`.

**They are identical today.** I compared them field by field; the only
difference is `Uuid` vs `z.string().uuid()`, which is the same constraint. So
this is a latent risk, not a live bug — stated precisely because overstating it
would be the same error the bench exists to catch.

The B03 scout flagged the same duplication for `CreateVenue` and `CreateCourt`
(the routes use `usecases/venues.ts:106-121`). **[re-verified 2026-09-03 — lead
now closed.]** Both pairs are field-for-field identical:

- `CreateVenue` (`schemas.ts:4519-4523`) vs `CreateVenueInput`
  (`venues.ts:106-110`) — character-identical.
- `CreateCourt` (`schemas.ts:4527-4531`) vs `CreateCourtInput`
  (`venues.ts:116-120`) — identical once `RequiredCourtTags` is expanded;
  `schemas.ts:39` defines it as literally
  `z.array(z.string().min(1).max(40)).max(50)`, which is what the usecase
  spells out inline. Note `schemas.ts:37-38` says in its own comment that the
  inline spelling "can drift from the rest the next time the cap changes" —
  the duplication is known, and documented as a hazard, at the site itself.

So all three pairs are the same latent-risk shape and none has drifted yet.

**Customer impact if they drift:** the published API document lies. An
integrator builds to the spec and gets a 400.

**Recommendation:** have `openapi.ts` import the same object the route
validates with, and delete the duplicate. If the doc copy exists to keep
`usecases/` out of the OpenAPI layer, invert it instead — move the schema to
`schemas.ts` and have the route import THAT — so there is one object either way.

**Strongest argument against:** the split may be a deliberate layering rule
(`api-v1/` must not import `usecases/` types). If so, the fix is a drift test
comparing the two shapes, not a merge.

**[re-verified 2026-09-03 — this open question is now answered, and the
guess was right.]** Two corrections to how it was posed:

1. **It is not a pre-commit check.** There is no `.husky/` directory in this
   repo. The gate is a CI step — `.github/workflows/ci.yml:94-98`, "OpenAPI
   spec drift gate (PROMPT-11)". `AGENTS.md` calls it "pre-commit"; that line
   is wrong too, and is worth fixing when someone is next in that file.
2. **It cannot catch this class of drift**, exactly as suspected. The step runs
   `npm run openapi:gen` and then `git diff --exit-code openapi/v1.json`.
   `openapi-gen.ts:13` imports `buildOpenApiDocument` from
   `api-v1/openapi.ts`, which reads `schemas.ts`. So the generated side and the
   committed side both descend from `schemas.ts`, and the route's own
   `usecases/` object is on neither side of the comparison. `CreateOfficial`
   could drift arbitrarily far from `CreateOfficialInput` with this gate green.

That makes the recommendation above a real one rather than a hypothetical: the
gate that looks like it covers this does not.

---

## G7 — `business` is seeded by a migration and does not exist in a migrated DB

**Evidence (QUERIED, live DB at v389.** The original write-up printed the
table below **without the query that produced it**, which made it
unreproducible — re-running with a different, equally reasonable definition of
"granted" returns different numbers and reads as drift. The query is now part
of the evidence, which is the only form in which a derived table is worth
anything.)

```sql
-- schema is seazn_club, not public: PGOPTIONS='-c search_path=seazn_club'
select plan_key,
       count(*) filter (where bool_value)                            as granted_bool,
       count(*) filter (where int_value is not null)                 as granted_limit,
       count(*) filter (where bool_value is true
                           or int_value is not null)                 as granted_any,
       count(*)                                                      as rows
  from plan_entitlements group by 1 order by 1;
```

```
 plan_key     | granted_bool | granted_limit | granted_any | rows
 community    |           12 |            15 |          26 |   59
 event_pass   |           19 |             4 |          22 |   25
 event_pass_l |           19 |             3 |          21 |   25
 pro          |           43 |            11 |          52 |   60
 pro_plus     |           47 |             4 |          51 |   60
```

**[re-verified 2026-09-03.]** The original single `granted` column was
`granted_bool` — boolean-true rows only — and it is a **misleading name for
what it counts**. A plan's numeric limits (`ai.credits.monthly = 10`, and
fourteen others on `community`) are grants too, and `granted_bool` scores every
one of them as ungranted. Read as "features this plan grants", `community: 12`
is wrong by more than half; the honest number is 26. Anyone quoting one number
per plan should quote `granted_any`.

**Stale by one delta, in the direction this document warned about.** The
numbers above are a v389 database. `origin/main` is v390:
`V390__scoring_free.sql` (entitlements W1, `ae0751682`) deletes
`scoring.ball_by_ball`, `scoring.rally_by_rally` and `scoring.match_timeline`
from `plan_entitlements` outright. Reading those nine rows out of the v389 DB
(`community` holds all three as **false**; `pro` and `pro_plus` hold all three
as **true**) gives the post-V390 catalog by subtraction — **derived, not
queried, because this database has not been migrated to v390**:

```
 plan_key     | granted_bool | rows      (DERIVED from V390's DELETE, not observed)
 pro_plus     |           44 |   57
 pro          |           40 |   57
 event_pass   |           19 |   25
 event_pass_l |           19 |   25
 community    |           12 |   56
```

Which is the finding restating itself one delta later: a table of counts is a
photograph of a moment, and it went stale between being written and being
re-read the next day.

`V112__entitlements_v2.sql:21+` seeds `community`, `pro` **and `business`**.
`business` is absent from the result above — a later delta removed it — while
three plans a V112 reader never sees (`pro_plus` from V290, `event_pass`,
`event_pass_l`) are present.

**Customer impact:** none directly. The cost is to every future reader: the
entitlement rows are spread across a long tail of deltas (V024, V112, V240,
V269, V290, V302, V306, V311, V319, V341, V353, …) that insert, update and
delete each other's rows, so **no single migration is the catalog** and any
conclusion drawn from grepping one is a snapshot of a moment in its history.

**[2026-09-03 — NOT blocked on W2, and this document said otherwise. Corrected
by the entitlements owner.]** The finding is independent of that wave: "no
single migration is the catalog, query the live DB" is true before W2 and after
it. The banner and the standing-rules section both listed G7 as W2-gated; they
were wrong and are corrected.

**W2 does not block it — it makes it cheaper, in three ways.** All three are
facts about W2's own branch, NOT about `main`: as of this writing `origin/main`
carries no `enterprise`, no `entitlements-v18-matrix.test.ts` and nothing past
`V391`, so re-pin them against the tree before relying on any of it.

- `pro_plus` is **gone** and `enterprise` is **added**, so any code or note
  carrying the old five-key list is wrong the moment W2 lands. That includes the
  table below, which is exactly the failure mode this gap is about.
- W2's T2 converged the plan-key mirrors onto **one union**, so there is a
  code-side list to import rather than hand-roll.
- `entitlements-v18-matrix.test.ts` pins the live catalog against the design
  doc, so drift **fails a test** instead of surfacing at runtime. That is
  strictly better than the runbook `select` recommended below, and it is what
  the recommendation should defer to once it lands.

This exchange is the third time in two days the catalog moved under a written
claim — v389, then V390, now W2. The recommendation below was already "commit
the query, not the table"; treat that as confirmed rather than restated.

**Recommendation [sharpened 2026-09-03 by this document going stale on its own
terms]:** do NOT write a note naming today's plans — that is what the original
recommendation said, and it would already be wrong twice over (once for V390,
once again when W2 deletes `pro_plus`). Commit **the query**, not its output:
put the `select` above in the entitlements index or a runbook, with the schema
caveat, so the reader gets today's catalog instead of some past session's. If a
checked-in table is genuinely wanted, generate it and gate it in CI like
`openapi/v1.json`, so it cannot rot silently.

**Strongest argument against:** a runbook `select` still needs someone to run
it, and an ungated generated table is a note with extra steps. Counter: this
document is the worked example — its table survived one day.

---

## G8 — the OpenAPI drift gate never diffs the PUBLISHED spec

**Found 2026-09-03, while answering G6's open question. Not in the original
write-up.**

**Evidence (READ, then RUN):** `scripts/openapi-gen.ts` writes **two** files —
`openapi/v1.json` (`:18-20`, the full internal spec) and
`openapi/v1.public.json` (`:22-27`, described in its own header as "published
developer spec: the key-scoped surface + public tag only (served on
/developers)"). Both are committed. The CI gate
(`.github/workflows/ci.yml:94-98`) runs the generator and then diffs **one** of
them:

```yaml
- name: OpenAPI spec drift gate (PROMPT-11)
  run: |
    npm run openapi:gen
    git diff --exit-code openapi/v1.json || {
      echo "openapi/v1.json is stale — run 'npm run openapi:gen' and commit."; exit 1; }
```

`openapi/v1.public.json` is regenerated by that very command and then not
compared to anything. A change that alters only the published projection —
adding a route to the public tag, changing which surface is key-scoped —
leaves the committed public spec stale and merges green.

**Currently in sync, so this is latent, not live.** I ran `npm run openapi:gen`
at `313af3818` and `git diff --stat openapi/` was empty for both files, then
restored the tree. Stated this precisely for the same reason G6 is: overstating
it would be the error the bench exists to catch.

**Customer impact if it drifts:** worse than G6's. `v1.public.json` is the
document served to external developers on `/developers`. G6 is a risk that two
internal objects diverge; this is the gate that would have caught the divergence
reaching the customer-facing artefact, and it is only watching the other file.

**Recommendation:** one line. Diff both:

```yaml
git diff --exit-code openapi/v1.json openapi/v1.public.json || {
  echo "openapi specs are stale — run 'npm run openapi:gen' and commit."; exit 1; }
```

**Test owed:** the change IS the test — make it fail first. Edit
`v1.public.json` by hand, confirm the amended step reds and the current step
does not, then revert. Do not commit the amendment without having seen the
current gate stay green on a deliberately stale public spec.

**Strongest argument against:** if `v1.public.json` is a pure projection of
`v1.json`, it cannot drift independently and the second diff is dead weight.
Check that before writing the line — if it IS a pure projection, the honest fix
may be to stop committing it at all.

---

## G9 — G2's blackout route can be WRITTEN but not READ

**Found 2026-09-03 by B03 T6, while consuming G2's fix. Not a criticism of that
fix — it is the gap its shape leaves behind, and it was only visible from a
client trying to use it.**

**Evidence (READ, exhaustive):** `apps/web/src/app/api/v1/officials/[id]/availability/route.ts`
exports exactly two handlers, `POST` (`:13`) and `DELETE` (`:23`). There is no
`GET`. The reader that exists, `listOfficialBlackouts` (`usecases/officials.ts:106`),
has ONE non-test caller in the whole tree — an RSC page,
`app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/schedule/page.tsx:134` — and nothing
under `app/api/**` references `official_availability` outside that route's own
test file.

**Customer impact:** an organiser can record an official's blackout over the API
and has no way to read back what they recorded. Write-only is worse than absent
for an integrator: nothing to reconcile against, nothing to show the user, and
no way to make a write idempotent except by writing again.

**How it was found, which is the useful part:** B03's acceptance line is
"Officials assigned + blackout visible via **API read-back**", and that line
cannot be satisfied directly. The bench proves the blackout through
`POST /divisions/{id}/schedule/validate`, whose `warn.official_unavailable`
finding is a genuine, side-effect-free consequence of the row existing. That
works, and it is a WORSE test than reading the row: it proves the scheduler
noticed something, not that the value stored is the value sent.

**Recommendation:** add `GET /api/v1/officials/{id}/availability` returning that
official's rows. `listOfficialBlackouts` is org-wide; this wants the
per-official slice, guarded by the same
`requireResourceAuth(req, "official", id, ...)` the writes already use, with
`"read"` instead of `"write"`.

**Strongest argument against:** nobody has asked, and G3's counter applies —
every public route is a permanent compatibility obligation. Counter: unlike G3
this is not a new capability, it is the read half of a write that shipped hours
ago, and the asymmetry is the kind a client discovers only after building
against it.

**Same shape as G3.** That one was "the API can create fixtures but not list
them"; this is "the API can write blackouts but not read them". Two instances in
one wave suggests the write-first habit is worth a checklist line rather than
two separate fixes.

---

## Standing rules for whoever takes this

- **New branch in a worktree**, never the main checkout. `pnpm install
  --frozen-lockfile`; confirm `readlink -f node_modules/@seazn/engine` resolves
  INSIDE the worktree.
- Environment per `~/.claude/skills/seazn-local-env/SKILL.md`. `db:apply` alone
  is NOT a fresh schema — it needs `sync:sports`, or `funnel.test.ts` fails
  `expected 'generic' to be 'badminton'`, which reads exactly like a
  regression on your branch.
- **Every change ships a test that fails without it.** All four types
  (unit / e2e / smoke / regression) or the PR body names the deferral.
- Any new or changed user-facing string → all 4 locale dictionaries. G1(b) and
  G2 could both add one; G3–G7 should not.
- **Smoke CI runs on PRs only.** `e2e.yml` triggers on push to `main` only —
  read the file, do not trust any prose about it, including this line.
- G1 and G2 touch the persons/officials area, which has its own live
  programme — check `docs/superpowers/specs/2026-08-16-registration-redesign-prompts/_INDEX.md`
  before changing shapes there.
- **G4 is withdrawn** (deliberate kill-switch, see its own note) and **G7 is
  NOT blocked on W2** — an earlier version of this list said both were gated on
  that wave and both were wrong. What follows is kept for the W2 context only.
- ~~G4 and G7 touch entitlements, which is mid-rewrite.~~ **[updated 2026-09-03:
  W1 has MERGED (`ae0751682`, bringing `V390__scoring_free.sql`); W2 has a plan
  at `docs/superpowers/plans/2026-09-03-entitlements-w2-matrix-and-plumbing.md`.]**
  Talk to the W2 session before either. Neither is urgent; both get cheaper
  after W2.
- **Query the live DB through `search_path=seazn_club`.** Every table this
  document cites lives in that schema, not `public`; a bare `psql` connection
  answers `relation "plan_entitlements" does not exist`, which reads like a
  missing migration rather than a missing search path.
- **Do not quote this document's numbers.** Re-run its queries. The G7 table
  went stale one day after it was written, and the corrected version of G7
  explains why that is the finding rather than an accident.

## Verify

```bash
cd <your worktree> && npx turbo run typecheck lint
cd <your worktree>/apps/web && npx vitest run --reporter=default \
  --reporter=json --outputFile=<scratch>/gaps.json <target paths>
```

Judge green ONLY from the JSON — `numTotalTests`, `numPassedTests`,
`numFailedTests`, `numFailedTestSuites`. A suite that fails to COLLECT
contributes no tests and no failures, so `numFailedTests: 0` alone is not
green. Confirm every `.testResults[].name` sits under YOUR worktree: the
shell's cwd resets to the main checkout between tool calls, and a run launched
without a `cd` prefix in the same call executes on `main` and returns a false
green.

## Suggested order

**[revised 2026-09-03 — G6's blocking question is answered and G8 is new.]**

G1 (owner already called for it) → **G8** (one line, and it guards a
customer-facing artefact) → G5 (cheap, permanent) → G6 (no longer blocked: the
CI gate demonstrably cannot catch it, and all three schema pairs are confirmed
identical, so this is a clean pre-emptive merge) → G2 (real customer workflow)
→ G3 (needs demand evidence) → G4, G7 (both after entitlements W2 — **W1 has
now merged**, so read the W2 plan first).

G8 and G6 are the same area and G6's fix makes G8's second file more valuable;
doing them in one PR is reasonable if the branch stays small.

Nothing here is a blocker for bench B03, B04 or B05.
