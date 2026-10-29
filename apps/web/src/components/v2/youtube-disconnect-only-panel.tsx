"use client";
// The Streaming page of an org that can no longer go live but still holds a YouTube connection (T18; Google API Services User Data
// Policy, DP III): downgraded, or on a deployment with no relay. It offers ONE thing - Disconnect - on each connected channel, so a
// plan change never strands a grant the organiser wants revoked. No Connect, no Settings, no Reconnect, no pasted keys (they are not
// even read: `listStreamTargets(..., { channelsOnly })`), and no "matches can go live" sentence on a row (the note above says they can't).
//
// A disconnected channel leaves the list HERE, from local state, and the page is not refreshed: the server would answer the last
// disconnect with the 404 an org with nothing to disconnect gets, and the person is looking at the confirmation. A reload or the next
// navigation asks the server again.
import { useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { StreamTarget } from "@/server/api-v1/schemas";
import { YoutubeChannelRow, YoutubeDisconnectedNotice } from "./youtube-connect-panel";

export function YoutubeDisconnectOnlyPanel({ orgId, targets }: { orgId: string; targets: StreamTarget[] }) {
  const msg = useMsg();
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [disconnected, setDisconnected] = useState<string | null>(null);
  const channels = targets.filter((t) => t.youtube !== null && !gone.has(t.id));

  return (
    <div data-testid="stream-disconnect-only" className="space-y-4">
      <p data-testid="stream-disconnect-only-note" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        {msg("streaming.youtube.disconnectOnly.note")}
      </p>
      {disconnected !== null && <YoutubeDisconnectedNotice name={disconnected} onDismiss={() => setDisconnected(null)} />}
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
                onDisconnected={(name) => {
                  setGone((g) => new Set(g).add(t.id));
                  setDisconnected(name);
                }}
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
