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
