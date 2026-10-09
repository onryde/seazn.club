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

It also pins one id fact for the presence check: in a session-participant
row, `id` is the per-connection id and `user_id` is the persistent
participant id that the add-participant call returns (here `user_id` equals
the driver's `self.userId`; the peer id the report was fetched by is the
driver's `self.id`, a third value).

Do not edit the copy. Re-record from a new spike instead, and update both
files together.
