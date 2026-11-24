"use client";
// Seazn-hosted video Task 31b (T26 review m8): a fixture's Seazn replays on the organiser fixture page, ON THEIR OWN — for an
// organiser the Stream panel is not mounted for (the org lost the plan, or is billing-frozen; lib/fixture-stream-mount.ts
// `offersStandaloneReplays`). The same card as the panel's (SeaznReplaysCard: Download on a playable part, Delete on every part, the
// same confirm and the same routes, which ask an editor's session and nothing of the plan or the freeze), framed as a page card. The
// list is the page's own read (server/video/organiser-replays.ts `fixtureSeaznReplays`); after a delete the page is read again.
//
// Task 33d: an organiser on a plan that lost the panel keeps both actions, but a member whose SEAT is paused (the plan's member limit,
// `memberFrozen`, the page's one read) is refused both by the routes' write scope — so the card offers neither and says why.
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { SeaznReplaysCard, useSeaznReplayActions } from "@/components/v2/seazn-replays-card";
import type { StreamSessionCurrent } from "@/server/api-v1/schemas";

/** One part as the panel's card reads it (the session view's shape, which `fixtureSeaznReplays` answers). */
type Replay = StreamSessionCurrent["seaznReplays"][number];

export function FixtureReplaysSection({
  fixtureId,
  replays,
  memberFrozen,
}: {
  fixtureId: string;
  replays: readonly Replay[];
  /** Task 33d: this member's seat is paused by the plan's member limit (entitlement-freeze.ts `frozenMemberIds`). */
  memberFrozen: boolean;
}) {
  const router = useRouter();
  const reread = useCallback(async () => router.refresh(), [router]);
  const actions = useSeaznReplayActions(fixtureId, reread);
  return (
    <div className="mt-4 min-w-0" data-role="fixture-replays">
      <SeaznReplaysCard fixtureId={fixtureId} replays={replays} actions={actions} frame="page" memberFrozen={memberFrozen} />
    </div>
  );
}
