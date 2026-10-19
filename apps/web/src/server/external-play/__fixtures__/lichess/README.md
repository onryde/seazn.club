# Lichess fixtures

`export-mate-white.json` and `export-started.json` are real, trimmed
`GET /game/export/<id>` responses recorded from lichess.org on 2026-09-16
(`Accept: application/json`, `pgnInJson=false&clocks=false`, GET only — no
challenge was created or otherwise written to lichess.org), kept down to
`id, rated, status, winner (if present), players.white.user.{id,name},
players.black.user.{id,name}`:

- `export-mate-white.json` — a finished, White-wins-by-checkmate blitz game,
  source id `MRLIhQuS`.
- `export-started.json` — a genuinely in-progress bullet game at capture
  time, source id `VEKTyEh4` (no `winner` key — Lichess omits it entirely
  while a game is unresolved, rather than sending `null`).

`export-created.json` is hand-written: producing a real `status: "created"`
export requires actually creating a public open challenge on lichess.org,
which this recording pass deliberately avoided (GETs only). Its exact shape
is to be confirmed against a real response in Task 16.

(The flat-`userId` `game-*.json` fixtures that used to sit beside these
were read only by the V404-era sync suite; Task 11 removed both with the
webhook they served — reconcile reads the board stream, below.)

`export-live-clocks.json` is the FULL, untrimmed `GET /game/export/<id>`
response recorded from lichess.org on 2026-10-09 while a draw offer stood
(`spike-battery2.log` §E, source id `QbFCQzuF`). It is the contract check for
two measured facts:

- **M11** — the export carries authoritative clocks: `"clocks":[60000,60000]`
  in CENTISECONDS beside `"clock":{initial,increment,totalTime}` in seconds.
  `initial: 600` against `clocks: 60000` is what pins the ×10, and it is why
  `exportGame` corrects our locally-derived clocks instead of letting them
  drift to the flag.
- **M10** — a PENDING draw offer is invisible here. There is no draw-offer
  field anywhere in this body and `status` is still `started`. This is the
  design's one accepted blind spot (§4): an offer made on lichess.org cannot
  be seen; an offer made on our page is fine, because our server sends it.

It is untrimmed on purpose — a trimmed copy could not witness M10, since the
claim is about a field that is ABSENT.

**Provenance, and what this body cannot tell you.** It is the single line the
spike logged at `10:28:58Z`, copied byte-for-byte (a `cmp` against that line of
`docs/superpowers/specs/evidence/2026-10-09-chess-spikes/spike-battery2.log`
is the check), not re-typed and not pretty-printed. The request that produced
it was `GET https://lichess.org/game/export/QbFCQzuF?moves=false` with
`Accept: application/json` and no `Authorization` header; `clocks` was left at
its default (`true`). It was made after `e2e4`, `e7e5` and White's draw offer.
Three consequences:

- **No `moves` field, although two plies were played** (`opening.ply: 2`) —
  the request said `moves=false`. `exportGame` reads that absence as
  `movesSan: []`; it is NOT evidence that a started game exports no moves.
- **`clocks` is one entry PER PLY, not one per side.** Two entries here
  because two plies were played. lila builds it as
  `interleave(history(firstMover), history(other))` — `bothClockStates` in
  `modules/core/src/main/game/data.scala`, read at lichess-org/lila
  `7b53d2671` on 2026-10-09 (source, not a measurement). This body alone
  cannot tell the two readings apart; the multi-ply case in
  `board-api.test.ts` is the one that can, and it is labelled synthetic.
- **An export of a game still in play lags the board.** For a requester
  that is not on lila's trusted list (our server's export is
  unauthenticated), `applyDelay` drops the last 3 plies from BOTH `moves` and
  `clocks` once the game is past 5 plies (`delayMovesBy = 3`,
  `delayKeepsFirstMoves = 5` in `modules/game/src/main/PgnDump.scala`;
  `delayMoves = !trusted` in `app/controllers/Game.scala`) — read from source
  at the same commit, not measured. At two plies nothing was withheld here.

## `openapi-GameStatusName.yaml` — the status list, recorded from source

A byte-identical copy of `doc/specs/schemas/GameStatusName.yaml` from
lichess-org/api, fetched 2026-10-09 at repo HEAD `906d1a6e9` (the file was
last changed in `59ebacb31`, 2025-08-12). It is NOT a measurement: it is the
published schema for the `status` field of a game export. Its 14 names match
the 14 cases of `enum Status` in scalachess
`core/src/main/scala/Status.scala` at `2ab0a403d`, read the same day.

