# CP-SAT service — binding rules

Owner-mandated, 2026-08-09: **all code in this programme follows
Domain-Driven Design.** This file is the standard. It binds Tasks 1-11
and every reviewer. A dispatch that touches this programme's code either
restates the relevant rule inline or points here.

This is not a DDD lecture. Every rule below is *mechanically checkable* —
each carries the command that proves it. A reviewer who cannot run the
check has not verified the rule.

---

## 1. The bounded context

One context: **constraint-based fixture placement**. It owns fixtures,
courts, slots, assignments, tiers, and the rules that constrain them.

It explicitly does NOT own: scheduling *validation* (that stays in the
TypeScript engine), org/tenant concepts, timezones-as-policy, or
persistence. CP-SAT is a **placer only** — it never calls
`validateAssignments` or any verification routine. If a task ever makes
the service validate its own output, the context has leaked.

## 2. Layers, and the direction of every dependency

Dependencies point **inward only**. Domain knows nothing of the layers
above it.

```
  infrastructure / application     main.py, config.py   |   build.ts (caller)
              |                                          |
              v  (may import)                            v
  anti-corruption layer            schema.py             |   cpsat-client.ts
              |                                          |
              v  (may import)                            v
  domain                           model.py, objective.py
```

### 2.1 Python — `services/cp-sat`

| Module | Layer | May import | Must NEVER import |
|---|---|---|---|
| `model.py`, `objective.py` | domain | `ortools`, stdlib | `scheduler_pb2`, `scheduler_pb2_grpc`, `grpc`, `os.environ` |
| `schema.py` | anti-corruption | `scheduler_pb2`, domain | `grpc`, `os.environ` |
| `main.py` | application/infra | `grpc`, `scheduler_pb2_grpc`, `schema`, `config` | `scheduler_pb2` |
| `config.py` | infrastructure | `os` | domain, proto |

**`ortools` in the domain is deliberate and allowed.** The domain of this
context *is* constraint-model construction; `cp_model` is its expression
medium, not an external system. The prohibition is on the wire, the
network, and the environment — not on the solver.

**`main.py` may import `scheduler_pb2_grpc` but not `scheduler_pb2`.**
The servicer base class is unavoidable to serve gRPC; message *types* are
not. If `main.py` ever constructs a response message directly, the ACL
has been bypassed.

Check:
```bash
cd services/cp-sat
grep -n "scheduler_pb2\|import grpc\|os.environ" src/cp_sat/model.py src/cp_sat/objective.py   # expect: no output
grep -n "scheduler_pb2[^_]"                        src/cp_sat/main.py                          # expect: prose only, no import
grep -rn "scheduler_pb2"                           src/cp_sat/ --include=*.py | grep -v generated/ | grep -v schema.py   # expect: main.py's _grpc lines only
```

### 2.2 TypeScript — `packages/engine`

| Module | Layer | May import | Must NEVER import |
|---|---|---|---|
| `scheduling/generated/scheduler.ts` | generated infra | — | (never hand-edited) |
| `scheduling/cpsat-client.ts` | anti-corruption | `@grpc/grpc-js`, `./generated/*` | engine domain internals |
| `scheduling/build.ts` | domain/application | `./cpsat-client.ts` | `@grpc/grpc-js`, `./generated/*` |

`cpsat-client.ts` is the **only** gRPC-aware module in the entire
TypeScript codebase, and it is an ACL in both directions: it takes
domain-shaped input and returns domain-shaped outcome. Wire artifacts —
proto field names, the integer `SolveStatus` enum, the metadata key
`x-internal-secret`, deadline arithmetic, `grpc.status.*` codes — must
not escape it.

`build.ts` stays **engine-agnostic**: it asks for a placement and gets
one. It must not be able to tell CP-SAT from greedy by the shape of what
it handles.

Check:
```bash
grep -n "@grpc/grpc-js\|generated/scheduler" packages/engine/src/scheduling/build.ts   # expect: no output
grep -rln "@grpc/grpc-js" packages/engine/src/ | grep -v "/generated/"                 # expect: cpsat-client.ts ONLY
```

