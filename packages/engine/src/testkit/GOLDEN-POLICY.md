# Golden corpus write policy

The eleven `sports/**/<key>.golden.json` files are the engine's only
back-compat tripwire. The fast-check conformance kit generates its streams at
run time, so it re-derives its inputs from whatever the schemas currently are
and structurally cannot prove that a schema change was additive. The frozen
corpora can, and only for as long as they are not rewritten casually.

## The policy

> A re-baseline is legitimate only when it is **deliberate, isolated in its own
> commit, and reviewed as a state diff.** Never a side effect of another
> change; never `UPDATE_GOLDEN=1` run to clear a red.

`UPDATE_GOLDEN=1` reached for to make a red suite green is the specific failure
this exists to stop. It does not fix anything — it deletes the evidence, and it
deletes it silently, because a regenerated corpus is green against the code that
broke it by construction.

## The three write modes

| env | what it writes | when |
| --- | --- | --- |
| `UPDATE_GOLDEN=1` | re-records **everything** from the generator | a corpus being built from nothing. Almost never. |
| `REBASELINE_GOLDEN=1` | the same recorded **events**, with states / outcome / summary / deltas recomputed | an **intended** fold change. The commit diff is then the behaviour change itself. |
| `EXTEND_GOLDEN=1` | **appends** streams covering uncovered fidelity-tier types and optional fields, then the streams the **golden floor** owes (next section but one), each written in the canonical **slim** form (see "Per-step digests") | a coverage gap. Never touches an existing stream. |

Only the appended stream is slimmed, never the corpus as a whole: the existing
streams have to survive byte for byte, and re-slimming an already-slim stream is
not an identity — `anchorSteps` derives shape growth by walking the states, a
digest contributes none, so a second pass can compute a different anchor set
from the one the full states produced. An append written whole would red the
slim gate the next time anyone ran it, with a message about a hand-edited digest
or a hand-edited anchor: the wrong cause entirely.

If a golden is red and the fold change was **not** intended, the corpus is
right and the code is wrong. Fix the code.

If the fold change **was** intended, `REBASELINE_GOLDEN=1` is the honest tool
and `UPDATE_GOLDEN=1` is not: a re-baseline keeps every recorded event byte for
byte, so the diff is the behaviour change and nothing can hide inside a fresh
generator walk. `rebaselineCorpus` also writes the **recorded** config back into
each state, so a re-baseline cannot launder a changed config value — it can
leave a red red, it cannot turn a red green.

## What the harness enforces

Prose in a comment enforced none of this, so the harness now does.

1. **Isolated in its own commit.** `UPDATE_GOLDEN=1` and `REBASELINE_GOLDEN=1`
   both refuse to run unless every dirty path in the working tree is one of the
   corpus files the run is about to rewrite. The refusal names the offending
   paths. Outside a git checkout the run **fails closed** — with no diff there
   is nothing to review, so the run cannot satisfy the clause it is gated on.
   The check is `corpusWriteVerdict`, a pure function over a
   `git status --porcelain` listing; `corpusWriteGuard` wires the real probe in.

   The practical consequence: commit or stash your work first, run the
   re-baseline into a clean tree, and commit the corpus **alone**.

