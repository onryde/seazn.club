# T1: a day-aware objective for multi-day boards (#512)

**Status:** design, approved in outline 2026-08-11 (owner chose the two-rung
form over span-only and over deferring). Not implemented.

**Depends on:** #511 (pins join the makespan span) — merged. Read its
rationale before this: the defect it fixed reappears in a new coat here, and
§6 is entirely about not reintroducing it.

---

## 1. The problem

T1 minimises `mk_hi - mk_lo`: one interval from the first placed match's start
to the last one's end.

On a single-day board that is exactly right — "finish early, do not strand
anyone". On a **multi-day** board it is mostly measuring darkness. Play hours
of 10:30–16:00 are 5.5 of every 24, so **~77% of the interval T1 minimises is
overnight** — time nobody can schedule into and nobody cares about.

The resulting behaviour is not an encoding bug. It is `mk_hi - mk_lo` being
minimised correctly: a week-long interval can only be shortened by shaving the
front of the first day and the back of the last, so the solver spends its whole
effort on the two ends.

Observed on staging, division `test001`, 37 fixtures over Aug 10–16,
`maxFixturesPerDay = 7`:

| Mon | Tue | Wed | Thu | Fri | Sat | Sun |
|---|---|---|---|---|---|---|
| 6 | 7 | 7 | 7 | 7 | **3** | **0** |

### 1.1 Read off staging 2026-08-11, and it confirms the thesis exactly

Division `7f41f7c4-e1d6-4432-b65c-7343f504e866`, org zone `Europe/London`,
play window 10:30–16:00:

```
Mon 10 Aug | 6 | 14:30-15:30 | locked=0    <- first day starts LATE
Tue 11 Aug | 7 | 10:30-14:00 | locked=0
Wed 12 Aug | 7 | 10:30-12:30 | locked=0
Thu 13 Aug | 7 | 10:30-13:00 | locked=0
Fri 14 Aug | 7 | 10:30-12:30 | locked=0
Sat 15 Aug | 3 | 10:30-10:30 | locked=0    <- last day ends EARLY
```

Front of the first day shaved, back of the last day shaved, middle days packed
from the window's open. That is the predicted signature of `mk_hi - mk_lo`,
observed rather than argued.

**`locked = 0` on all 37 rows — this board has NO pins.** That matters for
attribution: the empty Monday morning is this objective, not #511. An earlier
diagnosis in the programme attributed it to six pins on Monday sitting outside
the span; whatever was true then, the board as it stands has none, and #511 has
nothing to act on here. Do not carry that explanation forward.

### 1.2 What this objective does NOT fix, stated before anyone expects it to

**Summed per-day span is indifferent to when a day STARTS.** Monday's six
matches span 14:30–15:30; moved to 10:30–11:30 they span exactly the same
hour, so T1b scores both identically. T1a is unaffected either way — the day is
used in both.

So the two rungs stop the empty morning being *rewarded*; they do not make an
early start *preferred*. If "the day should begin when the window opens" is
the organiser's expectation — and the reported symptom suggests it is — that
needs a THIRD term (minimise summed start offsets, or per-day earliest finish),
and it should be argued for separately rather than assumed to fall out of this
change.

This is the single most likely way for this work to ship, pass its tests, and
still not satisfy the person who filed the issue.

### 1.3 Re-measured on a CLEARED board, 2026-08-11 20:01Z

The §1.1 read was of an already-applied board. This one satisfies the guard
(`scheduled = 0` before the run) and is the first clean measurement of the
current stack — `placement-stg` on `e794309c`, i.e. C4 + C6 + #511 all live.
Attribution confirmed: `solve request=build-37f3c-546332` in `placement-stg`,
and the prod `placement` app's most recent solve is 09:15Z, eleven hours
earlier.

```
Tue 11 Aug | 7 | 14:30-15:30     <- first day STILL starts late
Wed 12 Aug | 7 | 10:30-15:30
Thu 13 Aug | 7 | 10:30-13:30
Fri 14 Aug | 7 | 10:30-12:30
Sat 15 Aug | 7 | 10:30-13:30
Sun 16 Aug | 2 | 10:30-10:30     <- last day ends early
```

