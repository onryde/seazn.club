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

The sibling `game-*.json` fixtures in this directory are a separate,
pre-existing flat-`userId` convention owned by other tests/tasks — not
touched here.

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
