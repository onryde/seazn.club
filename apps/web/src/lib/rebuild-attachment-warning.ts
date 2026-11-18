// The sentence a Rebuild confirm appends naming the organiser setup the redraw deletes with the fixtures. Moved verbatim from
// components/v2/stages-panel.tsx (W5 T23 fix round 2) so the stage card's Rebuild and the table waiting strip's Rebuild say the
// one sentence; stages-panel re-exports it under its old name.
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** StageRosterDrift.attachments — the per-kind counts of setup on the stage's fixtures. */
export interface RebuildAttachments {
  officials: number;
  lineups: number;
  deviceLinks: number;
  streams: number;
  youtubeBroadcasts: number;
  availability: number;
  calls: number;
}

/** The roster-drift shape the card passes (`StageRosterDrift`); only `attachments` is read. */
export interface RebuildDriftLike {
  ghosts?: readonly unknown[];
  unplaced?: readonly unknown[];
  vacantLines?: number;
  attachments?: RebuildAttachments;
}

/**
 * F3 ultrareview finding 5 — the sentence appended to the rebuild confirm
 * dialog naming the organiser SETUP the rebuild clears along with the
 * fixtures: referee appointments, team sheets, paired scoring devices. All
 * three CASCADE off `delete from fixtures` and none of them blocks the
 * rebuild (a result does; see rebuildStageFixtures' guard) — so without this
 * the dialog said "every fixture is deleted and regenerated" while silently
 * also dropping a Saturday's worth of appointments.
 *
 * Returns "" when there is nothing attached, so the common case adds no
 * boilerplate to click through — only non-zero pieces are listed. Joined
 * with `Intl.ListFormat` on the caller's own locale rather than a hardcoded
 * ", " and " and ": the conjunction and the separator differ per language,
 * and this repo's four dictionaries would otherwise need two more keys that
 * exist only to spell out punctuation. Exported (pure) for the same reason
 * rebuildBlockedMessage is: testable without a jsdom harness.
 */
export function attachmentWarning(drift: RebuildDriftLike | undefined, msg: Msg, locale: string): string {
  const a = drift?.attachments;
  if (!a) return "";
  const parts = [
    a.officials > 0 ? msg("progression.rosterDrift.alsoOfficials", { count: a.officials }) : null,
    a.lineups > 0 ? msg("progression.rosterDrift.alsoLineups", { count: a.lineups }) : null,
    a.deviceLinks > 0 ? msg("progression.rosterDrift.alsoDevices", { count: a.deviceLinks }) : null,
    // W4 B2 fix round 2 (item 5): the rest of the setup a match can carry before Start, each a cascade of the delete.
    a.streams > 0 ? msg("progression.rosterDrift.alsoStreams", { count: a.streams }) : null,
    a.youtubeBroadcasts > 0 ? msg("progression.rosterDrift.alsoBroadcasts", { count: a.youtubeBroadcasts }) : null,
    a.availability > 0 ? msg("progression.rosterDrift.alsoAvailability", { count: a.availability }) : null,
    a.calls > 0 ? msg("progression.rosterDrift.alsoCalls", { count: a.calls }) : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return "";
  const items = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
  const cleared = msg("progression.rosterDrift.alsoCleared", { items });
  // Owner ruling Q4 (2026-09-23): the cascade takes every printed QR on this
  // stage with it — say so in the one dialog that precedes it.
  return a.deviceLinks > 0 ? `${cleared} ${msg("progression.rosterDrift.sheetsStop")}` : cleared;
}