Six days, every day within the cap of 7, front and back still shaved. The
empty first morning **reproduced on a board with no pins at all**, which
settles the attribution question in §1.1: this is the objective, not #511.

**The solver line is the important part:**

    status=FEASIBLE placed=37/37 tiers=1/2 granted=10.0s solver_elapsed_ms=10003

**T1 consumed the entire wall and did not prove.** The board above is an
UNPROVED T1 incumbent, not a proved optimum. `_RESUME.md` already recorded
this ("T1 does not complete on a real board and it is not going to"); this
run is the same result under the current stack.

That inverts part of §7's cost argument, and it is the strongest single
reason to do this work:

* **Today, T1 buys nothing provable.** Ten seconds of wall, no proof.
* **`days` is a tiny objective** — one Bool per calendar day, six of them
  here, minimised. It should prove in well under a second, so the chain would
  return a PROVED day count where it currently returns an unproved span.
* `day_span` then inherits whatever wall is left and will likely not prove
  either — but that is no worse than the status quo, and it is strictly
  better to fail to prove the *second* rung than the *only* one.

So "five rungs divide the wall further" (§7) is real but misleading. The
correct framing is that the first rung becomes cheap enough to actually
finish.

**CORRECTION — an earlier revision of this section claimed the window was
Aug 11–16 and that T1a therefore had zero degrees of freedom. That was wrong.**
The saved settings are start **10/08/2026 10:30**, end **16/08/2026**, play
hours 10:30–16:00, match 30, gap 0, three boards. So the window is **seven**
days and six are needed — there is exactly one degree of freedom, and the
board spends it by running **Tue–Sun and leaving Monday entirely empty**.

Under `mk_hi - mk_lo` that is rational: Tue 14:30 → Sun ~11:00 is a shorter
first-to-last interval than Mon 10:30 → Sat ~11:00. The term drops the
earliest available day off the front and pays for it with Sunday.

**One competing explanation is NOT yet ruled out, and it must be before this
is cited as proof.** The run happened on Tue 11 Aug ~21:00 London. Monday is a
past DAY and Tuesday is today, so if the grid excludes past days while keeping
today, Monday was never offered and the solver chose nothing. Resolve it by
setting the window to a wholly FUTURE range and re-running; until then, do not
claim the objective dropped Monday.

What survives either explanation: **within the first day it uses, matches are
crammed into 14:30–15:30 against a window that opens at 10:30.** That is the
front-shave, and it is not explicable by grid availability.

**And it is what neither approved rung fixes** (§1.2). Summed per-day span is
invariant to WHICH days are used — Mon–Sat and Tue–Sun score identically — and
T1a returns 6 either way. So on this board the two-rung objective removes the
perverse incentive without supplying a preference for the earliest slot: the
choice becomes arbitrary rather than actively wrong. That is an improvement,
and it is not what the issue reporter is asking for.

## 2. What the motivating board actually proves — read this before costing the work

**The day-count term wins nothing on the board that motivated the issue.**
37 fixtures at a cap of 7 needs `ceil(37/7) = 6` days. The board above uses
exactly 6. It is already at the floor, so "minimise distinct days used" has
nothing to take.

That reframes the table. The empty Sunday is the **optimum**, not a defect.
Saturday's 3 is the **cap remainder**, not the objective misbehaving. The only
part of that shape the objective is responsible for is how each day is packed
internally — which is T1b's job, not T1a's.

The earlier measurement of "6 days → 5" came from a **pre-C4 run in which pins
consumed no day-cap allowance**; the same arm put **12 matches on a cap-7 day**.
It was 5 days because it was cheating. Do not quote it as evidence for this
work.

So T1a is being built for boards **not** at the cap floor. That is a real class
— any board whose cap is loose relative to its fixture count — but it is not
this one, and the design should not be justified with this one.

## 3. The objective

Keep T1's slot in the lexicographic chain; replace its single term with two
rungs, in this order:

1. **`days`** — minimise the count of distinct calendar days used.
2. **`day_span`** — minimise `sum over d of (day_hi[d] - day_lo[d])` across the
   days in use.

