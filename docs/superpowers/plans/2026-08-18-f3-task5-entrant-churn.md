# F3 Task 5 — entrant churn detection, honest rebuild, and the waiting-proposal prompt

Status: PLANNED, not started. Branch `feat/f3-day-one-fixtures`, worktree
`f3-day-one`, DB label `f3`.

Supersedes the framing in ruling 7. Read "Corrected premise" first — the
ruling describes a mechanism that the code does not have, and a plan written
from the ruling alone builds the wrong thing.

## Corrected premise (scouted 2026-08-18, file:line evidence)

Ruling 7 says: "when entrants change under a `setup` stage that already has
generated fixtures, surface it with a one-click rebuild." Two facts change
what that means:

1. **Downstream `setup`-timing stages are structurally insulated from entrant
   churn.** `generateProgressionSetupFixtures` (`stages.ts:1498-1516`) draws
   from `sourceShapeOf` (`stage-seeding.ts:128-142`), which reads pool
   TOPOLOGY — pool keys and config — and never touches entrant rows. Adding
   or withdrawing an entrant cannot invalidate a downstream setup stage's
   placeholder fixtures, because those fixtures never referenced an entrant
   in the first place.
2. **The churn exposure is the ROOT stage.** `generateStageFixtures`'s plain
   path (`stages.ts:1085-1101`) draws live from
   `select id, seed from entrants where status in ('registered','confirmed')`.
   That stage's fixtures DO name entrants, and they go stale the moment the
   roster moves.

So the deliverable is not "detect churn under a setup stage". It is:
**detect that a stage's generated fixtures no longer match the live roster,
which is a root-stage condition, and offer a rebuild that can actually fix
it.**

### The defect this uncovers, which is worth more than the banner

`generateStageFixtures` is **additive only** — idempotent via the
`fixtures.ext_key` unique index (`V288__v13_fidelity.sql:26-33`), and the
data-loss confirm dialog was deliberately removed
(`stages-panel.tsx:670-698`) precisely because generation never deletes.

Consequence: **an entrant withdraws, and their name stays on the bracket
forever.** The existing Generate button cannot remove the stale reference —
it only ever inserts missing rows. An organiser looking at a fixture against
a withdrawn player has no in-product route to fix it.

ORGANISER VALUE: this is a wrong name on a bracket the organiser has already
shared publicly. It is the most visible failure in this area and it has no
workaround today. The banner without the rebuild is a notification that
something is broken with no way to act on it.

## Deliverables

### 5a — Derived staleness signal (no schema change)

Compare, for a stage whose fixtures name entrants:
- the live active set: `entrants` where `status in ('registered','confirmed')`
- against the entrant ids referenced by that stage's fixtures
  (`fixtures.home_entrant_id` / `away_entrant_id`)

Both directions carry meaning and both must be reported:
- **referenced but no longer active** → a withdrawn entrant still on the board
- **active but never referenced** → a new entrant with no fixtures

Derived per ruling 7, never stored. Confirmed derivable today as a plain join
— no migration. What is NOT derivable is *when* the drift happened:
`entrants` has `created_at` only, no `updated_at`
(`V212__entrants.sql:4-15`). Do not add one for this; "since when" is not
needed to answer "does the board match the roster".

Do NOT reuse `stage_seed_proposals.status='stale'` or
`markDependentSeedProposalsStale` (`stages.ts:2732-2769`) — that machinery is
standings-scoped and reacts to a source stage's results changing. Roster
drift is a different signal with a different trigger; overloading it would
make both unreadable.

ORGANISER VALUE: the organiser learns their board is out of date from the
product, rather than from a player turning up to a fixture that no longer
exists.

### 5b — A rebuild that can actually fix it

The existing `POST /api/v1/stages/{id}/generate` is safe but churn-blind.
5b needs a path that can REPLACE a stale fixture set, not just top it up.

Hard constraints:
- **Never destroy entered results.** Refuse — loudly, with a message naming
  what blocks it — if any fixture in the stage has a score, is in progress,
  or is completed. This is the one place a wrong call is unrecoverable.
- **Never auto-run.** Ruling 7: detect and offer. The organiser presses it.
- **Never lock the entrant list.** Ruling 7, explicit.
- Scoped to the stage the organiser is looking at; must not cascade into
  downstream stages' placeholder fixtures without a separate confirmation.

Open decision for the owner, stated rather than assumed: when SOME fixtures
in the stage have results and others do not, the choices are (a) refuse the
whole rebuild, (b) rebuild only the resultless fixtures. Recommendation: **(a)
refuse**, and say why in the message. A partial rebuild silently changes who
plays whom in a half-played stage, which is the kind of thing that ends up in
a dispute the organiser cannot reconstruct.

ORGANISER VALUE: the withdrawn player comes off the board in one click,
before anyone travels to a fixture that should not exist.

### 5c — The waiting-proposal prompt (ruling 14)

Today `getSeedProposal` (`stages.ts:2527-2538`) is server-only — there is **no
HTTP GET route** — and `ProgressionPanel` is mounted only when
`tab === "fixtures"` (division page `:144`, `:354-364`). So a pending proposal
is invisible everywhere except one tab of one page.

Reuse, do not invent: `progression-panel.tsx:297-311` already renders the
house "needs attention" state — amber `border-amber-200 bg-amber-50`, a
`data-progression-state` hook, an inline CTA. `conflicts-panel.tsx:56-90` is
the second house pattern (`role="status"` pill badge outside the panel) and
is the better model for a signal that must appear when the organiser is NOT
on the fixtures tab.

Needs a read path. Adding a GET for the pending proposal also means an
OpenAPI change — the drift gate (`npm run openapi:gen`, clean `git status`)
runs in CI, so regenerate in the same commit.

ORGANISER VALUE: ruling 14 chose "always confirm" so no seeding decision
happens without a human. The prompt is what stops that choice from meaning
"the bracket silently stays full of placeholders after the results are in".

## Required tests (all four types, per standing policy)

- **Unit**: the derived signal, both directions, including the case where a
  withdrawn entrant is referenced by a fixture that already has a result
  (must report, must not offer a destructive rebuild).
- **Regression**: a rebuild attempt against a stage with entered results is
  refused — this is the test that must fail without the guard.
- **E2E**: withdraw an entrant → banner appears → rebuild → the stale name is
  gone from the board. Landing beside `progression-panel-*.test.tsx` and the
  division-page wiring test. Seven-width matrix applies to any new UI.
- **Smoke**: extend the existing progression suite in `scripts/smoke.ts`.

## i18n

All new copy in four locales under the existing flat dotted `progression.*`
prefix (`dictionaries/en/ui.json:290-309`), then `npm run i18n:gen-keys` and
commit the regenerated `apps/web/src/lib/i18n-keys.ts` in the SAME commit.
Server-thrown engine messages stay English by design.

## Verification

Worktree-prefixed, JSON reporter only, serial not concurrent (concurrent
engine+web runs produce load-flakes in `build-wall`, `roundrobin`,
`cfg-replay.conformance`, `email-builders`, `help-copy-truth`,
`org-posts-digest`). Baseline to beat: engine 3961/0/3974, web 5057 passed /
5 failed / 5130 (4 = `schedule-build-honours-locks`, needs the placement
service; 1 = `org-posts-digest`, green 7/7 alone).

Screenshots at 1280 / 320 / 768 with no horizontal page scroll at any width.