2. **Reviewed as a state diff.** A re-baseline prints `corpusStateDiff` — per
   module and per stream, which step indices moved, which top-level state keys
   moved, and whether `outcome` / `summary` / `deltas` moved. Since scope item 3
   it also reports which of those steps are stored **only as a digest**, where no
   key can be named; see "Per-step digests" below for the residual and for how to
   recover the detail. It is a returned
   data structure first and a printout second, so it is asserted on in
   `golden-policy.test.ts` without running a re-baseline. The distinct set of
   moved state keys is the last line because that is the minimality claim a
   reviewer actually checks: a fold change to the shoot-out should not move
   `cards`.

   **Two things can silently deprive you of that review, and both hand you a
   reassuring number rather than an error.**

   *`unslimCorpus` must never be used to compare two versions of the engine.*
   It rebuilds the digested states by re-folding the stored ledger with whatever
   code is loaded **now**, so in

       corpusStateDiff(unslimCorpus(before), unslimCorpus(after))

   *both* sides are the current behaviour and the diff compares a thing with
   itself. It reported `changedStates: 0` for the set-piece `resolved` change,
   whose real footprint was **39 full states and 51 digests across 7 streams**.
   That is the exact compare-a-thing-with-itself failure the slimming work
   existed to eliminate, reintroduced by the recovery function added to recover
   from it — and it cannot be guarded, because a wrong `0` is indistinguishable
   from a right one. The correct comparison is against the **recorded bytes**:
   loop `verifyStream` over `readCorpus(key).streams`. `corpusStateDiff` is
   honest only when its `after` is a real `rebaselineCorpus` output and its
   `before` is the committed corpus as read from disk.

   *The printout can be swallowed by the tool wrapper.* Under `rtk` a
   `REBASELINE_GOLDEN=1` run reports `11 passed` and nothing else — the
   `corpusStateDiff` printout, which **is** the artefact this clause requires,
   never reaches the terminal. A re-baseline that looks clean may simply be
   unreviewed. Reconstruct it from the bytes instead: diff each written corpus
   against `git show HEAD:<path>` and confirm, per stream, that `events`,
   `lineups` and `configs` are byte-identical and which of `states` / `summary`
   / `outcome` / `deltas` moved. The bytes are the better source regardless —
   the harness summary says what the harness believes, the bytes say what
   shipped.

3. **The ledger is preserved.** The run asserts that every recorded `events`
   array is unchanged, and `corpusStateDiff.eventsMoved` says so independently.
   A re-baseline that moves an event is a re-record wearing a re-baseline's
   name.

## A re-baseline that changes a fold must raise that sport's FOLD_EPOCH

A corpus change that alters what an existing stream folds to (any state, the
outcome, the summary or the deltas), or that removes or re-records a stream,
must raise that sport's entry in `src/sport/fold-epoch.ts` (`FOLD_EPOCH`) **in
the same PR**. Native clients send their epoch, and the server (batch 1f)
refuses one lower than its own, so an outdated phone is stopped instead of
folding differently from the server. Appended streams (`EXTEND_GOLDEN`) need no
bump; an epoch never goes down.

`scripts/fold-epoch-guard.ts` enforces it in CI (the `gates` job). It compares
the PR **as a whole** with the branch it merges into: CI runs it with
`--against HEAD^1`, the first parent of the PR's merge commit, which is the base
branch's tip, so it is a net diff and not a commit-by-commit one. That keeps
the first clause above true: the corpus still goes in a commit of its own, the
bump may follow in the next commit, and the PR is green. Run against the corpus
commit's own parent it is red, which is the point of the second commit.

A stream's **input** is its raw config object (the one it names in the corpus's
`configs`), its events and its lineups, and changing any of the three counts as
re-recording the stream. The config is in that set on purpose: after a module's
default changes (a `cap` of 30 becoming 31), `REBASELINE_GOLDEN=1` stays red,
because it splices the recorded config back in, and the way to a green suite is
to write the old value (`cap: 30`) into every recorded config that lacked it.
Every replay then folds to the same result and not one event or output moves,
but a phone that still holds the old default plays a different rule. The guard
sees the edited config and demands the bump.

To check before pushing (from any directory; it also reads uncommitted work, so
re-baseline into a clean tree, bump, and run it):

    pnpm --filter @onryde/seazn-engine fold-epoch:check --against origin/main

It prints one line per sport (epoch before -> after; streams matched, changed,
removed, added) and `N sports checked, M streams compared`. Exit codes: `0` every
sport is in order (or the base has no `fold-epoch.ts` yet: the PR that
introduces it); `1` a sport's results moved without its epoch rising, an epoch
fell, or a corpus and an epoch entry do not pair up; `2` refused, nothing judged
(the ref is not a commit, which is what a shallow clone or a root commit gives;
git could not list or read the base; a table or corpus that does not load; a
run that compared no stream); `3` the guard itself crashed.

## What the guard cannot see

The epoch guard compares corpora, so it is only as wide as they are. It judges
the **module layer** of the **exercised paths**, and a change outside that owes
a **manual bump of every sport it reaches** (raise each sport's `FOLD_EPOCH` by
hand in the same PR; no tool will tell you):

