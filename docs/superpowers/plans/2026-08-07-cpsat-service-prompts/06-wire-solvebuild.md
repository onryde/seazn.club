# Prompt 06: Wire `solveBuild` in `build.ts` to call CP-SAT instead of z3

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "Service boundary — only the solve step moves" — verification
NEVER moves. `validateAssignments` runs once, generically, over
whichever engine's board it's handed (`build.ts:705`) — this is the
direct fix for the placer/verifier-fork bug class on record in this
repo's engine history. This prompt adds a third placer (CP-SAT) beside
greedy and z3; it must not touch how the board gets verified.

**Acceptance criteria**: `buildSchedule`'s exported signature is
unchanged (`BuildInput -> Promise<BuildResult>`) — no caller in
`schedule.ts` needs to change. A successful CP-SAT solve produces
`engine: "cp-sat"` and a verified (zero-conflict) board. A CP-SAT
failure/timeout falls back to the existing greedy path — reuse it,
don't build a second fallback mechanism.

**Do not touch**: `validateAssignments` itself, or anything in
`calendar.ts`. Do not remove `build-encode.ts`/z3 code yet — that's
Prompt 10, gated on this whole programme running green in production
first.

**Files:**
- Modify: `packages/engine/src/scheduling/build.ts` (the `solveBuild` function, line ~1069 — **read it in full first**, this prompt changes its internals, not its exported shape)
- Test: `packages/engine/src/scheduling/build.test.ts` (existing file — add cases, do not remove existing greedy-path coverage)

**Interfaces:**
- Consumes: `cpsat-client.ts`'s `solveBuild` (Prompt 05).
- Produces: `buildSchedule(input: BuildInput): Promise<BuildResult>` — signature unchanged.

- [ ] **Step 1: Read the current implementation**

Read `packages/engine/src/scheduling/build.ts` lines 1013-1600 in full
(`buildSchedule` and `solveBuild`) before changing anything. Identify
exactly where z3 gets loaded (`loadZ3`/`withZ3Lock`), where the tier
walk happens, and where `BuildResult` gets assembled — this prompt
replaces the z3-specific middle section only; the R18 gate check,
greedy seed, and final `validateAssignments` call before returning must
be preserved unchanged.

- [ ] **Step 2: Write the failing test**

```typescript
// packages/engine/src/scheduling/build.test.ts (additions)
import { vi } from "vitest";

describe("buildSchedule — CP-SAT path", () => {
  it("uses the CP-SAT client and returns a verified board", async () => {
    vi.spyOn(await import("./cpsat-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [{ fixtureId: "f1", court: "Court 1", startAtMs: 0 }],
      status: "OPTIMAL", tiersCompleted: 4,
      objectiveValues: [], elapsedMs: 1200, wallExhausted: false,
    });
    const result = await buildSchedule(minimalBuildInput());
    expect(result.engine).toBe("cp-sat");
    expect(result.assignments).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0); // validateAssignments still ran
  });

  it("falls back to greedy on CP-SAT timeout, exactly like a z3 gate-reject", async () => {
    vi.spyOn(await import("./cpsat-client.ts"), "solveBuild").mockRejectedValue(new Error("cp-sat solveBuild exceeded deadline"));
    const result = await buildSchedule(minimalBuildInput());
    expect(result.engine).toBe("greedy");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/engine && npx vitest run src/scheduling/build.test.ts -t "CP-SAT path"`
Expected: FAIL — `result.engine` is still `"z3"`/`"greedy"` via the old code path, `"cp-sat"` never appears.

- [ ] **Step 4: Replace the z3 middle section of `solveBuild` with a CP-SAT call**

