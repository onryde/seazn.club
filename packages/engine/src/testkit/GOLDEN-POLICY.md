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

## The write modes

| env | what it writes | when |
| --- | --- | --- |
| `UPDATE_GOLDEN=1` | re-records **everything** from the generator | a corpus being built from nothing. Almost never. |
| `REBASELINE_GOLDEN=1` | the same recorded **events**, with states / outcome / summary / deltas recomputed | an **intended** fold change. The commit diff is then the behaviour change itself. |
| `EXTEND_GOLDEN=1` | **appends** streams covering uncovered fidelity-tier types and optional fields, then the streams the **golden floor** owes (next section but one), each written in the canonical **slim** form (see "Per-step digests") | a coverage gap. Never touches an existing stream. |
| `REFORMAT_GOLDEN=1` | takes a corpus to the current format, one step at a time: adds the **format-2** fields (`summaries`, `overlay`) and `format: 2`, then the **format-3** field (`playerStats`) and `format: 3` (see "Corpus format 2" and "Corpus format 3"); every field, event and config the corpus already holds stays byte for byte | a corpus that does not yet record the kernel overlay (GF-2). **Never a re-baseline:** it replays every stream against the bytes it already holds and refuses to run if one field would change. |

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

1. **Isolated in its own commit.** `UPDATE_GOLDEN=1`, `REBASELINE_GOLDEN=1` and
   `REFORMAT_GOLDEN=1` (`GUARDED_WRITE_MODES`) all refuse to run unless every
   dirty path in the working tree is one of the corpus files the run is about to
   rewrite. (`EXTEND_GOLDEN=1` is not on the list: it only appends, and the
   prefix it must leave alone is asserted byte for byte.) The refusal names the offending
   paths. Outside a git checkout the run **fails closed** — with no diff there
   is nothing to review, so the run cannot satisfy the clause it is gated on.
   The check is `corpusWriteVerdict`, a pure function over a
   `git status --porcelain` listing; `writeRefusal(env, porcelain, writable)` is the
   pure gate over it (which modes are on comes from `GUARDED_WRITE_MODES` alone) and
   `corpusWriteRefusal` wires the real environment and the real probe in. A reformat
   is **all sports or none**: `reformatAll` computes every sport first and throws
   one error naming every refusing sport, so a refusal in the fifth sport leaves no
   half-reformatted tree.

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

## Corpus format 2 (GF-2)

A phone computes more than the module: the kernel lays a settlement, an expunge and
a withdrawal over a held level result on the module's answer (`outcomeOf` /
`summaryOf`, `core/events.ts`) and keeps a stoppage, the squads and a pending
decider beside module state. A **format 2** corpus records those. The format is
the corpus's `format` key (`2`, written just before `streams`, which stays the last
key); **absent means format 1**, every corpus written before GF-2. `recomputeStream`
takes the format as its fifth argument and it is **required: there is no default**
(a default 1 was a silent choice, and a caller that forgot it recorded the wrong
format without a word). A caller that pairs a recomputation with a corpus passes
`corpusFormat(corpus)`; one that asks what the *module* alone says passes `1` and
says so (the golden floor records with `statsRecorder`, format 3; `kernelRecorder`, format 2,
and `moduleRecorder`, format 1, survive only as the controls that show what each retired
exemption and claim used to read). `verifyStream` throws,
rather than returning a message, when a format-2 stream is replayed in format 1.

| field | format 1 | format 2 |
|---|---|---|
| `states`, `events`, `lineups`, `configs` | as ever | unchanged |
| `outcome`, `summary`, `deltas` | the **module's** (`module.outcome(final)`, `module.summary(final)`, `standingsDelta` of that outcome) | the **effective** values (`outcomeOf`, `summaryOf`, `standingsDelta` of `outcomeOf`, as the server stores and feeds them; owner ruling Q3, 2026-10-15). Byte-identical to format 1 on every stream that holds no settle, expunge or withdrawal over a level result |
| `summaries` | absent | per step, `#` + 16 hex of SHA-256 of `JSON.stringify(summaryOf(fold of events[0..i]))`: the headline the pad shows after each event, not only the last (never slimmed: all digests) |
| `overlay` | absent | one JSON string: per column (`outcome`, `stoppage`, `settlement`, `expunged`, `levelWithdrawal`, `decider`, `squads`), the `[step, value]` change points of the kernel's per-step facts. A value is recorded only where it differs from the step before (step -1 is the kernel default), a column that never moves is omitted, and a value returning to the default is a change point. Squads are digests. `expandOverlay` carries the points forward to the dense per-step form |

Both new fields are REQUIRED under format 2 and forbidden under format 1, so absence
can only mean format 1. The recorder reads the kernel fold's own keys, and a test
fails by name if the kernel ever returns a fact the recorder does not (a new key is
recorded or argued away, never silently left out).