- **The kernel overlays.** The harness records `module.outcome(finalState)`,
  `module.summary(finalState)` and `module.standingsDelta` (`golden.ts`
  `recomputeStream`). It does not record the kernel's `outcomeOf` / `summaryOf`
  (`core/events.ts`), which put a settlement, an expunge, or a withdrawal over a
  held level result on top of the module's answer. A change to how those combine
  moves no golden.
- **Stoppage arithmetic, and `forfeit-credit.ts`.** The corpora now hold a
  `core.suspend` / `core.resume` pair (the golden floor, below), but the stream
  records the module's final state, not the kernel's stoppage clock
  (`core/time.ts`): a change to how stopped time is summed moves no golden.
  Walkover credit is pinned only where a corpus has a forfeit that reaches it.
- **`core.settle`.** The one kernel type no corpus holds, by exemption: a
  settlement lives beside module state, the harness records the module's bare
  outcome, and a stream carrying one would record a value that is wrong the
  moment it is written. It lands with the kernel-overlay recording above, and the
  floor's exemption goes stale by itself when the harness starts recording the
  effective outcome (`settleProbe`).
- **Unexercised branches** of a module: a field no stream writes is invisible to
  a byte-exact comparison (see below), so a rule that fires only there moves
  nothing.

Which `core.*` events and outcome kinds each corpus holds is no longer a gap to
read off a table: it is a floor a test enforces (next section).
`docs/superpowers/specs/engine-split/reviews/1e.md` ("Corpus coverage per sport")
is the measurement that motivated it.

## The golden floor (GF-1)

`src/testkit/golden-floor.test.ts` fails unless every sport's corpus records at
least one stream for each of:

1. **Every `core.*` event the kernel accepts** — derived from
   `Object.keys(CORE_EVENT_SCHEMAS)` (fifteen: the ten kernel events and the five
   `core.lineup.*`), never a typed list. `core.void` is in every corpus because an
   undo is the commonest thing a phone writes. A void's target id is `voids` on
   the recorded event (`GoldenEvent.voids`, the envelope field; the payload is
   strictly empty).
2. **Every outcome kind the module can produce** — there is **no** per-module
   declared union (`OUTCOME_KINDS` is the global six), so the floor derives it:
   `win` always; `draw` where `supportsDraws` holds for a draw-capable stage in a
   recorded config; each forfeit reason (`walkover`, `retired`, `disqualified`,
   `withdrew`) and the `double_walkover` where `forfeitAdmission` admits them in a
   state the sport's own generator reaches (all eleven admit all of them);
   `tie` / `no_result` only from `NATURAL_OUTCOMES`, a reasoned per-sport list
   that is checked both ways (a listed outcome must be recorded, and a sweep of
   generator walks must reach no unlisted one).

Whether an event is written by a phone or only by an organiser does not reduce
the floor.

**Exemptions** are explicit rows in `FLOOR_EXEMPTIONS`, each with a reason and a
`stale()` check that turns the row into a failure the day it no longer holds.
There is one: `core.settle`, all sports (see above). Impossible-by-policy rows
are not exemptions but derived: `core.lineup.replacement` is required only where
a recorded config's policy lets the reducer accept it (football's `concussed`,
cricket's `mutable`, volleyball's libero); everywhere else the floor records the
reducer's own refusal code instead of a stream.

**Anti-vacuity.** Every sweep reports how many sports, tokens and holes it
checked; zero is a failure; the empty-corpus case is tested first (an emptied
corpus is red, naming the sport).

**How the streams get there.** `EXTEND_GOLDEN=1` runs `extendFloor`
(`golden-floor-streams.ts`) after the coverage pass. It builds short named
stories from the module's own generator with kernel events spliced in at points
the fold confirms are live — an undo and a late correction, a stoppage with a
note and an award and the finalize, an abandon, each forfeit reason, a withdrawal
carrying the lineup changes — and keeps a stream only if it closes a hole. Floor
streams have `seed >= FLOOR_SEED_STRIDE` (100000); the epoch guard keys a stream
by `config#seed`, so a floor stream is a plain **added** stream, never a changed
one, and a floor append owes no `FOLD_EPOCH` bump. The existing streams are not
touched; `golden.test.ts` asserts the prefix.

## How the comparison actually works

