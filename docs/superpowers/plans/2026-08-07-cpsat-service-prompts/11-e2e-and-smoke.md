# Prompt 11: E2E + smoke coverage for the CP-SAT cutover

**Depends on 06b** — the feature is not visible end-to-end until the
status vocabulary and the `cp-sat` engine label ship.

**Why this prompt exists separately from 07.** Prompt 07 proves TS↔Python
correctness. This one proves an organiser clicking Auto-schedule in a real
browser gets a board *from CP-SAT*. They are not the same claim, and the
gap between them is exactly where this cutover fails silently.

**Acceptance criterion**: an e2e that **fails if the board came from
greedy rather than CP-SAT**. Everything else here is secondary. The whole
risk of this cutover is a silent fallback — Task 05's review already found
a bug of exactly that shape (a wall-budget disagreement put the deadline
at +2s regardless of the wire value, which would have killed every solve
and fallen through to greedy on every board, with no error surfacing
anywhere and no test catching it).

---

## Ground truth — verified 2026-08-09, do not re-derive

**`apps/web/e2e/z3-auto-schedule.spec.ts`** holds three tests, and they do
NOT all belong to this programme:

| line | test | path | in scope? |
|---|---|---|---|
| 193 | "Auto-schedule places an empty board…" | BUILD | **yes** → cp-sat |
| 246 | "Re-flow places the unscheduled cards…" | REFLOW | **NO** — stays z3 |
| 304 | "Improve times compacts the board…" | POLISH | **yes** → cp-sat |

REFLOW is a separate, future programme. The Re-flow test must keep
asserting the z3 labels. **This is the single easiest thing to get wrong
here**: a global find-and-replace of the engine labels across this file
would silently convert an out-of-scope test and hide a real REFLOW
regression behind a passing suite.

**The file's teeth, at `:38-47`:**

```js
const SOLVED = ["ok", "already_optimal"];
```

Its docstring says `z3_unavailable`, `verifier_rejected` and `solver_busy`
are deliberately NOT accepted, because all three mean the solver did not
do the thing the spec exists to prove — "a run that quietly fell back to
the greedy pass would otherwise pass every assertion here. This list is
the whole of the file's teeth; **it does not grow**."

Prompt 06b introduces `solver_unavailable`. **Do not add it to `SOLVED`.**
Adding it would let a board produced by greedy, while CP-SAT was down,
pass the entire suite — which is precisely the failure this prompt exists
to detect. If you believe it must be added, stop and ask.

**The one deliberate copy assertion, at `:227-229`:**

```js
await expect(page.getByTestId("schedule-result-provenance")).toHaveText(
  /^(Quick pass|Solver, then refined|Solver) · /,
);
```

`board.result.provenance` renders `"<engine> · <elapsed> · <churn>"`, and
the engine name is the only thing on screen saying which solver produced
the board. The existing comment is explicit that a non-empty check would
pass on all three labels and on a blank engine key.

**Label sources** — `apps/web/src/dictionaries/en/ui.json`:
`board.result.engine.greedy` = "Quick pass";
`board.result.engine.z3lns` = "Solver, then refined"; the `z3` key sits
between them.

**`build.ts:523`** declares `engine: "greedy" | "z3" | "z3+lns"`, set at
`:1880`. Prompt 06 adds `"cp-sat"` to that union; Prompt 10 removes the z3
values later.

**A prefix trap already documented in this repo.**
`apps/web/src/components/v2/board/__tests__/result-strip.test.tsx:54`
warns that `"Solver"` is a **prefix** of `"Solver, then refined"`, so a
substring check can be satisfied by the wrong label. Whatever label
`cp-sat` gets must not create a second prefix collision, and your
assertions must be anchored, not substring.

---

- [ ] **Step 1: Make the provenance assertion distinguish cp-sat, per test**

Change the BUILD (`:193`) and POLISH (`:304`) tests so their provenance
assertion accepts **only** the cp-sat label — not greedy, not z3. Leave
the REFLOW test (`:246`) asserting the z3 labels.

The assertion must fail if the board came from greedy. That is the whole
point; verify it by forcing a fallback (below), not by reasoning.

- [ ] **Step 2: Extend the result-strip unit test's label table**

`result-strip.test.tsx:95-97` is a table mapping engine value → rendered
label. Add the `cp-sat` row. Keep the anchoring that defeats the
`"Solver"`-prefix problem.

- [ ] **Step 3: Prove the e2e actually catches a silent fallback**

The acceptance criterion is a negative claim, so it needs a negative test.
Force CP-SAT to be unreachable — point `CPSAT_SERVICE_HOST` at a dead
port, or whatever mechanism Prompt 06's fallback path actually uses — and
confirm the BUILD test goes **red**, not green-with-a-greedy-board.

Report the exact failure message. If the suite passes with CP-SAT dead,
Step 1 did not work and the rest of this prompt is worthless.

Then restore and confirm green.

- [ ] **Step 4: Smoke coverage**

`scripts/smoke.ts:7433` is `z3AutoScheduleSuite()`, invoked at `:665`,
with its own Pro org set up around `:11717`. It already reads a typed
response carrying `engine: string; mode?: string`.

Assert the engine is the cp-sat value on the BUILD path. Smoke runs on
**PRs only** — merging locally and pushing to `main` skips it — so this
assertion is the only thing standing between a broken cutover and
production on a direct push.

Follow the repo rule on the demo: if the smoke suite's fixture needs to
change, update the smoke demo data with it.

- [ ] **Step 5: The file name is now wrong — flag, do not rename**

Two of the three tests in `z3-auto-schedule.spec.ts` no longer exercise
z3. Renaming touches CI config and any `--grep` filters, which is a wider
blast radius than this prompt owns. Note it in your report for Prompt 10,
which is already removing z3 and is the right place to do it.

---

**Verify**: run the three e2e tests and the smoke suite locally against a
production build (`E2E_PROD_TARGET`) — **never enable
`.github/workflows/e2e.yml`**, it is disabled deliberately.

Known environment traps, all on record in this repo:
- e2e on `127.0.0.1:PORT` 401s every API call while the browser stays
  signed in — the session cookie is `Secure`. Use `localhost`.
- All three e2e projects failing in `auth.setup` means a squatted port
  3100: the health check 200'd against a FOREIGN server. Assert
  `lsof -t -i:3100` is your own PID.
- A parallel-phase e2e failure means the serial and mobile phases NEVER
  RAN — they are `&&`-chained.

**Output cap**: final message under 15 lines — which tests changed, the
Step 3 forced-fallback result verbatim, what you left for Prompt 10.