`REFORMAT_GOLDEN=1` is the only way a corpus goes from format 1 to 2. It adds the two
fields and changes nothing else, and it checks that rather than assuming it: every
stream is replayed under the current engine against the bytes the corpus already
holds, and one disagreement (a state, an effective outcome, a summary, the deltas)
refuses the whole run: that is a re-baseline, to land on its own first. A second run
is a no-op, and a format-2 corpus whose recorded fields no longer replay is refused,
never "repaired". `rebaselineCorpus`, `extendCorpus` and `extendFloor` keep the
corpus's format.

**A format-1 corpus the reformat cannot take.** Format 1 stores the *module's* outcome,
summary and deltas; format 2 stores the *effective* ones. On a stream with a
settlement, an expunge where the module still answers, or a withdrawal laid over a held
level result the two differ, so the reformat's own check (the current engine must
reproduce every field the corpus holds, as format 2 records it) finds a disagreement.
The ordinary advice, "re-baseline it first", does not work here: a format-1 re-baseline
records the module's answer, the bytes the stream already has, and the reformat refuses
again. The tool tells the two apart (the stream replays clean under format 1, but not
under format 2) and its refusal names the route that does work: **start from the
format-3 corpus on main** (take that file as main has it, where every stream already
holds its effective answer) **and re-append the branch's streams with
`EXTEND_GOLDEN=1`**, which records in the corpus's own format. Appended streams are
plain *added* streams to the epoch guard and owe nothing by themselves; a config the
branch added may grow a floor hole `EXTEND_GOLDEN` then fills. Measured on W2c's
format-1 corpora (football, hockey and icehockey, whose `abandonAward` streams record
a draw where the effective replay gives none): every one of them refuses a reformat. A
corpus with a stale field *and* such a stream gets both messages, each under its own
advice; the stale one is re-baselined first, as above.

**What the guard does with the new fields (GF-2 T2).** When both sides of a
comparison record them, a difference in either `summaries` (its length, or any
digest) or `overlay` is a **major** owed, like a moved state: a phone computes
both. A stream that **gains** them (the baseline is format 1, the tree is format 2,
the stream's identity and input are the same) is *newly recorded*, and that owes
**nothing only while the change touches no fold source** (owner ruling Q1,
2026-10-15). With the source frozen, the recorder ran the baseline's own code, so
what it wrote is what the baseline computes; with the source moving in the same
diff, the new fields would record the NEW rule and every old field, which cannot
see the kernel, would still look unchanged. The guard asks git which files the
tree changes against the baseline (`git diff --name-only --no-renames` and the
untracked files, repository-relative) and counts as **fold source**:

- anything under the engine's `src/` except `src/testkit/**` and any `*.test.ts`,
  `*.golden.json`, `*.schema.json` and `*.md` (so `src/sport/fold-epoch.ts` IS
  fold source: paying a bump in the PR that reformats makes every other sport's
  newly recorded streams owe too, so a reformat lands alone, or every sport is
  bumped);
- the engine's own `package.json` (zod and the toolchain fold too);
- the lockfile at the repository root.

When any of those moved, every newly recorded stream counts as **changed**: the
line says `N newly recorded stream(s) while the change touches fold source: <paths>
(land the format bump alone, or raise FOLD_EPOCH)`. A pre-existing field that
moved in the same change is changed whatever the source did (D34, owner ruling Q6:
a harness-only rewrite of an existing field stays a **major**). The report has a
`recorded N` column (the newly recorded streams of the sport). The format never
falls: a corpus that was format 2 at the baseline and is format 1 now is a
violation (`corpus format fell (2 -> 1)`) that no bump settles. It is decided on the
**corpus**, not on the streams that happen to match: a corpus rewritten as format 1
with every stream re-recorded matches nothing, owes the major (which a bump pays), and
is still red. A corpus that
declares a format other than 1 and 2, a format-2 stream without one summary digest
per event and an overlay that is a JSON object, or a format-1 stream that already
holds either, is refused (exit 2). A guard that is not told what changed (the pure
`epochViolations` without its change list) treats it as fold source touched.

The reformat itself (`REFORMAT_GOLDEN=1`) is **data only and lands in its own
commit**: the corpora gain `format: 2` and the two fields, every other byte
unchanged, and `fold-epoch:check --against <the commit's parent>` passes with
`changed 0` and `recorded` equal to the stream count. A later change to the
recorder itself (or to the kernel) moves fields both sides record, and that is
the major above.

**What the corpora exercise (GF-2 T3).** Recording the overlay is not exercising it: a
corpus whose overlay never leaves the kernel defaults records `{}` for every stream
and pins nothing (measured over the 381 streams of the reformat: none reached a
settlement, an expunge or a level withdrawal). So the golden floor (below) now
requires each kernel fact to be seen **leaving its default** and, where an undo
reopens it, **coming back**, and the corpora hold the streams that do it (a settle
story and an expunge story per sport). The floor and the unpinned-class probes run on
the format-2 recorder, which retired five of the things "What the guard cannot see"
used to list; the manual majors they named are no longer owed. What stays on that
list is stated there.

## Corpus format 3 (GF-2 T4)

`aggregatePlayerStats` (`src/stats/stats.ts`) is the fold behind every leaderboard: goals, assists, cards,
an award's credit (`<key>_awards`), the keeper and set/match rows. Only the **server** runs it (the S2
contract: **a phone must not compute or render player stats**), so a change to it moves what the server
stores and shows and nothing a scorer's phone plays by. A **format 3** corpus records its result, and that
makes it a **minor** of the epoch pair (owner ruling Q2, 2026-10-15), never a `FOLD_EPOCH` on its own.

