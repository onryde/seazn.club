# v1 public API — breaking changes

Newest first. Each entry names what changed, what replaces it, and what a
consumer sees if it sends the old value.

This file starts at the first breaking change the v1 contract has taken. It
is not a full changelog: additive fields do not appear here, because a reader
that ignores an unknown field is unaffected by one.

## 2026-10-28 — a hockey or ice hockey shoot-out config no longer carries `suddenDeath`

The hockey and ice hockey configs (`config.shootout`, for a variant that plays
a shoot-out) had a `suddenDeath` flag, `true` in both presets. Nothing ever read
it: it changed no kick, no result and no screen. It is removed.

**What changed.** `config.shootout.suddenDeath` is no longer part of a hockey or
ice hockey config. A request that still sends it is not refused: the key is
dropped, and the rest of the shoot-out is read as before.

| Path | Before | Now |
|---|---|---|
| `POST /api/v1/competitions/{id}/divisions`, `PATCH /api/v1/divisions/{id}`, `POST` and `PUT /api/v1/divisions/{id}/stages` (a stage's `rules`), `PUT /api/v1/stages/{id}/rules`, `PUT /api/v1/fixtures/{id}/rules`, a hockey or ice hockey config with a `shootout` | `suddenDeath` was a required boolean and was stored | accepted and dropped: 200 as before, and the stored config has no `suddenDeath` |
| `GET /api/v1/divisions/{id}`, `config.shootout` | `suddenDeath` present (a boolean) | absent once the stored copy is removed (see below) |

**What replaces it.** Nothing: the key did nothing. Stop sending it, and stop
reading it.

**What a consumer sees.** No error. A client that sends the old value
(`"suddenDeath": true`) keeps working unchanged. A client that reads
`config.shootout.suddenDeath` gets `undefined` where it used to get a boolean.

**Data.** The release's migration, which runs before the deploy, removes every
stored copy: from the division's config, a stage's rules, a match's own format,
a match's frozen snapshot and its cached state. Until it has run, a stored copy
is still there and still ignored. The fold epochs of both sports are raised in
the same release (hockey from 4 to 5, ice hockey from 2 to 3), so the server's
epoch gate refuses a native scoring client that still sends the old epoch for a
hockey or ice hockey fixture until it updates.

The migration runs before the new server is deployed, and the previous server
still requires the key. For those minutes `PATCH /api/v1/divisions/{id}` on a
hockey or ice hockey division with a shoot-out answers 422, `error.code`
`"CONFIG_INVALID"` (`"invalid icehockey config"`, issue path `shootout`), and so
does a new client's save that reaches a server not yet replaced. A retry
succeeds once the deploy is done. Scoring is not affected.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, decision D4 (rules HK-SO-2 and IH-SO-2). The pinning tests
are `packages/engine/src/sports/period/w2e-period.test.ts` and
`apps/web/src/server/engine-db/__tests__/w2e-suddendeath-strip.test.ts`; the
migration's is `apps/web/src/server/__tests__/w2e-migration.test.ts`.

## 2026-10-28 — The Hundred's net run rate is printed per five-ball over

A cricket table's net run rate (NRR) is the average runs per over a team scored
less the average runs per over scored against it (ECB The Hundred Playing
Conditions 2026, 16.9.4(a)), and an over on The Hundred "shall comprise 5
balls" (17.1). Seazn printed every cricket table's NRR per six-ball over. It now
prints it per over of the division's own length: five balls on The Hundred, six
anywhere else.

**What changed.** Nothing on the wire: `GET /api/v1/stages/{id}/standings`
carries the ledger in balls (`runs_for`, `balls_faced_eff`, `runs_against`,
`balls_bowled_eff`) as before, and the order of a table does not move. The
ratio printed from it does.

| Where | Before | Now |
|---|---|---|
| The NRR cell of a division on The Hundred (`config.ballsPerOver: 5`): the public division table, the hub table, and the "Now: you …, they …" sentence of the qualification what-if | runs per six balls | runs per five balls |
| The same cells for any other cricket division (T20, ODI, a six-ball test) | runs per six balls | unchanged |

A side that scored 120 off 100 balls and conceded 100 off 100 balls printed
`+1.200` and now prints `+1.000`. thehundred.com's own explainer divides by
balls faced, a per-ball figure (`+0.200` here) and names no unit; the Playing
Conditions are the authority, so the figure Seazn prints reads five times the
explainer's.

**What replaces it.** Nothing to send. A client that works NRR out from the
ledger itself divides by the division's `config.ballsPerOver`, not by six.

**What a consumer sees.** A number: the same table, the same order, a smaller
figure on The Hundred.

**No data migration was required.** NRR is worked out from the stored ledger
when a table is shown.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, decision D19 (owner), rule CK-BO-2. The pinning tests are
`packages/engine/src/competition/display-nrr-scale.test.ts` and
`apps/web/src/server/public-site/__tests__/standings-nrr-scale.test.ts`.

## 2026-10-28 — a dismissal a no ball or a wide does not admit is refused

Off a no ball a batter can be out only by hitting the ball twice, obstructing
the field or being run out (ICC Men's T20 World Cup 2026 Playing Conditions
21.18). Off a wide only hit wicket, obstructing the field, run out and stumped
stand (22.9). Both scoring write paths now refuse any other mode on such a
delivery.

**What changed.** A `cricket.ball` (or `cricket.superover.ball`) whose
`payload.runs.extras.kind` is `"noball"` or `"wide"` was accepted with a
`payload.wicket` of any `kind`. It is now refused unless the kind is one of
these:

| Delivery | Dismissals that stand (`wicket.kind`) | Refused |
|---|---|---|
| No ball | `hitballtwice`, `obstructed`, `runout` | `bowled`, `caught`, `lbw`, `stumped`, `hitwicket`, `retired`, `timedout` |
| Wide | `hitwicket`, `obstructed`, `runout`, `stumped` | `bowled`, `caught`, `lbw`, `hitballtwice`, `retired`, `timedout` |

Retired and timed out are not among the clauses' modes, so they are refused on
both deliveries too (the clauses' text, read narrowly). A wide that is also a
free hit is bound by the free hit first (21.19.2), so `stumped` is refused
there. A wicket on a legal delivery is unchanged, in every format.

| Write path | Before | Now |
|---|---|---|
| `POST /api/v1/fixtures/{id}/events`, such a delivery | accepted | 422, `error.code` `"INVALID_EVENT"`, nothing written |
| `POST /api/v1/divisions/{id}/events/import`, a stream with such a delivery | imported | 200; that stream is rejected with `"import.fold_rejected"`, `engineCode` `"INVALID_EVENT"`, and nothing is written for its fixture |

**What replaces it.** Send what happened on the delivery. A batter bowled off a
no ball is not out: send the delivery without a `wicket`. A stumping off a wide
stays a wicket.

**What a consumer sees.** On the scoring endpoint:

```json
{ "ok": false, "error": { "code": "INVALID_EVENT", "message": "\"bowled\" cannot dismiss on a no ball" }, "requestId": "…" }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. A delivery
already in a match's ledger with such a dismissal still replays to the result
it recorded, and a void of it is accepted.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, decision D8, rules CK-NB-1 and CK-WD-1. The pinning test
is `packages/engine/src/sports/cricket/w2e-cricket.test.ts`.

## 2026-10-28 — a cricket match decided by DLS or with revised overs credits the first side as the ICC does

A cricket table's net run rate (NRR) is worked out from each match's ledger. For
a match that Duckworth-Lewis-Stern decided, or that was played with revised
overs, the ICC does not credit the side that batted first with the runs it
scored: it credits the par score, or one run less than the chasing side's
target, off the overs the chasing side had (ICC Men's T20 World Cup 2026
Playing Conditions 16.10.7). Every cricket match is now credited this way; there
is no setting.

**What changed.** The ledger of a one-innings match (`metrics` on a row of
`GET /api/v1/stages/{id}/standings`: `runs_for`, `balls_faced_eff`,
`runs_against`, `balls_bowled_eff`, `run_diff`) moves for the first side:

| Match | Before | Now |
|---|---|---|
| Abandoned, with a result reached under DLS (the chase still open) | the first side's runs off the balls it faced | Team 2's par score on abandonment, off the balls Team 2 faced; Team 2's runs and balls as played |
| DLS applied earlier in the match (a revised target, computed or confirmed by the umpires), or a chase with revised overs and no DLS (the target stays Team 1's total plus one) | the first side's runs off the balls it faced | one run less than Team 2's final target, off the overs allocated to Team 2; Team 2 as played, and an all-out innings counted at its full allocated overs |
| Any other match, a two-innings match, a forfeit | as played | unchanged |

A tie at par, or on a revised target, is a result and counts. Where a revision
during Team 1's innings left Team 2 more resources than Team 1, the par on
abandonment is the engine's approximation (the final target pro-rated by the
resources Team 2 used), not the Standard Edition table's own redistribution.

A first side that made 200 in 20 overs, then a chase revised to 160 off 15
overs that finished on 140 for 6: the first side's row read `runs_for` 200,
`balls_faced_eff` 120 and `run_diff` 60; it now reads 159, 90 and 19. Its NRR
for the match moves from +0.667 to +1.267. A table whose order NRR decides can
reorder.

**What replaces it.** Nothing to send. A client that works NRR out from the
ledger gets the credited figures.

**What a consumer sees.** A different ledger for the match, in the same shape:

```json
{ "runs_for": 159, "balls_faced_eff": 90, "runs_against": 140, "balls_bowled_eff": 90, "run_diff": 19 }
```

**No data migration was required.** NRR is worked out from the match's ledger
when its table is built, and no stored match changes shape. A stored standings
snapshot keeps its old figures until the stage's table is next recomputed. No
recorded match changes its result.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, decision D18 (no setting, no freeze), rule CK-RR-1
(rulebook RB2A-20, audit row SC-C5). The pinning test is
`packages/engine/src/sports/cricket/w2e-cricket.test.ts`.

## 2026-10-28 — a set target below 5, or a tennis best of 1 with a match tie-break, is refused when written

W2e ruling 31: a volleyball or table tennis set is played to at least 5
points. ITF Appendix VI: a match tie-break REPLACES a deciding set, and a best
of 1 has no set to replace. Both are now asked whenever a config is written.
Neither is a schema rule: a config stored before this change still loads,
replays and plays.

**What changed.**

| Write path | Before | Now |
|---|---|---|
| `POST /api/v1/competitions/{id}/divisions`, `PATCH /api/v1/divisions/{id}`, `POST` and `PUT /api/v1/divisions/{id}/stages` (a stage's `rules`), `PUT /api/v1/stages/{id}/rules`, `PUT /api/v1/fixtures/{id}/rules`: a volleyball or table tennis config whose `setTo` or `finalSetTo` is below 5 (as the division, stage and match formats resolve) | accepted | 422, `error.code` `"CONFIG_INVALID"`, `error.issues` `[{ "path": [], "message": "A set must be played to at least 5 points." }]`, nothing written |
| The same paths, a tennis config with `bestOf: 1` and a `finalSet` of `{ "matchTiebreakTo": n }` | accepted | 422 `"CONFIG_INVALID"`, `error.issues` `[{ "path": [], "message": "A match tie-break replaces a deciding set; best of 1 has none." }]`, nothing written |
| `POST /api/v1/competitions/from-template`, a template whose division or stage resolves to either config | instantiated | 422, `error.code` `"TEMPLATE_INSTANTIATION_FAILED"` with `divisionIndex`, `stageIndex` and `cause`: `"invalid <sport> config: <sentence>"` when the division's config is refused, `"invalid <sport> config"` alone when a stage's resolved config is (`stageIndex` set), nothing written |
| `PATCH /api/v1/divisions/{id}` and `PUT /api/v1/stages/{id}/rules`, a save that would leave an unstarted match's own format (`PUT /fixtures/{id}/rules`) one of these configs (a division saved to best of 1 beside a match's own match tie-break) | accepted | 422 `"CONFIG_INVALID"` naming the match: `error.fixture_id` and the same `error.issues` |

Badminton, on the same set kernel, has no such floor. A best of 1 whose final
set is a final-set tie-break (`{ "tiebreakTo": 10 }`) or the same as any other
set is still accepted.

**What replaces it.** Write a set target of 5 or more; for a one-set tennis
match, a final-set tie-break (`finalSet: { "tiebreakTo": 10 }`) or best of 3
with the match tie-break. To change a division or stage under a match that has
its own format, set that match back to its stage's format first.

**What a consumer sees.**

```json
{ "ok": false, "error": { "code": "CONFIG_INVALID", "message": "invalid volleyball config: A set must be played to at least 5 points.", "issues": [{ "path": [], "message": "A set must be played to at least 5 points." }] }, "requestId": "…" }
```

Key on `error.code` and the issues' `message`, not on `error.message`.

Only a new write is judged; a stored config that breaks one still loads and
plays as before. None is left stored: the release's migration, which runs
before the deploy, counts every stored config that breaks either rule (in a
division's config, a stage's rules, a match's own format, a match's frozen
snapshot and its cached state) and, if it finds any, stops the deploy and
names each one. So no division is left that every later save would refuse.

## 2026-10-28 — a short-set tie-break ends at 5–4 (Fast4 and the new short-sets format)

ITF Appendix VI §2's short-set tie-break is the first to five points "with a
deciding point if the score reaches four all", so its margin is one. The set's
config carries that margin as a new optional key, `set.tiebreakWinBy`; absent,
a set tie-break plays to the match's `tiebreak.winBy` as before. The match
tie-break and a final-set tie-break (`finalSet.tiebreakTo`, App VI §5's ten-point
decider) always play to `tiebreak.winBy`, whatever `set.tiebreakWinBy` says:
short sets with a final-set tie-break to ten end the decider two clear (11–9),
never at 10–9.

**What changed.**

| Write path | Before | Now |
|---|---|---|
| `POST /api/v1/fixtures/{id}/events`, `tennis.point` at 4–4 in the tie-break of a Fast4 set (the `fast4` format, or any set with `tiebreakWinBy: 1`) | the tie-break played on to a two-point lead | the point ends the tie-break and the set (5–4) |
| Same path, a Fast4 `tennis.set_summary` of 4–3 with `tb` 5–4 | 422 `INVALID_EVENT` | accepted |
| Same path, a Fast4 `tb` block of 6–4 or 6–5 | 6–4 accepted | 422 `INVALID_EVENT`, nothing written |
| Both write paths, any tie-break or match tie-break played to a margin of one (`set.tiebreakWinBy: 1`, or `tiebreak.winBy: 1`), a `tb` block or match tie-break summary past its target (8–7 in a tie-break to 7; 11–10 in a match tie-break to 10) | accepted (only the point before was checked) | refused, `"INVALID_EVENT"` ("not a reachable final score"); `events/import` rejects the stream with `error.engineCode` `"INVALID_EVENT"` |

A Fast4 division that existed before this release keeps the margin it played:
the release's migration writes its own `tiebreak.winBy` into the stored set as
`set.tiebreakWinBy` (2, the default, unless the organiser chose a margin of
one), in the division's config and in every stage rule, match format, frozen
snapshot and cached state that holds a Fast4 set. A division created from the `fast4` format afterwards plays the
deciding point. A new format, `short-sets` (tie-break at 4-all, advantage
games), plays it too.

**What replaces it.** Send the score that was played: a short-set tie-break
ends 5–0 to 5–4.

**What a consumer sees.**

```json
{ "ok": false, "error": { "code": "INVALID_EVENT", "message": "tie-break summary is not a reachable final score" }, "requestId": "…" }
```

Summaries recorded before the change still replay as recorded.

## 2026-10-28 — a tennis set score no set can reach is refused

A tennis set summary in plain games (no `tb` block) is now refused when no set
can reach it under its tie-break: the score before its last game must itself be
reachable from 0–0 without passing a finished set or the tie-break score.

**What changed.** For `tennis.set_summary` with plain games:

| Write path | Before | Now |
|---|---|---|
| `POST /api/v1/fixtures/{id}/events`, a summary whose score no set can reach (`{home: 8, away: 6}` or `9–7` with the tie-break at 6-all; `5–3` or `6–4` in a Fast4 set, tie-break at 3-all) | accepted (only the one game before was checked) | 422, `error.code` `"SET_SCORE_UNREACHABLE"`, nothing written |
| `POST /api/v1/divisions/{id}/events/import`, a stream with such a summary | imported | that stream's result is `rejected`, `error.engineCode` `"SET_SCORE_UNREACHABLE"`, nothing written for its fixture |
| Both write paths, a summary whose score before its last game was already a finished set (`7–0`, `8–0`, `9–3`), in any set including an advantage set | refused, `"INVALID_EVENT"` | refused, `"SET_SCORE_UNREACHABLE"`: the same refusal under the new code |

The legal scores are the ITF's (Rules 6 and 7, Appendix VI): with the tie-break
at 6-all, 6–0 to 6–4 and 7–5 in plain games, and 7–6 only with its tie-break;
in a Fast4 set, 4–0 to 4–2, and 4–3 only with its tie-break. An advantage set
(no tie-break) takes exactly the scores it took before; the ones it refused it
still refuses, now with `SET_SCORE_UNREACHABLE` (the last row above). A summary
that is not a finished set at all (6–5) is refused as before, with
`INVALID_EVENT`.

**What replaces it.** Send the score that was played. A set that went to the
tie-break is sent as 7–6 (or 4–3) with its `tb` points.

**What a consumer sees.**

```json
{ "ok": false, "error": { "code": "SET_SCORE_UNREACHABLE", "message": "set score 8–6 cannot happen in this set: …" }, "requestId": "…" }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. A summary
recorded before this change still replays exactly as recorded, so a finished
match keeps its result.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e (sport fidelity), decision D8, rule TN-SS-1 (SC-S1). The
engine's pinning test is `packages/engine/src/sports/nested/w2e-tennis.test.ts`.

## 2026-10-28 — a match-ending sanction must be followed by its ending

A badminton disqualification (black card) and a tennis default now end the
match. The ending is its own event, recorded right after the sanction, and the
two strict write paths take no other scoring event until it is there.

**What changed.** After a live sanction at a level the sport declares as
match-ending (`badminton.sanction` with `level: "disqualification"`,
`tennis.sanction` with `level: "default"`), with no `core.forfeit` or
`core.abandon` after it:

| Write path | Before | Now |
|---|---|---|
| `POST /api/v1/fixtures/{id}/events`, any event other than `core.forfeit` or `core.abandon` (a rally, a point, another sanction, a note) | accepted | 422, `error.code` `"ENDING_SANCTION_PENDING"`, nothing written |
| `POST /api/v1/divisions/{id}/events/import`, a stream with such an event after the sanction | imported | that stream's result is `rejected`, `error.engineCode` `"ENDING_SANCTION_PENDING"`, nothing written for its fixture |
| `POST /api/v1/fixtures/{id}/events`, the ending (`core.forfeit` against the sanctioned side, `reason: "disqualified"`) sent with a device link or an official scorer's session, as the event right after the sanction | 403, `error.code` `"FORBIDDEN"` (a forfeit was organiser-only) | 201 |

Every other sanction level, and every other sport, is unchanged. A volleyball
disqualification or expulsion does not end the match by itself, and nothing is
refused after one; a scorer may send the incomplete-team ending right after it
(`core.forfeit` against that team with `reason: "retired"`, 201 where it was
403).

**What replaces it.** Send the ending: `core.forfeit` with `by` set to the
sanctioned entrant and `reason: "disqualified"`. Or void the sanction
(`core.void`), which lifts the refusal. Voiding the forfeit makes the ending
pending again; voiding the sanction while its forfeit stands leaves the match
ended.

A scorer credential (a device link, or the session of an official scorer) may
send the ending itself, but only as the event right after the sanction: the
fixture's last live event (voided events and voids do not count) must be that
sanction, against the same side, and the reason must be the one its level calls
for. It is judged on the ledger up to the request's `expected_seq`. Any other
`core.forfeit` from a scorer is still 403 `"FORBIDDEN"`: against the other side,
with another reason, after the sanction was voided, or with another event in
between. A ledger written before this change with an event after the sanction
(a rally, a `core.suspend`) therefore takes its ending or an abandon from an
organiser. Voiding that event (which an official scorer may also do) makes the
sanction the last live event again.

**What a consumer sees.** A rally sent after a black card with no ending:

```json
{ "ok": false, "error": { "code": "ENDING_SANCTION_PENDING", "message": "event \"badminton.rally\" rejected: a disqualification sanction against … ends the match — record the ending (core.forfeit) or void the sanction first" }, "requestId": "…" }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. A ledger
written before this change with play after a black card or a default still
replays exactly as recorded, so a finished match keeps its result. A match in
progress at the change, with such a sanction and no ending, takes the ending
(or a void of the sanction) next; its next rally is refused.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e (sport fidelity), decisions D3 (1) and D13, rules X-SE-1
and X-SE-3. The engine's pinning test is
`packages/engine/src/core/sanction-ending.test.ts`; the route's is
`apps/web/src/server/engine-db/__tests__/w2e-ending-sanction.test.ts`.

## 2026-10-28 — a generic division's config no longer carries `progressScore`

The generic sport (the fallback for a sport Seazn does not model) had a
`progressScore` key in its division `config`, a flag carried over from the v1
stepladder import. Nothing ever read it: it changed no score, no standing and
no screen. It is removed.

**What changed.** `config.progressScore` is no longer part of a generic
division's config. A request that still sends it is not refused: the key is
dropped, and the rest of the config is read as before.

| Path | Before | Now |
|---|---|---|
| `POST /api/v1/competitions/{id}/divisions` and `PATCH /api/v1/divisions/{id}`, a generic division's `config` | `progressScore` was accepted (a boolean, default `false`) and stored | accepted and dropped: 200 as before, and the stored `config` has no `progressScore` |
| `GET /api/v1/divisions/{id}`, `config` | `progressScore: false` (or `true`) present | absent once the stored copy is removed (see below) |

**What replaces it.** Nothing: the key did nothing. Stop sending it, and stop
reading it.

**What a consumer sees.** No error. A client that sends the old default
(`"progressScore": false`) keeps working unchanged. A client that reads
`config.progressScore` gets `undefined` where it used to get a boolean.

**Data.** The release's migration, which runs before the deploy, removes
every stored copy: from the division's config, a stage's rules, a match's own
format, a match's frozen snapshot and its cached state. Until it has run, a
stored copy is still there and still ignored. The generic sport's fold epoch is raised from 3 to 4
(every recorded match state embeds its config), so the server's epoch gate
refuses a native scoring client that still sends epoch 3 for a generic fixture
until it updates.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, decision D6. The pinning test is
`packages/engine/src/sports/generic/w2e-generic.test.ts`.

## 2026-10-28 — a carrom adjustment may not exceed the game target

A carrom umpire adjustment (Laws 51 and 55: a penalty, or points due) moves one
side's score in the open game by a few points. The scorer's app already offers
1 up to the game target (25 in the ICF Laws, Law 56a, and 29 in the club-29
variant) in either direction; the API did not check. Both scoring write paths
now do.

**What changed.** A `carrom.game.adjust` was accepted with any non-zero integer
`delta`. It is now refused when `delta` is more than `gameTo` points either
way (`gameTo` is the match's game target: 25 by default, 29 for club-29, or the
match's own setting). A `delta` of `0` or a fraction was already refused as
`INVALID_EVENT` and still is. A deduction that would take the score below zero
was already refused as `INVALID_EVENT` and still is; the range is judged
first.

| Path | Before | Now |
|---|---|---|
| `POST /api/v1/fixtures/{id}/events` | accepted, and the open game's score moved by the whole delta | 422, `error.code` `"ADJUST_OUT_OF_RANGE"`, nothing written |
| `POST /api/v1/divisions/{id}/events/import` | imported | 200; that stream is rejected with `"import.fold_rejected"`, `engineCode` `"ADJUST_OUT_OF_RANGE"`, and nothing is written for its fixture |

**What replaces it.** Send a `delta` between `-gameTo` and `gameTo`, not zero.
To move a score further than that, send more than one adjustment, each one
inside the range.

**What a consumer sees.** On the scoring endpoint:

```json
{ "ok": false, "error": { "code": "ADJUST_OUT_OF_RANGE", "message": "an adjustment moves a score by at most the points needed to win the game" }, "requestId": "…" }
```

On the import route, the stream's result (this refusal carries no
`eventIndex`; the other streams in the call are judged on their own):

```json
{ "fixture": "…", "status": "rejected", "eventsAppended": 0, "error": { "code": "import.fold_rejected", "engineCode": "ADJUST_OUT_OF_RANGE" } }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. No recorded
adjustment in the golden corpus (13 across 23 streams) is above 1 point, and an
adjustment already in a match's ledger still replays to the score it recorded.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, rule CA-AD-1 (audit row SC-O9). The pinning test is
`packages/engine/src/sports/carrom/w2e-carrom.test.ts`.

## 2026-10-28 — a board-game result's method must agree with its winner

A chess game is won by checkmate, resignation, time or a second illegal move,
and drawn by agreement, stalemate, insufficient material, repetition, the
fifty-move rule or a dead position (FIDE Laws of Chess Articles 5.1, 5.2 and
9.2 to 9.6). A result that says "won by stalemate" or "drawn by checkmate" cannot
have happened. Both scoring write paths now refuse one.

**What changed.** A `boardgame.result` was accepted with any `method` beside
any `winner`. It is now refused when its `method` is one only a decisive game
ends by (`checkmate`, `resign`, `time`, `illegal_move`) and `winner` is `null`
or left out, or one only a drawn game ends by (`agreement`, `stalemate`,
`insufficient`, `repetition`, `fifty_move`, `dead_position`) and `winner` names
an entrant. `adjudication` can go either way and is accepted in both shapes, and
a result with no `method` has nothing to contradict. `forfeit` and
`double_forfeit` were already refused on write (a chess forfeit is a
`core.forfeit` with a reason, W2b).

| Path | Before | Now |
|---|---|---|
| `POST /api/v1/fixtures/{id}/events` | accepted, and the game recorded the winner or the draw as sent | 422, `error.code` `"RESULT_METHOD_CONTRADICTS_WINNER"`, nothing written |
| `POST /api/v1/divisions/{id}/events/import` | imported | 200; that stream is rejected with `"import.fold_rejected"`, `engineCode` `"RESULT_METHOD_CONTRADICTS_WINNER"`, and nothing is written for its fixture |

**What replaces it.** Send a `method` that fits the result: a decisive one with
the winner's entrant id, a drawing one with `winner` `null` (or left out), or
no `method` at all.

**What a consumer sees.** On the scoring endpoint:

```json
{ "ok": false, "error": { "code": "RESULT_METHOD_CONTRADICTS_WINNER", "message": "the method does not fit the result: a win needs checkmate, resignation, time, illegal move or adjudication, and a draw needs a drawing method" }, "requestId": "…" }
```

On the import route, the stream's result (this refusal carries no
`eventIndex`; the other streams in the call are judged on their own):

```json
{ "fixture": "…", "status": "rejected", "eventsAppended": 0, "error": { "code": "import.fold_rejected", "engineCode": "RESULT_METHOD_CONTRADICTS_WINNER" } }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. No recorded
result in the golden corpus (76 across 85 streams) contradicts, and a result
already in a match's ledger still replays to the outcome it recorded.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, rule BG-RS-1 (rulebook RB2B-20). The pinning test is
`packages/engine/src/sports/boardgame/w2e-boardgame.test.ts`.

## 2026-10-28 — a cricket chase total may not pass the winning run

A chase ends at the winning run, and a boundary counts in full (ICC Playing
Conditions 16.5.1 and 16.5.3, MCC Law 16.5). From one run short, the last
delivery can add at most 7 runs: a no-ball hit for six. So a chase total above
the target minus 1 plus 7 cannot have happened. Both scoring write paths now
refuse one.

**What changed.** A `cricket.innings.summary` for the chasing innings was
accepted with any `payload.runs` and is now refused when `runs` is above
target − 1 + 7. The chasing innings is the second innings of a one-innings
match and the fourth of a two-innings match. The target is the other side's
total plus 1, or the revised target once a `cricket.revise` (DLS or a
confirmed target) has set one. In a two-innings match it is the other side's
aggregate lead plus 1. Earlier innings have no bound, and ball-by-ball
scoring (`cricket.ball`) is unchanged.

| Path | Before | Now |
|---|---|---|
| `POST /api/v1/fixtures/{id}/events` | accepted, and the chase recorded the total | 422, `error.code` `"CHASE_OVERSHOOT"`, nothing written |
| `POST /api/v1/divisions/{id}/events/import` | imported | 200; that stream is rejected with `"import.fold_rejected"`, `engineCode` `"CHASE_OVERSHOOT"`, and nothing is written for its fixture |

**What replaces it.** Send the total the chase ended on. It is at most the
target minus 1 plus 7.

**What a consumer sees.** On the scoring endpoint:

```json
{ "ok": false, "error": { "code": "CHASE_OVERSHOOT", "message": "a chase ends at the winning run — check the total" }, "requestId": "…" }
```

On the import route, the stream's result (this refusal carries no
`eventIndex`; the other streams in the call are judged on their own):

```json
{ "fixture": "…", "status": "rejected", "eventsAppended": 0, "error": { "code": "import.fold_rejected", "engineCode": "CHASE_OVERSHOOT" } }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. A chase total
already in a match's ledger still replays to the result it recorded, and a
void of it is accepted.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2e, rule CK-CH-1 (rulebook RB2A-22, SC-C4). The pinning
test is `packages/engine/src/sports/cricket/w2e-cricket.test.ts`.

## 2026-10-28 — the standings export refuses a table with no results

The standings export used to print the newest stage's stored table, even one
with no rows or one where no result had counted yet. That printed the seed
list as a ranking, with seed 1 shown first. The export now refuses such a
table with its own error code.

**What changed.** `GET /api/v1/divisions/{id}/exports/standings` (PDF and
XLSX):

| Case | Before | Now |
|---|---|---|
| No stored table | 404, `error.code` `"NOT_FOUND"` | 404, `error.code` `"STANDINGS_NOT_AVAILABLE"` |
| Every stored table is empty, or no result has counted in it yet (every row level) | 200, a document with no rows, or with the seed order printed as ranks | 404, `error.code` `"STANDINGS_NOT_AVAILABLE"` |
| The newest stage's table is empty or has no counted result, and an earlier stage's table has results | 200, the newest stage's table | 200, the newest stage table that has results |

The other export kinds are unchanged.

The same date also fixes the standings export for chess and other
half-point tables. The `Pts` cell now prints what the public table prints
(`"1½"`), not the stored half-point count (`3`). In the XLSX it is a text
cell. Whole-point sports keep a numeric `Pts` cell.

**What replaces it.** Key on the 404 status, or on `error.code`
`"STANDINGS_NOT_AVAILABLE"`. Do not key on `"NOT_FOUND"`.

**What a consumer sees.** A division with no standings to print returns:

```json
{ "ok": false, "error": { "code": "STANDINGS_NOT_AVAILABLE", "message": "no standings yet" }, "requestId": "…" }
```

Key on `error.code`, not on the message text.

**No data migration was required.** The export reads the stored tables as
they are.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2d (tables and tie-breaks), anti-goal 3 (no row is marked
first on a table with no results) and RB2B-17 (points print in the table's
unit on every surface). The pinning tests are in
`apps/web/src/server/usecases/__tests__/generate-level-table.test.ts`.

## 2026-10-28 — an imported hockey goal must record its type

This extends the 2026-10-27 change below to the bulk import route.

**What changed.** `POST /api/v1/divisions/{id}/events/import` judges every
event in a stream as a new write. A stream that carries a `hockey.goal`
(FIH hockey, every variant) with no `payload.kind` was imported and is now
rejected. Ice hockey and every other sport are unchanged.

**What replaces it.** Send each goal's `kind`, as for
`POST /api/v1/fixtures/{id}/events`. A client that has no way to know the
goal's type should send `"fg"`.

**What a consumer sees.** The call still returns 200, because each stream's
outcome is data. The stream's result is rejected and nothing is written for
that fixture:

```json
{ "fixture": "…", "status": "rejected", "eventsAppended": 0, "error": { "code": "import.fold_rejected", "engineCode": "GOAL_KIND_REQUIRED" } }
```

This refusal carries no `eventIndex`. The other streams in the same call are
judged on their own.

**No data migration was required.** An import only writes to fixtures with no
events yet.

**Why in place.** No client outside the web app uses the API yet (owner,
2026-10-27).

**Background.** W2d (tables and tie-breaks), rule HK-TB-2. The pinning test is
`apps/web/src/server/usecases/__tests__/event-import-dryrun.test.ts`.

## 2026-10-27 — a hockey goal must record its type

FIH ranks level teams on field goals (GTR Appendix 3), so a hockey table can
only break that tie if every goal says what kind it was. The scoring endpoint
now refuses a `hockey.goal` that does not.

**What changed.** `POST /api/v1/fixtures/{id}/events` with `type:
"hockey.goal"` (FIH hockey, every variant) and no `payload.kind` was accepted
and is now refused. Ice hockey's `icehockey.goal` and every other sport's goal
are unchanged: their type stays optional.

| Field | Before | Now |
|---|---|---|
| `payload.kind` on `hockey.goal` — `POST /api/v1/fixtures/{id}/events` | optional | required: one of the division's `goalKinds`, by default `"fg"` (field goal), `"pc"` (penalty corner), `"stroke"` (penalty stroke), `"og"` (own goal, credited to the other side) |

**What replaces it.** Send the goal's `kind`. A client that has no way to know
the goal's type should send `"fg"`, which is what an untyped goal was always
counted as.

**What a consumer sees.** An untyped hockey goal now fails with a 422 and
nothing is written:

```json
{ "ok": false, "error": { "code": "GOAL_KIND_REQUIRED", "message": "a goal in this sport must record its type" }, "requestId": "…" }
```

Key on `error.code`, not on the message text.

**No data migration was required.** Only a NEW write is judged. Untyped goals
already in a match's ledger still replay, and count as field goals, so a match
in progress at the change stays readable. A void of such a goal is accepted.
The pinning test is
`apps/web/src/server/engine-db/__tests__/legacy-untyped-hockey-goal.test.ts`.

**Why in place.** This lands in v1 rather than under a new version path
because no client outside the web app uses the API yet (owner, 2026-10-27).

**Background.** W2d (tables and tie-breaks), rule HK-TB-2;
`docs/superpowers/specs/2026-09-27-format-matrix-prompts/`.

## 2026-08-17 — the z3 solver leaves the contract

The scheduling stack finished moving onto the CP-SAT placement service. The
solver identifiers that named the old engine are now removed from the wire.

**Removed values.** Three enum members are no longer accepted as input and are
no longer emitted in responses:

| Field | Removed | Replacement |
|---|---|---|
| `solver.engine` — `POST /api/v1/stages/{id}/schedule/auto` | `"z3"`, `"z3+lns"` | `"optimized"` |
| `solver.status` — same endpoint | `"z3_unavailable"` | `"solver_unavailable"` |
| `repair.engine` — `POST /api/v1/divisions/{id}/schedule/ai-plan` and the competition-level equivalent | `"z3"` | `"optimized"` |

**What a consumer sees.** Sending one of the removed values now fails schema
validation at the API boundary with a 422, rather than being accepted. Reading
is unaffected in practice: nothing has emitted any of the three since the
CP-SAT cutover, so no response a live consumer has actually received changes
shape.

**Why the replacements are drop-in.** `"optimized"` and `"solver_unavailable"`
already render through byte-identical user-facing copy in all four locales.
The labels were unified before this removal precisely so that retiring the
older names would be invisible to anyone reading the board rather than the
JSON. `"solver_unavailable"` was added as a distinct identifier rather than a
rename for the same reason — see `BuildStatus` in
`packages/engine/src/scheduling/build.ts`.

**No data migration was required.** These values are response-only telemetry;
no database column, constraint or stored document holds them. That was
verified rather than assumed — the evidence is recorded in the C7 entry of
`docs/superpowers/specs/2026-08-12-release2-prompts/_INDEX.md`.

**Background.** `docs/superpowers/specs/2026-08-12-z3-retirement-design.md`,
stage D. The solver implementation itself is removed in stage E.
