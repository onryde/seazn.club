"use client";
// M1 k2 — the line under the fixture title, live.
//
// It used to be a plain server-rendered `<p>` in page.tsx, composed from the
// fixture row once per request. The live rain-delay test found the result: the
// court card below refetched its document and showed the new kick-off at
// 895 ms, while this line kept the old one until the reader reloaded. One
// page, two times (rule R10: live pages update without a reload).
//
// It now renders from the SAME snapshot `MatchCentre` is rendering — that
// component publishes each one to `live-fixture-channel`, and this subscribes
// (see that module for why a channel rather than a second `useLiveFixture` or
// a lifted hook). Everything the line needs is on the document:
// `startTime` (already formatted by the builder's `startTimeText`, the very
// string the court card's "Starts …" sentence renders, in the venue's
// timezone), `venueName` and `courtName`.
//
// FIRST PAINT IS UNCHANGED. `initial` is the same document the page already
// had in hand, `useLiveFixtureSnapshot` returns null on the server and on the
// hydration pass, and the fallback is `initial` — so the server HTML, the
// hydrated render and the pre-publish client render are the same three facts
// in the same order. No flash, no mismatch.
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { LiveFixtureData } from "@/components/public-site/live-score-data";
import { useLiveFixtureSnapshot } from "@/components/public-site/match-centre/live-fixture-channel";
import { fixtureSubheadingLine } from "./fixture-subheading";

export interface MatchCentreSubheadingProps {
  fixtureId: string;
  /** The page's own server-rendered snapshot — the seed for first paint and
   *  the fallback whenever nothing has been published (SSR, hydration, and
   *  after `MatchCentre` unmounts). */
  initial: LiveFixtureData;
  dict: PublicDict;
}

export function MatchCentreSubheading({ fixtureId, initial, dict }: MatchCentreSubheadingProps) {
  const live = useLiveFixtureSnapshot(fixtureId) ?? initial;
  const line = fixtureSubheadingLine(live.match_centre, live.status, {
    timeTbd: t(dict, "matchCentre.status.timeTbd"),
    timeNotRecorded: t(dict, "matchCentre.status.timeNotRecorded"),
  });
  // Null, not an empty paragraph: a fixture with neither a time nor a venue
  // gets no line at all rather than a 20px gap under the title.
  return line === null ? null : (
    <p data-testid="mc-subheading" className="mb-4 text-sm text-ink-muted">
      {line}
    </p>
  );
}
