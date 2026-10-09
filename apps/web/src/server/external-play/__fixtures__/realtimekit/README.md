# RealtimeKit fixtures

`peer-report-recorded.json` is a byte-identical copy of
`docs/superpowers/specs/evidence/2026-10-09-chess-spikes/peer-report-recorded.json`
(committed in c1f8e9ff2). It is a real
`GET /accounts/{account}/realtime/kit/{app}/sessions/peer-report/{peer_id}`
response, recorded on 2026-10-09 at 18:15Z after the owner-approved peer-report
lag spike. Its `_provenance` key lists what was redacted (network, device and
browser metadata; each `video_producer` sample keeps only the listed fields).

The ground truth for what it SHOULD show comes from the spike's driver log,
`docs/superpowers/specs/evidence/2026-10-09-chess-spikes/rtk-peer-report.log`,
never from the parser under test:

- camera ON 18:05:14, OFF 18:09:14.609, ON 18:12:14.621, left 18:14:14.638
  (driver timeline);
- one 189 s gap in `video_producer` samples, 18:09:11 → 18:12:20, with no
  samples inside it (the log's FINAL poll);
- `video_producer_cumulative.issues.no_video_fraction` = 0 despite three
  minutes off — which is why the parser never reads it.

It also pins the id spaces, MEASURED on the spike's ended session (the
controller's follow-up probe at the end of `rtk-peer-report.log`, commit
7dde4a246, `GET /sessions/{sid}/participants?include_peer_events=true`):

- `id` (here `ca9beb6c…`, the same as this report's `participant.id`) is the
  session participant id. It is NOT a peer id, despite the OpenAPI wording
  "maps to the corresponding peerId".
- `user_id` (`aaae7f73…`) is the add-participant id and the client's
  `self.userId`. The presence check matches on it.
- `peer_events[].peer_id` (`c4736b31…`, the client's `self.id`) is the only
  place the PEER id appears. The peer report is fetched by that id, and
  `listPeerIds` reads it.

Do not edit the copy. Re-record from a new spike instead, and update both
files together.