Within `solveBuild`, replace the `loadZ3`/`encodeBuild`/tier-walk/LNS
block with: build a `SolveBuildInput` from the function's existing
`grid`/`fixtures`/`config`/`existing`/`dependencies` locals (already
computed earlier in the function, unchanged), call
`cpsatClient.solveBuild(...)` with `wallSeconds` from the existing
`wallMs` budget math, and on success map its
`assignments`/`tiersCompleted`/`elapsedMs`/`wallExhausted` into the same
local variables the rest of the function already expects before falling
through to the existing `validateAssignments` call. On rejection (any
error, including deadline-exceeded), fall through to the existing
greedy-seed path exactly as today's z3-unavailable/gate-reject branches
already do — reuse it, don't add a new fallback mechanism. Set
`engine: "cp-sat"` (new literal, add it to `BuildResult["engine"]`'s
type union alongside the existing `"greedy"`/`"z3"`/`"z3+lns"` — do not
remove the old values yet, Prompt 10 does that).

---

Everything below was added after Prompts 05, 05b and 05c shipped. Step 4
above is the task; these are the constraints it now has to satisfy.

> **Signature correction (2026-08-09, after Task 5's fix round).**
> `wallSeconds` goes on the **input**, NOT on `opts`. Task 5 originally
> exposed it in both places; the two could disagree, and a disagreement
> silently killed every solve at 2s and fell back to greedy with no error
> anywhere. The fix removed it from `opts` entirely so the disagreement is
> no longer expressible. The live signature is:
>
> ```ts
> solveBuild(
>   input: SolveBuildInput,          // wallSeconds lives HERE
>   opts: { host?, secret, requestId?, clock? },
> )
> ```
>
> Two consequences for this task:
> - **`requestId` is caller-supplied and you are the caller.** Pass a real
>   one. It is not defaulted inside the client, and it must not be
>   generated from a timestamp or a random there — `packages/engine/src`
>   is a purity boundary enforced by a test (no `Date.now()`, no
>   `new Date()`, no `Math.random()`; time comes from `core/clock.ts`).
> - **Do not trust tsc to catch a stale `wallSeconds` in `opts`.** The
>   excess-property error only fires on an object *literal*. Build `opts`
>   as a variable and the stale field is silently ignored.
> - **Your import style decides whether Prompt 06b's tests can work at
>   all.** `build.test.ts` mocks with `vi.doMock`, and there is a recorded
>   trap in this repo: **`vi.doMock` is INERT if the file under test also
>   imports the module STATICALLY** — it has previously passed 5/5 with
>   the guard deleted. `z3-load.ts` is mockable today only because
>   `build.ts` loads it dynamically. So a static
>   `import { solveBuild } from "./cpsat-client.ts"` here would silently
>   disarm 06b's status-mapping tests one task later.
>   Either mirror how `loadZ3` is imported, or make sure the injection
>   seam Prompt 05 shipped (the call object is an internal third argument;
>   `SolveBuildOptions` is wire-free) is reachable from `build.ts`'s
>   tests. Say in your report which you chose — 06b depends on it.

### Two obligations Prompt 05c created for you (2026-08-09)

**1. You owe a correct `dayIndex`, and it needs its own test.**
Day caps no longer bucket by a UTC quotient. `Slot` now carries a
caller-supplied `day_index`, and the solver groups by that integer and
never reasons about time zones at all — a deliberate ruling, because
`_RULES.md` §1 puts timezone-as-policy outside this bounded context.

Which makes resolving each slot to the **org's local calendar day**
entirely your job. This is issue #448 one layer up: the in-scope `tz` is
wrong and typechecks, and `settings.orgTz` is the governing clock. Get it
wrong and every day cap binds against the wrong day, silently, exactly as
before — only now nothing downstream can catch it, because the solver has
been made deliberately blind to time zones.

Note also that `Assignment` does **not** carry `day_index`. That was
considered and rejected: caps are per-division and `Assignment` has no
`division_id`, so the field would have been decorative. The consequence
is real and documented in `model.py` — `existing` rows do not participate
in day caps.

**2. You must FILTER your rule maps — this is a behaviour change.**
Rules naming a division that no fixture declares are now **rejected**,
not silently ignored. If you pass an org-wide rest or day-cap map
straight through, a division that happens to have no fixtures in this
board will now produce an `InvalidRequestError` where it previously
produced a silent no-op. Filter to the divisions actually present in
`fixtures` before sending.

**3. A pinned row may not share an id with a fixture you are asking to
place** (added after 05c's review round). `existing[].fixture_id` must be
non-empty, unique, and **disjoint** from every `fixtures[].fixture_id`.

This is the one most likely to bite you, because the engine's natural
shape is "here is the competition, some of it is already scheduled" — one
list. Sending a match in both lists does NOT pin it: the `existing` row
lays a fixed blocking interval while the movable fixture stays free, and
it comes back placed a SECOND time somewhere else. Measured, 5/5: `f1`
pinned at T returns `[('f1','C0',T+40min)]`, OPTIMAL, `error` unset. The
ACL now rejects it rather than guessing which reading you meant, so
whatever builds the request has to split the two lists.

Same round, same rule, and cheap to trip from generated data: `courts`
entries must be non-empty and unique. An empty court name is not an
omitted court — the model gives it a real column and places matches on
it (measured: two fixtures over one grid point place 2 with an empty
string in `courts`, one of them on court `''`, and 1 without).

**4. Court names must be unique, and `config.courts` is not guaranteed to
make them so.** `courts` carries court *names*. Two venues that each call
a court "Court 1" produce a duplicate, and the ACL now **hard-refuses**
it rather than silently letting the model collapse or split them.

That rejection is deliberate — whether duplicates are harmless is a
property of today's model, not of the contract — but the cost lands on
you: you must disambiguate names before sending, not after. A caller that
passes `config.courts` straight through will start failing for any org
whose court names repeat across venues.

**5. Every court must offer the SAME start times — and this one changes
what boards you can send at all.**

The first version of this obligation said "every declared court must be
referenced by at least one slot". That was too weak. A slotless court is
only the extreme point of a continuous family: measured 6/6, with `C0`
offering `{T, T+40}` and `C1` offering only `{T+40}`, a fixture is still
placed on **`C1` at `T`** — a time that court does not have. Filtering out
slotless courts would have closed the visible case and left the family
open.

So the ACL now requires every court to offer identical start times, and
**per-court grids are refused, not mis-scheduled**. `Blackout.court?`
(`calendar.ts:21`) via `build.ts:1752` is exactly how a real board gets a
per-court grid, so this is reachable from ordinary data, not a synthetic
edge case.

**What you must do with such a board is a decision this prompt owns.**
The honest options are to filter the blackout so every court shares one
grid, or to route the board to greedy. Do not send it and hope. Whichever
you choose, say so in your report and cover it with a test — an org with
a per-court blackout must not silently get a worse board with no signal.

Context for that choice: before this change those boards were **already
wrong**, just quietly — CP-SAT placed matches at times the court did not
offer, and the TS verifier rejected the board afterwards. Refusal is
strictly better than that. It is still a capability gap against z3, and
it is tracked as a **Prompt 10 blocker**: z3 cannot be removed while
CP-SAT refuses boards z3 handles.

**6. `entrant_ids` must be unique within a fixture.** `["e1","e1"]`
returns **OPTIMAL with `placed=0`** and no error — the fixture joins its
own participant group twice and `AddNoOverlap` then makes it unplaceable.
Now rejected at the ACL.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/engine && npx vitest run src/scheduling/build.test.ts`
Expected: PASS — new tests green, all pre-existing tests in this file
still green (confirms the exported signature and greedy fallback truly
didn't change shape).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/scheduling/build.ts packages/engine/src/scheduling/build.test.ts
git commit -m "feat(engine): wire BUILD/POLISH's solveBuild to the cp-sat service"
```

**Verify**: `cd packages/engine && npx vitest run --reporter=json --outputFile=/tmp/gate.json src/scheduling/build.test.ts` then read `numFailedTests`/`numPassedTests` from the JSON directly — do not trust a wrapper summary (this repo's own `rtk` vitest summary can report `PASS(0) FAIL(0)` on a suite that failed to collect).

**Output cap**: final message under 15 lines — raw pass/fail counts from the JSON file, confirm no pre-existing test broke, confirm `result.conflicts` is empty on the happy path (proof verification still ran).