The `grep -v /generated/` is load-bearing, not cosmetic: `ts-proto`
emits `@grpc/grpc-js` imports into `generated/scheduler.ts`, which the
table above explicitly permits. Without the exclusion the check flags
its own sanctioned output and reads as a violation. (Caught by the Task
5 implementer against the first draft of this file.)

### 2.3 `packages/engine/src` is a purity boundary — enforced by a test

The engine has a pre-existing gate banning ambient non-determinism in
`src/`: no `Date.now()`, no `new Date()`, no `Math.random()`. Time comes
from `core/clock.ts`; identity comes from the caller.

This is a repo rule, not a DDD rule, but it lands on the same code and
the two reinforce each other — a domain that reads the wall clock is a
domain with a hidden dependency on infrastructure. It bites here
specifically because deadline arithmetic (`Date.now() + margin`) is the
natural way to write a gRPC client and is forbidden in this directory.

Consequence for Task 06: `requestId` is **caller-supplied** by design.
`build.ts` must pass a real one; it must not be defaulted inside the
client, and it must not be generated from a random or a timestamp there.

## 3. Ubiquitous language

One concept, one name, on both sides of the wire. The proto is the
shared contract, so it is the vocabulary of record.

| Concept | Proto | Python domain | TypeScript |
|---|---|---|---|
| a match to place | `Fixture.fixture_id` | `fixture_id` | `fixtureId` |
| a place to play | `court` | `court` | `court` |
| a placement | `Assignment` | `(fixture_id, court, start_at_ms)` | `{fixtureId, court, startAtMs}` |
| an objective level | `Tier{name, value_ms}` | `objective_values: [(name, value)]` | `objectiveValues` |

Case convention changes at the language boundary (`snake_case` ->
`camelCase`); **the word never does.** A rename on one side without the
other is a defect, not a style choice. If a tier is called `idle_gap` in
Python it is `idleGap` in TypeScript — never `gap`, never `worstGap`.

## 4. The anti-corruption layer earns its name

An ACL that merely renames fields is a mapper, not an ACL. These belong
in `schema.py` / `cpsat-client.ts` and **nowhere else**:

- **Proto3 zero-value defence.** An unset proto3 scalar arrives as `0`,
  an unset message as empty, an unset repeated field as `()` — never as
  absent. This programme has been bitten by that five times
  (`match_minutes`, `max_fixtures_per_day`, `wall_seconds`, `Grid`,
  `tiers`), each time producing a confidently-wrong `OPTIMAL`. Every
  field where "unset" and "legitimately zero" are indistinguishable is
  rejected at the ACL, before a domain object exists.
- **Status vocabulary translation — and there are TWO boundaries here,
  not one.** An earlier draft of this file collapsed them and was wrong;
  the Task 5 implementer caught it. Keep them apart:

  | Boundary | Where | Vocabulary |
  |---|---|---|
  | solver -> wire | `schema.py` | `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNKNOWN`, `ERROR` — the proto's `SolveStatus` |
  | wire -> engine | Task 06b, in the TS engine | `not_searched`, `infeasible`, `solver_unavailable`, … — the engine's EXISTING scheduling-status vocabulary, shared with z3/greedy |

  `UNKNOWN -> not_searched` and `ERROR -> solver_unavailable` are the
  **second** mapping. They are Task 06b's job, in TypeScript, and they do
  NOT belong in `schema.py` or in the proto. Renaming the proto to match
  the engine would be the tail wagging the dog: the proto is the shared
  contract and its vocabulary is solver-native.

  This does not violate §3. §3 governs one *domain concept* keeping one
  name across the wire. Solver status and engine status are two different
  concepts that happen to be adjacent — translating between them is
  precisely what an ACL is for.

  Both mappings must be **total**. No unmapped status may return a
  success-shaped response.
- **Clamping.** `wall_seconds` is clamped server-side, always. A client
  cannot request an unbounded solve.

The domain layer may *also* validate its own invariants (`model.py`
raising `ValueError` on `match_minutes <= 0` is correct — a domain
object must refuse to exist in an invalid state). Guarding at both the
ACL and the domain is defence in depth, not duplication.

## 5. Invariants live with the thing they constrain