Both are computed from `Slot.day_index`, which the wire already carries per
slot for the day-cap work. **No proto change.** The caller resolves each slot
to the org's local calendar day and sends an integer; the service still never
learns what a timezone is.

## 4. Encoding

Every input already exists in `build_model` section 9 — `day_bounds`,
`day_ids`, `on_day[i][d]`, and `_day_of_pin`. Nothing new needs deriving, which
is most of why this is worth doing now.

### 4.1 Days used

```python
day_used = {d: model.NewBoolVar(f"day_used_{d}") for d in day_ids}
for i in range(n):
    for d in day_ids:
        model.AddImplication(on_day[i][d], day_used[d])
# pins force their day directly — see §6
days_used = sum(day_used[d] for d in day_ids)
```

One-directional implication is sufficient **because the tier minimises
`days_used`**: nothing rewards setting a `day_used[d]` the board does not need.
Stating that here because the reverse implication looks like a missing
constraint to a reader who does not have the objective in view.

### 4.2 Per-day span

```python
for d in day_ids:
    day_lo[d] = model.NewIntVar(0, max_end, f"day_lo_{d}")
    day_hi[d] = model.NewIntVar(0, max_end, f"day_hi_{d}")
    for i in range(n):
        model.Add(day_lo[d] <= start[i]).OnlyEnforceIf(on_day[i][d])
        model.Add(day_hi[d] >= start[i] + dur_ms).OnlyEnforceIf(on_day[i][d])
    span[d] = model.NewIntVar(0, max_end, f"day_span_{d}")
    model.Add(day_hi[d] >= day_lo[d]).OnlyEnforceIf(day_used[d])
    model.Add(span[d] == day_hi[d] - day_lo[d]).OnlyEnforceIf(day_used[d])
    model.Add(span[d] == 0).OnlyEnforceIf(day_used[d].Not())
day_span_total = sum(span[d] for d in day_ids)
```

**The empty-day clamp is not optional, and this module has already paid for
learning that once.** `mk_lo`/`mk_hi` carry a `mk_hi >= mk_lo` clamp because
without it a board where nothing is placed left both floating over
`[0, max_end]`, and a MINIMISING tier drove `mk_hi` to 0 and `mk_lo` to
`max_end` — publishing `('makespan', -1767258600000)`, a negative epoch-shaped
number, as a proved optimum with `error` unset. Per-day vars are the same trap
multiplied by the number of days: every unused day is an unconstrained
min/max pair. The `day_used[d].Not()` branch is what forecloses it.

## 5. The tier chain

`TIER_ORDER` becomes five rungs:

```
placed -> days -> day_span -> idle_gap -> imbalance
```

The freeze machinery is unchanged — each rung is a single scalar and
`run_tier_chain` already does `model.Add(term <= achieved)` for a minimising
tier. This is the whole reason for two rungs rather than one two-part term:
a lexicographic pair inside one rung would need a new freeze concept, and the
chain already implements exactly this.

### 5.1 `TIER_COUNT` 4 → 5 is caller-visible

It is mirrored in `packages/engine/src/scheduling/build.ts:193` and again in
`apps/web/src/server/usecases/schedule.ts:815`, and `tiersCompleted ===
TIER_COUNT` is the **optimality predicate** that gates `already_optimal` and
the LNS fallback. All three move together or the predicate silently never
fires. `schedule-solver-telemetry.test.ts` asserts `TIERS_TOTAL` against the
engine rather than against the literal 4, so it follows automatically — that
was deliberate foresight and it pays off here.

### 5.2 Rename, do not reuse, the `makespan` tier name

`makespan` currently means whole-board span. Reusing that name for
`day_span` would ship a number whose **meaning changed while its name did
not** — the failure mode this programme keeps hitting. Emit `days` and
`day_span` as new names and retire `makespan`.

A TS consumer keying on `"makespan"` then gets an unknown name and fails
loudly, which is the point. A same-named number that quietly means something
else is the outcome to avoid.

## 6. Pins, and the trap this design must not walk into

**#511 exists because pins were invisible to T1.** A naive port of that fix
makes them invisible again, in two distinct ways. Both must be closed in the
same change that lands the new term, not afterwards.

