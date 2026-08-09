# Marketing pick-a-template AI schedule demo — design

**Issue:** #364 · **Date:** 2026-08-09 · **Status:** approved by owner (this session)
**Scope guard:** no server code, no API route, no credit spend, no runtime model
call. Deliberately separate from #348/#350 (both closed; their code is the
thing being demonstrated, not changed).

## Summary

The `/[lang]/scheduling` marketing page gains a section where a visitor picks
one of three templates and watches a **recorded, real** AI Schedule Architect
run replay through the actual product components — `AiTrace`, `AiDiffPanel`,
the conflict list, the rung/price card. Zero LLM calls at runtime; the runs
are captured offline, once, by us, and committed as fixtures.

Placement decision (owner): a **section on the existing `/scheduling` page**,
below the attract-mode `SchedulingBoard` — not a new page, not a replacement.

## The load-bearing discovery: there is no server trace

The issue assumed the fixture stores `TraceEvent[]`. It must not. The server
response (`AiPlanResponse`) carries **no trace field**; the product console
synthesizes the trace client-side —
`apps/web/src/components/v2/board/ai-console.tsx` `buildScheduleTrace(plan,
courts, msg)` (line ~1379) — from `plan.proposal`, `plan.blocking`,
`plan.warnings` and `plan.usage.repair_rounds`, through `board.ai.trace.*`
i18n keys.

Storing a `TraceEvent[]` therefore means storing a **translation snapshot in
one language**, which breaks the 4-locale rule, and storing derived data that
silently drifts from the composer as the product evolves. The same argument
kills storing the computed diff, the conflict labels and the quote: every one
of them is derivable at render through existing pure functions.

**Decision: thin fixture.** The fixture stores *inputs and model output only*;
trace, diff and price are recomputed at render by the product's own code.
That is also a stronger honesty claim: the pixels the visitor sees are
produced by today's product code operating on a real recorded run — not a
screenshot of an old one.

### Rejected alternative — fat fixture (issue's literal wording)

Bake `TraceEvent[]`, diff, conflicts, quote into the JSON. Simpler capture,
but: 4 baked traces per template (one per locale) or a hardcoded-English
violation; derived data drifts from `computeAiDiff`/`quoteRun`/the trace
composer with no test able to notice (the drift test would validate the baked
copy against itself). Rejected.

## Fixture format

One JSON per template at `apps/web/src/demo/ai-templates/<slug>.json`:

```jsonc
{
  "meta": {
    "slug": "club-night",
    "capturedAt": "…",          // fixed at capture, not render
    "model": "…",               // exact model id that produced planRaw
    "commit": "…",              // repo commit of the capture run
    "mode": "generate" | "repair",
    "joint": false               // true only for northside-open
  },
  "board": {
    "fixtures": [ /* AiConsoleFixture-shaped: id, label, entrants, court, time, status */ ],
    "courts": [ /* labels, per division for the joint template */ ],
    "entrants": [ /* id, name */ ],
    "window": { /* session window(s), anchor date */ }
  },
  "planRaw": { /* AiSchedulePlan — the model's own output, verbatim */ },
  "response": { /* AiPlanResponse | AiCompetitionPlanResponse — post-verify */ },
  "verify": { /* VerifyConfig snapshot sufficient to re-run validateAssignments */ }
}
```

`planRaw` is kept verbatim so the drift guard can assert the *model output*
still parses and verifies — the museum-of-an-older-product failure the issue
names. `response` is kept because the UI renders from the verified shape.

Loaded by **dynamic import on card selection** — the T2 fixture (~115
fixtures, likely 100–200 KB) must not sit in the marketing page's initial
bundle.

## Capture pipeline — `scripts/capture-ai-demo.ts`

1. Ephemeral Postgres schema, smoke-script recipe (`seazn-local-env` skill):
   fresh throwaway `DB_SCHEMA`, `db:apply` **and** `sync:sports`, torn down
   after. Never the dev DB.
2. Seed the three datasets through the ordinary usecases — `createDivision`,
   `createEntrants`, `createStages`, `generateStageFixtures`
   (`apps/web/src/server/usecases/{divisions,entrants,stages}.ts`) — so the
   data is valid by construction. Deterministic: UUIDv5 from
   `<slug>/<entity>/<n>`, fixed anchor date (no `Date.now()`), fictional
   names per the issue comment's datasets (Riverside Badminton Club /
   Northside Open / Eastvale Tennis Club). T3 additionally pre-schedules and
   publishes all 40 fixtures, marks 11 `decided`, then applies the
   13:00–15:30 blackout — the repair input state.
3. Seed the org a credit balance (DB rows in a throwaway schema — free), then
   run the **real** architect once per template: `aiPlanForDivision`
   (`schedule-ai.ts:2469`) for T1 and T3 (`mode: "repair"`),
   `aiPlanForCompetition` (`competition-schedule-ai.ts:2316`) for T2. The
   provider key comes from `apps/web/.env.local`; token cost is paid once, by
   us, at capture time.