A rule about fixtures lives in the fixture model, not in the handler
that received the request. If `main.py` grows a business rule, it is in
the wrong file. The gRPC handler's only jobs: authenticate, translate in
(via ACL), call the domain, translate out (via ACL), map errors.

## 6. Tests follow the layering

- Domain tests (`test_model.py`, `test_objective.py`) construct plain
  Python and never build a proto message.
- ACL tests (`test_schema.py`) are where wire-shape edge cases live —
  zero values, empty repeateds, unmapped enums.
- Application tests (`test_server.py`) use `grpc_testing`, in-process,
  and assert on auth/wiring/status — not on solver quality.

A test that reaches across two layers to set up one assertion is a
smell: the seam it crosses is probably in the wrong place.

## 6b. Mutation testing — the method, and the two ways it lies

Every claim of the form "this test guards X" in this programme is proven
by breaking X and watching the test go red. That is the only evidence
that counts here, because the re-audit found that most of this suite's
tests could not fail at all.

Two failure modes have both bitten, and both produce a **false SURVIVED**:

**1. A shared worktree.** Other agents work here. An auditor read a guard
as GREEN twice because a sibling had `objective.py` dirty at that moment;
against a clean tree it died 3/3. So mutate in your own mirror
(`git archive HEAD` into scratchpad), not in the worktree.

**2. But a mirror of an editable-installed package is INERT.** The venv's
`.pth` resolves `cp_sat` back to the **worktree**, so a mutation applied
in the mirror changes nothing the interpreter imports. Set `PYTHONPATH`,
and then **prove the mirror is live before trusting any result**: apply a
mutation that must fail loudly — a syntax error, or an always-raising
assert — and confirm you see it. If the suite stays green, the mirror is
inert and every conclusion from that run is void.

Note the asymmetry, because it bounds how much you have to redo: an inert
mirror yields **false SURVIVED, never false RED**. A "this test kills that
mutant" result stays trustworthy. Only "that mutant survived" needs the
liveness proof.

**3. And the one that actually bit hardest: n=1 against a
nondeterministic solver.** CP-SAT does not return the same board twice, so
a mutation result is a *sample*, not an observation. Measured at N=6 per
cell:

| mutant | 8 s wall | 3 s wall |
|---|---|---|
| M2 participant-rest | RED 5/6 | RED 6/6 |
| M7 court gap | RED **1/6** | RED 6/6 |

At n=1 this programme drew the 1-in-6 M7 kill *and* the 1-in-6 M2 miss —
two unlucky samples that together told a tidy, plausible, **wrong** story
("short walls destroy coverage because T1's packing pressure is what makes
a missing constraint visible"). It was endorsed at controller level and
written into three docstrings as measured fact. The truth is the inverse:
both die more reliably at the shorter wall. Load was not the discriminator
either — M7's single kill came at load 11.07, inside the 9.57–12.27 band
of its five misses.

So: **N≥6 per cell, and report the spread rather than a verdict.**
"RED 5/6" is a result; "RED" is not.

**Better still, remove the nondeterminism instead of averaging over it.**
The fix here was two *contended* boards that decide a T0-proved **count**
in ~0.55 s, independent of wall, tiers and day cap — killing M1/M2/M3/M7
at 6/6 with unmutated 0/3. A small deterministic board beats a large
stochastic one every time.

Two further traps, both measured here: a mutant whose value **collides
with an existing fixture value** under-reports (a hardcoded `8` killed
only 2 tests because another test already used 8); and a mutant that dies
only because it is **slower** is not a real kill (T3's old mutants were
green at 22 s and red at 44 s — same mutation).

**Corollary for wall budgets in this suite: the 8 s walls carry NO
coverage claim.** They are a legitimate place to reclaim runtime, provided
the M1–M8 matrix is re-run at N≥6 afterwards.

## 7. Enforcement

Every task reviewer in this programme receives §2's table and check
commands as part of its constraints block. A layering violation is an
**Important** finding minimum; a domain module importing the wire is
**Critical**.

Known accepted deviation: none. If one is ever accepted, record it here
with its reason — not in a commit message, where the next session will
not find it.
