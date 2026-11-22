"use client";
// Seazn-hosted video (Phase 1 Task 15; spec §5.1; recommendation 2026-11-21, G-B): the match page's Seazn player, in the `replay` slot of
// the court card where a YouTube replay would sit. The page is ISR (`revalidate = 30`), so a signed address minted in its server render
// would be served past its token's life; the island asks the video route itself, after hydration, and keeps asking:
//   - `live`: the live player, and no picker (recordings listed beside a live source do not play);
//   - no live, one or more `hls` parts (the interim Cloudflare recording, signed from the moment the session's recording is locked):
//     the parts in `partNo` order, ONE player at a time, with a picker ("Part {n}") only when there are two or more; the island keeps
//     looking every 30 s, so a second Go live (after half-time, or a failed run) turns the page to the new live player without a reload;
//   - nothing to show (not yet live, ended with no recording signed yet): nothing renders, and the island keeps looking, so a page
//     opened before kick-off turns to the live player without a reload.
// `embed` parts are the replay host's own player (Task 25) and have no rendering here yet.
//
// WHEN to ask again is the schedule's (seazn-video-schedule.ts), the loop's is seazn-video-poll.ts, and how an address reaches the
// element is seazn-playback.ts; this file is the wiring and the markup. `endpoint` picks the route: the public one (the match page) or
// the organiser's (Match Day's fixture panel, Task 17).
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { api } from "@/lib/client";
import { interpolate } from "@/lib/i18n-runtime";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { SeaznPlayer } from "./seazn-player";
import type { SeaznVideoLabels } from "./seazn-video-labels";
import { startVideoPoll, type VideoPoll } from "./seazn-video-poll";

export type SeaznVideoEndpoint = "public" | "org";