`board-api.test.ts` parses this file for the expected list of statuses, so the
completeness test never reads its answer out of `LICHESS_STATUSES` (the code
under test). To refresh it, fetch the file again, replace this copy whole, and
let the length pin and the exact-match test tell you what changed.

## `gamefull-*.ndjson` and `export-{mid,expired}.json` — the reconcile read, recorded

Recorded 2026-10-11 by the controller with the two programme test accounts
(scratchpad script `t11-record.sh`; no token is in any file), for Task 11 —
spec §3.5 as amended in 5903962d4: the reconcile read is the Board API
stream's FIRST line (`GET /api/board/game/stream/{id}`, a player's token,
`gameFull`), and the export is a fallback for a terminal status only.

**Sanitised:** the two player ids/names are replaced by `rec-white` and
`rec-black`, and the game id by `Rc11Game` (the real id would lead to the
accounts). Every other byte is as recorded; the `.ndjson` files keep the
stream's trailing newline. Tests that seed their own players substitute the
ids, never a game fact (moves, clocks, status, winner).

The timeline (record.log, game ids sanitised), one 3+0 game, unrated:

    10:09:29Z game created 3+0
    10:09:31Z…10:09:40Z plies 1-8 (e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6), each http=200
    10:09:49Z MID stream(white): status=started plies=8 wtime=175220 btime=176380
    10:09:49Z MID stream(black): status=started plies=8 wtime=175190 btime=176380
    10:09:49Z MID export:        status=started plies=5 wtime=None  btime=None
    10:09:49Z waiting for white's clock to expire (no reads meanwhile)
    10:13:17Z EXPIRED read 1 (stream, black token): status=started   plies=8 wtime=0
    10:13:20Z EXPIRED read 2 (stream, +3s):         status=outoftime winner=black
    10:13:20Z EXPIRED export:                       status=outoftime winner=black plies=8
    10:13:26Z EXPIRED read 3 (stream, after export): status=outoftime winner=black

- `gamefull-mid-white.ndjson` / `gamefull-mid-black.ndjson` — the stream's
  first line after 8 plies, through each player's token. Exact (8 plies, both
  clocks in ms).
- `export-mid.json` — the export at the SAME instant: 5 plies and 5 clock
  entries. **It lags the stream by 3 plies** (M16 re-measured), which is why
  a mid-game export must never move our state.
- `gamefull-expired-1.ndjson` — the first read ~3.5 min after the last move,
  White's 180 s long gone: `status: started`, `wtime: 0`. Lichess had NOT
  finalised the flag on its own (no read for ~3.5 min).
- `gamefull-expired-2.ndjson` — 3 s later: `outoftime`, `winner: black`.
  **A read settles the flag, visible on the NEXT read** — the measured ruling
  (T11 addendum 3) behind reconcile's single re-read after 3 s on a local
  clock zero.
- `export-expired.json` / `gamefull-expired-3.ndjson` — the export and a
  third stream read after it, both `outoftime`, the export now complete
  (8 plies).

## `challenge-list-{white,black}.json` — GET /api/challenge, recorded live

Recorded 2026-10-13 (08:42-08:49 UTC) by the T17 live probe with the two
programme test accounts (`t17-live-lichess.md` §1; no token is in any file).
White's token created a direct challenge exactly as `createChallengeToUser`
does (`clock.limit=600`, `clock.increment=0`, `rated=false`, `color=white`,
`variant=standard`); 2 s later each player read `GET /api/challenge`.

**Sanitised** as the T11 recordings are: the player ids/names are replaced by
`rec-white` / `rec-black`, the challenge id (and so the `url`) by `Rc17Chal`.
Every other byte is as recorded, including `perf.icon` (a private-use glyph).

What it pins:

- **There is no `createdAt`**, and no expiry field, on a listed challenge. A
  challenge cannot be bound to a time by its own body — recovery
  (`create-game.ts`) matches it on its fields, inside a window measured below.
- `timeControl.limit` / `.increment` are SECONDS; `challenger` and `destUser`
  are objects with lower-case `id`s; `direction` is `out` in White's `out[]`
  and `in` in Black's `in[]`, and the two entries are otherwise identical.
- **The listing is short-lived (measured, not in these files).** The
  unaccepted challenge was listed at +2 s and gone from `out[]` at +36 s;
  `GET /api/challenge/{id}/show` then said `status: "offline"`. A second
  challenge read `offline` at +32 s and was STILL ACCEPTED at +34 s (200
  `{"ok":true}`, the game started), and the first was cancelled after going
  offline (200 `{"ok":true}`). We never send `keepAliveStream`.

`lichess-fixture-contract.test.ts` holds the fixture server's challenge list to
these bodies key for key, and `board-api.test.ts` parses them through the real
reader.