**6a. A pin must force its day.** Without it, a day holding *only* pinned
matches reads as unused, `day_used[d]` stays 0, its span is clamped to 0, and
T1a is free to "save" a day that is in fact occupied. The organiser sees
matches on a day the objective believes is empty:

```python
for _court, existing_start in existing:
    d = _day_of_pin(existing_start, day_bounds)
    if d is not None:
        model.Add(day_used[d] == 1)
        model.Add(day_lo[d] <= existing_start)
        model.Add(day_hi[d] >= existing_start + dur_ms)
```

**6b. An off-lattice pin belongs to no day at all.** `_day_of_pin` returns
`None` by deliberate design — a pin between one day's last admissible tick and
the next day's first is a legitimate board, and C4 already treats it as
counting against no cap. Under a **per-day** objective that has a consequence
the whole-board term did not have: such a pin enters neither `days_used` nor
any `span[d]`, so **T1 stops seeing it entirely** — precisely #511's defect,
restored for the off-lattice case.

This is a genuine open decision, not an oversight to be resolved silently. Three
options, in preference order:

1. **Accept and document it.** Off-lattice pins are rare and already excluded
   from day caps; consistency with C4 has value of its own.
2. **Attribute to the nearest day** for span purposes only, leaving cap
   attribution untouched. Closes the blind spot; introduces a second, different
   notion of "which day a pin is on", which is exactly the kind of fork this
   subsystem keeps being bitten by.
3. **Keep a board-level span floor** alongside the per-day sum, so an
   off-lattice pin still moves *something*. Cheapest, but reintroduces the
   darkness-measuring term the whole change exists to remove.

**Recommendation: (1), with a regression test that pins the behaviour** so a
future reader finds a decision rather than an accident.

## 7. Cost, stated honestly

**Wall budget is the real risk.** The chain gets one wall for all rungs, and
five rungs divide it further. This is not hypothetical: service logs from
2026-08-11 show real boards finishing `tiers=1/2` at
`solver_elapsed_ms=10013` — already out of wall at four rungs. `days` is a
small-integer objective and should prove fast, but that is a prediction and
must be **measured before this lands**, not assumed. If it does not hold, the
production wall is the lever, and raising it is a separate decision.

**Re-baselines, none of them silent** (`REBASELINE_GOLDEN=1`, every byte kept,
diff reviewed — `packages/engine/src/testkit/GOLDEN-POLICY.md`):

* every recorded golden and bench number measured against span-makespan;
* `T1_PROVED_MAKESPAN_MS` and `T1_PROVED_MAKESPAN_PIN_FREE_MS` in
  `tests/test_objective.py`, which #511 has just re-baselined once already;
* `bench/placement_bench.py` carries a **divergent copy of the model** and will
  drift further. A bench number is evidence about the bench's model, not this
  one.

**Variables:** 2 IntVars + 1 Bool per *day*, plus one span var, against 2
IntVars per *board*. A 7-day board is ~28 extra vars; a 30-day horizon ~120.
Small, but the reified `OnlyEnforceIf` bounds are `n x |days|` constraints —
on the production board 37 x 7 = 259 per bound family.

## 8. Testing

1. **A board not at the cap floor packs into fewer days** — the T1a case. Must
   be built so both arms are strictly ordered, not a tie: a nondeterministic
   solver wins a tie roughly half the time, and an n=1 red on this model is a
   coin flip. Prove red 6/6 with the term reverted.
2. **A day's internal spread tightens** without changing the day count — the
   T1b case, isolating it from T1a.
3. **A day holding only pins is not counted as free** (§6a).
4. **An off-lattice pin's treatment is pinned** (§6b), whichever option is
   chosen.
5. **The empty/no-placement board does not publish a negative or epoch-shaped
   span** (§4.2's clamp).
6. **`tiersCompleted == TIER_COUNT` still gates `already_optimal`** end to end
   after the arity change.

## 9. Explicitly out of scope

* Raising the production wall — measure first (§7).
* De-duplicating `bench/`'s copy of the model.
* Any proto change. `day_index` is already on the wire.