`stateMismatch` is the whole tripwire, and what it does and does not catch is
worth knowing before adding a gate that restates it more weakly.

- **Everything outside the module's config: exact, on the recorded bytes.** Key
  order included. So for any state path some stream writes, both directions
  already red.
- **The config: a subset.** Every key the golden recorded must still be present
  with an identical value; extra keys are fine. This tolerance is **permanent
  and cannot be narrowed**: a zod `.default()` on an additive knob shifts the
  resolved config in every frozen state while changing no fold, and without the
  tolerance the period family had to route around the harness with a
  compile-time preset instead of a config field.

Two consequences that have bitten:

- **The config's location comes from the module, never from the name `cfg`**
  (`configStateKey`). `init` is handed the parsed config and the top-level state
  entry that *is* that object is where it lives. A nested key spelled `cfg` is
  part of the fold and gets no tolerance; a module filing its config under
  another name still gets one. Keying on the spelling meant the rule was about
  a name rather than about the config.
- **The comparison never round-trips the state through `JSON.parse`.**
  `JSON.parse` reorders integer-like keys — array-index-like own keys come
  first, ascending, whatever the text said — so parsing both sides and
  re-serialising normalises them identically and a real order change compares
  **equal**. `jsonObjectMembers` splits the source text instead. No corpus has
  an integer-like state key today; that is why this had to be fixed before one
  does, since the failure mode is a gate reporting success.

**Therefore the only real gap is coverage.** A field no stream writes is
invisible to a byte-exact comparison. Every "the tripwire missed X" finding
reduces to "no corpus exercises X", never to "the comparison is too weak" —
fix it with a `COVERAGE_CONFIGS` entry plus `EXTEND_GOLDEN=1`, not with a new
comparison.

# Per-step digests (#429 scope item 3)

The corpora recorded a full `JSON.stringify(state)` after every event. That came
to **4,507,821 bytes** across the eleven single-line files — cricket alone
1,865,370 of it — and roughly 90% of that weight was the states. (The issue body
says 2.2 MB; that is stale by about 2×, grown by sanctioned `EXTEND_GOLDEN`
passes since W4. Measure before quoting it.)

A step is now stored **either** as its full recorded state **or** as a digest of
it: `#` followed by 16 hex characters of SHA-256. `#` is not valid JSON, which is
load-bearing — every reader that walks the recorded states for a shape already
parses inside a `try/catch { continue }`, so each one skips a digest-only step
without being taught about digests at all.

## What this costs, first

Scope item 1 made **"reviewed as a state diff"** the core of the re-baseline
policy, and scope item 3 deletes the states that summary is made of. A digest
says **that** a step moved and never **what** moved: only the digest was stored,
so the previous value is a hash in git too. `corpusStateDiff` cannot name a key
for such a step and does not pretend to — it reports the step as moved, lists it
under `digestOnlySteps`, and the printout says where the detail can be had.

The bound on that cost is one fact: **the corpus still stores the `config`, the
`lineups` and every `event`, so the full state at any step is recomputable
locally.**

    recomputeStream(module, corpus.configs[stream.config], stream.events, stream.lineups).states[N]

A digest mismatch prints that line, with the step index filled in and the nearest
stored full state named.

## Which states are kept, and why those

Not a stride someone liked. Three clauses, each with a job:

1. **The first and last step of every stream, always.** The first carries the
   config the corpus was frozen against — `recordedCfgOf` reads it, and the
   config-subset pin lives there. The last is the state `outcome`, `summary` and
   `deltas` are derived from.
2. **Every `ANCHOR_STRIDE`-th step**, currently every 10th. This is the
   localisation budget: a reviewer looking at a moved digest is never more than
   ten steps from a stored full state in either direction, and the harness names
   the nearest one.
3. **Every step at which the stream's state SHAPE grows** — that is, introduces
   a `path`/`kind` pair no earlier step of that stream did. This is the clause
   that makes the anchor set deliberate. Both gates that walk the recorded states
   union a path set over them: `recordedStatePaths`, which feeds the state half
   of the additive tripwire, and `stateShapeOf`, whose output is committed as
   `<key>.schema.json` under a **byte-equality CI gate**. Keeping exactly the
   steps that ADD to that set preserves both outputs *by construction*, so
   slimming cannot quietly narrow a different tripwire or drop eleven schema
   snapshots on the floor. `golden-slim.test.ts` proves it for all eleven
   modules rather than assuming it; deleting the clause reds football, icehockey
   and hockey.