4. Write the fixture JSONs. Stable key order + trailing newline so a re-run
   with unchanged code diffs clean on the *seed-derived* parts.

**Determinism claim, stated precisely:** the *seeds and packs* reproduce to
identical bytes on re-run. The *model output* may legitimately differ — a
refresh produces a new fixture to commit, and the drift guard validates
whatever is committed. The issue's "re-runnable to identical bytes" applies
to the datasets, and the capture script asserts exactly that (it rebuilds the
pack and diffs it against the committed fixture's `board`/`verify` sections
in a `--check` mode).

## Runtime derivation

- **Trace:** extract `buildScheduleTrace` out of `ai-console.tsx` into a
  shared pure module (`apps/web/src/components/v2/board/ai-trace-compose.ts`),
  signature `(plan, courts, msg) => {events, flaggedIds}` with `msg` as a
  plain `(key, params?) => string` parameter. The console re-points to it
  (behavior-identical); the demo calls it with the visitor's locale. T2: the
  joint console (`ai-competition-console.tsx`) has its own composition — the
  implementation plan verifies whether it shares this composer or needs its
  own extraction; either way the demo renders T2 through the joint shapes,
  not by flattening into the single-division shape.
- **Diff:** `computeAiDiff(response, board.fixtures)`
  (`components/v2/board/ai-diff.ts:112` — note: *not* `lib/ai-diff.ts`; the
  issue's path is stale).
- **Price:** `predictRung` + `quoteRun` (`lib/ai-rung.ts:157/239`) with
  `schedulingRungWeights()` — env-fallback defaults, which is exactly what
  they resolve to in any client bundle; nothing sets `AI_RUNG_*` overrides
  today. The credit count shown is genuinely computed from the template's
  counts.
- **i18n payload:** the page ships the `marketing` dict plus a
  **server-filtered subset** of the `ui` dict — keys prefixed `board.ai.`
  plus the conflict-label keys `AiDiffPanel`/the conflict list read — via
  `DictProvider`. `ui.json` is 196 KB; shipping it whole to a public
  marketing page is not acceptable.

## Page section

New client island `AiArchitectDemo` on `/[lang]/scheduling`, below the
attract-mode board:

- Three template cards, **T3 "County League Finals Day" first** (hero slot,
  per issue). Card copy: name, one-line dataset, one-line "what it shows".
- Tap a card → dynamic-import fixture → timed replay of the composed
  `TraceEvent[]` through `AiTrace` (which already honours
  `prefers-reduced-motion` by dumping the full trace) → `AiDiffPanel` with
  local-state `onToggleExclude` (harmless interactivity) → conflict list →
  price card. `AiWishChips` display-only if used at all.
- **"Recorded from a real run"** label adjacent to the trace, plus the model
  id and capture date from `meta` — understating nothing, implying nothing
  live. New `marketing` keys, all four locales (en/es/fr/nl), flat dotted
  keys.
- 375 px: cards stack vertically, board panels scroll inside their own
  containers, no horizontal page scroll.

## Tests (all four types)

- **Unit — the drift guard, per fixture:** `planRaw` parses as
  `AiSchedulePlan` (`schedule-ai-prompt.ts:239`); `structuralCheck`
  (`schedule-ai.ts:1505` — currently unexported; exporting it is the one
  server-file touch) passes against the stored pack slice;
  `validateAssignments` (`packages/engine/src/scheduling/calendar.ts:1257`)
  returns zero blocking conflicts against the stored `verify` config; every
  `response.proposal[].fixture_id` exists in `board.fixtures`. T3
  additionally: every `decided` fixture is untouched by the proposal, and
  `unschedulable` is non-empty (the honest-output claim is load-bearing for
  the hero template).
- **E2E (Playwright):** on `/en/scheduling` — pick each template, trace
  replays to its end state, diff panel and price card render;
  `page.route`-level assertion of **zero requests** to any model host or to
  `/api/v1/**ai**`; a 375 px viewport case asserting no horizontal scroll;
  the recorded-run label present in all four locales.
- **Smoke:** a `scripts/smoke.ts` step confirming the scheduling page
  renders the demo section and three cards.
- **Regression:** the trace-composer extraction is pinned by a test asserting
  the console path's composed events are identical before/after the refactor
  (fixture-fed, not snapshot-of-English).

## Changes to existing code (complete list)

1. `structuralCheck` gains an `export` (drift guard needs it).
2. `buildScheduleTrace` extracted to a shared module; console re-pointed.
3. `/[lang]/scheduling/page.tsx` gains the section + the filtered-dict
   provider.
4. Four `marketing` dictionaries gain the demo keys.

No routes, no schema, no credits, no entitlements, nothing under
`(marketing)` beyond the one page.

## Out of scope (unchanged from issue)

Runtime model calls; free-text briefs; live in-browser re-solving (the
`Wish[] → SchedulingConstraints` compiler idea stays a follow-up); credits,
entitlements, wallet.
