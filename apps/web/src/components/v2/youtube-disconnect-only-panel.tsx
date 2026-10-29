"use client";
// The Streaming page of an org that can no longer go live but still holds a YouTube connection (T18; Google API Services User Data
// Policy, DP III): downgraded, or on a deployment with no relay. It offers ONE thing - Disconnect - on each connected channel, so a
// plan change never strands a grant the organiser wants revoked. No Connect, no Settings, no Reconnect, no pasted keys (they are not
// even read: `listStreamTargets(..., { channelsOnly })`), and no "matches can go live" sentence on a row (the note above says they can't).
//
// A disconnected channel leaves the list HERE, from local state, and the page is not refreshed: the server would answer a re-read
// after the last disconnect with the 404 an org with nothing to disconnect gets, and the person is looking at the confirmation. The
// LAST one is the exception that proves it: the page's own nav is part of what the server renders, and would go on offering a link to
// a page that now 404s, so it asks the server for the page again at `STREAMING_DISCONNECTED_HREF` - the one address that renders the
// emptied page instead of the 404 (the notice and the list are this component's state, which that re-render keeps). A reload of the
// bare address, or the next navigation, is the 404.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMsg } from "@/components/i18n/dict-provider";
import { STREAMING_DISCONNECTED_HREF } from "@/lib/youtube";
import type { StreamTarget } from "@/server/api-v1/schemas";
import { YoutubeChannelRow, YoutubeDisconnectedNotice, type DisconnectNews } from "./youtube-connect-panel";

export function YoutubeDisconnectOnlyPanel({ orgId, targets }: { orgId: string; targets: StreamTarget[] }) {
  const msg = useMsg();
  const router = useRouter();
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [disconnected, setDisconnected] = useState<DisconnectNews | null>(null);
  const channels = targets.filter((t) => t.youtube !== null && !gone.has(t.id));

  // A channel leaves the list; the last one to leave takes the page's nav with it (see the header).
  const leave = (id: string) => {
    setGone((g) => new Set(g).add(id));
    if (channels.every((c) => c.id === id)) router.replace(STREAMING_DISCONNECTED_HREF);
  };

  return (
    <div data-testid="stream-disconnect-only" className="space-y-4">
      <p data-testid="stream-disconnect-only-note" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        {msg("streaming.youtube.disconnectOnly.note")}
      </p>
      {disconnected !== null && <YoutubeDisconnectedNotice name={disconnected.name} outcome={disconnected.outcome} onDismiss={() => setDisconnected(null)} />}
      {channels.length > 0 ? (
        <div className="card overflow-visible">
          <ul data-testid="youtube-channel-list" className="divide-y divide-slate-100" aria-label={msg("streaming.youtube.channels")}>
            {channels.map((t) => (
              <YoutubeChannelRow
                key={t.id}
                t={t}
                canEdit
                orgId={orgId}
                badge={null}
                disconnectOnly
                refreshAfter={false}
                onDisconnected={(news) => {
                  leave(t.id);
                  setDisconnected(news);
                }}
                onGone={() => leave(t.id)}
              />
            ))}
          </ul>
        </div>
      ) : (
        <p data-testid="stream-disconnect-only-empty" className="text-sm text-slate-600">{msg("streaming.youtube.disconnectOnly.none")}</p>
      )}
    </div>
  );
}