export function seaznVideoUrl(fixtureId: string, endpoint: SeaznVideoEndpoint): string {
  const id = encodeURIComponent(fixtureId);
  return endpoint === "public" ? `/api/v1/public/fixtures/${id}/video` : `/api/v1/fixtures/${id}/video`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSigned = (v: unknown): v is Record<string, unknown> & { src: string; expiresAt: string } =>
  isObject(v) && typeof v.src === "string" && v.src !== "" && typeof v.expiresAt === "string" && v.expiresAt !== "";

const isPart = (v: unknown): boolean =>
  isSigned(v) && Number.isInteger(v.partNo) && (v.partNo as number) >= 1 && (v.player === "hls" || v.player === "embed");

/** The route's answer, checked before the page trusts it (`PublicFixtureVideo` is the contract; the zod schema is server-side and not
 *  worth a client bundle, so this is its hand-written twin, held to it by the island's test). Throws on anything else, so the loop
 *  keeps what it had. */
export function asPublicFixtureVideo(raw: unknown): PublicFixtureVideo {
  if (!isObject(raw)) throw new Error("seazn video: the answer is not an object");
  const { live, replay } = raw;
  if (live !== null && !isSigned(live)) throw new Error("seazn video: bad live source");
  if (!Array.isArray(replay) || !replay.every(isPart)) throw new Error("seazn video: bad replay parts");
  return raw as unknown as PublicFixtureVideo;
}

/** One read of the route. Never from the browser's cache (the route says `no-store`, and a stale answer is a lapsed token). */
export async function fetchSeaznVideo(fixtureId: string, endpoint: SeaznVideoEndpoint, signal: AbortSignal): Promise<PublicFixtureVideo> {
  return asPublicFixtureVideo(await api<unknown>(seaznVideoUrl(fixtureId, endpoint), { cache: "no-store", signal }));
}

/** The tablist's arrow keys: where focus goes from `from` among `count` tabs, or null for a key that moves nothing. */
export function nextPartIndex(key: string, from: number, count: number): number | null {
  const last = count - 1;
  if (key === "ArrowRight") return from === last ? 0 : from + 1;
  if (key === "ArrowLeft") return from === 0 ? last : from - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  return null;
}

const REGION = "ph-no-capture mt-4 border-t border-white/10 pt-4";

/** A player's identity. A different part is a different recording; a different `epoch` is a player that gave up and is rebuilt by the
 *  next answer (the poll's `rebuild`), so it gets a fresh element and a fresh hls.js instance even when the address is unchanged. A
 *  token refresh changes neither, which is what keeps the picture running through one. */
export const playerKey = (part: number | "live", epoch: number): string => `${part}:${epoch}`;

interface StageProps {
  video: PublicFixtureVideo | null;
  /** How many times the players have been rebuilt after giving up. */
  epoch: number;
  labels: SeaznVideoLabels;
  /** A player gave up on its address: ask the route for a fresh one. */
  onFatal: () => void;
}

/** Everything the island draws for one answer. */
function SeaznVideoStage({ video, epoch, labels, onFatal }: StageProps) {
  if (video === null) return null;
  if (video.live !== null) {
    return (
      <section data-testid="seazn-video" aria-label={labels.live} className={REGION}>
        <SeaznPlayer key={playerKey("live", epoch)} src={video.live.src} title={labels.live} liveLabel={labels.live} unavailable={labels.unavailable} onFatal={onFatal} />
      </section>
    );
  }
  // Task 25 gives `embed` parts a rendering of their own; until then only the interim recording plays.
  const parts = video.replay.filter((p) => p.player === "hls").sort((a, b) => a.partNo - b.partNo);
  if (parts.length === 0) return null;
  return <ReplayParts parts={parts} epoch={epoch} labels={labels} onFatal={onFatal} />;
}

function ReplayParts({ parts, epoch, labels, onFatal }: { parts: PublicFixtureVideo["replay"]; epoch: number; labels: SeaznVideoLabels; onFatal: () => void }) {
  const base = useId();
  // The viewer's pick is a part NUMBER, which a later read keeps stable; a part that is gone from the list falls back to the first.
  const [picked, setPicked] = useState<number | null>(null);
  const active = parts.find((p) => p.partNo === picked) ?? parts[0]!;
  const multi = parts.length > 1;
  const tabId = (partNo: number) => `${base}-tab-${partNo}`;
  const panelId = `${base}-panel`;
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = nextPartIndex(e.key, i, parts.length);
    if (next === null) return;
    e.preventDefault();
    const to = parts[next]!;
    setPicked(to.partNo);
    document.getElementById(tabId(to.partNo))?.focus();
  };
  // Keyed by the part: a different part is a different recording, so it gets its own player, which starts at its own beginning.
  const player = (
    <SeaznPlayer
      key={playerKey(active.partNo, epoch)}
      src={active.src}
      title={multi ? interpolate(labels.part, { n: active.partNo }) : labels.replay}
      unavailable={labels.unavailable}
      onFatal={onFatal}
    />
  );
  return (
    <section data-testid="seazn-video" aria-label={labels.replay} className={REGION}>
      {multi ? (
        <>
          <div role="tablist" aria-label={labels.replay} className="mb-3 flex flex-wrap gap-2">
            {parts.map((p, i) => {
              const selected = p.partNo === active.partNo;
              return (
                <button
                  key={p.partNo}
                  type="button"
                  role="tab"
                  id={tabId(p.partNo)}
                  aria-selected={selected}
                  aria-controls={selected ? panelId : undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setPicked(p.partNo)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court-ink ${
                    selected ? "bg-accent text-accent-ink" : "border border-white/25 text-court-ink hover:bg-white/10"
                  }`}
                >
                  {interpolate(labels.part, { n: p.partNo })}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" id={panelId} aria-labelledby={tabId(active.partNo)}>
            {player}
          </div>
        </>
      ) : (
        player
      )}
    </section>
  );
}

export interface SeaznVideoIslandProps {
  fixtureId: string;
  /** `public` (default): the match page's route. `org`: the organiser's (Match Day, Task 17). */
  endpoint?: SeaznVideoEndpoint;
  labels: SeaznVideoLabels;
  /** An answer to show before the first read (the server markup of a test); the page passes none. */
  initial?: PublicFixtureVideo;
}

export function SeaznVideoIsland({ fixtureId, endpoint = "public", labels, initial }: SeaznVideoIslandProps) {
  const [video, setVideo] = useState<PublicFixtureVideo | null>(initial ?? null);
  const [epoch, setEpoch] = useState(0);
  const pollRef = useRef<VideoPoll | null>(null);

  useEffect(() => {
    const poll = startVideoPoll({
      fetchVideo: (signal) => fetchSeaznVideo(fixtureId, endpoint, signal),
      onVideo: (next, { rebuild }) => {
        setVideo(next);
        if (rebuild) setEpoch((e) => e + 1);
      },
    });
    pollRef.current = poll;
    return () => {
      poll.stop();
      pollRef.current = null;
    };
  }, [fixtureId, endpoint]);

  const refresh = useCallback(() => pollRef.current?.refreshSoon(), []);
  return <SeaznVideoStage video={video} epoch={epoch} labels={labels} onFatal={refresh} />;
}