`outcome`, `summary` and `deltas` are **never** digested. They are a few hundred
bytes per stream against the states' several thousand, and they are what
standings are computed from.

## What this does not cost

The digest is taken over `comparableStateText` — **the exact text the byte-exact
half of `stateMismatch` compares**, with the module's config replaced by its
placeholder. Two consequences, both deliberate:

- **It is order-sensitive.** It hashes the recorded source text member by member
  in the recorded order. The comparison it replaces was byte-exact including key
  order, and the folds are deterministic, so replay reproduces that order
  exactly; an order-insensitive digest would be strictly *weaker* than what it
  replaces for no benefit at all. In particular it still reds on a reordering of
  integer-like keys, which is the defect scope item 4b fixed.
- **It keeps the config-subset tolerance**, which is permanent. Hashing the raw
  state instead would red all eleven corpora the next time a knob gains a
  `.default()`.

The one place the config pin is genuinely weaker: a **digest-only step is
config-blind**, because the config is placeholdered out before hashing. That
costs nothing, and the reason is structural — no fold rewrites the config, so
every state in a stream carries the same one, and step 0 is always an anchor. A
changed value on a recorded config key still reds, at step 0, in both forms.

## The mutation list is the acceptance gate

`golden-mutations.ts` is a committed, documented list of every class of
back-compat break the corpus is supposed to catch: the classes W4 threw at it (a
changed fold value, a dropped / added / reordered state key, a changed outcome,
a changed delta, a truncated stream, a changed event payload) and the two
defects proven while closing #429 (the config located by the module rather than
by the spelling `cfg`; the `JSON.parse` round trip that normalised integer-like
key order).

Each entry is applied as a **perturbation of the replayed result** rather than as
a source edit, so the whole list runs in the normal suite, and it is run through
`verifyStream` — the same function the replay test calls, not a re-implementation
of it that could drift green. `golden-mutations.test.ts` runs every entry against
**every module's** committed corpus in **both** storage forms and requires a red
in both. The state-level entries are aimed at a step the full corpus stores whole
and the slim corpus stores as a digest; that is the only step where the two forms
could disagree, so aiming anywhere else would make the file vacuous.

It ran against football alone until a review pass widened it. The
shape-preservation half already covered all eleven, and one module is the wrong
number for the defect the integer-key entry stands for: cricket owns 708 of the
~2,450 digests and has the most exotic state in the corpus, so a numbered map key
would appear there first. Each module contributes its own witness — the stream
with the most digested steps that still keeps an anchor after step 0 and stores a
number outside the config at that step, so the choice is deterministic rather
than "the first one that looked long enough".

A module that cannot supply such a witness is **skipped by name, with the reason
the harness itself computes** — the test asserts the recorded reason equals the
diagnosis `witnessFor` returns, and that the skip list is exactly the set of
modules without a witness. A loop that quietly skips would be worse than one that
only ever ran on football, because it would read as eleven-module coverage.
`boardgame` is the only entry: it records one result event per stream, so its
longest stream is three steps, only 2 of its 152 states are digested at all, and
that one digested state carries no number for a changed fold value to move.

`CORPUS_TOLERANCES` is the control: an unmutated replay and an additive config
knob must stay green in both forms. Without it a gate that reds on everything
would kill every entry in the list and guard nothing.

One entry is recorded as **`killedBy: "schema-snapshot"`** rather than by the
corpus: narrowing football's `abandonPolicy` enum. Every football stream records
`"replay"`, so the frozen states pin that one member and dropping any other moves
no recorded state — all eleven corpora stay green. The schema snapshot records
the declaration instead of a replay, so the narrowing is a removed line there.
The test asserts that blindness (one recorded value against several declared
members) instead of describing it, because "this gate cannot see X" is exactly
the kind of claim that rots into folklore.

# Schema snapshots (#429 scope item 2)

The corpora close that coverage gap one stream at a time. The committed
`sports/**/<key>.schema.json` files close the other half of it in one move, by
recording the **declaration** instead of a replay.

    npm run schema:snapshot --workspace packages/engine