| field | format 2 | format 3 |
|---|---|---|
| everything format 2 records | as above | unchanged |
| `playerStats` | absent | one JSON string per stream: the FINAL rows the server's `foldDivision` would hand `aggregatePlayerStats` for this fixture (the void-resolved ledger, the stream's team sheets, a ctx naming the fixture's two entrants of the kind the sport declares), as `[{"personId":..,"stats":{..}},..]`, **rows by personId and stats by key name in code-unit order** (so a refactor that only reorders what the fold emits moves no byte), `"[]"` when no one has a row. Only final rows: the fold is not run after every event |

The field is REQUIRED under format 3 and forbidden under formats 1 and 2, so absence can only mean an earlier
format, exactly as for the format-2 fields. A value that is not a finite number is refused rather than
recorded (`JSON.stringify` would write `null`, a pin on nothing). The format never falls (3 -> 2 and 3 -> 1 are
red, whatever is bumped); it is judged on the corpus, by the evidence its streams carry (a stream that records
`playerStats` is format 3 whatever its corpus declares).

**What the guard does with the field.** When both sides of a comparison record `playerStats`, a difference is
a **minor** owed (`statsOnly` in the report): states, outcome, summary, deltas, `summaries` and `overlay` all
equal, a person's number, a stat key or a row moved. Any other class that is owed in the same sport (a state
moved, a stream removed) decides as before, because the strongest class owed wins. A stream that **gains** the
field (baseline format 2, tree format 3) is *newly recorded* and follows owner ruling Q1's analogue: it owes
**nothing only while the change touches no fold source** (the classifier is the same as for format 2, see
above). With the source moving in the same diff, the new field would record the NEW rule and every older field
could not see it, so the sport owes a **minor** (`N newly recorded stream(s) of player stats while the change
touches fold source: <paths> (land the stats field alone, or raise FOLD_MINOR)`), not a major: the stats
field cannot make a phone disagree with the server. A harness-only rewrite of an EXISTING field stays a
**major** (D34, owner ruling Q6).

The report prints ` stats-only N` after `recorded N` only when N is above zero.

The reformat itself (`REFORMAT_GOLDEN=1`, 2 -> 3) is **data only and lands in its own commit**: every stream gains
`playerStats`, the corpus gains `format: 3`, every other byte is unchanged, and `fold-epoch:check --against <the
commit's parent>` passes with `changed 0` and `recorded` equal to the stream count. Measured on the eleven
corpora: 403 streams, +105,146 bytes (+3.4%), 329 streams with at least one row.

**What the floor now requires.** For every award key a sport DECLARES in `playerStats.awards` (football `motm`,
hockey `potm`, icehockey `mvp`), a recorded stream must show it credited: the token `stats:award:<key>`,
satisfied by a recorded person with `<key>_awards` of 1 or more. The `award` scenario (appended, index 11)
builds the missing story: an award to a home player, struck by a void, then the same award to an away player;
the stats fold must credit the away player once and the home player never. The eight sports that declare no key
owe no token. The same field is why `core.award` leaves the unpinned class where a key is declared (below).

`STATS_FOLD_VERSION` is a separate, manual obligation this guard does not enforce. It is an ENGINE constant
(`src/stats/stats.ts`, part of the fold source and the phone closure), which apps/web folds into the md5 of every stored
player-stat snapshot (`player_stat_snapshots`). **Bump it whenever the stats fold's output changes** for the same ledger
and inputs. If a bump is missed, every snapshot folded by the old rules keeps being served until its division changes.
The guard does see the trigger (a stats-only difference is reported as ` stats-only N`), but nothing requires the number
to rise; the reviewer of a stats-fold change owes that check by hand.

## A re-baseline that changes a fold must raise that sport's version

A sport's version is a **pair** in `src/sport/fold-epoch.ts`: the **major**
(`FOLD_EPOCH`, read with `foldEpochOf`) and the **minor** (`FOLD_MINOR`, read
with `foldMinorOf`). A corpus change owes one of them, in the **same PR**,
depending on who computes what moved:

