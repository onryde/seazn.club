# Parser blackout: teaching the instruction parser a word the engine already knows

Owner-approved 2026-08-16. Follows the instruction-parse bench
(`f7ee29cd`) and the parser model flip (`b64482d`).

## Why

The parse bench put the same instruction in front of five models:

> "…run for 4 days and keep 2 matches in the morning and 3 matches in the
> afternoon also we have lunch break from 12PM to 1PM"

The shipped model compiled the lunch break as `not_before 12:00` plus
`not_after 13:00` — which confines the entire tournament to the lunch
hour. That is the worst failure this pipeline can produce: a rule the
organiser is shown as enforced, that enforces something they never asked
for.

The obvious reading is that a mid-day break is a missing engine
capability. **It is not.** `packages/engine/src/scheduling/calendar.ts`
has carried `Blackout { court?, from, to }` all along; `build-grid.ts`
removes blackout slots from the lattice, the verifier reports blackout
violations, and `schedule-ai.ts` already ships `config.blackouts` into
the AI pack's settings. An organiser can set a lunch break by hand
today.

What is missing is a **word in the parser's vocabulary**. So this is the
cheapest of the four schema gaps the bench found, and the one with the
largest damage when left open.

## Non-goals

- Per-period caps ("2 in the morning, 3 in the afternoon"). Still
  unexpressible, still defers. Separate work.
- Per-date caps, per-entity caps, stage selectors.
- Recurring breaks that vary by day ("lunch is 12:00 on Saturday,
  13:00 on Sunday"). One daily break, applied to every day of the run.
- Breaks that span midnight. Refused — see Refusals below.

## Shape

### 1. A new hard rule

```ts
{ type: "no_play_between",
  from: "HH:mm",
  to:   "HH:mm",
  court?: string,      // omit for a break on every court
  scope: Scope }
```

`scope` is competition-only in practice: engine `Blackout` has no
division concept. A division-scoped break is refused into `unparsed`,
exactly as a division-scoped `window` already is.

### 2. Courts enter `ParserContext`

```ts
interface ParserContext {
  divisions: { id: string; name: string }[];
  courts: string[];
}
```

This is a deliberate reversal of the rule that removed `ext_key` on
2026-08-16 ("never offer a field the model cannot fill honestly"). The
reversal is safe **only** because the guard below makes the field
verifiable: unlike a fixture key, the full set of court labels is small,
known, and cheap to show.

### 3. The court guard

Any `court` the model emits is matched against
`ParserContext.courts` exactly. An unknown label sends the **whole
break** to `unparsed`.

It must not merely drop the court field. "Court 2 is closed at lunch"
silently becoming "everything stops at lunch" is a larger constraint
than the organiser stated — the same class of harm as the original bug,
arrived at by a different route.

`resolveParsed` does not receive `ParserContext`, so the court list
arrives through its existing `hints` parameter. When a break names a
court and `hints.courts` is absent, the court **cannot be verified** and
the break defers. Fail safe, not fail open.

### 4. Symbolic through `resolveParsed`, expanded at the pack edge

```ts
interface ResolvedParse {
  …
  dailyBreaks: { from: string; to: string; court?: string }[];
}
```

`resolveParsed` keeps the break as wall-clock strings and does **not**
expand it. It cannot: when the organiser states no date range,
`resolveParsed` has no idea which days the run covers — only the pack
does. Expanding there would either drop the break or guess at days,
and guessing is what this whole programme exists to stop.

`buildSchedulePack` owns the expansion, beside where it already renders
`config.blackouts`:

```ts
blackouts: [
  ...config.blackouts,
  ...expandDailyBreaks(resolved.dailyBreaks, packWindowDays, orgTz),
]
```

`expandDailyBreaks` walks the pack's resolved window day by day and
emits one `Blackout` per day, built with `zonedTimeToUtc` from
wall-clock day boundaries in one zone — never by adding 86_400_000,
because a DST day is 23 or 25 hours long. This mirrors how `windowMs`
is already computed and rendered.

## Refusals

Deterministic, in `resolveParsed`, no model involved:

| wording | outcome |
|---|---|
| `from >= to` (e.g. 13:00 → 12:00) | defer: cannot be read as one same-day break |
| spans midnight (22:00 → 02:00) | defer: not one same-day blackout |
| `court` not in `hints.courts` | defer the whole break |
| `court` named but `hints.courts` absent | defer the whole break |
| division-scoped | defer, as `window` already does |

A break that swallows the entire play window is **not** refused — it is
a real, checkable constraint and the verifier will report the run as
infeasible. But an assumption line says so first, so the organiser reads
our interpretation rather than only the failure.

## Persisted-shape change

`StoredResolvedParse` in `schedule-ai-preview.ts` mirrors
`ResolvedParse` for previews claimed by a later run. Adding
`dailyBreaks` means previews written before deploy fail strict parse and
surface as `PREVIEW_STALE`.

That is accepted, not worked around. That schema's own comment forbids
defaults that quietly repair rows this code wrote — a `.default([])`
here would be the schema silently repairing the thing it exists to
detect. Previews are short-lived; a stale one re-previews.

## Corpus re-baseline

Announced in the fixture's own `trap` field, per the standing rule that
a re-baseline is never silent:

- **c05** "lunch break from 12 to 1" — was defer-all *because* this was
  unexpressible. Becomes a compiled `no_play_between`.
- **c01** the owner example — the lunch clause now compiles; the
  per-period caps still defer. Its label moves from "defer everything"
  to partially compiled.

Both rows change meaning: a model that still answers `not_after 12:00`
now fails on `invented` rather than passing.

## Test plan

1. **Unit, schema** — `no_play_between` accepted; `from >= to` refused;
   midnight-spanning refused.
2. **Unit, court guard** — unknown court defers the whole break; absent
   `hints.courts` defers; known court survives with its label intact.
3. **Unit, expansion** — a 3-day window yields 3 blackouts; a DST
   boundary day yields the correct instants, not a 24h-arithmetic
   answer.
4. **Regression** — division-scoped break defers; a break plus an
   ordinary window still resolves both.
5. **Bench** — re-run the 35-case corpus; c05 and c01 must move from
   invention/defer to compiled.

## Risks

- **Widened context is a new invention surface.** Mitigated by the
  guard, but the court list also grows the prompt payload on every
  parse.
- **The bench scores `raw`**, so the court guard and the refusals are
  invisible to it, exactly as `refuseContradictions` already is. Their
  evidence is unit tests, not bench delta. Do not read a flat bench
  number as "the guard did nothing".