One file per module, next to its corpus, on the same naming convention.
`src/testkit/schema-snapshot.test.ts` fails when a committed file no longer
matches the live schemas, and `.github/workflows/ci.yml` runs the same
regenerate and requires `git status --porcelain` to come back empty — so a
narrowing cannot land unregenerated and unread.

Regenerating a snapshot is **routine and safe**, unlike re-baselining a corpus:
a snapshot holds no recorded behaviour, so it cannot launder a fold change. The
review artefact is the diff. Added lines are a widening; **removed lines are a
narrowing**, and that is the case this exists to make visible. The staleness
failure counts the removals for exactly that reason.

## What each of the three sections covers

**`configSchema` and `eventSchema` — complete, and independent of coverage.**
`z.toJSONSchema(schema, { io: "input" })`. Every knob, every enum member, every
bound and every union branch appears whether or not a stream ever exercised it,
which is precisely what the corpora cannot say. Drop a member from a config
enum and the snapshot loses a line even though all eleven corpora stay green.

Two pins worth knowing before changing them:

- `io: "input"`, not the zod default of `"output"`. The contract this guards is
  what the engine will **accept** — an event payload recorded last season must
  still parse — and that is the input schema. The output schema differs in the
  other direction (a `.default()` knob is required on the way out, optional on
  the way in), so it would report an additive default as a change to a
  `required` set.
- `unrepresentable` is left at "throw". A schema construct JSON Schema cannot
  express should fail the regenerate loudly rather than degrade to `{}` and
  quietly stop guarding that subtree.

**`state.paths` — structural, and the weakest of the three. Read this before
trusting it.** `SportModule<Cfg, Ev, State>` declares `configSchema` and
`eventSchema` only; there is no `stateSchema`, and every State is a plain TS
interface never validated at runtime. So the state section is derived by
walking values, not a declaration, and its claims are correspondingly narrow.

It **does** cover:

- every dotted path reachable from `init` under every config the corpus
  records, plus every path any recorded per-event state writes;
- the JSON **kind** at each path (`string`/`number`/`boolean`/`null`/`object`/
  `array`), unioned across every state that wrote it — so `winner` recorded as
  both `null` and `string` says so.

It does **not** cover:

- **any path no corpus state and no `init` ever writes.** This is the same
  coverage limit the corpora have, inherited wholesale. A conditional state
  field that no stream reaches is absent from the snapshot, and stays absent
  when it is removed. Only the two zod halves are coverage-independent.
- **values, bounds, enums or optionality.** A path is present or absent; there
  is no "this number is 0..99" and no "this key is optional". A field that
  becomes conditional does not move the snapshot.
- **which object is a record and which is a struct.** Person- and entrant-keyed
  maps collapse to a `[]` segment, as they do in the golden state walk and for
  the same reason: keying a record by its ids turns lineup data into schema
  paths that name no field. So `batterRuns[]` covers every player at once.
- **the two side keys.** `home`/`away` maps are symmetric by construction, so
  they collapse to `[]` too — otherwise a seed that sin-binned an away player
  and not a home one reads as a shape difference.
- **the module's own config**, which is dropped at the root of the state walk
  (located by identity via `configStateKey`, never by the spelling `cfg`). The
  `configSchema` section already owns every knob in it.

The state section is therefore best read as a *shape inventory*, not a schema.
Its one real guarantee is that a **rename or removal** of a covered path shows
up as a removed line.

## Determinism, because the CI gate is byte equality

Two rules, applied everywhere:

1. object keys sorted by UTF-16 code unit — never `localeCompare`, which is
   locale-dependent and would make the gate machine-dependent;
2. the two JSON Schema keywords whose arrays are **sets**, `required` and
   `enum`, sorted too, so reordering a zod object's properties is not a diff.
   Every other array keeps its order: `anyOf` and `prefixItems` are positional
   and reordering them is a real change.

Pretty-printed at 2 spaces and newline-terminated, unlike the corpora — these
files are meant to be read in review, and they are ~123 KB across all eleven.
`schema-snapshot.test.ts` asserts a rebuild of every real module is
byte-identical to the first build, because a gate that can differ from itself
reds at random.