| What moved (the stream's events, lineups and raw config object are unchanged) | Owes |
|---|---|
| a state, the outcome or the summary: a phone computes and renders these | **major** |
| a stream was removed, or re-recorded (its events, lineups or raw config object changed) | **major** |
| only the standings `deltas` (states, outcome and summary byte for byte the same): the server computes these | **minor** |
| both kinds in one sport | **major** (the strongest class owed decides) |
| format 2: a recorded `summaries` digest (or the list's length) or `overlay` differs, on a stream both sides record | **major** |
| format 2: the stream gains `summaries` and `overlay` for the first time, nothing it held moved, and the change touches no fold source | nothing |
| the same, but the change touches fold source (see "Corpus format 2") | **major** |
| format 2 -> 1: the corpus is format 1 where the baseline's was format 2 (its streams matched or re-recorded alike) | red; no bump settles it |
| format 3: only a recorded `playerStats` differs, on a stream both sides record (the server's leaderboard fold moved; nothing a phone computes did) | **minor**, plus a manual obligation: raise `STATS_FOLD_VERSION` (`src/stats/stats.ts`), or stored snapshots keep being served |
| format 3: the stream gains `playerStats` for the first time, nothing it held moved, and the change touches no fold source | nothing |
| the same, but the change touches fold source (see "Corpus format 3") | **minor** |
| format 3 -> 2 or 1: the corpus fell to an earlier format | red; no bump settles it |
| streams only appended (`EXTEND_GOLDEN`) | nothing |

The **major is the one the server gates on** (batch 1f): native clients send
theirs, and the server refuses one below its own for the fixture's sport, so a
major bump **locks out every older phone of that sport** until the app updates.
The **minor is informational**: nothing refuses a phone for it and no app
update is needed; it records that output only the server computes moved (the
shapes that really are deltas-only are listed below). Anything ambiguous is a
major. A deltas-only change need not be paid with a major bump, unless the same
PR owes a manual major.

The pair only goes up, lexicographically. A major that rose may leave the minor
anywhere (resetting it to 0 is the usual thing); a major that fell, or a minor
that fell while the major held, is red; and **a minor bump never settles a
change owed as a major** (a stream's states moved and only the minor was raised:
red, "major owed"). A baseline that has no `FOLD_MINOR` (the PR that introduced
it) is a minor of 0 for every sport. A change outside the corpora's reach that
alters what a phone computes (see "What the guard cannot see") owes a major by
hand.

`scripts/fold-epoch-guard.ts` enforces it in CI (the `gates` job). It compares
the PR **as a whole** with the branch it merges into: CI runs it with
`--against HEAD^1`, the first parent of the PR's merge commit, which is the base
branch's tip, so it is a net diff and not a commit-by-commit one. That keeps
the first clause above true: the corpus still goes in a commit of its own, the
bump may follow in the next commit, and the PR is green. Run against the corpus
commit's own parent it is red, which is the point of the second commit.

A stream's **input** is its raw config object (the one it names in the corpus's
`configs`), its events and its lineups, and changing any of the three counts as
re-recording the stream, which owes a **major**. The config is in that set on
purpose, because **every module embeds its config in its state**: changing an
existing default VALUE (a `cap` of 30 becoming 31, a `pointsMap` of `2/0`
becoming `3/0`) moves states, and so is a **major**, never a minor.
`REBASELINE_GOLDEN=1` cannot land it: it splices the recorded config back in, and
the golden replay reds on the recorded config (`cfg.pointsMap.*[0]: recorded 2,
replayed 3`; for a `cap`, the recorded set scores no longer exist). The way to a
green suite is to write the old value (`cap: 30`) into every recorded config that
lacked it. Every replay then folds to the same result and not one event or output
moves, but a phone that still holds the old default plays a different rule. The
guard sees the edited config and demands the **major**; a minor bump does not
launder it.

What really is deltas-only, each shape walked through the real tooling
(re-baseline, then the plain golden replay green, then the guard):

- **Code of `standingsDelta` or `supportsDraws`**, which only the server calls
  (a phone must not compute or render them: `src/sport/fold-epoch.ts` says so,
  and if one ever does, D34 is to be revisited).
- **Credit on a metric that is not displayed**, for example the set kernels'
  `points_won` credited by a forfeit (`kernel.ts`, forfeit credit): the standings
  deltas move, no state, outcome or summary does. A credit the summary reads
  (football's `goalCredit` reaches an award's summary) is a **major**.
- **A default that only ADDS a key**, for example a new `"2-1"` entry in a
  `pointsMap` default: the recorded config is a subset of the replayed one, so
  the replay stays green, and only the `deltas` of the streams that score a
  `2-1` result change.

A division's own config, set by an organiser, is input and never owes a version
change; only a module's code and its defaults do.

To check before pushing (from any directory; it also reads uncommitted work, so
re-baseline into a clean tree, bump, and run it):

    pnpm --filter @onryde/seazn-engine fold-epoch:check --against origin/main

It prints one line per sport (major and minor before -> after; streams matched,
changed, deltas-only, removed, added, recorded) and `N sports checked, M streams
compared`; a violation line says `major owed` or `minor owed` and names the
exact entry to raise, for example `raise FOLD_MINOR.badminton to 1` or
`raise FOLD_EPOCH.badminton to 2`. Exit codes: `0` every sport is in order (or
the base has no `fold-epoch.ts` yet: the PR that introduces it); `1` a sport's
results moved without the half that is owed rising, the pair fell, or a corpus
and an epoch entry do not pair up; `2` refused, nothing judged (the ref is not
a commit, which is what a shallow clone or a root commit gives; git could not
list or read the base; a table or corpus that does not load, including a tree
whose `FOLD_MINOR` is missing or names other sports than `FOLD_EPOCH`; a corpus
format that is none of 1, 2 and 3, or a half-recorded format-2 or format-3 stream; a run that
compared no stream); `3` the guard itself crashed.

## What the guard cannot see

The epoch guard compares corpora, so it is only as wide as they are. It judges
the **module layer** of the **exercised paths**, and a change outside that owes
a **manual MAJOR bump of every sport it reaches** (raise each sport's `FOLD_EPOCH` by
hand in the same PR; no tool will tell you):

- **Recorded, but the overlay is unpinned: a note, and an award where the sport declares
  no key for it.** The corpora hold both (the golden floor, below), and recording an event is **not** pinning it: an
  event a module folds as `return state` can sit in a stream and move nothing the
  epoch guard compares. Measured by removing the event from each recorded stream and
  comparing every recorded field, now including the kernel overlay and the summary
  digest after every event (the floor's own `OVERLAY_CLAIMS` probe, which turns red
  the day either starts to move a golden):
  - `core.note`: inert in all eleven (every module folds it as `return state`, and
    nothing computes from a note).
  - `core.award`: inert in the eight sports that declare no award key (cricket,
    boardgame, carrom, generic, volleyball, badminton, tabletennis, tennis): every
    module folds it as `return state` and the player-statistics fold ignores a key the
    sport does not declare.
  A change to how a MODULE folds either (the state it keeps, so what a phone computes)
  therefore owes a **manual MAJOR bump of every sport it reaches**: raise each sport's
  `FOLD_EPOCH` by hand in the same PR. A change to how the player-statistics fold treats
  an award key a sport does not declare is server-only (a phone never computes it), so it
  owes a manual **MINOR** (`FOLD_MINOR`), by owner ruling Q2. Nothing here is a
  closed gap; the floor only keeps the open one visible. `forfeit-credit.ts`: walkover
  credit is pinned only where a corpus has a forfeit that reaches it.
  **Retired by GF-2 T3** (the same probe, run on the format-2 recorder, now answers
  "pinned" where it answered "unpinned" on the module-only one): `core.suspend` /
  `core.resume` in all eleven sports (the stoppage is a recorded column), and every
  `core.lineup.*` type in boardgame, carrom and generic plus football's position
  change (the squads are a recorded column). Since the 2026-10-15 lineup ruling the
  first three no longer take a lineup event at all (see "The golden floor", item 1), so
  their corpora hold none and the flip stands on football's position change alone.
  `uncoveredUnpinned` still ablates every
  recorded `core.*` event and reds on any that moves nothing yet is named by no claim.
  **Retired by GF-2 T4** (format 3 records the final player-stats rows): `core.award` in
  football (`motm`), hockey (`potm`) and icehockey (`mvp`), where an award credits a
  person `<key>_awards`; the claim narrows to the sports that declare no key
  (`OVERLAY_CLAIMS` reads `playerStats.awards`, the engine's own declaration). A change
  to how those three fold an award is now a **minor** the guard asks for, not a manual
  major.
- **A kernel overlay a corpus never exercises.** The harness records the effective
  outcome, the summary after every event and the overlay (settlement, expunge,
  withdrawal over a level result, stoppage, squads, a pending decider), and the floor
  requires each fact to move. What it cannot require is a path no stream reaches: a
  config knob no recorded config sets. Football, hockey and icehockey (the last two
  through the shared period kernel's `applyAbandon`) carry `abandonPolicy: "replay" |
  "award"`, and every recorded config says `replay`; under `award` the module itself
  answers an outcome after an abandon (the leader wins, a level score is a draw where a
  draw stands), so `outcomeOf`'s expunge guard (an expunged match has no outcome) would
  be visible there, and no stream shows it. The expunge of an `award`-policy match is
  owed a recorded config in each of the three. (Under the recorded configs only
  cricket's module answers an outcome after an abandon, so a mutant that makes
  `outcomeOf` ignore the expunge reaches cricket alone; the `expunged` column is what
  pins it in all eleven.)
- **Kernel refusals, and widening what the kernel accepts.** A rule that only REFUSES an
  event moves no recorded byte when it is widened: a ledger it refused was never
  recorded, and every ledger it accepted folds as before. There are two, both fed by the
  fold's `abandonActive` flag in `core/events.ts`: X-AB-4, the refusal of a forfeit while
  an unvoided abandon stands (`ABANDONED_SETTLE_OR_VOID`, the `core.forfeit` branch near
  :943), and the settle admission (`SETTLE_NOT_APPLICABLE`, near :1108: a settle applies
  only to a level result, an abandoned match with no result, or a pending tie-break).
  Widening either one (accepting what it refused) changes what a ledger can mean without
  changing a golden, so it owes a **manual MAJOR bump of every sport it reaches**, like
  any other path the corpora do not show.
- **Unexercised branches** of a module: a field no stream writes is invisible to
  a byte-exact comparison (see below), so a rule that fires only there moves
  nothing. An opt-in cfg key is the standing case: an older phone strips or
  refuses it, so a match that sets it folds differently there, while every
  recorded stream (none sets it) folds the same. W2c's were raised by hand
  (owner 2026-10-15, manual MAJOR for opt-in cfg keys the guard cannot see):
  football `shootoutAttempts`, hockey fih-shootout `abandonPolicy:"q4_stands"`,
  carrom and generic `abandonPolicy:"share"`. Task 16c then recorded a stream
  for each branch (`golden-branches.ts`, next section), so a later change to
  how those keys fold is seen by the guard. The bump already raised stays: it
  covers the keys' arrival, which no stream can show a baseline without them.
  A NEW opt-in key owes a story in that table, not just a name in a config.
- **Player-statistics folds outside the recorded final rows** (`src/stats/stats.ts`).
  Format 3 records the FINAL rows of each stream, so a change to how a recorded stat
  folds is a **minor** the guard asks for (the server computes it; a phone must not).
  What no stream shows is a stat no recorded ledger earns, an award key a sport
  declares and no stream credits (the floor requires one per declared key), and any
  rule only reachable through a ctx the recorder does not build (it builds the
  fixture's own two team sheets and nothing else). Those owe a **manual minor**, raised by hand in the PR (`FOLD_MINOR`); no tool will tell you.
  The parts of the server's leaderboard the recorder does not run, each read from
  the code and each owing the same manual minor when it changes:
  - `sumPlayerStats` and the division re-derivation of ratio metrics
    (`stats.ts`): the recorder stops at one fixture's rows and never sums across
    fixtures, so a `derived` metric is recorded only as that fixture folded it.
  - The tombstone relabel (`apps/web` `usecases/player-stats.ts`): a merged person's
    id is relabelled to the survivor before the sum; no corpus has a merged person.
  - Entrant kind: the recorder gives both sides the sport's declared `defaultKind`
    (through `effectiveEntrantModel`, `golden-stats.ts` `statsCtxOf`), where the
    server reads each entrant's own row kind and falls back to `"team"` for an
    entrant it cannot find (`entrantFoldCtx`, `entrant-members.ts`). A bye or TBD
    side is dropped there, not padded, so the server can fold a ctx of one entrant.
  - The lineup pair: the recorder always passes one (the corpus records them); the
    server passes `lineupsByFixture.get(fixtureId)`, which is `undefined` for a
    fixture with no sheets. The fold then has no non-player filter, so a coach or
    team official is not excluded (the ctx is passed either way).
  - Football `motm` is pinned by ONE stream (`stats:award:motm`), so the award's
    credit path has a single witness; the floor asks for one, not for more.

Which `core.*` events and outcome kinds each corpus holds is no longer a gap to
read off a table: it is a floor a test enforces (next section). Holding an event
is not the same as pinning it: the "Recorded, but the overlay is unpinned" bullet
above is the list of events a corpus holds and the guard still cannot see move.
`docs/superpowers/specs/engine-split/reviews/1e.md` ("Corpus coverage per sport")
is the measurement that motivated it.

## The golden floor (GF-1, GF-2 T3)

`src/testkit/golden-floor.test.ts` fails unless every sport's corpus records at
least one stream for each of:

1. **Every `core.*` event the kernel accepts** — derived from
   `Object.keys(CORE_EVENT_SCHEMAS)` (fifteen: the ten kernel events and the five
   `core.lineup.*`), never a typed list; the lineup planners are checked against
   that list too, so a sixth `core.lineup.*` type with no planner fails by name
   instead of being "impossible". `core.void` is in every corpus because an undo
   is the commonest thing a phone writes. A void's target id is `voids` on the
   recorded event (`GoldenEvent.voids`, the envelope field; the payload is
   strictly empty). **The five `core.lineup.*` types are required only of a sport
   that ADMITS them** (owner ruling 2026-10-15): the kernel takes a lineup event on the
   write path only for a module that declares a `lineupPolicy`, so boardgame, carrom and
   generic (which declare none, and read no squad) refuse every one with
   `LINEUP_NOT_SUPPORTED`. For them all five are *impossible*, with the reason
   `lineup-not-supported` per recorded config, they owe no `overlay:squads:set` (item 3),
   and their corpora record no lineup event and no bench sheet (their own catalogs'
   `benchMax` is 0, and a bench existed in a floor stream only to give a lineup event
   someone to bring on). The test is the module's declaration (`admitsLineupEvents`), not a
   list of sport names: a sport that declares a policy tomorrow owes the tokens tomorrow.
   Two more tokens say WHAT is undone or left standing:
   `undo:core.forfeit`, `undo:core.abandon` and `undo:core.settle` (a mis-tapped
   retirement or abandon, struck, with play resuming to the walk's own result; a
   settle struck, which takes the organiser's win away), and
   `standing:core.abandon` (an abandon nothing strikes, which leaves the match
   ended with no outcome). A recorded void is checked to mean what it says
   (`golden-floor-voids.test.ts`: the ledger folds as if its target had never been
   recorded, and differs with the target left standing).
2. **Every outcome kind the module can produce** — there is **no** per-module
   declared union (`OUTCOME_KINDS` is the global six), so the floor derives it:
   `win` always; `draw` where `supportsDraws` holds for a draw-capable stage in a
   recorded config; each forfeit reason (`walkover`, `retired`, `disqualified`,
   `withdrew`) and the `double_walkover` where `forfeitAdmission` admits them in a
   state the sport's own generator reaches (all eleven admit all of them);
   `tie` / `no_result` only from `NATURAL_OUTCOMES`, a reasoned per-sport list
   that is checked both ways (a listed outcome must be recorded, and a sweep of
   generator walks must reach no unlisted one).
3. **Every kernel overlay fact moving** (GF-2 T3) — `overlay:<fact>:set` (the fact
   leaves its kernel default) and `overlay:<fact>:cleared` (it comes back), for each
   key the kernel's fold returns beside the module state. The keys are READ OFF a real
   fold of an empty ledger (a test fails by name if the kernel gains a key with no
   rule, or loses one), and each carries one owner-ruled rule (design §4, 2026-10-15):
   `stoppage` set and cleared; `squads` set (a lineup change moves them off the team
   sheets; the default is a digest only a fold can compute, so "cleared" is not
   required; owed only where the sport admits lineup events, so not in boardgame,
   carrom or generic); `settlement` set and cleared; `expunged` set and cleared;
   `levelWithdrawal` set and cleared, only where the sport's floor requires a draw, a
   tie or a no_result (a withdrawal can be laid over a held level result there
   alone: football, cricket, boardgame, generic, ice hockey, hockey). The tokens are
   read from each stream's recorded `overlay` column (`overlayTransitions`), so a
   stream that never leaves the default records nothing and satisfies nothing.

Whether an event is written by a phone or only by an organiser does not reduce
the floor.

**Exemptions** are explicit rows in `FLOOR_EXEMPTIONS`, each with a reason and a
`stale()` check that turns the row into a failure the day it no longer holds.
There are none since GF-2 T3: the one row, `core.settle`, existed because the harness
recorded the module's bare outcome and a settle is laid over it; format 2 records the
effective outcome, `settleProbe` read recorded === effective, and the row was deleted
(the test file keeps the row as a fixture and shows the probe flip under both
recorders, so the staleness check is shown to announce it). The mechanism stays for
the next reasoned exemption. Impossible-by-policy rows
are not exemptions but derived: `core.lineup.replacement` is required only where
a recorded config's policy lets the reducer accept it (football's `concussed`,
cricket's `mutable`, volleyball's libero); everywhere else the floor records the
reducer's own refusal code instead of a stream. A sport that declares no
`lineupPolicy` is refused by the kernel before the reducer is asked, so its reason is the
kernel's own (`lineup-not-supported`) for all five types.

**Recorded, overlay unpinned.** The floor is a presence check, and a stream that
records `core.note` satisfies it without pinning anything. That class is explicit:
`OVERLAY_CLAIMS` names, with a reason each, the events that move no recorded golden
(now a note and an award), the claim is **derived** by ablation (remove the event
and the voids that struck it, renumber the event ids the overlay names, compare
every recorded field: the states, the effective outcome, the summary digest and
overlay column at every step, the deltas), and a claim whose ablation starts to move
a golden, or finds nothing recorded, or cannot run, fails by name. `finalize`,
`abandon` and `forfeit` are probed beside them as controls and answer "pinned" in all
eleven. The ablation probe takes the recorder as a parameter: the same probe over the
same corpora answers "unpinned" for a pause and a lineup change under the module-only
recorder and "pinned" under the real one, and `golden-floor-overlay.test.ts` holds
that flip for each retired claim.

**One witness per column.** The floor asks for ONE stream per token, and that is what it
gets: at the GF-2 batch review (2026-10-16) the overlay columns `settlement`, `expunged`,
`levelWithdrawal` (where the sport has it) and `squads` were each witnessed by exactly one
stream per sport (one setting it, one clearing it; stoppage by one or two), so a rule with
branches is pinned only for the inputs that one stream happens to use. That is not a gap
against the floor and not a defect; when a column's rule grows a branch, adding a witness for
the new input is that change's job, because the floor will not ask for it.

**Anti-vacuity.** Every sweep reports how many sports, tokens and holes it
checked; zero is a failure; the empty-corpus case is tested first (an emptied
corpus is red, naming the sport). One bound, stated: the completeness sweep for
outcomes the floor does not require walks 40 generator seeds per config
(`OBSERVE_SEEDS`), which cannot reach a rare outcome (cricket's `tie` first turns up
near seed 460); those are the ones `NATURAL_OUTCOMES` declares by hand, and the
other direction of that table (a declared outcome no corpus records) keeps it honest.

**How the streams get there.** `EXTEND_GOLDEN=1` runs `extendFloor`
(`golden-floor-streams.ts`) after the coverage pass. It builds short named
stories from the module's own generator with kernel events spliced in at points
the fold confirms are live — an undo, a struck retirement and a struck abandon
(each with play resuming), and a late correction (an EARLIER event struck after
later play, searched across every config and seed: a toss or a pairing card where
a board game's or a carrom match's other events are chained), a stoppage with a
note and an award and the finalize, an abandon that stands, each forfeit reason, a
withdrawal carrying the lineup changes (where the sport admits them; in boardgame, carrom
and generic it is the same story without them) — and keeps a stream only if it closes a
hole. Two stories were added by GF-2 T3: a **settle** story (where the sport can end
level: a level result, a `withdrew` forfeit laid over it, the forfeit struck, a settle
by the organiser, the settle struck, a settle by lot; where it cannot: an abandon in
its place) and an **expunge** story (a withdrawal cascade's `core.abandon{expunge}`
mid-match, struck at once, play on). Each step is read back from the kernel's own fold
before a stream is kept. They are APPENDED to the scenario list, never inserted: a
floor is reproduced by running the scenarios in order, and a stream an earlier
scenario built must not depend on one added later.

A floor stream is measured against the streams that PRECEDE it in the corpus, and
**a floor is reproduced one batch at a time**. A batch is a maximal run of
consecutive floor streams (`floorBatches`: what one `EXTEND_GOLDEN` appended); it is
reproduced from the streams before it and **only the configs those streams
reference** (`corpusBefore`), because a config a later wave adds changes what the
floor derives (a carrom config that allows draws moves the stoppage story to
another config) and a second batch could never otherwise match. Today's rules
append the older batch's streams and then the newer one's, so a batch is reproduced
when its streams are the FIRST of what `extendFloor` appends there. A generator walk
a later `EXTEND_GOLDEN` appends after the floor changes neither the reproduction nor
the keep-rule. Floor
streams have `seed >= FLOOR_SEED_STRIDE` (100000); the epoch guard keys a stream
by `config#seed`, so a floor stream is a plain **added** stream, never a changed
one, and a floor append owes no version bump (neither `FOLD_EPOCH` nor `FOLD_MINOR`). The existing streams are not
touched; `golden.test.ts` asserts the prefix.

## Branch streams (W2c Task 16c)

`src/testkit/golden-branches.ts` is the fourth append path, for the branches a
config key switches on that none of the others can reach: the generator never
sets an opt-in key, `extendCorpus` stops once the key is pinned, and the floor
derives its tokens from kernel events. It is a table of **stories**; each builds
its ledger from the module's own generator plus the kernel event the branch is
about, and carries a verdict (`reached`) over the engine's own folds. Every
verdict is a **differential**: the same ledger refolded without the key must
decide differently (the default five kicks leave the shoot-out running; the
replay default holds nothing), so a stream that only names the key proves
nothing. `branchHoles` is the skip rule (any recorded stream that reaches a
branch makes it a skip, whatever its config name or seed) and `extendBranches`
appends one slim stream per hole; `EXTEND_GOLDEN=1` runs it after the floor.

Branch streams carry `seed` in `[BRANCH_SEED_BASE, FLOOR_SEED_STRIDE)` (90001
and up): above every generator seed, below the floor's stride, so the floor's
reproduction and keep-rule never count them. They are appended streams, so they
owe no version bump. They add configs, appended at the end of `configs`; no
existing stream or config changes. The seven stories today: football
`shootoutAttempts`, hockey `q4_stands`, carrom and generic `share`, and the
`award` abandon with a withdrawal's expunge for football, hockey and ice hockey.

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
corpus: narrowing cricket's `superOverStillTied` enum. Every cricket stream
records `"repeat"`, so the frozen states pin that one member and dropping any
other moves no recorded state — all eleven corpora stay green. The schema
snapshot records the declaration instead of a replay, so the narrowing is a
removed line there. The test asserts that blindness (one recorded value against
several declared members) instead of describing it, because "this gate cannot
see X" is exactly the kind of claim that rots into folklore. (The exemplar was
football's `abandonPolicy` until W2c Task 16c recorded its second member,
`award`: that narrowing is now a corpus kill, and the test asserts that too.)

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
