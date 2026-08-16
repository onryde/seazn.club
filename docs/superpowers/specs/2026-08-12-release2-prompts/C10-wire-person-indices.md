# C10 — put person identity on the placement wire

Spec of record: `../2026-08-12-z3-retirement-design.md`. Gate: **strictly
before C9 (PR #583) can merge**, and therefore before C7/C8. Owner ruled
2026-08-16: fix the wire contract first.

## Why this exists

The placement service refuses any fixture with empty `entrant_indices`
(`services/placement/src/placement/schema.py:296-303`):

> `fixtures[{i}].entrant_indices must not be empty. A fixture with no
> entrants joins no participant group, so the participant-rest NoOverlap and
> every T2 idle-gap term skip it. Measured (string contract, same
> mechanism): two fixtures sharing one player placed CONCURRENTLY, reported
> OPTIMAL.`

That refusal is CORRECT for the contract as it stands today, and its stated
reasoning is exactly right — with no participants on the wire, the solver
would silently place two fixtures sharing a player at the same time. Do not
simply delete it.

The problem is the premise. A genuinely undecided knockout slot — a final, a
third-place playoff, before its feeders have resolved — has no entrants yet,
but it very much has **people**: the players who can still reach it. Two such
slots can clash on a shared person, and today the service cannot see that,
because person identity never crosses the wire at all.

Consequence, measured: `scripts/smoke.ts:9755`/`:9768`/`:9780` (the
"v4 AI/bracket" canary, #396/#399/#401) are RED on C9's branch and cannot be
made green from the caller side. z3 handled these boards only because it ran
in-process against the full pack. **This is the last blocker on retiring z3
for AI repair.**

## The gap is transport, not modelling — do not rebuild what exists

The engine ALREADY computes and carries people. Verify each of these before
building on them:

- `packages/engine/src/scheduling/build-encode.ts:109,133` — participant rows
  carry BOTH `entrants` and `people: [...(f.people ?? [])]`.
- `build-encode.ts:233-240` — a `byParticipant` index already namespaced
  `e:` / `p:`, so the engine's own model of "entrant or person" is settled
  and you should mirror its semantics rather than invent new ones.
- `packages/engine/src/scheduling/repair-domain.ts:482-486` —
  `sharesParticipant` compares `entrants` and `people` in **separate,
  non-crossing loops**. Person ids and entrant ids are DISTINCT namespaces;
  never merge them into one index space.
- Callers already supply people:
  `apps/web/src/server/usecases/schedule-ai.ts:1027-1041`
  (`people: participants[f.id] ?? []`) and
  `competition-schedule-ai.ts:620,646-647`.

**The single point where it is dropped:**
`packages/engine/src/scheduling/placement-client.ts:270-280`, `toRequest()`,
destructures only `{ entrantIds, divisionId, roundNo }`. No person field is
sent. That function is the sole assembly point for wire `fixtures`
(`:270-341`), so it is also the only place that has to change on the TS side.

## Goal

Person identity travels to the placement service, participates in the
participant-rest NoOverlap exactly as entrants do, and a fixture with no
entrants but at least one person is accepted rather than refused.

## Shape (verify, do not assume)

- **Proto** (`proto/scheduler.proto:30-54`): `Fixture` uses field numbers
  1-3 (`entrant_indices`, `division_index`, `round`), no `reserved` inside
  the message, **next free number is 4**. Add a repeated person index field,
  mirroring `entrant_indices`. A `person_count` on the request will likely be
  needed alongside `entrant_count`; check how `entrant_count` is threaded
  before adding its twin.
- **TS** (`placement-client.ts:270-280`): send it. Index people the same way
  entrants are indexed. Keep the two namespaces separate.
- **Python model** (`model.py:792-795`): `by_entrant` is built by walking
  `entrant_indices` per fixture; `:851-852` and `:1359` turn those groups
  into `AddNoOverlap`. Add the person equivalent and feed it the same
  constraint machinery. Confirm whether idle-gap/T2 terms also need it — the
  refusal message claims those skip participant-less fixtures too, so a
  fixture that now joins a group via people must not silently miss them.
- **Schema** (`schema.py:296-303`): the refusal narrows to "a fixture with
  neither entrants NOR people", and its message must be rewritten to state
  the real remaining hazard. Keep a refusal for the genuinely
  participant-less case.

## Deploy ordering — state your conclusion explicitly

This is a proto change across a web/service boundary, so the two deploy
orders are not symmetric. An older service receiving the new field treats it
as an unknown field and silently ignores it — which means a board that
depends on person overlap would be solved WITHOUT that constraint and
reported OPTIMAL. That is precisely the failure mode the existing refusal
message was written about. Work out which deploy order is safe, say so in the
PR, and if a guard is needed to make the unsafe order impossible, add it.
C0 did the analogous work for field 10 and added an `UnknownFields()` probe
plus a structured log — read what it did before choosing
(`docs/superpowers/specs/2026-08-12-release2-prompts/C0-division-rules-retirement.md`).

## Acceptance

- A fixture with empty `entrant_indices` and non-empty person indices is
  ACCEPTED and its people participate in NoOverlap — proven by a test that
  fails against today's service.
- **Two fixtures sharing only a person are never placed concurrently.**
  This is the exact hazard the current refusal message cites as measured;
  pin it with a test on the Python side, not only through the TS stack.
- A fixture with neither entrants nor people is still refused, with a message
  that describes the real remaining reason.
- `scripts/repro-ai-bracket-frozen-feeder.ts` — run it against C9's branch
  rebased onto this work. The bracket clash must repair.
- **The canary:** with this merged and C9 rebased on top,
  `scripts/smoke.ts:9755`/`:9768`/`:9780` pass **unmodified**. If you edit
  those assertions, stop and report instead.
- BUILD/POLISH bracket boards, which C4 documented hitting this same wall,
  also work — confirm, since this is shared code and the win is not
  repair-only.
- Deploy-order conclusion stated, with a guard if the unsafe order is
  reachable.
- Golden/conformance corpora: a wire addition is exactly the shape that
  silently re-baselines a golden. Check before assuming none are affected.

## Do NOT touch

C9's repair driver (`repair-decompose-cpsat.ts` and its wiring — that is
#583's, and it rebases onto this), the `engine` enum narrowing (C7), z3
deletion (C8), C5's parked branch.

## Verify

Python tests for the service; `packages/engine` and `apps/web` suites via
JSON reporter with raw counts; full smoke with **`SCHEDULING_AI_BASE_URL`
exported** — a total near 836 instead of 891 means the AI section silently
did not run and the result is vacuous (`smoke.ts:9296`). Sweep stale
`next-server` processes and confirm port ownership by PID before any server
run. Fresh DB (`db:apply` alone is not a fresh schema — it needs
`sync:sports`).

Note there is currently **no test anywhere pinning the empty-entrant refusal
text**, so nothing will red to warn you if you change its behaviour by
accident — the closest is `services/placement/tests/test_schema.py:631-639`,
which asserts an empty `PinnedRow.entrant_indices` IS accepted (pins, not
movable fixtures). Add the missing coverage as part of this task.
